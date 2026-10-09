// The itinerary: stops in order, the travel between them, the end point and each person's trip home.
//
// - Each leg offers Walk, MRT and Car, each with its own time. The chosen mode sets when the next stop starts,
//   so changing it moves every later stop.
// - If anyone's trip home is over 60 minutes, the itinerary warns with that person's name.
import { legOptions, transitMinutes, defaultMode } from './travel.js'

export const LONG_TRIP_MINUTES = 60

// stops: [{ venue, plannedStart, duration }] in order. modes: ['walk' | 'mrt' | 'car'] per leg, or empty for defaults.
export function buildItinerary(stops, modes = []) {
  const legs = []
  const timed = []
  stops.forEach((stop, i) => {
    let start = stop.plannedStart
    if (i > 0) {
      const prev = timed[i - 1]
      const options = legOptions(prev.venue, stop.venue)
      // A mode this version does not offer (a plan saved with "grab") falls back to the default.
      const mode = modes[i - 1] in options ? modes[i - 1] : defaultMode(options)
      legs.push({ index: i - 1, options, mode, minutes: options[mode] })
      start = prev.end + options[mode]
    }
    timed.push({ ...stop, start, end: start + stop.duration })
  })
  return { stops: timed, legs }
}

// people: [{ id, name, end: { lat, lng, name } }]
export function tripsHome(lastVenue, people, travel = transitMinutes) {
  if (!lastVenue) return []
  return people.map((p) => {
    const minutes = travel(lastVenue, p.end)
    return { id: p.id, name: p.name, place: p.end.name, minutes, long: minutes > LONG_TRIP_MINUTES }
  })
}

// The end point of the plan: the last stop and its MRT station.
export function endPoint(lastVenue) {
  if (!lastVenue) return null
  return { name: lastVenue.name, mrt: lastVenue.mrt, mrtWalk: lastVenue.mrtWalk }
}
