import { haversineKm } from '../planner/geo.js'

// Which of NEA's five regions each of the 47 two-hour forecast areas falls in.
//
// The 24-hour forecast speaks of five regions (west, east, central, south, north) and has no coordinates. The
// planner places every venue in a two-hour forecast area, so to score a venue against a regional forecast it
// needs to know the region of that area. NEA publishes no such mapping. This table is the researched one (ticket
// #115): 31 areas are named in NEA's table of regions for air quality reporting, 14 take the nearest region
// by label point, and Geylang and Marine Parade were placed with the neighbouring towns NEA names. Novena is the
// weakest call (central 3.4 km, south 3.5 km).
//
// Each area also carries its label point, copied from the two-hour forecast's own area list
// (tests/fixtures/datagov/two-hr-forecast.dry.json), so a venue can be placed in its area without fetching the
// two-hour forecast. A test checks that this list and that fixture name the same areas.

/** The five regions the 24-hour forecast uses, as it spells them. */
export const REGIONS = ['west', 'east', 'central', 'south', 'north']

// Label points of the regions, from NEA's air quality (PSI) endpoint. Used only for an area the table does not
// name: it takes the region whose point is nearest.
export const REGION_POINTS = {
  north: { lat: 1.41803, lng: 103.82 },
  south: { lat: 1.29587, lng: 103.82 },
  east: { lat: 1.35735, lng: 103.94 },
  west: { lat: 1.35735, lng: 103.7 },
  central: { lat: 1.35735, lng: 103.82 },
}

/** The 47 two-hour forecast areas: name, label point and region. */
export const TWO_HOUR_AREAS = [
  { name: 'Ang Mo Kio', lat: 1.375, lng: 103.839, region: 'central' },
  { name: 'Bedok', lat: 1.321, lng: 103.924, region: 'east' },
  { name: 'Bishan', lat: 1.350772, lng: 103.839, region: 'central' },
  { name: 'Boon Lay', lat: 1.304, lng: 103.701, region: 'west' },
  { name: 'Bukit Batok', lat: 1.353, lng: 103.754, region: 'west' },
  { name: 'Bukit Merah', lat: 1.277, lng: 103.819, region: 'south' },
  { name: 'Bukit Panjang', lat: 1.362, lng: 103.77195, region: 'west' },
  { name: 'Bukit Timah', lat: 1.325, lng: 103.791, region: 'south' },
  { name: 'Central Water Catchment', lat: 1.38, lng: 103.805, region: 'central' },
  { name: 'Changi', lat: 1.357, lng: 103.987, region: 'east' },
  { name: 'Choa Chu Kang', lat: 1.377, lng: 103.745, region: 'west' },
  { name: 'City', lat: 1.292, lng: 103.844, region: 'south' },
  { name: 'Clementi', lat: 1.315, lng: 103.76, region: 'west' },
  { name: 'Geylang', lat: 1.318, lng: 103.884, region: 'east' },
  { name: 'Hougang', lat: 1.361218, lng: 103.886, region: 'east' },
  { name: 'Jalan Bahar', lat: 1.347, lng: 103.67, region: 'west' },
  { name: 'Jurong East', lat: 1.326, lng: 103.737, region: 'west' },
  { name: 'Jurong Island', lat: 1.266, lng: 103.699, region: 'west' },
  { name: 'Jurong West', lat: 1.34039, lng: 103.705, region: 'west' },
  { name: 'Kallang', lat: 1.312, lng: 103.862, region: 'east' },
  { name: 'Lim Chu Kang', lat: 1.423, lng: 103.717332, region: 'west' },
  { name: 'Mandai', lat: 1.419, lng: 103.812, region: 'north' },
  { name: 'Marine Parade', lat: 1.297, lng: 103.891, region: 'east' },
  { name: 'Novena', lat: 1.327, lng: 103.826, region: 'central' },
  { name: 'Pasir Ris', lat: 1.37, lng: 103.948, region: 'east' },
  { name: 'Paya Lebar', lat: 1.358, lng: 103.914, region: 'east' },
  { name: 'Pioneer', lat: 1.315, lng: 103.675, region: 'west' },
  { name: 'Pulau Tekong', lat: 1.403, lng: 104.053, region: 'east' },
  { name: 'Pulau Ubin', lat: 1.404, lng: 103.96, region: 'east' },
  { name: 'Punggol', lat: 1.401, lng: 103.904, region: 'north' },
  { name: 'Queenstown', lat: 1.291, lng: 103.78576, region: 'south' },
  { name: 'Seletar', lat: 1.404, lng: 103.869, region: 'north' },
  { name: 'Sembawang', lat: 1.445, lng: 103.818495, region: 'north' },
  { name: 'Sengkang', lat: 1.384, lng: 103.891443, region: 'north' },
  { name: 'Sentosa', lat: 1.243, lng: 103.832, region: 'south' },
  { name: 'Serangoon', lat: 1.357, lng: 103.865, region: 'east' },
  { name: 'Southern Islands', lat: 1.208, lng: 103.842, region: 'south' },
  { name: 'Sungei Kadut', lat: 1.413, lng: 103.756, region: 'north' },
  { name: 'Tampines', lat: 1.345, lng: 103.944, region: 'east' },
  { name: 'Tanglin', lat: 1.308, lng: 103.813, region: 'south' },
  { name: 'Tengah', lat: 1.374, lng: 103.715, region: 'west' },
  { name: 'Toa Payoh', lat: 1.334304, lng: 103.856327, region: 'central' },
  { name: 'Tuas', lat: 1.294947, lng: 103.635, region: 'west' },
  { name: 'Western Islands', lat: 1.205926, lng: 103.746, region: 'south' },
  { name: 'Western Water Catchment', lat: 1.405, lng: 103.689, region: 'west' },
  { name: 'Woodlands', lat: 1.432, lng: 103.786528, region: 'north' },
  { name: 'Yishun', lat: 1.418, lng: 103.839, region: 'north' },
]

const REGION_OF_AREA = new Map(TWO_HOUR_AREAS.map((a) => [a.name, a.region]))

/**
 * The region whose label point is nearest to a point.
 *
 * How to call:
 *   nearestRegion({ lat: 1.3521, lng: 103.8198 }) // 'central'
 */
export function nearestRegion(point) {
  let best = null
  let bestKm = Infinity
  for (const region of REGIONS) {
    const km = haversineKm(point, REGION_POINTS[region])
    if (km < bestKm) [best, bestKm] = [region, km]
  }
  return best
}

/**
 * Builds the lookup from a two-hour area to its region. An area the table does not name takes the nearest
 * region by its label point, and that is logged once per area name, not once per request.
 *
 * How to call:
 *   const regionOf = createRegionLookup({ warn: console.warn })
 *   regionOf({ name: 'Bedok', lat: 1.321, lng: 103.924 })     // 'east', from the table
 *   regionOf({ name: 'Nowhere', lat: 1.45, lng: 103.82 })     // 'north', nearest label point (logged once)
 */
export function createRegionLookup({ warn = console.warn } = {}) {
  const reported = new Set()
  return function regionOf(area) {
    const known = REGION_OF_AREA.get(area.name)
    if (known) return known
    const region = nearestRegion(area)
    if (!reported.has(area.name)) {
      reported.add(area.name)
      warn(`Forecast area "${area.name}" is not in the region table (services/weather-regions.js): using the nearest region, ${region}.`)
    }
    return region
  }
}
