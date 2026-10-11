// A stand-in for the Supabase browser client. It is used by the account tests (through lib/__tests__/authFixture.js) and,
// in development builds only, by the demo tools' "made-up real account" (DemoSignIn.vue), which lets a real account's flow
// be walked with no Supabase project at all. Nothing in a production build imports it. It keeps its users and profile rows
// in one object (`state`) that outlives a module reload, the way Supabase's own database outlives a page reload. The
// session lives where the real client keeps it: in local storage, under the key named in supabase.js, so a sign-out that
// does not remove it leaves the person signed in after a "reload" (a new boot on the same storage). It never touches the
// network.
//
// It answers the way the installed client (@supabase/auth-js 2.117) does for the calls lib/auth.js makes: errors carry
// `name`, `code` and `status`; a lost connection is an AuthRetryableFetchError with status 0; and every HTTP 5xx is also
// an AuthRetryableFetchError, with its status and no code (the client's NETWORK_ERROR_CODES), so the sign-up trigger's
// "Database error saving new user" arrives as a 500 of that class. Sign-up with email confirmation on returns a user and
// no session, and a repeat sign-up of a registered email returns a user with no identities. Profile writes follow the
// database's column grants (db/policies.sql).
import { AUTH_STORAGE_KEY } from '@/lib/supabase.js'

const OWN_PROFILE_COLUMNS = ['display_name', 'avatar_url']
const OWN_PRIVATE_COLUMNS = ['dob', 'home_area_id', 'dietary', 'budget_max_per_person', 'needs_step_free']

// Options:
//   confirmEmail        sign-up returns no session
//   signOutMode         'ok' ends the session; 'reject', 'throw', 'error' and 'hang' (never answers) leave it where it is
//   down                every call fails like a lost connection
//   failWrites          profile updates fail
//   writesHang          profile updates never answer (a slow connection)
//   readsHang           profile reads never answer
//   readError           reading several profiles by id fails with a server error
//   rpcError            the username check answers with this error and a 500
//   staleUsernameCheck  the username check says free until a sign-up has been tried, so the trigger's failure is what
//                       catches a name taken in between
//   breakTrigger        sign-up fails the way the trigger does for a bad date of birth: a 500, username free
//   expired             the stored access token has expired, so getSession refreshes first
//   refreshMode         'ok', 'retryable' (no connection), 'server' (a 502) or 'refused' (the server refuses the refresh
//                       token and the client removes the session)
//   getSessionMode      'ok' or 'hang' (the client is waiting on the network and never answers)
//   signUpError         an error to answer sign-up with
//   uuidIds             new users get uuid-shaped ids (like the real project's) instead of `uid-1`
//   memoryOnly          the session is kept in `state` only, and local storage (including the real client's key) is never touched
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
      readError: false,
      rpcError: null,
      staleUsernameCheck: false,
      breakTrigger: false,
      expired: false,
      refreshMode: 'ok',
      getSessionMode: 'ok',
      signUpError: null,
      uuidIds: false,
      memoryOnly: false,
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
    refreshCalls: 0,
    rpcCalls: [],
    writes: [],
    // Every read of several rows by id (`select(columns).in('id', ids)`), so a test can count the requests and see which
    // columns were asked for.
    reads: [],
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
  const disk = () => (typeof localStorage === 'undefined' || state.options.memoryOnly ? null : localStorage)
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
        const number = state.users.length + 1
        const id = state.options.uuidIds ? `00000000-0000-4000-8000-${String(number).padStart(12, '0')}` : `uid-${number}`
        const user = { id, email, password, meta }
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
            // Several rows by id, as the people source reads `profiles`. Only a signed-in user may; only the columns named come back.
            in: async (_col, ids) => {
              state.reads.push({ table, columns, ids: [...ids] })
              if (state.options.readsHang) return new Promise(() => {})
              if (state.options.down) return lostData()
              if (state.options.readError) return { data: null, error: { message: 'boom', code: '500' }, status: 500 }
              // `profiles.id` is a uuid column: one value that is not a uuid makes the database refuse the whole request.
              const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
              const bad = ids.find((id) => !UUID.test(id))
              if (bad !== undefined) return { data: null, error: { message: `invalid input syntax for type uuid: "${bad}"`, code: '22P02' }, status: 400 }
              if (table !== 'profiles' || !read()) return { data: null, error: { message: 'permission denied' }, status: 403 }
              const named = String(columns).split(',').map((c) => c.trim())
              const rowFor = (id) => Object.fromEntries(named.map((c) => [c, c === 'id' ? id : rows[id][c] ?? null]))
              return { data: ids.filter((id) => rows[id]).map(rowFor), error: null }
            },
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
