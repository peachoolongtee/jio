import express from 'express'
import cors from 'cors'
import { loadPlanData } from './db/venues.js'
import { createMeRouter } from './routes/me.js'
import { rateLimit } from './middleware/rate-limit.js'
import { createPlanRouter } from './routes/plan.js'
import { createHttp } from './services/http.js'
import { createOneMap } from './services/onemap.js'
import { scenarioMiddleware } from './services/scenario.js'
import { createWeather } from './services/weather.js'

// Builds the Express app without listening, so tests can start it on a free port.
//
// How to call:
//   const app = createApp({ frontendOrigin: 'http://localhost:5173' })
//
// With stubbed external APIs, for tests:
//   const app = createApp({ frontendOrigin, stub: true })
//
// Options:
//   frontendOrigin - The one origin CORS allows. Required, and never "*".
//   stub           - true answers external API calls from fixtures.
//   http           - The HTTP helper to share. Defaults to one built from `stub`.
//   planData       - Venues and settings the planner reads. Defaults to loadPlanData() (mock + curated + CDC).
//   weather        - The weather service, from createWeather(). Defaults to one built on `http`.
//   onemap         - OneMap search and public transport routing, from createOneMap(). Defaults to the stub
//                    routes in stub mode and to none otherwise, so a test app never calls OneMap. index.js
//                    passes the real one.
//   allowSimulatedWeather - true lets a planner request send `weatherCase` to fake the forecast. Stub mode
//                    always allows it. Otherwise the field is ignored and the answer says so. index.js sets
//                    it from ALLOW_SIMULATED_WEATHER=1.
//   planRateLimit  - { windowMs, max } to limit how often one caller may use the planner routes, or leave
//                    it out for no limit. index.js sets it outside stub mode.
//   supabase       - The server's Supabase clients, from createSupabase(). Without it the routes that
//                    need a login (GET /api/me) are not mounted.
//   mount          - A function that adds extra routes. They must go in before the "not found" handler,
//                    so routes added to the returned app afterwards are never reached. Tests use this:
//                      createApp({ frontendOrigin, mount: (app) => app.get('/probe', handler) })
export function createApp({
  frontendOrigin,
  stub = false,
  http = createHttp({ stub }),
  planData = loadPlanData(),
  weather = createWeather({ http }),
  onemap = stub ? createOneMap({ http, stub: true }) : null,
  allowSimulatedWeather = false,
  planRateLimit = null,
  supabase = null,
  mount = () => {},
}) {
  if (!frontendOrigin || frontendOrigin === '*') {
    throw new Error('createApp needs one explicit frontend origin; "*" is not allowed.')
  }

  const app = express()
  app.disable('x-powered-by')

  // The one shared HTTP helper. Every external API call goes through it.
  //
  // How to use it in a route handler:
  //   const http = req.app.locals.http
  //   const forecast = await http.getJson(url)
  app.locals.http = http

  // CORS allows exactly the frontend origin, never "*".
  app.use(cors({ origin: frontendOrigin }))
  app.use(express.json())

  // Stub mode only: read the x-jio-scenario header so a test can pick rain, dry
  // or routing-fail. It sits after the body parser on purpose.
  if (stub) app.use(scenarioMiddleware)

  // Uptime ping. The Render keep-alive cron hits this.
  app.get('/healthz', (req, res) => {
    res.status(200).json({ ok: true })
  })

  // Planner: /api/meeting-area, /api/converge, /api/roam, /api/search, /api/places/search.
  app.use(
    '/api',
    createPlanRouter({
      data: planData,
      weather,
      onemap,
      allowSimulatedWeather: allowSimulatedWeather || stub,
      limiter: planRateLimit ? rateLimit(planRateLimit) : null,
    }),
  )

  // Routes that need a login. The planner routes above do not check one yet: the frontend has to
  // start sending the session token first.
  if (supabase) app.use('/api', createMeRouter({ supabase }))

  mount(app)

  // An address that matches no route. Answered as JSON, like every other error.
  app.use((req, res) => {
    res.status(404).json({ error: 'not_found', message: `There is no ${req.method} ${req.path} here.` })
  })

  // Errors always come back as JSON, never as an HTML page.
  // A body that is not valid JSON (400) or is too big (413) is the caller's mistake, and so is any other 4xx
  // the body parser raises (for example 415 for an encoding it cannot read). Those are http-errors objects with a
  // string `type`. Any other error is logged and answers 500, even when it carries a 4xx `status`: an
  // ExternalApiError holds the upstream service's status, which is not the caller's mistake.
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON.' })
      return
    }
    if (err.type === 'entity.too.large') {
      res.status(413).json({ error: 'too_large', message: 'The request body is too big. The limit is 100 kB.' })
      return
    }
    const status = err.status ?? err.statusCode
    if (typeof err.type === 'string' && Number.isInteger(status) && status >= 400 && status <= 499) {
      res.status(status).json({ error: 'bad_request', message: 'The request could not be read.' })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' })
  })

  return app
}
