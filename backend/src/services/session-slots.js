import { CATEGORIES, fromMinutes, layoutSlots, toMinutes } from '../planner/slot-plan.js'
import { isAbout, locatedMembers, lower } from './session-plan.js'

// The rules of the slots and options of a voting session, as pure functions: rows in, rows out. No database, no planner call, no clock.
// The service (services/sessions.js) loads the rows into a "draft", the voting rules (services/session-voting.js) change the draft with
// the planner's help, and this file turns the draft back into the patch apply_session_plan writes.
//
// The draft's rows are the tables' rows with one change: an option or a vote is keyed by its slot's category, not its slot's id, because a
// slot made in this very run has no id yet.
//   slot    { id | null, category, start_minute, duration_minutes, picks, is_last, deleted, details, synced?, removed? }
//   option  { category, venue_id, rank, score, source, added_by, details }
//   vote    { category, user_id, venue_id }
// Travel times come from the centres of areas, never from an exact place, and no answer built here carries a label or a coordinate.

// The most places a slot holds is in planner/slot-plan.js (OPTIONS_MAX). Any saved place can be an option: the longest id is 86
// characters and the table's check (slot_options.venue_id) and the request bound (MAX.venueId) are both 160.

// How many places a ranking asks for per slot (the browser's RANKED_MAX): the top ten, and every current option that still fits.
export const RANKED_PER_SLOT = 10

// Every part of an option's details together stay well inside what a person can read in a card, and far inside what a row should hold.
const MAX_DETAILS_BYTES = 3000

// The session's window in minutes after midnight.
//
// How to call:
//   windowOf({ start_time: '10:00:00', end_time: '20:00:00' }) // { windowStart: 600, windowEnd: 1200 }
export function windowOf(session) {
  return { windowStart: toMinutes(session.start_time) ?? 0, windowEnd: toMinutes(session.end_time) ?? 1439 }
}

// The slots the draft's members make: one for every kind that has not been removed, as planner/slot-plan.js lays them out.
//
// How to call:
//   layoutFor(draft) // [{ category: 'eat', start: 720, time: '12:00', duration: 90, picks: 2 }, ...]
export function layoutFor(draft) {
  const members = draft.members
    .filter((m) => m.state === 'joined')
    .map((m) => ({ categories: m.categories ?? [], until: toMinutes(m.stay_until) }))
  const removed = draft.slots.filter((s) => s.deleted).map((s) => s.category)
  return layoutSlots({ members, ...windowOf(draft.session), removed })
}

// The category of a slot, by its id. How to call: categoryOfSlot(draft, '3b1f...') // 'eat', or null
export const categoryOfSlot = (draft, slotId) => draft.slots.find((s) => s.id !== null && lower(s.id) === lower(slotId))?.category ?? null

// A slot's options, best ranked first (an option with no rank last, then by place).
//
// How to call:
//   optionsOf(draft, 'eat') // [{ category: 'eat', venue_id: 'a', rank: 1, ... }]
export const optionsOf = (draft, category) =>
  draft.options
    .filter((o) => o.category === category)
    .sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity) || a.venue_id.localeCompare(b.venue_id))

