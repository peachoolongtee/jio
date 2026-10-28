import 'dotenv/config'
import { createApp } from './app.js'
import { checkPlanSchema } from './db/sessions.js'
import { createSupabase } from './db/supabase.js'
import { DEFAULT_CALLS_PER_MINUTE } from './services/budget.js'
import { assertStubAllowed, createHttp } from './services/http.js'
import { createGooglePlaces, readGoogleSettings } from './services/google-places.js'
import { createItineraryAi, readItinerarySettings } from './services/itinerary-ai.js'
import { setUpLinkReader } from './services/link-reader.js'
import { createOneMap, readOneMapSettings } from './services/onemap.js'
import { loadAreaTimes } from './db/area-times.js'
import { loadPlanData } from './db/venues.js'
import { areaTimesCoverage } from './planner/area-times.js'
import { MEETING_FINALISTS_MAX } from './services/planner-runs.js'
import { readRoutingDeadline, ROUTING_DEADLINE_MS } from './services/travel-times.js'

const isProduction = process.env.NODE_ENV === 'production'
const port = Number(process.env.PORT) || 3000

// In production the origin must be set explicitly. Locally it falls back to the Vite dev server.
const frontendOrigin = process.env.FRONTEND_ORIGIN || (isProduction ? null : 'http://localhost:5173')
if (!frontendOrigin) {
  console.error('FRONTEND_ORIGIN is not set. Copy backend/.env.example to backend/.env or set it on the host.')
  process.exit(1)
}

// Stub mode answers OneMap, data.gov.sg and LTA calls from fixtures.
//
// How to turn it on, for Playwright or for working offline:
//   STUB_EXTERNALS=1 pnpm dev:backend
const stub = process.env.STUB_EXTERNALS === '1'
try {
  assertStubAllowed({ stub, nodeEnv: process.env.NODE_ENV })
} catch (err) {
  console.error(err.message)
  process.exit(1)
}

const http = createHttp({ stub })

// OneMap. Address search needs no account. Public transport routing needs ONEMAP_EMAIL and ONEMAP_PASSWORD;
// without them the planner keeps its own travel estimate. The example values from .env.example count as not
// set. Setting only one of the two is a mistake in the settings, so the server refuses to start, as it does
// for Supabase.
//
// ONEMAP_CALLS_PER_MINUTE is the budget for every call this server makes to OneMap (routing, search and login
// together). The shared account allows 300 a minute, so the default is 240. Stub mode makes no real calls and
// has a large budget unless this is set.
//
// How to change it:
//   ONEMAP_CALLS_PER_MINUTE=120
const oneMapSettings = readOneMapSettings(process.env)
if (oneMapSettings.error) {
  console.error(oneMapSettings.error)
  process.exit(1)
}
const { callsPerMinute: oneMapCallsPerMinute } = oneMapSettings
const onemap = createOneMap({
  http,
  email: oneMapSettings.email,
  password: oneMapSettings.password,
  stub,
  callsPerMinute: oneMapCallsPerMinute,
})

// How long one request that a person waits on (every planner route, and the session server's planner runs) waits for OneMap
// routes in total. Trips not answered by then use the planner's estimate and are flagged `approximate`. Blank means 3000 ms; a
// value outside 1000 to 15000, or not a whole number, makes the server refuse to start. A slower OneMap answer that arrives
// after the deadline changes nothing.
//
// How to change it:
//   ROUTING_DEADLINE_MS=5000
const routingDeadline = readRoutingDeadline(process.env)
if (routingDeadline.error) {
  console.error(routingDeadline.error)
  process.exit(1)
}
const routingDeadlineMs = routingDeadline.deadlineMs

// Google Places: restaurants, cafés and bars with ratings and hours. Needs GOOGLE_MAPS_API_KEY; without it, off.
// The key is trimmed; a blank or malformed one counts as not set (the warning names the variable, never its value).
//
// GOOGLE_CALLS_PER_MINUTE is the budget for every Google call this server makes, nearby searches and photos together.
// Default 60. Stub mode makes no real calls and has a large budget.
//
// How to change it:
//   GOOGLE_CALLS_PER_MINUTE=30
const googleSettings = readGoogleSettings(process.env)
for (const warning of googleSettings.warnings) console.warn(warning)
const places = createGooglePlaces({
  http,
  apiKey: googleSettings.apiKey,
  callsPerMinute: stub ? undefined : googleSettings.callsPerMinute,
  stub,
})

