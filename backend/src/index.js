import 'dotenv/config'
import { createApp } from './app.js'
import { createSupabase } from './db/supabase.js'
import { assertStubAllowed, createHttp } from './services/http.js'

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

createApp({ frontendOrigin, stub, http, supabase, allowSimulatedWeather, planRateLimit }).listen(port, () => {
  console.log(`Jio backend listening on port ${port}, allowing ${frontendOrigin}`)
  if (stub) console.log('Stub mode is ON: external API calls are answered from fixtures.')
  if (allowSimulatedWeather) console.log('Simulated weather is ON: planner requests may send weatherCase to fake the forecast.')
  if (!supabase) {
    console.log('Supabase is NOT configured: routes that need a login are off. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in backend/.env.')
  }
})
