// area-times.js: a better guess at public transport minutes than straight-line distance.
//
// The planner has to guess before it spends real OneMap routes: it ranks the meeting areas by estimated trips and routes only
// the best few. The guess used to be the straight line between two points, which ignores the MRT: Lakeside to Bugis is one
// direct ride, and the straight line made Bugis look 18th of 37 when it was the best area for a real group. This module turns a
// table of REAL times between the planner's areas (scripts/build-area-times.js, taken from OneMap once) into the same kind of
// guess for any two points: the trip between their nearest areas, plus a short hop at each end.
//
// It is only a guess, to rank and to fill in when OneMap cannot answer. A trip that gets a real route still uses it.

import { haversineKm, mockTravelMinutes } from './geo.js';

// A point farther than this from every area is not near any: the table says nothing about it, and the straight line is used.
export const MAX_ACCESS_KM = 6;
// The short hop from a point to its nearest area, in minutes for each km (walking, a feeder bus or a short ride, with the wait).
// The straight-line estimate's own rate (about 3.7 a km) without its fixed 6 minutes, which the table's door-to-door times hold.
export const ACCESS_MINUTES_PER_KM = (1.35 * 60) / 22;

/**
 * The key of an unordered pair of area ids: 'bedok|bugis'.
 *
 * How to call:
 *   pairKey('bugis', 'bedok') // 'bedok|bugis'
 */
export const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Whether a saved table can be used: the shape build-area-times.js writes. A list is not a table.
 *
 * How to call:
 *   isAreaTimes(JSON.parse(text)) // true
 */
export const isAreaTimes = table =>
  table !== null && typeof table === 'object' && !Array.isArray(table)
  && table.minutes !== null && typeof table.minutes === 'object' && !Array.isArray(table.minutes)
  && Array.isArray(table._meta?.areas);

// A time in the table that can be believed: a number from 0 to 6 hours. Anything else (a corrupt file, a hand edit) is not used, and
// the straight line answers for that pair instead.
export const MAX_PLAUSIBLE_MINUTES = 360;
const plausible = minutes => typeof minutes === 'number' && Number.isFinite(minutes) && minutes >= 0 && minutes <= MAX_PLAUSIBLE_MINUTES;

/**
 * How much of the table the planner's current areas can use: { found, expected }. A table built before an area was added or
 * renamed covers fewer pairs than it should, and the planner quietly uses the straight line for the rest, so start-up says so.
 *
 * How to call:
 *   const { found, expected } = areaTimesCoverage(data.areas, table) // { found: 666, expected: 666 }
 */
export function areaTimesCoverage(areas, table) {
  let found = 0, expected = 0;
  for (let i = 0; i < areas.length; i++) {
    for (let j = i + 1; j < areas.length; j++) {
      expected += 1;
      if (plausible(table.minutes[pairKey(areas[i].id, areas[j].id)])) found += 1;
    }
  }
  return { found, expected };
}

/**
 * Makes the estimate from the planner's areas and a table of real times between them. Returns `estimateMinutes(a, b)` for two
 * points { lat, lng }, which is also what `mockTravelMinutes` is: a drop-in for it.
 *   - two points nearest the same area: the straight-line estimate (the table has nothing finer than an area);
 *   - otherwise: the real time between their nearest areas, plus a short hop at each end;
 *   - a pair the table lacks (no route was found) or holds a value that cannot be a time, or a point far from every area: the
 *     straight-line estimate.
 *
 * How to call:
 *   const estimate = createAreaEstimator({ areas, table: loadedTable })
 *   estimate({ lat: 1.3274, lng: 103.9464 }, { lat: 1.3443, lng: 103.7207 }) // about 45
 */
export function createAreaEstimator({ areas, table }) {
  if (!isAreaTimes(table) || !Array.isArray(areas) || areas.length === 0) throw new Error('createAreaEstimator: needs the areas and a table of times');
  const nearest = point => {
    let best = null, bestKm = Infinity;
    for (const area of areas) {
      const km = haversineKm(point, area);
      if (km < bestKm) [best, bestKm] = [area, km];
    }
    return { area: best, km: bestKm };
  };
  return function estimateMinutes(a, b) {
    const from = nearest(a), to = nearest(b);
    if (from.km > MAX_ACCESS_KM || to.km > MAX_ACCESS_KM || from.area.id === to.area.id) return mockTravelMinutes(a, b);
    const between = table.minutes[pairKey(from.area.id, to.area.id)];
    if (!plausible(between)) return mockTravelMinutes(a, b);
    return from.km * ACCESS_MINUTES_PER_KM + between + to.km * ACCESS_MINUTES_PER_KM;
  };
}
