// Reads and writes for the session endpoints. This file is the only one that names the session tables for the meeting-spot and
// voting endpoints; the service (services/sessions.js) asks for rows and for one write, and knows nothing of table names.
//
// Reads come in two kinds:
//   - admission, as the signed-in user (`req.supabase`): the database's own rules decide whether the caller is in the session
//     at all, so a stranger and a missing session look the same;
//   - state, with the service key, after admission has proved the caller is a member: everything a run needs about the session,
//     never an exact place (session_member_places is not read anywhere here). Members' private needs (what they cannot eat, a
//     budget, step-free access) come from session_member_needs(), and only when a ranking needs them.
// A member's needs for one outing and the needs the host dropped (session_member_diet, session_diet_dropped) are read and written
// here too, with the service key only: no browser may read them, and only the outing's needs together ever leave the server.
// Every write is the one function apply_session_plan (db/migrations/20261020000000_jio_apply_session_plan.sql), which locks the
// session row, compares the version and the status the run loaded, and writes nothing if either has moved.
//
// How to call (the service does this):
//   const { session, members } = await loadAdmission(req.supabase, id)
//   const state = await loadState(supabase.service, id)
//   const version = await applyPlan(supabase.service, id, { version: state.session.plan_version, status: state.session.status }, patch)

// The database errors a write is tried again after (deadlock detected, serialization failure). How to call: RETRYABLE.has('40P01') // true
const RETRYABLE = new Set(['40P01', '40001'])

// Thrown when apply_session_plan refuses a write on purpose (a rule, not a failure). `hint` is the rule's short name, and `detail` is
// the text the database gave with it (null when it gave none; a clash with another meetup names it there as JSON).
//
// How to catch it:
//   try { await applyPlan(...) } catch (err) { if (err instanceof PlanRefused && err.hint === 'area_pinned') ... }
export class PlanRefused extends Error {
  constructor(message, hint, detail = null) {
    super(message)
    this.name = 'PlanRefused'
    this.hint = hint
    this.detail = detail
  }
}

// Throws a plain Error naming what could not be read. The app's error handler answers 500 and logs it.
//
// How to call:
//   unwrap(await client.from('sessions').select('id'), 'the session')
function unwrap({ data, error }, what) {
  if (error) throw new Error(`Could not load ${what}: ${error.message}`)
  return data
}

// The session and its members as the caller may see them. The session is null when it does not exist or the caller is not in it.
//
// How to call:
//   const { session, members } = await loadAdmission(req.supabase, id)
export async function loadAdmission(client, id) {
  const session = unwrap(
    await client.from('sessions').select('id, host_id, status, plan_version, meeting_area_id, meeting_method').eq('id', id).maybeSingle(),
    'the session',
  )
  const members = unwrap(await client.from('session_members').select('user_id, role, state, start_area_id, end_area_id').eq('session_id', id), 'the members')
  return { session, members: members ?? [] }
}

