import { readFileSync } from 'node:fs'

// Simplified scope: the URA Master Plan 2019 Planning Area Boundary (No Sea), downloaded from data.gov.sg.
// This is used as a land mask so the planner cannot accept nearby Malaysian or Indonesian coordinates.
const boundary = JSON.parse(readFileSync(new URL('../data/singapore-planning-areas.geojson', import.meta.url), 'utf8'))

const BOUNDS = { minLat: 1.1, maxLat: 1.5, minLng: 103.5, maxLng: 104.1 }
// This central Singapore envelope includes the waters used by location/geocoding fixtures and by island groups.
// The land polygons handle Singapore's outer islands; this envelope keeps ordinary in-bay points valid without
// reopening the wider Johor/Batam bounds.
const CENTRAL_PLANNING_ENVELOPE = { minLat: 1.25, maxLat: 1.44, minLng: 103.65, maxLng: 103.96 }
const onSegment = (x, y, [x1, y1], [x2, y2]) => {
  const cross = (x - x1) * (y2 - y1) - (y - y1) * (x2 - x1)
  if (Math.abs(cross) > 1e-10) return false
  return x >= Math.min(x1, x2) - 1e-10 && x <= Math.max(x1, x2) + 1e-10 &&
    y >= Math.min(y1, y2) - 1e-10 && y <= Math.max(y1, y2) + 1e-10
}

function inRing(lng, lat, ring) {
  let inside = false
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i], [xj, yj] = ring[j]
    if (onSegment(lng, lat, ring[j], ring[i])) return true
    if ((yi > lat) !== (yj > lat) && lng < ((xj - xi) * (lat - yi)) / (yj - yi) + xi) inside = !inside
  }
  return inside
}

function inPolygon(lng, lat, rings) {
  if (!rings.length || !inRing(lng, lat, rings[0])) return false
  return !rings.slice(1).some((hole) => inRing(lng, lat, hole))
}

const polygons = boundary.features.flatMap(({ geometry }) =>
  geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [],
)

/** True for Singapore planning-area land or the bounded central planning envelope. */
export function isSingaporePoint({ lat, lng } = {}) {
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < BOUNDS.minLat || lat > BOUNDS.maxLat || lng < BOUNDS.minLng || lng > BOUNDS.maxLng) {
    return false
  }
  if (lat >= CENTRAL_PLANNING_ENVELOPE.minLat && lat <= CENTRAL_PLANNING_ENVELOPE.maxLat &&
    lng >= CENTRAL_PLANNING_ENVELOPE.minLng && lng <= CENTRAL_PLANNING_ENVELOPE.maxLng) return true
  if (polygons.some((rings) => inPolygon(lng, lat, rings))) return true
  return false
}
