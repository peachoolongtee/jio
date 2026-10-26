import { createHash } from 'node:crypto'
import { buildItinerary, TRAVEL_MODES } from '../planner/itinerary.js'
import { buildSlots, CATEGORIES, toMinutes } from '../planner/slot-plan.js'
import { lower } from './session-plan.js'
import { optionsOf, windowOf } from './session-slots.js'

// The rules of a session's plan, as pure functions: rows in, rows out. No database, no planner call, no clock. They turn what the group
// voted into stops, say whether a stored suggestion is still the one for those stops, and change a confirmed plan's stops (delete, move,
// travel mode, another place, a proposal added) the way the browser's own rules do. The service (services/sessions.js) loads the rows,
// calls these, and writes what they return through apply_session_plan.
//
// Row shapes (the column names of the tables):
//   voted stop  { slotId, category, venueId, plannedStart, duration }                   what a confirm would make, in the voted order
//   stop row    { id?, seq, slot_id, category, venue_id, planned_start_minute, duration_minutes, travel_mode, travel_minutes, not_before_minute }
// A stop with no slot (slot_id null) was added from a Roam proposal; the others come from a slot the group voted on.
// In a stored stop `planned_start_minute` is where the stop starts in the laid-out itinerary (laidOutRows): every function below that
// answers rows to store answers them laid out, so the database holds the times the screens draw. (A voted stop, before it is laid out, carries
// the start its slot gave it.)
//
// How to call:
//   const stops = votedStops(draft)                       // the stops confirming would make
//   const basis = basisOf(draft.session, stops)            // the hash a suggestion is made for
//   const rows = confirmedRows(stops, venueOf)             // the stop rows a confirm writes

// The last minute a column of minutes holds (23:59).
const LAST_MINUTE = 1439

// The most stops a plan holds (the database's limit, MAX.stops in routes/plan-schemas.js).
export const MAX_STOPS = 8

// How long a stop added from a Roam proposal lasts, and the length Roam ranks places for, in minutes.
export const ROAM_MINUTES = 60

// How many places a member may have waiting for the host, and the session in all (the function checks the same under its lock).
export const PROPOSALS_PER_MEMBER = 3
export const PROPOSALS_PER_SESSION = 10

// Is this stop one added from a Roam proposal (no slot)? Such a stop keeps its earliest start when the order changes.
//
// How to call:
//   isRoamStop({ slot_id: null }) // true
export const isRoamStop = (row) => row.slot_id === null || row.slot_id === undefined

// The place that wins a slot: the one with the most votes of joined members, a tie going to the better planner score (a lower penalty),
// then to the better rank. A slot with no options has no winner.
//
// How to call:
//   winnerOf(draft, 'eat') // 'ya-kun-kaya-toast', or null
export function winnerOf(draft, category) {
  const joined = new Set(draft.members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id)))
  const counts = new Map()
  for (const v of draft.votes) if (v.category === category && joined.has(lower(v.user_id))) counts.set(v.venue_id, (counts.get(v.venue_id) ?? 0) + 1)
  const options = optionsOf(draft, category)
  if (options.length === 0) return null
  const score = (o) => (Number.isFinite(o.score) ? o.score : Infinity)
  // optionsOf is best rank first, and a sort is stable, so a tie on votes and score keeps the better rank.
  return [...options].sort((a, b) => (counts.get(b.venue_id) ?? 0) - (counts.get(a.venue_id) ?? 0) || score(a) - score(b))[0].venue_id
}

// How many joined members have voted in a slot that is still there.
//
// How to call:
//   votersOf(draft) // 2
export function votersOf(draft) {
  const joined = new Set(draft.members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id)))
  const live = new Set(draft.slots.filter((s) => s.id && !s.deleted && !s.removed).map((s) => s.category))
  return new Set(draft.votes.filter((v) => live.has(v.category) && joined.has(lower(v.user_id))).map((v) => lower(v.user_id))).size
}

