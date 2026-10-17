import { Router } from 'express'
import { ZodError } from 'zod'
import { converge, hardFilterContext, meetingArea, meetingAreaPlan, resolveMembers, roam, searchVenues } from '../planner/engine.js'
import { filterByConstraints } from '../planner/filters.js'
import { fromGooglePlaces } from '../planner/google-adapter.js'
import { centroid, fairnessWeights, haversineKm, minimaxCenter } from '../planner/geo.js'
import { dropKnownPlaces, withEstimatedMrtWalk } from '../db/venues.js'
import {
  GOOGLE_TIMEOUT_MS,
  GoogleUnavailableError,
  PHOTO_NAME,
  PLACE_ID,
  PLACE_SEARCH_FIELDS,
  snapPhotoWidth,
} from '../services/google-places.js'
import { createWeatherResolver, placeVenues } from '../planner/weather-window.js'
import { OneMapUnavailableError } from '../services/budget.js'
import { ExternalApiError } from '../services/errors.js'
import { currentScenario } from '../services/scenario.js'
import { estimateTravel, ROUTING_DEADLINE_MS, runWithRealTravel } from '../services/travel-times.js'
import { MAX, makePlanSchemas, SINGAPORE_BOUNDS } from './plan-schemas.js'
import { arrangeCandidates, freshCandidates } from '../planner/arrange.js'
import { createItineraryAi } from '../services/itinerary-ai.js'

// The planner endpoints the frontend calls. Full request and response shapes: backend/docs/planner-api.md.
//
//   POST /api/meeting-area  where the group should meet (a named MRT station or neighbourhood)
//   POST /api/converge      rank venues for the group around a point (one call per itinerary slot)
//   POST /api/roam          rank venues near one person's current point ("What next?")
//   POST /api/search        find a venue by name, address or postal code to add as an option (our places, OneMap for a
//                           postal code, and Google), and say whether it fits the slot
//   GET  /api/places/search find an address, postal code or building with OneMap (and a place by name with Google, when
//                           OneMap finds nothing), for start and end points and meeting spots
//   GET  /api/places/photo  a Google place photo, by its name (redirects to the image; the key stays on the server)
//   POST /api/itinerary/arrange  a new order for a confirmed itinerary, chosen by an AI, Gemini or Claude (food stays at meal times)
//
// How to mount it (app.js does this):
//   app.use('/api', createPlanRouter({ data: loadPlanData(), weather, onemap, places, allowSimulatedWeather: false }))
//
// To shorten the time one request waits for OneMap, for a test:
//   createPlanRouter({ data, weather, onemap, routingDeadlineMs: 50 })
//
// Weather. /converge and /roam score each venue against the weather, and say where it came from in a top-level
// `weather: { source, basis, issuedAt?, validUntil?, phrase?, reason?, simulationIgnored? }`. Which forecast is used
// depends on how far away the stop's `dateTime` is (planner/weather-window.js):
//   live         the area forecast (two-hour) when the stop is within two hours, or the regional forecast (24-hour)
//                when a period of it covers the stop. Each venue is scored from the forecast of its nearest forecast
//                area, or of the region that area falls in. `validUntil` is when that forecast ends.
//   simulated    the request sent `weatherCase` and the server allows it (ALLOW_SIMULATED_WEATHER=1, or stub mode).
//                It applies at any date.
//   unavailable  the forecast could not be fetched. The planner falls back to the `clear` case and still answers.
//   none         the stop is further ahead than the regional forecast reaches: weather has no effect on the ranking.
// A request that sends `weatherCase` to a server that does not allow it is still answered: the field is ignored,
// the real forecast is used, and the answer carries `weather.simulationIgnored: true`. The frontend sends
// `weatherCase` on every ranking, so refusing it would break every slot.
//
// `limiter` is an optional middleware (see middleware/rate-limit.js) that runs before each planner route.
// `ai` is the itinerary AI from services/itinerary-ai.js. Without one, /itinerary/arrange chooses by its rules.
//
// Travel times. /meeting-area, /converge and /roam say where theirs came from in a top-level
// `travel: { source, asked, routed, cached, walked, failed, estimated }` (the numbers add up, see
// services/travel-times.js):
//   onemap    real public transport times from OneMap (services/onemap.js), fetched before the engine runs
//             (services/travel-times.js). A trip OneMap could not answer falls back to the estimate, and that
//             result is marked `approximate`.
//   estimate  the engine's own estimate: there is no OneMap service, or it has no account, or every call failed.
// One request makes at most 60 OneMap route calls, for whole venues or areas only. The rest keep the estimate.

