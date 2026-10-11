// A stand-in for the Supabase browser client, for the account tests. It keeps its users, session and profile rows in
// one object (`state`) that outlives a module reload, the way Supabase's own storage outlives a page reload. It never
// touches the network. Not a test file itself (the name does not end in .test.js).
//
// It answers the way Supabase does for the calls lib/auth.js makes: errors carry `name`, `code` and `status`, sign-up
// with email confirmation on returns a user and no session, and a repeat sign-up of a registered email returns a user
// with no identities. Profile writes follow the database's column grants (db/policies.sql).
import { loadApi } from './planFixture.js'

const OWN_PROFILE_COLUMNS = ['display_name', 'avatar_url']
const OWN_PRIVATE_COLUMNS = ['dob', 'home_area_id', 'dietary', 'budget_max_per_person', 'needs_step_free']

// Options: confirmEmail (sign-up returns no session), signOutMode ('ok', 'reject', 'throw' or 'error'), down (every
// call fails like a lost connection), failWrites (profile updates fail), staleUsernameCheck (the rpc says free
// even when the name is taken, so the trigger's unique violation is what catches it).
// How to call: const fake = fakeSupabase({ confirmEmail: true })
export function fakeSupabase(options = {}) {
  const state = {
    options: { confirmEmail: false, signOutMode: 'ok', down: false, failWrites: false, staleUsernameCheck: false, ...options },
    users: [],
    session: null,
    profiles: {},
    priv: {},
    // Everything sent to Supabase, in order, so a test can look for what must not be there.
    signUpCalls: [],
    signInCalls: [],
    signOutCalls: [],
    rpcCalls: [],
    writes: [],
    listeners: new Set(),
    count: 0,
  }
  const fire = (event) => {
    for (const fn of [...state.listeners]) fn(event, state.session)
  }
  const apiError = (status, code, message, extra = {}) => ({ name: 'AuthApiError', status, code, message, ...extra })
  const lost = () => {
    if (state.options.down) throw new TypeError('Failed to fetch')
  }
  const publicUser = (u) => ({ id: u.id, email: u.email, user_metadata: { ...u.meta }, identities: [{ id: u.id }] })
  const start = (u) => {
    state.count += 1
    state.session = { access_token: `token-${state.count}`, user: publicUser(u) }
    fire('SIGNED_IN')
  }

  const client = {
    auth: {
      async signUp({ email, password, options: opts }) {
        state.signUpCalls.push(structuredClone({ email, password, options: opts }))
        lost()
        if (password === 'weak') {
          return { data: { user: null, session: null }, error: { ...apiError(422, 'weak_password', 'Password should be at least 8 characters.'), name: 'AuthWeakPasswordError', reasons: ['length'] } }
        }
        if (password === 'limited') return { data: { user: null, session: null }, error: apiError(429, 'over_request_rate_limit', 'Request rate limit reached') }
        if (state.users.some((u) => u.email === email)) {
          if (state.options.confirmEmail) return { data: { user: { id: 'decoy', email, identities: [], user_metadata: {} }, session: null }, error: null }
          return { data: { user: null, session: null }, error: apiError(422, 'user_already_exists', 'User already registered') }
        }
        const meta = opts?.data || {}
        if (Object.values(state.profiles).some((p) => p.username === meta.username)) {
          return { data: { user: null, session: null }, error: apiError(500, 'unexpected_failure', 'Database error saving new user') }
        }
        const user = { id: `uid-${state.users.length + 1}`, email, password, meta }
        state.users.push(user)
        state.profiles[user.id] = { username: meta.username, display_name: meta.username, avatar_url: null }
        state.priv[user.id] = { dob: meta.dob, home_area_id: null }
        if (state.options.confirmEmail) return { data: { user: { ...publicUser(user) }, session: null }, error: null }
        start(user)
        return { data: { user: publicUser(user), session: state.session }, error: null }
      },
      async signInWithPassword({ email, password }) {
        state.signInCalls.push({ email })
        lost()
        const user = state.users.find((u) => u.email === email && u.password === password)
        if (!user) return { data: { user: null, session: null }, error: apiError(400, 'invalid_credentials', 'Invalid login credentials') }
        start(user)
        return { data: { user: publicUser(user), session: state.session }, error: null }
      },
      signOut(args) {
        state.signOutCalls.push(args)
        if (state.options.signOutMode === 'throw') throw new Error('boom')
        if (state.options.signOutMode === 'reject') return Promise.reject(new Error('Failed to fetch'))
        if (state.options.signOutMode === 'error') return Promise.resolve({ error: { name: 'AuthRetryableFetchError', message: 'down' } })
        state.session = null
        fire('SIGNED_OUT')
        return Promise.resolve({ error: null })
      },
      async getSession() {
        return { data: { session: state.session }, error: null }
      },
      async refreshSession() {
        if (!state.session) return { data: { session: null }, error: apiError(400, 'session_missing', 'no session') }
        state.count += 1
        state.session = { ...state.session, access_token: `token-${state.count}` }
        return { data: { session: state.session }, error: null }
      },
      onAuthStateChange(fn) {
        state.listeners.add(fn)
        return { data: { subscription: { unsubscribe: () => state.listeners.delete(fn) } } }
      },
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args })
      lost()
      const taken = Object.values(state.profiles).some((p) => p.username === args.p_username)
      return { data: state.options.staleUsernameCheck ? true : !taken, error: null }
    },
    from(table) {
      const rows = table === 'profiles' ? state.profiles : state.priv
      return {
        select(columns) {
          return {
            eq: (_col, id) => ({
              maybeSingle: async () => {
                lost()
                const row = rows[id]
                if (!row) return { data: null, error: null }
                return { data: row, error: null }
              },
            }),
          }
        },
        update(row) {
          return {
            eq: (_col, id) => ({
              select: async () => {
                const allowed = table === 'profiles' ? OWN_PROFILE_COLUMNS : OWN_PRIVATE_COLUMNS
                state.writes.push({ table, row: { ...row }, id })
                if (state.options.failWrites) return { data: null, error: { message: 'down' } }
                if (!Object.keys(row).every((c) => allowed.includes(c))) return { data: null, error: { message: 'permission denied' } }
                if (state.session?.user.id !== id || !rows[id]) return { data: [], error: null }
                Object.assign(rows[id], row)
                return { data: [{ id }], error: null }
              },
            }),
          }
        },
      }
    },
  }
  // The session ends without the app asking, as when a refresh token expires or another tab signs out.
  state.endSession = () => {
    state.session = null
    fire('SIGNED_OUT')
  }
  return { client, state }
}

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

