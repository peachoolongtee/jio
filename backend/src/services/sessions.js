import { randomUUID } from 'node:crypto'
import {
  applyPlan,
  loadAdmission,
  loadDebts,
  loadNames,
  loadNeeds,
  loadPastOutings,
  loadState,
  PlanRefused,
} from '../db/sessions.js'
import { arrangeCandidates, freshCandidates } from '../planner/arrange.js'
import { moreOptions, OPTIONS_MAX, OPTIONS_MORE } from '../planner/slot-plan.js'
import { MAX } from '../routes/plan-schemas.js'
import { nowInSingapore } from './planner-runs.js'
import { currentScenario } from './scenario.js'
import { HISTORY_OUTINGS, historySince, visitsFrom } from './session-history.js'
import {
  arrangeInput,
  basisOf,
  confirmedRows,
  MAX_STOPS,
  reorderedRows,
  startOf,
  suggestionFits,
  timedRows,
  votedStops,
  votersOf,
  withAddedStop,
  withMode,
  withoutStop,
  withPlace,
} from './session-itinerary.js'
import { homeTripsRun, ledgerFor, ledgerPeople, minutesBetween } from './session-ledger.js'
import { createSessionQueue } from './session-queue.js'
import {
  APP_SPOTS,
  describeChange,
  knownPlaceRow,
  locatedMembers,
  lostApprovalAreas,
  lostApprovalsBannerText,
  lower,
  meetingAtSpot,
  methodFor,
  MIN_STARTS,
  orderedSpots,
  preselectedSpot,
  priceAreaRun,
  relistedRows,
  spotRowsFrom,
  suggestedAreaIds,
} from './session-plan.js'
import { categoryOfSlot, optionRow, optionsOf } from './session-slots.js'
import { createVoting, dateTimeOf, spend } from './session-voting.js'
import { MAX_ROUTED_TRIPS_PER_REQUEST, ROUTING_DEADLINE_MS } from './travel-times.js'

// The session endpoints that decide where a group meets, what it votes on and the plan it makes, on the server: the meeting spots, a member's
// suggestion, the host's confirm and known place (which also makes the voting slots and their options), the radius, adding, swapping and
// removing places, removing and restoring a slot, opting out and rejoining, leaving or being removed, and (stage 5) the suggested order of the
// stops, the host's confirm of the plan, opening it again, deleting, moving and re-timing its stops, putting another place in a stop, Roam
// proposals, and finishing the outing with its travel ledger. Votes are not here: a browser writes its own vote directly, under the
// database's rules. routes/sessions.js is the HTTP side of this; this file is the rules.
//
// How a request goes:
//   1. Admission, as the signed-in user. The database's own rules show a session only to people in it, so a stranger and a
//      missing session both get 404 session_not_found, and the service key is not touched before this passes.
//   2. The cheap refusals (role, status) from what admission read.
//   3. The request joins its session's line (services/session-queue.js). A run loads the session afresh with the service key,
//      does every job in its batch to that copy, works the spots out once (one engine run through the shared planner runs, so
//      the OneMap cap and budget apply), and writes the lot with apply_session_plan.
//   4. apply_session_plan writes nothing when the session's version or status is not what the run loaded. A run that is too late
//      loads again and does its jobs again on the new state (so a spot list worked out for a locating session is never put
//      over a confirmed one, and a job that no longer applies is refused with the right error), up to three times; then 409 plan_busy.
//      Each call to the database in a run has a deadline (dbDeadlineMs); a run past it fails with 503 `unavailable` and the line moves on.
//
// Travel times come from the centres of areas, never from an exact place, and only saved venues exist here: no Google. No answer
// carries a label or a coordinate, and session_member_places is never read. One request has one allowance of OneMap trips (60), which
// its meeting area, all its slots, a replaced stop and the trips home of a finished outing spend together.
//
// The group's past is an extra, never a need (services/session-history.js): a ranking uses each person's travel debt (session_travel_debt())
// and the places the group has been to lately (the caller's own finished outings), and any failure or slowness reading either means the
// planner answers without it. The AI is asked for a suggested order only through the itinerary AI's budget (services/itinerary-ai.js),
// with only place names, kinds, times and the weather.
//
// Every refusal is a SessionError, which the router answers as { error, message } with the status given.
//
// How to build it (app.js does this):
//   const sessions = createSessions({ supabase, data, runs })
//   const answer = await sessions.confirmSpot({ client: req.supabase, id, userId: req.user.id, areaId: 'bugis' })

// How many times a run loads the session and does its jobs again when the session moved on while it worked out the spots.
const MAX_TRIES = 3

// The most time one call to the database may take inside a run (the same as OneMap's). A database that hangs must not hold its
// session's line for ever: after this the run fails with 503 and the line moves on.
const DB_DEADLINE_MS = 8000

// An error that is the caller's to hear about: a status, a code, and a message that is safe to show.
//
// How to catch it (routes/sessions.js does this):
//   if (err instanceof SessionError) return res.status(err.status).json({ error: err.code, message: err.message })
export class SessionError extends Error {
  constructor(status, code, message, { retryAfter = null } = {}) {
    super(message)
    this.name = 'SessionError'
    this.status = status
    this.code = code
    this.retryAfter = retryAfter
  }
}

// A SessionError to throw. How to call: throw refuse(403, 'host_only', 'Only the host can confirm a spot.')
const refuse = (status, code, message, options) => new SessionError(status, code, message, options)

// What a rule of apply_session_plan that refused a write (its hint) is told to the caller as. A hint that is not here is the session being
// in a state the request does not fit (409 wrong_status): the write was refused by the database after the server had checked, which means
// the session moved on between the two.
const REFUSALS = {
  area_pinned: [409, 'area_pinned', 'The meeting area was chosen, so this cannot move it.'],
  needs_two_people: [409, 'needs_two_people', 'A session needs at least two people.'],
  slot_missing: [404, 'slot_not_found', 'That slot is not in this session.'],
  not_enough_votes: [409, 'not_enough_votes', 'At least two people need to vote before the plan can be confirmed.'],
  stops_missing: [409, 'nothing_to_confirm', 'Vote for at least one place first.'],
  last_stop: [409, 'last_stop', 'A plan needs at least one stop.'],
  plan_full: [409, 'plan_full', `A plan holds up to ${MAX_STOPS} stops.`],
  too_many_stops: [409, 'plan_full', `A plan holds up to ${MAX_STOPS} stops.`],
  too_many_proposals: [409, 'too_many_proposals', 'Too many places are waiting for an answer.'],
  already_a_stop: [409, 'already_a_stop', 'That place is already in the plan.'],
  proposal_member: [403, 'not_joined', 'Only people in this session can do that.'],
  stop_missing: [409, 'stops_changed', 'The plan has changed. Look at it again.'],
  stop_order: [409, 'stops_changed', 'The plan has changed. Look at it again.'],
  stop_duplicate: [409, 'stops_changed', 'The plan has changed. Look at it again.'],
  stop_slot: [409, 'stops_changed', 'The plan has changed. Look at it again.'],
  stop_not_option: [409, 'stops_changed', 'The plan has changed. Look at it again.'],
}

// The SessionError for the hint of a refused write.
//
// How to call:
//   throw refusalOf('not_enough_votes')
const refusalOf = (hint) => {
  const [status, code, message] = REFUSALS[hint] ?? [409, 'wrong_status', 'This cannot be done while the session is in this state.']
  return refuse(status, code, message)
}

// Waits for a call to the database, at most `ms`. Past that it fails with 503 `unavailable` (the call may still finish later, so
// the caller cannot tell whether a write happened, which is why this is a 5xx and not a refusal).
//
// How to call:
//   const state = await within(loadState(service, id), 8000, 'reading the session')
function within(work, ms, what) {
  let timer
  const late = new Promise((_, reject) => {
    timer = setTimeout(() => reject(refuse(503, 'unavailable', `The database did not answer in time while ${what}. Try again in a moment.`, { retryAfter: 2 })), ms)
  })
  return Promise.race([work, late]).finally(() => clearTimeout(timer))
}

// Reads something the planner can do without (the group's past): waits at most the database deadline, and on any failure at all (a database
// error, a function that is not on the project, a timeout) answers `fallback` and says so in the log, at most once a minute. The log line
// holds only what was being read and the kind of failure, never a message from the database.
//
// How to call:
//   const debts = await softly(() => loadDebts(service, id), 'reading the travel debt', null)
let lastHistoryWarning = 0
function softly(work, what, fallback, ms = DB_DEADLINE_MS) {
  return within(work(), ms, what).catch((err) => {
    const at = Date.now()
    if (at - lastHistoryWarning > 60_000) {
      lastHistoryWarning = at
      console.warn(`Session history is not used (${what} failed: ${typeof err?.code === 'string' ? err.code : (err?.name ?? 'Error')}). The planner answers without it.`)
    }
    return fallback
  })
}

// The status check every endpoint makes. `allowed` are the statuses it works in. Of the others: a finished session is `closed`
// (an error code, default wrong_status), a status listed in `notYet` is work a later stage does (409 not_yet), and anything
// else is 409 wrong_status.
//
// How to call:
//   requireStatus(state, ['inviting', 'locating'], { notYet: ['voting'] })
function requireStatus(state, allowed, { notYet = [], closed = 'wrong_status', started = null, startedIn = ['voting', 'confirmed'], what = 'do that' } = {}) {
  const status = state.session.status
  if (allowed.includes(status)) return
  if (['completed', 'cancelled'].includes(status)) {
    throw refuse(409, closed, `This session has ended, so nobody can ${what}.`)
  }
  if (started && startedIn.includes(status)) {
    throw refuse(409, started, `Nobody can ${what} once the session has moved on, for now.`)
  }
  if (notYet.includes(status)) throw refuse(409, 'not_yet', `This is not supported yet while the session is ${status}.`)
  throw refuse(409, 'wrong_status', `This cannot be done while the session is ${status}.`)
}

