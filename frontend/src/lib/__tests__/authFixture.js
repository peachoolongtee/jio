// A stand-in for the Supabase browser client, for the account tests. It keeps its users and profile rows in one object
// (`state`) that outlives a module reload, the way Supabase's own database outlives a page reload. The session lives
// where the real client keeps it: in local storage, under the key named in supabase.js, so a sign-out that does not
// remove it leaves the person signed in after a "reload" (a new boot on the same storage). It never touches the network.
// Not a test file itself (the name does not end in .test.js).
//
// It answers the way the installed client (@supabase/auth-js 2.117) does for the calls lib/auth.js makes: errors carry
// `name`, `code` and `status`; a lost connection is an AuthRetryableFetchError with status 0; and every HTTP 5xx is also
// an AuthRetryableFetchError, with its status and no code (the client's NETWORK_ERROR_CODES), so the sign-up trigger's
// "Database error saving new user" arrives as a 500 of that class. Sign-up with email confirmation on returns a user and
// no session, and a repeat sign-up of a registered email returns a user with no identities. Profile writes follow the
// database's column grants (db/policies.sql).
import { loadApi } from './planFixture.js'
import { AUTH_STORAGE_KEY } from '../supabase.js'

const OWN_PROFILE_COLUMNS = ['display_name', 'avatar_url']
const OWN_PRIVATE_COLUMNS = ['dob', 'home_area_id', 'dietary', 'budget_max_per_person', 'needs_step_free']