// The people a ranking is for, as the engine wants them: the joined members who have shared where they start, from the centres of their
// areas, with the private needs the server read for them. Their diets count for everyone, though: a joined member with no start yet is
// not planned a trip for, but what they cannot eat is still left out of the options. With nobody located (a known place is set before
// anyone shares a start) everyone is sent as starting at the meeting area, so nobody has a trip to it and nobody is favoured.
//
// `debts` (optional, a Map of lower-case user id to minutes) is each person's travel debt, which the planner reads as `travelDebtMinutes`.
//
// How to call:
//   engineMembers(draft, areasById, needs, centre) // [{ id, name, start: { lat, lng }, end: { lat, lng }, dietary: [], ... }]
export function engineMembers(draft, areasById, needs, centre, debts = null) {
  const needOf = new Map(needs.map((n) => [lower(n.user_id), n]))
  const { located } = locatedMembers(draft.members, areasById)
  const joined = draft.members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id))
  const here = { lat: centre.lat, lng: centre.lng }
  const base = located.length > 0 ? located : joined.map((id) => ({ id, name: id, start: here, end: here }))
  const everyoneEats = [...new Set(joined.flatMap((id) => needOf.get(id)?.dietary ?? []))]
  return base.map((m) => {
    const need = needOf.get(m.id)
    // The diets of the members with no trip are added to the first member's, so the filter (which takes everyone's together) sees them.
    const dietary = m === base[0] ? everyoneEats : (need?.dietary ?? [])
    return {
      id: m.id,
      name: m.id,
      start: m.start,
      end: m.end,
      dietary,
      prefersHealthy: false,
      cuisineLikes: [],
      cuisineDislikes: [],
      travelDebtMinutes: debts?.get(m.id) ?? 0,
      ...(need?.budget_max_per_person !== null && need?.budget_max_per_person !== undefined && { budgetMaxPerPerson: Number(need.budget_max_per_person) }),
    }
  })
}

// The group constraints the members' needs make. Step-free access is one person's need that holds for the whole outing.
//
// How to call:
//   groupConstraints([{ user_id: 'u', needs_step_free: true }]) // ['step_free']
export const groupConstraints = (needs) => (needs.some((n) => n.needs_step_free) ? ['step_free'] : [])

// The request the engine's converge() takes for one slot: places of the slot's kind around the meeting area, at the slot's time. The
// places the group already has are always scored, so they come back in `current` while they still fit. Unknown access and the like are
// kept and flagged (`lenient`), as the browser asks; a place that is not known to suit every member's dietary need is left out
// (`dietPolicy: 'strict'`, the same rule as the diet filter of the stateless planner). It is a catch-up, as the planner client's DEFAULT_OCCASION says.
//
// How to call:
//   rankingInput({ sessionId, date, slot: { category: 'eat', start_minute: 720, duration_minutes: 90 }, members, centre, currentIds: [], constraints: [], radiusMeters: 1000, weatherCase: 'live' })
// `last` ranks the slot as the plan's last stop (a place far from an MRT station then counts against it); a voting slot is never ranked so.
// `exclude` are places the ranking leaves out whatever they score (the other stops of a plan, when a stop is being replaced).
export function rankingInput({ sessionId, date, slot, members, centre, currentIds, constraints, radiusMeters, weatherCase, last = false, exclude = [] }) {
  return {
    members,
    overrides: {},
    optedOut: [],
    occasion: 'catch_up',
    dateTime: `${date}T${fromMinutes(slot.start_minute)}`,
    durationMinutes: slot.duration_minutes,
    categories: [slot.category],
    groupConstraints: constraints,
    excludeVenueIds: exclude,
    currentOptionIds: currentIds,
    unknownPolicy: 'lenient',
    dietPolicy: 'strict',
    ...(weatherCase !== undefined && { weatherCase }),
    groupId: sessionId,
    centre: { lat: centre.lat, lng: centre.lng },
    lastStop: last,
    ...(radiusMeters ? { radiusMeters } : {}),
    topN: RANKED_PER_SLOT,
  }
}

// A number the database accepts in a numeric column, or null.
const finiteOrNull = (value) => (Number.isFinite(value) ? value : null)

