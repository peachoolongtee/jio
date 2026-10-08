import express from 'express'
import cors from 'cors'
import { loadPlanData } from './db/venues.js'
import { createPlanRouter } from './routes/plan.js'
import { createHttp } from './services/http.js'
import { scenarioMiddleware } from './services/scenario.js'

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
export function createApp({ frontendOrigin, stub = false, http = createHttp({ stub }), planData = loadPlanData() }) {
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

  // Planner: /api/meeting-area, /api/converge, /api/roam.
  app.use('/api', createPlanRouter({ data: planData }))

  // Errors always come back as JSON, never as an HTML page.
  // A body that is not valid JSON is the caller's mistake (400). Anything else is a bug on our side (500).
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'invalid_json', message: 'The request body is not valid JSON.' })
      return
    }
    console.error(err)
    res.status(500).json({ error: 'server_error', message: 'Something went wrong on the server.' })
  })

  return app
}
