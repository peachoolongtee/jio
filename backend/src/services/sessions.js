import {
  applyPlan,
  countSlots,
  loadAdmission,
  loadNames,
  loadState,
  PlanRefused,
} from '../db/sessions.js'
import { MAX } from '../routes/plan-schemas.js'
import { nowInSingapore } from './planner-runs.js'
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
import { MAX_ROUTED_TRIPS_PER_REQUEST, ROUTING_DEADLINE_MS } from './travel-times.js'

// The session endpoints that decide where a group meets, on the server: the meeting spots, a member's suggestion, the host's
// confirm and known place, opting out and rejoining, and leaving or being removed. routes/sessions.js is the HTTP side of this;
// this file is the rules.
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
//
// Travel times come from the centres of areas, never from an exact place, and only saved venues exist here: no Google. No answer
// carries a label or a coordinate, and session_member_places is never read.
//
// Every refusal is a SessionError, which the router answers as { error, message } with the status given.
//
// How to build it (app.js does this):
//   const sessions = createSessions({ supabase, data, runs })
//   const answer = await sessions.confirmSpot({ client: req.supabase, id, userId: req.user.id, areaId: 'bugis' })

// How many times a run loads the session and does its jobs again when the session moved on while it worked out the spots.
const MAX_TRIES = 3

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

