import { Router } from 'express'
import { ZodError } from 'zod'
import { converge, meetingArea, meetingAreaPlan, resolveMembers, roam, searchVenues } from '../planner/engine.js'
import { fromGooglePlaces } from '../planner/google-adapter.js'
import { centroid, fairnessWeights, minimaxCenter } from '../planner/geo.js'
import { dropKnownPlaces, withEstimatedMrtWalk } from '../db/venues.js'
import { GoogleUnavailableError, PHOTO_NAME, snapPhotoWidth } from '../services/google-places.js'
import { LIVE_WEATHER_CASE, withLiveWeather } from '../planner/live-weather.js'
import { OneMapUnavailableError } from '../services/budget.js'
import { ExternalApiError } from '../services/errors.js'
import { currentScenario } from '../services/scenario.js'
import { estimateTravel, ROUTING_DEADLINE_MS, runWithRealTravel } from '../services/travel-times.js'
import { makePlanSchemas } from './plan-schemas.js'

// The planner endpoints the frontend calls. Full request and response shapes: backend/docs/planner-api.md.
//
//   POST /api/meeting-area  where the group should meet (a named MRT station or neighbourhood)
//   POST /api/converge      rank venues for the group around a point (one call per itinerary slot)
//   POST /api/roam          rank venues near one person's current point ("What next?")
//   POST /api/search        find a venue by name to add as an option, and say whether it fits the slot
//   GET  /api/places/search find an address, postal code or building with OneMap, for start and end points
//   GET  /api/places/photo  a Google place photo, by its name (redirects to the image; the key stays on the server)
//
// How to mount it (app.js does this):
//   app.use('/api', createPlanRouter({ data: loadPlanData(), weather, onemap, places, allowSimulatedWeather: false }))
//
// To shorten the time one request waits for OneMap, for a test:
//   createPlanRouter({ data, weather, onemap, routingDeadlineMs: 50 })
//
// Weather. /converge and /roam score each venue against the weather, and say where it came from in a top-level
// `weather: { source, validUntil?, simulationIgnored? }`:
//   live         the two-hour forecast from data.gov.sg (cached for five minutes). Each venue is scored from the
//                forecast of its nearest forecast area. `validUntil` is when that forecast ends.
//   simulated    the request sent `weatherCase` and the server allows it (ALLOW_SIMULATED_WEATHER=1, or stub mode).
//   unavailable  the forecast could not be fetched. The planner falls back to the `clear` case and still answers.
// A request that sends `weatherCase` to a server that does not allow it is still answered: the field is ignored,
// the real forecast is used, and the answer carries `weather.simulationIgnored: true`. The frontend sends
// `weatherCase` on every ranking, so refusing it would break every slot.
//
// `limiter` is an optional middleware (see middleware/rate-limit.js) that runs before each planner route.
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

// Google places. /converge and /roam add restaurants, cafés, bars, dessert shops, malls and private activities (bowling,
// cinemas, karaoke, arcades, galleries...) from Google near the point they
// rank around, for that request only (Google's terms do not allow saving them), and say so in
// `google: { source, added }`:
//   google        `added` places came from Google (places the venue list already has are skipped)
//   off           this server has no GOOGLE_MAPS_API_KEY
//   not_needed    the request asked for no category Google is used for
//   unavailable   Google could not be used (it failed, its budget of calls for the minute is used up, or it is paused after
//                 repeated failures); the planner answers with its other venues

