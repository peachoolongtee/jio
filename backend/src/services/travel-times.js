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
// half-real numbers, including when the deadline cuts a candidate part-way: it is then estimated whole. Trips answered from the cache, and trips short enough to walk, cost no call and are free.
//
// A trip and its reverse share one route ("the way back takes as long as the way there"). Most members end
// where they started, so this halves the calls. It is an approximation, and the docs say so.
//
// TABLE MODE. When the server has the table of real minutes between the meeting areas (planner/area-times.js), every candidate is first
// ranked on table times, which cost no call (runWithTableTimes). Only the results a person sees first are then routed live (the top 3
// places of a category, the chosen meeting area), and the engine runs again with their routed times, so the order among them is
// the routed one. A result that climbs into the shown ones is routed in turn (at most TABLE_ROUTE_ROUNDS rounds). Candidates that are not shown
// are never fetched. A candidate is read whole, either on routed times or on table times, never half and half. The answer's `travel` counts
// them as `table`. Without the table, the code below this comment is what runs, as it always did.

// The most OneMap route calls one planner request may make. One place, used by every route.
export const MAX_ROUTED_TRIPS_PER_REQUEST = 60

// The most time one request waits for OneMap routes in total. Trips not answered by then use the estimate and are flagged
// `approximate`. Every caller today is a person waiting on a screen (the planner routes and the session server's runs), so
// the default is short: a round of 6 trips takes about 1.2 seconds, and a slow OneMap should cost a few estimates, not a
// loading screen. ROUTING_DEADLINE_MS in the environment changes it (readRoutingDeadline).
export const ROUTING_DEADLINE_MS = 3000

// What the environment setting may be. Below the floor no round of trips could finish; above the ceiling a wait would be
// longer than the frontend waits for a ranking (15 seconds).
export const ROUTING_DEADLINE_MIN_MS = 1000
export const ROUTING_DEADLINE_MAX_MS = 15000

// Reads ROUTING_DEADLINE_MS from the environment, the way readOneMapSettings reads its settings. Blank means the default (the
// result has no `deadlineMs`). Anything that is not a whole number from ROUTING_DEADLINE_MIN_MS to ROUTING_DEADLINE_MAX_MS is
// an `error` the server refuses to start with. The message names the variable, never a value.
//
// How to call:
//   const { deadlineMs, error } = readRoutingDeadline(process.env) // { deadlineMs: 3000 }, { error: '...' }, or {}
export function readRoutingDeadline(env) {
  const text = typeof env.ROUTING_DEADLINE_MS === 'string' ? env.ROUTING_DEADLINE_MS.trim() : ''
  if (text === '') return {}
  // Digits only: "1e3" and "0x10" are numbers to JavaScript but not what anyone meant by a number of milliseconds.
  const deadlineMs = /^\d+$/.test(text) ? Number(text) : NaN
  if (!Number.isInteger(deadlineMs) || deadlineMs < ROUTING_DEADLINE_MIN_MS || deadlineMs > ROUTING_DEADLINE_MAX_MS) {
    return { error: `ROUTING_DEADLINE_MS must be a whole number of milliseconds from ${ROUTING_DEADLINE_MIN_MS} to ${ROUTING_DEADLINE_MAX_MS}.` }
  }
  return { deadlineMs }
}

// Rounds to about 110 m, the same rounding as the OneMap cache, so near-identical points share one fetch.
const round3 = (x) => Math.round(x * 1000) / 1000
const pointKey = (p) => `${round3(p.lat)},${round3(p.lng)}`
const tripKey = (a, b) => [pointKey(a), pointKey(b)].sort().join('|')

// Which candidate a trip belongs to. Venues and candidate areas carry an `id`; a member's point never does
// (the request schema strips it). So the end with an id is the candidate. A trip between two bare points
// (the meeting point of a non-station method) is grouped by its destination.
const candidateKey = (a, b) => (a.id !== undefined ? `id:${a.id}` : b.id !== undefined ? `id:${b.id}` : `point:${pointKey(b)}`)

// How many rounds of live routes a table-mode request may make after ranking on the table: the shown results are routed in the first,
// and the ones that climbed into the shown results because of it in the next, until the shown results are routed or the rounds are used.
// Each round takes about as long as its slowest trip; a round after the first starts only with TABLE_ROUND_MIN_MS left.
export const TABLE_ROUTE_ROUNDS = 3

