import 'dotenv/config'
import { createApp } from './app.js'
import { createSupabase } from './db/supabase.js'
import { DEFAULT_CALLS_PER_MINUTE } from './services/budget.js'
import { assertStubAllowed, createHttp } from './services/http.js'
import { createGooglePlaces, readGoogleSettings } from './services/google-places.js'
import { createItineraryAi, readItinerarySettings } from './services/itinerary-ai.js'
import { createLinkReader, readLinkReaderSettings } from './services/link-reader.js'
import { createBrowserReader } from './services/link-browser.js'
import { createYtDlp } from './services/link-tools.js'
import { createOneMap, readOneMapSettings } from './services/onemap.js'

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

// Reading places out of a pasted link (YouTube, TikTok, Instagram, Xiaohongshu) with Gemini. Needs GEMINI_API_KEY. A YouTube
// post's description, date and comments need YOUTUBE_API_KEY (the YouTube Data API v3). Downloading TikTok and Instagram
// videos (LINK_READER_YTDLP=1) and opening their pages in Chrome for slides, Instagram and Xiaohongshu (LINK_READER_BROWSER=1) are
// OFF unless set, because they go against those sites' terms: for a laptop, never the deployed server.
//
// How to turn it on:
//   GEMINI_API_KEY=... and optionally YOUTUBE_API_KEY=... in backend/.env
// How to change the budget:
//   LINK_READER_CALLS_PER_MINUTE=10
const linkSettings = readLinkReaderSettings(process.env)
for (const warning of linkSettings.warnings) console.warn(warning)
const linkReader = createLinkReader({
  http,
  places,
  geminiKey: linkSettings.geminiKey,
  geminiModel: linkSettings.geminiModel,
  youtubeKey: linkSettings.youtubeKey,
  tools: linkSettings.ytdlp && !isProduction ? createYtDlp() : null,
  browser: linkSettings.browser && !isProduction ? createBrowserReader() : null,
  callsPerMinute: linkSettings.callsPerMinute,
})

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

createApp({ frontendOrigin, stub, http, onemap, places, itineraryAi, linkReader, supabase, allowSimulatedWeather, planRateLimit }).listen(port, () => {
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
          ? `OneMap routing is ON: logged in, at most ${oneMapCallsPerMinute ?? DEFAULT_CALLS_PER_MINUTE} OneMap calls a minute.`
          : 'OneMap routing is OFF for now: the login failed, so travel times are estimates. Check ONEMAP_EMAIL and ONEMAP_PASSWORD; the server tries again in a minute.',
      )
    })
  }
  if (!stub && !places.enabled) console.log('Google Places is OFF: no Google restaurants or cafés. Set GOOGLE_MAPS_API_KEY in backend/.env.')
  else if (!stub) console.log(`Google Places is ON: at most ${googleSettings.callsPerMinute} Google calls a minute.`)
  if (!stub) {
    console.log(
      itineraryAi.enabled
        ? `Itinerary AI is ON: ${itineraryAi.provider === 'gemini' ? 'Gemini' : 'Claude'} suggests the order of each plan when it is confirmed, at most ${itinerarySettings.callsPerMinute} AI calls a minute.`
        : 'Itinerary AI is OFF: plans get the order the rules score best (travel and waiting). Set GEMINI_API_KEY in backend/.env.',
    )
  }
  if (!stub) {
    const caps = linkReader.capabilities()
    console.log(
      linkReader.enabled
        ? `Link reader is ON: YouTube ${caps.youtube.comments ? 'with comments' : 'without comments (no YOUTUBE_API_KEY)'}, TikTok ${caps.tiktok.slides ? 'with slides and video (Chrome)' : caps.tiktok.video ? 'with video (yt-dlp)' : 'by caption only'}, at most ${linkSettings.callsPerMinute} reads a minute.`
        : 'Link reader is OFF: pasted links cannot be read. Set GEMINI_API_KEY in backend/.env.',
    )
    if ((linkSettings.ytdlp || linkSettings.browser) && isProduction) console.warn('LINK_READER_YTDLP and LINK_READER_BROWSER are ignored in production: they are for development machines only.')
  }
  if (allowSimulatedWeather) console.log('Simulated weather is ON: planner requests may send weatherCase to fake the forecast.')
  if (!supabase) {
    console.log('Supabase is NOT configured: routes that need a login are off. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in backend/.env.')
  }
})
