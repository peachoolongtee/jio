// Re-fits the hop at each end of the planner's table trip time (planner/area-times.js accessMinutes) to the live OneMap trips taken on
// 28 October 2026, kept as residuals in scripts/data/access-hop-trips.json (no routes, no coordinates). Needs no network.
//
// How to run:
//   node scripts/fit-access-hop.js          prints the error of the hop in the code and the best constants on a grid
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadAreaTimes } from '../src/db/area-times.js'
import { ACCESS_FIXED_MINUTES, ACCESS_MINUTES_PER_KM, ACCESS_RAMP_KM, AT_CENTRE_KM, pairKey } from '../src/planner/area-times.js'

export const TRIPS_FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), 'data/access-hop-trips.json')

// The hop of the model the residuals were taken at, or of any other constants.
//
// How to call:
//   hopWith({ fixed: 4, perKm: 7, rampKm: 0.4, centreKm: 0.05 })(1.2) // 12.4
export const hopWith = ({ fixed, perKm, rampKm, centreKm }) => (km) => (km < centreKm ? 0 : fixed * Math.min(1, km / rampKm) + perKm * km)

// The saved trips, each with the live minutes worked out again (planner at the reference constants minus its residual).
//
// How to call:
//   const trips = loadTrips() // [{ group, kind, a: [[areaId, km], ...], b: [...], live: 41.3 }]
export function loadTrips(file = TRIPS_FILE) {
  const { _meta, trips } = JSON.parse(fs.readFileSync(file, 'utf8'))
  const table = loadAreaTimes()
  const between = (x, y) => (x === y ? 0 : table.minutes[pairKey(x, y)])
  const reference = hopWith(_meta.reference)
  return trips.map((t) => ({ ...t, live: Math.min(...t.a.flatMap(([ia, ka]) => t.b.map(([ib, kb]) => reference(ka) + reference(kb) + between(ia, ib)))) - t.residualAtReference, between }))
}

// The planner's minutes for a trip with this hop, and the mean error and mean absolute error against the live minutes.
//
// How to call:
//   evaluate(loadTrips(), hopWith({ fixed: 4, perKm: 7, rampKm: 0.4, centreKm: 0.05 })) // { n: 73, mean: -0.4, mae: 4.1 }
export function evaluate(trips, hop) {
  const errors = trips.map((t) => Math.min(...t.a.flatMap(([ia, ka]) => t.b.map(([ib, kb]) => hop(ka) + hop(kb) + t.between(ia, ib)))) - t.live)
  const mean = errors.reduce((s, e) => s + e, 0) / errors.length
  return { n: errors.length, mean: +mean.toFixed(2), mae: +(errors.reduce((s, e) => s + Math.abs(e), 0) / errors.length).toFixed(2) }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const trips = loadTrips()
  const inCode = hopWith({ fixed: ACCESS_FIXED_MINUTES, perKm: ACCESS_MINUTES_PER_KM, rampKm: ACCESS_RAMP_KM, centreKm: AT_CENTRE_KM })
  console.log('in the code:', JSON.stringify({ fixed: ACCESS_FIXED_MINUTES, perKm: ACCESS_MINUTES_PER_KM }), evaluate(trips, inCode))
  const grid = []
  for (const fixed of [0, 1, 2, 3, 4, 5, 6]) for (const perKm of [4, 5, 6, 7, 8, 9]) grid.push({ fixed, perKm, ...evaluate(trips, hopWith({ fixed, perKm, rampKm: ACCESS_RAMP_KM, centreKm: AT_CENTRE_KM })) })
  console.log('best by mean absolute error:')
  for (const g of grid.sort((x, y) => x.mae - y.mae).slice(0, 5)) console.log(' ', JSON.stringify(g))
}