// The stops the votes make now, in the voted order: a kind that somebody voted in has a stop, and the kinds are laid back to back inside
// the session's window (the browser's planSlotsOf), each holding the place that wins its slot. A kind that cannot fit has none.
//
// How to call:
//   votedStops(draft) // [{ slotId, category: 'eat', venueId: 'ya-kun-kaya-toast', plannedStart: 720, duration: 90 }, ...]
export function votedStops(draft) {
  const joined = draft.members.filter((m) => m.state === 'joined')
  const joinedIds = new Set(joined.map((m) => lower(m.user_id)))
  const live = draft.slots.filter((s) => s.id && !s.deleted && !s.removed)
  const voted = CATEGORIES.filter((c) => live.some((s) => s.category === c) && draft.votes.some((v) => v.category === c && joinedIds.has(lower(v.user_id))))
  const everyone = Object.fromEntries(joined.map((m) => [lower(m.user_id), { categories: voted, until: toMinutes(m.stay_until) }]))
  return buildSlots({ prefs: everyone, ...windowOf(draft.session) })
    .map((slot) => {
      const venueId = winnerOf(draft, slot.category)
      return venueId ? { slotId: live.find((s) => s.category === slot.category).id, category: slot.category, venueId, plannedStart: slot.start, duration: slot.duration } : null
    })
    .filter(Boolean)
}

// "HH:MM" of a time such as "10:00:00".
const hhmm = (time) => String(time ?? '').slice(0, 5)

// A hash of what a suggested order was made for: the stops it would order (slot, place, start, length) and the session's date and times. The
// suggestion is stored with it, and the confirm takes the suggested order only if the stops now still hash to the same value. Nothing about
// a person is in it.
//
// How to call:
//   basisOf({ date: '2026-10-25', start_time: '10:00:00', end_time: '20:00:00' }, stops) // 64 hex characters
export function basisOf(session, stops) {
  const parts = [String(session.date), hhmm(session.start_time), hhmm(session.end_time), stops.map((s) => [s.slotId, s.venueId, s.plannedStart, s.duration])]
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex')
}

// The opening hours of a place as the order rules read them ("10:00-22:00"), at most four.
const HOURS = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/

// The stops as planner/arrange.js wants them: the place's name, kind, point, hours and setting, and the stop's length. Only these go to
// the AI provider (as names, kinds and times), nothing about a person.
//
// How to call:
//   arrangeInput(stops, (id) => venues.get(id), session) // { stops, startAt, endAt }
export function arrangeInput(stops, venueOf, session) {
  const { windowStart, windowEnd } = windowOf(session)
  return {
    stops: stops.map((s) => {
      const v = venueOf(s.venueId)
      return {
        id: s.slotId,
        name: String(v.name).slice(0, 80),
        category: s.category,
        ...(v.kind ? { kind: String(v.kind).slice(0, 80) } : {}),
        lat: v.lat,
        lng: v.lng,
        duration: s.duration,
        // A meal is anchored to its slot's time from voting.
        start: s.plannedStart,
        hours: (v.openingHours ?? []).map(([open, close]) => `${open}-${close}`).filter((h) => HOURS.test(h)).slice(0, 4),
        ...(typeof v.setting === 'string' ? { indoor: v.setting === 'indoor' } : {}),
        ...(Number.isFinite(v.mrtWalkMinutes) ? { mrtWalk: v.mrtWalkMinutes } : {}),
      }
    }),
    startAt: Math.min(...stops.map((s) => s.plannedStart)),
    endAt: windowEnd <= windowStart ? windowEnd + 1440 : windowEnd,
  }
}

