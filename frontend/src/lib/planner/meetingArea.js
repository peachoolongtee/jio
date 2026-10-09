// Converge: the meeting area that is fair for the whole group.
//
// The backend planner chooses it (POST /api/meeting-area, called from lib/api.js): the area that keeps the
// longest trip in the group as short as possible, always a real MRT station or neighbourhood, or the geographic
// centre when routing is off. This file holds what the screens need around it.
//
// Rules
// - Fewer than 2 locations: no meeting area yet. (api.js also waits for everyone while the group is still sharing.)
// - Everyone starts from the same place: the meeting area is that place.

export const MIN_LOCATIONS = 2

// The one result line under the map.
// result: { method: 'same' | 'centre' | 'fairest', maxMinutes, count }.
export function meetingResultLine(result, areaName) {
  if (!result) return ''
  const people = `${result.count} ${result.count === 1 ? 'person' : 'people'}`
  if (result.method === 'same') return `Fairest for ${people}: everyone starts from ${areaName}.`
  if (result.method === 'centre') {
    return `Routing is unavailable, so ${areaName} is the geographic centre for ${people}. The longest trip is about ${result.maxMinutes} minutes.`
  }
  return `Fairest for ${people}: nobody travels more than about ${result.maxMinutes} minutes.`
}
