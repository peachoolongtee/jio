import pLimit from 'p-limit'
import { mockTravelMinutes } from '../planner/geo.js'
import { OneMapUnavailableError } from './budget.js'
import { ExternalApiError } from './http.js'

// Runs the planner engine with real OneMap travel times.
//
// The engine is synchronous on purpose (pure functions, deterministic tests), but OneMap answers over the
// network. So the engine runs twice:
//   1. A dry run with the engine's own estimate, which only records every trip the engine asks about, grouped
//      into candidates (one venue, or one candidate meeting area, with every member's trips to it).
//   2. A few candidates are chosen, and their trips are fetched from OneMap through the cache and the shared
//      call budget in services/onemap.js.
//   3. The real run reads the fetched minutes. A trip OneMap could not answer gets null, and the engine then
//      uses its estimate and marks that result `approximate`, as it already does.
//
// How many OneMap calls one request may cause is capped (MAX_ROUTED_TRIPS_PER_REQUEST), because the OneMap
// account is shared by the whole server. The cap is applied to whole candidates, never to single trips, so a
// venue is either routed for every member or estimated for every member, and venues are never ranked on
// half-real numbers. Trips answered from the cache, and trips short enough to walk, cost no call and are free.
//
// A trip and its reverse share one route ("the way back takes as long as the way there"). Most members end
// where they started, so this halves the calls. It is an approximation, and the docs say so.

// The most OneMap route calls one planner request may make. One place, used by every route.
export const MAX_ROUTED_TRIPS_PER_REQUEST = 60

// The most time one request waits for OneMap routes in total. Trips not answered by then use the estimate.
export const ROUTING_DEADLINE_MS = 8000

// Rounds to about 110 m, the same rounding as the OneMap cache, so near-identical points share one fetch.
const round3 = (x) => Math.round(x * 1000) / 1000
const pointKey = (p) => `${round3(p.lat)},${round3(p.lng)}`
const tripKey = (a, b) => [pointKey(a), pointKey(b)].sort().join('|')

// Which candidate a trip belongs to. Venues and candidate areas carry an `id`; a member's point never does
// (the request schema strips it). So the end with an id is the candidate. A trip between two bare points
// (the meeting point of a non-station method) is grouped by its destination.
const candidateKey = (a, b) => (a.id !== undefined ? `id:${a.id}` : b.id !== undefined ? `id:${b.id}` : `point:${pointKey(b)}`)

// The `travel` object of an answer that used no OneMap at all.
//
// How to call:
//   res.json({ ...result, travel: estimateTravel() })
export const estimateTravel = () => ({ source: 'estimate', asked: 0, routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 })

// The order in which candidate areas get real routes when a meeting-area request asks for runners-up or names areas.
// The cap on trips is applied to this order exactly as it is to any other, so naming areas never adds a call
// beyond MAX_ROUTED_TRIPS_PER_REQUEST. The order is:
//   1. The meeting point of a method other than station (a trip between two bare points). It is the answer itself.
//   2. The shortlist: the `shortlistSize` best areas by estimated result, as for a request that names nothing.
//      Areas in `notShortlisted` (named areas outside the ones the ranking compares) never join it, and so never
//      push a better area out of it. The chosen area and the runners-up come from these.
//   3. The areas in `afterShortlist` (the request's `include`, in the order sent) that are not already routed,
//      each as long as the cap has room for it whole.
// Because 1 and 2 are what a request without `include` would route, the ranking sees the same times with or
// without it. Step 3 is returned apart (`named`) because its real times are for the named areas' own entries only:
// the caller must never let the ranking read them.
//
// How to call (inside this file):
//   const { ranked, named } = routingOrderWithNamedAreas(candidates, { shortlistSize: 5, notShortlisted: ['bishan'], afterShortlist: ['bishan'] })
function routingOrderWithNamedAreas(candidates, { shortlistSize, notShortlisted = [], afterShortlist = [] }) {
  // The same order as the shortlist in runWithRealTravel: longest trip, then mean, then the order the engine asked.
  const worst = (c) => Math.max(...c.estimates)
  const mean = (c) => c.estimates.reduce((s, x) => s + x, 0) / c.estimates.length
  const entries = [...candidates.entries()]
  const head = entries.filter(([key]) => key.startsWith('point:'))
  const outside = new Set(notShortlisted.map((id) => `id:${id}`))
  const shortlist = entries
    .filter(([key]) => !key.startsWith('point:') && !outside.has(key))
    .sort(([, x], [, y]) => worst(x) - worst(y) || mean(x) - mean(y) || x.order - y.order)
    .slice(0, shortlistSize)
  const taken = new Set([...head, ...shortlist].map(([key]) => key))
  const later = []
  for (const id of afterShortlist) {
    const key = `id:${id}`
    if (candidates.has(key) && !taken.has(key)) {
      taken.add(key)
      later.push(candidates.get(key))
    }
  }
  return { ranked: [...head, ...shortlist].map(([, candidate]) => candidate), named: later }
}

