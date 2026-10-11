// Account tests: the stand-in for the Supabase browser client (it lives with the demo tools, which also use it in
// development builds; see components/dev/fakeSupabase.js), and a way to load fresh copies of the app on top of it.
// Not a test file itself (the name does not end in .test.js).
import { loadApi } from './planFixture.js'
import { fakeSupabase } from '../../components/dev/fakeSupabase.js'

export { fakeSupabase }

// Fresh copies of api.js and auth.js on top of the given storage and the stand-in client, as if the page had just
// loaded. Without `fake`, Supabase is not set up (the test runner never sets it up itself).
// How to call: const { api, auth, storage } = await boot(fake, { data: previous.storage.store })
export async function boot(fake = null, storageOptions = {}) {
  const loaded = await loadApi(storageOptions)
  const auth = await import('../auth.js')
  auth.useClient(fake ? fake.client : null)
  return { api: loaded, auth, storage: loaded.storage }
}

export const PROFILE = { email: 'sam@example.com', password: 'Sup3r-secret!', name: 'Sam', username: 'sam', dob: '2001-05-06', homeAreaId: 'tampines', friends: ['darius'] }
export const OTHER = { email: 'kim@example.com', password: 'An0ther-secret!', name: 'Kim', username: 'kim', dob: '1999-02-03', homeAreaId: 'bishan', friends: [] }
export const SESSION = { title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }

