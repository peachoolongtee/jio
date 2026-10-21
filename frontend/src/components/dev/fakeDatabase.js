// A stand-in for the part of Jio's Supabase database that stages 2 and 3 use: sessions, who is in them, invite links, where
// people start from and the meeting spots. It
// follows db/schema.sql and db/policies.sql as the live project has them, so a flow can be walked and tested with no
// project contacted. It has no imports, so the browser (through fakeSupabase.js) and a Node script can both use it, and a
// script can hold ONE database for two browsers and a backend, the way a real project is one database for two devices.
//
// What it models, from the files:
//   - the tables `sessions`, `session_members` and `invites`, with their defaults, check constraints, foreign keys to
//     `profiles` and the unique indexes (one live link per session; one invitation per person per session);
//   - stage 3: `session_member_places` (a member's exact place: only its owner reads it, and it is never published to live
//     updates), `session_spots`, `spot_suggestions` and `spot_approvals` (members read them; only the server writes the first
//     two, and a member inserts and deletes their own approval while joined and the session is locating);
//   - `slots`, empty: the server counts them when the host confirms a spot, and nothing in this stage makes any (stage 4 does);
//   - who may read each row (a member reads their session, a host reads every invite of theirs, an invitee reads their own
//     invitations, a member reads the pending personal invitations of their session), and who may write which columns:
//     a signed-in user inserts a session (as the host) and an invite (as its creator, for a session they host), updates a
//     session's title, date, times and status (host only), and revokes an invite (host only, and it cannot be undone). A member
//     updates their own `start_area_id`, `end_area_id`, `categories` and `stay_until` while joined and the session is open, and
//     keeps their own exact place the same way. The browser has no insert or delete on `session_members`. The service key does anything;
//   - the triggers: the host's member row on a new session, the checks before an invite is made (the session is open, a
//     personal invitation is not for the host or a member, at most 30 open ones), and `guard_session_changes` (a finished
//     session is frozen; the only status changes are start, with two joined people, and cancel; the date and times change
//     only while inviting);
//   - the functions `invite_preview`, `join_session`, `my_invitations` and `decline_invite`, with the same answers and
//     errors (P0002 for any link that is not good, 28000 when not signed in, P0001 with hint session_full at 30 people);
//   - `apply_session_plan`, the one function the server writes a session's plan through (the service key only): the version and
//     status checks that answer null, the pinned area, a pin only with a confirm, the status move (the two-people check after the
//     operations), the members', suggestions' and approvals' operations (the host cannot be opted out or removed), the spots as a
//     difference (with the time the inputs were loaded, `loaded_at`), the banner and the meeting area, each a change only where a
//     value differs from the stored row. A port of the SQL (and of backend/tests/helpers/fake-supabase.js);
//     it does not run in the built app, only where this stand-in is loaded;
//   - Realtime: `subscribe` delivers inserts, updates and deletes of the published tables (`sessions`, `session_members`,
//     `invites`, `spot_approvals`), as the `supabase_realtime` publication carries them. `session_member_places`,
//     `session_spots` and `spot_suggestions` are not published: a subscriber to them hears nothing. An insert or update reaches only a subscriber who may read the row, and passes the
//     subscriber's filter. A delete is not filtered by access rules, carries only the row's key, and, as Supabase cannot
//     filter deletes, is NOT delivered to a subscriber who gave a filter (the stricter reading, so code cannot lean on it).
//
// Order of checks on an insert follows Postgres: a type error (a value that is not a uuid is 22P02, before anything else), the
// BEFORE triggers (check_invite_insert, even for the server), the row-level "with check", then the constraints (foreign keys,
// check constraints, unique indexes). A statement that RETURNS a row the caller may not read fails as a whole (42501) and
// leaves nothing behind.
//
// What it does NOT model: the planner columns of `sessions` beyond what stage 3 reads (meeting_*, banner and plan_version are
// there and the server's stand-in writes them; radius and replan are not), `slots`, `votes`, `stops` and the other tables, the 30-day
// ceiling on how far ahead `expires_at` may be set beyond what the check says, row locks and concurrent transactions (one
// call runs to the end before the next), Postgres's exact error texts beyond the ones the app reads, Realtime's connection
// life (reconnects, missed events), and the rate limits and size limits of Supabase itself.
//
// An acting identity is a user id (signed in), null (the public key, signed out) or SERVICE (the server's key).
// How to call: const db = createDatabase({ profiles: { [uid]: { username: 'sam', display_name: 'Sam', avatar_url: null } } }); db.run({ as: uid, kind: 'select', table: 'sessions', columns: '*', filters: [] })

export const SERVICE = 'service'

const PRIMARY_KEY = {
  sessions: ['id'],
  session_members: ['session_id', 'user_id'],
  invites: ['token'],
  session_member_places: ['session_id', 'user_id'],
  session_spots: ['session_id', 'area_id'],
  spot_suggestions: ['session_id', 'user_id'],
  spot_approvals: ['session_id', 'area_id', 'user_id'],
  slots: ['id'],
}
// The tables the supabase_realtime publication carries (db/policies.sql). The others raise no live events.
const PUBLISHED = new Set(['sessions', 'session_members', 'invites', 'spot_approvals'])
const PLACE_COLUMNS = ['start_label', 'start_lat', 'start_lng', 'end_label', 'end_lat', 'end_lng']
const DAY_MS = 24 * 60 * 60 * 1000
const OPEN = ['inviting', 'locating', 'voting']
const MAX_JOINED = 30
const GRANTS = {
  sessions: { insert: ['host_id', 'title', 'date', 'start_time', 'end_time'], update: ['title', 'date', 'start_time', 'end_time', 'status'] },
  invites: { insert: ['session_id', 'created_by', 'expires_at', 'invitee_id'], update: ['revoked'] },
  session_members: { insert: [], update: ['start_area_id', 'end_area_id', 'categories', 'stay_until'] },
  session_member_places: { insert: ['session_id', 'user_id', ...PLACE_COLUMNS], update: PLACE_COLUMNS, delete: true },
  session_spots: { insert: [], update: [] },
  spot_suggestions: { insert: [], update: [] },
  spot_approvals: { insert: ['session_id', 'area_id', 'user_id'], update: [], delete: true },
  slots: { insert: [], update: [] },
}

// A database error as the client reports it: { message, code, details, hint }, with the HTTP status PostgREST would use.
// How to call: throw new DbError('42501', 'permission denied for table sessions', { status: 403 })
class DbError extends Error {
  constructor(code, message, { status = 400, hint = null } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.hint = hint
  }
}
// How to call: throw denied('sessions'); throw rlsRefused('invites')
const denied = (table) => new DbError('42501', `permission denied for table ${table}`, { status: 403 })
const rlsRefused = (table) => new DbError('42501', `new row violates row-level security policy for table "${table}"`, { status: 403 })

// The uuid columns, which Postgres refuses any other text for with 22P02 before it looks at a row.
const UUID_COLUMNS = {
  sessions: ['id', 'host_id'],
  session_members: ['session_id', 'user_id'],
  invites: ['session_id', 'created_by', 'invitee_id'],
  session_member_places: ['session_id', 'user_id'],
  session_spots: ['session_id'],
  spot_suggestions: ['session_id', 'user_id'],
  spot_approvals: ['session_id', 'user_id'],
  slots: ['id', 'session_id'],
}
const UUID_TEXT = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Throw 22P02 for a value that is not a uuid in a uuid column (a null is fine).
// How to call: checkUuid('sessions', 'id', 'not-a-uuid') throws
function checkUuid(table, column, value) {
  if (!UUID_COLUMNS[table]?.includes(column) || value === null || value === undefined) return
  if (typeof value !== 'string' || !UUID_TEXT.test(value)) throw new DbError('22P02', `invalid input syntax for type uuid: "${value}"`)
}
// How to call: checkFilters('sessions', [{ col: 'id', op: 'eq', value: 'x' }]) throws
function checkFilters(table, filters = []) {
  for (const { col, value } of filters) for (const v of Array.isArray(value) ? value : [value]) checkUuid(table, col, v)
}

