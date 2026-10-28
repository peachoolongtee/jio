import { converge, roam, searchVenues } from '../planner/engine.js'
import { CATEGORIES, fromMinutes, reconcileOptions } from '../planner/slot-plan.js'
import { MAX } from '../routes/plan-schemas.js'
import { nowInSingapore } from './planner-runs.js'
import { MAX_ROUTED_TRIPS_PER_REQUEST } from './travel-times.js'
import {
  knownPlaceRow,
  locatedMembers,
  lower,
  meetingAtSpot,
  meetingBannerText,
  MIN_STARTS,
  plannerMethod,
  priceAreaRun,
} from './session-plan.js'
import {
  engineMembers,
  groupConstraints,
  groupSafeResult,
  layoutFor,
  meetingDiffers,
  optionRow,
  optionsOf,
  radiusBannerText,
  rankingInput,
  RANKED_PER_SLOT,
  readRanking,
  slotDetails,
  slotItems,
  survivingVotes,
  VOTES_CLEARED,
  weatherNote,
} from './session-slots.js'

// What the planner does for a voting session, on the server: where the meeting area stands, and which places each slot offers. The
// rules that decide what is stored are in session-slots.js and planner/slot-plan.js; services/sessions.js is the endpoints and the line a
// session's writes wait in. Everything here changes the run's draft, never the database.
//
// Only the saved places are ranked: no Google place is asked for (the lead's decision of 16 October: Google's terms do not allow them
// beside the OneMap map, and an option is stored by its venue id, which a Google place cannot be). Every OneMap trip goes through the
// shared planner runs (services/planner-runs.js), so the per-request cap of 60 trips and the process budget apply; one request has one
// allowance that its meeting area and all its slots spend together.
//
// How to build it (services/sessions.js does this):
//   const voting = createVoting({ data, areasById, runs })
//   const { info, items } = await voting.planPhase(draft, wants, ctx)

// One request's allowance of OneMap: how many trips it may still route (shared by every run of the request, retries included, so a
// retry cannot spend more of the shared account than the request is allowed) and how long it may wait for routes. The wait is a
// clock that starts when routing first needs a call, not when the request begins, so the database reads and the weather before it
// are not charged to "waiting for routes", and a retry of the request calls `restartClock()` to give its attempt a wait of its own.
//
// How to call:
//   const allowance = newAllowance(3000)                      // 60 trips, a 3 second wait once routing starts
//   runs.runWithTravel(input, data, run, () => allowance.routing())
//   allowance.restartClock()                                  // a new attempt of the same request
export function newAllowance(deadlineMs, trips = MAX_ROUTED_TRIPS_PER_REQUEST) {
  let startedAt = null
  const allowance = {
    trips,
    limit: trips,
    called: 0,
    deadlineMs,
    // Starts the clock if it has not started and says how many milliseconds are left (0 when none). runWithRealTravel calls this
    // when it finds it needs to make a call.
    clock: {
      start() {
        startedAt ??= Date.now()
        return Math.max(0, deadlineMs - (Date.now() - startedAt))
      },
    },
    // Called by runWithRealTravel for every call it makes, at the moment it makes it, so a call whose answer arrives too late to be
    // used is still taken from the allowance.
    onCalls(n) {
      allowance.called += n
      allowance.trips = Math.max(0, allowance.limit - allowance.called)
    },
    // The time left, without starting the clock: the full wait before routing starts.
    remainingMs() {
      return startedAt === null ? deadlineMs : Math.max(0, deadlineMs - (Date.now() - startedAt))
    },
    restartClock() {
      startedAt = null
    },
    // The options runWithTravel takes for a run of this request.
    routing() {
      return { maxTrips: allowance.trips, deadlineMs: allowance.remainingMs(), deadlineClock: allowance.clock, onCalls: allowance.onCalls }
    },
  }
  return allowance
}

