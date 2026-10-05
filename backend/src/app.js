import express from 'express'
import cors from 'cors'
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
export function createApp({ frontendOrigin, stub = false, http = createHttp({ stub }) }) {
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

  return app
}