// Does a stored suggestion still fit the stops a confirm would make now? Yes only when it names exactly those slots, each once, with a
// start for each that is a whole minute in the day, times that never overlap, and a meal never earlier than its time from voting. (The
// basis already says the stops are the same; this guards a stored row that was made some other way.)
//
// How to call:
//   suggestionFits(stops, { order: [slotId, ...], starts: { [slotId]: 600 } }) // true
export function suggestionFits(stops, suggestion) {
  const order = suggestion?.order
  const starts = suggestion?.starts
  if (!Array.isArray(order) || starts === null || typeof starts !== 'object' || !stops.length || order.length !== stops.length) return false
  const voted = new Map(stops.map((s) => [s.slotId, s]))
  if (voted.size !== stops.length || new Set(order).size !== order.length) return false
  let freeFrom = 0
  return order.every((slotId) => {
    const mine = voted.get(slotId)
    const start = starts[slotId]
    if (!mine || !Number.isInteger(start) || start < freeFrom || start >= 2880) return false
    if (mine.category === 'eat' && start < mine.plannedStart) return false
    freeFrom = start + mine.duration
    return true
  })
}

// A stop's point, or null when the place is not known.
const pointOf = (venueOf, venueId) => {
  const v = venueOf(venueId)
  return v && Number.isFinite(v.lat) && Number.isFinite(v.lng) ? { lat: v.lat, lng: v.lng } : null
}

// The stops as the itinerary times them: each starts after the one before it plus the leg between them, never before its earliest start.
// The plan starts at `startAt` (else the first stop's stored start, which is read only then). Starts are not limited to the day: a plan that
// runs past midnight has starts of 1440 and more here, though a stored start is kept to 1439 (see laidOutRows). Answers the rows with `start`
// and `end`, and the legs.
//
// How to call:
//   const { timed, legs } = timedRows(rows, venueOf, 720)   // timed[i].start, legs[i].minutes
export function timedRows(rows, venueOf, startAt) {
  const stops = rows.map((r) => ({
    row: r,
    venue: pointOf(venueOf, r.venue_id) ?? { lat: 1.3521, lng: 103.8198 },
    plannedStart: r.planned_start_minute,
    duration: r.duration_minutes,
    notBefore: r.not_before_minute,
  }))
  const { stops: timed, legs } = buildItinerary(stops, rows.slice(1).map((r) => r.travel_mode), startAt ?? null)
  return { timed: timed.map(({ row, start, end }) => ({ ...row, start, end })), legs }
}

// The rows as the itinerary lays them out, ready to store, and the starts as laid out. In the rows every stop's `planned_start_minute` is the
// start the screens draw (the plan's start for the first stop, then each stop after the one before it plus the leg between them, never
// before its earliest start), and the minutes of the leg into each stop are filled in, from the places and the mode chosen for the leg (the
// default when none). The first stop has no leg into it. Every write of the stops goes through this, so the stored times are never older than
// the order, the modes and the places stored beside them.
//
// A session cannot cross midnight (its end is after its start), but a plan can: the legs and the lengths of the stops can carry the last
// stops past 24:00. The column holds 0 to 1439, so a stored start is kept to 1439 (23:59), which is a floor and not the time: the true start is
// `starts[i]`, which can be 1440 or more, and it is always worked out again from the plan's start, the lengths and the legs, never read back
// from a stored `planned_start_minute`. (Nothing reads one as the time of a stop after the first: the layout uses it only for the first stop
// of a plan that has no stored start, and a dialog or a screen shows `starts`, not the rows.)
//
// How to call:
//   const { rows: stored, starts } = layoutRows(rows, venueOf, 720) // stored[i].planned_start_minute is starts[i] kept to the day; stored[i].travel_minutes the leg into it
export function layoutRows(rows, venueOf, startAt) {
  const { timed, legs } = timedRows(rows, venueOf, startAt)
  return {
    rows: rows.map((r, i) => {
      const known = i > 0 && pointOf(venueOf, r.venue_id) && pointOf(venueOf, rows[i - 1].venue_id)
      return { ...r, planned_start_minute: Math.min(LAST_MINUTE, timed[i].start), travel_minutes: known ? legs[i - 1].minutes : null }
    }),
    starts: timed.map((t) => t.start),
  }
}

// The same rows without the starts. How to call: laidOutRows(rows, venueOf, 720)
export const laidOutRows = (rows, venueOf, startAt) => layoutRows(rows, venueOf, startAt).rows

