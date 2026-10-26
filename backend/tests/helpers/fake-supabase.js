import { generateKeyPairSync, randomUUID, sign } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'

// A stand-in for Supabase, for the session tests. Nothing here touches the network.
//
// The database is a `world` of arrays, one per table. Two kinds of client read it:
//   - a user's client (`forUser`) sees only what the access rules in db/policies.sql let that person see, and can write only
//     what a browser may write directly: "Works for me" (spot_approvals), a member's own start and end area and picks, their own
//     exact place, and their own vote (votes);
//   - the service client (`service`) sees everything, is the only one that may call apply_session_plan, and records every request.
// `applySessionPlan` below is a JavaScript twin of the SQL function in db/migrations/20261020000000_jio_apply_session_plan.sql (stage 3)
// as extended by db/migrations/20261022000000_jio_apply_session_plan_slots.sql (stage 4: slots, options, votes, the radius) and
// db/migrations/20261023000000_jio_apply_session_plan_stops.sql (stage 5: the plan's stops, their order, proposals, finishing and the ledger).
// and db/migrations/20261027000000_jio_change_meeting_place.sql (the op `release_meeting`: the host changes the meeting place).
// It is a second implementation of the same rules, so the real function must still be tested on the live project
// (db/tests/apply_session_plan.sql); the point of the twin is that the server's code can be tested offline.
//
// How to use it:
//   const world = createWorld()
//   const supabase = fakeSupabase(world)            // { service, forUser, verifyToken } as createSupabase() gives
//   await supabase.service.rpc('apply_session_plan', { sid, expected_version: 0, expected_status: 'locating', patch })

export const SUPABASE_URL = 'https://project.supabase.test'

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
export const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig', key_ops: ['verify'] }