// Everything a run needs: the session (with the plan's columns: the suggested order, the order note, the plan's start), its members (areas,
// picks and how long they stay; never an exact place), the stored spots, the suggestions and the approvals, for voting the slots, their
// options (with what the planner said about each) and the votes, and for a confirmed plan its stops (in order) and the proposals still
// waiting. Read with the service key, so call it only after admission. The session is null if it is gone.
//
// How to call:
//   const { session, members, spots, suggestions, approvals, slots, options, votes, stops, proposals } = await loadState(supabase.service, id)
export async function loadState(service, id) {
  const session = unwrap(
    await service
      .from('sessions')
      .select(
        'id, host_id, status, meet_by, plan_version, date, start_time, end_time, radius_meters, banner, meeting_area_id, meeting_method, ' +
          'meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate, ' +
          'order_reason, order_source, order_suggestion, plan_start_minute, replan, weather_kept, completed_at',
      )
      .eq('id', id)
      .maybeSingle(),
    'the session',
  )
  if (!session) return { session: null, members: [], spots: [], suggestions: [], approvals: [], slots: [], options: [], votes: [], stops: [], proposals: [] }
  const [members, spots, suggestions, approvals, slots] = await Promise.all([
    service.from('session_members').select('user_id, role, state, start_area_id, end_area_id, categories, stay_until, travel_minutes').eq('session_id', id),
    service.from('session_spots').select('area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate').eq('session_id', id),
    service.from('spot_suggestions').select('user_id, area_id, here, created_at').eq('session_id', id),
    service.from('spot_approvals').select('area_id, user_id').eq('session_id', id),
    service.from('slots').select('id, category, start_minute, duration_minutes, picks, is_last, deleted, details').eq('session_id', id),
  ])
  const slotRows = unwrap(slots, 'the slots') ?? []
  let optionRows = []
  let voteRows = []
  if (slotRows.length > 0) {
    const slotIds = slotRows.map((s) => s.id)
    const [options, votes] = await Promise.all([
      service.from('slot_options').select('slot_id, venue_id, rank, score, source, added_by, details').in('slot_id', slotIds),
      service.from('votes').select('slot_id, user_id, venue_id').in('slot_id', slotIds),
    ])
    optionRows = (unwrap(options, 'the options') ?? []).map((o) => ({ ...o, score: o.score === null ? null : Number(o.score) }))
    voteRows = unwrap(votes, 'the votes') ?? []
  }
  // The stops and the proposals only exist once the plan is confirmed, so only then are they read.
  let stopRows = []
  let proposalRows = []
  if (session.status === 'confirmed') {
    const [stops, proposals] = await Promise.all([
      service.from('stops').select('id, seq, slot_id, category, venue_id, planned_start_minute, duration_minutes, travel_mode, travel_minutes, not_before_minute').eq('session_id', id),
      service.from('stop_proposals').select('id, venue_id, proposed_by, status, created_at').eq('session_id', id).eq('status', 'pending'),
    ])
    stopRows = [...(unwrap(stops, 'the stops') ?? [])].sort((a, b) => a.seq - b.seq)
    proposalRows = unwrap(proposals, 'the proposals') ?? []
  }
  return {
    session,
    members: unwrap(members, 'the members') ?? [],
    spots: (unwrap(spots, 'the spots') ?? []).map((s) => ({ ...s, worst_minutes: Number(s.worst_minutes), mean_minutes: Number(s.mean_minutes) })),
    suggestions: unwrap(suggestions, 'the suggestions') ?? [],
    approvals: unwrap(approvals, 'the approvals') ?? [],
    slots: slotRows,
    options: optionRows,
    votes: voteRows,
    stops: stopRows,
    proposals: proposalRows,
  }
}

// Each joined member's private planner needs: { user_id, dietary, budget_max_per_person, needs_step_free }. Only the service key can
// call the function, and only a ranking asks: a spot never needs them. Nothing here leaves the server except as which places pass.
//
// How to call:
//   const needs = await loadNeeds(supabase.service, id) // [{ user_id, dietary: ['halal'], budget_max_per_person: 20, needs_step_free: false }]
export async function loadNeeds(service, id) {
  return withOutingDiet(await loadProfileNeeds(service, id), await loadOutingDiet(service, id))
}

// session_member_needs()'s rows as they are: each joined member's profile needs, before anything picked for the outing.
// How to call: const rows = await loadProfileNeeds(supabase.service, id)
export async function loadProfileNeeds(service, id) {
  return unwrap(await service.rpc('session_member_needs', { sid: id }), "the members' needs") ?? []
}

// The dietary needs the app knows, in its order. Anything else is left out. How to call: cleanNeeds(['vegan', 'kosher']) // ['vegan']
export const DIET_NEEDS = ['halal', 'vegetarian', 'vegan']
export const cleanNeeds = (list) => DIET_NEEDS.filter((need) => Array.isArray(list) && list.includes(need))

// How many joined members an outing needs before a need can be dropped, or the dropped ones count. With two, a dropped need would be
// the other person's own, so below three nothing is dropped (and nothing about the others' needs is told: routes/sessions.js).
export const MIN_MEMBERS_TO_DROP = 3

// Is this the error of a table that is not on the project yet (the migration 20261030000000 not applied)? Postgres says 42P01; the
// API in front of it, PGRST205. How to call: missingTable({ code: '42P01' }) // true
const missingTable = (error) => error?.code === '42P01' || error?.code === 'PGRST205'

// What each person picked for this outing, and the needs the host dropped: { mine: Map { userId => ['halal'] }, dropped: ['vegan'],
// ready }. `ready` is false on a project without the tables yet, and then nothing is picked or dropped, so every need comes from the
// profile, as before. Any other failure throws. Service key only.
//
// How to call:
//   const outing = await loadOutingDiet(supabase.service, id) // { mine: Map { 'ab12...' => ['vegan'] }, dropped: [], ready: true }
export async function loadOutingDiet(service, id) {
  const [picked, dropped] = await Promise.all([
    service.from('session_member_diet').select('user_id, needs').eq('session_id', id),
    service.from('session_diet_dropped').select('need').eq('session_id', id),
  ])
  if (missingTable(picked.error) || missingTable(dropped.error)) return { mine: new Map(), dropped: [], ready: false }
  const pickedRows = unwrap(picked, "the members' needs for the outing") ?? []
  const droppedRows = unwrap(dropped, 'the dropped needs') ?? []
  return {
    mine: new Map(pickedRows.map((r) => [String(r.user_id).toLowerCase(), cleanNeeds(r.needs)])),
    dropped: cleanNeeds(droppedRows.map((r) => r.need)),
    ready: true,
  }
}

