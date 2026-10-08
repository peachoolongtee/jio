// The itinerary: stops in order, the travel between them, the end point and each person's trip home.
//
// - Each leg offers Walk, MRT and Car, each with its own time. The chosen mode sets when the next stop starts,
//   so changing it moves every later stop.
// - If anyone's trip home is over 60 minutes, the itinerary warns with that person's name.
// - Stops can be rearranged. The plan keeps its start time; each stop follows the one before it, and a stop that
//   would be closed at its new time is flagged (never silently kept as if it were fine).
import { legOptions, transitMinutes, defaultMode } from './travel.js'
import { toMinutes } from './format.js'

export const LONG_TRIP_MINUTES = 60

// The last stop should be this close to an MRT station (minutes on foot), so everyone can get home.
export const LAST_STOP_MRT_WALK = 10

// Is the venue open for the whole of [start, end) (minutes after midnight)? Hours are strings such as
// "07:30-20:00"; a closing time before the opening time runs past midnight. A venue with no hours listed
// (most CDC sites) counts as open: there is nothing to warn about.
export function isOpenDuring(venue, start, end) {
  const hours = venue.hours || []
  if (!hours.length) return true
  return hours.some((text) => {
    const [open, rawClose] = text.split('-').map(toMinutes)
    const close = rawClose <= open ? rawClose + 1440 : rawClose
    // Try the stop as it is, and shifted by a day for places that open late and close after midnight.
    return [0, 1440].some((shift) => start + shift >= open && end + shift <= close)
  })
}

// stops: [{ venue, plannedStart, duration }] in order. modes: ['walk' | 'mrt' | 'car'] per leg, or empty for defaults.
// startAt: when the plan starts (minutes). Defaults to the first stop's planned start.
// Each timed stop says whether the place is open for its whole time (`open`).
export function buildItinerary(stops, modes = [], startAt = null) {
  const legs = []
  const timed = []
  stops.forEach((stop, i) => {
    let start = i === 0 && startAt != null ? startAt : stop.plannedStart
    if (i > 0) {
      const prev = timed[i - 1]
      const options = legOptions(prev.venue, stop.venue)
      // A mode this version does not offer (a plan saved with "grab") falls back to the default.
      const mode = modes[i - 1] in options ? modes[i - 1] : defaultMode(options)
      legs.push({ index: i - 1, options, mode, minutes: options[mode] })
      start = prev.end + options[mode]
    }
    timed.push({ ...stop, start, end: start + stop.duration, open: isOpenDuring(stop.venue, start, start + stop.duration) })
  })
  return { stops: timed, legs }
}

// Move one item of a list to another position, for rearranging stops. Returns a new array.
export function moveItem(list, from, to) {
  const next = [...list]
  const [item] = next.splice(from, 1)
  next.splice(Math.max(0, Math.min(to, next.length)), 0, item)
  return next
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
  // After rearranging, the last stop may no longer be near an MRT station: say so.
  return { name: lastVenue.name, mrt: lastVenue.mrt, mrtWalk: lastVenue.mrtWalk, farFromMrt: lastVenue.mrtWalk > LAST_STOP_MRT_WALK }
}
