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

// Thrown when apply_session_plan refuses a write on purpose (a rule, not a failure). `hint` is the rule's short name.
//
// How to catch it:
//   try { await applyPlan(...) } catch (err) { if (err instanceof PlanRefused && err.hint === 'area_pinned') ... }
export class PlanRefused extends Error {
  constructor(message, hint) {
    super(message)
    this.name = 'PlanRefused'
    this.hint = hint
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
        'id, host_id, status, plan_version, date, start_time, end_time, radius_meters, banner, meeting_area_id, meeting_method, ' +
          'meeting_max_minutes, meeting_total_minutes, meeting_count, meeting_approximate, ' +
          'order_reason, order_source, order_suggestion, plan_start_minute, replan, completed_at',
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
  const rows = unwrap(await service.rpc('session_member_needs', { sid: id }), "the members' needs")
  return rows ?? []
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

// The caller's own recent finished outings, for the places the group has been to lately: the completed sessions the CALLER is in (the
// database's own rules decide, so nobody else's session is ever read), the newest `limit` completed since `since`, with their members and
// their stops. Three small reads, each bounded. THROWS on any failure (the caller plans without history when it does).
//
// How to call:
//   const { sessions, members, stops } = await loadPastOutings(req.supabase, { since: '2026-08-24T00:00:00.000Z', limit: 30 })
export async function loadPastOutings(client, { since, limit }) {
  const sessions = unwrap(
    await client.from('sessions').select('id, date, completed_at').eq('status', 'completed').gte('completed_at', since).order('completed_at', { ascending: false }).limit(limit),
    'the finished outings',
  ) ?? []
  if (sessions.length === 0) return { sessions: [], members: [], stops: [] }
  const ids = sessions.map((s) => s.id)
  const [members, stops] = await Promise.all([
    client.from('session_members').select('session_id, user_id, state').in('session_id', ids),
    client.from('stops').select('session_id, venue_id').in('session_id', ids),
  ])
  return { sessions, members: unwrap(members, 'the finished outings\' members') ?? [], stops: unwrap(stops, 'the finished outings\' stops') ?? [] }
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
  const { data, error } = await service.rpc('apply_session_plan', {
    sid: id,
    expected_version: version,
    expected_status: status,
    patch,
  })
  if (error) {
    // A rule the function enforces raises an exception with a hint; anything else is a failure of the database.
    if (error.code === 'P0001' && error.hint) throw new PlanRefused(error.message, error.hint)
    throw new Error(`Could not write the session's plan (${error.code ?? 'no code'}): ${error.message}`)
  }
  return data === null || data === undefined ? null : Number(data)
}