// The caller's member row, or a 404 that says nothing about whether the session exists.
//
// How to call:
//   const me = requireMember(state, userId) // { user_id, role, state, ... }
function requireMember(state, userId) {
  const row = state.members.find((m) => lower(m.user_id) === userId)
  if (!row) throw refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.')
  return row
}

// The caller's member row, which must be a joined one.
//
// How to call:
//   const me = requireJoined(state, userId)
function requireJoined(state, userId) {
  const row = requireMember(state, userId)
  if (row.state !== 'joined') throw refuse(403, 'not_joined', 'You have opted out of this session. Rejoin to do that.')
  return row
}

// Only the host.
//
// How to call:
//   requireHost(state, userId, 'confirm a spot')
function requireHost(state, userId, what) {
  if (lower(state.session.host_id) !== userId) throw refuse(403, 'host_only', `Only the host can ${what}.`)
}

// A copy of a run's inputs that a job may change freely.
//
// How to call:
//   const draft = draftOf(state)
const draftOf = (state) => {
  // Options and votes are keyed by their slot's category, so a slot made in this run (it has no id yet) can hold them.
  const categoryOf = new Map(state.slots.map((s) => [s.id, s.category]))
  return {
    session: { ...state.session },
    members: state.members.map((m) => ({ ...m })),
    spots: state.spots.map((s) => ({ ...s })),
    suggestions: state.suggestions.map((s) => ({ ...s })),
    approvals: state.approvals.map((a) => ({ ...a })),
    slots: state.slots.map((s) => ({ ...s })),
    options: state.options.map(({ slot_id: slotId, ...o }) => ({ ...o, category: categoryOf.get(slotId) })),
    votes: state.votes.map(({ slot_id: slotId, ...v }) => ({ ...v, category: categoryOf.get(slotId) })),
    // The stops of a confirmed plan (in order) and the proposals still waiting; empty in any other status.
    stops: (state.stops ?? []).map((s) => ({ ...s })),
    proposals: (state.proposals ?? []).map((p) => ({ ...p })),
    // The categories whose slots this run changed; only these go in the patch.
    dirty: new Set(),
  }
}