// The least time that must be left for a later round of live routes (or for the named areas' pass) to start. A round with less would
// send up to a round of calls that cannot answer in time, and spend the shared budget for nothing.
export const TABLE_ROUND_MIN_MS = 500

// The most the routes of a request may move the table times of the candidates not routed (see shiftNow in runWithTableTimes).
export const MAX_SHIFT_MINUTES = 15

// The `travel` object of an answer that used no OneMap at all.
//
// How to call:
//   res.json({ ...result, travel: estimateTravel() })
export const estimateTravel = () => ({ source: 'estimate', asked: 0, routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 })

// Fetches the routes of `keys` (trip keys) from OneMap through the shared budget and cache, at most `concurrency` at a time, and writes
// each answer to `outcome` ('routed' or 'failed' or 'estimated', for a OneMap that is unavailable) and `minutes`. It waits at most `waitMs`
// in all. Resolves true when the time ran out first: trips that had not answered by then have no outcome, and an answer that arrives
// later is ignored (the step is closed). A trip still waiting for its turn when the time ran out makes no call. Only an API failure is
// tolerated; any other error is a bug and surfaces.
//
// How to call (inside this file):
//   const timedOut = await fetchTrips({ onemap, trips, keys, dateTime, cache: true, concurrency: 6, onCalls: null, waitMs: 3000, outcome, minutes })
async function fetchTrips({ onemap, trips, keys, dateTime, cache, concurrency, onCalls, waitMs, outcome, minutes }) {
  let closed = false
  const limit = pLimit(concurrency)
  const fetchAll = Promise.all(
    keys.map((key) =>
      limit(async () => {
        if (closed) return // The deadline passed while this trip waited its turn: do not spend a call on it.
        const { a, b } = trips.get(key)
        try {
          onCalls?.(1)
          const m = cache ? await onemap.routeMinutes(a, b, dateTime) : await onemap.routeMinutes(a, b, dateTime, { cache: false })
          if (closed) return
          if (m === null || m === undefined) outcome.set(key, 'failed')
          else {
            minutes.set(key, m)
            outcome.set(key, 'routed')
          }
        } catch (err) {
          if (!(err instanceof ExternalApiError)) throw err
          // OneMap not available right now (no budget, circuit open, login failed): no call was made, so none is counted.
          if (err instanceof OneMapUnavailableError) onCalls?.(-1)
          if (closed) return
          outcome.set(key, err instanceof OneMapUnavailableError ? 'estimated' : 'failed')
        }
      }),
    ),
  )
  let timer
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => resolve('deadline'), waitMs)
    timer.unref?.()
  })
  try {
    return (await Promise.race([fetchAll.then(() => 'done'), deadline])) === 'deadline'
  } finally {
    clearTimeout(timer)
    closed = true
  }
}

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
// A server may ask for more finalists than the default (MEETING_FINALISTS), and then the shortlist can fill the whole cap and
// leave the named areas, which are what people asked for, with nothing. `protectedShortlist` is how many shortlist areas keep their
// place ahead of the named ones (the default number of finalists); the finalists after them come after the named areas, so they
// get only what is left. `order` is that sequence. With no more finalists than that, it is the shortlist and then the named areas.
//
// How to call (inside this file):
//   const { ranked, named, order } = routingOrderWithNamedAreas(candidates, { shortlistSize: 12, protectedShortlist: 5, notShortlisted: ['bishan'], afterShortlist: ['bishan'] })
function routingOrderWithNamedAreas(candidates, { shortlistSize, protectedShortlist = shortlistSize, notShortlisted = [], afterShortlist = [] }) {
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
  const ranked = [...head, ...shortlist].map(([, candidate]) => candidate)
  const protectedCount = head.length + Math.min(protectedShortlist, shortlist.length)
  return { ranked, named: later, order: [...ranked.slice(0, protectedCount), ...later, ...ranked.slice(protectedCount)] }
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
//                     two lists of area ids, and optionally `protectedShortlist`, how many of the `maxCandidates` best areas are routed before
//                     the named ones (the rest are routed after them, with what is left). See routingOrderWithNamedAreas. Used with
//                     rankByEstimate only.
//                     The real run is then given two functions: `travelMinutes`, which answers only the trips of the
//                     ranking (the head and the shortlist, as for a request that names nothing), and
//                     `includedTravelMinutes`, which also answers the trips of the named areas that were routed.
//   deadlineMs      - The most time to wait for OneMap in total. Default ROUTING_DEADLINE_MS. 0 or less means there is no time: no
//                     call is made, every trip that needed one is estimated and `reportFallback('deadline')` is called.
//   deadlineClock   - { start() } -> milliseconds left, instead of deadlineMs, for a caller whose wait is shared by several runs and
//                     must start when routing starts (services/session-voting.js newAllowance). It is called once, only when this run
//                     finds it has calls to make.
//   onCalls         - (n) => void, told how many calls this run is about to make (every one counts, even one whose answer arrives too
//                     late to be used), so a caller can take them from an allowance.
//   estimate        - A function (a, b) => minutes that guesses a trip: to rank the candidates and to fill in the trips with no real
//                     route. Default: the straight line. See planner/area-times.js.
//   cache           - false does not read or keep the routes (for trips from a person's position, which must not stay in this process). Default true.
//   concurrency     - How many of this request's trips are in flight at once. Default 6. The shared budget in
//                     services/onemap.js caps the whole server at 6 as well.
//   table           - A function (a, b) => minutes, or null where there is none: the planner's table trip time (planner/area-times.js).
//                     With it the request runs in table mode (see the comment at the top of this file): `maxCandidates`, `rankByEstimate` are
//                     not used, and `travel` gains `table`. `routeFirst` (a function of the answer, returning { ranking: [ids], named: [ids] }
//                     for the results shown first), `rounds` and `tableAt` (a sentence for `travel`: the moment the table is for) go with it. Without `routeFirst` every candidate is shown.
export async function runWithRealTravel({
  onemap,
  dateTime,
  run,
  maxTrips = MAX_ROUTED_TRIPS_PER_REQUEST,
  maxCandidates = Infinity,
  rankByEstimate = false,
  namedAreas = null,
  deadlineMs = ROUTING_DEADLINE_MS,
  deadlineClock = null,
  onCalls = null,
  concurrency = 6,
  estimate = null,
  cache = true,
  table = null,
  tableAt = null,
  routeFirst = null,
  rounds = TABLE_ROUTE_ROUNDS,
}) {
  // `estimate(a, b)` guesses the minutes of a trip, to rank the candidates and to fill in the trips that get no real route. Left out,
  // the straight-line guess is used (the engine's own). It is handed on to the engine as `estimateMinutes`.
  const guess = estimate ?? mockTravelMinutes
  const withGuess = (deps) => (estimate ? { ...deps, estimateMinutes: estimate } : deps)
  if (!onemap?.routingEnabled) {
    return table ? runOnTableTimes({ run, table, estimate: guess, tableAt }) : { result: run(withGuess({})), travel: estimateTravel() }
  }
  if (table) {
    return runWithTableTimes({
      onemap, dateTime, run, table, estimate: guess, tableAt, routeFirst, rounds, namedAreas, maxTrips, deadlineMs, deadlineClock, onCalls, concurrency, cache,
    })
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
  let order = ordered // the sequence in which candidates are routed
  const namesAreas = rankByEstimate && namedAreas !== null
  if (namesAreas) {
    ;({ ranked: ordered, named, order } = routingOrderWithNamedAreas(candidates, { ...namedAreas, shortlistSize: maxCandidates }))
  }
  const rankingTrips = new Set() // trip keys of the candidates the ranking may read

  const outcome = new Map() // trip key -> 'routed' | 'cached' | 'walked' | 'failed' | 'estimated'
  const minutes = new Map() // trip key -> minutes, for the trips that have a OneMap (or walking) time
  const toFetch = []
  let spent = 0
  let full = false // a ranked candidate did not fit: no later one that needs calls is tried
  let namedFull = false // a named one did not fit: no later named one that needs calls is tried (the ranked ones are not held back)
  for (const candidate of order) {
    const isNamed = named.includes(candidate)
    const looked = candidate.tripKeys.map((key) => {
      const { a, b } = trips.get(key)
      // A OneMap service without peekRoute (a test double) cannot tell, so every trip counts as a call.
      const plan = onemap.peekRoute ? onemap.peekRoute(a, b, dateTime) : { kind: 'call' }
      // Without the cache, a trip that was answered before is asked again: its answer is not kept, so none can be read.
      return [key, !cache && plan.kind === 'cached' ? { kind: 'call' } : plan]
    })
    const cost = looked.filter(([, plan]) => plan.kind === 'call').length
    // A candidate that needs calls must fit whole. Once one did not, no later one that needs calls is tried:
    // that would rank a lower candidate on real times while a better one has estimates. Candidates that need
    // no calls at all (everything cached or walked) are free, so they are always taken.
    if (cost > 0 && (full || (isNamed && namedFull) || spent + cost > maxTrips)) {
      if (isNamed) namedFull = true
      else full = true
      continue
    }
    spent += cost
    if (!isNamed) candidate.tripKeys.forEach((key) => rankingTrips.add(key))
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
  // The whole step shares one deadline. When it passes, trips that have not answered use the estimate. A deadline with no time left
  // makes no call at all (p-limit would otherwise start the first few before the timer could close the step).
  if (toFetch.length > 0) {
    const waitMs = deadlineClock ? deadlineClock.start() : deadlineMs
    const timedOut = !(waitMs > 0) || (await fetchTrips({ onemap, trips, keys: toFetch, dateTime, cache, concurrency, onCalls, waitMs, outcome, minutes }))
    if (timedOut) {
      onemap.reportFallback?.('deadline')
      // A candidate the deadline cut part-way is estimated whole: a venue is real for every member or an estimate for every member,
      // never ranked on half-real numbers. Its trips that did answer are dropped (they stay in the route cache for the next request).
      const fetching = new Set(toFetch)
      for (const candidate of order) {
        if (!candidate.tripKeys.some((key) => fetching.has(key) && !outcome.has(key))) continue
        for (const key of candidate.tripKeys) {
          minutes.delete(key)
          outcome.delete(key)
        }
      }
    }
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

// Counts how the trips of a table-mode answer were timed, as the `travel` object. `outcome` holds what happened to the trips that were
// asked of OneMap or taken from the cache or walked; `used` is the set of trip keys whose time the answer read from that (a trip of a
// candidate read on routed times). Every other trip was timed by the table, or by the straight line where the table has no pair: a route
// that arrived for a candidate that was then left on the table (one of its other trips failed, or the deadline cut it) counts as `table`,
// so `routed` and `source` describe the times in the answer, not the calls made (`onCalls` counts those). The numbers add up:
// asked = routed + cached + walked + table + failed + estimated. `tableAt` (the moment the table is for) is added when any trip is the table's.
//
// How to call (inside this file):
//   countTravel(trips, outcome, used, table, 'Tuesday 12:30') // { source: 'onemap', asked: 12, routed: 3, cached: 0, walked: 0, table: 9, failed: 0, estimated: 0, tableAt: 'Tuesday 12:30' }
function countTravel(trips, outcome, used, table, tableAt = null) {
  const counts = { routed: 0, cached: 0, walked: 0, table: 0, failed: 0, estimated: 0 }
  for (const [key, { a, b }] of trips) {
    const kind = outcome.get(key)
    if (kind === 'failed' || (used.has(key) && (kind === 'routed' || kind === 'cached' || kind === 'walked'))) counts[kind] += 1
    else counts[Number.isFinite(table(a, b)) ? 'table' : 'estimated'] += 1
  }
  const source = counts.routed + counts.cached > 0 ? 'onemap' : counts.table > 0 ? 'table' : 'estimate'
  return {
    source, asked: trips.size, routed: counts.routed, cached: counts.cached, walked: counts.walked, table: counts.table, failed: counts.failed, estimated: counts.estimated,
    ...(counts.table > 0 && tableAt && { tableAt }),
  }
}

// Runs `run(deps)` on table times alone, with no OneMap call: for a request that says `travel: 'estimate'` and for a server with no OneMap
// account, when the server has the table. The answer's `travel` counts the trips as `table`.
//
// How to call:
//   const { result, travel } = runOnTableTimes({ run: (deps) => converge(input, data, deps), table: estimator.tableMinutes, estimate: estimator, tableAt: 'Tuesday 12:30' })
//   travel // { source: 'table', asked: 20, routed: 0, cached: 0, walked: 0, table: 20, failed: 0, estimated: 0, tableAt: 'Tuesday 12:30' }
export function runOnTableTimes({ run, table, estimate, tableAt = null }) {
  const trips = new Map()
  const result = run({
    estimateMinutes: estimate,
    travelSource: () => 'table',
    travelMinutes: (a, b) => {
      trips.set(tripKey(a, b), { a, b })
      return table(a, b)
    },
  })
  return { result, travel: countTravel(trips, new Map(), new Set(), table, tableAt) }
}

// Table mode: ranks every candidate on table times, then routes live only what is shown first.
//
//   1. A dry run records every trip the engine asks about, by candidate, and reads table times (no call).
//   2. A candidate whose trips all cost no call (cached or short enough to walk) is read on those once the ranking shows it itself (it
//      is among `routeFirst(result).ranking`, as now or in an earlier answer of this request). One the ranking does not show is never read
//      live by it, whoever caused the cache to hold its routes: a name must never move the planner's own pick, in this request or in a
//      later one. An area a person named (`namedAreas.afterShortlist`) that costs no call is read for its own entry only, until shown.
//   3. The engine runs again. `routeFirst(result)` names the candidates it shows first: { ranking: [ids], named: [ids] }. Those not yet
//      routed are fetched whole, in that order, while the cap (`maxTrips`, in whole candidates) and the deadline allow. `ranking` ones
//      may change the order of the answer; `named` ones (areas a person named) are measured for their own entry only and the ranking
//      never reads them. A candidate with `point:` key (the meeting point of a method other than station) is always first.
//   4. The engine runs again on routed times for the candidates that arrived, and the table's for the rest, moved by how far the routes of
//      this request differ from the table on the same trips (their median, so a Friday evening or a long feeder does not leave every
//      unrouted candidate looking better than every routed one). Back to 3 for what climbed
//      into the shown results, at most `rounds` times in all; a later round starts only with TABLE_ROUND_MIN_MS left.
//   5. Last, the named areas are routed with the time and cap that are left, for their own entries. The ranking's rounds have the whole cap
//      first, exactly as without names. A route bought for a name is never read by the ranking, not even if the area is shown.
// A candidate with a trip OneMap could not answer, or one that did not arrive before the deadline, stays on table times whole.
// `notShortlisted` (a meeting-area request's named areas outside the ranking) is never read by the ranking, as in the mode without a table.
//
// Options are those of runWithRealTravel, with: table (a function (a, b) => minutes or null, planner/area-times.js tableMinutes),
// estimate (the straight-line fallback the engine uses where the table gives null), tableAt (the moment the table is for, for `travel`), routeFirst, rounds, namedAreas ({ notShortlisted, afterShortlist }).
// Without `routeFirst` every candidate is shown (a run with one candidate, such as pricing a known place).
//
// How to call (inside this file; runWithRealTravel passes its options on):
//   const { result, travel } = await runWithTableTimes({ onemap, dateTime, run, table, estimate, routeFirst: (r) => ({ ranking: [r.results[0].venueId] }), ...limits })
async function runWithTableTimes({
  onemap, dateTime, run, table, estimate, tableAt = null, routeFirst = null, rounds = TABLE_ROUTE_ROUNDS, namedAreas = null,
  maxTrips, deadlineMs, deadlineClock, onCalls, concurrency, cache,
}) {
  // 1. Which trips does the engine need, and which candidate does each belong to?
  const trips = new Map() // trip key -> { a, b }
  const candidates = new Map() // candidate key -> { tripKeys: Set }
  const dryResult = run({
    estimateMinutes: estimate,
    travelSource: () => 'table',
    travelMinutes: (a, b) => {
      const key = candidateKey(a, b)
      const tk = tripKey(a, b)
      let candidate = candidates.get(key)
      if (!candidate) candidates.set(key, (candidate = { tripKeys: new Set() }))
      candidate.tripKeys.add(tk)
      if (!trips.has(tk)) trips.set(tk, { a, b })
      return table(a, b)
    },
  })

  const outside = new Set((namedAreas?.notShortlisted ?? []).map((id) => `id:${id}`))
  const named = new Set([...(namedAreas?.afterShortlist ?? []).map((id) => `id:${id}`), ...outside]) // areas a person named: the ranking reads them only when it shows them
  const outcome = new Map() // trip key -> 'routed' | 'cached' | 'walked' | 'failed' | 'estimated', for the trips OneMap or the cache answered
  const minutes = new Map() // trip key -> minutes, for the trips that have a OneMap (or walking) time
  const live = new Set() // candidates the ranking reads on routed times
  const liveNamed = new Set() // candidates routed for a named area's own entry only
  const tried = new Set() // candidates whose routes were asked for: never asked again
  const refused = new Set() // candidates the ranking could not fit in the cap: the ranking does not ask again, but a named area still gets its own pass
  const boughtForName = new Set() // candidates routed for a name: the ranking never reads them
  const heads = [...candidates.keys()].filter((key) => key.startsWith('point:')) // meeting points of a method other than station: always shown
  let spent = 0
  let full = false // a ranking candidate did not fit the cap: no later one that needs calls is tried
  let namedFull = false
  let deadlineAt = null
  let outOfTime = false

  // What a candidate's trips would do, without doing it. A trip already answered in this request is free whether or not the cache is on (with
  // `cache: false` a position's routes are not kept between requests, but one fetched here must not be bought twice). Otherwise: a OneMap
  // service without peekRoute (a test double) cannot tell, so every trip counts as a call; without the cache, a trip answered before this
  // request is asked again.
  const peek = (key) => {
    // A trip that failed in this request is "no route" and free, with the cache off too: a sibling that shares it must not buy it again.
    if (outcome.get(key) === 'failed') return { kind: 'cached', minutes: null }
    if (minutes.has(key)) return outcome.get(key) === 'walked' ? { kind: 'walk', minutes: minutes.get(key) } : { kind: 'cached', minutes: minutes.get(key) }
    const { a, b } = trips.get(key)
    const plan = onemap.peekRoute ? onemap.peekRoute(a, b, dateTime) : { kind: 'call' }
    return !cache && plan.kind === 'cached' ? { kind: 'call' } : plan
  }
  // Takes the minutes a plan holds for a trip that costs no call.
  const takeFree = (key, plan) => {
    if (outcome.get(key) === 'routed') return // fetched in this request: it stays counted as a route
    if (plan.kind === 'walk') {
      minutes.set(key, plan.minutes)
      outcome.set(key, 'walked')
    } else if (plan.minutes === null) outcome.set(key, 'failed')
    else {
      minutes.set(key, plan.minutes)
      outcome.set(key, 'cached')
    }
  }

  // 2. A candidate that needs no call is read on its free times whole, but by the ranking only once the ranking shows it (`shown`, the keys
  // `routeFirst` names): a cached trip the ranking did not ask for may be there because of an earlier name, and reading it would let that
  // name move the pick. Places in one building share their routes, so a sibling that a fetch made free is read live as soon as it is shown.
  // A named area that is free and not shown is read for its own entry only; it joins the ranking from the moment the ranking shows it,
  // unless a name paid for its routes. Returns true when a candidate moved, and the caller runs the engine again.
  //
  // How to call (inside this file):
  //   if (adoptFree(shownKeys(result))) result = runNow()
  const adoptFree = (shown) => {
    let moved = false
    for (const [key, candidate] of candidates) {
      if (live.has(key) || tried.has(key)) continue
      const toRanking = shown.has(key) && !outside.has(key)
      if (!toRanking && !named.has(key)) continue
      if (liveNamed.has(key)) {
        if (!toRanking || boughtForName.has(key)) continue
        live.add(key)
        moved = true
        continue
      }
      const plans = [...candidate.tripKeys].map((tk) => [tk, peek(tk)])
      if (plans.some(([, plan]) => plan.kind === 'call')) continue
      if (plans.every(([, plan]) => plan.kind === 'walk' || plan.minutes !== null)) {
        plans.forEach(([tk, plan]) => takeFree(tk, plan))
        ;(toRanking ? live : liveNamed).add(key)
        moved = true
      } else {
        tried.add(key)
        plans.forEach(([tk, plan]) => plan.kind === 'cached' && plan.minutes === null && outcome.set(tk, 'failed')) // the cache remembers "no route"
      }
    }
    return moved
  }

  // The keys of the candidates the ranking shows in `answer`, which it may read live: its own first results (and the meeting points), or
  // every candidate when the run names none (a run with one candidate).
  //
  // How to call (inside this file):
  //   shownKeys(result) // Set { 'id:bugis', 'id:city-hall' }
  const shownKeys = (answer) => new Set(routeFirst ? [...heads, ...routeFirst(answer).ranking.map((id) => `id:${id}`)] : candidates.keys())

  // How much the routes of this request differ from the table on the same trips, in minutes. The table is one Tuesday midday; a request may be a
  // Friday evening, or one person's hops may run long (a start far from a station), so a candidate not routed is read on the table plus the shift
  // of the person the trip starts from: the median of routed minus table over that person's trips to the candidates the ranking reads live
  // (not walks, not the named areas'). A person with fewer than two such trips takes the median over everyone's, and with fewer than two in all
  // the shift is 0. Each is kept within +-MAX_SHIFT_MINUTES. Without a shift every unrouted candidate would look better than every routed one
  // whenever live runs longer than the table, and the first results shown would never be the routed ones.
  //
  // How to call (inside this file):
  //   const shifts = shiftsNow() // { of(a, b) => minutes }
  const endOf = (a, b) => (a.id !== undefined || b.id !== undefined ? (a.id !== undefined ? b : a) : null) // the end that is not a candidate: a person's point
  const medianOf = (gaps) => {
    if (gaps.length < 2) return null
    const sorted = [...gaps].sort((x, y) => x - y)
    const middle = sorted.length >> 1
    const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2
    return Math.max(-MAX_SHIFT_MINUTES, Math.min(MAX_SHIFT_MINUTES, median))
  }
  const shiftsNow = () => {
    const all = []
    const byPerson = new Map()
    for (const key of live) {
      for (const tk of candidates.get(key).tripKeys) {
        const { a, b } = trips.get(tk)
        const t = table(a, b)
        if (outcome.get(tk) === 'walked' || !minutes.has(tk) || !Number.isFinite(t)) continue
        const gap = minutes.get(tk) - t
        all.push(gap)
        const person = endOf(a, b)
        if (person) {
          const id = pointKey(person)
          byPerson.set(id, [...(byPerson.get(id) ?? []), gap])
        }
      }
    }
    const everyone = medianOf(all) ?? 0
    const own = new Map([...byPerson].map(([id, gaps]) => [id, medianOf(gaps)]))
    return (a, b) => {
      const person = endOf(a, b)
      return (person && own.get(pointKey(person))) ?? everyone
    }
  }

  // The engine's deps now: routed minutes for the candidates read live, the table's (moved by the shift above) for the rest. A table time of 0
  // (two area centres that are one) stays 0, as in the dry run, and a shift never takes a trip below a minute (or below its own time if less).
  const runNow = () => {
    const shiftOf = shiftsNow()
    const tableNow = (a, b) => {
      const t = table(a, b)
      return t === null || t === 0 ? t : Math.max(Math.min(1, t), t + shiftOf(a, b))
    }
    const timeFor = (set) => (a, b) => (set.has(candidateKey(a, b)) ? (minutes.get(tripKey(a, b)) ?? null) : tableNow(a, b))
    const readsLive = (a, b) => live.has(candidateKey(a, b))
    const anyLive = (a, b) => live.has(candidateKey(a, b)) || liveNamed.has(candidateKey(a, b))
    return run({
      estimateMinutes: estimate,
      travelMinutes: timeFor(live),
      ...(namedAreas && { includedTravelMinutes: timeFor(new Set([...live, ...liveNamed])) }),
      travelSource: (a, b, included) => ((included ? anyLive : readsLive)(a, b) ? 'routed' : 'table'),
    })
  }

  // 3. Route what the answer shows first, then run again. With nothing read live the engine would run on the dry run's input: reuse its answer.
  // Settling reads what is free and shown (and what is free and named, for its own entry), until no answer shows another.
  //
  // How to call (inside this file):
  //   settle() // result is now the answer for what the ranking shows
  let result = dryResult
  const settle = () => {
    for (let i = 0; i <= candidates.size && adoptFree(shownKeys(result)); i++) result = runNow()
  }
  settle()

  // Picks the candidates to route now, in order, whole, while the cap allows; `ranking` says whether the ranking will read them.
  // A candidate already read live, or already tried, is left out. Returns { key, candidate, ranking, plans } for each.
  const choose = (list) => {
    const batch = []
    for (const [key, ranking] of list) {
      const candidate = candidates.get(key)
      if (!candidate || batch.some((b) => b.key === key)) continue
      if (live.has(key) || (!ranking && liveNamed.has(key)) || tried.has(key) || (ranking && refused.has(key))) continue
      const plans = [...candidate.tripKeys].map((tk) => [tk, peek(tk)])
      const cost = plans.filter(([, plan]) => plan.kind === 'call').length
      // A candidate that needs calls must fit whole. Once a ranking one did not, no later ranking one that needs calls is tried; the named areas
      // come after the ranking and have what it leaves. A ranking candidate the cap refused is not "tried" for the named pass: a named area the
      // ranking shows still gets its own pass.
      if (cost > 0 && ((ranking ? full : namedFull) || spent + cost > maxTrips)) {
        if (ranking) {
          full = true
          refused.add(key)
        } else {
          namedFull = true
          tried.add(key)
        }
        continue
      }
      spent += cost
      batch.push({ key, candidate, ranking, plans })
    }
    return batch
  }
  // Fetches what a batch needs within the one deadline of the request (started when the first call is needed, the lazy clock of
  // runWithRealTravel), then reads each candidate whose trips all answered on its routed times. A round after the first starts only
  // with TABLE_ROUND_MIN_MS left: with less, a round of calls would not answer in time and would only spend the shared budget.
  const route = async (batch, later) => {
    const toFetch = [...new Set(batch.flatMap((b) => b.plans.filter(([, plan]) => plan.kind === 'call').map(([tk]) => tk)))]
    if (toFetch.length > 0) {
      if (deadlineAt === null) deadlineAt = Date.now() + Math.max(0, deadlineClock ? deadlineClock.start() : deadlineMs)
      const left = deadlineAt - Date.now()
      const timedOut = !(left > (later ? TABLE_ROUND_MIN_MS : 0)) || (await fetchTrips({ onemap, trips, keys: toFetch, dateTime, cache, concurrency, onCalls, waitMs: left, outcome, minutes }))
      if (timedOut) {
        onemap.reportFallback?.('deadline')
        outOfTime = true
      }
    }
    for (const { key, candidate, ranking, plans } of batch) {
      tried.add(key)
      if (!ranking && plans.some(([, plan]) => plan.kind === 'call')) boughtForName.add(key)
      const free = plans.filter(([, plan]) => plan.kind !== 'call')
      const answered = [...candidate.tripKeys].every((tk) => minutes.has(tk) || free.some(([ftk, plan]) => ftk === tk && (plan.kind === 'walk' || plan.minutes !== null)))
      if (!answered) {
        free.forEach(([tk, plan]) => plan.kind === 'cached' && plan.minutes === null && outcome.set(tk, 'failed'))
        continue
      }
      free.forEach(([tk, plan]) => takeFree(tk, plan))
      ;(ranking ? live : liveNamed).add(key)
    }
    result = runNow() // the caller settles what the ranking now shows before it decides anything else
  }

  for (let round = 1; round <= rounds && !outOfTime; round++) {
    settle() // the answer must show what the ranking reads: a free candidate it shows is read live before anything else is decided
    const wanted = routeFirst ? routeFirst(result) : { ranking: [...candidates.keys()].map((key) => key.replace(/^id:/, '')) }
    const batch = choose([...heads.map((key) => [key, true]), ...wanted.ranking.map((id) => [`id:${id}`, true])])
    if (batch.length === 0) break
    await route(batch, round > 1)
  }
  settle()
  // 5. The named areas last, with the time and cap that are left: they share neither with the ranking's rounds.
  if (!outOfTime && routeFirst) {
    const batch = choose((routeFirst(result).named ?? []).map((id) => [`id:${id}`, false]))
    if (batch.length > 0) await route(batch, true) // no settling after this: nothing a name bought may be read by the ranking
  }

  // The trips whose routed (or cached, or walked) time the answer read.
  const used = new Set([...live, ...liveNamed].flatMap((key) => [...candidates.get(key).tripKeys]))
  return { result, travel: countTravel(trips, outcome, used, table, tableAt) }
}
