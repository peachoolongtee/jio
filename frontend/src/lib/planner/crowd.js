// Crowd: each suggestion has an estimated crowd level for its slot: Quiet, Moderate or Busy.
// Crowd lowers a place in the ranking. It never hides a place. It is always labelled as an estimate.

// How busy each kind of place is through the day, from 0 to 1, by hour.
const PROFILES = {
  hawker: { 7: 0.5, 8: 0.6, 11: 0.8, 12: 1, 13: 0.9, 14: 0.5, 15: 0.3, 16: 0.3, 17: 0.5, 18: 0.9, 19: 1, 20: 0.7, 21: 0.4 },
  restaurant: { 11: 0.5, 12: 0.9, 13: 0.8, 14: 0.4, 15: 0.2, 16: 0.2, 17: 0.4, 18: 0.8, 19: 1, 20: 0.8, 21: 0.5 },
  cafe: { 8: 0.5, 9: 0.6, 10: 0.7, 11: 0.8, 12: 0.8, 13: 0.9, 14: 1, 15: 1, 16: 0.9, 17: 0.6, 18: 0.4, 19: 0.3 },
  dessert: { 13: 0.5, 14: 0.7, 15: 0.9, 16: 0.9, 17: 0.6, 18: 0.5, 19: 0.7, 20: 0.9, 21: 1, 22: 0.8 },
  bar: { 17: 0.3, 18: 0.5, 19: 0.6, 20: 0.8, 21: 1, 22: 1, 23: 0.8 },
  mall: { 10: 0.3, 11: 0.4, 12: 0.6, 13: 0.7, 14: 0.8, 15: 0.9, 16: 0.9, 17: 0.9, 18: 1, 19: 1, 20: 0.8, 21: 0.5 },
  market: { 11: 0.4, 12: 0.6, 13: 0.7, 14: 0.8, 15: 0.9, 16: 0.9, 17: 0.9, 18: 1, 19: 1, 20: 0.8, 21: 0.6 },
  park: { 7: 0.6, 8: 0.5, 9: 0.4, 10: 0.3, 15: 0.3, 16: 0.5, 17: 0.8, 18: 1, 19: 0.8, 20: 0.4 },
  museum: { 10: 0.4, 11: 0.6, 12: 0.7, 13: 0.8, 14: 1, 15: 1, 16: 0.9, 17: 0.6, 18: 0.4 },
  cinema: { 11: 0.2, 13: 0.4, 15: 0.5, 17: 0.6, 19: 0.9, 20: 1, 21: 1, 22: 0.7 },
  library: { 10: 0.4, 11: 0.5, 14: 0.8, 15: 0.9, 16: 0.9, 17: 0.7, 19: 0.5, 20: 0.3 },
  sports: { 7: 0.7, 8: 0.6, 9: 0.5, 15: 0.5, 16: 0.7, 17: 0.9, 18: 1, 19: 0.9, 20: 0.6 },
  attraction: { 9: 0.4, 10: 0.6, 11: 0.8, 12: 0.8, 13: 0.9, 14: 1, 15: 1, 16: 0.9, 17: 0.7, 18: 0.5 },
}

function profileAt(kind, hour) {
  const profile = PROFILES[kind] || PROFILES.mall
  if (hour in profile) return profile[hour]
  // Between listed hours, use the nearest earlier hour; before the first, assume it is quiet.
  const earlier = Object.keys(profile).map(Number).filter((h) => h < hour)
  return earlier.length ? profile[Math.max(...earlier)] * 0.8 : 0.2
}

// A number from 0 to about 1.4. `boost` is the "Simulate crowd" demo switch.
export function crowdScore(venue, minute, { boost = false } = {}) {
  const hour = Math.floor((((minute % 1440) + 1440) % 1440) / 60)
  const base = (venue.popularity ?? 0.5) * profileAt(venue.kind, hour)
  return base + (boost ? 0.4 : 0)
}

export function crowdLevel(venue, minute, options) {
  const score = crowdScore(venue, minute, options)
  if (score < 0.4) return 'quiet'
  if (score < 0.7) return 'moderate'
  return 'busy'
}

// 'unknown': the planner has no crowd profile for the place (most CDC and mock venues).
export const CROWD_LABELS = { quiet: 'Quiet', moderate: 'Moderate', busy: 'Busy', unknown: 'Crowd unknown' }

// The InfoTag tone for each level, the same colours as the map's heat layer. Unknown stays neutral.
const CROWD_TONES = { quiet: 'good', moderate: 'middle', busy: 'error' }
export function crowdTone(level) {
  return CROWD_TONES[level] || 'neutral'
}

// Always written as an estimate, unless there is nothing to estimate.
export function crowdText(level) {
  if (!(level in CROWD_LABELS) || level === 'unknown') return CROWD_LABELS.unknown
  return `${CROWD_LABELS[level]} · est.`
}
