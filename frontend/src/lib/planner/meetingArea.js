// Converge: find the meeting area that is fair for the whole group.
//
// Rules
// - Choose the area that keeps the longest travel time in the group as short as possible, by public transport.
// - If two areas tie, choose the lower total travel time.
// - The result is always a real place people know: candidates are MRT stations and neighbourhoods.
// - If routing is not available, fall back to the geographic centre and say so.
// - Fewer than 2 locations: no meeting area yet.
// - Everyone starts from the same place: the meeting area is that place.
import { centroid, distanceKm, nearest, SAME_PLACE_KM } from './geo.js'
import { transitMinutes } from './travel.js'

export const MIN_LOCATIONS = 2

function timesTo(area, origins, travel) {
  const times = {}
  for (const origin of origins) times[origin.id] = travel(origin, area)
  return times
}

function summarise(area, origins, times, method) {
  const values = origins.map((o) => times[o.id])
  return {
    areaId: area.id,
    method,
    times,
    maxMinutes: Math.max(...values),
    totalMinutes: values.reduce((sum, v) => sum + v, 0),
    count: origins.length,
  }
}

// origins: [{ id, lat, lng }] for each person with a start location.
// candidates: [{ id, name, lat, lng }] real places.
// travel(a, b): minutes by public transport. Pass routing: false when routing is down.
export function chooseMeetingArea({ origins, candidates, travel = transitMinutes, routing = true }) {
  if (!origins || origins.length < MIN_LOCATIONS || !candidates?.length) return null

  // Everyone starts from the same place.
  const first = origins[0]
  if (origins.every((o) => distanceKm(o, first) < SAME_PLACE_KM)) {
    const area = nearest(first, candidates)
    return summarise(area, origins, timesTo(area, origins, travel), 'same')
  }

  // No routing: the geographic centre, snapped to the nearest known place.
  if (!routing) {
    const area = nearest(centroid(origins), candidates)
    return summarise(area, origins, timesTo(area, origins, travel), 'centre')
  }

  let best = null
  for (const area of candidates) {
    const result = summarise(area, origins, timesTo(area, origins, travel), 'fairest')
    if (
      !best ||
      result.maxMinutes < best.result.maxMinutes ||
      (result.maxMinutes === best.result.maxMinutes && result.totalMinutes < best.result.totalMinutes)
    ) {
      best = { area, result }
    }
  }
  return best.result
}

// The group can override the fairest area with one they agree on.
// Same shape as chooseMeetingArea, with method 'chosen' and the travel times to that area.
export function meetingAt({ origins, area, travel = transitMinutes }) {
  if (!origins || origins.length < MIN_LOCATIONS || !area) return null
  return summarise(area, origins, timesTo(area, origins, travel), 'chosen')
}

// Every candidate ranked by the fairness rule (longest trip, then total), for choosing another area.
export function rankAreas({ origins, candidates, travel = transitMinutes }) {
  if (!origins || origins.length < MIN_LOCATIONS) return []
  return candidates
    .map((area) => {
      const r = summarise(area, origins, timesTo(area, origins, travel), 'fairest')
      return { areaId: area.id, maxMinutes: r.maxMinutes, totalMinutes: r.totalMinutes }
    })
    .sort((a, b) => a.maxMinutes - b.maxMinutes || a.totalMinutes - b.totalMinutes)
}

// A one-line summary of a meeting result.
export function meetingResultLine(result, areaName) {
  if (!result) return ''
  const people = `${result.count} ${result.count === 1 ? 'person' : 'people'}`
  if (result.method === 'same') return `Fairest for ${people}: everyone starts from ${areaName}.`
  if (result.method === 'centre') {
    return `Routing is unavailable, so ${areaName} is the geographic centre for ${people}. The longest trip is about ${result.maxMinutes} minutes.`
  }
  return `Fairest for ${people}: nobody travels more than ${result.maxMinutes} minutes.`
}
