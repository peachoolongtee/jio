import { Router } from 'express'
import { ZodError } from 'zod'
import { summariseBlocks } from '../planner/weather-window.js'
import { makePlanSchemas } from './plan-schemas.js'

// The weather at the stops of a plan. Full request and response: backend/docs/planner-api.md, "POST /api/weather/stops".
//
//   POST /api/weather/stops   for each stop (at most 8): the forecast it is judged by, and what it says there
//
// It does not rank anything and suggests no swap. The itinerary asks when it opens, and every 30 minutes on the day.
//
// How to mount it (app.js does this):
//   app.use('/api', createWeatherRouter({ data: loadPlanData(), resolver, allowSimulatedWeather: false, limiter }))
//
// `resolver` is the shared one from planner/weather-window.js. `limiter` is the same middleware as the planner
// routes use (one shared instance, so a caller's requests count together). A simulated `weatherCase` is allowed
// under the same rule as the planner routes: when `allowSimulatedWeather` is true. Otherwise it is ignored, never
// refused, and the answer carries `weather.simulationIgnored: true`.
export function createWeatherRouter({ data, resolver, allowSimulatedWeather = false, limiter = null }) {
  const schemas = makePlanSchemas(data)
  const router = Router()
  const guard = limiter ? [limiter] : []

  // The weather at each stop. A forecast kind is fetched at most once for the whole request, through the cache.
  //
  // How to call:
  //   POST /api/weather/stops { "stops": [{ "id": "s1", "point": { "lat": 1.3, "lng": 103.8 }, "start": "2026-10-12T19:00" }] }
  router.post('/weather/stops', ...guard, async (req, res, next) => {
    try {
      const input = schemas.weatherStops.parse(req.body ?? {})
      // A simulated forecast the server does not allow is dropped, and the answer says so.
      const simulationIgnored = input.weatherCase !== undefined && !allowSimulatedWeather
      const weatherCase = simulationIgnored ? undefined : input.weatherCase
      const forecasts = await Promise.all(input.stops.map((s) => resolver.forecastFor({ start: s.start, weatherCase })))
      const stops = input.stops.map((s, i) => ({
        id: s.id,
        ...resolver.stopWeather(forecasts[i], { point: s.point, setting: s.setting, exposure: s.exposure }),
      }))
      res.json({ stops, weather: { ...summariseBlocks(forecasts, stops), ...(simulationIgnored && { simulationIgnored: true }) } })
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json({
          error: 'invalid_input',
          message: 'Some fields in the request are missing or not valid. See issues.',
          issues: err.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        })
      } else {
        next(err)
      }
    }
  })

  return router
}
