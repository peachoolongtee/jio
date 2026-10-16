// A stand-in for the part of Jio's Supabase database that stage 2 uses: sessions, who is in them, and invite links. It
// follows db/schema.sql and db/policies.sql as the live project has them, so a flow can be walked and tested with no
// project contacted. It has no imports, so the browser (through fakeSupabase.js) and a Node script can both use it, and a
// script can hold ONE database for two browsers and a backend, the way a real project is one database for two devices.
//
// What it models, from the files:
//   - the tables `sessions`, `session_members` and `invites`, with their defaults, check constraints, foreign keys to
//     `profiles` and the unique indexes (one live link per session; one invitation per person per session);
//   - who may read each row (a member reads their session, a host reads every invite of theirs, an invitee reads their own
//     invitations, a member reads the pending personal invitations of their session), and who may write which columns:
//     a signed-in user inserts a session (as the host) and an invite (as its creator, for a session they host), updates a
//     session's title, date, times and status (host only), and revokes an invite (host only, and it cannot be undone). The
//     browser has no insert, update or delete on `session_members`, and no delete anywhere. The service key does anything;
//   - the triggers: the host's member row on a new session, the checks before an invite is made (the session is open, a
//     personal invitation is not for the host or a member, at most 30 open ones), and `guard_session_changes` (a finished
//     session is frozen; the only status changes are start, with two joined people, and cancel; the date and times change
//     only while inviting);
//   - the functions `invite_preview`, `join_session`, `my_invitations` and `decline_invite`, with the same answers and
//     errors (P0002 for any link that is not good, 28000 when not signed in, P0001 with hint session_full at 30 people);
//   - Realtime: `subscribe` delivers inserts, updates and deletes of the three tables, as the `supabase_realtime`
//     publication carries them. An insert or update reaches only a subscriber who may read the row, and passes the
//     subscriber's filter. A delete is not filtered by access rules, carries only the row's key, and, as Supabase cannot
//     filter deletes, is NOT delivered to a subscriber who gave a filter (the stricter reading, so code cannot lean on it).
//
// Order of checks on an insert follows Postgres: a type error (a value that is not a uuid is 22P02, before anything else), the
// BEFORE triggers (check_invite_insert, even for the server), the row-level "with check", then the constraints (foreign keys,
// check constraints, unique indexes). A statement that RETURNS a row the caller may not read fails as a whole (42501) and
// leaves nothing behind.
//
// What it does NOT model: updates to `session_members` (areas, picks: stage 3), the planner columns of `sessions`
// (meeting_*, radius, banner and the rest are null/absent), `slots`, `votes`, `stops` and the other tables, the 30-day
// ceiling on how far ahead `expires_at` may be set beyond what the check says, row locks and concurrent transactions (one
// call runs to the end before the next), Postgres's exact error texts beyond the ones the app reads, Realtime's connection
// life (reconnects, missed events), and the rate limits and size limits of Supabase itself.
//
// An acting identity is a user id (signed in), null (the public key, signed out) or SERVICE (the server's key).
// How to call: const db = createDatabase({ profiles: { [uid]: { username: 'sam', display_name: 'Sam', avatar_url: null } } }); db.run({ as: uid, kind: 'select', table: 'sessions', columns: '*', filters: [] })

export const SERVICE = 'service'