// The AI order of an itinerary (suggested when the group confirms a plan). Gemini when GEMINI_API_KEY is set (free
// tier), else Claude when ANTHROPIC_API_KEY is set. With neither, the plan still gets an order: the one the rules score
// best (travel, plus half the waiting). Stub mode never calls an AI. GEMINI_MODEL and ANTHROPIC_MODEL change the models.
// A key is trimmed; a blank or malformed one counts as not set (the warning names the variable, never its value).
//
// ITINERARY_AI_CALLS_PER_MINUTE is the budget for every AI call this server makes. Default 20, at most 2 at once. Three
// failures in a row pause the AI for a minute, an answer is kept for 10 minutes, and a call takes at most 8 seconds.
//
// How to turn it on:
//   GEMINI_API_KEY=... in backend/.env
// How to change the budget:
//   ITINERARY_AI_CALLS_PER_MINUTE=10
const itinerarySettings = readItinerarySettings(process.env)
for (const warning of itinerarySettings.warnings) console.warn(warning)
const itineraryAi = createItineraryAi({
  http,
  geminiKey: itinerarySettings.geminiKey,
  geminiModel: itinerarySettings.geminiModel,
  apiKey: itinerarySettings.anthropicKey,
  anthropicModel: itinerarySettings.anthropicModel,
  callsPerMinute: itinerarySettings.callsPerMinute,
  stub,
})

// Reading places out of a pasted link (YouTube, TikTok, Instagram, Xiaohongshu) with Gemini. OFF unless LINK_READER=1: without
// it nothing is built, nothing is scheduled, and the three /api/links routes do not exist (they answer 404 like any unknown
// address). With it, GEMINI_API_KEY is needed too, or read and refresh answer 503. A YouTube post's description, date and
// comments need YOUTUBE_API_KEY (the YouTube Data API v3), and comments also need LINK_READER_COMMENTS=1, which waits for
// the team lead's decision. Downloading TikTok and Instagram videos (LINK_READER_YTDLP=1) and opening their pages in Chrome
// for slides, Instagram and Xiaohongshu (LINK_READER_BROWSER=1) go against those sites' terms, so they run only with
// NODE_ENV=development as well: for a laptop, never the deployed server.
//
// LINK_READER_CALLS_PER_MINUTE is the budget for every AI call the reader makes (default 6, one token per model call).
// LINK_READER_PER_CALLER_PER_MINUTE is how many reads, and separately how many refreshes, one caller may make a minute (3).
//
// How to turn it on:
//   LINK_READER=1 and GEMINI_API_KEY=... and optionally YOUTUBE_API_KEY=... in backend/.env
// How to change the budget:
//   LINK_READER_CALLS_PER_MINUTE=10
const link = setUpLinkReader({ env: process.env, http, places, stub })
for (const warning of link.warnings) console.warn(warning)
const linkReader = link.reader
const linkSettings = link.settings
const linkRateLimit = stub ? null : { windowMs: 60_000, read: linkSettings.perCaller, refresh: linkSettings.perCaller }

// The simulated forecast: lets a planner request send `weatherCase` to pretend it is raining. Off unless
// switched on, because the planner uses the live data.gov.sg forecast otherwise. Stub mode always allows it.
//
// How to turn it on, for a demo on the deployed app:
//   ALLOW_SIMULATED_WEATHER=1
const allowSimulatedWeather = process.env.ALLOW_SIMULATED_WEATHER === '1'

// How many planner requests one caller may make each minute. A caller is a signed-in user once the planner
// routes check logins, and an address until then. 300 is loose on purpose: one round of voting in the app
// sends about 130 requests today. Lower it once the frontend sends fewer and real routing is switched on.
// Stub mode has no limit, so the browser tests can run flat out.
//
// How to change it:
//   PLANNER_RATE_LIMIT_PER_MINUTE=60
const plannerLimitPerMinute = Number(process.env.PLANNER_RATE_LIMIT_PER_MINUTE || 300)
if (!Number.isInteger(plannerLimitPerMinute) || plannerLimitPerMinute <= 0) {
  console.error('PLANNER_RATE_LIMIT_PER_MINUTE must be a whole number above 0.')
  process.exit(1)
}
const planRateLimit = stub ? null : { windowMs: 60_000, max: plannerLimitPerMinute }

