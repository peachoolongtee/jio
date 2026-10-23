import { once } from 'node:events'
import { createApp } from '../../src/app.js'
import { createSupabase } from '../../src/db/supabase.js'
import { createHttp } from '../../src/services/http.js'
import { createWeather } from '../../src/services/weather.js'
import { fakeSupabase, jwksFetch, SUPABASE_URL, tokenFor } from './fake-supabase.js'

// Starts the real app over a fake database, for the session tests. The login check is the real code (it verifies the tokens
// tokenFor signs); the database is the fake in ./fake-supabase.js. Nothing touches the network.
//
// How to call:
//   const world = createWorld()
//   const t = await startSessionApp(world)
//   const res = await t.call('POST', `/api/sessions/${SESSION}/meeting-area`, { trigger: 'start' }, GUEST)  // a fifth argument adds headers
//   // { status: 200, body: {...}, headers }
//   await t.stop()
export async function startSessionApp(world, options = {}) {
  const real = createSupabase({ url: SUPABASE_URL, anonKey: 'anon-key', serviceKey: 'service-key', fetchImpl: jwksFetch })
  const supabase = options.supabase === false ? null : fakeSupabase(world, real)
  const { supabase: _ignored, ...rest } = options
  // The forecast answers from the stub fixtures (a voting ranking asks for it), so no test needs the network, whatever day it runs on.
  const weather = createWeather({ http: createHttp({ stub: true }) })
  const server = createApp({ frontendOrigin: 'http://localhost:5173', supabase, weather, ...rest }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return {
    base,
    // Calls the app as a person (`as` is a user id; none sends no token). Resolves { status, body, headers }.
    async call(method, path, body, as, headers = {}) {
      const res = await fetch(`${base}${path}`, {
        method,
        headers: { ...(body !== undefined && { 'content-type': 'application/json' }), ...(as && { authorization: `Bearer ${tokenFor(as)}` }), ...headers },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      })
      return { status: res.status, body: await res.json(), headers: res.headers }
    },
    stop: () => new Promise((resolve) => server.close(resolve)),
  }
}

// The people and the session most tests use. Ids are lower-case, as Postgres prints them.
export const HOST = '1111111a-1111-4111-8111-11111111111b'
export const GUEST = '2222222c-2222-4222-8222-22222222222d'
export const OTHER = '3333333e-3333-4333-8333-33333333333f'
export const STRANGER = '44444444-4444-4444-8444-444444444444'
export const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'

// Adds a session to the world.
//
// How to call:
//   addSession(world, { id: SESSION, host: HOST, status: 'locating', version: 4 })
export function addSession(world, { id = SESSION, host = HOST, status = 'locating', version = 0, date = '2026-10-25', start = '10:00:00', end = '20:00:00' } = {}) {
  world.sessions.push({
    id,
    host_id: host,
    status,
    plan_version: version,
    radius_meters: null,
    date,
    start_time: start,
    end_time: end,
    meeting_area_id: null,
    meeting_method: null,
    meeting_max_minutes: null,
    meeting_total_minutes: null,
    meeting_count: null,
    meeting_approximate: null,
    meeting_computed_at: null,
    banner: null,
  })
}

// Adds a member (and their profile) to a session. `start` and `end` are area ids.
//
// How to call:
//   addMember(world, SESSION, GUEST, { start: 'bishan' })
export function addMember(world, sessionId, userId, { role = 'guest', state = 'joined', start = null, end = null, name } = {}) {
  world.session_members.push({ session_id: sessionId, user_id: userId, role, state, start_area_id: start, end_area_id: end, travel_minutes: null })
  if (!world.profiles.some((p) => p.id === userId)) world.profiles.push({ id: userId, display_name: name ?? `Person ${userId.slice(0, 2)}`, username: `u${userId.slice(0, 6)}` })
}