export function createPlanRouter({
  data,
  weather,
  onemap = null,
  places = null,
  allowSimulatedWeather = false,
  limiter = null,
  routingDeadlineMs = ROUTING_DEADLINE_MS,
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
  //   const { source, validUntil, weatherCase, planData } = await resolveWeather(input)
  async function resolveWeather(input) {
    if (input.weatherCase !== undefined) return { source: 'simulated', weatherCase: input.weatherCase, planData: data }
    try {
      const forecast = await weather.twoHourForecast()
      return {
        source: 'live',
        validUntil: forecast.validPeriod.end ?? undefined,
        weatherCase: LIVE_WEATHER_CASE,
        planData: withLiveWeather(data, forecast),
        forecast,
      }
    } catch (err) {
      // Only an API failure falls back. A bug must still reach the error handler.
      if (!(err instanceof ExternalApiError)) throw err
      console.warn(`Weather unavailable, planning as if clear: ${err.message}`)
      return { source: 'unavailable', weatherCase: 'clear', planData: data }
    }
  }

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

  // Adds Google's restaurants and cafés near the ranking point to this request's plan data. Places the venue list
  // already has are skipped. With a live forecast, each is placed in its forecast area the way every other venue is.
  // Never throws because Google is down.
  //
  // How to call:
  //   const { planData: withGoogle, google } = await addGooglePlaces(input, planData, forecast)
  async function addGooglePlaces(input, planData, forecast) {
    const wanted = (input.categories ?? (input.current ? ['eat', 'drink', 'activity'] : ['eat', 'drink'])).filter((c) => ['eat', 'drink', 'shop', 'activity'].includes(c))
    if (!places?.enabled) return { planData, google: { source: 'off', added: 0 } }
    if (wanted.length === 0) return { planData, google: { source: 'not_needed', added: 0 } }
    const point = rankingPoint(input)
    if (!point) return { planData, google: { source: 'not_needed', added: 0 } }
    let raw
    try {
      raw = await places.nearby(point, { categories: wanted, radiusMeters: input.radiusMeters ?? 1000 })
    } catch (err) {
      // Only an API failure falls back. A bug must still reach the error handler. The Google service logs the
      // failure itself, at most once a minute per reason, so it is not logged again here.
      if (!(err instanceof ExternalApiError)) throw err
      return { planData, google: { source: 'unavailable', added: 0 } }
    }
    // Only places of the categories this request is for: a dessert shop Google sends for a café search is food.
    // A place Google sent in a shape the adapter cannot read is skipped, never fatal.
    let fresh = dropKnownPlaces(
      fromGooglePlaces(raw, input.dateTime).filter((v) => wanted.includes(v.category)),
      planData.venues,
    )
    if (forecast) fresh = withLiveWeather({ ...planData, venues: fresh }, forecast).venues
    fresh = fresh.map((v) => withEstimatedMrtWalk(v, data.areas))
    return { planData: { ...planData, venues: [...planData.venues, ...fresh] }, google: { source: 'google', added: fresh.length } }
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
      const { source, validUntil, weatherCase, planData: weatherData, forecast } = await resolveWeather(
        simulationIgnored ? { ...input, weatherCase: undefined } : input,
      )
      const { planData, google } = await addGooglePlaces(input, weatherData, forecast)
      const { result, travel } = usesTravel
        ? await runWithTravel(withOptionCounts({ ...input, weatherCase }), planData, run, travelOptions)
        : { result: await run(withOptionCounts({ ...input, weatherCase }), planData, depsFor()) }
      res.json({
        ...result,
        ...(travel && { travel }),
        google,
        weather: {
          source,
          ...(validUntil !== undefined && { validUntil }),
          ...(simulationIgnored && { simulationIgnored: true }),
        },
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
  router.post('/search', ...guard, handle(schemas.search, (input, planData) => ({ results: searchVenues(input, planData) })))

  // GET /api/places/search?q=520201 -> { results: [{ name, address, postal, lat, lng }] }, at most 10.
  // For start and end points. Answers 503 when OneMap cannot be reached or this server has no OneMap service.
  // When the server's shared OneMap call budget is used up it also sends Retry-After, in whole seconds.
  router.get('/places/search', ...guard, async (req, res, next) => {
    try {
      const { q } = schemas.placeSearch.parse(req.query)
      if (!onemap) {
        res.status(503).json({ error: 'search_unavailable', message: 'Address search is not set up on this server.' })
        return
      }
      res.json({ results: (await onemap.search(q)).slice(0, 10) })
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
