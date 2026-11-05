import { haversineKm, mockTravelMinutes } from '../planner/geo.js'
import { MAX } from '../routes/plan-schemas.js'

// The rules of the meeting spots, as pure functions: rows in, rows out. No database, no planner call, no clock. The service
// (services/sessions.js) loads the rows, calls these, and writes what they return through apply_session_plan.
//
// A "spot" is an area the group is choosing between while a session is locating. The app lists up to three (rank 1 to 3, the
// fairest first) and members suggest more (rank null). Every figure comes from the centres of areas, never from an exact place:
// a member's start is the centre of their start area, so a spot's minutes say nothing about where in that area they are.
//
// Row shapes used below (the column names of the tables):
//   member      { user_id, role, state, start_area_id, end_area_id }
//   spot        { area_id, rank, worst_minutes, mean_minutes, travel_minutes: { <user id>: minutes }, approximate }
//   suggestion  { user_id, area_id, here, created_at }
//   approval    { area_id, user_id }

// The app lists this many spots: the chosen area and its runners-up. The engine's `alternatives` is one less (runners-up).
export const APP_SPOTS = 3

// A spot needs this many members with a start. Fewer than two and there is nothing to be fair about.
export const MIN_STARTS = 2

// The rule the meeting spots are ranked by: the planner's default, "longest". The place where the longest trip is shortest wins, and a person's
// past travel (their debt) only breaks an exact tie on that trip (planner/engine.js, meetingArea). The spots' input says it outright so the line
// that tells a person their past travel was counted (services/session-lean.js) names the rule that is really in use.
export const SPOT_RULE = 'longest'

// Starts closer than this are "the same place" (50 m, as the browser's planner counts it). Area centres of different areas never are.
const SAME_PLACE_KM = 0.05

// The most minutes the database allows in a figure (session_spots has a check on it).
const MAX_MINUTES = 1440

// A member id the way Postgres prints it, so the keys of a spot's minutes match the database's check on them.
//
// How to call:
//   lower('1111111A-1111-4111-8111-11111111111B') // '1111111a-1111-4111-8111-11111111111b'
export const lower = (id) => String(id).toLowerCase()

// A figure in minutes, kept inside what the database accepts. A number that is not finite becomes the largest allowed.
//
// How to call:
//   clampMinutes(24.6) // 24.6
const clampMinutes = (minutes) => (Number.isFinite(minutes) ? Math.min(MAX_MINUTES, Math.max(0, minutes)) : MAX_MINUTES)

// The joined members who can be planned for, as the engine wants them, and the joined members who cannot yet.
// A member can be planned for when their start area is one the planner knows. Their end is their end area when that is known,
// else their start. A joined member without a known start area is "skipped": they are told apart so the screen can ask them.
//
// `debts` (optional, a Map of lower-case user id to minutes) is each person's travel debt from their other outings; it goes to the planner
// as `travelDebtMinutes`, so the meeting area leans towards whoever has travelled more than their share. Left out, nobody has a debt.
//
// How to call:
//   const { located, skipped } = locatedMembers(members, areasById) // located: [{ id, name, start, end }], skipped: [userId]
//   const { located } = locatedMembers(members, areasById, new Map([[userId, 12.5]])) // located[0].travelDebtMinutes is 12.5
export function locatedMembers(members, areasById, debts = null) {
  const located = []
  const skipped = []
  for (const m of members) {
    if (m.state !== 'joined') continue
    const id = lower(m.user_id)
    const home = areasById.get(m.start_area_id)
    if (!home) {
      skipped.push(id)
      continue
    }
    const away = areasById.get(m.end_area_id) ?? home
    // `start` and `end` are bare points: the engine tells a member's point from an area by the area carrying an `id`.
    located.push({ id, name: id, start: { lat: home.lat, lng: home.lng }, end: { lat: away.lat, lng: away.lng }, ...(debts?.has(id) && { travelDebtMinutes: debts.get(id) }) })
  }
  return { located, skipped }
}

// When a suggestion was made, in milliseconds (0 when the time is missing or unreadable), and the order suggestions come in:
// oldest first, then by who made them, so the order never depends on the order rows were read.
//
// How to call:
//   [...suggestions].sort(byAge)
const ageOf = (s) => Date.parse(s.created_at) || 0
const byAge = (a, b) => ageOf(a) - ageOf(b) || lower(a.user_id).localeCompare(lower(b.user_id))

// The areas members suggested, once each, oldest suggestion first: they go in the planner's `include`. Only suggestions of
// joined members count, only for areas the planner knows, and at most MAX.suggestedSpots of them.
//
// How to call:
//   suggestedAreaIds(suggestions, members, areasById) // ['bugis', 'orchard']
export function suggestedAreaIds(suggestions, members, areasById) {
  const joined = new Set(members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id)))
  const ids = [...suggestions]
    .filter((s) => joined.has(lower(s.user_id)) && areasById.has(s.area_id))
    .sort(byAge)
    .map((s) => s.area_id)
  return [...new Set(ids)].slice(0, MAX.suggestedSpots)
}

// Whether a figure is to be shown as "about": its trips used the straight-line estimate (`approximate`), or the table of times between the
// areas, with no live route (`travelSource: 'table'`, services/travel-times.js table mode). The stored `approximate` columns mean this, because
// they have no third state. A planner answer's own `approximate` stays about the straight line alone.
//
// How to call:
//   isAbout({ approximate: false, travelSource: 'table' }) // true
export const isAbout = (x) => !!x?.approximate || x?.travelSource === 'table'

// The planner's answer for the spots as the rows to store. The chosen area and its runners-up get rank 1, 2 and 3; an area
// that is on the list only because a member suggested it has no rank. Minutes are kept unrounded (the screens round them, but the
// tie-break between spots compares the longest trip exactly). A figure is approximate when its own trips used an estimate,
// or when the whole answer is the planner's estimate (no routing at all), as the browser's planner marks it.
//
// How to call:
//   spotRowsFrom(result, travel) // [{ area_id: 'bishan', rank: 1, worst_minutes: 30.4, mean_minutes: 25.2, travel_minutes: { ... }, approximate: false }]
export function spotRowsFrom(result, travel) {
  const estimated = travel?.source === 'estimate'
  const candidates = result.candidates ?? []
  let rank = 0
  return candidates.map((c) => {
    const worst = clampMinutes(c.worstMinutes)
    return {
      area_id: c.area.id,
      rank: c.source === 'included' ? null : (rank += 1),
      worst_minutes: worst,
      mean_minutes: Math.min(worst, clampMinutes(c.meanMinutes)),
      travel_minutes: Object.fromEntries(Object.entries(c.travelByMember).map(([id, minutes]) => [lower(id), clampMinutes(minutes)])),
      approximate: isAbout(c) || estimated,
    }
  })
}

// The rows that stay when no planner run is needed: the app's spots as they are stored, and every area a member suggests that
// is already stored. Used when a suggestion is taken back or moved to an area that is already listed.
//
// How to call:
//   relistedRows(storedSpots, ['bugis']) // the stored rows with a rank, plus the stored 'bugis' row
export function relistedRows(stored, suggestedIds) {
  const wanted = new Set(suggestedIds)
  return stored.filter((s) => s.rank != null || wanted.has(s.area_id))
}

// The spots in the order the group sees them: the app's by rank, then the members' by who suggested first.
//
// How to call:
//   orderedSpots(spots, suggestions) // the same rows, ranked first
export function orderedSpots(spots, suggestions) {
  const firstSuggested = new Map()
  for (const s of [...suggestions].sort(byAge)) if (!firstSuggested.has(s.area_id)) firstSuggested.set(s.area_id, ageOf(s))
  const rankOf = (spot) => spot.rank ?? Infinity
  return [...spots].sort(
    (a, b) =>
      rankOf(a) - rankOf(b) ||
      (firstSuggested.get(a.area_id) ?? Infinity) - (firstSuggested.get(b.area_id) ?? Infinity) ||
      a.area_id.localeCompare(b.area_id),
  )
}

// How many joined members said a spot works for them. Opting out removes a member's approvals, but only joined members count
// here all the same.
//
// How to call:
//   approvalCount(approvals, 'bugis', members) // 2
export function approvalCount(approvals, areaId, members) {
  const joined = new Set(members.filter((m) => m.state === 'joined').map((m) => lower(m.user_id)))
  return approvals.filter((a) => a.area_id === areaId && joined.has(lower(a.user_id))).length
}

// The spot the host is offered: the most approved. A tie goes to the shorter longest trip (exactly, not as rounded), then to the
// list's own order. With nobody's approval it is the first of the list, the planner's own pick. Null when no spot is listed.
//
// How to call:
//   preselectedSpot(orderedSpots(spots, suggestions), approvals, members) // a spot row, or null
export function preselectedSpot(list, approvals, members) {
  if (list.length === 0) return null
  const counts = list.map((s) => approvalCount(approvals, s.area_id, members))
  const most = Math.max(0, ...counts)
  if (most === 0) return list[0]
  return list.filter((_, i) => counts[i] === most).reduce((best, s) => (Number(s.worst_minutes) < Number(best.worst_minutes) ? s : best))
}

