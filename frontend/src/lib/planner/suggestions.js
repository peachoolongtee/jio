// Diverge, part 2: suggest places for each slot, near the meeting area.
//
// Rules
// - Only places of the slot's category, open for the whole slot, and fitting its meal window.
// - The last stop must be within a 10 minute walk of an MRT station, and is ranked by how long
//   everyone takes to get to their end location.
// - Crowd lowers a place in the ranking. It never hides a place.
// - When it rains, outdoor places get a warning, drop in the ranking and come with an indoor swap.
// - Search near the meeting area first. If fewer than 3 places fit, widen the search once.
//   If nothing fits after that, the slot has nothing nearby.
import { distanceKm } from './geo.js'
import { fitsMealWindow, isOpenDuring } from './timeOfDay.js'
import { crowdLevel, CROWD_PENALTY } from './crowd.js'
import { transitMinutes, walkMinutes } from './travel.js'
import { fromMinutes } from './format.js'

export const SEARCH_RADIUS_KM = 1.2
export const WIDE_RADIUS_KM = 2.4
export const LAST_STOP_MRT_WALK = 10
export const OPTIONS_START = 3
export const OPTIONS_MAX = 6
const RAIN_PENALTY = 2.5

// Why a venue cannot be suggested for a slot, or '' when it can.
export function unfitReason(venue, slot, { isLast = false } = {}) {
  if (venue.category !== slot.category) return 'category'
  if (!isOpenDuring(venue, slot.start, slot.start + slot.duration)) return 'closed'
  if (!fitsMealWindow(venue, slot.start, slot.category)) return 'meal'
  if (isLast && venue.mrtWalk > LAST_STOP_MRT_WALK) return 'mrt'
  return ''
}

// Score one venue for one slot. Higher is better.
export function scoreVenue(venue, { slot, area, isLast = false, conditions = {}, homes = [], travel = transitMinutes }) {
  const walk = walkMinutes(area, venue)
  const crowd = crowdLevel(venue, slot.start, { boost: !!conditions.crowd })
  const rainHit = !!conditions.rain && !venue.indoor
  const homeTimes = isLast ? homes.map((h) => ({ id: h.id, name: h.name, minutes: travel(venue, h) })) : []
  const homeAverage = homeTimes.length ? homeTimes.reduce((s, h) => s + h.minutes, 0) / homeTimes.length : 0
  const homeMax = homeTimes.length ? Math.max(...homeTimes.map((h) => h.minutes)) : 0

  let score = venue.rating
  score -= 0.08 * walk
  score -= CROWD_PENALTY[crowd]
  if (rainHit) score -= RAIN_PENALTY
  if (isLast) score -= 0.05 * homeAverage

  const reasons = []
  if (conditions.rain && venue.indoor) reasons.push('Indoor')
  if (isLast && homeTimes.length && homeMax <= 35) reasons.push('Easy trip home')
  if (venue.mrtWalk <= 5) reasons.push('Near MRT')
  if (crowd === 'quiet') reasons.push(`Quiet at ${fromMinutes(slot.start)}`)
  if (walk <= 5) reasons.push('Short walk')
  if ((venue.tags || []).includes('hidden')) reasons.push('Hidden gem')
  if (venue.price < 10) reasons.push('Budget friendly')

  const warnings = rainHit ? ['rain'] : []
  return { score: Math.round(score * 100) / 100, walk, crowd, reasons: reasons.slice(0, 2), warnings, homeMax }
}

// All venues that fit the slot, ranked, with the search widened once if needed.
// Returns { options: [{ venue, score, walk, crowd, reasons, warnings }], widened, radiusKm }.
export function rankForSlot(venues, ctx) {
  const fitting = venues.filter((v) => !unfitReason(v, ctx.slot, ctx))
  let radiusKm = SEARCH_RADIUS_KM
  let near = fitting.filter((v) => distanceKm(ctx.area, v) <= radiusKm)
  let widened = false
  if (near.length < OPTIONS_START) {
    widened = true
    radiusKm = WIDE_RADIUS_KM
    near = fitting.filter((v) => distanceKm(ctx.area, v) <= radiusKm)
  }
  const options = near
    .map((venue) => ({ venue, ...scoreVenue(venue, ctx) }))
    .sort((a, b) => b.score - a.score || a.venue.name.localeCompare(b.venue.name))
  return { options, widened, radiusKm }
}

// Keep the options people are already voting on while they still fit, and top up to three
// from the ranking. Never more than six.
export function reconcileOptions(currentIds, rankedIds, { start = OPTIONS_START, max = OPTIONS_MAX } = {}) {
  const valid = new Set(rankedIds)
  const kept = (currentIds || []).filter((id) => valid.has(id)).slice(0, max)
  for (const id of rankedIds) {
    if (kept.length >= start) break
    if (!kept.includes(id)) kept.push(id)
  }
  return kept
}

// "More suggestions": add the next best places, up to six in the slot.
export function moreOptions(currentIds, rankedIds, { add = 3, max = OPTIONS_MAX } = {}) {
  const next = [...currentIds]
  for (const id of rankedIds) {
    if (next.length >= Math.min(max, currentIds.length + add)) break
    if (!next.includes(id)) next.push(id)
  }
  return next
}

// For an outdoor option in the rain: the best indoor place for the same slot that is not already an option.
export function indoorSwap(ranked, currentIds) {
  return ranked.find((o) => o.venue.indoor && !currentIds.includes(o.venue.id)) || null
}
