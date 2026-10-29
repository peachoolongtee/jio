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
//   - stage 4: `slots`, `slot_options` and `votes`. Members read them; only the server writes slots and options (through
//     `apply_session_plan`); a member inserts, changes and deletes their own vote while they have joined, the session is voting and
//     the slot is not removed (`my_votable_slot_ids()`), for a place that is one of the slot's options (the foreign key to
//     `slot_options`, which follows a swapped option and goes with a removed one);
//   - who may read each row (a member reads their session, a host reads every invite of theirs, an invitee reads their own
//     invitations, a member reads the pending personal invitations of their session), and who may write which columns:
//     a signed-in user inserts a session (as the host) and an invite (as its creator, for a session they host), updates a
//     session's title, date, times, status and meet_by (host only), and revokes an invite (host only, and it cannot be undone). A member
//     updates their own `start_area_id`, `end_area_id`, `categories` and `stay_until` while joined and the session is open, and
//     keeps their own exact place the same way. The browser has no insert or delete on `session_members`. The service key does anything;
//   - the triggers: the host's member row on a new session, the checks before an invite is made (the session is open, a
//     personal invitation is not for the host or a member, at most 30 open ones), and `guard_session_changes` (a finished
//     session is frozen; the only status changes are start, with two joined people, and cancel; the date and times change
//     only while inviting; meet_by is set as the session starts or while it is locating, and never cleared);
//   - the functions `invite_preview`, `join_session`, `my_invitations` and `decline_invite`, with the same answers and
//     errors (P0002 for any link that is not good, 28000 when not signed in, P0001 with hint session_full at 30 people);
//   - the clash rule (db/migrations/20261028000000_jio_no_clashing_meetups.sql): a new meetup, a join, and a move to other times are
//     refused with P0001 and the hint schedule_clash (naming the person's own meetup in `details`), or member_clash for another member;
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
// Stage 5 (the plan on the server, ticket 130) adds the tables `stops`, `commute_ledger` and `stop_proposals` and the order columns of
// `sessions` (`order_reason`, `order_source`, `order_suggestion`, `plan_start_minute`, `replan`, `completed_at`), as db/schema.sql has them
// (checks, the deferred unique key on (session_id, seq), one pending proposal per place, a proposal going with its proposer, a stop's
// slot set to null when the slot goes). Members read `stops` and `stop_proposals` (and a person's own ledger row, and every row of a
// session they are in, as the policy `commute_ledger_select` says); only the server writes them, and `stops` is in the Realtime publication
// (`commute_ledger` and `stop_proposals` are not). The status moves to `confirmed` and `completed` are the server's (the stand-in lets the
// service key set any status the table allows, which is what the trigger leaves to it).
// ASSUMED (no migration of stage 5 is written yet, so these are this stand-in's reading, to be reconciled with the backend half): the
// server writes the plan through direct table writes here, where the real one will extend `apply_session_plan` with stops, ledger,
// proposals and the order columns. The patch's parts for those are therefore NOT ported, except two: `session.replan` and the op `resolve_proposal`
// (a guest opting out of a confirmed plan sends both): `apply_session_plan` here still knows only the stage 3 and 4 parts besides, and the stand-in server (lib/__tests__/fakeSessionsServer.js) writes the stage 5 rows itself. The shapes of
// `order_suggestion` ({ basis, order, starts, reason, source, at }) and of `replan` ({ reason, trigger, at }) are from the design (#125, #80).
//
// Stage 4 of `apply_session_plan` is a port of db/migrations/20261022000000_jio_apply_session_plan_slots.sql (and of its JavaScript
// twin, backend/tests/helpers/fake-supabase.js): the ops `clear_votes` and `swap_option`, `opt_out` and `remove_member` taking the
// person's votes, the `slots` list as a difference (one item per category, with `options`, `deleted` and `remove`), the votes of anyone
// who is not a joined member going after it, `session.radius_meters`, a banner stamped by the database's clock, and the minutes of a
// joined member counting as a change. The browser never calls the function; only the real backend, started in a test, does.
// `session_member_needs(sid)` is here too (the service key only), over the needs given to `createDatabase` or `setNeeds`.
// Where it cannot be identical to Postgres (everything else in that function is a step-for-step port, and the same cases are in
// db/tests/apply_session_plan.sql steps 77 onwards and lib/__tests__/fakeDatabase.votes.test.js): the size check on `slots.details`
// is `octet_length(details::text) <= 4000` in the database (jsonb's text has a space after each colon and comma) and the length of
// `JSON.stringify` here, so a value within a few percent of 4000 bytes can differ; `score` is a `numeric` there and a JavaScript
// number here; `for update` row locks and a rolled-back transaction are replaced by running one call to the end and restoring the
// tables on an error; and error texts are Postgres's only where the app reads them.
//
// Order of checks on an insert follows Postgres: a type error (a value that is not a uuid is 22P02, before anything else), the
// BEFORE triggers (check_invite_insert, even for the server), the row-level "with check", then the constraints (foreign keys,
// check constraints, unique indexes). A statement that RETURNS a row the caller may not read fails as a whole (42501) and
// leaves nothing behind.
//
// What it does NOT model: the planner columns of `sessions` beyond what stages 3 and 4 read (meeting_*, banner, plan_version and
// radius_meters and replan are there), `stops` and the other tables, the table `profile_private` itself (only the function over
// it), the 30-day
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
  slot_options: ['slot_id', 'venue_id'],
  votes: ['slot_id', 'user_id'],
  stops: ['id'],
  commute_ledger: ['session_id', 'user_id'],
  stop_proposals: ['id'],
}
// The tables the supabase_realtime publication carries (db/policies.sql). The others raise no live events.
const PUBLISHED = new Set(['sessions', 'session_members', 'invites', 'spot_approvals', 'slots', 'slot_options', 'votes', 'stops'])
const PLACE_COLUMNS = ['start_label', 'start_lat', 'start_lng', 'end_label', 'end_lat', 'end_lng']
const DAY_MS = 24 * 60 * 60 * 1000
const OPEN = ['inviting', 'locating', 'voting']
const MAX_JOINED = 30
const GRANTS = {
  sessions: { insert: ['host_id', 'title', 'date', 'start_time', 'end_time'], update: ['title', 'date', 'start_time', 'end_time', 'status', 'meet_by'] },
  invites: { insert: ['session_id', 'created_by', 'expires_at', 'invitee_id'], update: ['revoked'] },
  session_members: { insert: [], update: ['start_area_id', 'end_area_id', 'categories', 'stay_until'] },
  session_member_places: { insert: ['session_id', 'user_id', ...PLACE_COLUMNS], update: PLACE_COLUMNS, delete: true },
  session_spots: { insert: [], update: [] },
  spot_suggestions: { insert: [], update: [] },
  spot_approvals: { insert: ['session_id', 'area_id', 'user_id'], update: [], delete: true },
  slots: { insert: [], update: [] },
  slot_options: { insert: [], update: [] },
  votes: { insert: ['slot_id', 'user_id', 'venue_id'], update: ['venue_id'], delete: true },
  // Stage 5: members read these three and write nothing (db/policies.sql grants select only).
  stops: { insert: [], update: [] },
  commute_ledger: { insert: [], update: [] },
  stop_proposals: { insert: [], update: [] },
}