// A random token of the length the schema makes: 32 bytes as 43 URL-safe characters.
// How to call: newToken() -> 'q3D9...' (43 characters)
function newToken() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(32))
  let text = ''
  for (const b of bytes) text += String.fromCharCode(b)
  return btoa(text).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

// How to call: newId() -> '3b1f...' (a uuid)
const newId = () => globalThis.crypto.randomUUID()
// How to call: clock(86400000) -> '1970-01-02T00:00:00.000Z'
const iso = (ms) => new Date(ms).toISOString()
// How to call: timeText('18:00') -> '18:00:00'; timeText('7pm') throws a check-style error
function timeText(value) {
  const m = /^([01]\d|2[0-3]):([0-5]\d)(?::([0-5]\d))?$/.exec(String(value ?? ''))
  if (!m) throw new DbError('22007', `invalid input syntax for type time: "${value}"`)
  return `${m[1]}:${m[2]}:${m[3] ?? '00'}`
}
// How to call: dateText('2026-10-17') -> '2026-10-17'
function dateText(value) {
  const text = String(value ?? '')
  const d = /^\d{4}-\d{2}-\d{2}$/.test(text) ? new Date(`${text}T00:00:00Z`) : null
  if (!d || Number.isNaN(d.getTime()) || d.toISOString().slice(0, 10) !== text) throw new DbError('22007', `invalid input syntax for type date: "${value}"`)
  return text
}

