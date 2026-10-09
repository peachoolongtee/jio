// Geography helpers. Points are { lat, lng }.

const EARTH_KM = 6371
const rad = (deg) => (deg * Math.PI) / 180

// Straight-line distance in kilometres.
export function distanceKm(a, b) {
  const dLat = rad(b.lat - a.lat)
  const dLng = rad(b.lng - a.lng)
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2
  return 2 * EARTH_KM * Math.asin(Math.sqrt(s))
}

// The geographic centre of a set of points.
export function centroid(points) {
  const n = points.length
  return {
    lat: points.reduce((sum, p) => sum + p.lat, 0) / n,
    lng: points.reduce((sum, p) => sum + p.lng, 0) / n,
  }
}

// The candidate closest to a point.
export function nearest(point, candidates) {
  let best = null
  let bestKm = Infinity
  for (const candidate of candidates) {
    const km = distanceKm(point, candidate)
    if (km < bestKm) {
      best = candidate
      bestKm = km
    }
  }
  return best
}

export const SINGAPORE_BOUNDS = { south: 1.15, north: 1.48, west: 103.59, east: 104.1 }

export function inSingapore(point) {
  const b = SINGAPORE_BOUNDS
  return point.lat >= b.south && point.lat <= b.north && point.lng >= b.west && point.lng <= b.east
}

// Two points closer than this are the same place.
export const SAME_PLACE_KM = 0.05