// Singapore local time now, as the planner writes it: "2026-10-10T19:00".
const nowInSingapore = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16)

// With routing on, the "best MRT station" check tries only the 16 areas nearest the fairest point, not all 37:
// 16 never missed the best area in 2,000 random groups (see docs/engine-integration.md), and it cuts the calls.
const MEETING_CANDIDATES_WITH_ROUTING = 16

// Of those, only the 5 whose estimated result is best get real routes. The others keep the estimate.
const MEETING_AREAS_ROUTED = 5

// What one ranking may spend on Google besides its nearby search, for the places in `currentOptionIds` that Google
// has to be asked about (MAX.googleOptions of them are read from the request). Of those not already cached or
// remembered as missing, at most this many are looked up, and at most this many at once, so one request cannot hold
// every one of the 4 Google slots, and an invented id costs one paid call, once, not one per request.
const GOOGLE_LOOKUPS_PER_REQUEST = 3
const GOOGLE_LOOKUPS_AT_ONCE = 2

// All that Google may add to one ranking (the nearby search and the look-ups together) waits at most one Google call
// timeout plus this grace, so a hung Google costs a ranking about 3 seconds, not the 9 the two steps took in turn.
const GOOGLE_GRACE_MS = 250

// Where a place search with no meeting point leans: the middle of Singapore, and a circle around it (in metres) wide
// enough to take in the whole island (about 50 km across; Google allows up to 50,000 m).
const SINGAPORE_CENTRE = { lat: 1.3521, lng: 103.8198 }
const SINGAPORE_BIAS_METERS = 25_000

// The location search asks Google only for a name that could be a place: at least this many characters, with a letter in
// it. A postal code and each prefix of what a person is typing are OneMap's to answer.
const MIN_PLACE_QUERY = 4

// POST /api/search does not ask Google for fewer characters than this, nor match an address with fewer.
const MIN_SEARCH_QUERY = 3

// Google places. /converge and /roam add restaurants, cafés, bars, dessert shops, malls and private activities (bowling,
// cinemas, karaoke, arcades, galleries...) from Google near the point they rank around, and the Google places the group
// already has as options (looked up by id), for that request only (Google's terms do not allow saving them), and say so in
// `google: { source, added, missing? }`:
//   google        `added` places came from Google near the point (places the venue list already has are skipped)
//   off           this server has no GOOGLE_MAPS_API_KEY
//   not_needed    the request asked for no category Google is used for
//   unavailable   Google could not be used (it failed, its budget of calls for the minute is used up, or it is paused after
//                 repeated failures); the planner answers with its other venues
// `missing` is there only when Google is on and some option ids "google_..." in `currentOptionIds` could not be looked
// up this time (Google no longer has the place, a look-up failed or was over this request's limit, or it is not an outing).

// Runs `fn` on each item, at most `limit` at a time and in order, and starts no new one once `stop()` says so. The
// slot of an item that was never started stays undefined.
//
// How to call:
//   await inPool(ids, 2, async (id) => lookUp(id), () => deadline.passed())
async function inPool(items, limit, fn, stop = () => false) {
  let next = 0
  const worker = async () => {
    while (next < items.length && !stop()) await fn(items[next++])
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker))
}

// A timer for one request. `race(promise)` resolves to DEADLINE_PASSED when the time is up before the promise settles; the
// promise itself keeps running (the Google service ends it with its own timeout) and a late failure is not reported.
// `stop()` clears the timer and must always be called.
//
// How to call:
//   const deadline = startDeadline(3250)
//   try { const out = await deadline.race(work()) } finally { deadline.stop() }
const DEADLINE_PASSED = Symbol('deadline passed')
function startDeadline(ms) {
  let timer
  let passed = false
  const expired = new Promise((resolve) => {
    timer = setTimeout(() => {
      passed = true
      resolve(DEADLINE_PASSED)
    }, ms)
  })
  return { passed: () => passed, race: (promise) => Promise.race([promise, expired]), stop: () => clearTimeout(timer) }
}

// Google tops up, it does not flood (ticket #149): it is asked about a category only when we know fewer than this many open
// places of it near the meeting point.
export const OWN_PLACES_ENOUGH = 6