// How many times one signed-in person may use the session endpoints each minute (/api/sessions/:id/...: work out the meeting
// spots after a start changes, suggest a spot, confirm, opt out, leave). One change of start makes one call, and few people
// make more than a handful a minute, so 60 is loose. Stub mode has no limit.
//
// How to change it:
//   SESSION_RATE_LIMIT_PER_MINUTE=10
const sessionLimitPerMinute = Number(process.env.SESSION_RATE_LIMIT_PER_MINUTE || 60)
if (!Number.isInteger(sessionLimitPerMinute) || sessionLimitPerMinute <= 0) {
  console.error('SESSION_RATE_LIMIT_PER_MINUTE must be a whole number above 0.')
  process.exit(1)
}
const sessionRateLimit = stub ? null : { windowMs: 60_000, max: sessionLimitPerMinute }

// How many times one signed-in person may search the saved places for a slot (GET /api/sessions/:id/slots/:slotId/venue-search, as they
// type) and fetch the places behind the cards of a voting session (GET /api/venues, when a card is shown for the first time). Each
// counts apart, and apart from the session endpoints above, so showing cards never uses up the allowance of the writes. Stub mode has
// no limit.
//
// How to change it:
//   VENUE_RATE_LIMIT_PER_MINUTE=60
const venueLimitPerMinute = Number(process.env.VENUE_RATE_LIMIT_PER_MINUTE || 120)
if (!Number.isInteger(venueLimitPerMinute) || venueLimitPerMinute <= 0) {
  console.error('VENUE_RATE_LIMIT_PER_MINUTE must be a whole number above 0.')
  process.exit(1)
}
const venueRateLimit = stub ? null : { windowMs: 60_000, max: venueLimitPerMinute }

// How many times one signed-in person may search for someone to invite each minute (GET /api/people/search). The invite
// field asks after a short pause as the person types, so this is loose enough for a fast typist. Stub mode has no limit.
//
// How to change it:
//   PEOPLE_SEARCH_RATE_LIMIT_PER_MINUTE=60
const peopleSearchLimitPerMinute = Number(process.env.PEOPLE_SEARCH_RATE_LIMIT_PER_MINUTE || 120)
if (!Number.isInteger(peopleSearchLimitPerMinute) || peopleSearchLimitPerMinute <= 0) {
  console.error('PEOPLE_SEARCH_RATE_LIMIT_PER_MINUTE must be a whole number above 0.')
  process.exit(1)
}
const peopleSearchRateLimit = stub ? null : { windowMs: 60_000, max: peopleSearchLimitPerMinute }

// Supabase: token checks and database access. All three values are needed. With none of them the server
// still runs outside production, but the routes that need a login are switched off. With only some of them
// it refuses to start, because that is a mistake in the settings, not a choice.
//
// SUPABASE_ALLOW_LEGACY_TOKENS=1 lets tokens signed with the old shared secret (HS256) be checked by
// asking Supabase. Set it only if the project still issues them.
const SUPABASE_SETTINGS = ['SUPABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY']
const missingSettings = SUPABASE_SETTINGS.filter((name) => !process.env[name])
if (missingSettings.length > 0 && missingSettings.length < SUPABASE_SETTINGS.length) {
  console.error(`Supabase is only partly configured. Missing: ${missingSettings.join(', ')}. Set all three or none.`)
  process.exit(1)
}
if (missingSettings.length === SUPABASE_SETTINGS.length && isProduction) {
  console.error(`Supabase is not configured. Set ${SUPABASE_SETTINGS.join(', ')} on the host.`)
  process.exit(1)
}
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env
const supabase =
  missingSettings.length === 0
    ? createSupabase({
        url: SUPABASE_URL,
        anonKey: SUPABASE_ANON_KEY,
        serviceKey: SUPABASE_SERVICE_ROLE_KEY,
        allowLegacyTokens: process.env.SUPABASE_ALLOW_LEGACY_TOKENS === '1',
      })
    : null

// Real minutes between the meeting areas, taken from OneMap once (pnpm build:area-times). With it the planner ranks areas by a guess
// that knows the MRT, not the straight line. Left out in stub mode, so the fixtures and the tests answer as they always did.
const areaTimes = stub ? null : loadAreaTimes()

// How many areas a meeting-area request routes with real OneMap times. Blank means 5. More is more accurate and uses more of
// the shared OneMap budget: 8 is a good next step. At most 12; anything else is ignored with a warning.
//
// How to change it:
//   MEETING_FINALISTS=8
const finalistsText = (process.env.MEETING_FINALISTS ?? '').trim()
const finalistsNumber = Number(finalistsText)
const meetingFinalists = Number.isInteger(finalistsNumber) && finalistsNumber >= 1 && finalistsNumber <= MEETING_FINALISTS_MAX ? finalistsNumber : undefined
if (finalistsText !== '' && meetingFinalists === undefined) console.warn(`MEETING_FINALISTS must be a whole number from 1 to ${MEETING_FINALISTS_MAX}, so the default is used.`)

