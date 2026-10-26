import { haversineKm, walkMinutes as walkLeg } from './geo.js'

// The timing of a confirmed itinerary, as pure functions: how long each leg between two stops takes by walking, the MRT or a car, which
// mode a leg starts with, and when every stop starts. This is a port of the browser's rules (frontend/src/lib/planner/travel.js and
// itinerary.js), so the server and the screens time a plan the same way; backend/tests/itinerary-port.test.js checks the two against each
// other. The server needs the times for three things the browser cannot be trusted with: the earliest a replaced stop may start, the
// minutes stored on each stop, and the minutes between stops in the ledger of a finished outing.
//
// Points are { lat, lng }. Nothing here reads a database, a clock or an external API.
//
// How to call:
//   const { stops, legs } = buildItinerary([{ venue: a, plannedStart: 720, duration: 90 }, { venue: b, plannedStart: 840, duration: 60 }], ['car'], 720)

// Under this far apart (50 m) two points are "the same place": no time passes between them.
const SAME_PLACE_KM = 0.05

// Streets are not straight lines: add a quarter to the distance.
const DETOUR = 1.25

// The three ways to get from one stop to the next.
export const TRAVEL_MODES = ['walk', 'mrt', 'car']

// Public transport door to door: about 7 minutes to reach the platform and wait, then the ride, slower on long trips (transfers), and
// cross-island trips (over 18 km) need extra changes and feeder buses.
//
// How to call:
//   mrtMinutes({ lat: 1.3, lng: 103.85 }, { lat: 1.35, lng: 103.9 }) // 18
export function mrtMinutes(a, b) {
  const km = haversineKm(a, b)
  if (km < SAME_PLACE_KM) return 0
  return Math.round(7 + 1.8 * km + 0.02 * km * km + Math.max(0, km - 18))
}

// A car (a Grab, a taxi): about 5 minutes to get going, then 27 km/h through traffic.
//
// How to call:
//   carMinutes({ lat: 1.3, lng: 103.85 }, { lat: 1.35, lng: 103.9 }) // 14
export function carMinutes(a, b) {
  const km = haversineKm(a, b)
  if (km < SAME_PLACE_KM) return 0
  return Math.round(5 + km * DETOUR * 2.2)
}

// The three choices between two stops, each with its own time. Walking is the planner's own formula (planner/geo.js), the same as the
// browser's.
//
// How to call:
//   legOptions(a, b) // { walk: 62, mrt: 18, car: 14 }
export function legOptions(a, b) {
  return { walk: walkLeg(a, b), mrt: mrtMinutes(a, b), car: carMinutes(a, b) }
}

// The mode a leg starts with: walk when it is short, otherwise the MRT unless the car saves more than 10 minutes.
//
// How to call:
//   defaultMode({ walk: 62, mrt: 18, car: 14 }) // 'mrt'
export function defaultMode(options) {
  if (options.walk <= 12) return 'walk'
  if (options.mrt <= options.car + 10) return 'mrt'
  return 'car'
}

// Times a list of stops: each starts when the one before it ends plus the leg between them (in the mode chosen for that leg, else the
// default), and never earlier than its own `notBefore`. The first stop starts at `startAt` (else its planned start).
//   stops  [{ venue: { lat, lng }, plannedStart, duration, notBefore? }] in order
//   modes  the mode of each leg: modes[0] is the leg into the second stop; a missing or unknown one is the default
// Answers { stops: [{ ...stop, start, end }], legs: [{ index, options, mode, minutes }] }.
//
// How to call:
//   buildItinerary(stops, [null, 'car'], 600)
export function buildItinerary(stops, modes = [], startAt = null) {
  const legs = []
  const timed = []
  stops.forEach((stop, i) => {
    let start = i === 0 && startAt !== null && startAt !== undefined ? startAt : stop.plannedStart
    if (i > 0) {
      const previous = timed[i - 1]
      const options = legOptions(previous.venue, stop.venue)
      const mode = TRAVEL_MODES.includes(modes[i - 1]) ? modes[i - 1] : defaultMode(options)
      legs.push({ index: i - 1, options, mode, minutes: options[mode] })
      start = previous.end + options[mode]
    }
    if (stop.notBefore !== null && stop.notBefore !== undefined) start = Math.max(start, stop.notBefore)
    timed.push({ ...stop, start, end: start + stop.duration })
  })
  return { stops: timed, legs }
}
