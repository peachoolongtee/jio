import { converge, searchVenues } from '../planner/engine.js'
import { CATEGORIES, fromMinutes, reconcileOptions } from '../planner/slot-plan.js'
import { MAX } from '../routes/plan-schemas.js'
import { nowInSingapore } from './planner-runs.js'
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
  readRanking,
  slotDetails,
  slotItems,
  survivingVotes,
  VOTES_CLEARED,
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

// Takes what a run used from the request's allowance of OneMap trips. A trip that failed was still a call.
//
// How to call:
//   spend(allowance, travel)
export function spend(allowance, travel) {
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
  // How to call:
  //   const ranking = await rankSlot(draft, { category: 'eat', start_minute: 720, duration_minutes: 90 }, ['a', 'b'], ctx)
  //   // { ok, rows: Map(venueId -> result), rankedIds, current: Set, widened, few, empty, weather }
  async function rankSlot(draft, slot, currentIds, ctx) {
    const centre = areasById.get(draft.session.meeting_area_id)
    const needs = await ctx.needs()
    const members = engineMembers(draft, areasById, needs, centre)
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
    })
    const { result, travel } = await runs.runWithTravel(input, resolved.planData, converge, () => ({
      maxTrips: ctx.allowance.trips,
      deadlineMs: Math.max(0, ctx.allowance.deadlineAt - Date.now()),
    }))
    spend(ctx.allowance, travel)
    return readRanking(result, resolved)
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
    const { located } = locatedMembers(draft.members, areasById)
    const dateTime = dateTimeOf(session)
    const options = () => ({ maxTrips: ctx.allowance.trips, deadlineMs: Math.max(0, ctx.allowance.deadlineAt - Date.now()) })

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
    if (info.moved || (wants.some((w) => w.meeting) && figuresChanged && trigger)) {
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

  return { rankSlot, repriceMeeting, syncSlots, planPhase, searchSlot, venues, MAX_QUERY: MAX.searchQuery }
}