// How to call: const db = createDatabase({ profiles, now: () => Date.now() })
export function createDatabase({ profiles = {}, now = () => Date.now() } = {}) {
  const tables = { sessions: [], session_members: [], invites: [], session_member_places: [], session_spots: [], spot_suggestions: [], spot_approvals: [], slots: [] }
  const subscribers = new Set()
  // The events of the statement being run, or null outside one.
  let queue = null
  // Declared here so the rules can be replaced in a test: self.canSee(...).
  const self = {}

  // Who is in what. How to call: isMember(uid, sessionId) -> true; isHost(uid, sessionId) -> true; sessionOf(sessionId) -> the row
  const isMember = (uid, sessionId) => tables.session_members.some((m) => m.session_id === sessionId && m.user_id === uid)
  const isHost = (uid, sessionId) => tables.sessions.some((s) => s.id === sessionId && s.host_id === uid)
  const sessionOf = (id) => tables.sessions.find((s) => s.id === id)
  // my_open_session_ids() and my_locating_session_ids(): the person has joined, and the session is open / is locating.
  // How to call: inOpen(uid, sessionId) -> true; inLocating(uid, sessionId) -> false
  const joinedIn = (uid, sessionId) => tables.session_members.some((m) => m.session_id === sessionId && m.user_id === uid && m.state === 'joined')
  const inOpen = (uid, sessionId) => joinedIn(uid, sessionId) && OPEN.includes(sessionOf(sessionId)?.status)
  const inLocating = (uid, sessionId) => joinedIn(uid, sessionId) && sessionOf(sessionId)?.status === 'locating'

  // May this identity read this row? The select policies of db/policies.sql.
  // How to call: canSee(uid, 'invites', row)
  function canSee(as, table, row) {
    if (as === SERVICE) return true
    if (!as) return false
    if (table === 'sessions') return row.host_id === as || isMember(as, row.id)
    if (table === 'session_members') return isMember(as, row.session_id)
    // Spots, suggestions and approvals: every member reads them. A person's exact place: only that person.
    if (['session_spots', 'spot_suggestions', 'spot_approvals', 'slots'].includes(table)) return isMember(as, row.session_id)
    if (table === 'session_member_places') return row.user_id === as
    if (table === 'invites') {
      if (isHost(as, row.session_id) || row.invitee_id === as) return true
      const pending = row.invitee_id != null && !row.revoked && row.declined_at == null && row.uses === 0 && Date.parse(row.expires_at) > now()
      return pending && isMember(as, row.session_id)
    }
    return false
  }

  // How to call: keyOf('session_members', row) -> { session_id, user_id }
  const keyOf = (table, row) => Object.fromEntries(PRIMARY_KEY[table].map((c) => [c, row[c]]))

  // Tell the subscribers. Delivery is a moment later, as a network is, and never inside the write that caused it.
  // How to call: publish('sessions', 'UPDATE', newRow)
  function publish(table, eventType, row) {
    // Inside a statement the events wait for it to succeed: a statement that fails leaves nothing and tells nobody.
    if (queue) {
      queue.push([table, eventType, structuredClone(row)])
      return
    }
    // A table that is not in the publication raises no live event at all.
    if (!PUBLISHED.has(table)) return
    for (const sub of [...subscribers]) {
      if (sub.table !== table || (sub.event !== '*' && sub.event !== eventType)) continue
      if (!sub.as) continue
      let payload
      if (eventType === 'DELETE') {
        if (sub.filter) continue
        payload = { eventType, schema: 'public', table, new: {}, old: keyOf(table, row), errors: null }
      } else {
        if (!self.canSee(sub.as, table, row) || !matches(row, sub.filter)) continue
        payload = { eventType, schema: 'public', table, new: structuredClone(row), old: keyOf(table, row), errors: null }
      }
      setTimeout(() => sub.cb(payload), 0)
    }
  }

  // A Realtime filter such as "invitee_id=eq.abc". Only the "eq" form the app uses.
  // How to call: matches(row, 'session_id=eq.abc') -> true
  function matches(row, filter) {
    if (!filter) return true
    const m = /^([a-z_]+)=eq\.(.*)$/.exec(filter)
    return !!m && String(row[m[1]]) === m[2]
  }

  // Listen to changes. `spec`: { as, table, event: '*' | 'INSERT' | 'UPDATE' | 'DELETE', filter? }. Returns the way to stop.
  // How to call: const stop = db.subscribe({ as: uid, table: 'sessions', event: '*' }, (payload) => ...)
  function subscribe(spec, cb) {
    const sub = { as: spec.as ?? null, table: spec.table, event: spec.event || '*', filter: spec.filter || '', cb }
    subscribers.add(sub)
    return () => subscribers.delete(sub)
  }

  // ── Writes, with the rules of the schema ────────────────────────────────

  // The check constraints and foreign keys of `sessions`. Throws a DbError; returns when the row is fine.
  // How to call: checkSession(row)
  function checkSession(row) {
    if (!profiles[row.host_id]) throw new DbError('23503', 'insert or update on table "sessions" violates foreign key constraint "sessions_host_id_fkey"')
    if (typeof row.title !== 'string' || row.title.trim().length < 1 || row.title.trim().length > 80) {
      throw new DbError('23514', 'new row for relation "sessions" violates check constraint "sessions_title_check"')
    }
    if (!['inviting', 'locating', 'voting', 'confirmed', 'completed', 'cancelled'].includes(row.status)) {
      throw new DbError('23514', 'new row for relation "sessions" violates check constraint "sessions_status_check"')
    }
    if (!(row.end_time > row.start_time)) throw new DbError('23514', 'new row for relation "sessions" violates check constraint "sessions_check"')
  }

  // guard_session_changes: for everyone but the server.
  // How to call: guardSession(old, next)
  function guardSession(old, next) {
    if (['completed', 'cancelled'].includes(old.status)) throw new DbError('42501', `A ${old.status} session cannot be changed.`, { status: 403 })
    if (next.status !== old.status) {
      if (next.status === 'locating' && old.status === 'inviting') {
        const joined = tables.session_members.filter((m) => m.session_id === old.id && m.state === 'joined').length
        if (joined < 2) throw new DbError('42501', 'A session needs at least two people before it can start.', { status: 403 })
      } else if (next.status !== 'cancelled') {
        throw new DbError('42501', `A session cannot go from ${old.status} to ${next.status} directly.`, { status: 403 })
      }
    }
    if (old.status !== 'inviting' && (next.date !== old.date || next.start_time !== old.start_time || next.end_time !== old.end_time)) {
      throw new DbError('42501', 'The date and times can only change before the session starts.', { status: 403 })
    }
  }

  // How to call: insertSession(uid, { host_id, title, date, start_time, end_time })
  function insertSession(as, values) {
    const row = {
      id: newId(),
      host_id: values.host_id,
      title: values.title,
      date: dateText(values.date),
      start_time: timeText(values.start_time),
      end_time: timeText(values.end_time),
      status: 'inviting',
      radius_meters: null,
      meeting_area_id: null,
      meeting_method: null,
      meeting_max_minutes: null,
      meeting_total_minutes: null,
      meeting_count: null,
      meeting_approximate: null,
      meeting_computed_at: null,
      banner: null,
      plan_version: 0,
      created_at: iso(now()),
      updated_at: iso(now()),
    }
    if (as !== SERVICE && row.host_id !== as) throw rlsRefused('sessions')
    checkSession(row)
    tables.sessions.push(row)
    publish('sessions', 'INSERT', row)
    // The trigger add_host_membership: the host is a joined member from the start.
    const member = { session_id: row.id, user_id: row.host_id, role: 'host', state: 'joined', start_area_id: null, end_area_id: null, categories: [], stay_until: null, travel_minutes: null, joined_at: iso(now()), updated_at: iso(now()) }
    tables.session_members.push(member)
    publish('session_members', 'INSERT', member)
    return row
  }

  // How to call: insertInvite(uid, { session_id, created_by, invitee_id })
  function insertInvite(as, values) {
    const created = now()
    const row = {
      token: newToken(),
      session_id: values.session_id,
      created_by: values.created_by,
      expires_at: values.expires_at ?? iso(created + 7 * DAY_MS),
      revoked: false,
      uses: 0,
      created_at: iso(created),
      invitee_id: values.invitee_id ?? null,
      declined_at: null,
    }
    // The BEFORE trigger check_invite_insert runs first, whoever inserts, so a person who may not insert at all is told the
    // trigger's sentence when the session is missing or closed. Then the row-level "with check", then the constraints.
    const s = sessionOf(row.session_id)
    if (!s || !OPEN.includes(s.status)) throw new DbError('42501', 'Invitations can only be made while a session is open.', { status: 403 })
    if (row.invitee_id !== null) {
      if (row.invitee_id === s.host_id) throw new DbError('42501', 'The host is already in the session.', { status: 403 })
      if (isMember(row.invitee_id, row.session_id)) throw new DbError('42501', 'That person is already in the session.', { status: 403 })
      const open = tables.invites.filter((i) => i.session_id === row.session_id && i.invitee_id !== null && !i.revoked && i.declined_at == null && i.uses === 0 && Date.parse(i.expires_at) > created)
      if (open.length >= MAX_JOINED) throw new DbError('42501', 'A session can have at most 30 open invitations.', { status: 403 })
    }
    if (as !== SERVICE && !(row.created_by === as && isHost(as, row.session_id))) throw rlsRefused('invites')
    if (!profiles[row.created_by]) throw new DbError('23503', 'insert or update on table "invites" violates foreign key constraint "invites_created_by_fkey"')
    if (row.invitee_id !== null && !profiles[row.invitee_id]) throw new DbError('23503', 'insert or update on table "invites" violates foreign key constraint "invites_invitee_id_fkey"')
    if (Number.isNaN(Date.parse(row.expires_at))) throw new DbError('22007', `invalid input syntax for type timestamp with time zone: "${row.expires_at}"`)
    if (Date.parse(row.expires_at) > created + 30 * DAY_MS) throw new DbError('23514', 'new row for relation "invites" violates check constraint "invites_expiry_limit"')
    if (row.invitee_id === null && tables.invites.some((i) => i.session_id === row.session_id && i.invitee_id === null && !i.revoked)) {
      throw new DbError('23505', 'duplicate key value violates unique constraint "invites_one_live_link_idx"', { status: 409 })
    }
    if (row.invitee_id !== null && tables.invites.some((i) => i.session_id === row.session_id && i.invitee_id === row.invitee_id)) {
      throw new DbError('23505', 'duplicate key value violates unique constraint "invites_one_per_invitee_idx"', { status: 409 })
    }
    tables.invites.push(row)
    publish('invites', 'INSERT', row)
    return row
  }

  // ── The request interface ───────────────────────────────────────────────

  // The columns asked for, or all of them. An unknown column is the error PostgREST gives.
  // How to call: project(row, 'id, title', 'sessions') -> { id, title }
  function project(row, columns, table) {
    const text = String(columns || '*').trim()
    if (text === '*') return structuredClone(row)
    const names = text.split(',').map((c) => c.trim()).filter(Boolean)
    const unknown = names.find((c) => !(c in row))
    if (unknown) throw new DbError('42703', `column ${table}.${unknown} does not exist`)
    return Object.fromEntries(names.map((c) => [c, structuredClone(row[c])]))
  }

  // The rows a request's filters keep. Filters: eq, neq, in, is (null).
  // How to call: filterRows(rows, [{ col: 'id', op: 'eq', value: 's1' }])
  function filterRows(rows, filters = []) {
    return rows.filter((row) =>
      filters.every(({ col, op, value }) => {
        if (op === 'eq') return String(row[col]) === String(value)
        if (op === 'neq') return String(row[col]) !== String(value)
        if (op === 'in') return value.map(String).includes(String(row[col]))
        if (op === 'is') return value === null ? row[col] == null : row[col] === value
        throw new Error(`The stand-in does not know the filter "${op}".`)
      }),
    )
  }

  // How to call: shape(op, rows) -> { data, error: null }, honouring single() and maybeSingle()
  function shape(op, rows, table) {
    const list = rows.map((r) => project(r, op.columns, table))
    if (op.single === 'single') {
      return list.length === 1 ? { data: list[0], error: null, status: 200 } : { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${list.length} rows`, hint: null }, status: 406 }
    }
    if (op.single === 'maybeSingle') {
      if (list.length > 1) return { data: null, error: { code: 'PGRST116', message: 'JSON object requested, multiple (or no) rows returned', details: `The result contains ${list.length} rows`, hint: null }, status: 406 }
      return { data: list[0] ?? null, error: null, status: 200 }
    }
    return { data: list, error: null, status: 200 }
  }

  // A read: only the rows the caller may see, filtered, ordered and cut to the columns asked for.
  // How to call: select({ as: uid, table: 'sessions', columns: 'id', filters: [], order: [], limit: null, single: null })
  function select(op) {
    const { as, table } = op
    // The accounts' public profiles are only read (the server looks up names to write a notice): never written here.
    if (table !== 'profiles' && !PRIMARY_KEY[table]) throw new DbError('42P01', `relation "public.${table}" does not exist`, { status: 404 })
    if (!as) throw denied(table)
    checkFilters(table, op.filters)
    const readable = table === 'profiles' ? Object.entries(profiles).map(([id, row]) => ({ id, ...row })) : tables[table].filter((r) => self.canSee(as, table, r))
    let rows = filterRows(readable, op.filters)
    for (const { col, ascending = true } of [...(op.order || [])].reverse()) {
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1))
    }
    if (op.limit != null) rows = rows.slice(0, op.limit)
    return shape(op, rows, table)
  }

  // The columns of a member's exact place that the schema checks: labels up to 120 characters, coordinates inside Singapore, and a
  // latitude always with its longitude.
  // How to call: checkPlace({ start_label: 'Home', start_lat: null, start_lng: null })
  function checkPlace(row) {
    for (const column of ['start_label', 'end_label']) {
      if (row[column] != null && String(row[column]).length > 120) throw new DbError('23514', `new row for relation "session_member_places" violates check constraint "session_member_places_${column}_check"`)
    }
    for (const [lat, lng] of [['start_lat', 'start_lng'], ['end_lat', 'end_lng']]) {
      if ((row[lat] == null) !== (row[lng] == null)) throw new DbError('23514', 'new row for relation "session_member_places" violates check constraint "session_member_places_check"')
      if (row[lat] != null && !(row[lat] >= 1.1 && row[lat] <= 1.5 && row[lng] >= 103.5 && row[lng] <= 104.1)) throw new DbError('23514', 'new row for relation "session_member_places" violates check constraint "session_member_places_lat_check"')
    }
  }

  // The server's own rows: the list of spots, and what each member suggested. Checks the shape the schema checks.
  // How to call: checkSpotRow('session_spots', { session_id, area_id: 'bugis', worst_minutes: 20, mean_minutes: 15, travel_minutes: {} })
  function checkSpotRow(table, row) {
    if (!sessionOf(row.session_id)) throw new DbError('23503', `insert or update on table "${table}" violates foreign key constraint "${table}_session_id_fkey"`)
    if (typeof row.area_id !== 'string' || row.area_id.length < 1 || row.area_id.length > 60) throw new DbError('23514', `new row for relation "${table}" violates check constraint "${table}_area_id_check"`)
    if (table === 'spot_suggestions' && !isMember(row.user_id, row.session_id)) throw new DbError('23503', 'insert or update on table "spot_suggestions" violates foreign key constraint "spot_suggestions_session_id_user_id_fkey"')
    if (table === 'session_spots') {
      const ok = (n) => typeof n === 'number' && n >= 0 && n <= 1440
      if (!ok(row.worst_minutes) || !ok(row.mean_minutes) || row.mean_minutes > row.worst_minutes + 0.001) throw new DbError('23514', 'new row for relation "session_spots" violates check constraint "session_spots_check"')
      if (row.rank != null && !(row.rank >= 1 && row.rank <= 3)) throw new DbError('23514', 'new row for relation "session_spots" violates check constraint "session_spots_rank_check"')
      for (const [id, minutes] of Object.entries(row.travel_minutes || {})) {
        if (!UUID_TEXT.test(id) || !(minutes >= 0 && minutes <= 1440)) throw new DbError('23514', 'new row for relation "session_spots" violates check constraint "session_spots_travel_minutes_check"')
      }
    }
  }

  // Delete rows and what hangs on them by "on delete cascade", telling the subscribers of each. A member's row takes their
  // exact place, suggestion and approvals; a spot takes its approvals; a session takes everything.
  // How to call: cascade('session_members', [row])
  function cascade(table, rows) {
    for (const row of rows) {
      const at = tables[table].indexOf(row)
      if (at === -1) continue
      tables[table].splice(at, 1)
      publish(table, 'DELETE', row)
      const children = []
      if (table === 'sessions') {
        for (const child of ['session_members', 'invites', 'session_member_places', 'session_spots', 'spot_suggestions', 'spot_approvals', 'slots']) children.push([child, tables[child].filter((r) => r.session_id === row.id)])
      } else if (table === 'session_members') {
        for (const child of ['session_member_places', 'spot_suggestions', 'spot_approvals']) children.push([child, tables[child].filter((r) => r.session_id === row.session_id && r.user_id === row.user_id)])
      } else if (table === 'session_spots') {
        children.push(['spot_approvals', tables.spot_approvals.filter((r) => r.session_id === row.session_id && r.area_id === row.area_id)])
      }
      for (const [child, list] of children) cascade(child, list)
    }
  }

  // A write of new rows, after the column grants, the row-level rules, the triggers and the constraints.
  // How to call: insert({ as: uid, table: 'invites', values: { session_id, created_by }, returning: true, columns: 'token' })
  function insert(op) {
    const { as, table } = op
    if (!PRIMARY_KEY[table]) throw new DbError('42P01', `relation "public.${table}" does not exist`, { status: 404 })
    if (!as) throw denied(table)
    const list = Array.isArray(op.values) ? op.values : [op.values]
    if (as !== SERVICE) {
      if (!GRANTS[table].insert.length) throw denied(table)
      for (const v of list) if (Object.keys(v).some((c) => !GRANTS[table].insert.includes(c))) throw denied(table)
    }
    for (const v of list) for (const [c, value] of Object.entries(v)) checkUuid(table, c, value)
    const made = list.map((v) => {
      if (table === 'sessions') return insertSession(as, v)
      if (table === 'invites') return insertInvite(as, v)
      if (table === 'session_member_places') return insertPlace(as, v)
      if (table === 'spot_approvals') return insertApproval(as, v)
      if (['session_spots', 'spot_suggestions'].includes(table)) return insertSpotRow(table, v)
      throw new Error('The stand-in lets only the server insert into session_members (the trigger and join_session do it).')
    })
    if (!op.returning) return { data: null, error: null, status: 201 }
    // RETURNING applies the select policy to the new rows: one the person may not read fails the whole statement.
    if (made.some((r) => !self.canSee(as, table, r))) throw rlsRefused(table)
    return shape(op, made, table)
  }

  // A member keeps their own exact place, while joined and the session is open.
  // How to call: insertPlace(uid, { session_id, user_id, start_label: 'Home' })
  function insertPlace(as, values) {
    if (as !== SERVICE && !(values.user_id === as && inOpen(as, values.session_id))) throw rlsRefused('session_member_places')
    if (!isMember(values.user_id, values.session_id)) throw new DbError('23503', 'insert or update on table "session_member_places" violates foreign key constraint "session_member_places_session_id_user_id_fkey"')
    const row = { session_id: values.session_id, user_id: values.user_id, start_label: null, start_lat: null, start_lng: null, end_label: null, end_lat: null, end_lng: null, updated_at: iso(now()), ...Object.fromEntries(PLACE_COLUMNS.filter((c) => c in values).map((c) => [c, values[c]])) }
    checkPlace(row)
    if (tables.session_member_places.some((r) => r.session_id === row.session_id && r.user_id === row.user_id)) throw new DbError('23505', 'duplicate key value violates unique constraint "session_member_places_pkey"', { status: 409 })
    tables.session_member_places.push(row)
    return row
  }

  // "Works for me": the member's own, while joined and the session is locating. The key to the spot list means only a listed
  // spot can be approved.
  // How to call: insertApproval(uid, { session_id, area_id: 'bugis', user_id: uid })
  function insertApproval(as, values) {
    if (as !== SERVICE && !(values.user_id === as && inLocating(as, values.session_id))) throw rlsRefused('spot_approvals')
    if (!tables.session_spots.some((r) => r.session_id === values.session_id && r.area_id === values.area_id)) throw new DbError('23503', 'insert or update on table "spot_approvals" violates foreign key constraint "spot_approvals_session_id_area_id_fkey"', { status: 409 })
    if (!isMember(values.user_id, values.session_id)) throw new DbError('23503', 'insert or update on table "spot_approvals" violates foreign key constraint "spot_approvals_session_id_user_id_fkey"', { status: 409 })
    if (tables.spot_approvals.some((r) => r.session_id === values.session_id && r.area_id === values.area_id && r.user_id === values.user_id)) throw new DbError('23505', 'duplicate key value violates unique constraint "spot_approvals_pkey"', { status: 409 })
    const row = { session_id: values.session_id, area_id: values.area_id, user_id: values.user_id, created_at: iso(now()) }
    tables.spot_approvals.push(row)
    publish('spot_approvals', 'INSERT', row)
    return row
  }

  // The server writes the spot list and the suggestions (the service key only; the grants above keep the browser out).
  // How to call: insertSpotRow('session_spots', { session_id, area_id: 'bugis', rank: 1, worst_minutes: 20, mean_minutes: 15, travel_minutes: {} })
  function insertSpotRow(table, values) {
    const row = table === 'session_spots'
      ? { rank: null, travel_minutes: {}, approximate: false, computed_at: iso(now()), ...structuredClone(values) }
      : { here: false, created_at: iso(now()), ...structuredClone(values) }
    checkSpotRow(table, row)
    if (tables[table].some((r) => PRIMARY_KEY[table].every((c) => r[c] === row[c]))) throw new DbError('23505', `duplicate key value violates unique constraint "${table}_pkey"`, { status: 409 })
    if (table === 'session_spots' && row.rank != null && tables.session_spots.some((r) => r.session_id === row.session_id && r.rank === row.rank)) throw new DbError('23505', 'duplicate key value violates unique constraint "session_spots_session_id_rank_key"', { status: 409 })
    tables[table].push(row)
    return row
  }

  // The row-level "using" rule of an update: which rows this identity may change. A host changes their session and its invites;
  // a member changes their own row (and their own exact place) while they are joined and the session is open.
  // How to call: mayChange(uid, 'session_members', row) -> true
  function mayChange(as, table, row) {
    if (as === SERVICE) return true
    if (table === 'sessions') return row.host_id === as
    if (table === 'invites') return isHost(as, row.session_id)
    if (table === 'session_members' || table === 'session_member_places') return row.user_id === as && inOpen(as, row.session_id)
    return false
  }

  // A change to existing rows the caller may change, after the column grants, the rules and the triggers.
  // How to call: update({ as: uid, table: 'sessions', values: { title: 'New' }, filters: [{ col: 'id', op: 'eq', value }], returning: false })
  function update(op) {
    const { as, table } = op
    if (!PRIMARY_KEY[table]) throw new DbError('42P01', `relation "public.${table}" does not exist`, { status: 404 })
    if (!as) throw denied(table)
    checkFilters(table, op.filters)
    const patch = op.values || {}
    if (as !== SERVICE && Object.keys(patch).some((c) => !GRANTS[table].update.includes(c))) throw denied(table)
    const targets = filterRows(tables[table].filter((r) => self.canSee(as, table, r) && mayChange(as, table, r)), op.filters)
    const done = targets.map((old) => {
      const next = { ...old, ...structuredClone(patch) }
      if (table === 'sessions') {
        if ('date' in patch) next.date = dateText(patch.date)
        if ('start_time' in patch) next.start_time = timeText(patch.start_time)
        if ('end_time' in patch) next.end_time = timeText(patch.end_time)
        checkSession(next)
        if (as !== SERVICE) guardSession(old, next)
        next.updated_at = iso(now())
      } else if (table === 'invites') {
        // The "with check": a host's update must leave the invite revoked, so a revoke cannot be undone.
        if (as !== SERVICE && next.revoked !== true) throw rlsRefused('invites')
      } else if (table === 'session_members') {
        for (const column of ['start_area_id', 'end_area_id']) {
          if (next[column] != null && (typeof next[column] !== 'string' || next[column].length < 1 || next[column].length > 60)) throw new DbError('23514', `new row for relation "session_members" violates check constraint "session_members_${column}_check"`)
        }
        next.updated_at = iso(now())
      } else if (table === 'session_member_places') {
        checkPlace(next)
        next.updated_at = iso(now())
      } else if (table === 'session_spots' || table === 'spot_suggestions') {
        checkSpotRow(table, next)
      }
      return { old, next }
    })
    for (const { old, next } of done) {
      Object.assign(old, next)
      publish(table, 'UPDATE', old)
    }
    if (!op.returning) return { data: null, error: null, status: 204 }
    // As for an insert: RETURNING a changed row the person may not read fails the statement.
    if (done.some(({ old }) => !self.canSee(as, table, old))) throw rlsRefused(table)
    return shape(op, done.map(({ old }) => old), table)
  }

  // A delete. A member may take back their own approval (while joined and the session is locating) and their own exact place
  // (at any time); everything else is the server's, and the rows that hang on a row go with it.
  // How to call: remove({ as: SERVICE, table: 'session_members', filters: [{ col: 'user_id', op: 'eq', value: uid }] })
  function remove(op) {
    const { as, table } = op
    if (!PRIMARY_KEY[table]) throw new DbError('42P01', `relation "public.${table}" does not exist`, { status: 404 })
    if (!as) throw denied(table)
    if (as !== SERVICE && !GRANTS[table]?.delete) throw denied(table)
    checkFilters(table, op.filters)
    let candidates = tables[table]
    if (as !== SERVICE) {
      // The policies: only the person's own row, and an approval only while the session is locating.
      candidates = candidates.filter((r) => self.canSee(as, table, r) && r.user_id === as && (table !== 'spot_approvals' || inLocating(as, r.session_id)))
    }
    const targets = filterRows(candidates, op.filters)
    cascade(table, targets)
    if (!op.returning) return { data: null, error: null, status: 204 }
    return shape(op, targets, table)
  }

  // ── apply_session_plan ──────────────────────────────────────────────────

  // Are two JSON values the same value? Objects by their keys in any order, numbers by value, as jsonb compares them.
  // How to call: sameJson({ a: 1, b: 2 }, { b: 2, a: 1 }) -> true
  function sameJson(a, b) {
    if (a === null || b === null || typeof a !== 'object' || typeof b !== 'object') return a === b
    if (Array.isArray(a) !== Array.isArray(b)) return false
    const keys = Object.keys(a)
    if (keys.length !== Object.keys(b).length) return false
    return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && sameJson(a[k], b[k]))
  }

  // A rule of the function: P0001 with a hint, which the server reads to refuse in its own words.
  // How to call: throw ruleBroken('area_pinned', 'The meeting area was chosen and cannot be changed by a recompute.')
  const ruleBroken = (hint, message) => new DbError('P0001', message, { hint })

  // The body of apply_session_plan. Returns the version, or null when the session moved on. Follows the SQL step by step; the
  // comments name its rules.
  // How to call: applySessionPlan({ sid, expected_version: 4, expected_status: 'locating', patch: { ops: [], spots: [] } })
  function applySessionPlan({ sid, expected_version: expectedVersion, expected_status: expectedStatus, patch }) {
    if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw new DbError('22023', 'The plan must be a JSON object.')
    const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
    const sp = patch.session ?? {}
    const meeting = sp.meeting
    const s = sessionOf(sid)
    if (!s || Number(s.plan_version) !== Number(expectedVersion) || s.status !== expectedStatus) return null

    // When the server loaded the members the spots are worked out from (before the planner ran), else now.
    let stamp = now()
    if (patch.loaded_at != null && patch.loaded_at !== '') {
      stamp = Date.parse(patch.loaded_at)
      if (Number.isNaN(stamp)) throw new DbError('22007', `invalid input syntax for type timestamp with time zone: "${patch.loaded_at}"`)
    }
    // Never later than the database's clock, as least(loaded_at, now()) in the SQL.
    stamp = Math.min(stamp, now())

    // Rule 4: a pinned meeting area stays.
    if (has(sp, 'meeting') && ['voted', 'chosen'].includes(s.meeting_method) && ((meeting?.area_id ?? null) !== s.meeting_area_id || (meeting?.method ?? null) !== s.meeting_method)) {
      throw ruleBroken('area_pinned', 'The meeting area was chosen and cannot be changed by a recompute.')
    }
    // Rule 1: the only move is inviting or locating to voting, with an area. (The two-people check comes after the ops.)
    let changed = false
    const newStatus = sp.status ?? s.status
    if (newStatus !== s.status) {
      if (!(['inviting', 'locating'].includes(s.status) && newStatus === 'voting') || !meeting?.area_id) {
        throw ruleBroken('status_transition', `A session cannot go from ${s.status} to ${newStatus} this way.`)
      }
      changed = true
    }
    // Rule 5: a pin only with a confirm. 'voted' or 'chosen' needs the move to voting in this patch, or the same pin (method and
    // area) already stored.
    if (['voted', 'chosen'].includes(meeting?.method) && newStatus === s.status && !(s.meeting_method === meeting.method && s.meeting_area_id === (meeting.area_id ?? null))) {
      throw ruleBroken('pin_without_confirm', 'A meeting area is pinned only when the host confirms it.')
    }

    // Deletes the rows of one table of this session that the test picks, with what hangs on them. True if any went.
    // How to call: dropRows('spot_approvals', (a) => a.user_id === uid)
    const dropRows = (table, test) => {
      const gone = tables[table].filter((r) => r.session_id === sid && test(r))
      cascade(table, gone)
      return gone.length > 0
    }
    // The member row's change, with the trigger that keeps updated_at current.
    // How to call: changeMember(row, { state: 'opted_out' })
    const changeMember = (row, values) => {
      Object.assign(row, values, { updated_at: iso(now()) })
      publish('session_members', 'UPDATE', row)
    }

    // Members, suggestions and approvals, in the order given.
    for (const op of patch.ops ?? []) {
      const user = op.user_id
      const member = tables.session_members.find((m) => m.session_id === sid && m.user_id === user)
      // Rule 6: the host stays.
      if (['opt_out', 'remove_member'].includes(op.op) && user === s.host_id) {
        throw ruleBroken('host_member', op.op === 'opt_out' ? 'The host cannot opt out.' : 'The host cannot be removed.')
      }
      if (op.op === 'opt_out') {
        if (member?.state === 'joined') {
          changeMember(member, { state: 'opted_out' })
          changed = true
        }
        changed = dropRows('spot_approvals', (a) => a.user_id === user) || changed
        changed = dropRows('spot_suggestions', (g) => g.user_id === user) || changed
      } else if (op.op === 'rejoin') {
        if (member?.state === 'opted_out') {
          changeMember(member, { state: 'joined' })
          changed = true
        }
      } else if (op.op === 'remove_member') {
        if (member) {
          cascade('session_members', [member])
          changed = true
        }
      } else if (op.op === 'suggest') {
        // One suggestion per member. Suggesting the same again changes nothing; a different one counts as newest.
        const here = op.here ?? false
        const existing = tables.spot_suggestions.find((g) => g.session_id === sid && g.user_id === user)
        if (!existing) {
          insertSpotRow('spot_suggestions', { session_id: sid, user_id: user, area_id: op.area_id, here })
          changed = true
        } else if (existing.area_id !== op.area_id || existing.here !== here) {
          const next = { ...existing, area_id: op.area_id, here, created_at: iso(now()) }
          checkSpotRow('spot_suggestions', next)
          Object.assign(existing, next)
          changed = true
        }
      } else if (op.op === 'unsuggest') {
        changed = dropRows('spot_suggestions', (g) => g.user_id === user) || changed
      } else if (op.op === 'clear_approvals') {
        changed = dropRows('spot_approvals', () => true) || changed
      } else if (op.op === 'clear_suggestions') {
        changed = dropRows('spot_suggestions', () => true) || changed
      } else {
        throw new DbError('22023', `Unknown operation ${op.op}.`)
      }
    }

    // Rule 2: leaving inviting needs two joined members, counted after the ops.
    if (s.status === 'inviting' && newStatus !== s.status && tables.session_members.filter((m) => m.session_id === sid && m.state === 'joined').length < 2) {
      throw ruleBroken('needs_two_people', 'A session needs at least two people before it can start.')
    }

    // The spots, as a difference: listed areas are inserted or updated, unlisted ones deleted with their approvals.
    let bannerText = null
    if (has(patch, 'spots')) {
      if (!Array.isArray(patch.spots)) throw new DbError('22023', 'The spots must be a JSON list.')
      const listed = new Set(patch.spots.map((r) => r.area_id))
      const lostApprovals = tables.spot_approvals.some((a) => a.session_id === sid && !listed.has(a.area_id))
      if (dropRows('session_spots', (x) => !listed.has(x.area_id))) changed = true
      for (const row of patch.spots) {
        const next = {
          session_id: sid,
          area_id: row.area_id,
          rank: row.rank ?? null,
          worst_minutes: Number(row.worst_minutes),
          mean_minutes: Number(row.mean_minutes),
          travel_minutes: structuredClone(row.travel_minutes ?? {}),
          approximate: row.approximate ?? false,
        }
        checkSpotRow('session_spots', next)
        const existing = tables.session_spots.find((x) => x.session_id === sid && x.area_id === row.area_id)
        if (!existing) {
          tables.session_spots.push({ ...next, computed_at: iso(stamp) })
          changed = true
        } else if (['rank', 'worst_minutes', 'mean_minutes', 'approximate'].some((k) => existing[k] !== next[k]) || !sameJson(existing.travel_minutes, next.travel_minutes)) {
          // A listed spot is written only if something about it changed, so its time of working out is left alone otherwise. When
          // it is written, its time of working out is when the inputs were loaded (stamp), not when the write happens.
          Object.assign(existing, next, { computed_at: iso(stamp) })
          changed = true
        }
      }
      // The ranks are unique in a session, checked at the end (so two spots can swap ranks in one call).
      const ranks = tables.session_spots.filter((x) => x.session_id === sid && x.rank != null).map((x) => x.rank)
      if (new Set(ranks).size !== ranks.length) throw new DbError('23505', 'duplicate key value violates unique constraint "session_spots_session_id_rank_key"', { status: 409 })
      // A run that worked the spots out again brings the time of working out of the older spots forward to when the inputs were
      // loaded, which is not a change.
      if (patch.recomputed === true) for (const x of tables.session_spots.filter((r) => r.session_id === sid && Date.parse(r.computed_at) < stamp)) x.computed_at = iso(stamp)
      // The group is told only when the deletion removed an approval.
      if (lostApprovals) bannerText = patch.banner_text || 'Some spots are no longer on the list, so approvals for them were removed.'
    }

    // Rule 3: the session section is a change only where a value differs from the stored row. The meeting is compared as it would be
    // written, after rounding; the banner as stored. Repeating the same pinned meeting or banner changes nothing.
    const rounded = (value) => (value == null ? null : Math.round(Number(value)))
    const meetingChanged = has(sp, 'meeting') && [
      [s.meeting_area_id, meeting?.area_id ?? null],
      [s.meeting_method, meeting?.method ?? null],
      [s.meeting_max_minutes, meeting ? rounded(meeting.max_minutes) : null],
      [s.meeting_total_minutes, meeting ? rounded(meeting.total_minutes) : null],
      [s.meeting_count, meeting ? rounded(meeting.count) : null],
      [s.meeting_approximate, meeting?.approximate ?? null],
    ].some(([stored, written]) => (stored ?? null) !== written)
    const bannerChanged = has(sp, 'banner') && !sameJson(s.banner ?? null, sp.banner ?? null)
    if (meetingChanged || bannerChanged || bannerText !== null) changed = true
    if (!changed) return Number(s.plan_version)

    // Each joined member's own minutes to the confirmed area.
    if (has(sp, 'meeting') && meeting && typeof meeting === 'object' && meeting.travel) {
      for (const m of tables.session_members.filter((row) => row.session_id === sid && row.state === 'joined')) {
        changeMember(m, { travel_minutes: has(meeting.travel, m.user_id) ? Math.round(meeting.travel[m.user_id]) : null })
      }
    }
    s.status = newStatus
    if (meetingChanged) {
      s.meeting_area_id = meeting?.area_id ?? null
      s.meeting_method = meeting?.method ?? null
      s.meeting_max_minutes = meeting ? rounded(meeting.max_minutes) : null
      s.meeting_total_minutes = meeting ? rounded(meeting.total_minutes) : null
      s.meeting_count = meeting ? rounded(meeting.count) : null
      s.meeting_approximate = meeting?.approximate ?? null
      s.meeting_computed_at = meeting?.area_id ? iso(now()) : null
    }
    // The banner the function writes when approvals went: { text, at, approvalsRemoved: true }, `at` in milliseconds.
    if (bannerText !== null) s.banner = { text: bannerText, at: now(), approvalsRemoved: true }
    else if (bannerChanged) s.banner = sp.banner ?? null
    s.plan_version = Number(s.plan_version) + 1
    s.updated_at = iso(now())
    publish('sessions', 'UPDATE', s)
    return s.plan_version
  }

  // ── Functions the app calls ─────────────────────────────────────────────

  // How to call: usableInvite('<token>', uid) -> the invite and its session when the link is good for this caller, else null
  function usableInvite(token, uid) {
    const invite = tables.invites.find((i) => i.token === token)
    if (!invite || invite.revoked || Date.parse(invite.expires_at) <= now() || invite.declined_at != null) return null
    if (invite.invitee_id !== null && !(invite.invitee_id === uid && invite.uses === 0)) return null
    const session = sessionOf(invite.session_id)
    return session && OPEN.includes(session.status) ? { invite, session } : null
  }

  // The host's name as the preview shows it. How to call: hostName(uid) -> 'Sam'
  const hostName = (id) => profiles[id]?.display_name || profiles[id]?.username || null

  const functions = {
    // What an invite link leads to. Callable when signed out. No row for a link that is not good.
    invite_preview({ as, args }) {
      const found = usableInvite(args.invite_token, as && as !== SERVICE ? as : null)
      if (!found) return []
      const s = found.session
      return [{ title: s.title, date: s.date, start_time: s.start_time, end_time: s.end_time, host_name: hostName(s.host_id) }]
    },
    // Join with a link or a personal invitation. Returns the session id.
    join_session({ as, args }) {
      if (!as || as === SERVICE) throw new DbError('28000', 'Sign in to join a session.', { status: 401 })
      const found = usableInvite(args.invite_token, as)
      if (!found) throw new DbError('P0002', 'This invite link is no longer valid.', { status: 400 })
      const target = found.session.id
      if (isMember(as, target)) return target
      if (tables.session_members.filter((m) => m.session_id === target && m.state === 'joined').length >= MAX_JOINED) {
        throw new DbError('P0001', 'This session is full.', { hint: 'session_full' })
      }
      const member = { session_id: target, user_id: as, role: 'guest', state: 'joined', start_area_id: null, end_area_id: null, categories: [], stay_until: null, travel_minutes: null, joined_at: iso(now()), updated_at: iso(now()) }
      tables.session_members.push(member)
      publish('session_members', 'INSERT', member)
      found.invite.uses += 1
      publish('invites', 'UPDATE', found.invite)
      return target
    },
    // The open invitations addressed to the caller, newest first.
    my_invitations({ as }) {
      if (!as || as === SERVICE) return []
      return tables.invites
        .filter((i) => i.invitee_id === as && !i.revoked && i.declined_at == null && i.uses === 0 && Date.parse(i.expires_at) > now())
        .map((i) => ({ i, s: sessionOf(i.session_id) }))
        .filter(({ i, s }) => s && OPEN.includes(s.status) && !isMember(as, s.id) && i.invitee_id === as)
        .sort((a, b) => (a.i.created_at < b.i.created_at ? 1 : -1))
        .map(({ i, s }) => ({ token: i.token, title: s.title, date: s.date, start_time: s.start_time, end_time: s.end_time, host_name: hostName(s.host_id), invited_at: i.created_at }))
    },
    // The one function the server writes a session's plan through (db/migrations/20261020000000_jio_apply_session_plan.sql): the
    // service key only. Answers null when the session's version or status is not what the server loaded (nothing is written), the
    // version after the write otherwise, and a P0001 error with a hint for a rule (area_pinned, needs_two_people, status_transition).
    // The caller's whole statement is undone if any step fails, as run() does for every write. This is a JavaScript port of the
    // SQL, and of applySessionPlan in backend/tests/helpers/fake-supabase.js; the two are separate copies because the backend's
    // twin keeps its tables as plain arrays and has no cascade or Realtime, and this one has both.
    apply_session_plan({ as, args }) {
      if (as !== SERVICE) throw denied('apply_session_plan')
      return applySessionPlan(args)
    },
    // The invitee says no.
    decline_invite({ as, args }) {
      if (!as || as === SERVICE) throw new DbError('28000', 'Sign in to answer an invitation.', { status: 401 })
      const invite = tables.invites.find((i) => i.token === args.invite_token && i.invitee_id === as && !i.revoked && i.uses === 0)
      if (!invite) throw new DbError('P0002', 'This invitation is no longer valid.', { status: 400 })
      invite.declined_at ??= iso(now())
      publish('invites', 'UPDATE', invite)
      return null
    },
  }

  // How to call: rpc({ as, fn: 'join_session', args: { invite_token } })
  function rpc(op) {
    const fn = functions[op.fn]
    if (!fn) throw new DbError('PGRST202', `Could not find the function public.${op.fn} in the schema cache`, { status: 404 })
    // Only invite_preview is open to the public key (db/policies.sql).
    if (!op.as && op.fn !== 'invite_preview') throw denied(op.fn)
    const data = fn({ as: op.as, args: op.args || {} })
    return { data, error: null, status: 200 }
  }

  // Run one request. Always answers { data, error, status }; a rule broken is an error in the answer, as the client reports.
  // How to call: db.run({ as: uid, kind: 'select', table: 'sessions', columns: 'id, title', filters: [{ col: 'id', op: 'eq', value }], single: 'maybeSingle' })
  function run(op) {
    const writes = op.kind !== 'select'
    const saved = writes ? structuredClone(tables) : null
    queue = writes ? [] : null
    try {
      const kinds = { select, insert, update, delete: remove, rpc }
      if (!kinds[op.kind]) throw new Error(`The stand-in does not know the request kind "${op.kind}".`)
      const answer = kinds[op.kind](op)
      const events = queue
      queue = null
      for (const [table, eventType, row] of events || []) publish(table, eventType, row)
      return answer
    } catch (err) {
      queue = null
      // A statement that fails changes nothing, however far it got.
      if (saved) for (const name of Object.keys(tables)) tables[name].splice(0, tables[name].length, ...saved[name])
      if (!(err instanceof DbError)) throw err
      return { data: null, error: { message: err.message, code: err.code, details: null, hint: err.hint }, status: err.status }
    }
  }

  // The accounts' public profiles are shared too, so a second page (or a second user of a script's database) sees a new
  // person's name. The page's own stand-in keeps its copy in `profiles` and tells the database about each new one.
  // How to call: db.setProfile(uid, { username: 'kim', display_name: 'Kim', avatar_url: null })
  function setProfile(id, row) {
    if (profiles[id] !== row) profiles[id] = { ...row }
  }
  // How to call: db.getProfiles([uid]) -> { [uid]: { username, display_name, avatar_url } } for those that exist
  function getProfiles(ids) {
    return Object.fromEntries(ids.filter((id) => profiles[id]).map((id) => [id, { ...profiles[id] }]))
  }
  // How to call: db.usernameTaken('kim') -> true
  const usernameTaken = (name) => Object.values(profiles).some((p) => p.username === name)
  // How to call: db.profileByUsername('kim') -> { id, username, display_name, avatar_url }, or null
  function profileByUsername(name) {
    const found = Object.entries(profiles).find(([, p]) => p.username === name)
    return found ? { id: found[0], ...found[1] } : null
  }

  // The login tokens the stand-in has issued, by person, so a stand-in backend can tell who sent one.
  // How to call: db.setToken('token-3', uid); db.userForToken('token-3') -> uid
  const tokens = new Map()
  const setToken = (token, id) => void tokens.set(token, id)
  const userForToken = (token) => tokens.get(token) ?? null

  return Object.assign(self, { canSee, run, subscribe, setProfile, getProfiles, usernameTaken, profileByUsername, setToken, userForToken, tables, functionNames: Object.keys(functions) })
}

// ── A client's view of a database ─────────────────────────────────────────

// The query builder the browser client and the server share: `from(table).select(...).eq(...)`, `.insert(...)`,
// `.update(...)`, `.delete()`, `.rpc(...)`, and Realtime's `channel().on('postgres_changes', ...).subscribe()`. Each
// request is a plain object handed to `database.run`, which may be a Promise (a database held in another process).
// `as()` says who is acting at the time of each request (a user id, null or SERVICE). `leaveMs` is how long a channel takes
// to leave (the server's acknowledgement); realtime-js tears a channel down only after it.
// How to call: const data = createDataClient({ database: db, as: () => uid }); const { data: rows } = await data.from('sessions').select('id, title').eq('id', id)
export function createDataClient({ database, as, leaveMs = 30 }) {
  // The channels held, by topic (realtime-js's RealtimeClient.channels).
  const channels = new Map()

  // How to call: from('sessions').select('id')... (awaited like supabase-js's)
  function from(table) {
    const op = { as: null, kind: 'select', table, columns: '*', filters: [], order: [], limit: null, values: null, returning: false, single: null }
    const builder = {
      select(columns = '*') {
        // After an insert, update or delete this asks for the changed rows back; on its own it is a read.
        op.columns = columns
        if (op.kind !== 'select') op.returning = true
        return builder
      },
      insert(values) {
        op.kind = 'insert'
        op.values = values
        return builder
      },
      update(values) {
        op.kind = 'update'
        op.values = values
        return builder
      },
      delete() {
        op.kind = 'delete'
        return builder
      },
      eq: (col, value) => (op.filters.push({ col, op: 'eq', value }), builder),
      neq: (col, value) => (op.filters.push({ col, op: 'neq', value }), builder),
      in: (col, value) => (op.filters.push({ col, op: 'in', value: [...value] }), builder),
      is: (col, value) => (op.filters.push({ col, op: 'is', value }), builder),
      order: (col, { ascending = true } = {}) => (op.order.push({ col, ascending }), builder),
      limit: (n) => ((op.limit = n), builder),
      single: () => ((op.single = 'single'), builder),
      maybeSingle: () => ((op.single = 'maybeSingle'), builder),
      then(resolve, reject) {
        return Promise.resolve()
          .then(() => database.run({ ...structuredClone(op), as: as() }))
          .then(resolve, reject)
      },
    }
    return builder
  }

  // How to call: await rpc('join_session', { invite_token: token })
  async function rpc(fn, args = {}) {
    return database.run({ as: as(), kind: 'rpc', fn, args: structuredClone(args) })
  }

  // A channel as @supabase/realtime-js (2.117) has it, in the ways that matter to a caller:
  //   - `channel(topic)` returns the channel already held for that topic, even one that is still leaving, instead of a new one;
  //   - `on()` after `subscribe()` throws, and a binding identical to one already there is ignored;
  //   - `subscribe()` does nothing unless the channel is closed (so on a channel that is leaving it does nothing at all);
  //   - leaving is asynchronous: `unsubscribe()` resolves 'ok' a moment later, and only `removeChannel()` then tears the channel
  //     down and forgets its topic, after which a new `channel(topic)` is a new channel. Events keep reaching a leaving
  //     channel's callbacks until it has left.
  // How to call: const ch = channel('watch').on('postgres_changes', { event: '*', schema: 'public', table: 'sessions' }, (p) => ...).subscribe((status) => ...)
  function channel(name) {
    const topic = `realtime:${name}`
    const held = channels.get(topic)
    if (held) return held
    const listeners = []
    const stops = []
    const ch = {
      name,
      topic,
      // 'closed', 'joining', 'joined' or 'leaving'.
      state: 'closed',
      on(type, spec, cb) {
        if (type !== 'postgres_changes') throw new Error(`The stand-in carries only postgres_changes, not "${type}".`)
        if (ch.state === 'joined' || ch.state === 'joining') throw new Error(`cannot add \`${type}\` callbacks for ${topic} after \`subscribe()\`.`)
        const same = (a, b) => ['event', 'schema', 'table', 'filter'].every((k) => (a[k] || '') === (b[k] || ''))
        if (!listeners.some((l) => same(l.spec, spec))) listeners.push({ spec, cb })
        return ch
      },
      subscribe(onStatus) {
        if (ch.state !== 'closed') return ch
        ch.state = 'joining'
        // Connecting takes a moment; changes made before it is SUBSCRIBED are not delivered, as in Supabase.
        setTimeout(async () => {
          if (ch.state !== 'joining') return
          for (const { spec, cb } of listeners) {
            const stop = await database.subscribe({ as: as(), table: spec.table, event: spec.event || '*', filter: spec.filter }, cb)
            if (ch.state === 'joining') stops.push(stop)
            else stop()
          }
          if (ch.state !== 'joining') return
          ch.state = 'joined'
          onStatus?.('SUBSCRIBED')
        }, 0)
        return ch
      },
      // How to call: await ch.unsubscribe() -> 'ok'
      async unsubscribe() {
        ch.state = 'leaving'
        // The server's acknowledgement takes a network round trip.
        await new Promise((resolve) => setTimeout(resolve, leaveMs))
        for (const stop of stops.splice(0)) stop()
        ch.state = 'closed'
        return 'ok'
      },
      // How to call: ch.teardown() (forgets the topic)
      teardown() {
        if (channels.get(topic) === ch) channels.delete(topic)
      },
    }
    channels.set(topic, ch)
    return ch
  }

  // How to call: await removeChannel(ch) -> 'ok'
  async function removeChannel(ch) {
    const status = await ch.unsubscribe()
    if (status === 'ok') ch.teardown()
    return status
  }

  return { from, rpc, channel, removeChannel, getChannels: () => [...channels.values()] }
}
