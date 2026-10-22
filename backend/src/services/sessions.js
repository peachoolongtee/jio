import {
  applyPlan,
  loadAdmission,
  loadNames,
  loadNeeds,
  loadState,
  PlanRefused,
} from '../db/sessions.js'
import { moreOptions, OPTIONS_MAX, OPTIONS_MORE } from '../planner/slot-plan.js'
import { MAX } from '../routes/plan-schemas.js'
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

// The session endpoints that decide where a group meets and what it votes on, on the server: the meeting spots, a member's suggestion,
// the host's confirm and known place (which also makes the voting slots and their options), the radius, adding, swapping and removing
// places, removing and restoring a slot, opting out and rejoining, and leaving or being removed. Votes are not here: a browser writes
// its own vote directly, under the database's rules. routes/sessions.js is the HTTP side of this; this file is the rules.
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
// its meeting area and all its slots spend together.
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
//
// How to call:
//   const sessions = createSessions({ supabase, data, runs })
export function createSessions({ supabase, data, runs, routingDeadlineMs = ROUTING_DEADLINE_MS, dbDeadlineMs = DB_DEADLINE_MS }) {
  const service = supabase.service
  const areasById = new Map((data.areas ?? []).map((a) => [a.id, a]))
  const areaName = (id) => areasById.get(id)?.name ?? id
  const voting = createVoting({ data, areasById, runs })

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
  //   const { rows, skipped, travel } = await computeSpots(draft, allowance)
  async function computeSpots(draft, allowance) {
    const { located, skipped } = locatedMembers(draft.members, areasById)
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
      const ctx = { allowance, state, needs: () => (needsRead ??= within(loadNeeds(service, sessionId), dbDeadlineMs, "reading the members' needs")) }
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
        ;({ rows, skipped } = await computeSpots(draft, allowance))
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

      const nothingToWrite = patch.ops.length === 0 && patch.spots === undefined && !patch.session && patch.slots === undefined
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
          const error =
            err.hint === 'area_pinned' ? refuse(409, 'area_pinned', 'The meeting area was chosen, so this cannot move it.')
            : err.hint === 'needs_two_people' ? refuse(409, 'needs_two_people', 'A session needs at least two people.')
            : err.hint === 'slot_missing' ? refuse(404, 'slot_not_found', 'That slot is not in this session.')
            : refuse(409, 'wrong_status', 'This cannot be done while the session is in this state.')
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
    return queue.enqueue(id, job)
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
    queue,
  }
}