// What the planner said about a place, kept with its option so a reload shows the same card without a planner call: the minutes to
// walk from the meeting area, how crowded it is likely to be, the short tags, the rain warning and the indoor swap, the sentence that
// explains the rank, whether a need of the group is unconfirmed for the place, whether a time was an estimate, and the weather there.
// Nothing about a person, and no need is named: every member reads this row, so in a group of two a named need ("halal") would be the
// other person's. The planner's `verify` and `dietUnknown` (which name the needs) become one flag, `checkNeeds`, that is there only when
// it is true. The browser names the needs itself, for the ones it may name, from the place's own diet levels (GET /api/venues).
//
// How to call:
//   optionDetails(result) // { walkMinutes: 3, crowd: 'quiet', reasons: [...], warnings: [], swap: null, explanation: '...', checkNeeds: true, ... }
export function optionDetails(r) {
  const checkNeeds = (r.verify?.length ?? 0) + (r.dietUnknown?.length ?? 0) > 0
  const full = {
    walkMinutes: finiteOrNull(r.walkMinutes),
    crowd: r.crowd ?? null,
    reasons: r.reasons ?? [],
    warnings: r.warnings ?? [],
    swap: r.swap ?? null,
    explanation: r.explanation ?? '',
    ...(checkNeeds ? { checkNeeds: true } : {}),
    approximate: isAbout(r),
    ...(r.weather ? { weather: r.weather } : {}),
  }
  // Through JSON, so a value that is undefined is not there at all.
  const plain = JSON.parse(JSON.stringify(full))
  if (Buffer.byteLength(JSON.stringify(plain)) <= MAX_DETAILS_BYTES) return plain
  // Far larger than a card needs: keep what the card shows, not the long text.
  return { walkMinutes: plain.walkMinutes, crowd: plain.crowd, reasons: plain.reasons.slice(0, 2), warnings: plain.warnings, approximate: plain.approximate }
}

// The words of the reasons a place does not fit that name a need of the group (a diet, step-free access), which a search must not say to
// everyone in the session. They become one reason that names none.
const NEED_REASONS = (reason) => reason.startsWith('diet:') || reason === 'step_free'

// One search result as every member may read it: the reasons that name a need of the group (`diet:halal`, `step_free`) become one
// `group_needs` (once), and `verify` and `dietUnknown`, which name the needs a place only likely meets or has no data on, are left out.
// The other reasons (closed, far, the wrong kind of place) are about the place and stay.
//
// How to call:
//   groupSafeResult({ venueId: 'a', unfit: ['diet:halal', 'far', 'diet:vegan'], verify: ['halal'], dietUnknown: [] }) // { venueId: 'a', unfit: ['group_needs', 'far'] }
export function groupSafeResult(result) {
  const { verify: _verify, dietUnknown: _dietUnknown, unfit, ...rest } = result
  const reasons = []
  for (const reason of unfit ?? []) {
    const shown = NEED_REASONS(reason) ? 'group_needs' : reason
    if (!reasons.includes(shown)) reasons.push(shown)
  }
  return { ...rest, unfit: reasons }
}

// One planner result as an option row of the draft. A place the group already had keeps who added it and how (`source`).
//
// How to call:
//   optionRow('eat', result, { source: 'member', addedBy: userId })
export function optionRow(category, r, { source = 'planner', addedBy = null } = {}) {
  return { category, venue_id: r.venueId, rank: Number.isInteger(r.rank) ? r.rank : null, score: finiteOrNull(r.score), source, added_by: addedBy, details: optionDetails(r) }
}

// The forecast the ranking was scored on, in the few fields a card needs to say so.
//
// How to call:
//   weatherNote({ source: 'live', basis: 'area', validUntil: '2026-10-25T12:00:00+08:00', phrase: 'Showers' })
export function weatherNote(block) {
  if (!block) return null
  const note = {}
  for (const key of ['source', 'basis', 'issuedAt', 'validUntil', 'phrase', 'reason']) if (block[key] !== undefined) note[key] = block[key]
  return note
}

// Reads the engine's answer for a slot: every place it scored (the top ones and the current options that still fit), best first, and
// what it said about the slot as a whole.
//
// How to call:
//   const ranking = readRanking(answer, resolved) // { ok, rows: Map(venueId -> result), rankedIds, current: Set, widened, few, empty, weather }
export function readRanking(answer, resolved) {
  const ok = answer.status === 'ok'
  const rows = new Map()
  for (const r of [...(answer.results ?? []), ...(answer.current ?? [])]) if (!rows.has(r.venueId)) rows.set(r.venueId, r)
  const notice = ok ? answer.notice : null
  return {
    ok,
    rows,
    rankedIds: [...rows.keys()],
    current: new Set((answer.current ?? []).map((r) => r.venueId)),
    widened: !!notice,
    few: notice?.type === 'few_options' ? { found: notice.found, widenToKm: notice.widenToKm } : null,
    empty: ok ? null : { reason: answer.reason ?? null, nearestKm: finiteOrNull(answer.hints?.nearestKm), widenToKm: finiteOrNull(answer.hints?.widenToKm) },
    weather: weatherNote(resolved?.weather),
  }
}

