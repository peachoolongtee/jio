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

// Grab: about 5 minutes to be picked up, then 27 km/h through traffic.
export function grabMinutes(a, b) {
  const km = distanceKm(a, b)
  if (km < SAME_PLACE_KM) return 0
  return Math.round(5 + km * DETOUR * 2.2)
}

// The three choices between two stops, each with its own time.
export function legOptions(a, b) {
  return { walk: walkMinutes(a, b), mrt: mrtMinutes(a, b), grab: grabMinutes(a, b) }
}

// The mode a leg starts with: walk when it is short, otherwise the faster of MRT and Grab,
// preferring the MRT unless Grab saves more than 10 minutes.
export function defaultMode(options) {
  if (options.walk <= 12) return 'walk'
  if (options.mrt <= options.grab + 10) return 'mrt'
  return 'grab'
}