// Each member's needs for the outing before anything is dropped: what they picked for it, else their profile's. Rows are
// session_member_needs()'s. How to call: outingNeedsOf(rows, outing) // [{ user_id, needs: ['halal'] }]
export function outingNeedsOf(rows, outing) {
  return rows.map((r) => ({ user_id: String(r.user_id).toLowerCase(), needs: outing.mine.get(String(r.user_id).toLowerCase()) ?? cleanNeeds(r.dietary) }))
}

// The needs dropped for this outing, while three or more have joined; none below that. `joined` is how many have joined.
// How to call: droppedFor(3, outing) // ['halal']
export const droppedFor = (joined, outing) => (joined >= MIN_MEMBERS_TO_DROP ? outing.dropped : [])

// session_member_needs()'s rows with `dietary` as the ranking should filter by: the outing's needs in place of the profile's, less
// the dropped ones. Every other field is as the function gave it. `joined` is how many have joined: one row each, since every
// account has a private row (the sign-up trigger).
// How to call: withOutingDiet(rows, outing) // [{ user_id, dietary: ['vegan'], budget_max_per_person, ... }]
export function withOutingDiet(rows, outing, joined = rows.length) {
  const dropped = droppedFor(joined, outing)
  const needs = new Map(outingNeedsOf(rows, outing).map((r) => [r.user_id, r.needs]))
  return rows.map((r) => ({ ...r, dietary: needs.get(String(r.user_id).toLowerCase()).filter((need) => !dropped.includes(need)) }))
}

// Saves one person's needs for the outing (a row means they confirmed them, possibly none) and the dropped needs as `dropped` lists
// them. THROWS a plain Error on a failure, and one with `code: 'not_set_up'` on a project without the tables.
//
// How to call:
//   await saveOutingDiet(supabase.service, id, { userId, mine: ['vegan'], dropped: ['halal'], before: ['halal', 'vegan'] })
export async function saveOutingDiet(service, id, { userId, mine, dropped, before }) {
  const check = ({ error }, what) => {
    if (missingTable(error)) throw Object.assign(new Error('Dietary needs for an outing are not set up on this project yet.'), { code: 'not_set_up' })
    if (error) throw new Error(`Could not save ${what}: ${error.message}`)
  }
  check(await service.from('session_member_diet').upsert({ session_id: id, user_id: userId, needs: cleanNeeds(mine) }), 'your needs for the outing')
  const gone = before.filter((need) => !dropped.includes(need))
  const added = dropped.filter((need) => !before.includes(need))
  if (gone.length) check(await service.from('session_diet_dropped').delete().eq('session_id', id).in('need', gone), 'the dropped needs')
  if (added.length) check(await service.from('session_diet_dropped').upsert(added.map((need) => ({ session_id: id, need }))), 'the dropped needs')
}

// Each joined member's travel debt in minutes (their share of the effort in their other outings in the last 90 days, positive when they
// travelled more than their share), from session_travel_debt(). Only the service key can call the function. THROWS on any failure: the caller
// plans without debt when it does (a ranking is never refused because the history could not be read).
//
// How to call:
//   const debts = await loadDebts(supabase.service, id) // Map { userId => 12.5 }
export async function loadDebts(service, id) {
  const rows = unwrap(await service.rpc('session_travel_debt', { sid: id }), "the members' travel debt")
  return new Map((rows ?? []).map((r) => [String(r.user_id).toLowerCase(), Number(r.debt_minutes)]).filter(([, debt]) => Number.isFinite(debt)))
}

