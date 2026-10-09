import { Router } from 'express'
import { ZodError } from 'zod'
import { converge, meetingArea, roam, searchVenues } from '../planner/engine.js'
import { LIVE_WEATHER_CASE, withLiveWeather } from '../planner/live-weather.js'
import { ExternalApiError } from '../services/errors.js'
import { currentScenario } from '../services/scenario.js'
import { makePlanSchemas } from './plan-schemas.js'

// The planner endpoints the frontend calls. Full request and response shapes: backend/docs/planner-api.md.
//
//   POST /api/meeting-area  where the group should meet (a named MRT station or neighbourhood)
//   POST /api/converge      rank venues for the group around a point (one call per itinerary slot)
//   POST /api/roam          rank venues near one person's current point ("What next?")
//   POST /api/search        find a venue by name to add as an option, and say whether it fits the slot
//
// How to mount it (app.js does this):
//   app.use('/api', createPlanRouter({ data: loadPlanData(), weather, allowSimulatedWeather: false }))
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
// Travel times are still the engine's fake estimate. When services/onemap.js exists, build a travelMinutes
// lookup here (fetch the shortlist's routes first, since OneMap is async) and pass it as deps.

export function createPlanRouter({ data, weather, allowSimulatedWeather = false, limiter = null }) {
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
      }
    } catch (err) {
      // Only an API failure falls back. A bug must still reach the error handler.
      if (!(err instanceof ExternalApiError)) throw err
      console.warn(`Weather unavailable, planning as if clear: ${err.message}`)
      return { source: 'unavailable', weatherCase: 'clear', planData: data }
    }
  }

  // Answers 400 in the shape every planner error uses.
  //
  // How to call:
  //   invalid(res, [{ path: 'weatherCase', message: 'switched off' }])
  const invalid = (res, issues) => res.status(400).json({ error: 'invalid_input', issues })

  // Wraps a handler: checks the body, runs the engine, answers 400 with the field errors on bad input.
  // With `usesWeather` it also resolves the weather first and adds `weather` to the answer.
  //
  // How to call:
  //   router.post('/converge', handle(schemas.converge, converge, { usesWeather: true }))
  const handle = (schema, run, { usesWeather = false } = {}) => async (req, res, next) => {
    try {
      const input = schema.parse(req.body ?? {})
      if (!usesWeather) {
        res.json(await run(input, data, depsFor()))
        return
      }
      // A simulated forecast the server does not allow is dropped, and the answer says so.
      const simulationIgnored = input.weatherCase !== undefined && !allowSimulatedWeather
      const { source, validUntil, weatherCase, planData } = await resolveWeather(
        simulationIgnored ? { ...input, weatherCase: undefined } : input,
      )
      const result = await run({ ...input, weatherCase }, planData, depsFor())
      res.json({
        ...result,
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

  router.post('/meeting-area', ...guard, handle(schemas.meetingArea, meetingArea))
  router.post('/converge', ...guard, handle(schemas.converge, converge, { usesWeather: true }))
  router.post('/roam', ...guard, handle(schemas.roam, roam, { usesWeather: true }))
  router.post('/search', ...guard, handle(schemas.search, (input, planData) => ({ results: searchVenues(input, planData) })))

  return router
}
