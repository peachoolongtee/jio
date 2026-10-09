import { Router } from 'express'
import { ZodError } from 'zod'
import { converge, meetingArea, resolveMembers, roam, searchVenues } from '../planner/engine.js'
import { fromGooglePlace } from '../planner/google-adapter.js'
import { centroid, fairnessWeights } from '../planner/geo.js'
import { dropKnownPlaces, withEstimatedMrtWalk } from '../db/venues.js'
import { PHOTO_NAME } from '../services/google-places.js'
import { LIVE_WEATHER_CASE, withLiveWeather } from '../planner/live-weather.js'
import { ExternalApiError } from '../services/errors.js'
import { currentScenario } from '../services/scenario.js'
import { runWithRealTravel } from '../services/travel-times.js'
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
// `travel: { source, routed, failed }`:
//   onemap    real public transport times from OneMap (services/onemap.js), fetched before the engine runs
//             (services/travel-times.js). A trip OneMap could not answer falls back to the estimate, and that
//             result is marked `approximate`.
//   estimate  the engine's own estimate: there is no OneMap service, or it has no account, or every call failed.

// Singapore local time now, as the planner writes it: "2026-10-10T19:00".
const nowInSingapore = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16)

// With routing on, the "best MRT station" check tries only the 16 areas nearest the fairest point, not all 37:
// 16 never missed the best area in 2,000 random groups (see docs/engine-integration.md), and it cuts the calls.
const MEETING_CANDIDATES_WITH_ROUTING = 16

// Google places. /converge and /roam add restaurants, cafés, bars and dessert shops from Google near the point they
// rank around, for that request only (Google's terms do not allow saving them), and say so in
// `google: { source, added }`:
//   google        `added` places came from Google (places the venue list already has are skipped)
//   off           this server has no GOOGLE_MAPS_API_KEY
//   not_needed    the request asked only for shop or activity, which Google is not used for
//   unavailable   Google could not be reached; the planner answers with its other venues