// The status check every endpoint makes. `allowed` are the statuses it works in. Of the others: a finished session is `closed`
// (an error code, default wrong_status), a status listed in `notYet` is work a later stage does (409 not_yet), and anything
// else is 409 wrong_status.
//
// How to call:
//   requireStatus(state, ['inviting', 'locating'], { notYet: ['voting'] })
function requireStatus(state, allowed, { notYet = [], closed = 'wrong_status', started = null, what = 'do that' } = {}) {
  const status = state.session.status
  if (allowed.includes(status)) return
  if (['completed', 'cancelled'].includes(status)) {
    throw refuse(409, closed, `This session has ended, so nobody can ${what}.`)
  }
  if (started && ['voting', 'confirmed'].includes(status)) {
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

// When a session's trips set off, for public transport times: its own date and start while that is today or later in Singapore,
// otherwise now (the planner's default).
//
// How to call:
//   dateTimeOf({ date: '2026-10-25', start_time: '10:00:00' }) // '2026-10-25T10:00'
function dateTimeOf(session) {
  const date = String(session.date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < nowInSingapore().slice(0, 10)) return undefined
  const time = /^\d{2}:\d{2}/.exec(String(session.start_time ?? ''))?.[0] ?? '12:00'
  return `${date}T${time}`
}

// A copy of a run's inputs that a job may change freely.
//
// How to call:
//   const draft = draftOf(state)
const draftOf = (state) => ({
  session: { ...state.session },
  members: state.members.map((m) => ({ ...m })),
  spots: state.spots.map((s) => ({ ...s })),
  suggestions: state.suggestions.map((s) => ({ ...s })),
  approvals: state.approvals.map((a) => ({ ...a })),
})

// Builds the session service.
//
// Options:
//   supabase - From createSupabase(): `service` is the only client used here, after admission.
//   data     - Venues and areas the planner reads, from loadPlanData(). Only the areas are used.
//   runs     - The shared planner runs, from createPlannerRuns() (services/planner-runs.js). Every OneMap call goes through them.
//   queue    - Tests may pass their own lane (createSessionQueue); normally built here.
//
// How to call:
//   const sessions = createSessions({ supabase, data, runs })
export function createSessions({ supabase, data, runs, routingDeadlineMs = ROUTING_DEADLINE_MS }) {
  const service = supabase.service
  const areasById = new Map((data.areas ?? []).map((a) => [a.id, a]))
  const areaName = (id) => areasById.get(id)?.name ?? id

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

  // Takes what a run used from the request's allowance of OneMap trips. A trip that failed was still a call.
  //
  // How to call:
  //   spend(allowance, travel)
  function spend(allowance, travel) {
    allowance.trips = Math.max(0, allowance.trips - (travel.routed ?? 0) - (travel.failed ?? 0))
  }

  // ── Running a batch ────────────────────────────────────────────────────

  // Runs one batch of jobs for a session: load, do every job to a copy, work out the spots once if any job needs them, and write
  // it all through apply_session_plan. Settles every job. Called by the queue.
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
      const state = await loadState(service, sessionId)
      if (!state.session) {
        for (const job of batch.jobs) if (!dropped.has(job)) reject(job, refuse(404, 'session_not_found', 'This session does not exist, or you are not in it.'))
        return
      }
      const draft = draftOf(state)
      const spotsBefore = draft.spots
      const live = []
      for (const job of batch.jobs) {
        if (dropped.has(job)) continue
        try {
          live.push({ job, prepared: await job.prepare(draft, { allowance, state }) })
        } catch (err) {
          if (!(err instanceof SessionError)) throw err
          reject(job, err)
        }
      }
      if (live.length === 0) return

      // The spots: worked out again if any job needs the planner, kept as they are stored if the jobs only move suggestions about,
      // and the job's own list when the host sets a known place.
      const needs = live.some(({ prepared }) => prepared.needs === 'recompute') ? 'recompute' : live.some(({ prepared }) => prepared.needs === 'relist') ? 'relist' : 'none'
      let rows = live.find(({ prepared }) => prepared.spots)?.prepared.spots
      let skipped = []
      if (rows === undefined && needs === 'recompute') ({ rows, skipped } = await computeSpots(draft, allowance))
      else if (rows === undefined && needs === 'relist') rows = relistedRows(draft.spots, suggestedAreaIds(draft.suggestions, draft.members, areasById))

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

      const patch = { ops: live.flatMap(({ prepared }) => prepared.ops ?? []) }
      const sessionPatch = live.find(({ prepared }) => prepared.session)?.prepared.session
      if (sessionPatch) patch.session = sessionPatch
      let lost = []
      if (rows !== undefined) {
        patch.spots = rows
        lost = lostApprovalAreas(spotsBefore, rows, draft.approvals)
        if (lost.length > 0) {
          const reason = live.find(({ prepared }) => prepared.reason)?.prepared
          const names = await loadNames(service, [...new Set(live.flatMap(({ prepared }) => prepared.nameIds ?? []))])
          const nameOf = (id) => names.get(lower(id)) ?? 'Someone'
          patch.banner_text = lostApprovalsBannerText(reason?.reason(nameOf) ?? 'The list of spots changed.', lost, areaName)
        }
      }

      const nothingToWrite = patch.ops.length === 0 && patch.spots === undefined && !patch.session
      let version = Number(state.session.plan_version)
      if (!nothingToWrite) {
        // A run that only recomputed does not write when a newer run of the same kind is waiting: that one does the same work on newer inputs.
        if (needs === 'recompute' && patch.ops.length === 0 && !patch.session && handOver(live.map(({ job }) => job))) return
        try {
          const written = await applyPlan(service, sessionId, { version: state.session.plan_version, status: state.session.status }, patch)
          if (written === null) continue // the session moved on while the spots were worked out: load again
          version = written
        } catch (err) {
          if (!(err instanceof PlanRefused)) throw err
          const error =
            err.hint === 'area_pinned' ? refuse(409, 'area_pinned', 'The meeting area was chosen, so this cannot move it.')
            : err.hint === 'needs_two_people' ? refuse(409, 'needs_two_people', 'A session needs at least two people.')
            : refuse(409, 'wrong_status', 'This cannot be done while the session is in this state.')
          for (const { job } of live) reject(job, error)
          return
        }
      }
      for (const { job, prepared } of live) {
        try {
          job.settle.resolve(await prepared.answer({ version, rows: rows ?? draft.spots, lost, skipped, state }))
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
  //   verify   (rows) => throws a SessionError if the answer does not satisfy this job
  //   answer   ({ version, rows, lost, skipped }) => the JSON the endpoint answers with

  // Admits a request and queues its job. Resolves with the job's answer.
  //
  // How to call:
  //   return submit({ client, id, userId }, job)
  async function submit({ client, id, userId }, job) {
    const state = await admit(client, id, userId)
    job.check(state)
    return queue.enqueue(id, job)
  }

  // POST /api/sessions/:id/meeting-area: work the spots out again after a start or end changed (E1). Only the spots change.
  //
  // How to call:
  //   await sessions.recompute({ client: req.supabase, id, userId: req.user.id, trigger: 'start' })
  //   // { planVersion, meetingAreaId: null, moved: false, votesCleared: false, skipped: [userId], spots: 3, approvalsRemoved: [] }
  function recompute({ client, id, userId, trigger = 'start' }) {
    userId = lower(userId)
    const check = (state) => {
      requireJoined(state, userId)
      requireStatus(state, ['inviting', 'locating'], { notYet: ['voting'], what: 'work out the spots' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          return {
            ops: [],
            needs: 'recompute',
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
          draft.suggestions = [...draft.suggestions.filter((s) => lower(s.user_id) !== userId), { user_id: userId, area_id: areaId, here, created_at: new Date().toISOString() }]
          return {
            ops: [{ op: 'suggest', user_id: userId, area_id: areaId, here }],
            needs: listed ? 'relist' : 'recompute',
            nameIds: [userId],
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
          const had = draft.suggestions.some((s) => lower(s.user_id) === userId)
          draft.suggestions = draft.suggestions.filter((s) => lower(s.user_id) !== userId)
          return {
            ops: had ? [{ op: 'unsuggest', user_id: userId }] : [],
            needs: had ? 'relist' : 'none',
            nameIds: [userId],
            reason: (nameOf) => describeChange('withdrew', nameOf(userId)),
            answer: ({ version }) => ({ planVersion: version }),
          }
        },
      },
    )
  }

  // POST /api/sessions/:id/opt-out: the caller, a guest, steps out (E10). Their approvals and suggestion go, and the spots are
  // worked out without them. Already out is a no-op.
  //
  // How to call:
  //   await sessions.optOut({ client: req.supabase, id, userId: req.user.id }) // { planVersion, state: 'opted_out' }
  function optOut({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      const me = requireMember(state, userId)
      if (me.role === 'host' || lower(state.session.host_id) === userId) throw refuse(403, 'host_cannot_opt_out', 'The host cannot opt out. Cancel the session instead.')
      requireStatus(state, ['inviting', 'locating'], { notYet: ['voting', 'confirmed'], what: 'opt out' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const me = requireMember(draft, userId)
          if (me.state === 'opted_out') return { ops: [], needs: 'none', answer: ({ version }) => ({ planVersion: version, state: 'opted_out' }) }
          me.state = 'opted_out'
          draft.suggestions = draft.suggestions.filter((s) => lower(s.user_id) !== userId)
          draft.approvals = draft.approvals.filter((a) => lower(a.user_id) !== userId)
          return {
            ops: [{ op: 'opt_out', user_id: userId }],
            needs: 'recompute',
            nameIds: [userId],
            reason: (nameOf) => describeChange('optout', nameOf(userId)),
            answer: ({ version }) => ({ planVersion: version, state: 'opted_out' }),
          }
        },
      },
    )
  }

  // POST /api/sessions/:id/rejoin: the caller, who opted out, comes back (E11). The spots are worked out with them again. Already
  // joined still works the spots out, in case an earlier call was lost.
  //
  // How to call:
  //   await sessions.rejoin({ client: req.supabase, id, userId: req.user.id }) // { planVersion, state: 'joined' }
  function rejoin({ client, id, userId }) {
    userId = lower(userId)
    const check = (state) => {
      requireMember(state, userId)
      requireStatus(state, ['inviting', 'locating'], { notYet: ['voting', 'confirmed'], what: 'rejoin' })
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          const me = requireMember(draft, userId)
          const wasOut = me.state === 'opted_out'
          me.state = 'joined'
          return {
            ops: wasOut ? [{ op: 'rejoin', user_id: userId }] : [],
            needs: 'recompute',
            nameIds: [userId],
            reason: (nameOf) => describeChange('rejoin', nameOf(userId)),
            answer: ({ version }) => ({ planVersion: version, state: 'joined' }),
          }
        },
      },
    )
  }

  // DELETE /api/sessions/:id/members/:userId: a member leaves, or the host removes a guest (E25). The member's row goes, and with it
  // their exact place, approvals and suggestion; then the spots are worked out without them. Until the plan stage can take a
  // person's votes and options with them, a session that has moved on to voting or later refuses (409 session_started).
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
      requireStatus(state, ['inviting', 'locating'], { closed: 'session_closed', started: 'session_started', what: 'leave or be removed' })
      if (!state.members.some((m) => lower(m.user_id) === person)) throw refuse(404, 'member_not_found', 'That person is not in this session.')
    }
    return submit(
      { client, id, userId },
      {
        check,
        prepare: (draft) => {
          check(draft)
          draft.members = draft.members.filter((m) => lower(m.user_id) !== person)
          draft.suggestions = draft.suggestions.filter((s) => lower(s.user_id) !== person)
          draft.approvals = draft.approvals.filter((a) => lower(a.user_id) !== person)
          return {
            ops: [{ op: 'remove_member', user_id: person }],
            needs: 'recompute',
            nameIds: [person],
            reason: (nameOf) => describeChange(leaving ? 'left' : 'removed', nameOf(person)),
            answer: ({ version }) => (leaving ? { planVersion: version, left: true } : { planVersion: version, removed: true }),
          }
        },
      },
    )
  }

  // POST /api/sessions/:id/voting: the host confirms a spot (E2). Without an area it is the preselected spot: the most approved,
  // a tie going to the shorter longest trip. It becomes the meeting area, from the spot's stored figures with no planner run, and
  // the session moves to voting. The method is `voted` when anyone approved the spot, the planner's own (`same` or `fairest`) when
  // nobody did and it is the app's first spot, and `chosen` otherwise. Spots stay as the record.
  //
  // The slots and the places to vote on are the voting stage's (stage 4): this writes the meeting area and the status and leaves
  // the slots as they are, so `slotCount` is what exists (0 until that stage). Confirming again, for the same spot, is a no-op.
  //
  // How to call:
  //   await sessions.confirmSpot({ client: req.supabase, id, userId: req.user.id, areaId: 'bugis' })
  //   // { planVersion, status: 'voting', meetingAreaId: 'bugis', method: 'voted', slotCount: 0 }
  function confirmSpot({ client, id, userId, areaId }) {
    userId = lower(userId)
    if (areaId !== undefined) requireArea(areaId)
    const done = (state, version) => countSlots(service, id).then((slotCount) => ({
      planVersion: version,
      status: 'voting',
      meetingAreaId: state.session.meeting_area_id,
      method: state.session.meeting_method,
      slotCount,
    }))
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
          if (alreadyConfirmed(draft)) return { ops: [], needs: 'none', answer: ({ version }) => done(draft, version) }
          const list = orderedSpots(draft.spots, draft.suggestions)
          if (list.length === 0) throw refuse(409, 'no_spots', 'There are no spots to confirm yet. They open once two people have shared where they start.')
          const spot = areaId === undefined ? preselectedSpot(list, draft.approvals, draft.members) : list.find((s) => s.area_id === areaId)
          if (!spot) throw refuse(404, 'spot_not_found', 'That spot is not on the list.')
          const { located } = locatedMembers(draft.members, areasById)
          const meeting = meetingAtSpot(spot, methodFor(spot, draft.approvals, draft.members, located))
          return {
            ops: [],
            needs: 'none',
            session: { status: 'voting', banner: null, meeting },
            answer: ({ version }) => done({ session: { meeting_area_id: meeting.area_id, meeting_method: meeting.method } }, version),
          }
        },
      },
    )
  }

  // PUT /api/sessions/:id/known-place: the host sets the meeting area straight away because the group has already decided (E21),
  // from inviting or locating to voting. The list becomes that one area, suggestions and approvals are cleared, and the area is
  // pinned (`chosen`): a later change of start moves the travel times, never the area. One planner run prices the area for the
  // members who have shared a start; with none, the times are zero. The session needs two people, as it does to start.
  //
  // As with confirming a spot, the slots are the voting stage's. Setting the same place again is a no-op.
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
          return {
            ops: [{ op: 'clear_approvals' }, { op: 'clear_suggestions' }],
            needs: 'none',
            spots: [row],
            session: { status: 'voting', banner: null, meeting: meetingAtSpot(row, 'chosen') },
            answer: ({ version }) => ({ planVersion: version, status: 'voting' }),
          }
        },
      },
    )
  }

  return { recompute, suggestSpot, withdrawSpot, optOut, rejoin, removeMember, confirmSpot, setKnownPlace, queue }
}
