import { Router } from 'express'
import { ZodError } from 'zod'
import { converge, meetingArea, roam, searchVenues } from '../planner/engine.js'
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
//   app.use('/api', createPlanRouter({ data: loadPlanData() }))
//
// Travel times are still the engine's fake estimate. When services/onemap.js exists, build a travelMinutes
// lookup here (fetch the shortlist's routes first, since OneMap is async) and pass it as deps.

export function createPlanRouter({ data }) {
  const schemas = makePlanSchemas(data)
  const router = Router()

  // Stub mode only (Playwright): the x-jio-scenario header picks the weather and whether routing fails.
  // Outside stub mode currentScenario() is always 'dry', so nothing changes.
  const weatherFor = (body) => body.weatherCase ?? (currentScenario() === 'rain' ? 'rain' : 'clear')
  const depsFor = () => (currentScenario() === 'routing-fail' ? { travelMinutes: () => null } : {})

  // Wraps a handler: checks the body, runs the engine, answers 400 with the field errors on bad input.
  const handle = (schema, run) => (req, res, next) => {
    try {
      const input = schema.parse(req.body ?? {})
      res.json(run({ ...input, weatherCase: weatherFor(input) }, depsFor()))
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

  router.post('/meeting-area', handle(schemas.meetingArea, (input, deps) => meetingArea(input, data, deps)))
  router.post('/converge', handle(schemas.converge, (input, deps) => converge(input, data, deps)))
  router.post('/roam', handle(schemas.roam, (input, deps) => roam(input, data, deps)))
  router.post('/search', handle(schemas.search, (input) => ({ results: searchVenues(input, data) })))

  return router
}