export function createPlanRouter({ data, weather, onemap = null, places = null, allowSimulatedWeather = false, limiter = null }) {
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

  // The point a request ranks around: Roam's current point, Converge's given centre, or else the group's
  // fairness-weighted centre (the engine's default seed).
  function rankingPoint(input) {
    if (input.current) return input.current
    if (input.centre) return input.centre
    const members = resolveMembers(input.members, input.overrides, input.optedOut)
    return members.length ? centroid(members.map((m) => m.start), fairnessWeights(members)) : null
  }

  // Adds Google's restaurants and cafés near the ranking point to this request's plan data. Places the venue list
  // already has are skipped. With a live forecast, each is placed in its forecast area the way every other venue is.
  // Never throws because Google is down.
  //
  // How to call:
  //   const { planData: withGoogle, google } = await addGooglePlaces(input, planData, forecast)
  async function addGooglePlaces(input, planData, forecast) {
    const wanted = (input.categories ?? (input.current ? ['eat', 'drink', 'activity'] : ['eat', 'drink'])).filter((c) => c === 'eat' || c === 'drink')
    if (!places?.enabled) return { planData, google: { source: 'off', added: 0 } }
    if (wanted.length === 0) return { planData, google: { source: 'not_needed', added: 0 } }
    const point = rankingPoint(input)
    if (!point) return { planData, google: { source: 'not_needed', added: 0 } }
    let raw
    try {
      raw = await places.nearby(point, { categories: wanted, radiusMeters: input.radiusMeters ?? 1000 })
    } catch (err) {
      if (!(err instanceof ExternalApiError)) throw err
      console.warn(`Google Places unavailable, planning without it: ${err.message}`)
      return { planData, google: { source: 'unavailable', added: 0 } }
    }
    let fresh = dropKnownPlaces(raw.map((p) => fromGooglePlace(p, input.dateTime)).filter(Boolean), planData.venues)
    if (forecast) fresh = withLiveWeather({ ...planData, venues: fresh }, forecast).venues
    fresh = fresh.map((v) => withEstimatedMrtWalk(v, data.areas))
    return { planData: { ...planData, venues: [...planData.venues, ...fresh] }, google: { source: 'google', added: fresh.length } }
  }

  // Runs the engine with real OneMap travel times when routing is on, and with the estimate otherwise.
  //
  // How to call:
  //   const { result, travel } = await runWithTravel(input, planData, converge)
  async function runWithTravel(input, planData, run) {
    if (!onemap?.routingEnabled) {
      return { result: run(input, planData, depsFor()), travel: { source: 'estimate', routed: 0, failed: 0 } }
    }
    return runWithRealTravel({
      onemap,
      dateTime: input.dateTime ?? nowInSingapore(),
      run: (deps) => run(input, planData, deps),
    })
  }

  // Answers 400 in the shape every planner error uses.
  //
  // How to call:
  //   invalid(res, [{ path: 'weatherCase', message: 'switched off' }])
  const invalid = (res, issues) => res.status(400).json({ error: 'invalid_input', issues })

  // Wraps a handler: checks the body, runs the engine, answers 400 with the field errors on bad input.
  // With `usesWeather` it also resolves the weather first and adds `weather` to the answer.
  // With `usesTravel` it runs the engine with real OneMap travel times when it can, and adds `travel`.
  //
  // How to call:
  //   router.post('/converge', handle(schemas.converge, converge, { usesWeather: true, usesTravel: true }))
  const handle = (schema, run, { usesWeather = false, usesTravel = false } = {}) => async (req, res, next) => {
    try {
      const input = schema.parse(req.body ?? {})
      if (!usesWeather) {
        if (!usesTravel) {
          res.json(await run(input, data, depsFor()))
          return
        }
        const { result, travel } = await runWithTravel(input, data, run)
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
        ? await runWithTravel({ ...input, weatherCase }, planData, run)
        : { result: await run({ ...input, weatherCase }, planData, depsFor()) }
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

  // With routing on, the meeting area tries 16 candidate areas unless the request says otherwise.
  const meetingAreaWithRouting = (input, planData, deps) =>
    meetingArea(
      onemap?.routingEnabled && input.method === 'station' && !input.maxCandidates
        ? { ...input, maxCandidates: MEETING_CANDIDATES_WITH_ROUTING }
        : input,
      planData,
      deps,
    )

  router.post('/meeting-area', ...guard, handle(schemas.meetingArea, meetingAreaWithRouting, { usesTravel: true }))
  router.post('/converge', ...guard, handle(schemas.converge, converge, { usesWeather: true, usesTravel: true }))
  router.post('/roam', ...guard, handle(schemas.roam, roam, { usesWeather: true, usesTravel: true }))
  router.post('/search', ...guard, handle(schemas.search, (input, planData) => ({ results: searchVenues(input, planData) })))

  // GET /api/places/search?q=520201 -> { results: [{ name, address, postal, lat, lng }] }, at most 10.
  // For start and end points. Answers 503 when OneMap cannot be reached or this server has no OneMap service.
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
        res.status(503).json({ error: 'search_unavailable', message: 'Address search is not available right now. Try again soon.' })
      } else {
        next(err)
      }
    }
  })

  // GET /api/places/photo?name=places/<id>/photos/<id>&maxWidth=400 -> a redirect to the image.
  // A Google venue carries `photo.name`; the browser asks here, the server asks Google with the key, and the
  // browser is sent to the short-lived image link Google returns. Show `photo.credit` with the image.
  router.get('/places/photo', ...guard, async (req, res, next) => {
    try {
      const name = String(req.query.name ?? '')
      const maxWidth = Math.min(Math.max(Number(req.query.maxWidth) || 400, 100), 1600)
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
      res.redirect(302, url)
    } catch (err) {
      if (err instanceof ExternalApiError) {
        res.status(503).json({ error: 'photos_unavailable', message: 'Place photos are not available right now.' })
      } else {
        next(err)
      }
    }
  })

  return router
}