// How the planner's own pick is described: 'same' when everyone starts together, else 'fairest'. (The browser also has 'centre', for
// when routing is off; the server never writes it.)
//
// How to call:
//   plannerMethod(located) // 'fairest'
export function plannerMethod(located) {
  if (located.length === 0) return 'fairest'
  return located.every((m) => haversineKm(m.start, located[0].start) < SAME_PLACE_KM) ? 'same' : 'fairest'
}

// How a confirmed spot is described: 'voted' when anyone approved it; the planner's own method when nobody did and it is the
// app's first suggestion (rank 1); otherwise 'chosen' (the host picked it).
//
// How to call:
//   methodFor(spot, approvals, members, located) // 'voted' | 'same' | 'fairest' | 'chosen'
export function methodFor(spot, approvals, members, located) {
  if (approvalCount(approvals, spot.area_id, members) > 0) return 'voted'
  return spot.rank === 1 ? plannerMethod(located) : 'chosen'
}

// The meeting area's columns for a confirmed spot, from the spot's stored figures: the longest trip and the group's total, in the
// rounded minutes the screens show, how many travel times there are, and each member's rounded minutes (which become their
// session_members.travel_minutes). A spot with no times (nobody had shared a start) has zeros.
//
// How to call:
//   meetingAtSpot(spot, 'voted') // { area_id, method, max_minutes, total_minutes, count, approximate, travel }
export function meetingAtSpot(spot, method) {
  const travel = Object.fromEntries(Object.entries(spot.travel_minutes ?? {}).map(([id, minutes]) => [id, Math.round(minutes)]))
  const minutes = Object.values(travel)
  return {
    area_id: spot.area_id,
    method,
    max_minutes: minutes.length ? Math.max(...minutes) : 0,
    total_minutes: minutes.reduce((sum, m) => sum + m, 0),
    count: minutes.length,
    approximate: !!spot.approximate,
    travel,
  }
}

// The areas whose approvals a new list takes with it: stored areas that are not in the new list and that someone approved.
//
// How to call:
//   lostApprovalAreas(storedSpots, newRows, approvals) // ['orchard']
export function lostApprovalAreas(stored, next, approvals) {
  const kept = new Set(next.map((r) => r.area_id))
  const gone = stored.filter((s) => !kept.has(s.area_id)).map((s) => s.area_id)
  return [...new Set(approvals.filter((a) => gone.includes(a.area_id)).map((a) => a.area_id))]
}

// The sentence for approvals that went with a spot.
//
// How to call:
//   lostApprovalsNote(['orchard'], 'Orchard') // 'Orchard is no longer on the list, so approvals for it were removed.'
export function lostApprovalsNote(areaIds, nameOf) {
  const names = areaIds.map((id) => nameOf(id) ?? id)
  const one = names.length === 1
  const joined = one ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`
  return `${joined} ${one ? 'is' : 'are'} no longer on the list, so approvals for ${one ? 'it' : 'them'} were removed.`
}

// What the group is told when approvals were removed: why the list changed, then which spots left it.
//
// How to call:
//   lostApprovalsBannerText("Jonathan's start location changed.", ['orchard'], (id) => 'Orchard')
export const lostApprovalsBannerText = (reason, areaIds, nameOf) => `${reason} ${lostApprovalsNote(areaIds, nameOf)}`

// What changed, as a clause that follows "because" or starts a sentence: "Ian's start location changed". No capital, no full stop.
//
// How to call:
//   triggerText('start', 'Ian') // "Ian's start location changed"
export function triggerText(kind, name) {
  return kind === 'start' ? `${name}'s start location changed`
    : kind === 'end' ? `${name}'s end location changed`
    : kind === 'added' ? `${name} added a start location`
    : kind === 'optout' ? `${name} opted out`
    : kind === 'rejoin' ? `${name} rejoined`
    : kind === 'left' ? `${name} left`
    : kind === 'removed' ? `${name} was removed`
    : kind === 'suggested' ? `${name} suggested a different spot`
    : kind === 'withdrew' ? `${name} withdrew their suggestion`
    : kind === 'replan' ? 'the plan was opened again'
    : 'The group changed'
}

// The reason a recompute gives for the notice, by what changed.
//
// How to call:
//   describeChange('start', 'Ian') // "Ian's start location changed."
export function describeChange(kind, name) {
  const text = triggerText(kind, name)
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}