// Builds the session service.
//
// Options:
//   supabase - From createSupabase(): `service` is the only client used here, after admission.
//   data     - Venues and areas the planner reads, from loadPlanData(). Saved venues only: no Google place is ever ranked here.
//   runs     - The shared planner runs, from createPlannerRuns() (services/planner-runs.js). Every OneMap call goes through them.
//   queue    - Tests may pass their own lane (createSessionQueue); normally built here.
//   dbDeadlineMs - The most time one call to the database may take inside a run. Default DB_DEADLINE_MS (8 seconds).
//   ai       - The itinerary AI, from createItineraryAi() (services/itinerary-ai.js): it chooses the suggested order of the stops among the orders
//              the rules allow, inside its own budget. Without one the rules choose.
//   now      - Returns the time in milliseconds. Tests pass a fake clock; it decides how far back the group's past is read.
//
// How to call:
//   const sessions = createSessions({ supabase, data, runs, ai })
export function createSessions({ supabase, data, runs, ai = null, now = Date.now, routingDeadlineMs = ROUTING_DEADLINE_MS, dbDeadlineMs = DB_DEADLINE_MS }) {
  const service = supabase.service
  const areasById = new Map((data.areas ?? []).map((a) => [a.id, a]))
  const areaName = (id) => areasById.get(id)?.name ?? id
  const voting = createVoting({ data, areasById, runs })
  // Reads something the planner can do without, within this service's database deadline (see softly).
  const soft = (work, what, fallback) => softly(work, what, fallback, dbDeadlineMs)
  // A saved place by its id (undefined when it is not one), for the timing of a plan.
  const ctxVenue = (venueId) => voting.venues.get(venueId)

  // ── Admission ──────────────────────────────────────────────────────────

  // Reads the session as the caller. Throws 404 when there is no such session or the caller is not in it.
  //
  // How to call:
  //   const state = await admit(req.supabase, id, userId) // { session, members }
  async function admit(client, id, userId) {
    const { session, members } = await loadAdmission(client, id)
    const state = { session, members }
    if (!session) throw refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.')
    requireMember(state, userId)
    return state
  }

  // An area id the planner knows, or 422 unknown_area.
  //
  // How to call:
  //   requireArea('bugis')
  function requireArea(areaId) {
    if (!areasById.has(areaId)) throw refuse(422, 'unknown_area', 'That is not an area the planner knows.')
  }

  // ── Working out the spots ──────────────────────────────────────────────

  // The spots as the draft stands: the app's three and the members' suggestions, priced for everyone with a start. Fewer than
  // two starts gives an empty list. One engine run (so at most one allowance of OneMap trips) however many suggestions there are.
  //
  // How to call:
  //   const { rows, skipped, travel } = await computeSpots(draft, allowance, ctx)
  async function computeSpots(draft, allowance, ctx) {
    const debts = (await ctx.debts?.()) ?? null
    const { located, skipped } = locatedMembers(draft.members, areasById, debts)
    if (located.length < MIN_STARTS) return { rows: [], skipped, travel: null }
    const input = {
      members: located,
      method: 'station',
      alternatives: APP_SPOTS - 1,
      include: suggestedAreaIds(draft.suggestions, draft.members, areasById),
      dateTime: dateTimeOf(draft.session),
    }
    const { result, travel } = await runs.runWithTravel(input, data, runs.meetingAreaWithRouting, (request) => ({
      ...runs.meetingAreaTravelFor(request),
      maxTrips: allowance.trips,
      deadlineMs: Math.max(0, allowance.deadlineAt - Date.now()),
    }))
    spend(allowance, travel)
    return { rows: spotRowsFrom(result, travel), skipped, travel }
  }

  // ── Running a batch ────────────────────────────────────────────────────

  // Runs one batch of jobs for a session: load, do every job to a copy, work out the spots once if any job needs them (while the group is
  // choosing where to meet) or the meeting area and the slots once (while it is voting), and write it all through apply_session_plan.
  // Settles every job. Called by the queue.
  //
  // How to call (the queue does this):
  //   await runBatch(sessionId, { exclusive: false, jobs }, { handOver })
  async function runBatch(sessionId, batch, { handOver }) {
    const allowance = { trips: MAX_ROUTED_TRIPS_PER_REQUEST, deadlineAt: Date.now() + routingDeadlineMs }
    const dropped = new Set()
    const reject = (job, err) => {
      dropped.add(job)
      job.settle.reject(err)
    }

    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      // Taken before the members are read, so a member row changed after it has an updated_at later than the spots' computed_at.
      const loadedAt = new Date().toISOString()
      const state = await within(loadState(service, sessionId), dbDeadlineMs, 'reading the session')
      if (!state.session) {
        for (const job of batch.jobs) if (!dropped.has(job)) reject(job, refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.'))
        return
      }
      const draft = draftOf(state)
      const spotsBefore = draft.spots
      // The members' private needs, read once and only if a ranking asks (the service key is used here after admission has passed).
      let needsRead
      let debtsRead
      let visitsRead
      // The group's past, read softly: any failure, or a database too slow, answers nothing and the planner goes on without it. The
      // finished outings are read as the first caller of the batch that is still waiting (the database's rules show that person only their
      // own), never with the service key; the travel debt is the server's own function.
      const ctx = {
        allowance,
        state,
        venueOf: (venueId) => voting.venues.get(venueId),
        needs: () => (needsRead ??= within(loadNeeds(service, sessionId), dbDeadlineMs, "reading the members' needs")),
        debts: () => (debtsRead ??= soft(() => loadDebts(service, sessionId), 'reading the travel debt', null)),
        visits: () =>
          (visitsRead ??= soft(
            async () => {
              const client = batch.jobs.find((job) => !dropped.has(job) && job.client)?.client
              if (!client) return []
              const joined = new Set(state.members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id)))
              const outings = await loadPastOutings(client, { since: historySince(now()), limit: HISTORY_OUTINGS })
              return visitsFrom({ outings, sessionId, joined })
            },
            'reading the finished outings',
            [],
          )),
      }
      const live = []
      for (const job of batch.jobs) {
        if (dropped.has(job)) continue
        try {
          live.push({ job, prepared: await job.prepare(draft, ctx) })
        } catch (err) {
          if (!(err instanceof SessionError)) throw err
          reject(job, err)
        }
      }
      if (live.length === 0) return

      // The spots: worked out again if any job needs the planner, kept as they are stored if the jobs only move suggestions about,
      // and the job's own list when the host sets a known place.
      const needs = live.some(({ prepared }) => prepared.needs === 'recompute') ? 'recompute' : live.some(({ prepared }) => prepared.needs === 'relist') ? 'relist' : 'none'
      const ops = live.flatMap(({ prepared }) => prepared.ops ?? [])
      const jobSession = Object.assign({}, ...live.map(({ prepared }) => prepared.session).filter(Boolean))
      const sessionPatch = Object.keys(jobSession).length > 0 ? jobSession : undefined
      // A run that would only recompute does not spend a planner run (and its OneMap calls) when a newer run of the same kind is
      // already waiting: that one does the same work on newer inputs, so the jobs move to it before anything is paid for. Only a run all
      // of whose jobs are "work it out again" (`pure`) or have nothing to do can move; any job that changes something keeps its turn.
      const handable = () =>
        ops.length === 0 && !sessionPatch && live.some(({ prepared }) => prepared.pure) &&
        live.every(({ prepared }) => prepared.pure || (prepared.needs ?? 'none') === 'none')
      if (handable() && handOver(live.map(({ job }) => job))) return
      let rows = live.find(({ prepared }) => prepared.spots)?.prepared.spots
      let skipped = []
      let recomputed = false
      if (rows === undefined && needs === 'recompute') {
        ;({ rows, skipped } = await computeSpots(draft, allowance, ctx))
        recomputed = true
      } else if (rows === undefined && needs === 'relist') {
        rows = relistedRows(draft.spots, suggestedAreaIds(draft.suggestions, draft.members, areasById))
      }

      // A job can ask to be refused by what the planner answered (a suggested area that could not be priced). It is refused alone
      // and the others are done again without it.
      let refused = false
      for (const { job, prepared } of live) {
        if (!prepared.verify) continue
        try {
          prepared.verify(rows ?? draft.spots)
        } catch (err) {
          if (!(err instanceof SessionError)) throw err
          reject(job, err)
          refused = true
        }
      }
      if (refused) {
        attempt -= 1
        continue
      }

      // The voting half: the meeting area and the slots, when a job asked and the session is (or is becoming) voting.
      const wants = live.map(({ prepared }) => prepared.plan).filter(Boolean)
      const plan = wants.length > 0 && draft.session.status === 'voting' ? await voting.planPhase(draft, wants, ctx) : null

      const patch = { ops: [...ops, ...(plan?.ops ?? [])] }
      const sessionPart = { ...jobSession, ...plan?.session }
      if (Object.keys(sessionPart).length > 0) patch.session = sessionPart
      if (plan && plan.items.length > 0) patch.slots = plan.items
      // The plan's own parts: the complete list of stops, the details of a place put in a stop, and the ledger of a finished outing.
      const stopsPart = live.map(({ prepared }) => prepared.stops).filter((part) => part !== undefined).at(-1)
      if (stopsPart !== undefined) patch.stops = stopsPart
      const stopOptions = live.flatMap(({ prepared }) => prepared.stopOptions ?? [])
      if (stopOptions.length > 0) patch.stop_options = stopOptions
      const ledgerPart = live.map(({ prepared }) => prepared.ledger).filter((part) => part !== undefined).at(-1)
      if (ledgerPart !== undefined) patch.ledger = ledgerPart
      let lost = []
      if (rows !== undefined) {
        patch.spots = rows
        // Said only when the planner just worked the list out, so the database brings its time of working out forward even when no
        // number moved (a page compares it with a member's last change). A list merely kept as it was never claims that. The time
        // is when the members were read, not when the planner finished, so a start saved while it ran still looks unpriced.
        if (recomputed) patch.recomputed = true
        patch.loaded_at = loadedAt
        lost = lostApprovalAreas(spotsBefore, rows, draft.approvals)
        if (lost.length > 0) {
          // The notice starts with the change that took the spot away: the job that withdrew or replaced its suggestion, or removed
          // the person who made it. With several jobs in the batch and none to blame (they all moved starts), it says only that the
          // list changed, rather than name one person's change for something another's may have caused.
          const reasoned = live.filter(({ prepared }) => prepared.reason)
          const culprit = reasoned.find(({ prepared }) => (prepared.removes ?? []).some((areaId) => lost.includes(areaId)))?.prepared
          const reason = culprit ?? (reasoned.length === 1 ? reasoned[0].prepared : null)
          const names = await within(loadNames(service, [...new Set(live.flatMap(({ prepared }) => prepared.nameIds ?? []))]), dbDeadlineMs, 'reading the names')
          const nameOf = (id) => names.get(lower(id)) ?? 'Someone'
          patch.banner_text = lostApprovalsBannerText(reason?.reason(nameOf) ?? 'The list of spots changed.', lost, areaName)
        }
      }

      const nothingToWrite =
        patch.ops.length === 0 && patch.spots === undefined && !patch.session && patch.slots === undefined &&
        patch.stops === undefined && patch.stop_options === undefined && patch.ledger === undefined
      let version = Number(state.session.plan_version)
      if (!nothingToWrite) {
        // Asked again now: a run may have joined the line while the planner worked, and its jobs would be done again on newer inputs.
        if (handable() && handOver(live.map(({ job }) => job))) return
        try {
          const written = await within(
            applyPlan(service, sessionId, { version: state.session.plan_version, status: state.session.status }, patch),
            dbDeadlineMs,
            'saving the plan',
          )
          if (written === null) continue // the session moved on while the spots were worked out: load again
          version = written
        } catch (err) {
          if (!(err instanceof PlanRefused)) throw err
          const error = refusalOf(err.hint)
          for (const { job } of live) reject(job, error)
          return
        }
      }
      for (const { job, prepared } of live) {
        try {
          job.settle.resolve(await within(Promise.resolve(prepared.answer({ version, rows: rows ?? draft.spots, lost, skipped, state, draft, plan: plan?.info })), dbDeadlineMs, 'reading the result'))
        } catch (err) {
          job.settle.reject(err)
        }
      }
      return
    }
    for (const job of batch.jobs) if (!dropped.has(job)) reject(job, refuse(409, 'plan_busy', 'The session changed again while this was worked out. Try again.', { retryAfter: 1 }))
  }

  const queue = createSessionQueue(runBatch)

  // ── The jobs ───────────────────────────────────────────────────────────
  // A job is what one endpoint does: { exclusive?, check(state), prepare(draft) }. `check` is the cheap refusals, run on what
  // admission read and again on the fresh copy. `prepare` does the job's change to the copy and says what to write:
  //   ops      changes to members, suggestions and approvals, in order (see apply_session_plan)
  //   needs    'recompute' (work the spots out with the planner), 'relist' (keep the stored spots the suggestions still need),
  //            or 'none'
  //   spots    the exact rows to leave in session_spots (a known place)
  //   session  columns of the session to change (status, banner, meeting)
  //   reason   (nameOf) => the sentence a notice starts with if approvals were removed; nameIds the people it names
  //   removes  the area ids whose suggestion this job took away, so the notice names the job that caused a spot to leave the list
  //   verify   (rows) => throws a SessionError if the answer does not satisfy this job
  //   plan     what the voting half does after the jobs have changed the draft (a voting session only):
  //              { meeting?: true, rank?: 'all' | [category], trigger?: { kind, name }, radius?: true }
  //            `meeting` works the meeting area out again, `rank` ranks the slots (all of them, or those categories; a kind with no slot yet is
  //            always ranked), `trigger` names the change for the notice, `radius` makes the notice the radius's. A job that changes options
  //            itself (add, swap, remove) changes the draft's slots, options and votes in `prepare` and marks `draft.dirty`.
  //   pure     true when the job only works the session out again from what is stored; such a run may move to a newer one waiting behind it
  //   answer   ({ version, rows, lost, skipped, state, draft, plan }) => the JSON the endpoint answers with

  // Admits a request and queues its job. Resolves with the job's answer.
  //
  // How to call:
  //   return submit({ client, id, userId }, job)   // the session id may be in any case; the line uses it in lower case
  async function submit({ client, id, userId }, job) {
    // One lane per session however its id is written: Postgres reads a uuid without regard to case, and so must the line.
    id = lower(id)
    const state = await admit(client, id, userId)
    job.check(state)
    // The caller's own client goes with the job: the group's past is read as a member of the batch (never with the service key).
    return queue.enqueue(id, { ...job, client })
  }

  // A person's name for a notice, or "Someone" when they have none.
  //
  // How to call:
  //   const name = await nameFor(userId) // 'Ian'
  async function nameFor(userId) {
    const names = await within(loadNames(service, [userId]), dbDeadlineMs, 'reading the names')
    return names.get(lower(userId)) ?? 'Someone'
  }

  // The voting half of a job that changes who is in the session or where they start: work the meeting area out again, then the slots.
  // Their notice names the person and what they did.
  //
  // How to call:
  //   plan: await votingPlan(userId, 'optout')
  const votingPlan = async (userId, kind) => ({ meeting: true, rank: 'all', trigger: { kind, name: await nameFor(userId) } })

  // POST /api/sessions/:id/meeting-area: work the spots out again after a start or end changed (E1). While the group is inviting or
  // locating only the spots change. While it is voting, a chosen meeting area stays and its travel times move; the planner's own pick may
  // move, and then the options and the votes are cleared and chosen again. Either way the slots are ranked again.
  //
  // How to call:
  //   await sessions.recompute({ client: req.supabase, id, userId: req.user.id, trigger: 'start' })
  //   // { planVersion, meetingAreaId: null, moved: false, votesCleared: false, skipped: [userId], spots: 3, approvalsRemoved: [] }
  function recompute({ client, id, userId, trigger = 'start' }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['inviting', 'locating', 'voting'], { notYet: ['confirmed'], what: 'work out the spots' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft) => {
          check(draft)
          if (draft.session.status === 'voting') {
            return {
              ops: [],
              needs: 'none',
              pure: true,
              plan: await votingPlan(userId, trigger),
              answer: ({ version, draft: after, plan }) => ({
                planVersion: version,
                meetingAreaId: after.session.meeting_area_id ?? null,
                moved: plan.moved,
                votesCleared: plan.votesCleared,
                skipped: locatedMembers(after.members, areasById).skipped,
                spots: after.spots.length,
                approvalsRemoved: [],
              }),
            }
          }
          return {
            ops: [],
            needs: 'recompute',
            pure: true,
            nameIds: [userId],
            reason: (nameOf) => describeChange(trigger, nameOf(userId)),
            // While locating the meeting area stays empty: the list is the truth, and the host confirms from it.
            answer: ({ version, rows, lost, skipped }) => ({
              planVersion: version,
              meetingAreaId: null,
              moved: false,
              votesCleared: false,
              skipped,
              spots: rows.length,
              approvalsRemoved: lost,
            }),
          }
        },
      },
    )
  }

  // PUT /api/sessions/:id/spots/mine: the caller suggests a spot, replacing their earlier suggestion (E19). The planner is asked
  // only when the area is not already on the list.
  //
  // How to call:
  //   await sessions.suggestSpot({ client: req.supabase, id, userId: req.user.id, areaId: 'bugis', here: true })
  //   // { planVersion, spots: 4, approvalsRemoved: [] }
  function suggestSpot({ client, id, userId, areaId, here = false }) {
    userId = lower(userId)
    requireArea(areaId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['locating'], { what: 'suggest a spot' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const others = draft.suggestions.filter((s) => lower(s.user_id) !== userId).map((s) => s.area_id)
          if (new Set([...others, areaId]).size > MAX.suggestedSpots) {
            throw refuse(409, 'too_many_spots', `The group can suggest up to ${MAX.suggestedSpots} different spots. Ask someone to withdraw theirs first.`)
          }
          const listed = draft.spots.some((s) => s.area_id === areaId)
          if (!listed && locatedMembers(draft.members, areasById).located.length < MIN_STARTS) {
            throw refuse(409, 'no_spots', 'Spots open once two people have shared where they start.')
          }
          const replaced = draft.suggestions.find((s) => lower(s.user_id) === userId)?.area_id
          draft.suggestions = [...draft.suggestions.filter((s) => lower(s.user_id) !== userId), { user_id: userId, area_id: areaId, here, created_at: new Date().toISOString() }]
          return {
            ops: [{ op: 'suggest', user_id: userId, area_id: areaId, here }],
            needs: listed ? 'relist' : 'recompute',
            nameIds: [userId],
            removes: replaced && replaced !== areaId ? [replaced] : [],
            reason: (nameOf) => `${nameOf(userId)} suggested ${areaName(areaId)}.`,
            verify: (rows) => {
              if (!rows.some((r) => r.area_id === areaId)) {
                throw refuse(422, 'area_not_priced', `The planner could not work out travel times to ${areaName(areaId)}.`)
              }
            },
            answer: ({ version, rows, lost }) => ({ planVersion: version, spots: rows.length, approvalsRemoved: lost }),
          }
        },
      },
    )
  }

  // DELETE /api/sessions/:id/spots/mine: the caller takes their suggestion back (E20). No planner run. Does nothing when they
  // have none.
  //
  // How to call:
  //   await sessions.withdrawSpot({ client: req.supabase, id, userId: req.user.id }) // { planVersion }
  function withdrawSpot({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['locating'], { what: 'withdraw a suggestion' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const had = draft.suggestions.find((s) => lower(s.user_id) === userId)
          draft.suggestions = draft.suggestions.filter((s) => lower(s.user_id) !== userId)
          return {
            ops: had ? [{ op: 'unsuggest', user_id: userId }] : [],
            needs: had ? 'relist' : 'none',
            nameIds: [userId],
            removes: had ? [had.area_id] : [],
            reason: (nameOf) => describeChange('withdrew', nameOf(userId)),
            answer: ({ version }) => ({ planVersion: version }),
          }
        },
      },
    )
  }

  // POST /api/sessions/:id/opt-out: the caller, a guest, steps out (E10). Their approvals, suggestion and votes go, and the spots (or,
  // while voting, the meeting area and the slots) are worked out without them. Already out is a no-op.
  //
  // How to call:
  //   await sessions.optOut({ client: req.supabase, id, userId: req.user.id }) // { planVersion, state: 'opted_out' }
  function optOut({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      const me = requireMember(state, userId)
      if (me.role === 'host' || lower(state.session.host_id) === userId) throw refuse(403, 'host_cannot_opt_out', 'The host cannot opt out. Cancel the session instead.')
      requireStatus(state, ['inviting', 'locating', 'voting'], { notYet: ['confirmed'], what: 'opt out' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft) => {
          check(draft)
          const me = requireMember(draft, userId)
          if (me.state === 'opted_out') return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, state: 'opted_out' }) }
          me.state = 'opted_out'
          const theirs = draft.suggestions.filter((s) => lower(s.user_id) === userId).map((s) => s.area_id)
          draft.suggestions = draft.suggestions.filter((s) => lower(s.user_id) !== userId)
          draft.approvals = draft.approvals.filter((a) => lower(a.user_id) !== userId)
          draft.votes = draft.votes.filter((v) => lower(v.user_id) !== userId)
          const voting = draft.session.status === 'voting'
          return {
            ops: [{ op: 'opt_out', user_id: userId }],
            needs: voting ? 'none' : 'recompute',
            nameIds: [userId],
            removes: theirs,
            reason: (nameOf) => describeChange('optout', nameOf(userId)),
            ...(voting && { plan: await votingPlan(userId, 'optout') }),
            answer: ({ version }) => ({ planVersion: version, state: 'opted_out' }),
          }
        },
      },
    )
  }

  // POST /api/sessions/:id/rejoin: the caller, who opted out, comes back (E11). The spots (or, while voting, the meeting area and the
  // slots) are worked out with them again. Already joined still works them out, in case an earlier call was lost.
  //
  // How to call:
  //   await sessions.rejoin({ client: req.supabase, id, userId: req.user.id }) // { planVersion, state: 'joined' }
  function rejoin({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      requireMember(state, userId)
      requireStatus(state, ['inviting', 'locating', 'voting'], { notYet: ['confirmed'], what: 'rejoin' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft) => {
          check(draft)
          const me = requireMember(draft, userId)
          const wasOut = me.state === 'opted_out'
          me.state = 'joined'
          const voting = draft.session.status === 'voting'
          return {
            ops: wasOut ? [{ op: 'rejoin', user_id: userId }] : [],
            needs: voting ? 'none' : 'recompute',
            pure: !wasOut,
            nameIds: [userId],
            reason: (nameOf) => describeChange('rejoin', nameOf(userId)),
            ...(voting && { plan: await votingPlan(userId, 'rejoin') }),
            answer: ({ version }) => ({ planVersion: version, state: 'joined' }),
          }
        },
      },
    )
  }

  // DELETE /api/sessions/:id/members/:userId: a member leaves, or the host removes a guest (E25). The member's row goes, and with it
  // their exact place, approvals and suggestion; their votes are deleted with it, and the spots (or, while voting, the meeting area and
  // the slots) are worked out without them. Once the plan is confirmed this refuses (409 session_started): the plan stage decides what
  // happens to a stop's people.
  //
  // How to call:
  //   await sessions.removeMember({ client: req.supabase, id, userId: req.user.id, target: 'me' })      // { planVersion, left: true }
  //   await sessions.removeMember({ client: req.supabase, id, userId: req.user.id, target: guestId })   // { planVersion, removed: true }
  function removeMember({ client, id, userId, target }) {
    userId = lower(userId)
    const person = target === 'me' ? userId : lower(target)
    const leaving = person === userId
    const check = (state) => {
      requireMember(state, userId)
      // The host is the only one who could ask to remove the host, and then it is the host leaving.
      if (leaving && lower(state.session.host_id) === userId) throw refuse(403, 'host_cannot_leave', 'The host cannot leave a session. Cancel it instead.')
      if (!leaving && lower(state.session.host_id) !== userId) throw refuse(403, 'host_only', 'Only the host can remove someone from a session.')
      requireStatus(state, ['inviting', 'locating', 'voting'], { closed: 'session_closed', started: 'session_started', startedIn: ['confirmed'], what: 'leave or be removed' })
      if (!state.members.some((m) => lower(m.user_id) === person)) throw refuse(404, 'member_not_found', 'That person is not in this session.')
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft) => {
          check(draft)
          const theirs = draft.suggestions.filter((s) => lower(s.user_id) === person).map((s) => s.area_id)
          draft.members = draft.members.filter((m) => lower(m.user_id) !== person)
          draft.suggestions = draft.suggestions.filter((s) => lower(s.user_id) !== person)
          draft.approvals = draft.approvals.filter((a) => lower(a.user_id) !== person)
          draft.votes = draft.votes.filter((v) => lower(v.user_id) !== person)
          const voting = draft.session.status === 'voting'
          return {
            ops: [{ op: 'remove_member', user_id: person }],
            needs: voting ? 'none' : 'recompute',
            nameIds: [person],
            removes: theirs,
            reason: (nameOf) => describeChange(leaving ? 'left' : 'removed', nameOf(person)),
            ...(voting && { plan: await votingPlan(person, leaving ? 'left' : 'removed') }),
            answer: ({ version }) => (leaving ? { planVersion: version, left: true } : { planVersion: version, removed: true }),
          }
        },
      },
    )
  }

  // Sets the draft up as a session that has just moved to voting at `meeting`, so the voting half ranks the slots around the new area.
  //
  // How to call:
  //   enterVoting(draft, meeting)
  function enterVoting(draft, meeting) {
    Object.assign(draft.session, {
      status: 'voting',
      banner: null,
      meeting_area_id: meeting.area_id,
      meeting_method: meeting.method,
      meeting_max_minutes: meeting.max_minutes,
      meeting_total_minutes: meeting.total_minutes,
      meeting_count: meeting.count,
      meeting_approximate: meeting.approximate,
    })
  }

  // POST /api/sessions/:id/voting: the host confirms a spot (E2). Without an area it is the preselected spot: the most approved,
  // a tie going to the shorter longest trip. It becomes the meeting area, from the spot's stored figures with no planner run for the
  // area, and the session moves to voting. In the same write the session gets its slots (eat, drink, shop and activity) and each slot's
  // first places, ranked around the area, so a voting session always has them. The method is `voted` when anyone approved the spot, the
  // planner's own (`same` or `fairest`) when nobody did and it is the app's first spot, and `chosen` otherwise. Spots stay as the record.
  //
  // Confirming again, for the same spot, is a no-op.
  //
  // How to call:
  //   await sessions.confirmSpot({ client: req.supabase, id, userId: req.user.id, areaId: 'bugis' })
  //   // { planVersion, status: 'voting', meetingAreaId: 'bugis', method: 'voted', slotCount: 4 }
  function confirmSpot({ client, id, userId, areaId }) {
    userId = lower(userId)
    if (areaId !== undefined) requireArea(areaId)
    // A repeat of a confirm that already went through: the same spot, or no spot named.
    const alreadyConfirmed = (state) =>
      state.session.status === 'voting' && state.session.meeting_area_id && (areaId === undefined || areaId === state.session.meeting_area_id)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'confirm a spot')
      if (!alreadyConfirmed(state)) requireStatus(state, ['locating'], { what: 'confirm a spot' })
    }
    return submit(
      { client, id, userId },
      {
        exclusive: true,
        check,
        prepare: (draft) => {
          check(draft)
          if (alreadyConfirmed(draft)) {
            return {
              ops: [],
              needs: 'none',
              answer: ({ version }) => ({
                planVersion: version,
                status: 'voting',
                meetingAreaId: draft.session.meeting_area_id,
                method: draft.session.meeting_method,
                slotCount: draft.slots.filter((s) => !s.deleted).length,
              }),
            }
          }
          const list = orderedSpots(draft.spots, draft.suggestions)
          if (list.length === 0) throw refuse(409, 'no_spots', 'There are no spots to confirm yet. They open once two people have shared where they start.')
          const spot = areaId === undefined ? preselectedSpot(list, draft.approvals, draft.members) : list.find((s) => s.area_id === areaId)
          if (!spot) throw refuse(404, 'spot_not_found', 'That spot is not on the list.')
          const { located } = locatedMembers(draft.members, areasById)
          const meeting = meetingAtSpot(spot, methodFor(spot, draft.approvals, draft.members, located))
          enterVoting(draft, meeting)
          return {
            ops: [],
            needs: 'none',
            session: { status: 'voting', banner: null, meeting },
            plan: { rank: 'all' },
            answer: ({ version, plan }) => ({ planVersion: version, status: 'voting', meetingAreaId: meeting.area_id, method: meeting.method, slotCount: plan.slotCount }),
          }
        },
      },
    )
  }

  // PUT /api/sessions/:id/known-place: the host sets the meeting area straight away because the group has already decided (E21),
  // from inviting or locating to voting. The list becomes that one area, suggestions and approvals are cleared, and the area is
  // pinned (`chosen`): a later change of start moves the travel times, never the area. One planner run prices the area for the
  // members who have shared a start; with none, the times are zero. The session needs two people, as it does to start. As with
  // confirming a spot, the slots and their places are made in the same write. Setting the same place again is a no-op.
  //
  // How to call:
  //   await sessions.setKnownPlace({ client: req.supabase, id, userId: req.user.id, areaId: 'bugis' }) // { planVersion, status: 'voting' }
  function setKnownPlace({ client, id, userId, areaId }) {
    userId = lower(userId)
    requireArea(areaId)
    const alreadySet = (state) => state.session.status === 'voting' && state.session.meeting_method === 'chosen' && state.session.meeting_area_id === areaId
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'set a known place')
      if (alreadySet(state)) return
      requireStatus(state, ['inviting', 'locating'], { what: 'set a known place' })
      if (state.members.filter((m) => m.state === 'joined').length < 2) throw refuse(409, 'needs_two_people', 'A session needs at least two people.')
    }
    return submit(
      { client, id, userId },
      {
        exclusive: true,
        check,
        prepare: async (draft, { allowance }) => {
          check(draft)
          if (alreadySet(draft)) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, status: 'voting' }) }
          const { located } = locatedMembers(draft.members, areasById)
          let priced = null
          let travel = null
          if (located.length > 0) {
            const area = areasById.get(areaId)
            const input = { members: located, area: { id: area.id, lat: area.lat, lng: area.lng }, dateTime: dateTimeOf(draft.session) }
            ;({ result: priced, travel } = await runs.runWithTravel(input, data, priceAreaRun, () => ({
              maxTrips: allowance.trips,
              deadlineMs: Math.max(0, allowance.deadlineAt - Date.now()),
            })))
            spend(allowance, travel)
          }
          const row = knownPlaceRow(areaId, priced, travel)
          draft.suggestions = []
          draft.approvals = []
          const meeting = meetingAtSpot(row, 'chosen')
          enterVoting(draft, meeting)
          return {
            ops: [{ op: 'clear_approvals' }, { op: 'clear_suggestions' }],
            needs: 'none',
            spots: [row],
            session: { status: 'voting', banner: null, meeting },
            plan: { rank: 'all' },
            answer: ({ version }) => ({ planVersion: version, status: 'voting' }),
          }
        },
      },
    )
  }

  // ── Voting: the radius, the slots and the places ───────────────────────

  // The slot a path names, which must be there and not removed.
  //
  // How to call:
  //   const slot = liveSlot(draft, slotId) // the draft's slot row
  function liveSlot(draft, slotId) {
    const category = categoryOfSlot(draft, slotId)
    const slot = category && draft.slots.find((s) => s.category === category)
    if (!slot || slot.deleted || slot.removed) throw refuse(404, 'slot_not_found', 'That slot is not in this session.')
    return slot
  }

  // A voting session has an area to offer places around, unless voting is paused (nobody has shared where they start).
  //
  // How to call:
  //   requireMeetingArea(draft)
  function requireMeetingArea(draft) {
    if (!draft.session.meeting_area_id) throw refuse(409, 'no_meeting_area', 'Places open once two people have shared where they start.')
  }

  // POST /api/sessions/:id/plan/sync: work the slots and their places out again (E3), after someone changed what they picked or how
  // long they stay (a direct write by that person). Places people vote for stay while they still fit. While inviting or locating there
  // are no slots, and the answer is `changed: false`.
  //
  // How to call:
  //   await sessions.syncPlan({ client: req.supabase, id, userId: req.user.id }) // { planVersion, changed: true }
  function syncPlan({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      if (!['inviting', 'locating'].includes(state.session.status)) requireStatus(state, ['voting'], { what: 'refresh the places' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft, { state }) => {
          check(draft)
          if (draft.session.status !== 'voting') return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, changed: false }) }
          return {
            ops: [],
            needs: 'none',
            pure: true,
            plan: { rank: 'all' },
            answer: ({ version }) => ({ planVersion: version, changed: version !== Number(state.session.plan_version) }),
          }
        },
      },
    )
  }

  // PUT /api/sessions/:id/radius: the host sets how far from the meeting area places are offered, 100 to 3000 metres, or null to let the
  // planner widen on its own (E4). While voting every slot is ranked again: places outside the ring drop out with their votes, and each
  // slot tops up to three again. When votes went, the notice says so for everyone, until it is replaced.
  //
  // How to call:
  //   await sessions.setRadius({ client: req.supabase, id, userId: req.user.id, radiusMeters: 1000 }) // { planVersion, radiusMeters: 1000 }
  function setRadius({ client, id, userId, radiusMeters }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'change the radius')
      requireStatus(state, ['inviting', 'locating', 'voting'], { notYet: ['confirmed'], what: 'change the radius' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const answer = ({ version }) => ({ planVersion: version, radiusMeters })
          if ((draft.session.radius_meters ?? null) === radiusMeters) return { ops: [], needs: 'none', answer }
          draft.session.radius_meters = radiusMeters
          return {
            ops: [],
            needs: 'none',
            session: { radius_meters: radiusMeters },
            ...(draft.session.status === 'voting' && { plan: { rank: 'all', radius: true } }),
            answer,
          }
        },
      },
    )
  }

  // DELETE /api/sessions/:id/slots/:slotId: the host removes a slot (E5). Its places and their votes go with it. Already removed is a no-op.
  //
  // How to call:
  //   await sessions.deleteSlot({ client: req.supabase, id, userId: req.user.id, slotId }) // { planVersion }
  function deleteSlot({ client, id, userId, slotId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'remove a slot')
      requireStatus(state, ['voting'], { what: 'remove a slot' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const category = categoryOfSlot(draft, slotId)
          const slot = category && draft.slots.find((s) => s.category === category)
          if (!slot) throw refuse(404, 'slot_not_found', 'That slot is not in this session.')
          if (slot.deleted) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version }) }
          slot.deleted = true
          draft.options = draft.options.filter((o) => o.category !== category)
          draft.votes = draft.votes.filter((v) => v.category !== category)
          draft.dirty.add(category)
          return { ops: [], needs: 'none', plan: {}, answer: ({ version }) => ({ planVersion: version }) }
        },
      },
    )
  }

  // POST /api/sessions/:id/slots/restore: the host brings back a removed slot, or every removed slot (E6). The restored slots are
  // ranked afresh and start with their top three places.
  //
  // How to call:
  //   await sessions.restoreSlots({ client: req.supabase, id, userId: req.user.id }) // { planVersion, restored: [slotId] }
  function restoreSlots({ client, id, userId, slotId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'restore a slot')
      requireStatus(state, ['voting'], { what: 'restore a slot' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          let targets = draft.slots.filter((s) => s.deleted)
          if (slotId !== undefined) {
            const category = categoryOfSlot(draft, slotId)
            const slot = category && draft.slots.find((s) => s.category === category)
            if (!slot) throw refuse(404, 'slot_not_found', 'That slot is not in this session.')
            targets = targets.filter((s) => s === slot)
          }
          if (targets.length === 0) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, restored: [] }) }
          requireMeetingArea(draft)
          const restored = targets.map((s) => s.id)
          for (const slot of targets) slot.deleted = false
          return { ops: [], needs: 'none', plan: { rank: targets.map((s) => s.category) }, answer: ({ version }) => ({ planVersion: version, restored }) }
        },
      },
    )
  }

  // POST /api/sessions/:id/slots/:slotId/options: a joined member adds a place to a slot (E7). The place must be a saved one and must
  // fit the slot: the planner is asked with it among the options, and it must come back as one that still fits. Already an option is a
  // no-op (`added: false`).
  //
  // How to call:
  //   await sessions.addOption({ client: req.supabase, id, userId: req.user.id, slotId, venueId: 'ya-kun-kaya-toast' }) // { planVersion, added: true }
  function addOption({ client, id, userId, slotId, venueId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['voting'], { what: 'add a place' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft, ctx) => {
          check(draft)
          const slot = liveSlot(draft, slotId)
          const venue = voting.venues.get(venueId)
          if (!venue) throw refuse(404, 'venue_not_found', 'That place is not one Jio knows.')
          const options = optionsOf(draft, slot.category)
          if (options.some((o) => o.venue_id === venueId)) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, added: false }) }
          if (options.length >= OPTIONS_MAX) throw refuse(409, 'slot_full', `A slot holds up to ${OPTIONS_MAX} places.`)
          requireMeetingArea(draft)
          const ranking = await voting.rankSlot(draft, slot, [...options.map((o) => o.venue_id), venueId], ctx)
          if (!ranking.current.has(venueId)) throw refuse(422, 'venue_does_not_fit', `${venue.name} does not fit this slot.`)
          draft.options.push(optionRow(slot.category, ranking.rows.get(venueId), { source: 'member', addedBy: userId }))
          draft.dirty.add(slot.category)
          return { ops: [], needs: 'none', plan: {}, answer: ({ version }) => ({ planVersion: version, added: true }) }
        },
      },
    )
  }

  // POST /api/sessions/:id/slots/:slotId/options/more: "more suggestions" (E8). The slot gets the next best places, three more than the
  // `have` the caller saw, up to six; if it already holds that many, nothing is added, so a retry never adds again.
  //
  // How to call:
  //   await sessions.addMoreOptions({ client: req.supabase, id, userId: req.user.id, slotId, have: 3 }) // { planVersion, added: ['ya-kun-kaya-toast'] }
  function addMoreOptions({ client, id, userId, slotId, have }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['voting'], { what: 'add places' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft, ctx) => {
          check(draft)
          const slot = liveSlot(draft, slotId)
          const options = optionsOf(draft, slot.category)
          const ids = options.map((o) => o.venue_id)
          const target = Math.min(OPTIONS_MAX, have + OPTIONS_MORE)
          if (ids.length >= target) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, added: [] }) }
          requireMeetingArea(draft)
          const ranking = await voting.rankSlot(draft, slot, ids, ctx)
          const next = moreOptions(ids, ranking.rankedIds, { add: target - ids.length })
          const added = next.filter((venueId) => !ids.includes(venueId))
          for (const venueId of added) draft.options.push(optionRow(slot.category, ranking.rows.get(venueId)))
          if (added.length > 0) draft.dirty.add(slot.category)
          return { ops: [], needs: 'none', ...(added.length > 0 && { plan: {} }), answer: ({ version }) => ({ planVersion: version, added }) }
        },
      },
    )
  }

  // POST /api/sessions/:id/slots/:slotId/options/:venueId/swap: a joined member swaps one place of a slot for another (E9), for example
  // an indoor place when it rains. The place changes in place, so the votes for it follow it. The new place must be a saved one that fits.
  // Swapping again, when the old place is gone, is a no-op (`swapped: false`).
  //
  // How to call:
  //   await sessions.swapOption({ client: req.supabase, id, userId: req.user.id, slotId, fromId: 'east-coast-park', toId: 'toa-payoh-library' })
  //   // { planVersion, swapped: true }
  function swapOption({ client, id, userId, slotId, fromId, toId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['voting'], { what: 'swap a place' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft, ctx) => {
          check(draft)
          const slot = liveSlot(draft, slotId)
          const to = voting.venues.get(toId)
          if (!to) throw refuse(404, 'venue_not_found', 'That place is not one Jio knows.')
          const options = optionsOf(draft, slot.category)
          const from = options.find((o) => o.venue_id === fromId)
          const there = options.find((o) => o.venue_id === toId)
          if (!from) {
            if (there) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, swapped: false }) }
            throw refuse(404, 'option_not_found', 'That place is not an option of this slot.')
          }
          if (fromId === toId) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, swapped: false }) }
          requireMeetingArea(draft)
          const ids = options.map((o) => o.venue_id).filter((v) => v !== fromId)
          const ranking = await voting.rankSlot(draft, slot, there ? ids : [...ids, toId], ctx)
          if (!ranking.current.has(toId)) throw refuse(422, 'venue_does_not_fit', `${to.name} does not fit this slot.`)
          // The place changes in place (or merges into the one already there), and the votes for it follow.
          for (const v of draft.votes) if (v.category === slot.category && v.venue_id === fromId) v.venue_id = toId
          draft.options = draft.options.filter((o) => !(o.category === slot.category && o.venue_id === fromId))
          const row = optionRow(slot.category, ranking.rows.get(toId), { source: from.source, addedBy: from.added_by })
          if (there) Object.assign(draft.options.find((o) => o.category === slot.category && o.venue_id === toId), { rank: row.rank, score: row.score, details: row.details })
          else draft.options.push(row)
          draft.dirty.add(slot.category)
          return {
            ops: [{ op: 'swap_option', category: slot.category, from: fromId, to: toId }],
            needs: 'none',
            plan: {},
            answer: ({ version }) => ({ planVersion: version, swapped: true }),
          }
        },
      },
    )
  }

  // GET /api/sessions/:id/slots/:slotId/venue-search?q=: a joined member searches the saved places by name for a slot (E17). Each result
  // says whether it fits the slot and, if not, why, and whether it is already an option. Changes nothing, so it does not wait in the
  // session's line; the service key is used only after admission has passed.
  //
  // How to call:
  //   await sessions.searchSlot({ client: req.supabase, id, userId: req.user.id, slotId, query: 'ya kun' }) // { results: [...] }
  async function searchSlot({ client, id, userId, slotId, query }) {
    userId = lower(userId)
    id = lower(id)
    const state = await admit(client, id, userId)
    requireJoined(state, userId)
    requireStatus(state, ['voting'], { what: 'search for a place' })
    const full = await within(loadState(service, id), dbDeadlineMs, 'reading the session')
    if (!full.session) throw refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.')
    const draft = draftOf(full)
    const slot = liveSlot(draft, slotId)
    requireMeetingArea(draft)
    let needsRead
    const ctx = { needs: () => (needsRead ??= within(loadNeeds(service, id), dbDeadlineMs, "reading the members' needs")) }
    return { results: await voting.searchSlot(draft, slot, query, ctx) }
  }


  // ── The plan: the suggested order, confirming, the stops, finishing ────

  // The caller must be the host of a confirmed plan (every edit of the stops, finishing, and the answer to a re-plan prompt).
  //
  // How to call:
  //   const check = confirmedPlanCheck(userId, 'delete a stop')
  const confirmedPlanCheck = (userId, what) => (state) => {
    requireJoined(state, userId)
    requireHost(state, userId, what)
    requireStatus(state, ['confirmed'], { what })
  }

  // The stop of the draft with this id, or 404.
  //
  // How to call:
  //   const row = stopOf(draft, stopId)
  function stopOf(draft, stopId) {
    const row = draft.stops.find((s) => s.id === stopId)
    if (!row) throw refuse(404, 'stop_not_found', 'That stop is not in this plan.')
    return row
  }

  // A job that rewrites the whole list of stops: the rows and the plan's start it was given, and the note about the order cleared (the stops
  // are no longer exactly in the order that was suggested).
  //
  // How to call:
  //   return stopsJob(rows, planStart, { stopOptions }, answer)
  function stopsJob({ rows, planStart }, extra, answer) {
    return {
      ops: [],
      needs: 'none',
      session: { order_note: null, plan_start_minute: planStart },
      stops: rows,
      ...extra,
      answer,
    }
  }

  // POST /api/sessions/:id/order/suggest: the host asks for a suggested order of the stops the votes make now (E22). The order is chosen among
  // the orders that keep every place open and every meal on time (planner/arrange.js), by the itinerary AI inside its own budget, or by the
  // rules when it cannot answer. It is stored with the session (`order_suggestion`) with a hash of the stops it was made for (`basis`), so
  // asking again for the same stops makes no AI call, and confirming with `order: 'suggested'` is refused when the stops have moved since.
  // The browser sends nothing but the request: the stops, the sentence and who chose it all come from stored rows. Only the names, kinds,
  // opening hours and settings of the places, the times, and whether it rains go to the AI provider, never anything about a person.
  //
  // How to call:
  //   await sessions.suggestOrder({ client: req.supabase, id, userId: req.user.id })
  //   // { status: 'ok', basis, order: [slotId], stops: [{ slotId, venueId, start }], reason, source: 'ai' | 'rules' }
  //   // or { status: 'none', why: 'one_movable' | 'no_order_fits' | 'no_stops' | 'unknown_place' }
  async function suggestOrder({ client, id, userId }) {
    userId = lower(userId)
    id = lower(id)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'ask for a suggested order')
      requireStatus(state, ['voting'], { what: 'suggest an order' })
    }
    check(await admit(client, id, userId))
    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      const state = await within(loadState(service, id), dbDeadlineMs, 'reading the session')
      if (!state.session) throw refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.')
      const draft = draftOf(state)
      check(draft)
      if (votersOf(draft) < 2) throw refuse(409, 'not_enough_votes', 'At least two people need to vote before an order can be suggested.')
      const stops = votedStops(draft)
      if (stops.length === 0) return { status: 'none', why: 'no_stops' }
      const basis = basisOf(draft.session, stops)
      const answerOf = (stored) => ({
        status: 'ok',
        basis,
        order: stored.order,
        stops: stored.order.map((slotId) => ({ slotId, venueId: stops.find((s) => s.slotId === slotId).venueId, start: stored.starts[slotId] })),
        reason: stored.reason,
        source: stored.source,
      })
      // The same stops as the stored suggestion: nothing to work out, nothing to write, no AI call.
      const stored = state.session.order_suggestion
      if (stored?.basis === basis && suggestionFits(stops, stored)) return answerOf(stored)
      if (stops.some((s) => !voting.venues.has(s.venueId))) return { status: 'none', why: 'unknown_place' }
      if (stops.filter((s) => s.category !== 'eat').length < 2) return { status: 'none', why: 'one_movable' }
      const { candidates } = arrangeCandidates(arrangeInput(stops, (venueId) => voting.venues.get(venueId), draft.session))
      const { options } = freshCandidates(candidates, [], { includeCurrent: true })
      if (options.length === 0) return { status: 'none', why: 'no_order_fits' }
      // The AI never throws because it is down, slow or over budget: it falls back to the rules.
      const choice = ai ? await ai.choose({ options, rain: currentScenario() === 'rain' }) : { index: 0, reason: 'Every place is open and every meal is on time in this order.', source: 'rules' }
      const chosen = options[choice.index] ?? options[0]
      const suggestion = {
        basis,
        order: chosen.ids,
        starts: Object.fromEntries(chosen.stops.map((s) => [s.id, s.start])),
        reason: choice.reason,
        source: choice.source === 'ai' ? 'ai' : 'rules',
        at: now(),
      }
      try {
        await submit(
          { client, id, userId },
          {
            check,
            prepare: (current) => {
              check(current)
              // The votes (or the places) moved while the order was worked out: this suggestion is for stops that are gone.
              if (basisOf(current.session, votedStops(current)) !== basis) throw refuse(409, 'plan_busy', 'The votes changed while an order was worked out. Try again.', { retryAfter: 1 })
              return { ops: [], needs: 'none', session: { order_suggestion: suggestion }, answer: ({ version }) => ({ planVersion: version }) }
            },
          },
        )
      } catch (err) {
        if (err instanceof SessionError && err.code === 'plan_busy' && attempt + 1 < MAX_TRIES) continue
        throw err
      }
      return answerOf(suggestion)
    }
    throw refuse(409, 'plan_busy', 'The votes changed while an order was worked out. Try again.', { retryAfter: 1 })
  }

  // POST /api/sessions/:id/confirm: the host confirms the plan (E12), voting to confirmed. The stops are written from the stored winners of
  // each slot, laid back to back inside the session's window (the browser never sends a stop, a time or a sentence). `order: 'voted'` (or
  // nothing) keeps the voted order. `order: 'suggested'` takes the stored suggested order, with its sentence and who chose it, only if the
  // body's `basis` is the stored suggestion's AND the stops the votes make now still hash to it: otherwise 409 order_stale and nothing is
  // written, and the host asks for a suggestion again. At least two joined people must have voted. Confirming again is a no-op.
  //
  // How to call:
  //   await sessions.confirmPlan({ client: req.supabase, id, userId: req.user.id, order: 'suggested', basis })
  //   // { planVersion, status: 'confirmed', stops: 3 }
  function confirmPlan({ client, id, userId, order = 'voted', basis }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'confirm the plan')
      if (state.session.status !== 'confirmed') requireStatus(state, ['voting'], { what: 'confirm the plan' })
    }
    return submit(
      { client, id, userId },
      {
        exclusive: true,
        check,
        prepare: (draft) => {
          check(draft)
          if (draft.session.status === 'confirmed') {
            return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, status: 'confirmed', stops: draft.stops.length }) }
          }
          if (votersOf(draft) < 2) throw refuse(409, 'not_enough_votes', 'At least 2 people need to vote first.')
          const stops = votedStops(draft)
          if (stops.length === 0) throw refuse(409, 'nothing_to_confirm', 'Vote for at least one place first.')
          let suggestion = null
          if (order === 'suggested') {
            const stored = draft.session.order_suggestion
            const current = basisOf(draft.session, stops)
            if (!basis || basis !== current || stored?.basis !== current || !suggestionFits(stops, stored)) {
              throw refuse(409, 'order_stale', 'The votes changed since this order was suggested. Look at the order again.')
            }
            suggestion = stored
          }
          const { rows, planStart } = confirmedRows(stops, (venueId) => voting.venues.get(venueId), suggestion)
          const note = suggestion ? { reason: suggestion.reason, source: suggestion.source === 'ai' ? 'ai' : 'rules' } : null
          return {
            ops: [],
            needs: 'none',
            session: { status: 'confirmed', banner: null, replan: null, plan_start_minute: planStart, order_note: note },
            stops: rows,
            answer: ({ version }) => ({ planVersion: version, status: 'confirmed', stops: rows.length }),
          }
        },
      },
    )
  }

  // POST /api/sessions/:id/replan: the host opens a confirmed plan for voting again (E13), or turns down the "plan again?" prompt with
  // `accept: false` (which only clears the prompt). Opening it again takes the stops, the order note and the suggested order away, dismisses
  // the proposals still waiting, works the meeting area out again (a chosen area stays; the planner's own pick may move, and then the votes
  // go) and ranks the slots again. Already voting is a no-op.
  //
  // How to call:
  //   await sessions.replan({ client: req.supabase, id, userId: req.user.id, accept: true }) // { planVersion, status: 'voting' }
  function replan({ client, id, userId, accept = true }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'plan again')
      if (state.session.status !== 'voting') requireStatus(state, ['confirmed'], { what: 'plan again' })
    }
    return submit(
      { client, id, userId },
      {
        exclusive: true,
        check,
        prepare: (draft) => {
          check(draft)
          if (draft.session.status === 'voting') return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, status: 'voting' }) }
          if (!accept) {
            return { ops: [], needs: 'none', session: { replan: null }, answer: ({ version }) => ({ planVersion: version, status: 'confirmed' }) }
          }
          Object.assign(draft.session, { status: 'voting', banner: null, replan: null, order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null })
          draft.stops = []
          draft.proposals = []
          return {
            ops: [],
            needs: 'none',
            session: { status: 'voting', banner: null, replan: null },
            plan: { meeting: true, rank: 'all', trigger: { kind: 'replan', name: '' } },
            answer: ({ version }) => ({ planVersion: version, status: 'voting' }),
          }
        },
      },
    )
  }

  // DELETE /api/sessions/:id/stops/:stopId: the host takes a stop out of the plan (E15). The stops after it move up, the legs either side merge
  // into one with its default mode, the order note and every stop's earliest start from the order go, and when the first stop goes the plan
  // starts when the next one does. The last stop cannot be deleted.
  //
  // How to call:
  //   await sessions.deleteStop({ client: req.supabase, id, userId: req.user.id, stopId }) // { planVersion }
  function deleteStop({ client, id, userId, stopId }) {
    userId = lower(userId)
    const check = confirmedPlanCheck(userId, 'delete a stop')
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          stopOf(draft, stopId)
          if (draft.stops.length <= 1) throw refuse(409, 'last_stop', 'A plan needs at least one stop.')
          const result = withoutStop(draft.stops, stopId, draft.session, ctxVenue)
          return stopsJob(result, {}, ({ version }) => ({ planVersion: version }))
        },
      },
    )
  }

  // PATCH /api/sessions/:id/stops/:stopId: the host sets how the group gets to a stop from the stop before (E15): walk, mrt or car, or null for
  // the default. The first stop has no leg into it (409 no_leg). Setting the mode it already has changes nothing.
  //
  // How to call:
  //   await sessions.setTravelMode({ client: req.supabase, id, userId: req.user.id, stopId, mode: 'car' }) // { planVersion, travelMode: 'car' }
  function setTravelMode({ client, id, userId, stopId, mode }) {
    userId = lower(userId)
    const check = confirmedPlanCheck(userId, 'change how the group travels')
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          stopOf(draft, stopId)
          const result = withMode(draft.stops, stopId, mode, draft.session, ctxVenue)
          if (!result) throw refuse(409, 'no_leg', 'The first stop has no leg before it.')
          return {
            ops: [],
            needs: 'none',
            session: { plan_start_minute: result.planStart },
            stops: result.rows,
            answer: ({ version }) => ({ planVersion: version, travelMode: mode }),
          }
        },
      },
    )
  }

  // PUT /api/sessions/:id/stops/order: the host sets the order of the stops (E15). `stopIds` names every stop of the plan once, in the new
  // order, or the plan has changed (409 stops_changed). The plan keeps its start; every stop follows the one before it; the travel modes go back
  // to their defaults (the legs are new pairs); the order note and the earliest starts from the order go. The same order again changes nothing.
  //
  // How to call:
  //   await sessions.reorderStops({ client: req.supabase, id, userId: req.user.id, stopIds: [b, a, c] }) // { planVersion }
  function reorderStops({ client, id, userId, stopIds }) {
    userId = lower(userId)
    const check = confirmedPlanCheck(userId, 'rearrange the stops')
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const result = reorderedRows(draft.stops, stopIds, draft.session, ctxVenue)
          if (!result) throw refuse(409, 'stops_changed', 'The plan has changed. Look at it again.')
          // The same order: the modes and earliest starts stay as they are.
          if (stopIds.every((stopId, i) => draft.stops[i].id === stopId)) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version }) }
          return stopsJob(result, {}, ({ version }) => ({ planVersion: version }))
        },
      },
    )
  }

  // PUT /api/sessions/:id/stops/:stopId/place: the host puts another place in a stop (E15), for the rain swap and for Replace: the one way a
  // confirmed stop's place changes. Refused unless the stop still holds `seenVenueId`, the place the caller saw (409 stop_changed), and
  // unless the place is a saved one (404), not already another stop (409 already_a_stop) and fits the stop: the planner is asked for it at the
  // time the stop starts in the itinerary now, as the plan's last stop if it is (422 venue_does_not_fit). The stop keeps its length, never starts
  // earlier than the time the planner checked it for, the legs either side go back to their default modes, the order note goes, and the new
  // place is kept as an option of the stop's slot with what the planner said about it (the old place leaves the options, with its votes).
  // `category` makes it another kind of stop. Asking again once the stop holds the place changes nothing.
  //
  // How to call:
  //   await sessions.changeStopPlace({ client: req.supabase, id, userId: req.user.id, stopId, venueId: 'toa-payoh-library', seenVenueId: 'east-coast-park' })
  //   // { planVersion, changed: true }
  function changeStopPlace({ client, id, userId, stopId, venueId, seenVenueId, category }) {
    userId = lower(userId)
    const check = confirmedPlanCheck(userId, 'replace a stop')
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft, ctx) => {
          check(draft)
          const row = stopOf(draft, stopId)
          const venue = voting.venues.get(venueId)
          if (!venue) throw refuse(404, 'venue_not_found', 'That place is not one Jio knows.')
          const kind = category ?? row.category ?? venue.category
          if (row.venue_id === venueId && row.category === kind) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, changed: false }) }
          if (row.venue_id !== seenVenueId) throw refuse(409, 'stop_changed', 'That stop has changed. Look at the plan again.')
          if (draft.stops.some((s) => s.id !== row.id && s.venue_id === venueId)) throw refuse(409, 'already_a_stop', `${venue.name} is already in the plan.`)
          const index = draft.stops.indexOf(row)
          const startedAt = timedRows(draft.stops, ctxVenue, startOf(draft.session, draft.stops)).timed[index].start
          const slot = { category: kind, start_minute: Math.min(1439, startedAt), duration_minutes: row.duration_minutes }
          requireMeetingArea(draft)
          const ranking = await voting.rankSlot(draft, slot, [venueId], ctx, { last: index === draft.stops.length - 1 })
          if (!ranking.current.has(venueId)) throw refuse(422, 'venue_does_not_fit', `${venue.name} does not fit this stop.`)
          const result = withPlace(draft.stops, stopId, { venueId, category: kind, startedAt: Math.min(1439, startedAt) }, draft.session, ctxVenue)
          const kept = row.slot_id ? optionRow(kind, ranking.rows.get(venueId)) : null
          return stopsJob(
            result,
            kept ? { stopOptions: [{ slot_id: row.slot_id, venue_id: venueId, rank: kept.rank, score: kept.score, source: 'planner', added_by: null, details: kept.details, replaces: row.venue_id }] } : {},
            ({ version }) => ({ planVersion: version, changed: true }),
          )
        },
      },
    )
  }

  // POST /api/sessions/:id/complete: the host finishes the outing (E14), confirmed to completed. The server works the travel ledger out from
  // stored rows, never from the browser: for each joined person who has minutes in (stored when the meeting spot was confirmed), the minutes in,
  // the minutes between stops (the stored leg minutes), and the minutes home, routed from the last stop to the centre of the area they end the
  // day in (OneMap through the shared runs, inside the request's allowance, with the estimate where it cannot route). The deltas from the
  // mean sum to exactly zero. The ledger and the status are written together; a retry after success is a no-op, and it is refused unless
  // the plan is confirmed.
  //
  // How to call:
  //   await sessions.completeOuting({ client: req.supabase, id, userId: req.user.id }) // { planVersion, status: 'completed' }
  function completeOuting({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'finish the outing')
      if (state.session.status !== 'completed') requireStatus(state, ['confirmed'], { what: 'finish the outing' })
    }
    return submit(
      { client, id, userId },
      {
        exclusive: true,
        check,
        prepare: async (draft, { allowance }) => {
          check(draft)
          if (draft.session.status === 'completed') return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, status: 'completed' }) }
          const people = ledgerPeople(draft.members)
          const between = minutesBetween(draft.stops)
          const last = draft.stops.at(-1)
          const lastVenue = last ? voting.venues.get(last.venue_id) : null
          const ends = people.map((m) => ({ id: lower(m.user_id), area: areasById.get(m.end_area_id) ?? areasById.get(m.start_area_id) })).filter((p) => p.area)
          let home = {}
          if (lastVenue && ends.length > 0) {
            const input = {
              from: { id: lastVenue.id, lat: lastVenue.lat, lng: lastVenue.lng },
              people: ends.map((p) => ({ id: p.id, end: { lat: p.area.lat, lng: p.area.lng } })),
              dateTime: dateTimeOf(draft.session),
            }
            const { result, travel } = await runs.runWithTravel(input, data, homeTripsRun, () => ({
              maxTrips: allowance.trips,
              deadlineMs: Math.max(0, allowance.deadlineAt - Date.now()),
            }))
            spend(allowance, travel)
            home = result.minutes
          }
          const ledger = ledgerFor(people.map((m) => ({ userId: lower(m.user_id), minutesIn: m.travel_minutes, minutesBetween: between, minutesHome: home[lower(m.user_id)] ?? 0 })))
          draft.session.status = 'completed'
          return { ops: [], needs: 'none', session: { status: 'completed', replan: null }, ledger, answer: ({ version }) => ({ planVersion: version, status: 'completed' }) }
        },
      },
    )
  }

  // POST /api/sessions/:id/proposals: a joined member puts a saved place forward as the next stop (E23), while the plan is confirmed. The place
  // must be one Jio knows (404), not already a stop (409 already_a_stop), and the plan not full (409 plan_full); a member has at most 3
  // waiting and the session 10 (409 too_many_proposals). A place that is already waiting stays its first proposer's: nothing changes and the
  // answer says `applied: false` with that proposal's id.
  //
  // How to call:
  //   await sessions.proposeStop({ client: req.supabase, id, userId: req.user.id, venueId: 'ya-kun-kaya-toast' }) // { planVersion, id, applied: true }
  function proposeStop({ client, id, userId, venueId }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['confirmed'], { what: 'propose a place' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const venue = voting.venues.get(venueId)
          if (!venue) throw refuse(404, 'venue_not_found', 'That place is not one Jio knows.')
          if (draft.stops.some((s) => s.venue_id === venueId)) throw refuse(409, 'already_a_stop', `${venue.name} is already in the plan.`)
          const waiting = draft.proposals.find((p) => p.venue_id === venueId)
          if (waiting) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, id: waiting.id, applied: false }) }
          const proposalId = randomUUID()
          return { ops: [{ op: 'propose', id: proposalId, user_id: userId, venue_id: venueId }], needs: 'none', answer: ({ version }) => ({ planVersion: version, id: proposalId, applied: true }) }
        },
      },
    )
  }

  // POST /api/sessions/:id/proposals/:proposalId/resolve: the host adds a proposed place to the plan (`accept: true`), or leaves it out
  // (`accept: false`); the person who proposed it may also leave it out, which is taking it back (E24). Adding appends a stop at the end, in the
  // place's own category, lasting 60 minutes, which may not start before the last stop ends or now, whichever is later (the time the list of
  // places was ranked for); it clears the note about the order. A plan of 8 stops takes no more (409 plan_full). A proposal that is not waiting
  // any more (answered, or cleared by a re-plan or the end of the outing) changes nothing: `applied: false`.
  //
  // How to call:
  //   await sessions.resolveProposal({ client: req.supabase, id, userId: req.user.id, proposalId, accept: true }) // { planVersion, applied: true }
  function resolveProposal({ client, id, userId, proposalId, accept }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['confirmed'], { what: 'answer a proposal' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const proposal = draft.proposals.find((p) => lower(p.id) === lower(proposalId))
          if (!proposal) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, applied: false }) }
          const isHost = lower(draft.session.host_id) === userId
          if (accept && !isHost) throw refuse(403, 'host_only', 'Only the host can add a place to the plan.')
          if (!accept && !isHost && lower(proposal.proposed_by) !== userId) throw refuse(403, 'host_only', 'Only the host, or the person who proposed it, can dismiss it.')
          const ops = [{ op: 'resolve_proposal', proposal_id: proposal.id, status: accept ? 'accepted' : 'dismissed', by: userId }]
          const answer = ({ version }) => ({ planVersion: version, applied: true })
          if (!accept) return { ops, needs: 'none', answer }
          const venue = voting.venues.get(proposal.venue_id)
          if (!venue) throw refuse(404, 'venue_not_found', 'That place is not one Jio knows.')
          if (draft.stops.some((s) => s.venue_id === proposal.venue_id)) return { ops, needs: 'none', answer }
          if (draft.stops.length >= MAX_STOPS) throw refuse(409, 'plan_full', `A plan holds up to ${MAX_STOPS} stops.`)
          const timed = draft.stops.length ? timedRows(draft.stops, ctxVenue, startOf(draft.session, draft.stops)).timed : []
          const endedAt = timed.at(-1)?.end ?? null
          const sgMinutes = Number(nowInSingapore().slice(11, 13)) * 60 + Number(nowInSingapore().slice(14, 16))
          const notBefore = Math.max(endedAt ?? 0, sgMinutes)
          const result = withAddedStop(draft.stops, { venueId: proposal.venue_id, category: venue.category, notBefore, duration: 60, endedAt }, draft.session, ctxVenue)
          return { ...stopsJob(result, {}, answer), ops }
        },
      },
    )
  }

  return {
    recompute,
    suggestSpot,
    withdrawSpot,
    optOut,
    rejoin,
    removeMember,
    confirmSpot,
    setKnownPlace,
    syncPlan,
    setRadius,
    deleteSlot,
    restoreSlots,
    addOption,
    addMoreOptions,
    swapOption,
    searchSlot,
    suggestOrder,
    confirmPlan,
    replan,
    deleteStop,
    setTravelMode,
    reorderStops,
    changeStopPlace,
    completeOuting,
    proposeStop,
    resolveProposal,
    queue,
  }
}
