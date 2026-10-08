// Travel time estimates. These stand in for OneMap routing until the backend exists.
// Every function takes two points ({ lat, lng }) and returns whole minutes.
import { distanceKm, SAME_PLACE_KM } from './geo.js'

// Streets are not straight lines: add a quarter to the distance.
const DETOUR = 1.25

// Walking at 5 km/h.
export function walkMinutes(a, b) {
  const km = distanceKm(a, b)
  if (km < SAME_PLACE_KM) return 0
  return Math.max(1, Math.round(km * DETOUR * 12))
}

// MRT and bus, door to door: about 7 minutes to reach the platform and wait, then the ride.
// The ride slows a little on long trips because of transfers, and cross-island trips (over 18 km)
// need extra changes and feeder buses.
export function mrtMinutes(a, b) {
  const km = distanceKm(a, b)
  if (km < SAME_PLACE_KM) return 0
  return Math.round(7 + 1.8 * km + 0.02 * km * km + Math.max(0, km - 18))
}

// Public transport for one person: whichever is faster of walking or the MRT.
export function transitMinutes(a, b) {
  return Math.min(walkMinutes(a, b), mrtMinutes(a, b))
}

// Car (a Grab, a taxi or driving yourself): about 5 minutes to get going (a pick-up, or finding parking),
// then 27 km/h through traffic.
export function carMinutes(a, b) {
  const km = distanceKm(a, b)
  if (km < SAME_PLACE_KM) return 0
  return Math.round(5 + km * DETOUR * 2.2)
}

// The three choices between two stops, each with its own time.
export function legOptions(a, b) {
  return { walk: walkMinutes(a, b), mrt: mrtMinutes(a, b), car: carMinutes(a, b) }
}

// The mode a leg starts with: walk when it is short, otherwise the faster of MRT and car,
// preferring the MRT unless the car saves more than 10 minutes.
export function defaultMode(options) {
  if (options.walk <= 12) return 'walk'
  if (options.mrt <= options.car + 10) return 'mrt'
  return 'car'
}

// Colour coding for a person's trip to the meeting area, always shown with the minutes:
// short (up to 30 min), medium (up to 45) and long (over 45).
export const TRAVEL_TONES = [
  { id: 'short', label: 'Up to 30 min', max: 30 },
  { id: 'medium', label: '31 to 45 min', max: 45 },
  { id: 'long', label: 'Over 45 min', max: Infinity },
]

export function travelTone(minutes) {
  return TRAVEL_TONES.find((t) => minutes <= t.max).id
}