// Options:
//   confirmEmail        sign-up returns no session
//   signOutMode         'ok' ends the session; 'reject', 'throw', 'error' and 'hang' (never answers) leave it where it is
//   down                every call fails like a lost connection
//   failWrites          profile updates fail
//   writesHang          profile updates never answer (a slow connection)
//   readsHang           profile reads never answer
//   rpcError            the username check answers with this error and a 500
//   staleUsernameCheck  the username check says free until a sign-up has been tried, so the trigger's failure is what
//                       catches a name taken in between
//   breakTrigger        sign-up fails the way the trigger does for a bad date of birth: a 500, username free
//   expired             the stored access token has expired, so getSession refreshes first
//   refreshMode         'ok', 'retryable' (no connection), 'server' (a 502) or 'refused' (the server refuses the refresh
//                       token and the client removes the session)
//   getSessionMode      'ok' or 'hang' (the client is waiting on the network and never answers)
//   signUpError         an error to answer sign-up with
// How to call: const fake = fakeSupabase({ confirmEmail: true })
export function fakeSupabase(options = {}) {
  const state = {
    options: {
      confirmEmail: false,
      signOutMode: 'ok',
      down: false,
      failWrites: false,
      writesHang: false,
      readsHang: false,
      rpcError: null,
      staleUsernameCheck: false,
      breakTrigger: false,
      expired: false,
      refreshMode: 'ok',
      getSessionMode: 'ok',
      signUpError: null,
      ...options,
    },
    users: [],
    session: null,
    profiles: {},
    priv: {},
    // Everything sent to Supabase, in order, so a test can look for what must not be there.
    signUpCalls: [],
    signInCalls: [],
    signOutCalls: [],
    resetCalls: [],
    passwordUpdates: [],
    refreshCalls: 0,
    rpcCalls: [],
    writes: [],
    listeners: new Set(),
    count: 0,
  }
  const fire = (event) => {
    for (const fn of [...state.listeners]) fn(event, state.session)
  }
  const apiError = (status, code, message, extra = {}) => ({ name: 'AuthApiError', status, code, message, ...extra })
  // What the installed client makes of a failed request: status 0 for no answer, the status for any 5xx.
  const retryable = (status, message) => Object.assign(new Error(message), { name: 'AuthRetryableFetchError', status })
  const sessionMissing = () => Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400, code: 'session_missing' })
  // What the data client (PostgREST) returns when the request never got an answer.
  const lostData = () => ({ data: null, error: { message: 'TypeError: Failed to fetch', details: '', hint: '', code: '' }, status: 0 })
  const publicUser = (u) => ({ id: u.id, email: u.email, user_metadata: { ...u.meta }, identities: [{ id: u.id }] })

  // The session is kept in local storage, as the real client keeps it; without a storage it is only in `state`.
  const disk = () => (typeof localStorage === 'undefined' ? null : localStorage)
  const write = (session) => {
    state.session = session
    const d = disk()
    if (!d) return
    if (session) d.setItem(AUTH_STORAGE_KEY, JSON.stringify(session))
    else d.removeItem(AUTH_STORAGE_KEY)
  }
  const read = () => {
    const d = disk()
    if (!d) return state.session
    try {
      return JSON.parse(d.getItem(AUTH_STORAGE_KEY))
    } catch {
      return null
    }
  }
  const start = (u) => {
    state.count += 1
    write({ access_token: `token-${state.count}`, refresh_token: `refresh-${state.count}`, user: publicUser(u) })
    fire('SIGNED_IN')
  }
  const refresh = async () => {
    state.refreshCalls += 1
    const stored = read()
    if (!stored) return { data: { user: null, session: null }, error: sessionMissing() }
    const { refreshMode, down } = state.options
    if (down || refreshMode === 'retryable') return { data: { user: null, session: null }, error: retryable(0, 'Failed to fetch') }
    if (refreshMode === 'server') return { data: { user: null, session: null }, error: retryable(502, 'Bad Gateway') }
    if (refreshMode === 'refused') {
      write(null)
      fire('SIGNED_OUT')
      return { data: { user: null, session: null }, error: apiError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found') }
    }
    state.count += 1
    write({ ...stored, access_token: `token-${state.count}` })
    state.options.expired = false
    fire('TOKEN_REFRESHED')
    return { data: { user: state.session.user, session: state.session }, error: null }
  }

  const client = {
    auth: {
      async signUp({ email, password, options: opts }) {
        state.signUpCalls.push(structuredClone({ email, password, options: opts }))
        if (state.options.down) return { data: { user: null, session: null }, error: retryable(0, 'Failed to fetch') }
        if (state.options.signUpError) return { data: { user: null, session: null }, error: state.options.signUpError }
        if (password === 'weak') {
          return { data: { user: null, session: null }, error: { ...apiError(422, 'weak_password', 'Password should be at least 8 characters.'), name: 'AuthWeakPasswordError', reasons: ['length'] } }
        }
        if (password === 'limited') return { data: { user: null, session: null }, error: apiError(429, 'over_request_rate_limit', 'Request rate limit reached') }
        if (state.users.some((u) => u.email === email)) {
          if (state.options.confirmEmail) return { data: { user: { id: 'decoy', email, identities: [], user_metadata: {} }, session: null }, error: null }
          return { data: { user: null, session: null }, error: apiError(422, 'user_already_exists', 'User already registered') }
        }
        const meta = opts?.data || {}
        if (state.options.breakTrigger || Object.values(state.profiles).some((p) => p.username === meta.username)) {
          return { data: { user: null, session: null }, error: retryable(500, 'Database error saving new user') }
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
        if (state.options.down) return { data: { user: null, session: null }, error: retryable(0, 'Failed to fetch') }
        const user = state.users.find((u) => u.email === email && u.password === password)
        if (!user) return { data: { user: null, session: null }, error: apiError(400, 'invalid_credentials', 'Invalid login credentials') }
        start(user)
        return { data: { user: publicUser(user), session: state.session }, error: null }
      },
      signOut(args) {
        state.signOutCalls.push(args)
        const mode = state.options.signOutMode
        if (mode === 'throw') throw new Error('boom')
        if (mode === 'reject') return Promise.reject(new Error('Failed to fetch'))
        if (mode === 'error') return Promise.resolve({ error: retryable(0, 'Failed to fetch') })
        if (mode === 'hang') return new Promise(() => {})
        write(null)
        fire('SIGNED_OUT')
        return Promise.resolve({ error: null })
      },
      async getSession() {
        if (state.options.getSessionMode === 'hang') return new Promise(() => {})
        const stored = read()
        if (!stored) return { data: { session: null }, error: null }
        // An expired access token is refreshed first, as the real client does. If the refresh cannot be made the
        // session is not returned, but it is left in storage unless the server refused it.
        if (state.options.expired) {
          const { data, error } = await refresh()
          if (error) return { data: { session: null }, error }
          return { data: { session: data.session }, error: null }
        }
        return { data: { session: stored }, error: null }
      },
      async refreshSession() {
        return refresh()
      },
      // Answers the same for a registered and an unknown email, as Supabase does. 'limited@example.com' is rate limited.
      async resetPasswordForEmail(email, opts) {
        state.resetCalls.push({ email, options: opts })
        if (state.options.down) return { data: null, error: retryable(0, 'Failed to fetch') }
        if (email === 'limited@example.com') return { data: null, error: apiError(429, 'over_email_send_rate_limit', 'Email rate limit exceeded') }
        return { data: {}, error: null }
      },
      // Changes the signed-in user's password. The password is not recorded in `passwordUpdates`, only that it changed.
      async updateUser({ password }) {
        if (state.options.down) return { data: { user: null }, error: retryable(0, 'Failed to fetch') }
        const stored = read()
        if (!stored) return { data: { user: null }, error: sessionMissing() }
        const user = state.users.find((u) => u.id === stored.user.id)
        if (password === user.password) {
          return { data: { user: null }, error: apiError(422, 'same_password', 'New password should be different from the old password.') }
        }
        user.password = password
        state.passwordUpdates.push(user.id)
        fire('USER_UPDATED')
        return { data: { user: publicUser(user) }, error: null }
      },
      onAuthStateChange(fn) {
        state.listeners.add(fn)
        return { data: { subscription: { unsubscribe: () => state.listeners.delete(fn) } } }
      },
    },
    async rpc(name, args) {
      state.rpcCalls.push({ name, args })
      if (state.options.down) return lostData()
      if (state.options.rpcError) return { data: null, error: state.options.rpcError, status: 500 }
      const taken = Object.values(state.profiles).some((p) => p.username === args.p_username)
      const stale = state.options.staleUsernameCheck && state.signUpCalls.length === 0
      return { data: stale ? true : !taken, error: null }
    },
    from(table) {
      const rows = table === 'profiles' ? state.profiles : state.priv
      return {
        select(columns) {
          return {
            eq: (_col, id) => ({
              maybeSingle: async () => {
                if (state.options.readsHang) return new Promise(() => {})
                if (state.options.down) return lostData()
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
                if (state.options.writesHang) return new Promise(() => {})
                if (state.options.down) return lostData()
                if (state.options.failWrites) return { data: null, error: { message: 'down' } }
                if (!Object.keys(row).every((c) => allowed.includes(c))) return { data: null, error: { message: 'permission denied' } }
                if (read()?.user.id !== id || !rows[id]) return { data: [], error: null }
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
    write(null)
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