// Runs `run(deps)` with real travel times when OneMap routing is on, and once with the estimate when it is off.
//
// How to call:
//   const { result, travel } = await runWithRealTravel({
//     onemap,
//     dateTime: '2026-10-10T19:00',
//     run: (deps) => converge(input, data, deps),
//   })
//   travel // { source: 'onemap', asked: 20, routed: 12, cached: 4, walked: 2, failed: 0, estimated: 2 }
//
// The numbers in `travel` always add up: asked = routed + cached + walked + failed + estimated.
//   asked      distinct trips the engine wanted (a trip and its reverse count once)
//   routed     real OneMap answers fetched for this request. Cached and walked trips are not counted here.
//   cached     answered from the route cache, no call
//   walked     under 400 m, walked, no call
//   failed     OneMap was asked and gave no time (an error, or no route), or the cache remembers "no route"
//   estimated  never asked, so the engine used its estimate: its candidate did not fit the cap or the shortlist,
//              or OneMap was not available (budget used up, circuit open, login failed), or the deadline came
// `source` is 'onemap' when at least one trip got a OneMap time (routed or cached), and 'estimate' otherwise.
//
// Options:
//   onemap          - The OneMap service, or null. When null or when routing is off, travel stays an estimate.
//   dateTime        - When the trips start, local Singapore time. Public transport depends on the hour.
//   run             - Runs the engine with the deps it is given. Called once or twice; it must not have side effects.
//   maxTrips        - The most OneMap calls this request may make. Default MAX_ROUTED_TRIPS_PER_REQUEST.
//   maxCandidates   - Shortlist size: only the first candidates (after ordering) are ever routed. Default all.
//   rankByEstimate  - Order candidates by their estimated result (longest trip, then mean) instead of the order
//                     the engine asked about them. For the meeting area, where the engine tries every area.
//   namedAreas      - For a meeting-area request that asks for runners-up or names areas: { notShortlisted, afterShortlist },
//                     two lists of area ids. See routingOrderWithNamedAreas below. Used with rankByEstimate only.
//                     The real run is then given two functions: `travelMinutes`, which answers only the trips of the
//                     ranking (the head and the shortlist, as for a request that names nothing), and
//                     `includedTravelMinutes`, which also answers the trips of the named areas that were routed.
//   deadlineMs      - The most time to wait for OneMap in total. Default ROUTING_DEADLINE_MS.
//   estimate        - A function (a, b) => minutes that guesses a trip: to rank the candidates and to fill in the trips with no real
//                     route. Default: the straight line. See planner/area-times.js.
//   concurrency     - How many of this request's trips are in flight at once. Default 6. The shared budget in
//                     services/onemap.js caps the whole server at 6 as well.
export async function runWithRealTravel({
  onemap,
  dateTime,
  run,
  maxTrips = MAX_ROUTED_TRIPS_PER_REQUEST,
  maxCandidates = Infinity,
  rankByEstimate = false,
  namedAreas = null,
  deadlineMs = ROUTING_DEADLINE_MS,
  concurrency = 6,
  estimate = null,
}) {
  // `estimate(a, b)` guesses the minutes of a trip, to rank the candidates and to fill in the trips that get no real route. Left out,
  // the straight-line guess is used (the engine's own). It is handed on to the engine as `estimateMinutes`.
  const guess = estimate ?? mockTravelMinutes
  const withGuess = (deps) => (estimate ? { ...deps, estimateMinutes: estimate } : deps)
  if (!onemap?.routingEnabled) {
    return { result: run(withGuess({})), travel: estimateTravel() }
  }

  // 1. Which trips does the engine need, and which candidate does each belong to?
  const trips = new Map() // trip key -> { a, b }
  const candidates = new Map() // candidate key -> { order, tripKeys (first seen here), estimates (every call) }
  run(withGuess({
    travelMinutes: (a, b) => {
      const estimate = guess(a, b)
      const ck = candidateKey(a, b)
      let candidate = candidates.get(ck)
      if (!candidate) {
        candidate = { order: candidates.size, tripKeys: [], estimates: [] }
        candidates.set(ck, candidate)
      }
      candidate.estimates.push(estimate)
      const tk = tripKey(a, b)
      if (!trips.has(tk)) {
        trips.set(tk, { a, b })
        candidate.tripKeys.push(tk)
      }
      return estimate
    },
  }))

  // 2. Choose whole candidates, in priority order, until the next one would pass the cap.
  let ordered = [...candidates.values()]
  if (rankByEstimate) {
    const worst = (c) => Math.max(...c.estimates)
    const mean = (c) => c.estimates.reduce((s, x) => s + x, 0) / c.estimates.length
    ordered.sort((x, y) => worst(x) - worst(y) || mean(x) - mean(y) || x.order - y.order)
  }
  ordered = ordered.slice(0, maxCandidates)
  // A request that names areas replaces the order above with one that also reaches them (same cap, same loop below).
  // `named` comes after `ranked`, so the ranked areas have first call on the cap.
  let named = []
  const namesAreas = rankByEstimate && namedAreas !== null
  if (namesAreas) {
    ;({ ranked: ordered, named } = routingOrderWithNamedAreas(candidates, { ...namedAreas, shortlistSize: maxCandidates }))
  }
  const rankingTrips = new Set() // trip keys of the candidates the ranking may read

  const outcome = new Map() // trip key -> 'routed' | 'cached' | 'walked' | 'failed' | 'estimated'
  const minutes = new Map() // trip key -> minutes, for the trips that have a OneMap (or walking) time
  const toFetch = []
  let spent = 0
  let full = false
  for (const candidate of [...ordered, ...named]) {
    const looked = candidate.tripKeys.map((key) => {
      const { a, b } = trips.get(key)
      // A OneMap service without peekRoute (a test double) cannot tell, so every trip counts as a call.
      return [key, onemap.peekRoute ? onemap.peekRoute(a, b, dateTime) : { kind: 'call' }]
    })
    const cost = looked.filter(([, plan]) => plan.kind === 'call').length
    // A candidate that needs calls must fit whole. Once one did not, no later one that needs calls is tried:
    // that would rank a lower candidate on real times while a better one has estimates. Candidates that need
    // no calls at all (everything cached or walked) are free, so they are always taken.
    if (cost > 0 && (full || spent + cost > maxTrips)) {
      full = true
      continue
    }
    spent += cost
    if (!named.includes(candidate)) candidate.tripKeys.forEach((key) => rankingTrips.add(key))
    for (const [key, plan] of looked) {
      if (plan.kind === 'call') toFetch.push(key)
      else if (plan.kind === 'walk') {
        minutes.set(key, plan.minutes)
        outcome.set(key, 'walked')
      } else if (plan.minutes === null) outcome.set(key, 'failed')
      else {
        minutes.set(key, plan.minutes)
        outcome.set(key, 'cached')
      }
    }
  }

  // 3. Fetch them. Only an API failure is tolerated; any other error is a bug and must surface.
  // The whole step shares one deadline. When it passes, trips that have not answered use the estimate.
  let closed = false
  let timedOut = false
  if (toFetch.length > 0) {
    const limit = pLimit(concurrency)
    const fetchAll = Promise.all(
      toFetch.map((key) =>
        limit(async () => {
          if (closed) return // The deadline passed while this trip waited its turn: do not spend a call on it.
          const { a, b } = trips.get(key)
          try {
            const m = await onemap.routeMinutes(a, b, dateTime)
            if (closed) return
            if (m === null || m === undefined) outcome.set(key, 'failed')
            else {
              minutes.set(key, m)
              outcome.set(key, 'routed')
            }
          } catch (err) {
            if (!(err instanceof ExternalApiError)) throw err
            if (closed) return
            // OneMap not available right now (no budget, circuit open, login failed): never asked, so estimated.
            outcome.set(key, err instanceof OneMapUnavailableError ? 'estimated' : 'failed')
          }
        }),
      ),
    )
    let timer
    const deadline = new Promise((resolve) => {
      timer = setTimeout(() => resolve('deadline'), deadlineMs)
      timer.unref?.()
    })
    try {
      timedOut = (await Promise.race([fetchAll.then(() => 'done'), deadline])) === 'deadline'
    } finally {
      clearTimeout(timer)
      closed = true
    }
    if (timedOut) onemap.reportFallback?.('deadline')
  }

  // 4. The real run reads a snapshot, so an answer that arrives after the deadline changes nothing.
  // When areas are named, the ranking reads only the trips of the ranking's own candidates, so a named area's real
  // times can never change which area is chosen or how the runners-up are ordered.
  const answers = new Map(minutes)
  const readFrom = (map) => (a, b) => map.get(tripKey(a, b)) ?? null
  const result = namesAreas
    ? run(withGuess({
        travelMinutes: readFrom(new Map([...answers].filter(([key]) => rankingTrips.has(key)))),
        includedTravelMinutes: readFrom(answers),
      }))
    : run(withGuess({ travelMinutes: readFrom(answers) }))

  const counts = { routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 }
  for (const key of trips.keys()) counts[outcome.get(key) ?? 'estimated'] += 1
  return {
    result,
    travel: { source: counts.routed + counts.cached > 0 ? 'onemap' : 'estimate', asked: trips.size, ...counts },
  }
}
