// Reads and writes for the session endpoints. This file is the only one that names the session tables for the meeting-spot and
// voting endpoints; the service (services/sessions.js) asks for rows and for one write, and knows nothing of table names.
//
// Reads come in two kinds:
//   - admission, as the signed-in user (`req.supabase`): the database's own rules decide whether the caller is in the session
//     at all, so a stranger and a missing session look the same;
//   - state, with the service key, after admission has proved the caller is a member: everything a run needs about the session,
//     never an exact place (session_member_places is not read anywhere here). Members' private needs (what they cannot eat, a
//     budget, step-free access) come from session_member_needs(), and only when a ranking needs them.
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

// The dietary needs a person can have. Anything else in the database is left out of every answer.
export const NEEDS = ['halal', 'vegetarian', 'vegan']

// Keeps the needs of the list that are known ones, each once, in the app's order. How to call: knownNeeds(['vegan', 'durian-free', 'vegan']) -> ['vegan']
export const knownNeeds = (list) => NEEDS.filter((need) => Array.isArray(list) && list.includes(need))

// An outing's dietary needs as the database holds them (db/migrations/20261030000000_jio_outing_dietary.sql), for the server only: every joined
// member's private needs for THIS outing (their own list for it if they changed or confirmed it, else their profile's: session_member_needs()),
// which of them have a list of their own for the outing, and the needs the host dropped. Read with the service key; call it only after admission.
// `rows` still carry the dropped needs, so the host can be told which are dropped and take a drop back; a ranking reads loadNeeds() instead.
//
// How to call:
//   const { rows, saved, dropped } = await loadOutingDietary(supabase.service, id)
//   // rows: [{ user_id, dietary, budget_max_per_person, ... }], saved: Map { 'user id' => confirmed_at | null }, dropped: ['halal']
export async function loadOutingDietary(service, id) {
  const [needs, saved, dropped] = await Promise.all([
    service.rpc('session_member_needs', { sid: id }),
    service.from('session_member_dietary').select('user_id, confirmed_at').eq('session_id', id),
    service.from('session_dietary_dropped').select('need').eq('session_id', id),
  ])
  return {
    rows: unwrap(needs, "the members' needs") ?? [],
    saved: new Map((unwrap(saved, "the members' needs for the outing") ?? []).map((r) => [String(r.user_id).toLowerCase(), r.confirmed_at ?? null])),
    dropped: knownNeeds((unwrap(dropped, "the outing's dropped needs") ?? []).map((r) => r.need)),
  }
}

// Each joined member's private planner needs: { user_id, dietary, budget_max_per_person, needs_step_free }, for the outing: the dietary needs
// are the member's for this outing, without the ones the host dropped (so every ranking, which reads them here, stops filtering for a dropped
// need). Only the service key can call the functions, and only a ranking asks: a spot never needs them. Nothing here leaves the server except
// as which places pass.
//
// How to call:
//   const needs = await loadNeeds(supabase.service, id) // [{ user_id, dietary: ['halal'], budget_max_per_person: 20, needs_step_free: false }]
export async function loadNeeds(service, id) {
  const { rows, dropped } = await loadOutingDietary(service, id)
  if (dropped.length === 0) return rows
  return rows.map((row) => ({ ...row, dietary: Array.isArray(row.dietary) ? row.dietary.filter((need) => !dropped.includes(need)) : row.dietary }))
}

// Saves a member's dietary needs for one outing: the list they have for it, and (`confirm`) that they confirmed it. A write with the service key,
// as the member has no right to the table. Leaving `dietary` out keeps the saved list (and writes nothing new but the confirmation).
//
// How to call:
//   await saveMemberDietary(supabase.service, id, userId, { dietary: ['halal'], confirm: true })
export async function saveMemberDietary(service, id, userId, { dietary, confirm = false }) {
  const row = { session_id: id, user_id: userId, ...(dietary !== undefined && { dietary }), ...(confirm && { confirmed_at: new Date().toISOString() }) }
  const { error } = await service.from('session_member_dietary').upsert(row, { onConflict: 'session_id,user_id' })
  if (error) throw new Error(`Could not save the member's dietary needs: ${error.message}`)
}

// Sets the needs the host dropped for an outing to exactly this list: the ones no longer on it are taken back, the new ones are dropped.
//
// How to call:
//   await saveDroppedNeeds(supabase.service, id, { add: ['halal'], remove: ['vegan'] })
export async function saveDroppedNeeds(service, id, { add, remove }) {
  if (remove.length > 0) {
    const { error } = await service.from('session_dietary_dropped').delete().eq('session_id', id).in('need', remove)
    if (error) throw new Error(`Could not take back a dropped need: ${error.message}`)
  }
  if (add.length > 0) {
    const { error } = await service.from('session_dietary_dropped').upsert(add.map((need) => ({ session_id: id, need })), { onConflict: 'session_id,need' })
    if (error) throw new Error(`Could not drop a need: ${error.message}`)
  }
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

// Checks that the database has what stage 5 and the outing's dietary needs need, so a backend started before the migration fails at once, loudly, naming the migration
// (and not on the first request of every session, in every status). Only a missing column or table is fatal; a database that cannot be
// reached gives an Error with `unreachable: true`, which the caller logs as a warning, since requests would fail on their own.
//
// How to call:
//   await checkPlanSchema(supabase.service) // resolves when the schema is there; else throws an Error naming the migration file
export async function checkPlanSchema(service) {
  const stage5 = 'db/migrations/20261023000000_jio_apply_session_plan_stops.sql'
  const probes = [
    ['sessions', 'order_suggestion, plan_start_minute, order_reason, order_source, weather_kept', stage5],
    ['stops', 'not_before_minute', stage5],
    ['stop_proposals', 'id', stage5],
    // The dietary needs of one outing: every ranking reads the host's dropped needs, so a server without the tables would fail them all.
    ['session_member_dietary', 'session_id, user_id, dietary, confirmed_at', 'db/migrations/20261030000000_jio_outing_dietary.sql'],
    ['session_dietary_dropped', 'session_id, need', 'db/migrations/20261030000000_jio_outing_dietary.sql'],
  ]
  for (const [table, columns, migration] of probes) {
    const { error } = await service.from(table).select(columns).limit(1)
    if (!error) continue
    // 42703 undefined column, 42P01 undefined table, PGRST204 and PGRST205 the same through PostgREST's schema cache.
    if (['42703', '42P01', 'PGRST204', 'PGRST205'].includes(error.code)) {
      throw new Error(`The database does not have what the sessions need (${table}: ${error.message}). Apply ${migration} before this server runs.`)
    }
    throw Object.assign(new Error(`Could not check the database for the sessions (${table}: ${error.message}).`), { unreachable: true })
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
