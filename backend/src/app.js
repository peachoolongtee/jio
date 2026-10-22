import express from 'express'
import cors from 'cors'
import { loadPlanData } from './db/venues.js'
import { createAccountsRouter } from './routes/accounts.js'
import { createMeRouter } from './routes/me.js'
import { rateLimit } from './middleware/rate-limit.js'
import { createLinksRouter } from './routes/links.js'
import { createPeopleRouter } from './routes/people.js'
import { createPlanRouter } from './routes/plan.js'
import { createSessionsRouter } from './routes/sessions.js'
import { createVenuesRouter } from './routes/venues.js'
import { createWeatherRouter } from './routes/weather.js'
import { createWeatherResolver } from './planner/weather-window.js'
import { createHttp } from './services/http.js'
import { createGooglePlaces } from './services/google-places.js'
import { createItineraryAi } from './services/itinerary-ai.js'
import { createOneMap } from './services/onemap.js'
import { createPlannerRuns } from './services/planner-runs.js'
import { createSessions } from './services/sessions.js'
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
//   planData       - Venues and settings the planner reads. Defaults to loadPlanData() (curated + OneMap + CDC;
//                    fictional fixtures are included only with INCLUDE_FICTIONAL_VENUES=1, which the tests set).
//   weather        - The weather service, from createWeather(). Defaults to one built on `http` and `now`.
//   now            - Returns the time in milliseconds, for the weather: which forecast a stop is judged by depends on
//                    how far away it is. Defaults to Date.now. Tests pass a fake clock.
//   onemap         - OneMap search and public transport routing, from createOneMap(). Defaults to the stub
//                    routes in stub mode and to none otherwise, so a test app never calls OneMap. index.js
//                    passes the real one.
//   places         - Google Places, from createGooglePlaces(). Same default as `onemap`.
//   itineraryAi    - An AI (Gemini or Claude) for rearranging itineraries, from createItineraryAi(). Defaults to one with no key, which
//                    chooses by its rules, so a test app never calls an AI. index.js passes the real one.
//   linkReader     - Reads the places out of a pasted post link, from createLinkReader(). Defaults to none: the three /api/links
//                    routes are then not mounted and answer 404 like any unknown address. index.js passes one only when
//                    LINK_READER=1 (setUpLinkReader); a test that needs it passes one built on the stub `http`.
//   linkRateLimit  - { windowMs, read, refresh } to hold one caller to `read` reads and `refresh` refreshes in each window, or
//                    leave it out for no limit. index.js sets it outside stub mode (3 each a minute).
//   allowSimulatedWeather - true lets a planner request send `weatherCase` to fake the forecast. Stub mode
//                    always allows it. Otherwise the field is ignored and the answer says so. index.js sets
//                    it from ALLOW_SIMULATED_WEATHER=1.
//   routingDeadlineMs - The most time one planner request waits for OneMap routes in total. Defaults to 8
//                    seconds. Tests shorten it.
//   ownPlacesEnough - Google is asked about a food, drink, shop or activity category only when fewer than this many
//                    of our own open places are near the meeting point. Defaults to 6 (ticket #149). Tests that
//                    need Google asked pass Infinity.
//   includePlannerDiagnostics - Keep the engine's `diagnostics` counters in planner answers. Defaults to
//                    PLANNER_DIAGNOSTICS=1 (the backend's tests set it in vitest.config.js; NODE_ENV does not change it).
//   roundPlannerMinutes - Round the minutes in planner answers to one decimal place. Defaults to true; it is
//                    independent of the diagnostics switch. A test that needs the engine's raw minutes passes false.
//   meetingFinalists - How many areas a meeting-area request routes with real OneMap times (the best by estimate). Default 5, at
//                    most 12. index.js sets it from MEETING_FINALISTS.
//   areaTimes      - A table of real minutes between the meeting areas (src/db/mock/area-times.json), or null. With it, the meeting area
//                    ranks areas and fills in trips with a guess that knows the MRT. index.js loads it; tests leave it out.
//   planRateLimit  - { windowMs, max } to limit how often one caller may use the planner routes, or leave
//                    it out for no limit. index.js sets it outside stub mode.
//   accountCheckRateLimit - { windowMs, max } for POST /api/accounts/email-check, which tells whether an email has an
//                    account. Strict on purpose, and on by default: 10 a minute for each caller. Pass null for no
//                    limit (only a test should).
//   supabase       - The server's Supabase clients, from createSupabase(). Without it the routes that
//                    need a login (GET /api/me) are not mounted.
//   sessionRateLimit - { windowMs, max } to limit how often one signed-in caller may use the session endpoints (the meeting spots,
//                    opting out, leaving, removing a guest), and, counted apart, read an outing's dietary needs
//                    (GET /api/sessions/:id/dietary), or leave it out for no limit. index.js sets it outside stub mode.
//   peopleSearchRateLimit - { windowMs, max } to limit how often one signed-in caller may search for people to invite
//                    (GET /api/people/search, which a screen calls as the person types), or leave it out for no limit. index.js sets it
//                    outside stub mode.
//   mount          - A function that adds extra routes. They must go in before the "not found" handler,
//                    so routes added to the returned app afterwards are never reached. Tests use this:
//                      createApp({ frontendOrigin, mount: (app) => app.get('/probe', handler) })
export function createApp({
  frontendOrigin,
  stub = false,
  http = createHttp({ stub }),
  planData = loadPlanData(),
  now = Date.now,
  weather = createWeather({ http, now }),
  onemap = stub ? createOneMap({ http, stub: true }) : null,
  places = stub ? createGooglePlaces({ http, stub: true }) : null,
  itineraryAi = createItineraryAi({ stub: true }),
  linkReader = null,
  linkRateLimit = null,
  allowSimulatedWeather = false,
  planRateLimit = null,
  sessionRateLimit = null,
  peopleSearchRateLimit = null,
  accountCheckRateLimit = { windowMs: 60_000, max: 10 },
  routingDeadlineMs = undefined,
  areaTimes = null,
  meetingFinalists = undefined,
  ownPlacesEnough = undefined,
  includePlannerDiagnostics = process.env.PLANNER_DIAGNOSTICS === '1',
  roundPlannerMinutes = true,
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

  // One limiter and one weather resolver, shared by every route that uses them: a caller's requests to the planner
  // and to the weather route count together, and a forecast failure is logged once a minute across both.
  const limiter = planRateLimit ? rateLimit(planRateLimit) : null
  const weatherResolver = createWeatherResolver({ data: planData, weather, now })
  // The planner's engine runs with real travel times, shared by the planner routes and the session endpoints so both spend the
  // same OneMap budget (services/planner-runs.js).
  const runs = createPlannerRuns({ data: planData, weatherResolver, onemap, routingDeadlineMs, areaTimes, meetingFinalists })

  // Planner: /api/meeting-area, /api/converge, /api/roam, /api/search, /api/places/search, /api/itinerary/arrange.
  app.use(
    '/api',
    createPlanRouter({
      data: planData,
      weather,
      weatherResolver,
      onemap,
      places,
      ai: itineraryAi,
      allowSimulatedWeather: allowSimulatedWeather || stub,
      routingDeadlineMs,
      ownPlacesEnough,
      includeDiagnostics: includePlannerDiagnostics,
      roundMinutes: roundPlannerMinutes,
      limiter,
      runs,
    }),
  )

  // The weather at the stops of a plan: /api/weather/stops.
  app.use('/api', createWeatherRouter({ data: planData, resolver: weatherResolver, allowSimulatedWeather: allowSimulatedWeather || stub, limiter }))
  // Reading places out of a pasted link, and refreshing saved places: /api/links/read, /api/links/refresh, /api/links/capabilities.
  // Not mounted at all unless a link reader is given (LINK_READER=1), so without it these are unknown addresses.
  if (linkReader) {
    const perCaller = (max) => (linkRateLimit ? rateLimit({ windowMs: linkRateLimit.windowMs, max }) : null)
    app.use(
      '/api',
      createLinksRouter({
        reader: linkReader,
        limiter: planRateLimit ? rateLimit(planRateLimit) : null,
        readLimit: perCaller(linkRateLimit?.read),
        refreshLimit: perCaller(linkRateLimit?.refresh),
      }),
    )
  }

  // Routes that need a login. The planner routes above do not check one yet: the frontend has to
  // start sending the session token first.
  if (supabase) app.use('/api', createMeRouter({ supabase }))
  // Where a group meets, on the server: the meeting spots, a suggestion, the host's confirm and known place, opting out and
  // rejoining, leaving and removing (/api/sessions/:id/...); and an outing's dietary needs together (GET /api/sessions/:id/dietary).
  // Needs a login, then a limit per person (the needs counted apart).
  if (supabase) {
    const sessions = createSessions({ supabase, data: planData, runs, ...(routingDeadlineMs !== undefined && { routingDeadlineMs }) })
    const sessionLimiter = sessionRateLimit ? rateLimit(sessionRateLimit) : null
    app.use('/api', createSessionsRouter({
      supabase,
      sessions,
      limiter: sessionLimiter,
      readLimiter: sessionRateLimit ? rateLimit(sessionRateLimit) : null,
    }))
    // The saved places behind a voting session's cards: GET /api/venues?ids=. Needs a login, then the same limit per person.
    app.use('/api', createVenuesRouter({ supabase, data: planData, limiter: sessionLimiter }))
  }

  // Finding a person to invite by the start of their username: /api/people/search. Needs a login, then a limit per person.
  if (supabase) app.use('/api', createPeopleRouter({ supabase, limiter: peopleSearchRateLimit ? rateLimit(peopleSearchRateLimit) : null }))

  // The email check for the sign-up screen. Always mounted: without Supabase it answers 503, never a guess.
  app.use(
    '/api',
    createAccountsRouter({ supabase, limiter: accountCheckRateLimit ? rateLimit(accountCheckRateLimit) : null }),
  )

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