// A login token for a person, signed the way Supabase Auth does.
//
// How to call:
//   tokenFor('1111111a-1111-4111-8111-11111111111b')
export function tokenFor(id) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', typ: 'JWT', kid: 'key-1' })
  const body = b64({ iss: `${SUPABASE_URL}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: id, email: 'x@example.test', iat: now, exp: now + 3600 })
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

// The fetch function that serves the public signing key the way Supabase does, so the login check is the real code.
//
// How to call:
//   createSupabase({ url: SUPABASE_URL, anonKey: 'a', serviceKey: 's', fetchImpl: jwksFetch })
export async function jwksFetch(input) {
  const url = new URL(typeof input === 'string' ? input : input.url)
  if (url.pathname === '/auth/v1/.well-known/jwks.json') {
    return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return new Response('{}', { status: 404 })
}

const TABLES = ['sessions', 'session_members', 'session_spots', 'spot_suggestions', 'spot_approvals', 'slots', 'slot_options', 'votes', 'stops', 'stop_proposals', 'commute_ledger', 'profiles', 'profile_private', 'session_member_places']

// An empty database. `calls` records every request: { table | rpc, kind, who } with who = the user id, or null for the service key.
// Fields a test may set:
//   hooks.beforeApply   (args) => void, run inside apply_session_plan before it looks at the session: to play another writer
//   staleApply          a number: that many calls answer null (the session "moved on") without writing
//   failApply           true: apply_session_plan fails as a database error
//   hangApply           true: apply_session_plan never answers (a database that hung)
//   hangReads           true: the service key's reads never answer
//   hooks.beforeRead    ({ table }) => void | Promise, run before each read by the service key: to play a request that arrives while a run loads
//                       (a promise holds the read until it settles)
//   profile_private     [{ id, dietary, home_area_id, budget_max_per_person, needs_step_free }]: the private rows that
//                       session_member_needs reads (no client may read them as a table)
//   failNeeds           true: session_member_needs fails as a database error
//   failDebt            true: session_travel_debt fails as a database error (the function is not on the project yet, say)
//   failPast            true: the server's read of the finished outings of the group (the members' outings, a read of session_members by user) fails as a database error
//
// How to call:
//   const world = createWorld()
export function createWorld() {
  const world = { calls: [], hooks: {}, staleApply: 0, failApply: false, failNeeds: false, failDebt: false, failPast: false, hangApply: false, hangReads: false, t: Date.parse('2026-10-20T08:00:00Z') }
  for (const table of TABLES) world[table] = []
  return world
}

// The next moment, one millisecond on from the last, as the timestamp Postgres would write.
//
// How to call:
//   created_at: tick(world)
export function tick(world) {
  world.t += 1
  return new Date(world.t).toISOString()
}

// A database error in the shape supabase-js hands back. How to call: throw dbError('P0001', 'The meeting area is pinned.', 'area_pinned')
const dbError = (code, message, hint) => ({ code, message, ...(hint && { hint }) })

const UUID_LOWER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const UUID_ANY = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Are two values equal as the database sees them? A uuid is equal to the same uuid in any case, as Postgres compares them.
//
// How to call:
//   sameValue('AAAAAAAA-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa') // true
const sameValue = (a, b) => a === b || (typeof a === 'string' && typeof b === 'string' && UUID_ANY.test(a) && UUID_ANY.test(b) && a.toLowerCase() === b.toLowerCase())

// The database's own checks on a row of session_spots (db/schema.sql), so a row the server should never write is caught here.
//
// How to call:
//   checkSpot({ area_id: 'bishan', rank: 1, worst_minutes: 30, mean_minutes: 25, travel_minutes: {} })
function checkSpot(row) {
  const bad = (why) => {
    throw dbError('23514', `session_spots check failed: ${why}`)
  }
  if (typeof row.area_id !== 'string' || row.area_id.length < 1 || row.area_id.length > 60) bad('area_id')
  if (row.rank !== null && row.rank !== undefined && ![1, 2, 3].includes(row.rank)) bad('rank')
  for (const key of ['worst_minutes', 'mean_minutes']) if (!(typeof row[key] === 'number' && row[key] >= 0 && row[key] <= 1440)) bad(key)
  if (row.mean_minutes > row.worst_minutes + 0.001) bad('mean_minutes above worst_minutes')
  const minutes = row.travel_minutes
  if (minutes === null || typeof minutes !== 'object' || Array.isArray(minutes)) bad('travel_minutes is not an object')
  for (const [id, value] of Object.entries(minutes)) {
    if (!UUID_LOWER.test(id)) bad(`travel_minutes key ${id}`)
    if (!(typeof value === 'number' && value >= 0 && value <= 1440)) bad(`travel_minutes value for ${id}`)
  }
}

// The database's own checks on a slot and on an option (db/schema.sql), so a row the server should never write is caught here.
//
// How to call:
//   checkSlot({ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, details: {} })
//   checkOption(world, { venue_id: 'a', source: 'planner' })
function checkSlot(row) {
  const bad = (why, code = '23514') => {
    throw dbError(code, `slots check failed: ${why}`)
  }
  if (!['eat', 'drink', 'shop', 'activity'].includes(row.category)) bad('category')
  if (!Number.isInteger(row.start_minute)) bad('start_minute is null or not a whole number', '23502')
  if (!Number.isInteger(row.duration_minutes)) bad('duration_minutes is null or not a whole number', '23502')
  if (row.start_minute < 0 || row.start_minute > 1439) bad('start_minute')
  if (row.duration_minutes < 1 || row.duration_minutes > 720) bad('duration_minutes')
  if (row.details === null || typeof row.details !== 'object' || Array.isArray(row.details) || Buffer.byteLength(JSON.stringify(row.details)) > 4000) bad('details')
}
function checkOption(world, row) {
  const bad = (why, code = '23514') => {
    throw dbError(code, `slot_options check failed: ${why}`)
  }
  if (typeof row.venue_id !== 'string' || row.venue_id.length < 1 || row.venue_id.length > 160) bad('venue_id')
  if (!['planner', 'member'].includes(row.source)) bad('source')
  if (row.added_by && !world.profiles.some((p) => sameValue(p.id, row.added_by))) bad('added_by is not a profile', '23503')
}

// The database's own checks on a stop, a proposal, a ledger row and the plan's columns of a session (db/schema.sql).
//
// How to call:
//   checkStop({ seq: 0, venue_id: 'a', category: 'eat', planned_start_minute: 720, duration_minutes: 90, travel_mode: null })
function checkStop(row) {
  const bad = (why, code = '23514') => {
    throw dbError(code, `stops check failed: ${why}`)
  }
  for (const key of ['seq', 'planned_start_minute', 'duration_minutes']) if (!Number.isInteger(row[key])) bad(`${key} is null or not a whole number`, '23502')
  if (typeof row.venue_id !== 'string' || row.venue_id.length < 1 || row.venue_id.length > 160) bad('venue_id')
  if (row.seq < 0) bad('seq')
  if (row.planned_start_minute < 0 || row.planned_start_minute > 1439) bad('planned_start_minute')
  if (row.duration_minutes < 1 || row.duration_minutes > 720) bad('duration_minutes')
  if (row.category !== null && !['eat', 'drink', 'shop', 'activity'].includes(row.category)) bad('category')
  if (row.travel_mode !== null && !['walk', 'mrt', 'car'].includes(row.travel_mode)) bad('travel_mode')
  if (row.not_before_minute !== null && !(Number.isInteger(row.not_before_minute) && row.not_before_minute >= 0 && row.not_before_minute <= 1439)) bad('not_before_minute')
}
function checkLedger(row) {
  for (const key of ['minutes_in', 'minutes_between', 'minutes_home']) {
    if (!(Number.isInteger(row[key]) && row[key] >= 0)) throw dbError('23514', `commute_ledger check failed: ${key}`)
  }
}
function checkOrder({ note, suggestion }) {
  const bad = (why) => {
    throw dbError('23514', `sessions check failed: ${why}`)
  }
  if (note !== null) {
    const { reason, source } = note
    if ((reason === undefined || reason === null) !== (source === undefined || source === null)) bad('order_note_pair')
    if (reason != null && !(typeof reason === 'string' && reason.length >= 1 && reason.length <= 200)) bad('order_reason_length')
    if (source != null && !['ai', 'rules'].includes(source)) bad('order_source_values')
  }
  if (suggestion !== null) {
    if (typeof suggestion !== 'object' || Array.isArray(suggestion) || Buffer.byteLength(JSON.stringify(suggestion)) > 4000) bad('order_suggestion_shape')
    if (!/^[0-9a-f]{64}$/.test(String(suggestion.basis ?? ''))) bad('order_suggestion_shape')
    if (!Array.isArray(suggestion.order) || suggestion.order.length > 8) bad('order_suggestion_shape')
  }
}

// The parts of a plan the function knows (anything else is refused with 22023), and of its session part.
const PLAN_KEYS = ['ops', 'spots', 'slots', 'stops', 'stop_options', 'ledger', 'session', 'loaded_at', 'recomputed', 'banner_text']
const SESSION_PLAN_KEYS = ['status', 'meeting', 'banner', 'radius_meters', 'replan', 'plan_start_minute', 'order_note', 'order_suggestion', 'weather_kept']

// The exact sum of decimal numbers, as the database's numeric column adds them: in millionths, in BigInt, so 0.1 + 0.2 is 0.3.
//
// How to call:
//   decimalSum([0.1, 0.2, -0.3]) // 0n
function decimalSum(values) {
  return values.reduce((sum, value) => sum + BigInt(Math.round(Number(value) * 1e6)), 0n)
}

// A JavaScript twin of apply_session_plan(sid, expected_version, expected_status, patch). Returns the new version, null when the
// session moved on, or the current version when nothing changed. Throws a database error object for the rules and the checks.
//
// How to call:
//   const version = applySessionPlan(world, { sid, expected_version: 4, expected_status: 'locating', patch: { ops: [], spots: [] } })
export function applySessionPlan(world, { sid, expected_version: expectedVersion, expected_status: expectedStatus, patch }) {
  world.hooks.beforeApply?.({ sid, expectedVersion, expectedStatus, patch })
  if (patch === null || typeof patch !== 'object' || Array.isArray(patch)) throw dbError('22023', 'The plan must be a JSON object.')
  // A part of the plan the function does not know is refused, before the session is read (so a late write with a typo is refused too).
  const unknownKey = Object.keys(patch).find((k) => !PLAN_KEYS.includes(k))
  if (unknownKey !== undefined) throw dbError('22023', `The plan has a part this function does not know: ${unknownKey}.`)
  if (Object.prototype.hasOwnProperty.call(patch, 'session')) {
    if (patch.session === null || typeof patch.session !== 'object' || Array.isArray(patch.session)) throw dbError('22023', 'The session part of the plan must be a JSON object.')
    const unknownSessionKey = Object.keys(patch.session).find((k) => !SESSION_PLAN_KEYS.includes(k))
    if (unknownSessionKey !== undefined) throw dbError('22023', `The session part of the plan has a part this function does not know: ${unknownSessionKey}.`)
  }
  const session = world.sessions.find((s) => sameValue(s.id, sid))
  if (world.staleApply > 0) {
    world.staleApply -= 1
    return null
  }
  if (!session || Number(session.plan_version) !== Number(expectedVersion) || session.status !== expectedStatus) return null

  // Everything below is undone if a rule or a check fails, as a transaction would be.
  const snapshot = structuredClone({
    sessions: world.sessions,
    session_members: world.session_members,
    session_member_places: world.session_member_places,
    session_spots: world.session_spots,
    spot_suggestions: world.spot_suggestions,
    spot_approvals: world.spot_approvals,
    slots: world.slots,
    slot_options: world.slot_options,
    votes: world.votes,
    stops: world.stops,
    stop_proposals: world.stop_proposals,
    commute_ledger: world.commute_ledger,
  })
  try {
    return apply(world, session, patch)
  } catch (err) {
    for (const [name, rows] of Object.entries(snapshot)) world[name] = rows
    throw err
  }
}

// A figure rounded the way the database writes it into an integer column, or null when there is none.
//
// How to call:
//   roundOrNull(10.4) // 10
const roundOrNull = (value) => (value === undefined || value === null ? null : Math.round(Number(value)))

// The body of the twin, run on a session already locked and found current. It enforces the same rules in the same order as the SQL:
// a pinned meeting stays; a status moves only from inviting or locating to voting with an area; a pin comes only with that move (or
// when the same pin is stored); slots, options and their votes are written only in a voting session (rule 7); the host is never
// opted out or removed; leaving inviting needs two joined members after the ops; and the version rises only when a value differs
// from the stored row.
//
// How to call (applySessionPlan does this):
//   const version = apply(world, session, patch)
function apply(world, session, patch) {
  const sid = session.id
  const sp = patch.session ?? {}
  const meeting = sp.meeting
  const has = (object, key) => Object.prototype.hasOwnProperty.call(object, key)
  let changed = false
  // When the server loaded the members the spots are worked out from; absent, the moment of the write.
  const loadedAt = patch.loaded_at ? new Date(patch.loaded_at) : null
  if (loadedAt && Number.isNaN(loadedAt.getTime())) throw dbError('22007', `invalid input syntax for type timestamp with time zone: "${patch.loaded_at}"`)
  // Never later than the database's clock, as least(loaded_at, now()) in the SQL.
  const stamp = () => { const now = tick(world); return loadedAt && loadedAt.toISOString() < now ? loadedAt.toISOString() : now }
  const newStatus = sp.status ?? session.status
  const moving = newStatus !== session.status

  // Rule 9: the host changes the meeting place. The op releases the meeting area and sends the session back to locating; it is valid only on
  // that move (from voting or confirmed), and that move is valid only with it. It names the host's new choice, and brings no meeting.
  const releaseOp = Array.isArray(patch.ops) ? patch.ops.find((o) => o?.op === 'release_meeting') : undefined
  const released = releaseOp !== undefined
  if (released) {
    if (!(['voting', 'confirmed'].includes(session.status) && newStatus === 'locating')) {
      throw dbError('P0001', 'The meeting area is released only by moving a voting or confirmed session back to locating.', 'release_status')
    }
    if (sp.meeting !== undefined && sp.meeting !== null) throw dbError('P0001', 'A released session has no meeting area, so the patch cannot bring one.', 'release_meeting')
    if (!['fairest', 'known'].includes(releaseOp.meet_by)) throw dbError('22023', 'A release says how the meeting point is picked again: fairest or known.')
  }

  // Rule 4: a pinned meeting area stays (unless the host is releasing it, Rule 9).
  if (!released && has(sp, 'meeting') && ['voted', 'chosen'].includes(session.meeting_method) && ((meeting?.area_id ?? null) !== session.meeting_area_id || (meeting?.method ?? null) !== session.meeting_method)) {
    throw dbError('P0001', 'The meeting area was chosen and cannot be changed by a recompute.', 'area_pinned')
  }
  // Rule 1: the moves are inviting or locating to voting (with an area), and the plan's: voting to confirmed, confirmed to voting (the
  // plan is opened again) and confirmed to completed.
  if (moving) {
    const allowed =
      (['inviting', 'locating'].includes(session.status) && newStatus === 'voting' && !!meeting?.area_id) ||
      (session.status === 'voting' && newStatus === 'confirmed') ||
      (session.status === 'confirmed' && ['voting', 'completed'].includes(newStatus)) ||
      (released && ['voting', 'confirmed'].includes(session.status) && newStatus === 'locating')
    if (!allowed) throw dbError('P0001', `A session cannot go from ${session.status} to ${newStatus} this way.`, 'status_transition')
    changed = true
  }
  const reopened = session.status === 'confirmed' && newStatus === 'voting'
  // Rule 5: a pin only with the host's confirm: the move from inviting or locating to voting in this patch, or the same pin already stored.
  if (['voted', 'chosen'].includes(meeting?.method) && !(['inviting', 'locating'].includes(session.status) && newStatus === 'voting') && !(session.meeting_method === meeting.method && (session.meeting_area_id ?? null) === (meeting.area_id ?? null))) {
    throw dbError('P0001', 'A meeting area is pinned only when the host confirms it.', 'pin_without_confirm')
  }
  // Rule 7: slots and options are written only while the session is voting (after this patch).
  if (has(patch, 'slots') && newStatus !== 'voting') {
    throw dbError('P0001', 'Slots and options are written only while the session is voting.', 'slots_status')
  }

  // Rule 8 (stage 5): the stops, a stop's place details, the order note and the plan's start only while confirmed (after this patch); the
  // suggested order only while voting; the ledger only with the move to completed; confirming needs stops.
  const given = (key) => has(sp, key) && sp[key] !== null
  if ((has(patch, 'stops') || has(patch, 'stop_options') || given('plan_start_minute') || given('order_note') || given('weather_kept')) && newStatus !== 'confirmed') {
    throw dbError('P0001', 'The stops and the order of the plan are written only while the session is confirmed.', 'stops_status')
  }
  if (given('order_suggestion') && !(session.status === 'voting' && newStatus === 'voting')) {
    throw dbError('P0001', 'The suggested order is written only while the session is voting.', 'order_status')
  }
  if (has(patch, 'ledger') && !(session.status === 'confirmed' && newStatus === 'completed')) {
    throw dbError('P0001', 'The ledger is written only when the outing is finished.', 'ledger_status')
  }
  if (session.status === 'confirmed' && newStatus === 'completed' && !has(patch, 'ledger')) {
    throw dbError('P0001', 'Finishing the outing needs its ledger.', 'ledger_missing')
  }
  if (session.status === 'voting' && newStatus === 'confirmed' && !(Array.isArray(patch.stops) && patch.stops.length > 0)) {
    throw dbError('P0001', 'A plan needs at least one stop before it can be confirmed.', 'stops_missing')
  }

  const dropApprovals = (test) => {
    const before = world.spot_approvals.length
    world.spot_approvals = world.spot_approvals.filter((a) => !(a.session_id === sid && test(a)))
    return before !== world.spot_approvals.length
  }
  const dropSuggestions = (test) => {
    const before = world.spot_suggestions.length
    world.spot_suggestions = world.spot_suggestions.filter((g) => !(g.session_id === sid && test(g)))
    return before !== world.spot_suggestions.length
  }

  const slotsOfSession = () => world.slots.filter((x) => x.session_id === sid)
  // Votes of this session's slots, removed where `test` says so. Answers whether any went.
  const dropVotes = (test) => {
    const mine = new Set(slotsOfSession().map((x) => x.id))
    const before = world.votes.length
    world.votes = world.votes.filter((v) => !(mine.has(v.slot_id) && test(v)))
    return before !== world.votes.length
  }
  // Options of a slot, removed where `test` says so; the votes for a removed option go with it (the foreign key). Answers whether any went.
  const dropOptions = (slotId, test) => {
    const gone = world.slot_options.filter((o) => o.slot_id === slotId && test(o))
    if (gone.length === 0) return false
    world.slot_options = world.slot_options.filter((o) => !gone.includes(o))
    world.votes = world.votes.filter((v) => !(v.slot_id === slotId && gone.some((o) => o.venue_id === v.venue_id)))
    return true
  }

  for (const op of patch.ops ?? []) {
    const user = op.user_id
    const member = world.session_members.find((m) => m.session_id === sid && m.user_id === user)
    // Rule 6: the host is never opted out or removed here.
    if ((op.op === 'opt_out' || op.op === 'remove_member') && sameValue(user, session.host_id)) {
      throw dbError('P0001', op.op === 'opt_out' ? 'The host cannot opt out.' : 'The host cannot be removed.', 'host_member')
    }
    if (op.op === 'opt_out') {
      if (member?.state === 'joined') {
        member.state = 'opted_out'
        changed = true
      }
      changed = dropApprovals((a) => a.user_id === user) || changed
      changed = dropSuggestions((g) => g.user_id === user) || changed
      changed = dropVotes((v) => sameValue(v.user_id, user)) || changed
    } else if (op.op === 'rejoin') {
      if (member?.state === 'opted_out') {
        member.state = 'joined'
        changed = true
      }
    } else if (op.op === 'remove_member') {
      if (member) {
        world.session_members = world.session_members.filter((m) => m !== member)
        world.session_member_places = world.session_member_places.filter((p) => !(p.session_id === sid && p.user_id === user))
        dropApprovals((a) => a.user_id === user)
        dropSuggestions((g) => g.user_id === user)
        changed = true
      }
      changed = dropVotes((v) => sameValue(v.user_id, user)) || changed
    } else if (op.op === 'suggest') {
      if (!member) throw dbError('23503', 'spot_suggestions: the member is not in the session')
      const here = op.here ?? false
      const existing = world.spot_suggestions.find((g) => g.session_id === sid && g.user_id === user)
      if (!existing) {
        world.spot_suggestions.push({ session_id: sid, user_id: user, area_id: op.area_id, here, created_at: tick(world) })
        changed = true
      } else if (existing.area_id !== op.area_id || existing.here !== here) {
        Object.assign(existing, { area_id: op.area_id, here, created_at: tick(world) })
        changed = true
      }
    } else if (op.op === 'unsuggest') {
      changed = dropSuggestions((g) => g.user_id === user) || changed
    } else if (op.op === 'clear_approvals') {
      changed = dropApprovals(() => true) || changed
    } else if (op.op === 'clear_suggestions') {
      changed = dropSuggestions(() => true) || changed
    } else if (op.op === 'clear_votes') {
      if (!(session.status === 'voting' || reopened)) throw dbError('P0001', 'Votes are cleared only while the session is voting.', 'slots_status')
      changed = dropVotes(() => true) || changed
    } else if (op.op === 'release_meeting') {
      // Rule 9: everything that belonged to the meeting place goes in this write; starts, ends, exact places, picks and members stay.
      const mySlots = new Set(slotsOfSession().map((x) => x.id))
      world.votes = world.votes.filter((v) => !mySlots.has(v.slot_id))
      world.slot_options = world.slot_options.filter((o) => !mySlots.has(o.slot_id))
      world.slots = world.slots.filter((x) => x.session_id !== sid)
      world.stops = world.stops.filter((x) => x.session_id !== sid)
      dropApprovals(() => true)
      dropSuggestions(() => true)
      world.session_spots = world.session_spots.filter((x) => x.session_id !== sid)
      // (The members' own minutes are left as they are: a write would move their updated_at past the new spots' computed_at.)
      changed = true
    } else if (op.op === 'swap_option') {
      if (session.status !== 'voting') throw dbError('P0001', 'An option is swapped only while the session is voting.', 'slots_status')
      const slot = slotsOfSession().find((x) => x.category === op.category)
      if (!slot) throw dbError('P0001', `This session has no ${op.category} slot.`, 'slot_missing')
      if (op.from === op.to) {
        // The same place: nothing to swap.
      } else if (world.slot_options.some((o) => o.slot_id === slot.id && o.venue_id === op.to)) {
        // The other place is already an option: the votes move to it and this one goes.
        const moved = world.votes.filter((v) => v.slot_id === slot.id && v.venue_id === op.from)
        for (const v of moved) v.venue_id = op.to
        changed = moved.length > 0 || changed
        changed = dropOptions(slot.id, (o) => o.venue_id === op.from) || changed
      } else {
        // In place: the votes follow the option (on update cascade).
        const option = world.slot_options.find((o) => o.slot_id === slot.id && o.venue_id === op.from)
        if (option) {
          option.venue_id = op.to
          for (const v of world.votes.filter((row) => row.slot_id === slot.id && row.venue_id === op.from)) v.venue_id = op.to
          changed = true
        }
      }
    } else if (op.op === 'propose') {
      if (!(session.status === 'confirmed' && newStatus === 'confirmed')) throw dbError('P0001', 'A place is proposed only while the plan is confirmed.', 'proposal_status')
      if (member?.state !== 'joined') throw dbError('P0001', 'Only a joined member can propose a place.', 'proposal_member')
      if (world.stops.some((x) => x.session_id === sid && x.venue_id === op.venue_id)) throw dbError('P0001', 'That place is already in the plan.', 'already_a_stop')
      const pending = world.stop_proposals.filter((x) => x.session_id === sid && x.status === 'pending')
      if (!pending.some((x) => x.venue_id === op.venue_id)) {
        if (world.stops.filter((x) => x.session_id === sid).length >= 8) throw dbError('P0001', 'The plan already has the most stops it can hold.', 'plan_full')
        if (pending.length >= 10 || pending.filter((x) => x.proposed_by === user).length >= 3) throw dbError('P0001', 'Too many places are waiting for an answer.', 'too_many_proposals')
        if (typeof op.venue_id !== 'string' || op.venue_id.length < 1 || op.venue_id.length > 160) throw dbError('23514', 'stop_proposals check failed: venue_id')
        world.stop_proposals.push({ id: op.id ?? randomUUID(), session_id: sid, venue_id: op.venue_id, proposed_by: user, status: 'pending', created_at: tick(world), resolved_at: null, resolved_by: null })
        changed = true
      }
    } else if (op.op === 'resolve_proposal') {
      if (!(session.status === 'confirmed' && newStatus === 'confirmed')) throw dbError('P0001', 'A proposal is answered only while the plan is confirmed.', 'proposal_status')
      if (!['accepted', 'dismissed'].includes(op.status)) throw dbError('22023', 'A proposal is answered as accepted or dismissed.')
      const proposal = world.stop_proposals.find((x) => x.session_id === sid && sameValue(x.id, op.proposal_id) && x.status === 'pending')
      if (proposal) {
        Object.assign(proposal, { status: op.status, resolved_at: tick(world), resolved_by: op.by ?? null })
        changed = true
      }
    } else {
      throw dbError('22023', `Unknown operation ${op.op}.`)
    }
  }

  // Rule 2: leaving inviting needs two joined members, counted after the ops.
  if (session.status === 'inviting' && moving && world.session_members.filter((m) => m.session_id === sid && m.state === 'joined').length < 2) {
    throw dbError('P0001', 'A session needs at least two people before it can start.', 'needs_two_people')
  }

  let bannerText = null
  if (has(patch, 'spots')) {
    if (!Array.isArray(patch.spots)) throw dbError('22023', 'The spots must be a JSON list.')
    const listed = new Set(patch.spots.map((r) => r.area_id))
    const lostApprovals = world.spot_approvals.some((a) => a.session_id === sid && !listed.has(a.area_id))
    const goneSpots = world.session_spots.filter((x) => x.session_id === sid && !listed.has(x.area_id))
    if (goneSpots.length > 0) {
      world.session_spots = world.session_spots.filter((x) => !goneSpots.includes(x))
      world.spot_approvals = world.spot_approvals.filter((a) => !(a.session_id === sid && !listed.has(a.area_id)))
      changed = true
    }
    for (const row of patch.spots) {
      const next = {
        session_id: sid,
        area_id: row.area_id,
        rank: row.rank ?? null,
        worst_minutes: Number(row.worst_minutes),
        mean_minutes: Number(row.mean_minutes),
        travel_minutes: row.travel_minutes ?? {},
        approximate: row.approximate ?? false,
      }
      checkSpot(next)
      const existing = world.session_spots.find((x) => x.session_id === sid && x.area_id === row.area_id)
      if (!existing) {
        world.session_spots.push({ ...next, computed_at: stamp() })
        changed = true
      } else {
        const same = ['rank', 'worst_minutes', 'mean_minutes', 'approximate'].every((k) => existing[k] === next[k]) && JSON.stringify(existing.travel_minutes) === JSON.stringify(next.travel_minutes)
        if (!same) {
          Object.assign(existing, next, { computed_at: stamp() })
          changed = true
        }
      }
    }
    // The ranks are unique in a session (checked at the end of the transaction).
    const ranks = world.session_spots.filter((x) => x.session_id === sid && x.rank !== null).map((x) => x.rank)
    if (new Set(ranks).size !== ranks.length) throw dbError('23505', 'session_spots: two spots with one rank')
    // A run that worked the spots out with the planner brings the time of working out forward on the spots that are older than
    // when its inputs were loaded, but that is not a change.
    if (patch.recomputed === true) {
      const at = stamp()
      for (const x of world.session_spots.filter((row) => row.session_id === sid && Date.parse(row.computed_at) < Date.parse(at))) x.computed_at = at
    }
    if (lostApprovals) bannerText = patch.banner_text || 'Some spots are no longer on the list, so approvals for them were removed.'
  }

  // The slots and their options, as a difference. A kept option keeps its votes; a dropped one takes them.
  if (has(patch, 'slots')) {
    if (!Array.isArray(patch.slots)) throw dbError('22023', 'The slots must be a JSON list.')
    for (const item of patch.slots) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) throw dbError('22023', 'Each slot must be a JSON object.')
      if (item.remove === true) {
        const gone = slotsOfSession().find((x) => x.category === item.category)
        if (gone) {
          dropOptions(gone.id, () => true)
          world.slots = world.slots.filter((x) => x !== gone)
          changed = true
        }
        continue
      }
      let slot = slotsOfSession().find((x) => x.category === item.category)
      if (!slot) {
        slot = {
          id: randomUUID(),
          session_id: sid,
          category: item.category,
          start_minute: item.start_minute ?? null,
          duration_minutes: item.duration_minutes ?? null,
          picks: item.picks ?? 0,
          is_last: item.is_last ?? false,
          deleted: item.deleted ?? false,
          details: item.details ?? {},
        }
        checkSlot(slot)
        world.slots.push(slot)
        changed = true
      } else {
        const next = {
          ...slot,
          start_minute: item.start_minute ?? slot.start_minute,
          duration_minutes: item.duration_minutes ?? slot.duration_minutes,
          picks: item.picks ?? slot.picks,
          is_last: item.is_last ?? slot.is_last,
          deleted: item.deleted ?? slot.deleted,
          details: has(item, 'details') ? item.details : slot.details,
        }
        checkSlot(next)
        if (!isDeepStrictEqual(next, slot)) {
          Object.assign(slot, next)
          changed = true
        }
      }
      if (slot.deleted) {
        changed = dropOptions(slot.id, () => true) || changed
      } else if (has(item, 'options')) {
        if (!Array.isArray(item.options)) throw dbError('22023', 'The options of a slot must be a JSON list.')
        const listed = new Set(item.options.map((o) => o.venue_id))
        changed = dropOptions(slot.id, (o) => !listed.has(o.venue_id)) || changed
        for (const opt of item.options) {
          const next = { slot_id: slot.id, venue_id: opt.venue_id, rank: opt.rank ?? null, score: opt.score ?? null, source: opt.source ?? 'planner', added_by: opt.added_by ?? null, details: opt.details ?? {} }
          checkOption(world, next)
          const existing = world.slot_options.find((o) => o.slot_id === slot.id && o.venue_id === opt.venue_id)
          if (!existing) {
            world.slot_options.push({ ...next, created_at: tick(world) })
            changed = true
          } else if (!isDeepStrictEqual([existing.rank, existing.score, existing.details], [next.rank, next.score, next.details])) {
            Object.assign(existing, { rank: next.rank, score: next.score, details: next.details })
            changed = true
          }
        }
      }
    }
    // Votes belong to the person, not to their membership: those of anyone who is not a joined member go now.
    changed = dropVotes((v) => !world.session_members.some((m) => m.session_id === sid && sameValue(m.user_id, v.user_id) && m.state === 'joined')) || changed
  }

  // ── Stage 5: the plan ──
  if (session.status === 'confirmed' && newStatus !== 'confirmed') {
    for (const proposal of world.stop_proposals.filter((x) => x.session_id === sid && x.status === 'pending')) Object.assign(proposal, { status: 'dismissed', resolved_at: tick(world) })
    if (reopened) world.stops = world.stops.filter((x) => x.session_id !== sid)
  }
  if (session.status === 'voting' && newStatus === 'confirmed') {
    const joined = new Set(world.session_members.filter((m) => m.session_id === sid && m.state === 'joined').map((m) => m.user_id))
    const mySlots = new Set(slotsOfSession().filter((x) => !x.deleted).map((x) => x.id))
    const voters = new Set(world.votes.filter((v) => mySlots.has(v.slot_id) && joined.has(v.user_id)).map((v) => v.user_id))
    if (voters.size < 2) throw dbError('P0001', 'At least two people need to vote before the plan can be confirmed.', 'not_enough_votes')
  }
  if (has(patch, 'stops')) {
    if (!Array.isArray(patch.stops)) throw dbError('22023', 'The stops must be a JSON list.')
    if (patch.stops.length > 8) throw dbError('P0001', 'A plan holds up to 8 stops.', 'too_many_stops')
    const listed = new Set(patch.stops.map((e) => e.id).filter(Boolean))
    const gone = world.stops.filter((x) => x.session_id === sid && !listed.has(x.id))
    if (gone.length > 0) {
      world.stops = world.stops.filter((x) => !gone.includes(x))
      changed = true
    }
    for (const item of patch.stops) {
      if (item === null || typeof item !== 'object' || Array.isArray(item)) throw dbError('22023', 'Each stop must be a JSON object.')
      if (item.slot_id && !slotsOfSession().some((x) => sameValue(x.id, item.slot_id) && (!x.deleted || session.status !== 'voting'))) throw dbError('P0001', 'A stop names a slot that is not in this session.', 'stop_slot')
      const next = {
        seq: item.seq,
        slot_id: item.slot_id || null,
        category: item.category ?? null,
        venue_id: item.venue_id,
        planned_start_minute: item.planned_start_minute,
        duration_minutes: item.duration_minutes,
        travel_mode: item.travel_mode ?? null,
        travel_minutes: item.travel_minutes ?? null,
        not_before_minute: item.not_before_minute ?? null,
      }
      if (item.id) {
        const row = world.stops.find((x) => x.session_id === sid && x.id === item.id)
        if (!row) throw dbError('P0001', 'A stop is not in this session.', 'stop_missing')
        checkStop(next)
        if (!isDeepStrictEqual(Object.fromEntries(Object.keys(next).map((k) => [k, row[k]])), next)) {
          Object.assign(row, next)
          changed = true
        }
      } else {
        checkStop(next)
        world.stops.push({ id: randomUUID(), session_id: sid, ...next, arrived_at: null, created_at: tick(world) })
        changed = true
      }
    }
    const mine = world.stops.filter((x) => x.session_id === sid)
    if (mine.length === 0) throw dbError('P0001', 'A confirmed plan keeps at least one stop.', 'last_stop')
    if (new Set(mine.map((x) => x.seq)).size !== mine.length || Math.max(...mine.map((x) => x.seq)) !== mine.length - 1) {
      throw dbError('P0001', 'The stops must be numbered 0, 1, 2 ... with no gap and no repeat.', 'stop_order')
    }
    if (new Set(mine.map((x) => x.venue_id)).size !== mine.length) throw dbError('P0001', 'A place cannot be two stops.', 'stop_duplicate')
    if (session.status === 'voting' && mine.some((x) => !x.slot_id || !world.slot_options.some((o) => o.slot_id === x.slot_id && o.venue_id === x.venue_id))) {
      throw dbError('P0001', 'A stop is not one of the places the group could vote for.', 'stop_not_option')
    }
    // Confirming: the votes are read again under the lock. Every stop is a leader of its slot (a tie is a leader), counting only joined people,
    // and every slot somebody voted in has its stop.
    if (session.status === 'voting' && newStatus === 'confirmed') {
      const joined = new Set(world.session_members.filter((m) => m.session_id === sid && m.state === 'joined').map((m) => m.user_id))
      const tally = new Map()
      for (const slot of slotsOfSession().filter((x) => !x.deleted)) {
        const counts = new Map()
        for (const v of world.votes.filter((x) => x.slot_id === slot.id && joined.has(x.user_id))) counts.set(v.venue_id, (counts.get(v.venue_id) ?? 0) + 1)
        tally.set(slot.id, counts)
      }
      const stale =
        mine.some((x) => x.slot_id && (tally.get(x.slot_id)?.get(x.venue_id) ?? 0) < Math.max(1, ...(tally.get(x.slot_id)?.values() ?? []))) ||
        [...tally].some(([slotId, counts]) => counts.size > 0 && !mine.some((x) => x.slot_id === slotId))
      if (stale) throw dbError('P0001', 'The votes changed while the plan was being confirmed.', 'stale_tally')
    }
  }
  if (has(patch, 'stop_options')) {
    if (!Array.isArray(patch.stop_options)) throw dbError('22023', 'The stop options must be a JSON list.')
    for (const item of patch.stop_options) {
      const slot = slotsOfSession().find((x) => sameValue(x.id, item.slot_id))
      if (!slot) throw dbError('P0001', 'A stop option names a slot that is not in this session.', 'stop_slot')
      if (item.replaces && item.replaces !== item.venue_id) changed = dropOptions(slot.id, (o) => o.venue_id === item.replaces) || changed
      // A stop changed to another kind of place has no place to keep in this slot: only the old place leaves.
      if (!item.venue_id) continue
      const next = { slot_id: slot.id, venue_id: item.venue_id, rank: item.rank ?? null, score: item.score ?? null, source: item.source ?? 'planner', added_by: item.added_by ?? null, details: item.details ?? {} }
      checkOption(world, next)
      const existing = world.slot_options.find((o) => o.slot_id === slot.id && o.venue_id === item.venue_id)
      if (!existing) {
        world.slot_options.push({ ...next, created_at: tick(world) })
        changed = true
      } else if (!isDeepStrictEqual([existing.rank, existing.score, existing.details], [next.rank, next.score, next.details])) {
        Object.assign(existing, { rank: next.rank, score: next.score, details: next.details })
        changed = true
      }
    }
  }
  if (has(patch, 'ledger')) {
    if (!Array.isArray(patch.ledger)) throw dbError('22023', 'The ledger must be a JSON list.')
    if (patch.ledger.some((e) => !world.session_members.some((m) => m.session_id === sid && sameValue(m.user_id, e.user_id) && m.state === 'joined'))) {
      throw dbError('P0001', 'The ledger names someone who is not a joined member.', 'ledger_member')
    }
    if (new Set(patch.ledger.map((e) => String(e.user_id).toLowerCase())).size !== patch.ledger.length) throw dbError('P0001', 'The ledger names somebody twice.', 'ledger_duplicate')
    if (decimalSum(patch.ledger.map((e) => e.delta_from_mean)) !== 0n) throw dbError('P0001', "The ledger's deltas must sum to zero.", 'ledger_sum')
    for (const e of patch.ledger) {
      const row = { session_id: sid, user_id: e.user_id, minutes_in: e.minutes_in, minutes_between: e.minutes_between ?? 0, minutes_home: e.minutes_home, delta_from_mean: Number(e.delta_from_mean) }
      checkLedger(row)
      if (world.commute_ledger.some((x) => x.session_id === sid && sameValue(x.user_id, e.user_id))) continue
      world.commute_ledger.push({ ...row, total_minutes: row.minutes_in + row.minutes_between + row.minutes_home, created_at: tick(world) })
      changed = true
    }
    // The stored ledger, rows that were there already included, still sums to zero.
    if (decimalSum(world.commute_ledger.filter((x) => x.session_id === sid).map((x) => x.delta_from_mean)) !== 0n) throw dbError('P0001', "The ledger's deltas must sum to zero.", 'ledger_sum')
  }

  // Rule 3: the session section is a change only where a value differs from the stored row (the meeting as it would be written).
  const nextMeeting = [meeting?.area_id ?? null, meeting?.method ?? null, roundOrNull(meeting?.max_minutes), roundOrNull(meeting?.total_minutes), roundOrNull(meeting?.count), meeting?.approximate ?? null]
  const storedMeeting = [session.meeting_area_id, session.meeting_method, session.meeting_max_minutes, session.meeting_total_minutes, session.meeting_count, session.meeting_approximate].map((v) => v ?? null)
  const meetingChanged = has(sp, 'meeting') && !isDeepStrictEqual(storedMeeting, nextMeeting)
  // A banner sent without its time is stamped with the database's clock when written, and differs from the stored one only apart from it.
  const stamped = has(sp, 'banner') && sp.banner !== null && typeof sp.banner === 'object' && !has(sp.banner, 'at')
  const storedBanner = session.banner ?? null
  // A release brings its notice afresh (always a change), and a release with none clears the old one.
  const bannerChanged = released
    ? has(sp, 'banner') && sp.banner !== null ? true : storedBanner !== null
    : has(sp, 'banner') && !isDeepStrictEqual(stamped && storedBanner ? (({ at: _at, ...rest }) => rest)(storedBanner) : storedBanner, sp.banner ?? null)
  // A joined member whose stored minutes differ from the new ones counts as a change (when they have stored minutes at all).
  const travelChanged =
    has(sp, 'meeting') && meeting && typeof meeting === 'object' && !!meeting.travel &&
    world.session_members.some((m) => {
      if (m.session_id !== sid || m.state !== 'joined' || m.travel_minutes === null || m.travel_minutes === undefined) return false
      return (has(meeting.travel, m.user_id) ? Math.round(meeting.travel[m.user_id]) : null) !== m.travel_minutes
    })
  const radiusChanged = has(sp, 'radius_meters') && (session.radius_meters ?? null) !== (sp.radius_meters ?? null)
  if (has(sp, 'radius_meters') && sp.radius_meters !== null && !(Number.isInteger(sp.radius_meters) && sp.radius_meters >= 100 && sp.radius_meters <= 3000) && radiusChanged) {
    throw dbError('23514', 'sessions check failed: radius_meters')
  }
  // Stage 5: the order note, the suggested order, the plan's start and the pending prompt, each a change only where it differs.
  const noteNew = has(sp, 'order_note') ? sp.order_note ?? null : null
  const suggestionNew = has(sp, 'order_suggestion') ? sp.order_suggestion ?? null : null
  if (has(sp, 'order_note') && noteNew !== null && (typeof noteNew !== 'object' || Array.isArray(noteNew))) throw dbError('22023', 'The order note must be a JSON object or null.')
  if (has(sp, 'replan') && sp.replan !== null && (typeof sp.replan !== 'object' || Array.isArray(sp.replan))) throw dbError('22023', 'The re-plan prompt must be a JSON object or null.')
  const noteChanged = has(sp, 'order_note') && ((session.order_reason ?? null) !== (noteNew?.reason ?? null) || (session.order_source ?? null) !== (noteNew?.source ?? null))
  const suggestionChanged = has(sp, 'order_suggestion') && !isDeepStrictEqual(session.order_suggestion ?? null, suggestionNew)
  const startChanged = has(sp, 'plan_start_minute') && (session.plan_start_minute ?? null) !== (sp.plan_start_minute ?? null)
  const replanChanged = has(sp, 'replan') && !isDeepStrictEqual(session.replan ?? null, sp.replan ?? null)
  if (has(sp, 'weather_kept') && sp.weather_kept !== null && (typeof sp.weather_kept !== 'object' || Array.isArray(sp.weather_kept))) throw dbError('22023', 'The kept rain warnings must be a JSON object or null.')
  const keptChanged = has(sp, 'weather_kept') && !isDeepStrictEqual(session.weather_kept ?? null, sp.weather_kept ?? null)
  if (meetingChanged || travelChanged || bannerChanged || radiusChanged || bannerText !== null || noteChanged || suggestionChanged || startChanged || replanChanged || keptChanged) changed = true
  if (!changed) return Number(session.plan_version)

  if (has(sp, 'meeting') && meeting && typeof meeting === 'object' && meeting.travel) {
    // Only a member whose stored minutes differ is written, as in the function.
    for (const m of world.session_members.filter((row) => row.session_id === sid && row.state === 'joined')) {
      const minutes = has(meeting.travel, m.user_id) ? Math.round(meeting.travel[m.user_id]) : null
      if ((m.travel_minutes ?? null) !== minutes) m.travel_minutes = minutes
    }
  }
  // The checks the database makes on the new values (db/schema.sql), before anything is kept.
  checkOrder({ note: has(sp, 'order_note') && !reopened && !released ? noteNew : null, suggestion: has(sp, 'order_suggestion') && !reopened && !released ? suggestionNew : null })
  if (has(sp, 'plan_start_minute') && sp.plan_start_minute !== null && !(Number.isInteger(sp.plan_start_minute) && sp.plan_start_minute >= 0 && sp.plan_start_minute <= 1439)) {
    throw dbError('23514', 'sessions check failed: plan_start_minute_range')
  }
  const wasConfirmed = session.status === 'confirmed'
  if (reopened || released) {
    Object.assign(session, { order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null })
  } else {
    if (has(sp, 'order_note')) Object.assign(session, { order_reason: noteNew?.reason ?? null, order_source: noteNew?.source ?? null })
    if (has(sp, 'order_suggestion')) session.order_suggestion = suggestionNew
    if (has(sp, 'plan_start_minute')) session.plan_start_minute = sp.plan_start_minute ?? null
  }
  if (released || (wasConfirmed && newStatus !== 'confirmed') || (session.status === 'voting' && newStatus === 'confirmed')) session.replan = null
  else if (has(sp, 'replan')) session.replan = sp.replan ?? null
  if (released || (wasConfirmed && newStatus !== 'confirmed') || (session.status === 'voting' && newStatus === 'confirmed')) session.weather_kept = null
  else if (has(sp, 'weather_kept')) session.weather_kept = sp.weather_kept ?? null
  if (wasConfirmed && newStatus === 'completed') session.completed_at = tick(world)
  session.status = newStatus
  if (radiusChanged) session.radius_meters = sp.radius_meters ?? null
  if (meetingChanged && !released) {
    session.meeting_area_id = meeting?.area_id ?? null
    session.meeting_method = meeting?.method ?? null
    session.meeting_max_minutes = nextMeeting[2]
    session.meeting_total_minutes = nextMeeting[3]
    session.meeting_count = nextMeeting[4]
    session.meeting_approximate = nextMeeting[5]
    session.meeting_computed_at = meeting?.area_id ? tick(world) : null
  }
  if (released) {
    Object.assign(session, { meeting_area_id: null, meeting_method: null, meeting_max_minutes: null, meeting_total_minutes: null, meeting_count: null, meeting_approximate: null, meeting_computed_at: null, meet_by: releaseOp.meet_by })
  }
  if (bannerText !== null) session.banner = { text: bannerText, at: world.t, approvalsRemoved: true }
  else if (bannerChanged && stamped) {
    tick(world)
    session.banner = { ...sp.banner, at: world.t }
  } else if (bannerChanged) session.banner = sp.banner ?? null
  session.plan_version = Number(session.plan_version) + 1
  return session.plan_version
}

// Is this person in the session, joined or not? How to call: isMember(world, GUEST, SESSION)
const isMember = (world, who, sessionId) => world.session_members.some((m) => m.session_id === sessionId && m.user_id === who)
// Do the access rules show this row to this person? `who` is a lower-case user id, or null for the service key (which sees
// everything). How to call: canSee(world, 'session_spots', row, GUEST)
function canSee(world, table, row, who) {
  if (who === null) return true
  if (table === 'sessions') return row.host_id === who || isMember(world, who, row.id)
  if (table === 'profiles') return true
  if (table === 'session_member_places') return row.user_id === who
  if (table === 'profile_private') return row.id === who
  // Options and votes belong to a slot, and a slot to a session: a member of the session reads them (my_slot_ids()).
  if (table === 'slot_options' || table === 'votes') {
    const slot = world.slots.find((x) => x.id === row.slot_id)
    return !!slot && isMember(world, who, slot.session_id)
  }
  return isMember(world, who, row.session_id)
}

// A query over one table, in the shape of supabase-js's builder (select, eq, in, maybeSingle, insert, update, delete, upsert).
// Reads show the person only what the rules show. A write by a person is allowed only where a browser may write; a write by the
// service key is allowed anywhere.
//
// How to call (through the client):
//   const { data, error } = await client.from('session_spots').select('area_id').eq('session_id', id)
function query(world, table, who) {
  const op = { kind: 'select', filters: [], rows: null, patch: null, returning: false, single: false, upsert: false }
  const matches = (row) => canSee(world, table, row, who) && op.filters.every(([column, test]) => test(row[column]))
  const log = () => world.calls.push({ table, kind: op.kind, who, filters: op.filters.map(([c]) => c) })

  // What a browser may write, by the rules in db/policies.sql. Returns an error object, or null when it is allowed.
  const refuseWrite = (row, kind) => {
    if (who === null) return null
    const session = world.sessions.find((s) => s.id === (row.session_id ?? row.id))
    const mine = world.session_members.find((m) => m.session_id === session?.id && m.user_id === who)
    const denied = dbError('42501', `new row violates row-level security policy for table "${table}"`)
    if (table === 'spot_approvals') {
      if (row.user_id !== who && kind !== 'delete') return denied
      if (kind === 'delete' && row.user_id !== who) return denied
      if (!(mine?.state === 'joined' && session?.status === 'locating')) return denied
      if (kind === 'insert' && !world.session_spots.some((s) => s.session_id === row.session_id && s.area_id === row.area_id)) return dbError('23503', 'spot_approvals: the spot is not listed')
      return null
    }
    if (table === 'votes') {
      // db/policies.sql: a person casts, changes and withdraws only their own vote, in a slot they may vote in right now (my_votable_slot_ids():
      // joined, the session voting, the slot not removed), and only for a place that is an option of the slot (the foreign key).
      const slot = world.slots.find((x) => x.id === row.slot_id)
      const voting = world.sessions.find((s) => s.id === slot?.session_id)
      const member = world.session_members.find((m) => m.session_id === slot?.session_id && m.user_id === who)
      if (row.user_id !== who) return denied
      if (!(slot && !slot.deleted && voting?.status === 'voting' && member?.state === 'joined')) return denied
      if (kind !== 'delete' && !world.slot_options.some((o) => o.slot_id === row.slot_id && o.venue_id === row.venue_id)) return dbError('23503', 'votes: the place is not an option of the slot')
      return null
    }
    if (table === 'session_members' && kind === 'update') {
      return mine?.state === 'joined' && ['inviting', 'locating', 'voting'].includes(session?.status) && row.user_id === who ? null : denied
    }
    if (table === 'session_member_places') {
      return row.user_id === who && mine?.state === 'joined' && ['inviting', 'locating', 'voting'].includes(session?.status) ? null : denied
    }
    return dbError('42501', `permission denied for table ${table}`)
  }

  const run = () => {
    log()
    let wait
    if (who === null && op.kind === 'select') {
      wait = world.hooks.beforeRead?.({ table })
      // A database that hung: the service key's reads never answer.
      if (world.hangReads) return new Promise(() => {})
    }
    // A hook that returns a promise holds this read until it settles (to play requests that arrive while a run is loading).
    return wait && typeof wait.then === 'function' ? wait.then(execute) : execute()
  }
  const execute = () => {
    const rows = world[table]
    if (op.kind === 'select' && world.failPast && table === 'session_members' && op.filters.some(([column]) => column === 'user_id')) {
      return { data: null, error: dbError('XX000', 'boom') }
    }
    if (op.kind === 'select') {
      let found = rows.filter(matches)
      if (op.order) {
        const { column, ascending } = op.order
        found = [...found].sort((a, b) => (a[column] < b[column] ? -1 : a[column] > b[column] ? 1 : 0) * (ascending ? 1 : -1))
      }
      if (op.limit !== undefined) found = found.slice(0, op.limit)
      return op.single ? { data: found[0] ? { ...found[0] } : null, error: null } : { data: found.map((r) => ({ ...r })), error: null }
    }
    try {
      if (op.kind === 'insert') {
        const added = []
        for (const row of op.rows) {
          const denied = refuseWrite(row, 'insert')
          if (denied) return { data: null, error: denied }
          const key = (r) => (table === 'spot_approvals' ? [r.session_id, r.area_id, r.user_id] : table === 'votes' ? [r.slot_id, r.user_id] : [r.session_id, r.user_id]).join('|')
          const dup = rows.find((r) => key(r) === key(row))
          if (dup && !op.upsert) return { data: null, error: dbError('23505', `duplicate key in ${table}`) }
          if (dup) Object.assign(dup, row)
          else rows.push({ created_at: tick(world), ...row })
          added.push(row)
        }
        return { data: op.returning ? added : null, error: null }
      }
      const found = rows.filter(matches)
      if (op.kind === 'update') {
        // A project without the meet_by migration: the column is not there to write.
        if (world.refuseMeetBy && table === 'sessions' && 'meet_by' in op.patch) return { data: null, error: dbError('42703', 'column "meet_by" of relation "sessions" does not exist') }
        for (const row of found) {
          const denied = refuseWrite({ ...row, ...op.patch }, 'update')
          if (denied) return { data: null, error: denied }
        }
        for (const row of found) Object.assign(row, op.patch)
        return { data: op.returning ? found.map((r) => ({ ...r })) : null, error: null }
      }
      if (op.kind === 'delete') {
        for (const row of found) {
          const denied = refuseWrite(row, 'delete')
          if (denied) return { data: null, error: denied }
        }
        world[table] = rows.filter((r) => !found.includes(r))
        if (table === 'spot_approvals') return { data: op.returning ? found : null, error: null }
        return { data: op.returning ? found : null, error: null }
      }
    } catch (err) {
      return { data: null, error: err }
    }
    return { data: null, error: { code: 'XX000', message: 'unsupported' } }
  }

  const builder = {
    select() {
      if (op.kind !== 'select') op.returning = true
      return builder
    },
    insert(rows) {
      op.kind = 'insert'
      op.rows = Array.isArray(rows) ? rows : [rows]
      return builder
    },
    upsert(rows) {
      op.kind = 'insert'
      op.upsert = true
      op.rows = Array.isArray(rows) ? rows : [rows]
      return builder
    },
    update(patch) {
      op.kind = 'update'
      op.patch = patch
      return builder
    },
    delete() {
      op.kind = 'delete'
      return builder
    },
    eq(column, value) {
      op.filters.push([column, (v) => sameValue(v, value)])
      return builder
    },
    in(column, values) {
      op.filters.push([column, (v) => values.some((candidate) => sameValue(v, candidate))])
      return builder
    },
    gte(column, value) {
      op.filters.push([column, (v) => v !== null && v !== undefined && Date.parse(v) >= Date.parse(value)])
      return builder
    },
    order(column, { ascending = true } = {}) {
      op.order = { column, ascending }
      return builder
    },
    limit(count) {
      op.limit = count
      return builder
    },
    maybeSingle() {
      op.single = true
      return builder
    },
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  }
  return builder
}

// session_member_needs(sid), as db/schema.sql defines it: one row per joined member of the session (an opted-out member has
// none), with their private fields. Only the service key may call it.
//
// How to call:
//   return memberNeeds(world, null, { sid: SESSION })
function memberNeeds(world, who, { sid }) {
  if (who !== null) return { data: null, error: dbError('42501', 'permission denied for function session_member_needs') }
  if (world.failNeeds) return { data: null, error: dbError('XX000', 'boom') }
  const rows = world.session_members
    .filter((m) => sameValue(m.session_id, sid) && m.state === 'joined')
    .map((m) => (world.profile_private || []).find((p) => sameValue(p.id, m.user_id)))
    .filter(Boolean)
    .map((p) => ({ user_id: p.id, home_area_id: p.home_area_id ?? null, dietary: p.dietary ?? [], budget_max_per_person: p.budget_max_per_person ?? null, needs_step_free: p.needs_step_free ?? false }))
  return { data: rows, error: null }
}

// session_travel_debt(sid), as db/schema.sql defines it: one row per joined member, the sum of their deltas in other sessions in the last 90
// days, clamped to plus or minus 14,400. Only the service key may call it. A ledger row's `created_at` defaults to the world's clock.
//
// How to call:
//   return travelDebt(world, null, { sid: SESSION })
function travelDebt(world, who, { sid }) {
  if (who !== null) return { data: null, error: dbError('42501', 'permission denied for function session_travel_debt') }
  if (world.failDebt) return { data: null, error: dbError('42883', 'function public.session_travel_debt(uuid) does not exist') }
  const since = world.t - 90 * 24 * 3600 * 1000
  const rows = world.session_members
    .filter((m) => sameValue(m.session_id, sid) && m.state === 'joined')
    .map((m) => {
      const sum = world.commute_ledger
        .filter((l) => sameValue(l.user_id, m.user_id) && !sameValue(l.session_id, sid) && Date.parse(l.created_at ?? new Date(world.t).toISOString()) > since)
        .reduce((total, l) => total + Number(l.delta_from_mean), 0)
      return { user_id: m.user_id, debt_minutes: Math.max(-14400, Math.min(14400, sum)) }
    })
  return { data: rows, error: null }
}

// One client over the world. `who` is a lower-case user id, or null for the service key.
//
// How to call:
//   const client = clientOver(world, null)
function clientOver(world, who) {
  return {
    from: (table) => {
      if (!TABLES.includes(table)) throw new Error(`the fake has no table ${table}`)
      return query(world, table, who)
    },
    async rpc(name, args) {
      world.calls.push({ rpc: name, kind: 'rpc', who })
      if (name === 'session_member_needs') return memberNeeds(world, who, args)
      if (name === 'session_travel_debt') return travelDebt(world, who, args)
      if (name !== 'apply_session_plan') return { data: null, error: dbError('42883', `no function ${name}`) }
      if (who !== null) return { data: null, error: dbError('42501', 'permission denied for function apply_session_plan') }
      if (world.hangApply) return new Promise(() => {})
      if (world.failApply) return { data: null, error: dbError('XX000', 'boom') }
      try {
        return { data: applySessionPlan(world, args), error: null }
      } catch (err) {
        return { data: null, error: err }
      }
    },
  }
}

// What createSupabase() gives the server, over a world: the real login check (it verifies tokens signed by tokenFor), and fake
// clients. Pass `real` (a createSupabase() result built with fetchImpl: jwksFetch) to take its verifyToken.
//
// How to call:
//   const real = createSupabase({ url: SUPABASE_URL, anonKey: 'anon', serviceKey: 'service', fetchImpl: jwksFetch })
//   const supabase = fakeSupabase(world, real)
export function fakeSupabase(world, real) {
  return {
    ...real,
    service: clientOver(world, null),
    // The token's subject, in lower case: Postgres compares uuids without regard to case, and so does the fake.
    forUser: (token) => clientOver(world, JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub.toLowerCase()),
  }
}

// A client as the browser of one person, for the writes a browser makes directly ("Works for me", their own start and end area).
//
// How to call:
//   await userClient(world, GUEST).from('spot_approvals').insert({ session_id: SESSION, area_id: 'bugis', user_id: GUEST })
export const userClient = (world, id) => clientOver(world, id.toLowerCase())