// The sessions need what the stage 5 migration adds (db/migrations/20261023000000_jio_apply_session_plan_stops.sql). A database without it fails here, at
// once and by name, not on the first request of every session. A database that cannot be reached is only a warning.
if (supabase) {
  try {
    await checkPlanSchema(supabase.service)
  } catch (err) {
    if (!err.unreachable) {
      console.error(err.message)
      process.exit(1)
    }
    console.warn(err.message)
  }
}

createApp({ frontendOrigin, stub, http, onemap, places, itineraryAi, linkReader, linkRateLimit, supabase, allowSimulatedWeather, planRateLimit, sessionRateLimit, venueRateLimit, peopleSearchRateLimit, areaTimes, meetingFinalists, routingDeadlineMs }).listen(port, () => {
  console.log(`Jio backend listening on port ${port}, allowing ${frontendOrigin}`)
  if (stub) console.log('Stub mode is ON: external API calls are answered from fixtures.')
  else if (!onemap.routingEnabled) {
    console.log('OneMap routing is OFF: travel times are estimates. Set ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env.')
  } else {
    // Try one login in the background, so a wrong account shows up now rather than on the first request. It does
    // not delay start-up, and the server keeps running when OneMap is down: routing then uses the estimate.
    onemap.warmUp().then((ok) => {
      console.log(
        ok
          ? `OneMap routing is ON: logged in, at most ${oneMapCallsPerMinute ?? DEFAULT_CALLS_PER_MINUTE} OneMap calls a minute, and a request waits at most ${routingDeadlineMs ?? ROUTING_DEADLINE_MS} ms for routes.`
          : 'OneMap routing is OFF for now: the login failed, so travel times are estimates. Check ONEMAP_EMAIL and ONEMAP_PASSWORD; the server tries again in a minute.',
      )
    })
  }
  if (!stub && areaTimes) {
    const { found, expected } = areaTimesCoverage(loadPlanData().areas, areaTimes)
    console.log(`Area travel times are ON: ${found} of ${expected} real times between the meeting areas rank them before routing.`)
    if (found < expected) console.warn(`The area travel times cover only ${found} of ${expected} pairs (the areas changed since it was built): the rest use straight-line distance. Rebuild with pnpm build:area-times.`)
  } else if (!stub) console.log('Area travel times are OFF: areas are ranked by straight-line distance. Build the table with pnpm build:area-times.')
  if (!stub && !places.enabled) console.log('Google Places is OFF: no Google restaurants or cafés. Set GOOGLE_MAPS_API_KEY in backend/.env.')
  else if (!stub) console.log(`Google Places is ON: at most ${googleSettings.callsPerMinute} Google calls a minute.`)
  if (!stub) {
    console.log(
      itineraryAi.enabled
        ? `Itinerary AI is ON: ${itineraryAi.provider === 'gemini' ? 'Gemini' : 'Claude'} suggests the order of each plan when it is confirmed, at most ${itinerarySettings.callsPerMinute} AI calls a minute.`
        : 'Itinerary AI is OFF: plans get the order the rules score best (travel and waiting). Set GEMINI_API_KEY in backend/.env.',
    )
  }
  if (!linkReader) {
    console.log('Link reader is OFF (the default): pasted links cannot be read and /api/links does not exist. Set LINK_READER=1 and GEMINI_API_KEY in backend/.env to turn it on.')
  } else if (!linkReader.enabled) {
    console.log('Link reader is ON but has no GEMINI_API_KEY, so reading and refreshing answer 503. Set GEMINI_API_KEY in backend/.env.')
  } else if (!stub) {
    const caps = linkReader.capabilities()
    console.log(
      `Link reader is ON: YouTube ${caps.youtube.comments ? 'with comments' : caps.youtube.description ? 'with description, without comments' : 'without description (no YOUTUBE_API_KEY)'}, TikTok ${caps.tiktok.slides ? 'with slides and video (Chrome)' : caps.tiktok.video ? 'with video (yt-dlp)' : 'by caption only'}, at most ${linkSettings.callsPerMinute} AI calls a minute and ${linkSettings.perCaller} reads a minute for one caller.`,
    )
  } else {
    console.log('Link reader is ON in stub mode: it answers from fixtures.')
  }
  if (allowSimulatedWeather) console.log('Simulated weather is ON: planner requests may send weatherCase to fake the forecast.')
  if (!supabase) {
    console.log('Supabase is NOT configured: routes that need a login are off. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in backend/.env.')
  }
})
