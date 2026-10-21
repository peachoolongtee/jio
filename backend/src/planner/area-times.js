// area-times.js: a better guess at public transport minutes than straight-line distance.
//
// The planner has to guess before it spends real OneMap routes: it ranks the meeting areas by estimated trips and routes only
// the best few. The guess used to be the straight line between two points, which ignores the MRT: Lakeside to Bugis is one
// direct ride, and the straight line made Bugis look 18th of 37 when it was the best area for a real group. This module turns a
// table of REAL times between the planner's areas (scripts/build-area-times.js, taken from OneMap once) into the same kind of
// guess for any two points: the trip between their nearest areas, plus a short hop at each end.
//
// It is only a guess, to rank and to fill in when OneMap cannot answer. A trip that gets a real route still uses it.
//
// A session's members start from the centres of areas, never from an exact place, so for them a trip is exactly the table's time.
// An exact address (the planner's other callers) is not on an area's centre: it may use any of the few areas nearest it, whichever
// gives the shortest trip, so a point just on the other side of a boundary is not guessed very differently from one just inside.

import { haversineKm, mockTravelMinutes } from './geo.js';

// How many of the nearest areas at each end of a trip are tried; the shortest way through any of them is the guess.
export const NEAREST_AREAS = 3;
// A point this close to an area's centre is that area (a session's member starts at the centre): only it is used at that end.
export const AT_CENTRE_KM = 0.05;
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
 *   - two points of different areas: the shortest, over the NEAREST_AREAS nearest areas at each end, of the real time between those
 *     areas plus a short hop (ACCESS_MINUTES_PER_KM) at each end. A point on an area's centre uses only that area. A point has
 *     no distance limit: the hop just grows, so there is no jump where "near an area" ends;
 *   - two points nearest the same area: the straight-line estimate, the two hops or the area's shortest trip to a neighbour,
 *     whichever is least (a trip inside an area is never longer than leaving it);
 *   - a pair the table lacks (no route was found) or holds a value that cannot be a time: skipped; if none is left, the
 *     straight-line estimate.
 *
 * How to call:
 *   const estimate = createAreaEstimator({ areas, table: loadedTable })
 *   estimate({ lat: 1.3274, lng: 103.9464 }, { lat: 1.3443, lng: 103.7207 }) // about 45
 */
export function createAreaEstimator({ areas, table }) {
  if (!isAreaTimes(table) || !Array.isArray(areas) || areas.length === 0) throw new Error('createAreaEstimator: needs the areas and a table of times');
  // The shortest trip from each area to any other, from the table: the most a trip inside the area may take.
  const ids = new Set(areas.map(a => a.id));
  const shortestLeaving = new Map();
  for (const [key, minutes] of Object.entries(table.minutes)) {
    const [x, y, ...more] = key.split('|');
    if (more.length > 0 || !ids.has(x) || !ids.has(y) || !plausible(minutes)) continue;
    for (const id of [x, y]) shortestLeaving.set(id, Math.min(shortestLeaving.get(id) ?? Infinity, minutes));
  }
  // The NEAREST_AREAS areas nearest a point, nearest first: [{ area, km }]. Only the nearest, for a point on an area's centre.
  const nearest = point => {
    const few = [];
    for (const area of areas) {
      const km = haversineKm(point, area);
      if (few.length === NEAREST_AREAS && km >= few[NEAREST_AREAS - 1].km) continue;
      few.push({ area, km });
      few.sort((x, y) => x.km - y.km);
      if (few.length > NEAREST_AREAS) few.pop();
    }
    return few[0].km < AT_CENTRE_KM ? [few[0]] : few;
  };
  return function estimateMinutes(a, b) {
    const from = nearest(a), to = nearest(b);
    if (from[0].area.id === to[0].area.id) {
      const hops = (from[0].km + to[0].km) * ACCESS_MINUTES_PER_KM;
      return Math.min(mockTravelMinutes(a, b), hops, shortestLeaving.get(from[0].area.id) ?? Infinity);
    }
    let best = Infinity;
    for (const x of from) {
      for (const y of to) {
        const between = x.area.id === y.area.id ? 0 : table.minutes[pairKey(x.area.id, y.area.id)]; // one area for both ends: just the hops
        if (plausible(between)) best = Math.min(best, (x.km + y.km) * ACCESS_MINUTES_PER_KM + between);
      }
    }
    return Number.isFinite(best) ? best : mockTravelMinutes(a, b);
  };
}
