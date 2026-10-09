import 'dotenv/config'
import { createApp } from './app.js'
import { createSupabase } from './db/supabase.js'
import { assertStubAllowed, createHttp } from './services/http.js'
import { createOneMap } from './services/onemap.js'
import { createWeather } from './services/weather.js'

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

// Live data. NEA weather needs no account. OneMap search needs none either; routing needs ONEMAP_EMAIL and
// ONEMAP_PASSWORD, and without them the planner keeps its own travel estimate. The example values in
// .env.example count as not set.
const weather = createWeather({ http, apiKey: process.env.DATAGOV_API_KEY || null })
const onemapEmail = process.env.ONEMAP_EMAIL === 'you@example.com' ? null : process.env.ONEMAP_EMAIL || null
const onemap = createOneMap({ http, email: onemapEmail, password: process.env.ONEMAP_PASSWORD || null, stub })

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

createApp({ frontendOrigin, stub, http, weather, onemap, supabase }).listen(port, () => {
  console.log(`Jio backend listening on port ${port}, allowing ${frontendOrigin}`)
  if (stub) console.log('Stub mode is ON: external API calls are answered from fixtures.')
  else if (!onemap.routingEnabled) {
    console.log('OneMap routing is OFF: travel times are estimates. Set ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env.')
  }
  if (!supabase) {
    console.log('Supabase is NOT configured: routes that need a login are off. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in backend/.env.')
  }
})