const PRIMARY_KEY = { sessions: ['id'], session_members: ['session_id', 'user_id'], invites: ['token'] }
const DAY_MS = 24 * 60 * 60 * 1000
const OPEN = ['inviting', 'locating', 'voting']
const MAX_JOINED = 30
const GRANTS = {
  sessions: { insert: ['host_id', 'title', 'date', 'start_time', 'end_time'], update: ['title', 'date', 'start_time', 'end_time', 'status'] },
  invites: { insert: ['session_id', 'created_by', 'expires_at', 'invitee_id'], update: ['revoked'] },
  session_members: { insert: [], update: ['start_area_id', 'end_area_id', 'categories', 'stay_until'] },
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
const UUID_COLUMNS = { sessions: ['id', 'host_id'], session_members: ['session_id', 'user_id'], invites: ['session_id', 'created_by', 'invitee_id'] }
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
  const tables = { sessions: [], session_members: [], invites: [] }
  const subscribers = new Set()
  // The events of the statement being run, or null outside one.
  let queue = null
  // Declared here so the rules can be replaced in a test: self.canSee(...).
  const self = {}

  // Who is in what. How to call: isMember(uid, sessionId) -> true; isHost(uid, sessionId) -> true; sessionOf(sessionId) -> the row
  const isMember = (uid, sessionId) => tables.session_members.some((m) => m.session_id === sessionId && m.user_id === uid)
  const isHost = (uid, sessionId) => tables.sessions.some((s) => s.id === sessionId && s.host_id === uid)
  const sessionOf = (id) => tables.sessions.find((s) => s.id === id)

  // May this identity read this row? The select policies of db/policies.sql.
  // How to call: canSee(uid, 'invites', row)
  function canSee(as, table, row) {
    if (as === SERVICE) return true
    if (!as) return false
    if (table === 'sessions') return row.host_id === as || isMember(as, row.id)
    if (table === 'session_members') return isMember(as, row.session_id)
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
    if (!PRIMARY_KEY[table]) throw new DbError('42P01', `relation "public.${table}" does not exist`, { status: 404 })
    if (!as) throw denied(table)
    checkFilters(table, op.filters)
    let rows = filterRows(tables[table].filter((r) => self.canSee(as, table, r)), op.filters)
    for (const { col, ascending = true } of [...(op.order || [])].reverse()) {
      rows = [...rows].sort((a, b) => (a[col] < b[col] ? -1 : a[col] > b[col] ? 1 : 0) * (ascending ? 1 : -1))
    }
    if (op.limit != null) rows = rows.slice(0, op.limit)
    return shape(op, rows, table)
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
      throw new Error('The stand-in lets only the server insert into session_members (the trigger and join_session do it).')
    })
    if (!op.returning) return { data: null, error: null, status: 201 }
    // RETURNING applies the select policy to the new rows: one the person may not read fails the whole statement.
    if (made.some((r) => !self.canSee(as, table, r))) throw rlsRefused(table)
    return shape(op, made, table)
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
    if (table === 'session_members') throw new Error('The stand-in does not model updates to session_members (stage 3).')
    // The row-level "using" rule: only the host's own rows can be updated; others are silently left out.
    const mine = (r) => as === SERVICE || (table === 'sessions' ? r.host_id === as : isHost(as, r.session_id))
    const targets = filterRows(tables[table].filter((r) => self.canSee(as, table, r) && mine(r)), op.filters)
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

  // A delete. Only the server's key may; the rows that hang on a session go with it.
  // How to call: remove({ as: SERVICE, table: 'session_members', filters: [{ col: 'user_id', op: 'eq', value: uid }] })
  function remove(op) {
    const { as, table } = op
    if (!PRIMARY_KEY[table]) throw new DbError('42P01', `relation "public.${table}" does not exist`, { status: 404 })
    if (!as) throw denied(table)
    if (as !== SERVICE) throw denied(table)
    checkFilters(table, op.filters)
    const targets = filterRows(tables[table], op.filters)
    for (const row of targets) {
      tables[table].splice(tables[table].indexOf(row), 1)
      publish(table, 'DELETE', row)
      // Foreign keys with "on delete cascade".
      if (table === 'sessions') {
        for (const child of ['session_members', 'invites']) {
          for (const c of tables[child].filter((r) => r.session_id === row.id)) {
            tables[child].splice(tables[child].indexOf(c), 1)
            publish(child, 'DELETE', c)
          }
        }
      }
    }
    if (!op.returning) return { data: null, error: null, status: 204 }
    return shape(op, targets, table)
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