export function createPlanRouter({
  data,
  weather,
  now = Date.now,
  weatherResolver = createWeatherResolver({ data, weather, now }),
  onemap = null,
  places = null,
  ai = createItineraryAi(),
  allowSimulatedWeather = false,
  limiter = null,
  routingDeadlineMs = ROUTING_DEADLINE_MS,
  ownPlacesEnough = OWN_PLACES_ENOUGH,
}) {
  const schemas = makePlanSchemas(data)
  const router = Router()

  // Stub mode only (Playwright): the x-jio-scenario header picks whether routing fails. The weather scenario
  // reaches the forecast through the HTTP helper, so it needs nothing here. Outside stub mode currentScenario()
  // is always 'dry', so nothing changes.
  const depsFor = () => (currentScenario() === 'routing-fail' ? { travelMinutes: () => null } : {})

  // Works out which weather one request is scored against. Never throws because data.gov.sg is down.
  //
  // How to call:
  //   const resolved = await resolveWeather(input) // { weatherCase, planData, forecast, weather, ... }
  //
  // `resolved` is also what placeVenues(resolved, venues) needs to put a venue added later in the request under the
  // same weather (see readyGoogleVenues). Its `forecast` is the same shape for the area and the regional forecast, and
  // undefined for a simulated forecast and for "no effect".
  const resolveWeather = (input) => weatherResolver.resolve({ start: input.dateTime, weatherCase: input.weatherCase })

  // The point a request ranks around: Roam's current point, Converge's given centre, or else the group's seed point,
  // worked out from the same functions and the same rule as the engine's converge() (its `seed` and
  // `fairnessScaleMinutes`), so Google's places are fetched around the point the engine ranks around.
  //
  // How to call:
  //   const point = rankingPoint(input) // { lat, lng }, or null when nobody is left to plan for
  function rankingPoint(input) {
    if (input.current) return input.current
    if (input.centre) return input.centre
    const members = resolveMembers(input.members, input.overrides, input.optedOut)
    if (members.length === 0) return null
    const starts = members.map((m) => m.start)
    if (input.seed === 'minimax') return minimaxCenter(starts).center
    if (input.seed === 'centroid') return centroid(starts)
    return centroid(starts, fairnessWeights(members, input.fairnessScaleMinutes ?? 60))
  }

  // Venues from Google places, ready for the engine: each placed under the weather the ranking is scored on (all four
  // bases, see placeVenues in planner/weather-window.js) and given an estimated walk to the MRT, like the nearby ones.
  // `resolved` is what resolveWeather() answered; without it (POST /api/search, which does not score weather) venues
  // keep their own region label.
  //
  // How to call:
  //   const venues = readyGoogleVenues(fromGooglePlaces(raw, dateTime), resolved)
  function readyGoogleVenues(venues, resolved = null) {
    const placed = resolved ? placeVenues(resolved, venues) : venues
    return placed.map((v) => withEstimatedMrtWalk(v, data.areas))
  }

  // The Google place ids "google_..." in the request's options that the plan data does not have (a place someone found
  // by searching is usually not among the 20 nearest), in order and once each.
  //
  // How to call:
  //   const ids = googleOptionIds(input, planData) // ['google_ChIJ...']
  const googleOptionIds = (input, planData) => {
    const known = new Set(planData.venues.map((v) => v.id))
    return [...new Set(input.currentOptionIds ?? [])].filter((id) => id.startsWith('google_') && !known.has(id))
  }

  // Looks up the Google places the group already has as options, by id, so the ranking knows them. Cheap by design:
  // a place cached or remembered as missing costs nothing, at most GOOGLE_LOOKUPS_PER_REQUEST of the others are asked
  // for, at most GOOGLE_LOOKUPS_AT_ONCE at once, and none starts after the deadline. Whatever is not found this time
  // is simply left out; the caller lists it. Never throws because Google is down.
  //
  // How to call:
  //   const venues = await lookUpGoogleOptions(input, planData, resolved, deadline) // ready venues
  async function lookUpGoogleOptions(input, planData, resolved, deadline) {
    const wanted = googleOptionIds(input, planData)
      .filter((id) => PLACE_ID.test(id.slice(7)))
      .slice(0, MAX.googleOptions)
    const found = [] // Filled as look-ups finish, so those done before the deadline still count.
    const toAsk = []
    for (const id of wanted) {
      const plan = places.peekDetails?.(id.slice(7)) ?? { state: 'call' }
      if (plan.state === 'cached') found.push(plan.place)
      else if (plan.state === 'call' && toAsk.length < GOOGLE_LOOKUPS_PER_REQUEST) toAsk.push(id)
    }
    await deadline.race(
      inPool(
        toAsk,
        GOOGLE_LOOKUPS_AT_ONCE,
        async (id) => {
          try {
            const raw = await places.details(id.slice(7))
            if (raw) found.push(raw)
          } catch (err) {
            // Only an API failure is "not found this time". A bug must still reach the error handler.
            if (!(err instanceof ExternalApiError)) throw err
          }
        },
        deadline.passed,
      ),
    )
    // A searched place that is not an outing (a bank typed in by hand) is not rankable.
    const venues = fromGooglePlaces([...found], input.dateTime ?? nowInSingapore(), { searched: true }).filter((v) => !v.notAnOuting)
    return readyGoogleVenues(venues, resolved)
  }

  // Google's restaurants, cafés and so on near the ranking point, ready for the engine; places the plan data already
  // has are skipped. Never throws because Google is down.
  //
  // How to call:
  //   const { venues, google } = await nearbyGoogleVenues(input, planData, resolved)
  async function nearbyGoogleVenues(input, planData, resolved) {
    const wanted = (input.categories ?? (input.current ? ['eat', 'drink', 'activity'] : ['eat', 'drink'])).filter((c) => ['eat', 'drink', 'shop', 'activity'].includes(c))
    if (wanted.length === 0) return { venues: [], google: { source: 'not_needed', added: 0 } }
    const point = rankingPoint(input)
    if (!point) return { venues: [], google: { source: 'not_needed', added: 0 } }
    // Count our own places first: those the engine itself would keep for this request (its hard filters, run with the same
    // context: diet, group constraints, a last stop's near-MRT rule, closed days, duration, capacity, exclusions), inside the
    // circle Google would search. A category with enough of them is not asked of Google.
    const radiusMeters = input.radiusMeters ?? 1000
    const members = input.current ? input.members : resolveMembers(input.members, input.overrides, input.optedOut)
    const ctx = { ...hardFilterContext(input, members, input.current ? 'roam' : 'converge'), categories: wanted }
    const own = { eat: 0, drink: 0, shop: 0, activity: 0 }
    const ours = planData.venues.filter((v) => v.source !== 'google' && haversineKm(point, v) * 1000 <= radiusMeters)
    for (const v of filterByConstraints(ours, ctx).passed) own[v.category] += 1
    const ask = wanted.filter((c) => own[c] < ownPlacesEnough)
    if (ask.length === 0) return { venues: [], google: { source: 'not_needed', added: 0, reason: 'enough_own_places' } }
    const skipped = wanted.filter((c) => !ask.includes(c))
    let raw
    try {
      raw = await places.nearby(point, { categories: ask, radiusMeters })
    } catch (err) {
      // Only an API failure falls back. A bug must still reach the error handler. The Google service logs the
      // failure itself, at most once a minute per reason, so it is not logged again here.
      if (!(err instanceof ExternalApiError)) throw err
      return { venues: [], google: { source: 'unavailable', added: 0 } }
    }
    // Only places of the categories this request is for: a dessert shop Google sends for a café search is food.
    // A place Google sent in a shape the adapter cannot read is skipped, never fatal.
    const fresh = dropKnownPlaces(
      fromGooglePlaces(raw, input.dateTime).filter((v) => ask.includes(v.category)),
      planData.venues,
    )
    const venues = readyGoogleVenues(fresh, resolved)
    return { venues, google: { source: 'google', added: venues.length, ...(skipped.length > 0 && { skipped }) } }
  }

  // Adds Google's places to this request's plan data: the nearby search and the look-ups of the options already chosen,
  // run together under one deadline (one Google call timeout plus a short grace). Never throws because Google is down.
  // Says what happened in `google` (see the top of this file), with `missing`: the ids "google_..." among the options
  // that could not be looked up this time.
  //
  // How to call:
  //   const { planData: withGoogle, google } = await addGoogle(input, planData, resolved)
  async function addGoogle(input, planData, resolved) {
    if (!places?.enabled) return { planData, google: { source: 'off', added: 0 } }
    const deadline = startDeadline((places.timeoutMs ?? GOOGLE_TIMEOUT_MS) + GOOGLE_GRACE_MS)
    let nearby
    let options
    try {
      // The options are looked up without waiting for the nearby search, so a place that is also one of the 20 nearest
      // may be asked for once more than needed; it is dropped below, and cached for the next request.
      ;[nearby, options] = await Promise.all([
        deadline.race(nearbyGoogleVenues(input, planData, resolved)),
        lookUpGoogleOptions(input, planData, resolved, deadline),
      ])
    } finally {
      deadline.stop()
    }
    if (nearby === DEADLINE_PASSED) nearby = { venues: [], google: { source: 'unavailable', added: 0 } }
    const have = new Set([...planData.venues, ...nearby.venues].map((v) => v.id))
    const looked = options.filter((v) => !have.has(v.id))
    const venues = [...planData.venues, ...nearby.venues, ...looked]
    const present = new Set(venues.map((v) => v.id))
    const missing = googleOptionIds(input, planData).filter((id) => !present.has(id))
    return {
      planData: nearby.venues.length || looked.length ? { ...planData, venues } : planData,
      google: { ...nearby.google, ...(missing.length > 0 && { missing }) },
    }
  }

  // A Google place as a row of the location search, or null when it is not one to show: no name (Google sometimes sends
  // a place without one), a name that is only digits (a bare address), no point, or a point outside Singapore (the bias
  // prefers places on the island but does not exclude others).
  //
  // How to call:
  //   const row = googleRow(rawPlace) // { name, address, postal, lat, lng, source: 'google' } or null
  function googleRow(p) {
    const lat = p?.location?.latitude
    const lng = p?.location?.longitude
    const name = typeof p?.displayName?.text === 'string' ? p.displayName.text.trim() : ''
    if (name === '' || /^\d+$/.test(name)) return null
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null
    const { lat: la, lng: lo } = SINGAPORE_BOUNDS
    if (lat < la.min || lat > la.max || lng < lo.min || lng > lo.max) return null
    const address = typeof p.formattedAddress === 'string' ? p.formattedAddress : ''
    return { name, address, postal: address.match(/Singapore (\d{6})/)?.[1] ?? null, lat, lng, source: 'google' }
  }

  // Addresses, postal codes and buildings for GET /api/places/search: OneMap first (free, and it knows every address
  // and postal code). Only when OneMap finds nothing, and the words look like a place's name (a letter in them, at least
  // MIN_PLACE_QUERY characters), Google's text search adds places by name (a shop, a karaoke, a landmark OneMap does not
  // list), asking for no more than a name, an address and a point. Each is { name, address, postal, lat, lng, source },
  // at most 10: source says 'onemap' or 'google', and postal is a string or null. Throws ExternalApiError only when
  // neither could answer.
  //
  // How to call:
  //   const results = await searchAddresses('Teo Heng')
  async function searchAddresses(q) {
    let found = []
    let failure = null
    if (onemap) {
      try {
        // A copy: OneMap's answer is the array in its 24-hour cache, and nothing here may change that.
        found = (await onemap.search(q)).map((r) => ({ ...r, source: 'onemap' }))
      } catch (err) {
        if (!(err instanceof ExternalApiError)) throw err
        failure = err
      }
    }
    if (found.length === 0 && places?.enabled && q.length >= MIN_PLACE_QUERY && /\p{L}/u.test(q)) {
      try {
        const raw = await places.searchText(q, SINGAPORE_CENTRE, { fieldMask: PLACE_SEARCH_FIELDS, biasMeters: SINGAPORE_BIAS_METERS })
        const seen = new Set()
        for (const p of raw) {
          const row = googleRow(p)
          const key = row && `${row.name.toLowerCase()}|${row.address.toLowerCase()}`
          if (!row || seen.has(key)) continue
          seen.add(key)
          found.push(row)
        }
        // OneMap's failure is forgotten only when Google had something to show in its place.
        if (found.length > 0) failure = null
      } catch (err) {
        if (!(err instanceof ExternalApiError)) throw err
      }
    }
    if (failure && found.length === 0) throw failure
    // A home address comes back from OneMap named only by its postal code ("760201"): name it by its street address.
    return found.slice(0, 10).map((r) => (/^\d+$/.test(r.name ?? '') && r.address ? { ...r, name: r.address } : r))
  }

  // POST /api/search: our saved places by name, area or address; for a postal code, also the saved places at that
  // building (found with OneMap); and Google's places matching the words (text search near the meeting point), so a
  // place like "Teo Heng" or "Have Fun Karaoke" can be found even though it is not saved and not among the 20 nearest.
  // Google's places come back with an id starting "google_"; adding one as an option works because the ranking looks
  // it up by id (lookUpGoogleOptions). Says where Google stood in `google: { source, added }` as /converge does ('not_needed'
  // for words shorter than MIN_SEARCH_QUERY characters, which Google is not asked). OneMap or Google being down never
  // fails the search: it answers with what it has.
  //
  // How to call (the route does this):
  //   const { results, google } = await searchEverywhere(input, data)
  async function searchEverywhere(input, planData) {
    const query = input.query.trim()
    const postal = /^\d{6}$/.test(query)
    const alsoMatch = []
    let venues = planData.venues

    // A postal code: the saved places within 150 m of the building OneMap finds for it.
    if (postal && onemap) {
      try {
        const [hit] = await onemap.search(query)
        if (hit) for (const v of venues) if (haversineKm(hit, v) <= 0.15) alsoMatch.push(v.id)
      } catch (err) {
        if (!(err instanceof ExternalApiError)) throw err
      }
    }

    // Google: places matching whatever was typed, near the meeting point. Every kind is kept: a place of another kind
    // than the slot comes back marked 'category', so the screen can say "Eat, not Activity" instead of hiding it.
    let google = { source: 'off', added: 0 }
    if (places?.enabled && query.length < MIN_SEARCH_QUERY) {
      google = { source: 'not_needed', added: 0 }
    } else if (places?.enabled) {
      try {
        const raw = await places.searchText(postal ? `Singapore ${query}` : query, input.centre)
        // Google sometimes answers a postal code with the bare address, named only by its number: not a place to go.
        const named = raw.filter((p) => !/^\d+$/.test(p?.displayName?.text ?? ''))
        // Saved places are matched by name only: an unrelated saved place of the same kind close by must not hide it.
        const fresh = readyGoogleVenues(dropKnownPlaces(fromGooglePlaces(named, input.dateTime, { searched: true }), venues, { sameKindMeters: 0 }))
        for (const v of fresh) alsoMatch.push(v.id)
        venues = [...venues, ...fresh]
        google = { source: 'google', added: fresh.length }
      } catch (err) {
        if (!(err instanceof ExternalApiError)) throw err
        google = { source: 'unavailable', added: 0 }
      }
    }

    return { results: searchVenues({ ...input, alsoMatch }, { ...planData, venues }), google }
  }

  // Runs the engine with real OneMap travel times when routing is on, and with the estimate otherwise.
  //
  // `options` go to runWithRealTravel: { maxCandidates, rankByEstimate } for the meeting area's shortlist. They may
  // be a function of the request, for options that depend on what it asks for.
  //
  // How to call:
  //   const { result, travel } = await runWithTravel(input, planData, converge)
  async function runWithTravel(input, planData, run, options = {}) {
    if (!onemap?.routingEnabled) {
      return { result: run(input, planData, depsFor()), travel: estimateTravel() }
    }
    return runWithRealTravel({
      ...(typeof options === 'function' ? options(input) : options),
      onemap,
      deadlineMs: routingDeadlineMs,
      dateTime: input.dateTime ?? nowInSingapore(),
      run: (deps) => run(input, planData, deps),
    })
  }

  // The API's names for how many options to look for, in the engine's words: minOptions is the radius search's
  // minResults, shortlistSize is the engine's pruneTo. Left out, the engine keeps its defaults (3 and 10).
  //
  // How to call:
  //   const engineInput = withOptionCounts({ ...input, minOptions: 10, shortlistSize: 20 })
  const withOptionCounts = (input) => ({
    ...input,
    ...(input.shortlistSize !== undefined && { pruneTo: input.shortlistSize }),
    ...(input.minOptions !== undefined && { radius: { minResults: input.minOptions } }),
  })

  // Answers 400 in the shape every planner error uses: { error, message }, plus the field errors in `issues`.
  //
  // How to call:
  //   invalid(res, [{ path: 'weatherCase', message: 'switched off' }])
  const invalid = (res, issues) =>
    res.status(400).json({ error: 'invalid_input', message: 'Some fields in the request are missing or not valid. See issues.', issues })

  // Wraps a handler: checks the body, runs the engine, answers 400 with the field errors on bad input.
  // With `usesWeather` it also resolves the weather first and adds `weather` to the answer.
  // With `usesTravel` it runs the engine with real OneMap travel times when it can, and adds `travel`.
  // `travelOptions` are passed on to runWithRealTravel.
  //
  // How to call:
  //   router.post('/converge', handle(schemas.converge, converge, { usesWeather: true, usesTravel: true }))
  const handle = (schema, run, { usesWeather = false, usesTravel = false, travelOptions = {} } = {}) => async (req, res, next) => {
    try {
      const input = schema.parse(req.body ?? {})
      if (!usesWeather) {
        if (!usesTravel) {
          res.json(await run(input, data, depsFor()))
          return
        }
        const { result, travel } = await runWithTravel(input, data, run, travelOptions)
        res.json({ ...result, travel })
        return
      }
      // A simulated forecast the server does not allow is dropped, and the answer says so.
      const simulationIgnored = input.weatherCase !== undefined && !allowSimulatedWeather
      const resolved = await resolveWeather(simulationIgnored ? { ...input, weatherCase: undefined } : input)
      const { weatherCase, planData: weatherData, weather: weatherBlock } = resolved
      const { planData, google } = await addGoogle(input, weatherData, resolved)
      const { result, travel } = usesTravel
        ? await runWithTravel(withOptionCounts({ ...input, weatherCase }), planData, run, travelOptions)
        : { result: await run(withOptionCounts({ ...input, weatherCase }), planData, depsFor()) }
      res.json({
        ...result,
        ...(travel && { travel }),
        google,
        weather: { ...weatherBlock, ...(simulationIgnored && { simulationIgnored: true }) },
      })
    } catch (err) {
      if (err instanceof ZodError) {
        invalid(res, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
      } else {
        next(err)
      }
    }
  }

  // The limiter, when there is one, runs before each planner route and no other.
  const guard = limiter ? [limiter] : []

  // With routing on, the meeting area tries 16 candidate areas unless the request says otherwise. A method other
  // than station tries them only to find runners-up, so only when the request asks for some.
  //
  // How to call:
  //   const effective = withRoutingCandidates(input) // input, or input with maxCandidates: 16
  const withRoutingCandidates = (input) =>
    onemap?.routingEnabled && (input.method === 'station' || input.alternatives > 0) && !input.maxCandidates
      ? { ...input, maxCandidates: MEETING_CANDIDATES_WITH_ROUTING }
      : input
  const meetingAreaWithRouting = (input, planData, deps) => meetingArea(withRoutingCandidates(input), planData, deps)

  // The meeting area tries many areas, so only the best few by estimate get real routes (see travel-times.js).
  // A request that asks for runners-up or names areas also routes the named ones after those, within the same cap.
  //
  // How to call:
  //   runWithRealTravel({ ...meetingAreaTravelFor(input), onemap, dateTime, run })
  const meetingAreaTravel = { rankByEstimate: true, maxCandidates: MEETING_AREAS_ROUTED }
  const meetingAreaTravelFor = (input) => {
    if (input.alternatives === undefined && input.include === undefined) return meetingAreaTravel
    const { outside } = meetingAreaPlan(withRoutingCandidates(input), data)
    return { ...meetingAreaTravel, namedAreas: { notShortlisted: outside, afterShortlist: input.include ?? [] } }
  }
  router.post(
    '/meeting-area',
    ...guard,
    handle(schemas.meetingArea, meetingAreaWithRouting, { usesTravel: true, travelOptions: meetingAreaTravelFor }),
  )
  router.post('/converge', ...guard, handle(schemas.converge, converge, { usesWeather: true, usesTravel: true }))
  router.post('/roam', ...guard, handle(schemas.roam, roam, { usesWeather: true, usesTravel: true }))
  router.post('/search', ...guard, handle(schemas.search, searchEverywhere))

  // A new order for a confirmed itinerary. Food stops keep their place, so meals stay at meal times; the other
  // stops are put in the order the AI (Gemini or Claude) finds nicest among the orders that keep every place open
  // (services/itinerary-ai.js). The app asks once, when the group confirms, with `includeCurrent` (the voted order may
  // be the best). A caller that wants a different order each time sends the orders already shown in `shown`; once
  // every order has been shown it starts again and says `restarted: true`. The AI is bounded in cost and time (a call
  // budget, a pause after failures, a cache and an 8 second deadline); when it cannot answer, the rules do, at once.
  //
  // Answers { status: 'ok', order: [stop ids], stops: [{ id, start, end }], reason, source: 'ai' | 'rules',
  // restarted, others } or { status: 'no_other_order', message, blockers } when nothing else fits (for example one
  // movable stop).
  router.post('/itinerary/arrange', ...guard, async (req, res, next) => {
    try {
      const input = schemas.arrange.parse(req.body ?? {})
      const { candidates, movable, blockers } = arrangeCandidates(input)
      const { options, restarted } = freshCandidates(candidates, input.shown, { includeCurrent: input.includeCurrent })
      if (options.length === 0) {
        // A reason that starts with "the plan would end" is a sentence of its own here, so it gets its capital letter.
        const why = movable < 2 ? 'Only one stop can move: food stays at meal times.' : blockers.length ? `${blockers.slice(0, 2).join('; ').replace(/^the plan/, 'The plan')}.` : ''
        res.json({ status: 'no_other_order', message: `No other order works. ${why}`.trim(), blockers })
        return
      }
      const { index, reason, source } = await ai.choose({ options, rain: input.rain })
      const chosen = options[index]
      res.json({
        status: 'ok',
        order: chosen.ids,
        stops: chosen.stops.map((s) => ({ id: s.id, start: s.start, end: s.end })),
        reason,
        source,
        restarted,
        // How many other orders are left to show after this one.
        others: options.length - 1,
      })
    } catch (err) {
      if (err instanceof ZodError) {
        invalid(res, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
      } else {
        next(err)
      }
    }
  })

  // GET /api/places/search?q=520201 -> { results: [{ name, address, postal, lat, lng, source }] }, at most 10.
  // For start and end points and meeting spots: OneMap, and Google by name when OneMap finds nothing and the words
  // look like a name (searchAddresses). Answers 503 when neither can answer or this server has neither.
  // When the server's shared OneMap call budget is used up it also sends Retry-After, in whole seconds.
  router.get('/places/search', ...guard, async (req, res, next) => {
    try {
      const { q } = schemas.placeSearch.parse(req.query)
      if (!onemap && !places?.enabled) {
        res.status(503).json({ error: 'search_unavailable', message: 'Address search is not set up on this server.' })
        return
      }
      res.json({ results: await searchAddresses(q) })
    } catch (err) {
      if (err instanceof ZodError) {
        invalid(res, err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })))
      } else if (err instanceof ExternalApiError) {
        if (err instanceof OneMapUnavailableError && err.retryAfterSeconds !== null) {
          res.set('Retry-After', String(err.retryAfterSeconds))
        }
        res.status(503).json({ error: 'search_unavailable', message: 'Address search is not available right now. Try again soon.' })
      } else {
        next(err)
      }
    }
  })

  // GET /api/places/photo?name=places/<id>/photos/<id>&maxWidth=400 -> a redirect to the image.
  // A Google venue carries `photo.name`; the browser asks here, the server asks Google with the key, and the
  // browser is sent to the short-lived image link Google returns, only when that is an https address on one of
  // Google's image hosts. Show every author in `photo.credits` (and Google's attribution) with the image.
  //   maxWidth  rounded up to 200, 400, 800 or 1600 pixels (400 when missing)
  //   302       Cache-Control: public, max-age=1800
  //   400       the name is not a photo address (each id is 1 to 300 characters)
  //   404       Google has no such photo (remembered for 5 minutes)
  //   502       Google sent a link that is not one of its image addresses
  //   503       no Google on this server, Google failed, its call budget is used up, or it is paused
  router.get('/places/photo', ...guard, async (req, res, next) => {
    try {
      const name = String(req.query.name ?? '')
      const maxWidth = snapPhotoWidth(Number(req.query.maxWidth) || 400)
      if (!PHOTO_NAME.test(name)) {
        invalid(res, [{ path: 'name', message: 'a Google photo name, like places/<id>/photos/<id>' }])
        return
      }
      if (!places?.enabled) {
        res.status(503).json({ error: 'photos_unavailable', message: 'Place photos are not set up on this server.' })
        return
      }
      const url = await places.photoUrl(name, maxWidth)
      if (!url) {
        res.status(404).json({ error: 'not_found', message: 'Google has no image for that photo.' })
        return
      }
      res.set('Cache-Control', 'public, max-age=1800')
      res.redirect(302, url)
    } catch (err) {
      if (err instanceof GoogleUnavailableError && err.reason === 'bad_response') {
        res.status(502).json({ error: 'photos_unavailable', message: 'Google sent an image link that cannot be used.' })
      } else if (err instanceof ExternalApiError) {
        res.status(503).json({ error: 'photos_unavailable', message: 'Place photos are not available right now.' })
      } else {
        next(err)
      }
    }
  })

  return router
}