// The stop rows a confirm writes, laid out (planned_start_minute is where each stop starts). The voted order gives every stop no earliest
// start. A suggested order puts the stops in the suggested order with its start as each stop's earliest start, so a meal keeps its time and a
// shop waits to open. The plan starts when the first voted stop does.
//
// How to call:
//   confirmedRows(stops, venueOf, { order: [slotId...], starts: { [slotId]: 600 } }) // { rows, starts, planStart }; leave the suggestion out for the voted order
export function confirmedRows(stops, venueOf, suggestion = null) {
  const planStart = stops[0]?.plannedStart ?? null
  const bySlot = new Map(stops.map((s) => [s.slotId, s]))
  const ordered = suggestion ? suggestion.order.map((id) => bySlot.get(id)) : stops
  const rows = ordered.map((s, seq) => ({
    seq,
    slot_id: s.slotId,
    category: s.category,
    venue_id: s.venueId,
    planned_start_minute: s.plannedStart,
    duration_minutes: s.duration,
    travel_mode: null,
    travel_minutes: null,
    // A suggested start can reach past the day; the column cannot, and an earliest start kept to 23:59 still holds the stop back.
    not_before_minute: suggestion ? Math.min(LAST_MINUTE, suggestion.starts[s.slotId]) : null,
  }))
  return { ...layoutRows(rows, venueOf, planStart), planStart }
}

// The stops a confirm would write, as the Confirm dialog draws them: in the order they would be stored, each with the start that would be
// stored for it (the laid-out start, not the slot's or the suggestion's own, and not kept to the day: past midnight it reads 1440 and more,
// as the itinerary draws it). The same rows as confirmedRows, so what the host is shown is what is saved.
//
// How to call:
//   shownStops(stops, venueOf)                                     // the voted order
//   shownStops(stops, venueOf, { order: [slotId...], starts: {} }) // the suggested one
//   // [{ slotId, category: 'eat', venueId: 'ya-kun-kaya-toast', start: 720, duration: 90 }, ...]
export function shownStops(stops, venueOf, suggestion = null) {
  const { rows, starts } = confirmedRows(stops, venueOf, suggestion)
  // The start is the laid-out one, which can pass midnight; the stored column keeps it to 23:59.
  return rows.map((r, i) => ({ slotId: r.slot_id, category: r.category, venueId: r.venue_id, start: starts[i], duration: r.duration_minutes }))
}

// Renumbers rows 0, 1, 2 ... in the order given.
const renumber = (rows) => rows.map((r, seq) => ({ ...r, seq }))

// A stop without the earliest start the order gave it. A stop added from a proposal keeps its own: it says the stop cannot start before the
// moment it was added.
const withoutOrderTime = (row) => (isRoamStop(row) ? row : { ...row, not_before_minute: null })

// The plan's start as it stands: the stored one, else the earliest planned start.
//
// How to call:
//   startOf({ plan_start_minute: 720 }, rows) // 720
export const startOf = (session, rows) => session.plan_start_minute ?? (rows.length ? Math.min(...rows.map((r) => r.planned_start_minute)) : null)

// The stops in the order of `ids` (every stop once). The plan keeps its start; every stop follows the one before it; the travel modes go
// back to their defaults, because the legs are new pairs; a stop's earliest start from the order goes. Answers { rows, planStart }, or null
// when `ids` are not exactly the plan's stops.
//
// How to call:
//   reorderedRows(rows, [idB, idA], session, venueOf)
export function reorderedRows(rows, ids, session, venueOf) {
  const byId = new Map(rows.map((r) => [r.id, r]))
  if (ids.length !== rows.length || new Set(ids).size !== ids.length || ids.some((id) => !byId.has(id))) return null
  const planStart = startOf(session, rows)
  const next = renumber(ids.map((id) => withoutOrderTime({ ...byId.get(id), travel_mode: null })))
  return { rows: laidOutRows(next, venueOf, planStart), planStart }
}