// The notice a voting session shows when a start or end moved the meeting area, or left it where it was with new travel times
// (the browser's recalcBanner). `previousName` and `nextName` are area names, or null when there is no meeting area (nobody had
// shared where they start, so voting is paused).
//
// How to call:
//   meetingBannerText({ previousName: 'Bugis', nextName: 'Orchard', kind: 'start', name: 'Ian' })
//   // "Meeting area moved from Bugis to Orchard because Ian's start location changed."
export function meetingBannerText({ previousName, nextName, kind, name }) {
  const reason = triggerText(kind, name)
  if (previousName && nextName && previousName !== nextName) return `Meeting area moved from ${previousName} to ${nextName} because ${reason}.`
  if (previousName && nextName) return `Meeting area stays at ${previousName}. ${reason.charAt(0).toUpperCase()}${reason.slice(1)}.`
  if (!previousName && nextName) return `Meeting area set to ${nextName} because ${reason}.`
  if (previousName && !nextName) return `Meeting area cleared because ${reason}. It comes back once everyone has shared where they start.`
  return describeChange(kind, name)
}

// The notice the group reads when the host changed the meeting place: it names the host (and nobody else) and says what went, in plain words.
// `status` is what the session was (voting or confirmed), `hadVotes` whether anyone had voted, `placeName` the new area when the host named it.
//
// How to call:
//   releasedBannerText({ hostName: 'Ian', status: 'confirmed', hadVotes: true })
//   // "Ian changed the meeting place, so the votes and the plan were cleared."
//   releasedBannerText({ hostName: 'Ian', status: 'voting', hadVotes: false, placeName: 'Bugis' })
//   // "Ian changed the meeting place to Bugis, so the places to vote on were chosen again."
//   releasedBannerText({ hostName: 'Ian', status: 'voting', hadVotes: false })
//   // "Ian changed the meeting place, so the places to vote on were cleared."
export function releasedBannerText({ hostName, status, hadVotes, placeName = null }) {
  // With no votes there is nothing to say about them: the places to vote on were cleared, and with a named area they are chosen again there.
  const gone = status === 'confirmed' ? 'the votes and the plan were cleared' : hadVotes ? 'the votes were cleared' : placeName ? 'the places to vote on were chosen again' : 'the places to vote on were cleared'
  return `${hostName} changed the meeting place${placeName ? ` to ${placeName}` : ''}, so ${gone}.`
}

// The engine's work for pricing one area, for a host's "we already have a place". It asks the engine's travel function for each
// member's trip from their start to the area centre, and falls back to the estimate (marking the result approximate) where there
// is no real time, exactly as the engine does. The estimate is the one the travel layer hands in (`deps.estimateMinutes`, the table
// of times between areas when the server has one), so a known place and a listed spot price the same trip the same way.
// The area carries an `id` and the starts do not, so the travel-time layer (services/travel-times.js) sees one candidate: all of this area's trips, routed together or not at all.
//
// How to call (through the shared runs, so the OneMap cap and budget apply):
//   await runs.runWithTravel({ members, area: { id, lat, lng } }, data, priceAreaRun)
//   // result: { travelByMember: { <user id>: minutes }, approximate: false, travelSource: 'routed' | 'table' (in table mode) }
export function priceAreaRun(input, _data, deps = {}) {
  const estimate = deps.estimateMinutes ?? mockTravelMinutes
  const ask = deps.travelMinutes ?? estimate
  let approximate = false
  const kinds = new Set() // where the times came from, when the travel layer says (deps.travelSource)
  const travelByMember = {}
  for (const m of input.members) {
    const minutes = ask(m.start, input.area)
    if (Number.isFinite(minutes) && minutes >= 0) {
      travelByMember[m.id] = minutes
      if (deps.travelSource) kinds.add(deps.travelSource(m.start, input.area))
    } else {
      approximate = true
      kinds.add('estimate')
      travelByMember[m.id] = estimate(m.start, input.area)
    }
  }
  return { travelByMember, approximate, ...(deps.travelSource && { travelSource: kinds.has('table') ? 'table' : 'routed' }) }
}

// One priced area as the row to store, for the host's known place. With nobody located there are no trips, so the figures are zero.
//
// How to call:
//   knownPlaceRow('bugis', priced, travel) // { area_id: 'bugis', rank: null, worst_minutes: 31.2, ... }
export function knownPlaceRow(areaId, priced, travel) {
  const minutes = Object.entries(priced?.travelByMember ?? {}).map(([id, m]) => [lower(id), clampMinutes(m)])
  const values = minutes.map(([, m]) => m)
  const worst = values.length ? Math.max(...values) : 0
  return {
    area_id: areaId,
    rank: null,
    worst_minutes: worst,
    mean_minutes: values.length ? Math.min(worst, values.reduce((s, m) => s + m, 0) / values.length) : 0,
    travel_minutes: Object.fromEntries(minutes),
    approximate: isAbout(priced) || (values.length > 0 && travel?.source === 'estimate'),
  }
}