// A database error as the client reports it: { message, code, details, hint }, with the HTTP status PostgREST would use.
// How to call: throw new DbError('42501', 'permission denied for table sessions', { status: 403 })
class DbError extends Error {
  constructor(code, message, { status = 400, hint = null, details = null } = {}) {
    super(message)
    this.code = code
    this.status = status
    this.hint = hint
    this.details = details
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
  slot_options: ['slot_id'],
  votes: ['slot_id', 'user_id'],
  stops: ['id', 'session_id', 'slot_id'],
  commute_ledger: ['session_id', 'user_id'],
  stop_proposals: ['id', 'session_id', 'proposed_by', 'resolved_by'],
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
export function createDatabase({ profiles = {}, needs = {}, now = () => Date.now() } = {}) {
  // The private planner needs of each person, as `profile_private` holds them (home_area_id, dietary, budget_max_per_person,
  // needs_step_free). Nobody reads them as a table; only `session_member_needs()` does, for the service key.
  const privateNeeds = new Map(Object.entries(needs).map(([id, row]) => [id, structuredClone(row)]))
  const tables = { sessions: [], session_members: [], invites: [], session_member_places: [], session_spots: [], spot_suggestions: [], spot_approvals: [], slots: [], slot_options: [], votes: [], stops: [], commute_ledger: [], stop_proposals: [] }
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
  // The slot a row hangs on, and the session of that slot. my_slot_ids() (a member of the slot's session, in any state) and
  // my_votable_slot_ids() (joined, the session is voting, the slot is not removed).
  // How to call: slotOf(slotId) -> the row; votable(uid, slotId) -> true
  const slotOf = (slotId) => tables.slots.find((sl) => sl.id === slotId)
  const inSlot = (uid, slotId) => {
    const slot = slotOf(slotId)
    return !!slot && isMember(uid, slot.session_id)
  }
  const votable = (uid, slotId) => {
    const slot = slotOf(slotId)
    return !!slot && !slot.deleted && joinedIn(uid, slot.session_id) && sessionOf(slot.session_id)?.status === 'voting'
  }

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
    // Options and votes: a member of the slot's session reads them all (my_slot_ids()).
    if (table === 'slot_options' || table === 'votes') return inSlot(as, row.slot_id)
    // The itinerary, the ledger and the proposals: every member reads them (my_session_ids()); a person also reads their own ledger row
    // (commute_ledger_select).
    if (table === 'stops' || table === 'stop_proposals') return isMember(as, row.session_id)
    if (table === 'commute_ledger') return row.user_id === as || isMember(as, row.session_id)
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
    // How the host picks the meeting point (db/schema.sql): 'fairest', 'known', or null on a session that started before the choice.
    if (row.meet_by != null && !['fairest', 'known'].includes(row.meet_by)) throw new DbError('23514', 'new row for relation "sessions" violates check constraint "sessions_meet_by_check"')
    // The order columns of stage 5 (db/schema.sql): a one-sentence reason of 1 to 200 characters and its source, set or null together; the
    // plan's start a minute of the day; a suggestion no larger than 4000 bytes with a 64-character hex basis and at most 8 slot ids.
    if (row.order_reason != null && !(typeof row.order_reason === 'string' && row.order_reason.length >= 1 && row.order_reason.length <= 200)) throw new DbError('23514', 'new row for relation "sessions" violates check constraint "order_reason_length"')
    if (row.order_source != null && !['ai', 'rules'].includes(row.order_source)) throw new DbError('23514', 'new row for relation "sessions" violates check constraint "order_source_values"')
    if ((row.order_reason == null) !== (row.order_source == null)) throw new DbError('23514', 'new row for relation "sessions" violates check constraint "order_note_pair"')
    if (row.plan_start_minute != null && !(Number.isInteger(row.plan_start_minute) && row.plan_start_minute >= 0 && row.plan_start_minute <= 1439)) throw new DbError('23514', 'new row for relation "sessions" violates check constraint "plan_start_minute_range"')
    if (row.order_suggestion != null) {
      const o = row.order_suggestion
      const ok = typeof o === 'object' && !Array.isArray(o) && JSON.stringify(o).length <= 4000 && /^[0-9a-f]{64}$/.test(String(o.basis)) && Array.isArray(o.order) && o.order.length <= 8
      if (!ok) throw new DbError('23514', 'new row for relation "sessions" violates check constraint "order_suggestion_shape"')
    }
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
    // meet_by is set as the session starts or while it is locating, and is never cleared.
    if (next.meet_by !== old.meet_by) {
      if (next.meet_by == null) throw new DbError('42501', 'How to pick the meeting point cannot be cleared.', { status: 403 })
      const starting = old.status === 'inviting' && next.status === 'locating'
      const locating = old.status === 'locating' && next.status === 'locating'
      if (!starting && !locating) throw new DbError('42501', 'How to pick the meeting point can only be chosen as the session starts or while it is locating.', { status: 403 })
    }
  }

  // The trigger guards of db/migrations/20261028000000_jio_no_clashing_meetups.sql: a person cannot be in two meetups at the same
  // time. Meetups hold their time while inviting, locating, voting or confirmed; back to back is fine; the owner (no signed-in
  // person) is let through, and the server is checked only when it brings an opted-out member back (apply_session_plan, op rejoin).
  // Throws P0001 with hint schedule_clash and the meetup in the way as JSON.
  const HOLDING = ['inviting', 'locating', 'voting', 'confirmed']
  // The first meetup the person is joined in that overlaps the session's day and times (leaving out the session itself), or undefined.
  // How to call: clashOf(uid, { id: 's1', date: '2026-10-28', start_time: '19:00:00', end_time: '21:00:00' })
  function clashOf(user, session) {
    return tables.sessions.find(
      (s) =>
        s.id !== session.id &&
        HOLDING.includes(s.status) &&
        s.date === session.date &&
        s.start_time < session.end_time &&
        session.start_time < s.end_time &&
        tables.session_members.some((m) => m.session_id === s.id && m.user_id === user && m.state === 'joined'),
    )
  }
  // Refuses when `user` is already in a meetup that overlaps the session. How to call: refuseClash(uid, session)
  function refuseClash(user, session) {
    const hit = clashOf(user, session)
    if (hit) {
      throw new DbError('P0001', 'You already have a meetup at that time.', {
        hint: 'schedule_clash',
        details: JSON.stringify({ id: hit.id, title: hit.title, date: hit.date, start: hit.start_time, end: hit.end_time }),
      })
    }
  }
  // A signed-in person's own write. How to call: guardClash(uid, { id, status, date, start_time, end_time })
  function guardClash(as, session) {
    if (!as || as === SERVICE || !HOLDING.includes(session.status)) return
    refuseClash(as, session)
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
      meet_by: null,
      meeting_max_minutes: null,
      meeting_total_minutes: null,
      meeting_count: null,
      meeting_approximate: null,
      meeting_computed_at: null,
      banner: null,
      replan: null,
      weather_kept: null,
      completed_at: null,
      order_reason: null,
      order_source: null,
      order_suggestion: null,
      plan_start_minute: null,
      plan_version: 0,
      created_at: iso(now()),
      updated_at: iso(now()),
    }
    if (as !== SERVICE && row.host_id !== as) throw rlsRefused('sessions')
    checkSession(row)
    guardClash(as, { ...row, id: null })
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
        for (const child of ['session_members', 'invites', 'session_member_places', 'session_spots', 'spot_suggestions', 'spot_approvals', 'slots', 'stops', 'commute_ledger', 'stop_proposals']) children.push([child, tables[child].filter((r) => r.session_id === row.id)])
      } else if (table === 'session_members') {
        for (const child of ['session_member_places', 'spot_suggestions', 'spot_approvals']) children.push([child, tables[child].filter((r) => r.session_id === row.session_id && r.user_id === row.user_id)])
        // A proposal goes with its proposer (the foreign key to the member row cascades).
        children.push(['stop_proposals', tables.stop_proposals.filter((r) => r.session_id === row.session_id && r.proposed_by === row.user_id)])
      } else if (table === 'session_spots') {
        children.push(['spot_approvals', tables.spot_approvals.filter((r) => r.session_id === row.session_id && r.area_id === row.area_id)])
      } else if (table === 'slots') {
        // A removed slot takes its options, and they take the votes for them (on delete cascade). The stops made from it keep standing, with
        // no slot (on delete set null).
        children.push(['slot_options', tables.slot_options.filter((r) => r.slot_id === row.id)])
        for (const stop of tables.stops.filter((r) => r.slot_id === row.id)) {
          stop.slot_id = null
          publish('stops', 'UPDATE', stop)
        }
      } else if (table === 'slot_options') {
        children.push(['votes', tables.votes.filter((r) => r.slot_id === row.slot_id && r.venue_id === row.venue_id)])
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
      if (table === 'votes') return insertVote(as, v)
      if (table === 'slots') return insertSlot(v)
      if (table === 'slot_options') return insertOption(v)
      if (['session_spots', 'spot_suggestions'].includes(table)) return insertSpotRow(table, v)
      if (['stops', 'commute_ledger', 'stop_proposals'].includes(table)) return insertPlanRow(table, v)
      throw new Error('The stand-in lets only the server insert into session_members (the trigger and join_session do it).')
    })
    if (table === 'stops') checkStopSeq()
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

  // A vote: the member's own, in a slot they may vote in now, for one of the slot's options (db/policies.sql votes_insert_own; the
  // foreign key (slot_id, venue_id) to slot_options; the key (slot_id, user_id) allows one vote per person per slot).
  // How to call: insertVote(uid, { slot_id, user_id: uid, venue_id: 'v25' })
  function insertVote(as, values) {
    if (as !== SERVICE && !(values.user_id === as && votable(as, values.slot_id))) throw rlsRefused('votes')
    if (!profiles[values.user_id]) throw new DbError('23503', 'insert or update on table "votes" violates foreign key constraint "votes_user_id_fkey"', { status: 409 })
    if (!tables.slot_options.some((o) => o.slot_id === values.slot_id && o.venue_id === values.venue_id)) {
      throw new DbError('23503', 'insert or update on table "votes" violates foreign key constraint "votes_slot_id_venue_id_fkey"', { status: 409 })
    }
    if (tables.votes.some((v) => v.slot_id === values.slot_id && v.user_id === values.user_id)) {
      throw new DbError('23505', 'duplicate key value violates unique constraint "votes_pkey"', { status: 409 })
    }
    const row = { slot_id: values.slot_id, user_id: values.user_id, venue_id: values.venue_id, created_at: iso(now()), updated_at: iso(now()) }
    tables.votes.push(row)
    publish('votes', 'INSERT', row)
    return row
  }

  // The server's slots and options (the service key only). The checks the tables make: a category from the four, a start inside the day,
  // a length of 1 to 720 minutes, one slot per category per session, one option per place per slot, a venue id up to 160 characters (the 32 saved hawker centres have ids of 86).
  // How to call: insertSlot({ session_id, category: 'eat', start_minute: 720, duration_minutes: 90 })
  function insertSlot(values) {
    const row = { id: newId(), picks: 0, is_last: false, deleted: false, details: {}, created_at: iso(now()), updated_at: iso(now()), ...structuredClone(values) }
    checkSlot(row)
    if (tables.slots.some((x) => x.session_id === row.session_id && x.category === row.category)) throw new DbError('23505', 'duplicate key value violates unique constraint "slots_session_id_category_key"', { status: 409 })
    tables.slots.push(row)
    publish('slots', 'INSERT', row)
    return row
  }
  // How to call: checkSlot(row) throws a check-style error
  function checkSlot(row) {
    if (!sessionOf(row.session_id)) throw new DbError('23503', 'insert or update on table "slots" violates foreign key constraint "slots_session_id_fkey"')
    if (!['eat', 'drink', 'shop', 'activity'].includes(row.category)) throw new DbError('23514', 'new row for relation "slots" violates check constraint "slots_category_check"')
    if (row.start_minute == null) throw new DbError('23502', 'null value in column "start_minute" of relation "slots" violates not-null constraint')
    if (row.duration_minutes == null) throw new DbError('23502', 'null value in column "duration_minutes" of relation "slots" violates not-null constraint')
    if (!(row.start_minute >= 0 && row.start_minute <= 1439)) throw new DbError('23514', 'new row for relation "slots" violates check constraint "slots_start_minute_check"')
    if (!(row.duration_minutes >= 1 && row.duration_minutes <= 720)) throw new DbError('23514', 'new row for relation "slots" violates check constraint "slots_duration_minutes_check"')
    if (row.details === null || typeof row.details !== 'object' || Array.isArray(row.details) || JSON.stringify(row.details).length > 4000) throw new DbError('23514', 'new row for relation "slots" violates check constraint "slots_details_shape"')
  }
  // How to call: insertOption({ slot_id, venue_id: 'v25', rank: 1, score: 12.5, details: {} })
  function insertOption(values) {
    const row = { rank: null, score: null, source: 'planner', added_by: null, details: {}, created_at: iso(now()), ...structuredClone(values) }
    if (!slotOf(row.slot_id)) throw new DbError('23503', 'insert or update on table "slot_options" violates foreign key constraint "slot_options_slot_id_fkey"')
    if (typeof row.venue_id !== 'string' || row.venue_id.length < 1 || row.venue_id.length > 160) throw new DbError('23514', 'new row for relation "slot_options" violates check constraint "slot_options_venue_id_check"')
    if (!['planner', 'member'].includes(row.source)) throw new DbError('23514', 'new row for relation "slot_options" violates check constraint "slot_options_source_check"')
    if (row.added_by != null && !profiles[row.added_by]) throw new DbError('23503', 'insert or update on table "slot_options" violates foreign key constraint "slot_options_added_by_fkey"')
    if (tables.slot_options.some((o) => o.slot_id === row.slot_id && o.venue_id === row.venue_id)) throw new DbError('23505', 'duplicate key value violates unique constraint "slot_options_pkey"', { status: 409 })
    tables.slot_options.push(row)
    publish('slot_options', 'INSERT', row)
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

  // ── Stage 5: the itinerary, the ledger and the proposals ────────────────

  // The checks of one row of `stops`, `commute_ledger` or `stop_proposals`, as db/schema.sql has them.
  // How to call: checkPlanRow('stops', { session_id, seq: 0, category: 'eat', venue_id: 'v25', planned_start_minute: 720, duration_minutes: 60 })
  function checkPlanRow(table, row) {
    const bad = (name) => new DbError('23514', `new row for relation "${table}" violates check constraint "${name}"`)
    if (!sessionOf(row.session_id)) throw new DbError('23503', `insert or update on table "${table}" violates foreign key constraint "${table}_session_id_fkey"`)
    if (table === 'stops') {
      if (!(Number.isInteger(row.seq) && row.seq >= 0)) throw bad('stops_seq_check')
      if (row.slot_id != null && !slotOf(row.slot_id)) throw new DbError('23503', 'insert or update on table "stops" violates foreign key constraint "stops_slot_id_fkey"')
      if (row.category != null && !['eat', 'drink', 'shop', 'activity'].includes(row.category)) throw bad('stops_category_check')
      if (typeof row.venue_id !== 'string' || row.venue_id.length < 1 || row.venue_id.length > 160) throw bad('stops_venue_id_check')
      if (!(Number.isInteger(row.planned_start_minute) && row.planned_start_minute >= 0 && row.planned_start_minute <= 1439)) throw bad('stops_planned_start_minute_check')
      if (!(Number.isInteger(row.duration_minutes) && row.duration_minutes >= 1 && row.duration_minutes <= 720)) throw bad('stops_duration_minutes_check')
      if (row.travel_mode != null && !['walk', 'mrt', 'car'].includes(row.travel_mode)) throw bad('stops_travel_mode_check')
      if (row.not_before_minute != null && !(Number.isInteger(row.not_before_minute) && row.not_before_minute >= 0 && row.not_before_minute <= 1439)) throw bad('not_before_minute_range')
    } else if (table === 'commute_ledger') {
      if (!profiles[row.user_id]) throw new DbError('23503', 'insert or update on table "commute_ledger" violates foreign key constraint "commute_ledger_user_id_fkey"')
      for (const column of ['minutes_in', 'minutes_between', 'minutes_home']) if (!(Number.isInteger(row[column]) && row[column] >= 0)) throw bad(`commute_ledger_${column}_check`)
      if (typeof row.delta_from_mean !== 'number' || !Number.isFinite(row.delta_from_mean)) throw new DbError('23502', 'null value in column "delta_from_mean" of relation "commute_ledger" violates not-null constraint')
    } else {
      if (typeof row.venue_id !== 'string' || row.venue_id.length < 1 || row.venue_id.length > 160) throw bad('stop_proposals_venue_id_check')
      if (!['pending', 'accepted', 'dismissed'].includes(row.status)) throw bad('stop_proposals_status_check')
      if ((row.status === 'pending') !== (row.resolved_at == null)) throw bad('stop_proposals_check')
      if (row.resolved_by != null && row.resolved_at == null) throw bad('stop_proposals_check1')
      if (!isMember(row.proposed_by, row.session_id)) throw new DbError('23503', 'insert or update on table "stop_proposals" violates foreign key constraint "stop_proposals_session_id_proposed_by_fkey"')
    }
  }

  // The key (session_id, seq) of `stops` is unique but deferred: checked at the end of the statement, so stops can swap places in one go.
  // How to call: checkStopSeq() throws 23505 when two stops of a session share a place in the order
  function checkStopSeq() {
    const seen = new Set()
    for (const stop of tables.stops) {
      const key = `${stop.session_id}:${stop.seq}`
      if (seen.has(key)) throw new DbError('23505', 'duplicate key value violates unique constraint "stops_session_id_seq_key"', { status: 409 })
      seen.add(key)
    }
  }

  // The server writes these (the service key only; the grants keep the browser out).
  // How to call: insertPlanRow('stops', { session_id, seq: 0, slot_id, category: 'eat', venue_id: 'v25', planned_start_minute: 720, duration_minutes: 60 })
  function insertPlanRow(table, values) {
    let row
    if (table === 'stops') row = { id: newId(), slot_id: null, category: null, travel_mode: null, travel_minutes: null, arrived_at: null, not_before_minute: null, created_at: iso(now()), ...structuredClone(values) }
    else if (table === 'commute_ledger') row = { minutes_in: 0, minutes_between: 0, minutes_home: 0, delta_from_mean: 0, created_at: iso(now()), ...structuredClone(values) }
    else row = { id: newId(), status: 'pending', created_at: iso(now()), resolved_at: null, resolved_by: null, ...structuredClone(values) }
    checkPlanRow(table, row)
    if (table === 'commute_ledger') row.total_minutes = row.minutes_in + row.minutes_between + row.minutes_home
    if (tables[table].some((r) => PRIMARY_KEY[table].every((c) => r[c] === row[c]))) throw new DbError('23505', `duplicate key value violates unique constraint "${table}_pkey"`, { status: 409 })
    if (table === 'stop_proposals' && row.status === 'pending' && tables.stop_proposals.some((r) => r.session_id === row.session_id && r.venue_id === row.venue_id && r.status === 'pending')) {
      throw new DbError('23505', 'duplicate key value violates unique constraint "stop_proposals_one_pending_idx"', { status: 409 })
    }
    tables[table].push(row)
    publish(table, 'INSERT', row)
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
    // A vote: the person's own, in a slot they may vote in now (votes_update_own, votes_delete_own).
    if (table === 'votes') return row.user_id === as && votable(as, row.slot_id)
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
        if (old.date !== next.date || old.start_time !== next.start_time || old.end_time !== next.end_time) {
          guardClash(as, next)
          const others = tables.session_members.filter((m) => m.session_id === next.id && m.state === 'joined' && m.user_id !== as)
          if (as !== SERVICE && HOLDING.includes(next.status) && others.some((m) => clashOf(m.user_id, next))) {
            throw new DbError('P0001', 'Someone in this meetup already has plans at that time.', { hint: 'member_clash' })
          }
        }
        next.updated_at = iso(now())
      } else if (table === 'invites') {
        // The "with check": a host's update must leave the invite revoked, so a revoke cannot be undone.
        if (as !== SERVICE && next.revoked !== true) throw rlsRefused('invites')
      } else if (table === 'session_members') {
        // The trigger session_members_guard_clash: a member becoming joined again (the server's rejoin, or a person's own write) must not
        // be in another meetup then.
        if (as && old.state !== 'joined' && next.state === 'joined') {
          const target = tables.sessions.find((x) => x.id === next.session_id)
          if (target && HOLDING.includes(target.status)) refuseClash(next.user_id, target)
        }
        for (const column of ['start_area_id', 'end_area_id']) {
          if (next[column] != null && (typeof next[column] !== 'string' || next[column].length < 1 || next[column].length > 60)) throw new DbError('23514', `new row for relation "session_members" violates check constraint "session_members_${column}_check"`)
        }
        next.updated_at = iso(now())
      } else if (table === 'session_member_places') {
        checkPlace(next)
        next.updated_at = iso(now())
      } else if (table === 'session_spots' || table === 'spot_suggestions') {
        checkSpotRow(table, next)
      } else if (table === 'votes') {
        // The foreign key follows an option the vote is moved to: it has to be one of the slot's options.
        if (!tables.slot_options.some((o) => o.slot_id === next.slot_id && o.venue_id === next.venue_id)) {
          throw new DbError('23503', 'insert or update on table "votes" violates foreign key constraint "votes_slot_id_venue_id_fkey"', { status: 409 })
        }
        next.updated_at = iso(now())
      } else if (table === 'slots') {
        checkSlot(next)
        next.updated_at = iso(now())
      } else if (['stops', 'commute_ledger', 'stop_proposals'].includes(table)) {
        checkPlanRow(table, next)
        if (table === 'commute_ledger') next.total_minutes = next.minutes_in + next.minutes_between + next.minutes_home
        if (table === 'stop_proposals' && next.status === 'pending' && tables.stop_proposals.some((r) => r !== old && r.session_id === next.session_id && r.venue_id === next.venue_id && r.status === 'pending')) {
          throw new DbError('23505', 'duplicate key value violates unique constraint "stop_proposals_one_pending_idx"', { status: 409 })
        }
      }
      return { old, next }
    })
    for (const { old, next } of done) {
      Object.assign(old, next)
      publish(table, 'UPDATE', old)
    }
    if (table === 'stops') checkStopSeq()
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
      candidates = candidates.filter((r) => self.canSee(as, table, r) && r.user_id === as && (table !== 'spot_approvals' || inLocating(as, r.session_id)) && (table !== 'votes' || votable(as, r.slot_id)))
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
    // A part of the plan the function does not know is refused, before the session is read, so a typo is never dropped without a word.
    const unknownKey = Object.keys(patch).find((k) => !['ops', 'spots', 'slots', 'session', 'loaded_at', 'recomputed', 'banner_text'].includes(k))
    if (unknownKey !== undefined) throw new DbError('22023', `The plan has a part this function does not know: ${unknownKey}.`)
    if (has(patch, 'session')) {
      if (patch.session === null || typeof patch.session !== 'object' || Array.isArray(patch.session)) throw new DbError('22023', 'The session part of the plan must be a JSON object.')
      const unknownSessionKey = Object.keys(patch.session).find((k) => !['status', 'meeting', 'banner', 'radius_meters', 'replan'].includes(k))
      if (unknownSessionKey !== undefined) throw new DbError('22023', `The session part of the plan has a part this function does not know: ${unknownSessionKey}.`)
    }
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

    // Rule 9 (db/migrations/20261027000000_jio_change_meeting_place.sql): the host changes the meeting place. The op releases the meeting area and
    // sends the session back to locating; it is valid only on that move (from voting or confirmed), and that move is valid only with it. It
    // names the host's new choice, and the patch brings no meeting of its own.
    const releaseOp = Array.isArray(patch.ops) ? patch.ops.find((o) => o?.op === 'release_meeting') : undefined
    const released = releaseOp !== undefined
    if (released) {
      if (!(['voting', 'confirmed'].includes(s.status) && (sp.status ?? s.status) === 'locating')) {
        throw ruleBroken('release_status', 'The meeting area is released only by moving a voting or confirmed session back to locating.')
      }
      if (sp.meeting !== undefined && sp.meeting !== null) throw ruleBroken('release_meeting', 'A released session has no meeting area, so the patch cannot bring one.')
      if (!['fairest', 'known'].includes(releaseOp.meet_by)) throw new DbError('22023', 'A release says how the meeting point is picked again: fairest or known.')
    }

    // Rule 4: a pinned meeting area stays (unless the host is releasing it, Rule 9).
    if (!released && has(sp, 'meeting') && ['voted', 'chosen'].includes(s.meeting_method) && ((meeting?.area_id ?? null) !== s.meeting_area_id || (meeting?.method ?? null) !== s.meeting_method)) {
      throw ruleBroken('area_pinned', 'The meeting area was chosen and cannot be changed by a recompute.')
    }
    // Rule 1: the only move is inviting or locating to voting, with an area. (The two-people check comes after the ops.)
    let changed = false
    const newStatus = sp.status ?? s.status
    if (newStatus !== s.status) {
      if ((!(['inviting', 'locating'].includes(s.status) && newStatus === 'voting') || !meeting?.area_id) && !(released && ['voting', 'confirmed'].includes(s.status) && newStatus === 'locating')) {
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

    // Rule 7: slots and options are written only while the session is voting (after this patch).
    if (has(patch, 'slots') && newStatus !== 'voting') {
      throw ruleBroken('slots_status', 'Slots and options are written only while the session is voting.')
    }

    // This session's votes, deleted where `test` says so (a vote hangs on its slot, so only this session's go). True if any went.
    // How to call: dropVotes((v) => v.user_id === uid)
    const dropVotes = (test) => {
      const mine = new Set(tables.slots.filter((sl) => sl.session_id === sid).map((sl) => sl.id))
      const gone = tables.votes.filter((v) => mine.has(v.slot_id) && test(v))
      cascade('votes', gone)
      return gone.length > 0
    }

    // Members, suggestions, approvals, votes and options, in the order given.
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
        // Opting out also takes the person's votes in this session's slots.
        changed = dropVotes((v) => v.user_id === user) || changed
      } else if (op.op === 'rejoin') {
        if (member?.state === 'opted_out') {
          // The trigger session_members_guard_clash checks the server's rejoin too.
          if (HOLDING.includes(s.status)) refuseClash(user, s)
          changeMember(member, { state: 'joined' })
          changed = true
        }
      } else if (op.op === 'remove_member') {
        if (member) {
          cascade('session_members', [member])
          changed = true
        }
        // Votes belong to the person, not to their membership: nothing took them with the row, so they go here.
        changed = dropVotes((v) => v.user_id === user) || changed
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
      } else if (op.op === 'clear_votes') {
        // The meeting area moved, so every vote is for a place that no longer belongs to it. Only in a voting session.
        if (s.status !== 'voting') throw ruleBroken('slots_status', 'Votes are cleared only while the session is voting.')
        changed = dropVotes(() => true) || changed
      } else if (op.op === 'release_meeting') {
        // Rule 9: everything that belonged to the meeting place goes in this write; starts, ends, exact places, picks and members stay.
        dropVotes(() => true)
        dropRows('slots', () => true)
        dropRows('stops', () => true)
        dropRows('spot_approvals', () => true)
        dropRows('spot_suggestions', () => true)
        dropRows('session_spots', () => true)
        // (The members' own minutes are left as they are: a write would move their updated_at past the new spots' computed_at, and a page reads that as stale.)
        changed = true
      } else if (op.op === 'swap_option') {
        if (s.status !== 'voting') throw ruleBroken('slots_status', 'An option is swapped only while the session is voting.')
        const slot = tables.slots.find((sl) => sl.session_id === sid && sl.category === op.category)
        if (!slot) throw ruleBroken('slot_missing', `This session has no ${op.category} slot.`)
        if (op.from === op.to) {
          // The same place: nothing to swap.
        } else if (tables.slot_options.some((o) => o.slot_id === slot.id && o.venue_id === op.to)) {
          // The other place is already an option: the votes move to it and this one goes.
          const moved = tables.votes.filter((v) => v.slot_id === slot.id && v.venue_id === op.from)
          for (const vote of moved) {
            vote.venue_id = op.to
            vote.updated_at = iso(now())
            publish('votes', 'UPDATE', vote)
          }
          changed = moved.length > 0 || changed
          const gone = tables.slot_options.filter((o) => o.slot_id === slot.id && o.venue_id === op.from)
          cascade('slot_options', gone)
          changed = gone.length > 0 || changed
        } else {
          // In place: the option's place changes and the votes for it follow it (on update cascade).
          const option = tables.slot_options.find((o) => o.slot_id === slot.id && o.venue_id === op.from)
          if (option) {
            option.venue_id = op.to
            publish('slot_options', 'UPDATE', option)
            for (const vote of tables.votes.filter((v) => v.slot_id === slot.id && v.venue_id === op.from)) {
              vote.venue_id = op.to
              vote.updated_at = iso(now())
              publish('votes', 'UPDATE', vote)
            }
            changed = true
          }
        }
      } else if (op.op === 'resolve_proposal') {
        // Stage 5, only the part a guest opting out of a confirmed plan needs: the proposals they had waiting are dismissed in the same
        // write (migration 20261023000000). Only while the plan stays confirmed; one already answered changes nothing.
        if (!(s.status === 'confirmed' && newStatus === 'confirmed')) throw ruleBroken('proposal_status', 'A proposal is answered only while the plan is confirmed.')
        if (!['accepted', 'dismissed'].includes(op.status)) throw new DbError('23514', 'new row for relation "stop_proposals" violates check constraint "stop_proposals_status_check"')
        const waiting = tables.stop_proposals.find((x) => x.session_id === sid && x.id === op.proposal_id && x.status === 'pending')
        if (waiting) {
          Object.assign(waiting, { status: op.status, resolved_at: iso(now()), resolved_by: op.by ?? null })
          publish('stop_proposals', 'UPDATE', waiting)
          changed = true
        }
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

    // The slots and their options, as a difference (never delete-everything-then-insert, which would delete every vote). One item per
    // category: `remove` deletes the slot row; otherwise the slot is made (it then needs start_minute and duration_minutes) or only the
    // fields the item carries change. `options` is the slot's complete list: a listed place is inserted, or has its rank, score and
    // details updated (its source, who added it and its votes stay); an unlisted place is deleted and takes its votes. A slot without
    // `options` keeps its options. A deleted slot has none. Each is a change only where it alters a stored value.
    const sessionSlots = () => tables.slots.filter((sl) => sl.session_id === sid)
    if (has(patch, 'slots')) {
      if (!Array.isArray(patch.slots)) throw new DbError('22023', 'The slots must be a JSON list.')
      for (const item of patch.slots) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new DbError('22023', 'Each slot must be a JSON object.')
        if (item.remove === true) {
          const gone = sessionSlots().filter((sl) => sl.category === item.category)
          cascade('slots', gone)
          changed = gone.length > 0 || changed
          continue
        }
        let slot = sessionSlots().find((sl) => sl.category === item.category)
        if (!slot) {
          slot = insertSlot({
            session_id: sid,
            category: item.category,
            start_minute: item.start_minute ?? null,
            duration_minutes: item.duration_minutes ?? null,
            picks: item.picks ?? 0,
            is_last: item.is_last ?? false,
            deleted: item.deleted ?? false,
            details: item.details ?? {},
          })
          changed = true
        } else {
          const next = {
            ...slot,
            start_minute: item.start_minute ?? slot.start_minute,
            duration_minutes: item.duration_minutes ?? slot.duration_minutes,
            picks: item.picks ?? slot.picks,
            is_last: item.is_last ?? slot.is_last,
            deleted: item.deleted ?? slot.deleted,
            details: has(item, 'details') ? structuredClone(item.details) : slot.details,
          }
          checkSlot(next)
          if (!sameJson(next, slot)) {
            Object.assign(slot, next, { updated_at: iso(now()) })
            publish('slots', 'UPDATE', slot)
            changed = true
          }
        }
        if (slot.deleted) {
          // A removed slot has no options, and so no votes.
          const gone = tables.slot_options.filter((o) => o.slot_id === slot.id)
          cascade('slot_options', gone)
          changed = gone.length > 0 || changed
        } else if (has(item, 'options')) {
          if (!Array.isArray(item.options)) throw new DbError('22023', 'The options of a slot must be a JSON list.')
          const listed = new Set(item.options.map((o) => o.venue_id))
          const stale = tables.slot_options.filter((o) => o.slot_id === slot.id && !listed.has(o.venue_id))
          cascade('slot_options', stale)
          changed = stale.length > 0 || changed
          for (const wanted of item.options) {
            const existing = tables.slot_options.find((o) => o.slot_id === slot.id && o.venue_id === wanted.venue_id)
            const fields = { rank: wanted.rank ?? null, score: wanted.score ?? null, details: structuredClone(wanted.details ?? {}) }
            if (!existing) {
              insertOption({ slot_id: slot.id, venue_id: wanted.venue_id, source: wanted.source ?? 'planner', added_by: wanted.added_by ?? null, ...fields })
              changed = true
            } else if (!sameJson(fields, { rank: existing.rank, score: existing.score, details: existing.details })) {
              Object.assign(existing, fields)
              publish('slot_options', 'UPDATE', existing)
              changed = true
            }
          }
        }
      }
      // Votes belong to the person, not to their membership: those of anyone who is not a joined member go now.
      changed = dropVotes((v) => !joinedIn(v.user_id, sid)) || changed
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
    // A banner sent without its time is stamped by the database's clock when it is written, so a newer notice always has a later
    // `at` than an older one. It differs from the stored one only apart from that time.
    const stampedBanner = has(sp, 'banner') && sp.banner !== null && typeof sp.banner === 'object' && !has(sp.banner, 'at')
    // A release brings its notice afresh (always a change), and a release with none clears the old one.
    const bannerChanged = released
      ? (has(sp, 'banner') && sp.banner != null ? true : (s.banner ?? null) !== null)
      : has(sp, 'banner') && !sameJson(stampedBanner && s.banner ? (({ at: _at, ...rest }) => rest)(s.banner) : s.banner ?? null, sp.banner ?? null)
    // A joined member whose stored minutes differ from the new ones counts as a change (when they have stored minutes at all): two
    // people can swap their times with the longest trip, the total and the count the same.
    const travelChanged = has(sp, 'meeting') && meeting && typeof meeting === 'object' && !!meeting.travel &&
      tables.session_members.some((m) => m.session_id === sid && m.state === 'joined' && m.travel_minutes != null &&
        (has(meeting.travel, m.user_id) ? Math.round(meeting.travel[m.user_id]) : null) !== m.travel_minutes)
    // The radius the host chose (100 to 3000 metres, or null for the planner's own widening); the table's own check refuses the rest.
    const radiusChanged = has(sp, 'radius_meters') && (s.radius_meters ?? null) !== (sp.radius_meters ?? null)
    if (radiusChanged && sp.radius_meters != null && !(Number.isInteger(sp.radius_meters) && sp.radius_meters >= 100 && sp.radius_meters <= 3000)) {
      throw new DbError('23514', 'new row for relation "sessions" violates check constraint "sessions_radius_meters_check"')
    }
    // The "plan again?" prompt a guest's opting out of a confirmed plan writes: an object or null, a change only where it differs.
    if (has(sp, 'replan') && sp.replan != null && (typeof sp.replan !== 'object' || Array.isArray(sp.replan))) {
      throw new DbError('22023', 'The re-plan prompt must be a JSON object or null.')
    }
    const replanChanged = has(sp, 'replan') && !sameJson(s.replan ?? null, sp.replan ?? null)
    if (meetingChanged || travelChanged || bannerChanged || radiusChanged || bannerText !== null || replanChanged) changed = true
    if (!changed) return Number(s.plan_version)

    // Each joined member's own minutes to the confirmed area.
    if (has(sp, 'meeting') && meeting && typeof meeting === 'object' && meeting.travel) {
      // Only a member whose stored minutes differ is written (and so has their updated_at moved), as in the function.
      for (const m of tables.session_members.filter((row) => row.session_id === sid && row.state === 'joined')) {
        const minutes = has(meeting.travel, m.user_id) ? Math.round(meeting.travel[m.user_id]) : null
        if ((m.travel_minutes ?? null) !== minutes) changeMember(m, { travel_minutes: minutes })
      }
    }
    // Leaving confirmed, or entering it, clears the prompt; otherwise the patch's prompt is kept.
    // Pending proposals are dismissed whenever a session leaves confirmed (the stage 5 rule), and the plan's own columns go with a release.
    if (s.status === 'confirmed' && newStatus !== 'confirmed') {
      for (const p of tables.stop_proposals.filter((x) => x.session_id === sid && x.status === 'pending')) Object.assign(p, { status: 'dismissed', resolved_at: iso(now()) })
    }
    if (released || (s.status === 'confirmed' && newStatus !== 'confirmed') || (s.status === 'voting' && newStatus === 'confirmed')) s.replan = null
    else if (has(sp, 'replan')) s.replan = sp.replan ?? null
    if (released) Object.assign(s, { order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null, weather_kept: null, meet_by: releaseOp.meet_by })
    s.status = newStatus
    if (radiusChanged) s.radius_meters = sp.radius_meters ?? null
    if (released) {
      Object.assign(s, { meeting_area_id: null, meeting_method: null, meeting_max_minutes: null, meeting_total_minutes: null, meeting_count: null, meeting_approximate: null, meeting_computed_at: null })
    } else if (meetingChanged) {
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
    else if (bannerChanged && stampedBanner) s.banner = { ...sp.banner, at: now() }
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
      guardClash(as, found.session)
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
    // Each joined member's private planner needs, for the server only (db/schema.sql session_member_needs()): one row per joined
    // member who has a private row. A member who opted out has none; nobody else may call it.
    session_member_needs({ as, args }) {
      if (as !== SERVICE) throw new DbError('42501', 'permission denied for function session_member_needs', { status: 403 })
      return tables.session_members
        .filter((m) => m.session_id === args.sid && m.state === 'joined' && privateNeeds.has(m.user_id))
        .map((m) => {
          const row = privateNeeds.get(m.user_id)
          return {
            user_id: m.user_id,
            home_area_id: row.home_area_id ?? null,
            dietary: structuredClone(row.dietary ?? []),
            budget_max_per_person: row.budget_max_per_person ?? null,
            needs_step_free: row.needs_step_free ?? false,
          }
        })
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
      return { data: null, error: { message: err.message, code: err.code, details: err.details ?? null, hint: err.hint }, status: err.status }
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

  // Gives a person private planner needs, as their `profile_private` row would hold them.
  // How to call: db.setNeeds(uid, { dietary: ['halal'], needs_step_free: false })
  const setNeeds = (id, row) => privateNeeds.set(id, structuredClone(row))

  return Object.assign(self, { canSee, run, subscribe, setNeeds, setProfile, getProfiles, usernameTaken, profileByUsername, setToken, userForToken, tables, functionNames: Object.keys(functions) })
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