// Takes what a run used from the request's allowance of OneMap trips. An allowance from newAllowance() is debited call by call as
// the calls are made (onCalls), so there is nothing to do here; any other object is debited by what the run reports, where a trip
// that failed was still a call.
//
// How to call:
//   spend(allowance, travel)
export function spend(allowance, travel) {
  if (allowance.onCalls) return
  allowance.trips = Math.max(0, allowance.trips - (travel.routed ?? 0) - (travel.failed ?? 0))
}

// When a session's trips set off, for public transport times: its own date and start while that is today or later in Singapore,
// otherwise now (the planner's default).
//
// How to call:
//   dateTimeOf({ date: '2026-10-25', start_time: '10:00:00' }) // '2026-10-25T10:00'
export function dateTimeOf(session) {
  const date = String(session.date ?? '')
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date) || date < nowInSingapore().slice(0, 10)) return undefined
  const time = /^\d{2}:\d{2}/.exec(String(session.start_time ?? ''))?.[0] ?? '12:00'
  return `${date}T${time}`
}

// Builds the voting rules over one set of plan data.
//
// Options:
//   data      - Venues and areas the planner reads, from loadPlanData().
//   areasById - A Map of area id to area.
//   runs      - The shared planner runs, from createPlannerRuns().
//
// How to call:
//   const voting = createVoting({ data, areasById, runs })
export function createVoting({ data, areasById, runs }) {
  // The saved places that can be options (the planner's own, every one of them).
  const venues = new Map(data.venues.map((v) => [v.id, v]))

  // Asks the engine to rank one slot's kind of place around the meeting area, with the group's needs and the weather at the slot's time,
  // spending from the request's allowance of OneMap trips. `currentIds` are the options the group has: they are always scored.
  //
  // The group's past feeds the ranking when the run can read it (ctx.debts() and ctx.visits(), both soft: they answer nothing when the history
  // could not be read): each person's travel debt goes to the planner with them, and the places the group has been to lately count against
  // an option. `last` ranks the slot as the plan's last stop (a stop being replaced; a voting slot is never ranked so). `exclude` are places left out
  // whatever they score (the other stops of the plan, for a stop being replaced).
  //
  // How to call:
  //   const ranking = await rankSlot(draft, { category: 'eat', start_minute: 720, duration_minutes: 90 }, ['a', 'b'], ctx)
  //   // { ok, rows: Map(venueId -> result), rankedIds, current: Set, widened, few, empty, weather }
  async function rankSlot(draft, slot, currentIds, ctx, { last = false, exclude = [] } = {}) {
    const centre = areasById.get(draft.session.meeting_area_id)
    const needs = await ctx.needs()
    const [debts, visits] = await Promise.all([ctx.debts?.(), ctx.visits?.()])
    const members = engineMembers(draft, areasById, needs, centre, debts ?? null)
    const resolved = await runs.resolveWeather({ dateTime: `${draft.session.date}T${fromMinutes(slot.start_minute)}` })
    const input = rankingInput({
      sessionId: draft.session.id,
      date: draft.session.date,
      slot,
      members,
      centre,
      currentIds,
      constraints: groupConstraints(needs),
      radiusMeters: draft.session.radius_meters ?? undefined,
      weatherCase: resolved.weatherCase,
      last,
      exclude,
    })
    // The saved sample visits are never used: only this group's own finished outings, when they could be read.
    const planData = visits?.length > 0 ? { ...resolved.planData, visitHistory: visits } : resolved.planData
    const { result, travel } = await runs.runWithTravel(input, planData, converge, () => ({
      ...ctx.allowance.routing(),
    }))
    spend(ctx.allowance, travel)
    return readRanking(result, resolved)
  }

  // Asks the engine for the places near a point, for Roam ("What next?"), with the group's needs and the weather at `dateTime`, spending from
  // the request's allowance of OneMap trips (one trip per place scored, from the point). The point is for this request only: it is not stored,
  // and the engine's answer, which repeats it, is cut down by roamReply before anyone reads it. Only saved places are ranked.
  //
  // How to call:
  //   const { result, weather } = await roamAround(draft, { current: { lat: 1.3, lng: 103.8 }, categories: ['eat'], dateTime: '2026-10-25T15:00', minutes: 60 }, ctx)
  async function roamAround(draft, { current, categories, dateTime, minutes }, ctx) {
    const centre = areasById.get(draft.session.meeting_area_id)
    const needs = await ctx.needs()
    const [debts, visits] = await Promise.all([ctx.debts?.(), ctx.visits?.()])
    const members = engineMembers(draft, areasById, needs, centre, debts ?? null)
    const resolved = await runs.resolveWeather({ dateTime })
    const input = {
      members,
      occasion: 'catch_up',
      dateTime,
      durationMinutes: minutes,
      ...(categories && { categories }),
      current,
      groupConstraints: groupConstraints(needs),
      excludeVenueIds: [],
      currentOptionIds: [],
      unknownPolicy: 'lenient',
      dietPolicy: 'strict',
      ...(resolved.weatherCase !== undefined && { weatherCase: resolved.weatherCase }),
      groupId: draft.session.id,
      topN: RANKED_PER_SLOT,
    }
    const planData = visits?.length > 0 ? { ...resolved.planData, visitHistory: visits } : resolved.planData
    const { result, travel } = await runs.runWithTravel(input, planData, roam, () => ({
      ...ctx.allowance.routing(),
      // The point is a person's position: its routes are not read from or put in the route cache, so nothing of it stays in this process.
      cache: false,
    }))
    spend(ctx.allowance, travel)
    return { result, weather: weatherNote(resolved.weather) }
  }

  // The meeting area as the draft's members now make it, for a session that is voting. A chosen area (`voted` or `chosen`) stays where it
  // is and only its travel times are worked out again, from whoever has shared a start; with nobody it has zero times. The planner's own
  // pick may move: fewer than two starts pauses it (null), otherwise the fairest area is worked out again. Returns the meeting in the
  // shape apply_session_plan takes (or null for paused) and whether the area moved.
  //
  // How to call:
  //   const { meeting, moved } = await repriceMeeting(draft, ctx) // meeting: { area_id, method, max_minutes, ..., travel }
  async function repriceMeeting(draft, ctx) {
    const session = draft.session
    const debts = (await ctx.debts?.()) ?? null
    const { located } = locatedMembers(draft.members, areasById, debts)
    const dateTime = dateTimeOf(session)
    const options = () => ctx.allowance.routing()

    if (['voted', 'chosen'].includes(session.meeting_method) && session.meeting_area_id) {
      let priced = null
      let travel = null
      if (located.length > 0) {
        const area = areasById.get(session.meeting_area_id)
        const input = { members: located, area: { id: area.id, lat: area.lat, lng: area.lng }, dateTime }
        ;({ result: priced, travel } = await runs.runWithTravel(input, data, priceAreaRun, options))
        spend(ctx.allowance, travel)
      }
      return { meeting: meetingAtSpot(knownPlaceRow(session.meeting_area_id, priced, travel), session.meeting_method), moved: false }
    }

    if (located.length < MIN_STARTS) return { meeting: null, moved: session.meeting_area_id !== null && session.meeting_area_id !== undefined }

    const { result, travel } = await runs.runWithTravel({ members: located, method: 'station', dateTime }, data, runs.meetingAreaWithRouting, (request) => ({
      ...runs.meetingAreaTravelFor(request),
      ...options(),
    }))
    spend(ctx.allowance, travel)
    const row = {
      area_id: result.area.id,
      travel_minutes: Object.fromEntries(Object.entries(result.travelByMember).map(([id, minutes]) => [lower(id), Number.isFinite(minutes) ? Math.min(1440, Math.max(0, minutes)) : 1440])),
      approximate: !!result.approximate || travel?.source === 'estimate',
    }
    return { meeting: meetingAtSpot(row, plannerMethod(located)), moved: row.area_id !== (session.meeting_area_id ?? null) }
  }

  // Ranks the slots a run asked for and puts the reconciled options in the draft: the places people already vote on stay while they still
  // fit, the list tops up to three, and never more than six. A slot the day no longer has room for is removed. A kind that has no row yet
  // is always ranked. Returns the categories the run changed.
  //
  // How to call:
  //   const dirty = await syncSlots(draft, 'all', ctx) // Set { 'eat', 'drink', ... }
  async function syncSlots(draft, rank, ctx) {
    const dirty = new Set()
    if (!draft.session.meeting_area_id) {
      // Voting is paused (nobody has shared where they start): there is no area to offer places around, so no options.
      for (const row of draft.slots) {
        if (row.deleted || !draft.options.some((o) => o.category === row.category)) continue
        draft.options = draft.options.filter((o) => o.category !== row.category)
        dirty.add(row.category)
      }
      return dirty
    }
    const layout = layoutFor(draft)
    const wanted = new Set(rank === 'all' ? CATEGORIES : rank)
    const lastCategory = layout.at(-1)?.category
    for (const category of CATEGORIES) {
      const row = draft.slots.find((s) => s.category === category)
      if (row?.deleted) continue
      const spec = layout.find((s) => s.category === category)
      if (!spec) {
        if (row) {
          row.removed = true
          draft.options = draft.options.filter((o) => o.category !== category)
          dirty.add(category)
        }
        continue
      }
      if (row && !wanted.has(category)) continue
      const stored = optionsOf(draft, category)
      const currentIds = stored.map((o) => o.venue_id)
      const slot = { category, start_minute: spec.start, duration_minutes: spec.duration }
      const ranking = await rankSlot(draft, slot, currentIds, ctx)
      const ids = reconcileOptions(currentIds, ranking.rankedIds)
      const had = new Map(stored.map((o) => [o.venue_id, o]))
      const next = ids.map((id) => optionRow(category, ranking.rows.get(id), { source: had.get(id)?.source ?? 'planner', addedBy: had.get(id)?.added_by ?? null }))
      draft.options = [...draft.options.filter((o) => o.category !== category), ...next]
      const fields = {
        category,
        start_minute: spec.start,
        duration_minutes: spec.duration,
        picks: spec.picks,
        is_last: category === lastCategory,
        deleted: false,
        removed: false,
        synced: true,
        details: slotDetails(ranking, ids.length),
      }
      if (row) Object.assign(row, fields)
      else draft.slots.push({ id: null, ...fields })
      dirty.add(category)
    }
    return dirty
  }

  // The voting half of a run, after the jobs have changed the draft: the meeting area (when a job asked), the slots (when a job asked),
  // the votes that go with a moved area, and the notice the group sees. `wants` are the jobs' requests:
  //   { meeting?: true, rank?: 'all' | [category], trigger?: { kind, name }, radius?: true }
  // Returns what to write: { ops, session, items, info }. `session` holds the meeting and the banner when they change; `items` are the
  // patch's slots; `info` is what the answers say (moved, votesCleared, meetingAreaId, slotCount, paused).
  //
  // How to call:
  //   const { ops, session, items, info } = await planPhase(draft, [{ meeting: true, rank: 'all', trigger: { kind: 'start', name: 'Ian' } }], ctx)
  async function planPhase(draft, wants, ctx) {
    const ops = []
    const session = {}
    const dirty = new Set(draft.dirty)
    const info = { moved: false, votesCleared: false, paused: false }
    const trigger = wants.find((w) => w.trigger)?.trigger
    const radius = wants.some((w) => w.radius)
    let figuresChanged = false
    let previousName = null
    let nextName = null

    if (wants.some((w) => w.meeting)) {
      const previous = draft.session.meeting_area_id ?? null
      previousName = previous ? areasById.get(previous)?.name ?? previous : null
      const { meeting, moved } = await repriceMeeting(draft, ctx)
      figuresChanged = meetingDiffers(draft.session, draft.members, meeting)
      session.meeting = meeting
      nextName = meeting ? areasById.get(meeting.area_id)?.name ?? meeting.area_id : null
      draft.session.meeting_area_id = meeting?.area_id ?? null
      draft.session.meeting_method = meeting?.method ?? null
      info.moved = moved
      if (moved) {
        // The area moved: every vote was for a place near the old one, and the options are chosen again from nothing.
        info.votesCleared = draft.votes.length > 0
        if (draft.votes.length > 0 || draft.slots.length > 0) ops.push({ op: 'clear_votes' })
        draft.votes = []
        for (const row of draft.slots) if (draft.options.some((o) => o.category === row.category)) dirty.add(row.category)
        draft.options = []
      }
    }

    const votesBefore = draft.votes.length
    const rank = wants.some((w) => w.rank === 'all') ? 'all' : [...new Set(wants.flatMap((w) => (Array.isArray(w.rank) ? w.rank : [])))]
    if (rank === 'all' || rank.length > 0 || draft.session.meeting_area_id === null || draft.slots.length === 0) {
      for (const category of await syncSlots(draft, rank, ctx)) dirty.add(category)
    }
    const survivors = survivingVotes(draft)
    const lost = votesBefore - survivors.length
    info.paused = !draft.session.meeting_area_id
    info.slotCount = draft.slots.filter((s) => !s.deleted && !s.removed).length

    // The notice. A moved area (or a paused one) says so and, when votes went, that they did. A radius change says it only when it took
    // votes away, and takes back its own earlier notice when it did not. A start or end that left the area where it was says so only when
    // the travel times changed. A repeat that changes nothing writes no notice.
    // (A re-plan names no change of the group, so figures that moved without the area moving are not announced.)
    if (info.moved || (wants.some((w) => w.meeting) && figuresChanged && trigger && trigger.kind !== 'replan')) {
      if (trigger) {
        const text = meetingBannerText({ previousName, nextName, kind: trigger.kind, name: trigger.name })
        session.banner = { text: info.votesCleared ? `${text} ${VOTES_CLEARED}` : text, ...(info.votesCleared && { votesCleared: true }) }
      }
    } else if (radius) {
      if (lost > 0) session.banner = { text: radiusBannerText(draft.session.radius_meters), votesCleared: true, byRadius: true }
      else if (draft.session.banner?.byRadius) session.banner = null
    }
    draft.votes = survivors
    return { ops, session, items: slotItems(draft, dirty), info }
  }

  // Searches the saved places by name for a slot, to add one by hand: each result says whether it fits the slot and, when not, why (a need of
  // the group is only ever `group_needs`, never which need). No
  // Google and no OneMap lookup, so the postal-code step of the stateless search is not here. Reads only.
  //
  // How to call:
  //   const results = await searchSlot(draft, slot, 'ya kun', ctx) // [{ venueId, name, area, category, source, fits, unfit, ... }]
  async function searchSlot(draft, slot, query, ctx) {
    const centre = areasById.get(draft.session.meeting_area_id)
    const needs = await ctx.needs()
    const members = engineMembers(draft, areasById, needs, centre)
    const text = query.trim()
    const found = searchVenues(
      {
        query: text,
        centre: { lat: centre.lat, lng: centre.lng },
        dateTime: `${draft.session.date}T${fromMinutes(slot.start_minute)}`,
        durationMinutes: slot.duration_minutes,
        categories: [slot.category],
        lastStop: false,
        members,
        groupConstraints: groupConstraints(needs),
        unknownPolicy: 'lenient',
        dietPolicy: 'strict',
        ...(draft.session.radius_meters ? { maxKm: draft.session.radius_meters / 1000 } : {}),
        limit: 12,
      },
      { ...data, venues: [...venues.values()] },
    )
    const have = new Set(optionsOf(draft, slot.category).map((o) => o.venue_id))
    // Every member reads the answer, so no reason names a need and no result names the needs it only likely meets (groupSafeResult).
    return found.map((r) => ({ ...groupSafeResult(r), added: have.has(r.venueId) }))
  }

  return { rankSlot, roamAround, repriceMeeting, syncSlots, planPhase, searchSlot, venues, MAX_QUERY: MAX.searchQuery }
}
