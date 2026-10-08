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

// Supabase: token checks and database access. All three values are needed. Without them the server
// still runs, but the routes that need a login are switched off.
const { SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY } = process.env
const supabaseReady = SUPABASE_URL && SUPABASE_ANON_KEY && SUPABASE_SERVICE_ROLE_KEY
const supabase = supabaseReady
  ? createSupabase({ url: SUPABASE_URL, anonKey: SUPABASE_ANON_KEY, serviceKey: SUPABASE_SERVICE_ROLE_KEY })
  : null

createApp({ frontendOrigin, stub, http, supabase }).listen(port, () => {
  console.log(`Jio backend listening on port ${port}, allowing ${frontendOrigin}`)
  if (stub) console.log('Stub mode is ON: external API calls are answered from fixtures.')
  if (!supabase) {
    console.log('Supabase is NOT configured: routes that need a login are off. Set SUPABASE_URL, SUPABASE_ANON_KEY and SUPABASE_SERVICE_ROLE_KEY in backend/.env.')
  }
})
