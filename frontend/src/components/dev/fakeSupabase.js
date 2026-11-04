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
//
// Stage 2 adds the sessions side of the database (fakeDatabase.js): `from('sessions' | 'session_members' | 'invites')` (and, from
// stage 3, `session_member_places`, `session_spots`, `spot_suggestions` and `spot_approvals`; from stage 4, `slots`, `slot_options` and
// `votes`; from stage 5, `stops`, `commute_ledger` and `stop_proposals`),
// the functions `invite_preview`, `join_session`, `my_invitations` and `decline_invite`, and Realtime's `channel()` /
// `removeChannel()`, all acting as the signed-in user (or the public key when nobody is signed in). By default each
// stand-in has a database of its own; give `database` to have several share one (a script holding one database for two
// browsers). What is not modelled is listed at the top of fakeDatabase.js.
import { AUTH_STORAGE_KEY } from '@/lib/supabase.js'
import { createDataClient, createDatabase } from './fakeDatabase.js'

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
//   realtimeLeaveMs     how long a Realtime channel takes to leave (the server's acknowledgement). A channel is torn down only
//                       after it, as in realtime-js
//   database            a database from createDatabase() (or a stand-in for one in another process) to use instead of a new one.
//                       New users then get random uuids, so two stand-ins sharing it never make the same id
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
      database: null,
      realtimeLeaveMs: 30,
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
    // Every session this stand-in has handed out, by refresh token, so setSession can find the one it is given.
    issued: {},
    setSessionCalls: 0,
    otherSessionsEnded: 0,
    rpcCalls: [],
    writes: [],
    // Every read of several rows by id (`select(columns).in('id', ids)`), so a test can count the requests and see which
    // columns were asked for.
    reads: [],
    listeners: new Set(),
    count: 0,
    database: null,
  }
  // The sessions side of the database: its own, or one shared with other stand-ins.
  state.database = state.options.database || createDatabase({ profiles: state.profiles })
  const shared = !!state.options.database
  // Reads of other people's profiles that this stand-in does not hold yet, from the shared database.
  // How to call: await learn([uid])
  const learn = async (ids) => {
    const found = await state.database.getProfiles(ids.filter((id) => !state.profiles[id]))
    Object.assign(state.profiles, found)
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
  // A token's text. Stand-ins that share a database must not issue the same one to two people, so then it is random.
  // How to call: tokenText() -> 'token-3'
  const tokenText = () => (shared ? `token-${globalThis.crypto.randomUUID()}` : `token-${state.count}`)
  const start = (u) => {
    state.count += 1
    write({ access_token: tokenText(), refresh_token: `refresh-${state.count}`, user: publicUser(u) })
    // A shared database learns whose token this is, so a stand-in backend can check it.
    if (shared) state.database.setToken?.(state.session.access_token, u.id)
    state.issued[state.session.refresh_token] = state.session
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
    write({ ...stored, access_token: tokenText() })
    if (shared) state.database.setToken?.(state.session.access_token, stored.user.id)
    state.options.expired = false
    fire('TOKEN_REFRESHED')
    return { data: { user: state.session.user, session: state.session }, error: null }
  }

  // The sessions side of the database, acting as the signed-in user (the public key when nobody is). When the connection is
  // down (option `down`) every request fails like a lost connection.
  const data = createDataClient({
    database: {
      run: async (op) => (state.options.down ? lostData() : state.database.run(op)),
      subscribe: (spec, cb) => state.database.subscribe(spec, cb),
    },
    as: () => read()?.user.id ?? null,
    leaveMs: state.options.realtimeLeaveMs,
  })

  // For a test: the channels open now, `state.dataClient.getChannels()`.
  state.dataClient = data

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
        if (state.options.breakTrigger || Object.values(state.profiles).some((p) => p.username === meta.username) || (shared && (await state.database.usernameTaken(meta.username)))) {
          return { data: { user: null, session: null }, error: retryable(500, 'Database error saving new user') }
        }
        const number = state.users.length + 1
        const id = shared ? globalThis.crypto.randomUUID() : state.options.uuidIds ? `00000000-0000-4000-8000-${String(number).padStart(12, '0')}` : `uid-${number}`
        const user = { id, email, password, meta }
        state.users.push(user)
        // As the sign-up trigger does (db/schema.sql): the optional name, home area and dietary needs are saved when
        // they keep the rules, and left out otherwise.
        const name = typeof meta.name === 'string' && meta.name.trim() && meta.name.trim().length <= 50 ? meta.name.trim() : null
        const area = typeof meta.home_area_id === 'string' && meta.home_area_id.trim() ? meta.home_area_id.trim() : null
        const diet = Array.isArray(meta.dietary) ? [...new Set(meta.dietary.filter((d) => ['halal', 'vegetarian', 'vegan'].includes(d)))].sort() : []
        state.profiles[user.id] = { username: meta.username, display_name: name || meta.username, avatar_url: null }
        // A shared database learns the new person, so another stand-in can read their name.
        if (shared) await state.database.setProfile(user.id, state.profiles[user.id])
        state.priv[user.id] = { dob: meta.dob, home_area_id: area, dietary: diet }
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
        // Signing out the other sessions leaves this one where it is, as the real client does (scope 'others').
        if (args?.scope === 'others') {
          if (mode === 'throw') throw new Error('boom')
          if (mode === 'reject') return Promise.reject(new Error('Failed to fetch'))
          if (mode === 'error') return Promise.resolve({ error: retryable(0, 'Failed to fetch') })
          if (mode === 'hang') return new Promise(() => {})
          state.otherSessionsEnded += 1
          return Promise.resolve({ error: null })
        }
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
      // Makes the session with these tokens the current one, as the client does. An unknown refresh token is refused.
      async setSession({ refresh_token: token }) {
        state.setSessionCalls += 1
        if (state.options.down) return { data: { user: null, session: null }, error: retryable(0, 'Failed to fetch') }
        const found = state.issued[token]
        if (!found) return { data: { user: null, session: null }, error: apiError(400, 'refresh_token_not_found', 'Invalid Refresh Token: Refresh Token Not Found') }
        write(found)
        fire('SIGNED_IN')
        return { data: { user: found.user, session: found }, error: null }
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
      // The database refuses this to the browser's key (db/policies.sql): the browser asks the backend instead.
      if (name === 'email_registered') throw new Error('The browser must not call email_registered; it asks the backend.')
      // The functions of the sessions side of the database, acting as whoever is signed in.
      if (state.database.functionNames.includes(name)) return data.rpc(name, args)
      if (state.options.rpcError) return { data: null, error: state.options.rpcError, status: 500 }
      const taken = Object.values(state.profiles).some((p) => p.username === args.p_username) || (shared && !!(await state.database.usernameTaken(args.p_username)))
      const stale = state.options.staleUsernameCheck && state.signUpCalls.length === 0
      return { data: stale ? true : !taken, error: null }
    },
    channel: (name) => data.channel(name),
    removeChannel: (channel) => data.removeChannel(channel),
    from(table) {
      // The sessions side of the database has its own tables and rules (fakeDatabase.js).
      if (['saved_places', 'sessions', 'session_members', 'invites', 'session_member_places', 'session_spots', 'spot_suggestions', 'spot_approvals', 'slots', 'slot_options', 'votes', 'stops', 'commute_ledger', 'stop_proposals', 'session_member_dietary', 'session_dietary_dropped'].includes(table)) return data.from(table)
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
              if (shared) await learn(ids)
              const named = String(columns).split(',').map((c) => c.trim())
              const rowFor = (id) => Object.fromEntries(named.map((c) => [c, c === 'id' ? id : rows[id][c] ?? null]))
              return { data: ids.filter((id) => rows[id]).map(rowFor), error: null }
            },
            eq: (col, id) => ({
              maybeSingle: async () => {
                if (state.options.readsHang) return new Promise(() => {})
                if (state.options.down) return lostData()
                // A person is looked up by id (the account's own profile) or, for the invite by username, by username.
                if (col === 'username' && table === 'profiles') {
                  if (!read()) return { data: null, error: { message: 'permission denied' }, status: 403 }
                  let found = Object.entries(rows).find(([, p]) => p.username === id)
                  if (!found && shared) {
                    const remote = await state.database.profileByUsername(id)
                    if (remote) found = [remote.id, remote]
                  }
                  if (!found) return { data: null, error: null }
                  const named = String(columns).split(',').map((c) => c.trim())
                  return { data: Object.fromEntries(named.map((c) => [c, c === 'id' ? found[0] : found[1][c] ?? null])), error: null }
                }
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
  // The client tells its listeners something, as when a reset link is accepted: fake.state.emit('PASSWORD_RECOVERY').
  state.emit = (event) => fire(event)
  // The backend's email check, answered from the users here (a stand-in for POST /api/accounts/email-check).
  state.emailRegistered = (email) => state.users.some((u) => u.email.toLowerCase() === String(email).trim().toLowerCase())
  // The session ends without the app asking, as when a refresh token expires or another tab signs out.
  state.endSession = () => {
    write(null)
    fire('SIGNED_OUT')
  }
  return { client, state }
}