// What the planner said about a slot as a whole, for slots.details: whether the radius was widened, how few places fit inside the radius,
// why the slot came up empty, whether more places could be offered, and the forecast behind it.
//
// How to call:
//   slotDetails(ranking, 3) // { widened: false, few: null, empty: null, moreAvailable: true, weather: { source: 'live', ... } }
export function slotDetails(ranking, optionCount) {
  return {
    widened: ranking.widened,
    few: ranking.few,
    empty: ranking.empty,
    moreAvailable: ranking.rankedIds.length > optionCount,
    weather: ranking.weather,
  }
}

// Minutes to one decimal place, as the stateless planner answers them. How to call: oneDecimal(12.34) // 12.3
const oneDecimal = (minutes) => (Number.isFinite(minutes) ? Math.round(minutes * 10) / 10 : null)

// The engine's Roam answer as a session's members may read it (POST /api/sessions/:id/roam). It leaves out where the group is (`centre`: the
// caller's own point is used for one request and not repeated), the score breakdown, the engine's counters, and the names of needs: a result's
// `verify` and `dietUnknown` (which name the needs a place only likely meets) become the one flag `checkNeeds`, and an empty answer's hints
// (which say which need or constraint to drop) are cut down to the distances. Each place says whether it is already a stop (`isStop`) and who
// put it forward as the next stop, if anyone (`proposedBy`, a member's id, which every member can read in stop_proposals anyway).
//
// How to call:
//   roamReply(answer, { weather, stopVenueIds: new Set(['a']), proposedBy: new Map([['b', userId]]) })
//   // { status: 'ok', results: [{ rank, venueId, name, venue, score, travelMinutes, distanceKm, ..., isStop, proposedBy }], notice, weather }
export function roamReply(answer, { weather, stopVenueIds, proposedBy }) {
  if (answer.status !== 'ok') {
    const hints = {}
    for (const key of ['nearestKm', 'widenToKm']) if (Number.isFinite(answer.hints?.[key])) hints[key] = answer.hints[key]
    return { status: 'empty', reason: answer.reason ?? null, hints, results: [], weather }
  }
  return {
    status: 'ok',
    results: answer.results.map((r) => ({
      rank: r.rank,
      venueId: r.venueId,
      name: r.name,
      venue: r.venue,
      score: finiteOrNull(r.score),
      travelMinutes: oneDecimal(r.travelMinutes),
      distanceKm: finiteOrNull(r.distanceKm),
      walkMinutes: oneDecimal(r.walkMinutes),
      crowd: r.crowd ?? null,
      reasons: r.reasons ?? [],
      warnings: r.warnings ?? [],
      swap: r.swap ?? null,
      ...(r.weather ? { weather: r.weather } : {}),
      explanation: r.explanation ?? '',
      approximate: isAbout(r),
      ...((r.verify?.length ?? 0) + (r.dietUnknown?.length ?? 0) > 0 ? { checkNeeds: true } : {}),
      isStop: stopVenueIds.has(r.venueId),
      proposedBy: proposedBy.get(r.venueId) ?? null,
    })),
    notice: answer.notice ?? null,
    weather,
  }
}

