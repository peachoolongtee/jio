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
import { fromMinutes, moreOptions, OPTIONS_MAX, OPTIONS_MORE } from '../planner/slot-plan.js'
import { MAX } from '../routes/plan-schemas.js'
import { nowInSingapore } from './planner-runs.js'
import { currentScenario } from './scenario.js'
import { HISTORY_OUTINGS, historySince, visitsFrom } from './session-history.js'
import {
  arrangeInput,
  basisOf,
  confirmedRows,
  MAX_STOPS,
  PROPOSALS_PER_MEMBER,
  PROPOSALS_PER_SESSION,
  reorderedRows,
  ROAM_MINUTES,
  shownStops,
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
  releasedBannerText,
  spotRowsFrom,
  suggestedAreaIds,
} from './session-plan.js'
import { categoryOfSlot, optionRow, optionsOf, roamReply } from './session-slots.js'
import { createVoting, dateTimeOf, newAllowance, spend } from './session-voting.js'
import { ROUTING_DEADLINE_MS } from './travel-times.js'

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
  stale_tally: [409, 'order_stale', 'The votes changed while the plan was being confirmed. Look at them again.'],
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

// Builds the reader for something the planner can do without (the group's past): it waits at most `ms`, and on any failure at all (a database
// error, a function that is not on the project, a timeout) answers `fallback` and says so in the log, at most once a minute for each service.
// The log line holds only what was being read and the kind of failure, never a message from the database.
//
// How to call:
//   const soft = createSoftly(8000)
//   const debts = await soft(() => loadDebts(service, id), 'reading the travel debt', null)
function createSoftly(ms) {
  let lastWarning = 0
  return (work, what, fallback) =>
    within(work(), ms, what).catch((err) => {
      const at = Date.now()
      if (at - lastWarning > 60_000) {
        lastWarning = at
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

// Singapore's date and the minutes since its midnight, now. How to call: singaporeDay() // '2026-10-25'; singaporeMinutes() // 750
const singaporeDay = () => nowInSingapore().slice(0, 10)
const singaporeMinutes = () => Number(nowInSingapore().slice(11, 13)) * 60 + Number(nowInSingapore().slice(14, 16))

// Is the session's day today in Singapore? How to call: onTheDay({ date: '2026-10-25' }) // true on 25 October 2026
const onTheDay = (session) => String(session.date).slice(0, 10) === singaporeDay()

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
  // Reads something the planner can do without, within this service's database deadline (see createSoftly).
  const soft = createSoftly(dbDeadlineMs)
  // The places of a draft's stops for laying the itinerary out: a place Jio does not know stands where the meeting area is, as it does on the
  // screens, so the legs to and from it (and so every start after it) are the same on both sides. (Without a meeting area, the centre of Singapore.)
  //
  // How to call:
  //   timedRows(draft.stops, layoutVenue(draft), startOf(draft.session, draft.stops))
  function layoutVenue(draft) {
    const area = areasById.get(draft.session.meeting_area_id)
    return (venueId) => voting.venues.get(venueId) ?? (area ? { lat: area.lat, lng: area.lng } : undefined)
  }
  // When each voted stop of a draft was voted to start, by slot, for the plan to start at when its first stop goes.
  //
  // How to call:
  //   withoutStop(draft.stops, stopId, draft.session, layoutVenue(draft), votedStartsOf(draft))
  const votedStartsOf = (draft) => {
    const starts = new Map(votedStops(draft).map((s) => [s.slotId, s.plannedStart]))
    return (slotId) => starts.get(slotId) ?? null
  }

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
      ...allowance.routing(),
    }))
    spend(allowance, travel)
    return { rows: spotRowsFrom(result, travel), skipped, travel }
  }

  // What a ranking reads besides the draft, each read once and only if a ranking asks (the service key is used here, after admission has passed):
  // the members' private needs, and the group's past, read softly: any failure, or a database too slow, answers nothing and the planner goes on
  // without it. The finished outings are read with the service key for every joined member, so what is stored does not depend on who asked (only
  // the places and days of outings that at least two of this group were in leave the reader: see session-history.js); the travel debt is the
  // server's own function. `allowance` is the request's OneMap trips and deadline, shared by every run it makes.
  //
  // How to call:
  //   const ctx = contextFor({ sessionId, state, allowance })
  function contextFor({ sessionId, state, allowance }) {
    let needsRead
    let debtsRead
    let visitsRead
    return {
      allowance,
      state,
      venueOf: (venueId) => voting.venues.get(venueId),
      needs: () => (needsRead ??= within(loadNeeds(service, sessionId), dbDeadlineMs, "reading the members' needs")),
      debts: () => (debtsRead ??= soft(() => loadDebts(service, sessionId), 'reading the travel debt', null)),
      visits: () =>
        (visitsRead ??= soft(
          async () => {
            const joined = state.members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id))
            const outings = await loadPastOutings(service, { since: historySince(now()), limit: HISTORY_OUTINGS, userIds: joined })
            return visitsFrom({ outings, sessionId, joined: new Set(joined) })
          },
          'reading the finished outings',
          [],
        )),
    }
  }

  // ── Running a batch ────────────────────────────────────────────────────

  // Runs one batch of jobs for a session: load, do every job to a copy, work out the spots once if any job needs them (while the group is
  // choosing where to meet) or the meeting area and the slots once (while it is voting), and write it all through apply_session_plan.
  // Settles every job. Called by the queue.
  //
  // How to call (the queue does this):
  //   await runBatch(sessionId, { exclusive: false, jobs }, { handOver })
  async function runBatch(sessionId, batch, { handOver }) {
    const allowance = newAllowance(routingDeadlineMs)
    const dropped = new Set()
    const reject = (job, err) => {
      dropped.add(job)
      job.settle.reject(err)
    }

    for (let attempt = 0; attempt < MAX_TRIES; attempt += 1) {
      // Each attempt waits for OneMap for as long as the first did: the clock starts again, while the trips left are still the request's.
      // An attempt that finds no trips left prices its spots on estimates and says so (`approximate`), it is never given no time at all.
      allowance.restartClock()
      // Taken before the members are read, so a member row changed after it has an updated_at later than the spots' computed_at.
      const loadedAt = new Date().toISOString()
      const state = await within(loadState(service, sessionId), dbDeadlineMs, 'reading the session')
      if (!state.session) {
        for (const job of batch.jobs) if (!dropped.has(job)) reject(job, refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.'))
        return
      }
      const draft = draftOf(state)
      const spotsBefore = draft.spots
      // The members' private needs and the group's past, read once and only if a ranking asks (see contextFor).
      const ctx = contextFor({ sessionId, state, allowance })
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
      let applied = false
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
          applied = true
        } catch (err) {
          if (!(err instanceof PlanRefused)) throw err
          // The function refuses the whole write, and cannot say which job caused it. The jobs checked their own limits before, so this is a race
          // (the session changed between the run's read and its lock). One job's refusal must not refuse the others written with it: with
          // several in the run, each is done again on its own, and a job that is refused alone is the offender.
          if (live.length > 1) {
            for (const { job } of live) await runBatch(sessionId, { ...batch, jobs: [job] }, { handOver: () => false })
            return
          }
          const error = refusalOf(err.hint)
          for (const { job } of live) reject(job, error)
          return
        }
      }
      // What a job records after its change was written (never when nothing was written, or the write was refused).
      if (applied) for (const { prepared } of live) if (prepared.afterApply) await prepared.afterApply()
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
  //   afterApply  () => a promise: something to record once the write has gone through (the host's Start choice after a known place).
  //            It must not fail the request, which has already succeeded.
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
  // Once the plan is confirmed nothing changes it silently (the design's state machine): the person is out, their votes and the places they
  // put forward as the next stop go with them, and the one write to the plan is the question "Re-plan?" in `sessions.replan` ({ reason, trigger,
  // at }, the browser's own words: "Faith opted out. The meeting area would stay at Bugis."), which the host answers (POST .../replan). The
  // sentence says whether the planner's own pick of meeting area would move without them (a chosen area never does); that is worked out, not written.
  //
  // How to call:
  //   await sessions.optOut({ client: req.supabase, id, userId: req.user.id }) // { planVersion, state: 'opted_out' }
  function optOut({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      const me = requireMember(state, userId)
      if (me.role === 'host' || lower(state.session.host_id) === userId) throw refuse(403, 'host_cannot_opt_out', 'The host cannot opt out. Cancel the session instead.')
      requireStatus(state, ['inviting', 'locating', 'voting', 'confirmed'], { what: 'opt out' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: async (draft, ctx) => {
          check(draft)
          const me = requireMember(draft, userId)
          if (me.state === 'opted_out') return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, state: 'opted_out' }) }
          // Everything that can fail (the name, the pricing of the meeting area) is asked first on a copy; the run's draft changes after the last
          // await, so a job that fails leaves the draft as the jobs after it expect it.
          const confirmed = draft.session.status === 'confirmed'
          const voting = draft.session.status === 'voting'
          const apart = confirmed ? { ...draft, members: draft.members.map((m) => (m === me ? { ...m, state: 'opted_out' } : m)) } : null
          const prompt = confirmed ? await optOutPrompt(apart, ctx, userId) : null
          const plan = voting ? await votingPlan(userId, 'optout') : null
          me.state = 'opted_out'
          const theirs = draft.suggestions.filter((s) => lower(s.user_id) === userId).map((s) => s.area_id)
          draft.suggestions = draft.suggestions.filter((s) => lower(s.user_id) !== userId)
          draft.approvals = draft.approvals.filter((a) => lower(a.user_id) !== userId)
          draft.votes = draft.votes.filter((v) => lower(v.user_id) !== userId)
          if (confirmed) return optOutOfPlan(draft, userId, prompt)
          return {
            ops: [{ op: 'opt_out', user_id: userId }],
            needs: voting ? 'none' : 'recompute',
            nameIds: [userId],
            removes: theirs,
            reason: (nameOf) => describeChange('optout', nameOf(userId)),
            ...(plan && { plan }),
            answer: ({ version }) => ({ planVersion: version, state: 'opted_out' }),
          }
        },
      },
    )
  }

  // The "Re-plan?" question for a guest opting out of a confirmed plan: what it says, from a pricing of the meeting area without the person that
  // nothing stores. `without` is the draft with the person already out (a copy; the run's own draft is not touched).
  //
  // How to call:
  //   const replan = await optOutPrompt(without, ctx, userId) // { reason: 'Faith opted out. The meeting area would stay at Bugis.', trigger, at }
  async function optOutPrompt(without, ctx, userId) {
    const { meeting, moved } = await voting.repriceMeeting(without, ctx)
    const nextName = meeting ? areaName(meeting.area_id) : null
    const name = await nameFor(userId)
    const outcome = moved && nextName ? ` The fairest meeting area is now ${nextName}.` : nextName ? ` The meeting area would stay at ${nextName}.` : ''
    return { reason: `${describeChange('optout', name)}${outcome}`, trigger: { kind: 'optout' }, at: now() }
  }

  // The job of a guest opting out of a confirmed plan: the member goes out (their votes with them), the places they put forward are dismissed
  // (nobody is left to speak for them), and the one thing written to the session is the "Re-plan?" question. The stops are not touched.
  //
  // How to call:
  //   return optOutOfPlan(draft, userId, replan) // inside optOut, after the last await
  function optOutOfPlan(draft, userId, replan) {
    const dismissed = draft.proposals.filter((p) => lower(p.proposed_by) === userId)
    draft.proposals = draft.proposals.filter((p) => lower(p.proposed_by) !== userId)
    draft.session.replan = replan
    return {
      ops: [
        { op: 'opt_out', user_id: userId },
        ...dismissed.map((p) => ({ op: 'resolve_proposal', proposal_id: p.id, status: 'dismissed', by: userId })),
      ],
      needs: 'none',
      session: { replan },
      answer: ({ version }) => ({ planVersion: version, state: 'opted_out' }),
    }
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

  // Records that the host named the place themselves (`sessions.meet_by = 'known'`), for the guests' line on the Locate step. Done by the
  // server after the known place was written, with the service key (the database lets the server write the column at any time), and only
  // when it is not 'known' already. It is a second write, not part of apply_session_plan (that function is not changed for it), so it can
  // fail on its own: it then says so in the log, at most once a minute, and the known place stands. The session is voting by then, where the
  // record only matters for the host's own history. A project without the column (its migration not applied) answers an error here and
  // nothing else is affected.
  //
  // How to call:
  //   await recordKnownChoice('3b1f...')
  let lastChoiceWarning = 0
  async function recordKnownChoice(id) {
    try {
      const read = await within(service.from('sessions').select('meet_by').eq('id', id).maybeSingle(), dbDeadlineMs, 'reading how the host chose')
      if (read.error) throw read.error
      if (!read.data || read.data.meet_by === 'known') return
      const wrote = await within(service.from('sessions').update({ meet_by: 'known' }).eq('id', id), dbDeadlineMs, 'recording how the host chose')
      if (wrote.error) throw wrote.error
    } catch (err) {
      const at = Date.now()
      if (at - lastChoiceWarning > 60_000) {
        lastChoiceWarning = at
        console.warn(`The host's choice was not recorded (${typeof err?.code === 'string' ? err.code : (err?.name ?? 'Error')}). Has db/migrations/20261026000000_jio_session_meet_by.sql been applied?`)
      }
    }
  }

  // PUT /api/sessions/:id/known-place: the host sets the meeting area straight away because the group has already decided (E21),
  // from inviting or locating to voting. The list becomes that one area, suggestions and approvals are cleared, and the area is
  // pinned (`chosen`): a later change of start moves the travel times, never the area. One planner run prices the area for the
  // members who have shared a start; with none, the times are zero. The session needs two people, as it does to start. As with
  // confirming a spot, the slots and their places are made in the same write. Setting the same place again is a no-op.
  //
  // `notice` is an optional banner for the group ({ text, released: true, votesCleared: true }), which the host's change of the meeting place
  // brings so that the group is told in the same write that the place moved; without it the banner is cleared, as for any known place.
  //
  // How to call:
  //   await sessions.setKnownPlace({ client: req.supabase, id, userId: req.user.id, areaId: 'bugis' }) // { planVersion, status: 'voting' }
  function setKnownPlace({ client, id, userId, areaId, notice = null }) {
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
              ...allowance.routing(),
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
            session: { status: 'voting', banner: notice, meeting },
            plan: { rank: 'all' },
            afterApply: () => recordKnownChoice(lower(id)),
            answer: ({ version }) => ({ planVersion: version, status: 'voting' }),
          }
        },
      },
    )
  }

  // POST /api/sessions/:id/change-meeting-place: the host lets the meeting area go (from voting or confirmed) and picks it again, the way a
  // session starts: `meetBy: 'fairest'` works the spots out again from the starts people already shared, and `meetBy: 'known'` names the area
  // (`areaId`) and goes straight to voting there. The release is ONE write (the op `release_meeting`): the session goes back to locating, the
  // meeting area, the slots with their places and votes, the stops, the order note and suggestion, the plan's start, the prompt, the kept rain
  // warnings, the spots with their approvals and suggestions, and the members' minutes to the old area all go, pending proposals are dismissed,
  // `meet_by` is set to the new choice, and the group gets a banner that names the host. Starts, ends, exact places and picks stay. It is the
  // only way a chosen area is released; every other path still answers `area_pinned`.
  // 'fairest' works the spots out in the same write, so the group never sees an empty list. 'known' is then a second write, the known place
  // (setKnownPlace) with the banner brought along; if that one fails the session stays on Locate with the host's choice recorded, and the host
  // names the area there ("We already have a place"). Nothing is held in memory between the two.
  //
  // THE GAP between the two writes of 'known' (and what is done about it): between the release and the known place the session is `locating` for
  // a moment, so a guest's page may see that state (the shared follower in lib/followRelease.js waits briefly and looks again, and goes back to
  // Vote when the session is voting at the new area), and the group has no spot list in that moment ('fairest' has none missing: its spots are in
  // the release's own write). If the second write fails the host is told on Locate, where they name the area themselves.
  //
  // A retry must not wipe what happened since: the browser sends the `planVersion` it saw, and a stale one is 409 `stale_plan` with nothing
  // written. Without one, a repeat of 'known' that names the area the session is already voting at, chosen by the host's own 'known', with no vote
  // cast yet, is a no-op that answers 200 (nothing to clear, and nothing written).
  //
  // Refused: not the host (403 host_only), a session that is not voting or confirmed (409 wrong_status), a stale `planVersion` (409 stale_plan), an
  // unknown area (422).
  //
  // How to call:
  //   await sessions.changeMeetingPlace({ client: req.supabase, id, userId: req.user.id, meetBy: 'known', areaId: 'bugis', planVersion: 12 })
  //   // { planVersion, status: 'voting', meetBy: 'known' }
  async function changeMeetingPlace({ client, id, userId, meetBy, areaId, planVersion }) {
    userId = lower(userId)
    if (meetBy === 'known') requireArea(areaId)
    const check = (state) => {
      requireJoined(state, userId)
      requireHost(state, userId, 'change the meeting place')
      requireStatus(state, ['voting', 'confirmed'], { what: 'change the meeting place' })
      if (planVersion !== undefined && Number(state.session.plan_version) !== planVersion) {
        throw refuse(409, 'stale_plan', 'The session changed since you looked at it. Look at it again.')
      }
    }
    let repeat = false
    // The notice of the known place, which replaces the one the release leaves (it names the new area), worked out inside the job.
    let notice = null
    const released = await submit(
      { client, id, userId },
      {
        exclusive: true,
        check,
        prepare: async (draft) => {
          check(draft)
          const s = draft.session
          if (meetBy === 'known' && s.status === 'voting' && s.meet_by === 'known' && s.meeting_method === 'chosen' && s.meeting_area_id === areaId && draft.votes.length === 0) {
            repeat = true
            return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, status: 'voting', meetBy: 'known' }) }
          }
          repeat = false
          const hostName = await nameFor(userId)
          const facts = { hostName, status: draft.session.status, hadVotes: draft.votes.length > 0 }
          const text = releasedBannerText(facts)
          if (meetBy === 'known') notice = { text: releasedBannerText({ ...facts, placeName: areaName(areaId) }), released: true, votesCleared: true }
          // The draft as the function leaves the session, so the spots are worked out from the starts that stay.
          Object.assign(draft.session, {
            status: 'locating', meet_by: meetBy, banner: { text, released: true },
            meeting_area_id: null, meeting_method: null, meeting_max_minutes: null, meeting_total_minutes: null, meeting_count: null, meeting_approximate: null,
            order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null, replan: null, weather_kept: null,
          })
          Object.assign(draft, { slots: [], options: [], votes: [], stops: [], proposals: [], spots: [], suggestions: [], approvals: [] })
          return {
            ops: [{ op: 'release_meeting', meet_by: meetBy }],
            needs: meetBy === 'fairest' ? 'recompute' : 'none',
            session: { status: 'locating', banner: { text, released: true } },
            answer: ({ version }) => ({ planVersion: version, status: 'locating', meetBy }),
          }
        },
      },
    )
    if (meetBy === 'fairest' || repeat) return released
    return { ...(await setKnownPlace({ client, id, userId, areaId, notice })), meetBy }
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
  // are no longer exactly in the order that was suggested). `clearKept` is a stop id whose kept rain warning goes with the change. The draft takes the new stops too, so another job in the same run edits the plan
  // as this one left it, and the run writes both (the last list of stops is the one written).
  //
  // How to call:
  //   return stopsJob(draft, result, { stopOptions }, answer)
  function stopsJob(draft, { rows, planStart }, { clearKept = null, ...extra }, answer) {
    draft.stops = rows.map((r) => ({ ...r }))
    Object.assign(draft.session, { plan_start_minute: planStart, order_reason: null, order_source: null })
    // A rain warning the host kept for a stop goes when the stop's place changes or the stop is deleted (it was about that place).
    const kept = draft.session.weather_kept
    const keptNow = clearKept && kept && clearKept in kept ? Object.fromEntries(Object.entries(kept).filter(([key]) => key !== clearKept)) : undefined
    if (keptNow !== undefined) draft.session.weather_kept = Object.keys(keptNow).length > 0 ? keptNow : null
    return {
      ops: [],
      needs: 'none',
      session: { order_note: null, plan_start_minute: planStart, ...(keptNow !== undefined && { weather_kept: draft.session.weather_kept }) },
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
  // The answer also says what a confirm would store, so the Confirm dialog shows exactly that: `voted` is the stops of the voted order and
  // `stops` those of the suggested one, each with the start that is stored for it (laid out with the travel between the stops, the same
  // rows a confirm writes), and the `basis` is what a confirm of either order must send back. An answer of `none` still has `voted`.
  //
  // How to call:
  //   await sessions.suggestOrder({ client: req.supabase, id, userId: req.user.id })
  //   // { status: 'ok', basis, order: [slotId], stops: [{ slotId, venueId, start }], voted: [{ slotId, category, venueId, start, duration }], reason, source: 'ai' | 'rules' }
  //   // or { status: 'none', why: 'one_movable' | 'no_order_fits' | 'no_stops' | 'unknown_place', basis, voted }
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
      if (stops.length === 0) return { status: 'none', why: 'no_stops', voted: [] }
      const basis = basisOf(draft.session, stops)
      const venueOf = layoutVenue(draft)
      // What a confirm of the voted order would store, and (below) of the suggested one: their stops with the laid-out starts.
      const voted = shownStops(stops, venueOf)
      const answerOf = (stored) => ({
        status: 'ok',
        basis,
        order: stored.order,
        stops: shownStops(stops, venueOf, stored).map(({ slotId, venueId, start }) => ({ slotId, venueId, start })),
        voted,
        reason: stored.reason,
        source: stored.source,
      })
      // The same stops as the stored suggestion: nothing to work out, nothing to write, no AI call.
      const stored = state.session.order_suggestion
      if (stored?.basis === basis && suggestionFits(stops, stored)) return answerOf(stored)
      if (stops.some((s) => !voting.venues.has(s.venueId))) return { status: 'none', why: 'unknown_place', basis, voted }
      if (stops.filter((s) => s.category !== 'eat').length < 2) return { status: 'none', why: 'one_movable', basis, voted }
      const { candidates } = arrangeCandidates(arrangeInput(stops, (venueId) => voting.venues.get(venueId), draft.session))
      const { options } = freshCandidates(candidates, [], { includeCurrent: true })
      if (options.length === 0) return { status: 'none', why: 'no_order_fits', basis, voted }
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
          const current = basisOf(draft.session, stops)
          // A basis the host was shown (for the suggested order, and for the voted one too) is the stops the votes made when they looked: if the
          // votes have moved a winner since, nothing is written and they look again.
          if (basis !== undefined && basis !== current) throw refuse(409, 'order_stale', 'The votes changed since you looked. Look at them again.')
          if (order === 'suggested') {
            const stored = draft.session.order_suggestion
            if (!basis || stored?.basis !== current || !suggestionFits(stops, stored)) {
              throw refuse(409, 'order_stale', 'The votes changed since this order was suggested. Look at the order again.')
            }
            suggestion = stored
          }
          const { rows, planStart } = confirmedRows(stops, layoutVenue(draft), suggestion)
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
          const result = withoutStop(draft.stops, stopId, draft.session, layoutVenue(draft), votedStartsOf(draft))
          return stopsJob(draft, result, { clearKept: stopId }, ({ version }) => ({ planVersion: version }))
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
          const result = withMode(draft.stops, stopId, mode, draft.session, layoutVenue(draft))
          if (!result) throw refuse(409, 'no_leg', 'The first stop has no leg before it.')
          draft.stops = result.rows.map((r) => ({ ...r }))
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
          const result = reorderedRows(draft.stops, stopIds, draft.session, layoutVenue(draft))
          if (!result) throw refuse(409, 'stops_changed', 'The plan has changed. Look at it again.')
          // The same order: the modes and earliest starts stay as they are.
          if (stopIds.every((stopId, i) => draft.stops[i].id === stopId)) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version }) }
          return stopsJob(draft, result, {}, ({ version }) => ({ planVersion: version }))
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
          const startedAt = timedRows(draft.stops, layoutVenue(draft), startOf(draft.session, draft.stops)).timed[index].start
          const slot = { category: kind, start_minute: Math.min(1439, startedAt), duration_minutes: row.duration_minutes }
          requireMeetingArea(draft)
          const ranking = await voting.rankSlot(draft, slot, [venueId], ctx, { last: index === draft.stops.length - 1 })
          if (!ranking.current.has(venueId)) throw refuse(422, 'venue_does_not_fit', `${venue.name} does not fit this stop.`)
          const result = withPlace(draft.stops, stopId, { venueId, category: kind, startedAt: Math.min(1439, startedAt) }, draft.session, layoutVenue(draft))
          // The new place is kept as an option of the stop's slot only when it is of the slot's own kind; for another kind the old place just
          // leaves the slot's options (a place of one kind is not a choice for another kind's slot).
          const slotKind = row.slot_id ? draft.slots.find((sl) => sl.id === row.slot_id)?.category : null
          const kept = row.slot_id && kind === slotKind ? optionRow(kind, ranking.rows.get(venueId)) : null
          const stopOptions = !row.slot_id
            ? []
            : kept
              ? [{ slot_id: row.slot_id, venue_id: venueId, rank: kept.rank, score: kept.score, source: 'planner', added_by: null, details: kept.details, replaces: row.venue_id }]
              : [{ slot_id: row.slot_id, venue_id: null, replaces: row.venue_id }]
          return stopsJob(draft, result, { clearKept: row.id, ...(stopOptions.length > 0 && { stopOptions }) }, ({ version }) => ({ planVersion: version, changed: true }))
        },
      },
    )
  }

  // ── Reads that rank places for a confirmed plan (the rain swap, Replace's list, Roam). They write nothing and keep nothing: each answer is
  // worked out from the stored rows and the planner's own pool, and a choice a person acts on goes through the write routes (the stop's place,
  // a proposal), which put it in `stops` and `stop_proposals`. They spend the request's own allowance of OneMap trips (60), never ask Google, and
  // name no need of the group: a need only decides which places are left, and the answers carry places, never the reasons that name a need.

  // The caller must be a joined member of a confirmed plan.
  //
  // How to call:
  //   const check = confirmedMemberCheck(userId, 'look for places')
  const confirmedMemberCheck = (userId, what) => (state) => {
    requireJoined(state, userId)
    requireStatus(state, ['confirmed'], { what })
  }

  // The session as a read needs it: admitted as the caller (404 for a stranger, before the service key is used), checked, loaded afresh with
  // the service key, checked again on the fresh copy, with the context a ranking reads from (needs, the group's past, the OneMap allowance).
  //
  // How to call:
  //   const { draft, ctx } = await readDraft({ client, id, userId, check })
  async function readDraft({ client, id, userId, check }) {
    id = lower(id)
    check(await admit(client, id, userId))
    const state = await within(loadState(service, id), dbDeadlineMs, 'reading the session')
    if (!state.session) throw refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.')
    const draft = draftOf(state)
    check(draft)
    const allowance = newAllowance(routingDeadlineMs)
    return { draft, ctx: contextFor({ sessionId: id, state, allowance }) }
  }

  // The slot a stop is ranked as: its own length, at the time the itinerary starts it now, as the plan's last stop if it is the last. It is the
  // same slot changeStopPlace checks a place against, so a place listed here is not turned away there for its time.
  //
  // How to call:
  //   const { slot, last } = stopSlotOf(draft, row, 'drink') // { slot: { category, start_minute, duration_minutes }, last: false }
  function stopSlotOf(draft, row, category) {
    const index = draft.stops.indexOf(row)
    const startedAt = timedRows(draft.stops, layoutVenue(draft), startOf(draft.session, draft.stops)).timed[index].start
    return { slot: { category, start_minute: Math.min(1439, startedAt), duration_minutes: row.duration_minutes }, last: index === draft.stops.length - 1 }
  }

  // GET /api/sessions/:id/stops/:stopId/swap: the indoor place the planner would put in a stop in the rain, or none. The planner is asked about the
  // stop's own place at its time on its day (with the other stops left out, so the place is never one the plan already has); the `swap` it gives
  // for a place with a rain warning is the answer. Any joined member may ask, while the plan is confirmed; putting the place in is the host's
  // (PUT .../place). Nothing is written.
  //
  // How to call:
  //   await sessions.stopSwap({ client: req.supabase, id, userId: req.user.id, stopId }) // { swap: { venueId, name } | null }
  async function stopSwap({ client, id, userId, stopId }) {
    userId = lower(userId)
    const { draft, ctx } = await readDraft({ client, id, userId, check: confirmedMemberCheck(userId, 'look for a rain swap') })
    const row = stopOf(draft, stopId)
    if (!voting.venues.has(row.venue_id)) return { swap: null }
    requireMeetingArea(draft)
    const { slot, last } = stopSlotOf(draft, row, row.category)
    const others = draft.stops.filter((s) => s !== row).map((s) => s.venue_id)
    const ranking = await voting.rankSlot(draft, slot, [row.venue_id], ctx, { last, exclude: others })
    const swap = ranking.rows.get(row.venue_id)?.swap
    return { swap: swap ? { venueId: swap.venueId, name: swap.name } : null }
  }

  // GET /api/sessions/:id/stops/:stopId/choices?category=: the places that could take a stop's place, for Replace. Only the host, while the plan
  // is confirmed. The places are of `category` (the stop's own when left out), ranked for the stop's time on its day; the places the group voted
  // for in that kind are always among them while they fit, with how many votes each had (a number, never who). A place any stop already has is not
  // offered. Each is { venueId, rank, score, votes, details } with the same details a voting option keeps. Nothing is written.
  //
  // How to call:
  //   await sessions.stopChoices({ client: req.supabase, id, userId: req.user.id, stopId, category: 'activity' }) // { category, options: [...] }
  async function stopChoices({ client, id, userId, stopId, category }) {
    userId = lower(userId)
    const { draft, ctx } = await readDraft({ client, id, userId, check: confirmedPlanCheck(userId, 'replace a stop') })
    const row = stopOf(draft, stopId)
    const kind = category ?? row.category
    requireMeetingArea(draft)
    const { slot, last } = stopSlotOf(draft, row, kind)
    const inPlan = new Set(draft.stops.map((s) => s.venue_id))
    const voted = optionsOf(draft, kind).map((o) => o.venue_id).filter((venueId) => !inPlan.has(venueId))
    const ranking = await voting.rankSlot(draft, slot, voted, ctx, { last, exclude: [...inPlan] })
    const joined = new Set(draft.members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id)))
    const votes = new Map()
    for (const v of draft.votes) if (v.category === kind && joined.has(lower(v.user_id))) votes.set(v.venue_id, (votes.get(v.venue_id) ?? 0) + 1)
    const options = ranking.rankedIds.map((venueId) => {
      const kept = optionRow(kind, ranking.rows.get(venueId))
      return { venueId, rank: kept.rank, score: kept.score, votes: votes.get(venueId) ?? 0, details: kept.details }
    })
    return { category: kind, options }
  }

  // POST /api/sessions/:id/roam: "What next?" (E16), the places near where the group is, for a joined member while the plan is confirmed. The point
  // is `current` (for this request only: it is not stored, logged or answered) or else the meeting area's centre. The list is ranked for the time
  // the next stop would start, today in Singapore: when the last stop ends, or now if that has passed, for an hour. The group's needs and the
  // weather count; each place says whether it is already a stop and who put it forward (roamReply). Saved places only. Nothing is written.
  //
  // How to call:
  //   await sessions.roamNearby({ client: req.supabase, id, userId: req.user.id, current: { lat: 1.35, lng: 103.85 }, categories: ['eat'] })
  //   // { status: 'ok', results: [{ venueId, name, venue, travelMinutes, distanceKm, isStop, proposedBy, ... }], notice, weather }
  async function roamNearby({ client, id, userId, current, categories }) {
    userId = lower(userId)
    const { draft, ctx } = await readDraft({ client, id, userId, check: confirmedMemberCheck(userId, 'look for places') })
    if (!onTheDay(draft.session)) throw refuse(409, 'wrong_day', 'Places near the group can be looked up on the day of the outing.')
    requireMeetingArea(draft)
    const area = areasById.get(draft.session.meeting_area_id)
    const here = current ? { lat: current.lat, lng: current.lng } : { lat: area.lat, lng: area.lng }
    const nowMinutes = singaporeMinutes()
    const endedAt = draft.stops.length ? (timedRows(draft.stops, layoutVenue(draft), startOf(draft.session, draft.stops)).timed.at(-1)?.end ?? 0) : 0
    const dateTime = `${singaporeDay()}T${fromMinutes(Math.min(1439, Math.max(endedAt, nowMinutes)))}`
    const { result, weather } = await voting.roamAround(draft, { current: here, categories, dateTime, minutes: ROAM_MINUTES }, ctx)
    return roamReply(result, {
      weather,
      stopVenueIds: new Set(draft.stops.map((s) => s.venue_id)),
      proposedBy: new Map(draft.proposals.map((p) => [p.venue_id, lower(p.proposed_by)])),
    })
  }

  // When the group sets off for home: the session's day at the minute the last stop ends, or undefined (the planner's default, now) once the day
  // has passed.
  //
  // How to call:
  //   homeDateTime(draft) // '2026-10-25T19:30'
  function homeDateTime(draft) {
    const date = String(draft.session.date).slice(0, 10)
    if (date < singaporeDay() || draft.stops.length === 0) return undefined
    const endedAt = timedRows(draft.stops, layoutVenue(draft), startOf(draft.session, draft.stops)).timed.at(-1)?.end ?? 0
    return `${date}T${fromMinutes(Math.min(1439, endedAt))}`
  }

  // PUT /api/sessions/:id/stops/:stopId/kept-rain: the host keeps a stop as it is in the rain (the Keep button). `state` is the forecast's state
  // when they pressed it. It is stored on the session (`sessions.weather_kept`, { <stop id>: state }, so every device of every member sees the
  // warning put away); the warning comes back when the forecast changes state, which the screen works out by comparing. The stop's place
  // changing, the stop going, the plan being opened again or finished clears it. The same state again changes nothing.
  //
  // How to call:
  //   await sessions.keepRain({ client: req.supabase, id, userId: req.user.id, stopId, state: 'showers' }) // { planVersion, kept: true }
  function keepRain({ client, id, userId, stopId, state }) {
    userId = lower(userId)
    const check = confirmedPlanCheck(userId, 'keep a stop in the rain')
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          stopOf(draft, stopId)
          const before = draft.session.weather_kept ?? {}
          if (before[stopId] === state) return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, kept: true }) }
          const kept = { ...before, [stopId]: state }
          draft.session.weather_kept = kept
          return { ops: [], needs: 'none', session: { weather_kept: kept }, answer: ({ version }) => ({ planVersion: version, kept: true }) }
        },
      },
    )
  }

  // The minutes each person needs to get home: from the last stop to the centre of the area they end the day in (the area they start in when
  // they named no other), leaving when the last stop ends on the outing's day. They are routed by OneMap through the shared runs, inside the
  // request's allowance, with the planner's estimate where a trip cannot be routed. The people are the ones the ledger has a row for
  // (ledgerPeople), and the trips are routed together or estimated together, so this is one computation: finishing the outing writes these
  // minutes as `minutes_home`, and the itinerary of a confirmed plan shows these same minutes (GET .../trips-home). `approximate` is true when
  // any of them is an estimate.
  //
  // How to call:
  //   const { people, minutes, approximate } = await homeMinutes(draft, allowance) // minutes: { <user id>: 31 }
  async function homeMinutes(draft, allowance) {
    const people = ledgerPeople(draft.members)
    const last = draft.stops.at(-1)
    const lastVenue = last ? voting.venues.get(last.venue_id) : null
    const ends = people.map((m) => ({ id: lower(m.user_id), area: areasById.get(m.end_area_id) ?? areasById.get(m.start_area_id) })).filter((p) => p.area)
    if (!lastVenue || ends.length === 0) return { people, minutes: {}, approximate: false }
    const input = {
      from: { id: lastVenue.id, lat: lastVenue.lat, lng: lastVenue.lng },
      people: ends.map((p) => ({ id: p.id, end: { lat: p.area.lat, lng: p.area.lng } })),
      // The way home leaves when the last stop ends, on the outing's day (the planner's default, now, once that day has passed).
      dateTime: homeDateTime(draft),
    }
    const { result, travel } = await runs.runWithTravel(input, data, homeTripsRun, () => ({
      ...allowance.routing(),
    }))
    spend(allowance, travel)
    return { people, minutes: result.minutes, approximate: travel.source === 'estimate' || travel.estimated > 0 || travel.failed > 0 }
  }

  // GET /api/sessions/:id/trips-home: the minutes each person needs to get home from the last stop, for the itinerary of a confirmed plan. A
  // joined member asks, while the plan is confirmed. It is the computation the ledger of the finished outing uses (homeMinutes), not a second
  // estimate, so the two cannot disagree except by what the routes themselves say at another hour. Each trip is { userId, minutes }: an area
  // is all the server knows of where a person ends the day, and a member already sees the areas people end in. Nothing is written.
  //
  // How to call:
  //   await sessions.tripsHome({ client: req.supabase, id, userId: req.user.id }) // { trips: [{ userId, minutes }], approximate }
  async function tripsHome({ client, id, userId }) {
    userId = lower(userId)
    const { draft } = await readDraft({ client, id, userId, check: confirmedMemberCheck(userId, 'see the trips home') })
    const allowance = newAllowance(routingDeadlineMs)
    const { minutes, approximate } = await homeMinutes(draft, allowance)
    return { trips: Object.entries(minutes).map(([user, m]) => ({ userId: user, minutes: Math.max(0, Math.round(m)) })), approximate }
  }

  // POST /api/sessions/:id/complete: the host finishes the outing (E14), confirmed to completed. The server works the travel ledger out from
  // stored rows, never from the browser: for each joined person who has minutes in (stored when the meeting spot was confirmed), the minutes in,
  // the minutes between stops (the stored leg minutes), and the minutes home, routed from the last stop to the centre of the area they end the
  // day in (OneMap through the shared runs, inside the request's allowance, with the estimate where it cannot route). The deltas from the
  // mean sum to exactly zero. The ledger and the status are written together; a retry after success is a no-op, and it is refused unless
  // the plan is confirmed and the outing's day has come (409 before_the_day).
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
          // The outing cannot be finished before its day (409 before_the_day): until then it has not happened.
          if (String(draft.session.date).slice(0, 10) > singaporeDay()) throw refuse(409, 'before_the_day', 'The outing can be finished from its day.')
          const between = minutesBetween(draft.stops)
          const { people, minutes: home } = await homeMinutes(draft, allowance)
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
          // The limits the function checks under its lock, checked here first on the run's copy (which holds the proposals of the jobs before this
          // one in the same batch), so a refused proposal refuses itself and not the others written with it.
          if (draft.stops.length >= MAX_STOPS) throw refuse(409, 'plan_full', `A plan holds up to ${MAX_STOPS} stops.`)
          if (draft.proposals.length >= PROPOSALS_PER_SESSION || draft.proposals.filter((p) => lower(p.proposed_by) === userId).length >= PROPOSALS_PER_MEMBER) {
            throw refuse(409, 'too_many_proposals', 'Too many places are waiting for an answer.')
          }
          const proposalId = randomUUID()
          draft.proposals.push({ id: proposalId, venue_id: venueId, proposed_by: userId, status: 'pending' })
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
          // The draft changes only after the last refusal, so a job refused here leaves the run's copy as the jobs after it expect it.
          const answered = () => {
            draft.proposals = draft.proposals.filter((p) => p !== proposal)
          }
          if (!accept) {
            answered()
            return { ops, needs: 'none', answer }
          }
          const venue = voting.venues.get(proposal.venue_id)
          if (!venue) throw refuse(404, 'venue_not_found', 'That place is not one Jio knows.')
          if (draft.stops.some((s) => s.venue_id === proposal.venue_id)) {
            answered()
            return { ops, needs: 'none', answer }
          }
          if (draft.stops.length >= MAX_STOPS) throw refuse(409, 'plan_full', `A plan holds up to ${MAX_STOPS} stops.`)
          answered()
          const timed = draft.stops.length ? timedRows(draft.stops, layoutVenue(draft), startOf(draft.session, draft.stops)).timed : []
          const endedAt = timed.at(-1)?.end ?? null
          // Not before now, but only on the day of the outing: on any other day the clock says nothing about the plan's times.
          const notBefore = Math.max(endedAt ?? 0, onTheDay(draft.session) ? singaporeMinutes() : 0)
          const result = withAddedStop(draft.stops, { venueId: proposal.venue_id, category: venue.category, notBefore, duration: ROAM_MINUTES, endedAt }, draft.session, layoutVenue(draft))
          return { ...stopsJob(draft, result, {}, answer), ops }
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
    changeMeetingPlace,
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
    stopSwap,
    stopChoices,
    roamNearby,
    keepRain,
    completeOuting,
    tripsHome,
    proposeStop,
    resolveProposal,
    queue,
  }
}