// The finished outings that any of these people were in, for the places the group has been to lately: the completed sessions since `since` that
// one of `userIds` was a joined member of, the newest `limit`, with their members and their stops. Read with the service key, so the answer is the
// same whoever asked (the planner stores a ranking for the whole group); the caller keeps only what at least two of the group did together
// (services/session-history.js), and only places and days leave it. Reads are in chunks of ids, each bounded. THROWS on any failure (the caller
// plans without history when it does).
//
// How to call:
//   const { sessions, members, stops } = await loadPastOutings(supabase.service, { since: '2026-08-24T00:00:00.000Z', limit: 30, userIds: [a, b] })
export async function loadPastOutings(service, { since, limit, userIds }) {
  if (userIds.length === 0) return { sessions: [], members: [], stops: [] }
  const mine = unwrap(await service.from('session_members').select('session_id').in('user_id', userIds).eq('state', 'joined').limit(2000), "the group's outings") ?? []
  const wanted = [...new Set(mine.map((m) => m.session_id))]
  const found = []
  for (let i = 0; i < wanted.length; i += 100) {
    const rows = unwrap(
      await service.from('sessions').select('id, date, completed_at').in('id', wanted.slice(i, i + 100)).eq('status', 'completed').gte('completed_at', since),
      'the finished outings',
    ) ?? []
    found.push(...rows)
  }
  const sessions = found.sort((a, b) => String(b.completed_at).localeCompare(String(a.completed_at))).slice(0, limit)
  if (sessions.length === 0) return { sessions: [], members: [], stops: [] }
  const ids = sessions.map((s) => s.id)
  const [members, stops] = await Promise.all([
    service.from('session_members').select('session_id, user_id, state').in('session_id', ids),
    service.from('stops').select('session_id, venue_id').in('session_id', ids),
  ])
  return { sessions, members: unwrap(members, "the finished outings' members") ?? [], stops: unwrap(stops, "the finished outings' stops") ?? [] }
}

// Checks that the database has what stage 5 needs, so a backend started before the migration fails at once, loudly, naming the migration
// (and not on the first request of every session, in every status). Only a missing column or table is fatal; a database that cannot be
// reached gives an Error with `unreachable: true`, which the caller logs as a warning, since requests would fail on their own.
//
// How to call:
//   await checkPlanSchema(supabase.service) // resolves when the schema is there; else throws an Error naming the migration file
export async function checkPlanSchema(service) {
  const migration = 'db/migrations/20261023000000_jio_apply_session_plan_stops.sql'
  const probes = [
    ['sessions', 'order_suggestion, plan_start_minute, order_reason, order_source, weather_kept'],
    ['stops', 'not_before_minute'],
    ['stop_proposals', 'id'],
  ]
  for (const [table, columns] of probes) {
    const { error } = await service.from(table).select(columns).limit(1)
    if (!error) continue
    // 42703 undefined column, 42P01 undefined table, PGRST204 and PGRST205 the same through PostgREST's schema cache.
    if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)) {
      throw new Error(`The database does not have what stage 5 of the sessions needs (${table}: ${error.message}). Apply ${migration} before this server runs.`)
    }
    throw Object.assign(new Error(`Could not check the database for stage 5 (${table}: ${error.message}).`), { unreachable: true })
  }
}

// People's names, for the sentence a notice carries. A person with no profile row is left out.
//
// How to call:
//   const names = await loadNames(supabase.service, [hostId]) // Map { hostId => 'Ian' }
export async function loadNames(service, ids) {
  if (ids.length === 0) return new Map()
  const rows = unwrap(await service.from('profiles').select('id, display_name, username').in('id', ids), 'the names')
  return new Map((rows ?? []).map((p) => [String(p.id).toLowerCase(), p.display_name || p.username || null]))
}

// Makes a run's whole write in one transaction, if the session is still as the run loaded it. Resolves with the session's version
// after the write, or null when the session moved on (its version or its status is not what was loaded): nothing was written and
// the run should load again. Throws PlanRefused when a rule of the function refuses the write, and an Error for any failure.
//
// How to call:
//   const version = await applyPlan(service, id, { version: 4, status: 'locating' }, { ops: [], spots: [] }) // 5, or null
export async function applyPlan(service, id, { version, status }, patch) {
  const call = () => service.rpc('apply_session_plan', { sid: id, expected_version: version, expected_status: status, patch })
  let { data, error } = await call()
  // The database ended this write to break a deadlock (40P01) or a serialization clash (40001), which a release can meet when a guest's vote is
  // in flight: nothing was written, so it is tried once more with the same version and status (the function answers null if the session moved
  // on, which makes the caller load it again). A second failure is the caller's.
  if (error && RETRYABLE.has(error.code)) ({ data, error } = await call())
  if (error) {
    // A rule the function enforces raises an exception with a hint; anything else is a failure of the database.
    if (error.code === 'P0001' && error.hint) throw new PlanRefused(error.message, error.hint, error.details || null)
    throw new Error(`Could not write the session's plan (${error.code ?? 'no code'}): ${error.message}`)
  }
  return data === null || data === undefined ? null : Number(data)
}