// The plan without one stop. The legs either side merge into one that starts with its default mode; a stop's earliest start from the order
// goes; and when the first stop goes the plan starts the next stop at the time it was voted for (`votedStartOf(slotId)`, null when it is not
// known; the start of the next stop as it was laid out then, if so), or at its own earliest start if it was added from a proposal, so the plan
// does not open with a gap the group never chose. Answers { rows, planStart }, or null when there is no such stop or it is the only one.
//
// How to call:
//   withoutStop(rows, stopId, session, venueOf, (slotId) => 840)
export function withoutStop(rows, stopId, session, venueOf, votedStartOf = () => null) {
  const index = rows.findIndex((r) => r.id === stopId)
  if (index < 0 || rows.length <= 1) return null
  const kept = renumber(rows.filter((_, i) => i !== index).map(withoutOrderTime))
  // The stop now at the removed stop's place arrives by a new leg, which starts with its default mode.
  if (index < kept.length) kept[index] = { ...kept[index], travel_mode: null }
  const first = rows.filter((_, i) => i !== index)[0]
  let planStart = startOf(session, rows)
  if (index === 0) {
    // Where the next stop was laid out (not its stored start, which is kept to the day) is the fallback.
    const laid = timedRows(rows, venueOf, planStart).timed[1].start
    planStart = isRoamStop(first) ? (first.not_before_minute ?? laid) : (votedStartOf(first.slot_id) ?? laid)
  }
  planStart = Math.min(LAST_MINUTE, planStart)
  return { rows: laidOutRows(kept, venueOf, planStart), planStart }
}

// The plan with the mode of the leg into one stop set (null for the default). The first stop has no leg into it, so it is null for that.
// Answers { rows, planStart }, or null when there is no such stop or no leg into it.
//
// How to call:
//   withMode(rows, stopId, 'car', session, venueOf)
export function withMode(rows, stopId, mode, session, venueOf) {
  const index = rows.findIndex((r) => r.id === stopId)
  if (index < 1 || (mode !== null && !TRAVEL_MODES.includes(mode))) return null
  const planStart = startOf(session, rows)
  const next = rows.map((r, i) => (i === index ? { ...r, travel_mode: mode } : r))
  return { rows: laidOutRows(next, venueOf, planStart), planStart }
}

// The plan with one stop holding another place (and, if asked, another kind): the stop keeps its start and length; its earliest start is
// never earlier than `startedAt`, the start the planner checked the place for; the legs either side go back to their default modes.
// Answers { rows, planStart }, or null when there is no such stop.
//
// How to call:
//   withPlace(rows, stopId, { venueId: 'x', category: 'drink', startedAt: 840 }, session, venueOf)
export function withPlace(rows, stopId, { venueId, category, startedAt }, session, venueOf) {
  const index = rows.findIndex((r) => r.id === stopId)
  if (index < 0) return null
  const planStart = startOf(session, rows)
  const next = rows.map((r, i) => {
    if (i === index) return { ...r, venue_id: venueId, category, not_before_minute: Math.max(r.not_before_minute ?? 0, startedAt), travel_mode: null }
    return i === index + 1 ? { ...r, travel_mode: null } : r
  })
  return { rows: laidOutRows(next, venueOf, planStart), planStart }
}

// The plan with a proposed place added as the last stop, in the place's own category, for `duration` minutes. It has no slot and no planned
// time of its own: it may not start before `notBefore`, and its planned start is when the plan ended (or notBefore for a plan with no
// stops). Answers { rows, planStart }.
//
// How to call:
//   withAddedStop(rows, { venueId: 'x', category: 'eat', notBefore: 1000, duration: 60 }, session, venueOf)
export function withAddedStop(rows, { venueId, category, notBefore, duration, endedAt }, session, venueOf) {
  const planStart = rows.length === 0 ? notBefore : startOf(session, rows)
  const next = [
    ...rows,
    {
      seq: rows.length,
      slot_id: null,
      category,
      venue_id: venueId,
      planned_start_minute: Math.min(1439, endedAt ?? notBefore),
      duration_minutes: duration,
      travel_mode: null,
      travel_minutes: null,
      not_before_minute: Math.min(1439, notBefore),
    },
  ]
  return { rows: laidOutRows(next, venueOf, planStart), planStart }
}