// The votes that stand once the draft's slots and options are as they are: a vote stands when its person is joined, its slot is still
// there and not removed, and its place is still an option of it. This is what the database does by foreign key and by the rules of
// apply_session_plan, worked out here so the notice can say whether anything was lost.
//
// How to call:
//   survivingVotes(draft).length // 4
export function survivingVotes(draft) {
  const joined = new Set(draft.members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id)))
  const live = new Set(draft.slots.filter((s) => !s.deleted && !s.removed).map((s) => s.category))
  const options = new Set(draft.options.filter((o) => live.has(o.category)).map((o) => `${o.category}|${o.venue_id}`))
  return draft.votes.filter((v) => joined.has(lower(v.user_id)) && options.has(`${v.category}|${v.venue_id}`))
}

// The slot items of the patch, one for every category the run touched ("dirty"): a removed slot is `remove`, a deleted one `deleted`, and
// every other carries its complete list of options (a place left out is dropped, with its votes) and, when the run laid it out again,
// its time, length and the planner's notes. A category the run did not touch is not mentioned, so its options and votes are not touched.
//
// How to call:
//   slotItems(draft, new Set(['eat'])) // [{ category: 'eat', deleted: false, options: [{ venue_id: 'a', rank: 1, ... }] }]
export function slotItems(draft, dirty) {
  const items = []
  for (const category of CATEGORIES) {
    if (!dirty.has(category)) continue
    const row = draft.slots.find((s) => s.category === category)
    if (row?.removed) {
      items.push({ category, remove: true })
    } else if (row?.deleted) {
      items.push({ category, deleted: true })
    } else if (row) {
      items.push({
        category,
        ...(row.synced && {
          start_minute: row.start_minute,
          duration_minutes: row.duration_minutes,
          picks: row.picks,
          is_last: row.is_last,
          details: row.details,
        }),
        deleted: false,
        options: optionsOf(draft, category).map((o) => ({
          venue_id: o.venue_id,
          rank: o.rank,
          score: o.score,
          source: o.source,
          added_by: o.added_by,
          details: o.details,
        })),
      })
    }
  }
  return items
}

// Do the figures of a meeting differ from the session's, or does a joined member's stored minutes differ from the new ones? The same test
// apply_session_plan makes before it writes (a member whose minutes were never stored does not count), so the run says "the meeting
// changed" exactly when the database will write it.
//
// How to call:
//   meetingDiffers(draft.session, draft.members, meeting) // meeting: { area_id, method, max_minutes, ... , travel } or null
export function meetingDiffers(session, members, meeting) {
  const next = meeting
    ? [meeting.area_id, meeting.method, Math.round(meeting.max_minutes), Math.round(meeting.total_minutes), Math.round(meeting.count), meeting.approximate]
    : [null, null, null, null, null, null]
  const stored = [session.meeting_area_id, session.meeting_method, session.meeting_max_minutes, session.meeting_total_minutes, session.meeting_count, session.meeting_approximate].map((v) => v ?? null)
  if (next.some((v, i) => v !== stored[i])) return true
  if (!meeting?.travel) return false
  return members.some((m) => {
    if (m.state !== 'joined' || m.travel_minutes === null || m.travel_minutes === undefined) return false
    const minutes = meeting.travel[lower(m.user_id)]
    return (minutes === undefined ? null : Math.round(minutes)) !== m.travel_minutes
  })
}

// The notice for a radius change that took votes away. The browser's own text, so both read the same.
//
// How to call:
//   radiusBannerText(1000) // 'Votes for places outside the new ring were cleared.'
export const radiusBannerText = (metres) => (metres == null ? 'Votes for places that no longer fit were cleared.' : 'Votes for places outside the new ring were cleared.')

// The notice when the group's dietary needs changed and the places were picked again. It names nobody and no need (every member reads it, and in
// a small group a named need is a person's). When votes for places that no longer fit were cleared, it says so after.
//
// How to call:
//   dietBannerText(0) // "The group's dietary needs changed, so the places were picked again."
export const dietBannerText = (votesLost) =>
  `The group's dietary needs changed, so the places were picked again.${votesLost > 0 ? ' Votes for places that no longer fit were cleared.' : ''}`

// The sentence that follows a notice when the meeting area moved and took the votes with it.
export const VOTES_CLEARED = 'Votes for places were cleared.'
