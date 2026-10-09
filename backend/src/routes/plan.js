import { Router } from 'express'
import { ZodError } from 'zod'
import { converge, meetingArea, roam, searchVenues } from '../planner/engine.js'
import { ExternalApiError } from '../services/http.js'
import { runWithRealTravel } from '../services/travel-times.js'
import { coversTime, nearestForecastArea } from '../services/weather.js'
import { makePlanSchemas } from './plan-schemas.js'

// The planner endpoints the frontend calls. Full request and response shapes: backend/docs/planner-api.md.
//
//   POST /api/meeting-area  where the group should meet (a named MRT station or neighbourhood)
//   POST /api/converge      rank venues for the group around a point (one call per itinerary slot)
//   POST /api/roam          rank venues near one person's current point ("What next?")
//   POST /api/search        find a venue by name to add as an option, and say whether it fits the slot
//   GET  /api/places/search find an address, postal code or building with OneMap, for start and end points
//
// How to mount it (app.js does this):
//   app.use('/api', createPlanRouter({ data: loadPlanData(), weather, onemap, stub }))
//
// Live data, when the services are given:
//   weather - NEA 2-hour forecast (services/weather.js). Used when the slot falls inside the forecast's period.
//   onemap  - OneMap search and public transport routes (services/onemap.js). Routes are used when an account is set.
// Without them the planner uses its own estimates, and every answer says which source it used.

// Singapore local time now, as the planner writes it: "2026-10-10T19:00".
const nowInSingapore = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16)

// With routing on, the "best MRT station" check tries only the 16 areas nearest the fairest point, not all 37:
// 16 never missed the best area in 2,000 random groups (see docs/engine-integration.md), and it cuts the calls.
const MEETING_CANDIDATES_WITH_ROUTING = 16

export function createPlanRouter({ data, weather = null, onemap = null, stub = false }) {
  const schemas = makePlanSchemas(data)
  const router = Router()

  // The planner data with every venue moved to its nearest NEA forecast area, and the live forecast added as the
  // weather case 'live'. Built once per forecast (the weather service caches each forecast for 5 minutes).
  const liveViews = new WeakMap()
  function liveData(forecast) {
    if (!liveViews.has(forecast)) {
      const live = Object.fromEntries(forecast.areas.map((a) => [a.name, { rainRisk: a.rainRisk, forecast: a.forecast }]))
      liveViews.set(forecast, {
        ...data,
        venues: data.venues.map((v) => ({ ...v, forecastArea: nearestForecastArea(v, forecast.areas).name })),
        weatherCases: { ...data.weatherCases, live },
      })
    }
    return liveViews.get(forecast)
  }

  // Which weather a request plans with:
  //   - weatherCase in the body: the demo switch. That mock case, as before.
  //   - otherwise the live NEA forecast, when the slot's time falls inside the forecast's 2-hour period.
  //     In stub mode the fixture forecast stands for any time, so Playwright's rain scenario always shows rain.
  //   - otherwise 'clear', and the answer says why there is no live forecast.
  async function weatherFor(input) {
    if (input.weatherCase) return { view: data, weatherCase: input.weatherCase, weather: { source: 'demo', case: input.weatherCase } }
    if (!weather) return { view: data, weatherCase: 'clear', weather: { source: 'none', reason: 'live_weather_off' } }
    let forecast
    try {
      forecast = await weather.twoHourForecast()
    } catch (err) {
      if (!(err instanceof ExternalApiError)) throw err
      return { view: data, weatherCase: 'clear', weather: { source: 'none', reason: 'forecast_unavailable' } }
    }
    const period = { validFrom: forecast.validFrom, validTo: forecast.validTo, validText: forecast.validText }
    if (!stub && !coversTime(forecast, input.dateTime)) {
      return { view: data, weatherCase: 'clear', weather: { source: 'none', reason: 'outside_forecast_period', ...period } }
    }
    return {
      view: liveData(forecast),
      weatherCase: 'live',
      weather: { source: 'nea', ...period, updatedAt: forecast.updatedAt, unknownTexts: forecast.unknownTexts },
    }
  }

  // Wraps a handler: checks the body, runs it, answers 400 with the field errors on bad input.
  const handle = (schema, run) => async (req, res, next) => {
    try {
      res.json(await run(schema.parse(req.body ?? {})))
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'invalid_input',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      } else {
        next(err)
      }
    }
  }

  // Converge and Roam: live weather, then real travel times, then the engine.
  const rankWith = (engine) => async (input) => {
    const { view, weatherCase, weather: weatherInfo } = await weatherFor(input)
    const { result, travel } = await runWithRealTravel({
      onemap,
      dateTime: input.dateTime,
      run: (deps) => engine({ ...input, weatherCase }, view, deps),
    })
    return { ...result, weather: weatherInfo, travel }
  }

  router.post('/converge', handle(schemas.converge, rankWith(converge)))
  router.post('/roam', handle(schemas.roam, rankWith(roam)))

  router.post(
    '/meeting-area',
    handle(schemas.meetingArea, async (input) => {
      const routing = onemap?.routingEnabled
      const withLimit = routing && input.method === 'station' && !input.maxCandidates
        ? { ...input, maxCandidates: MEETING_CANDIDATES_WITH_ROUTING }
        : input
      const { result, travel } = await runWithRealTravel({
        onemap,
        dateTime: input.dateTime ?? nowInSingapore(),
        run: (deps) => meetingArea(withLimit, data, deps),
      })
      return { ...result, travel }
    }),
  )

  router.post('/search', handle(schemas.search, (input) => ({ results: searchVenues(input, data) })))

  // GET /api/places/search?q=178879 -> { results: [{ name, address, postal, lat, lng }] }
  // For start and end points. Answers 503 when OneMap cannot be reached, so the frontend can say so.
  router.get('/places/search', async (req, res, next) => {
    try {
      const { q } = schemas.placeSearch.parse(req.query)
      if (!onemap) {
        res.status(503).json({ error: 'search_unavailable', message: 'Address search is not set up on this server.' })
        return
      }
      res.json({ results: (await onemap.search(q)).slice(0, 10) })
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({ error: 'invalid_input', issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) })
      } else if (err instanceof ExternalApiError) {
        res.status(503).json({ error: 'search_unavailable', message: 'Address search is not available right now. Try again soon.' })
      } else {
        next(err)
      }
    }
  })

  return router
}
