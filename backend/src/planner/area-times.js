// area-times.js: a better guess at public transport minutes than straight-line distance.
//
// The planner has to guess before it spends real OneMap routes: it ranks the meeting areas by estimated trips and routes only
// the best few. The guess used to be the straight line between two points, which ignores the MRT: Lakeside to Bugis is one
// direct ride, and the straight line made Bugis look 18th of 37 when it was the best area for a real group. This module turns a
// table of REAL times between the planner's areas (scripts/build-area-times.js, taken from OneMap once) into the same kind of
// guess for any two points: the trip between their nearest areas, plus a short hop at each end.
//
// It is the planner's TABLE TRIP TIME: the one definition that ranks meeting areas and places before any live route is asked for
// (services/travel-times.js routes only the few results a person sees first, and replaces their table times with routed ones). It is
// real transit data between the areas plus a modelled hop at each end, so the answer labels it `table`, apart from a straight-line
// `estimate`. The hop was fitted to 26 live OneMap trips on 28 October 2026 (see backend/docs/planner-api.md): the first version,
// 3.7 minutes a km, was 14 minutes too optimistic on average.
//
// A session's members start from the centres of areas, never from an exact place, so for them a trip is exactly the table's time.
// An exact address (the planner's other callers) is not on an area's centre: it may use any of the few areas nearest it, whichever
// gives the shortest trip, so a point just on the other side of a boundary is not guessed very differently from one just inside.

import { haversineKm, mockTravelMinutes } from './geo.js';

// How many of the nearest areas at each end of a trip are tried; the shortest way through any of them is the guess.
export const NEAREST_AREAS = 3;
// A point this close to an area's centre is that area (a session's member starts at the centre): only it is used at that end.
export const AT_CENTRE_KM = 0.05;
// The hop from a point to an area's station, in minutes: a fixed part for reaching and waiting at a station (growing from 0 to
// ACCESS_FIXED_MINUTES over the first ACCESS_RAMP_KM) and ACCESS_MINUTES_PER_KM for each km (walking, or a feeder bus with its wait). The step
// where the hop starts (AT_CENTRE_KM, a point on an area's centre has none) is under a minute, not zero. PROVISIONAL: fitted to 73 live OneMap
// trips on 28 October 2026 (backend/scripts/fit-access-hop.js and backend/scripts/data/access-hop-trips.json reproduce it). It is the same at
// both ends of a trip because the way back shares the route. Tried and kept: a smaller fixed part at the end of a trip. Trips with a hop
// at only their end suggest about 3 there (5 is 1.6 minutes too long on 16), but trips with hops at both ends, which are the place
// rankings, are then 2.4 minutes too short (the shortest of 3 x 3 ways through the areas is optimistic, and the fixed part pays for
// that), so each end keeps 5.
// The first version, 3.7 minutes a km and no fixed part, was 13.7 minutes too optimistic on average.
export const ACCESS_MINUTES_PER_KM = 7;
export const ACCESS_FIXED_MINUTES = 5;
export const ACCESS_RAMP_KM = 0.4;

/**
 * The minutes of the hop between a point and an area's centre `km` away. A point on the centre (a session's member) has no hop.
 *
 * How to call:
 *   accessMinutes(0.04) // 0
 *   accessMinutes(1) // 12
 */
export const accessMinutes = km => (km < AT_CENTRE_KM ? 0 : ACCESS_FIXED_MINUTES * Math.min(1, km / ACCESS_RAMP_KM) + ACCESS_MINUTES_PER_KM * km);

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
 *   const { found, expected } = areaTimesCoverage(data.areas, table) // { found: 10440, expected: 10440 }
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
 * The moment the table's times are for, in words: "Tuesday 12:30" from `_meta.dateTime` ("2026-10-27T12:30"). Null when the table does not say or
 * says something that is not a date and time. The times are one weekday midday; an evening or a weekend can differ.
 *
 * How to call:
 *   tableMoment(table) // 'Tuesday 12:30'
 */
export function tableMoment(table) {
  const text = table?._meta?.dateTime;
  const m = typeof text === 'string' ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})/.exec(text) : null;
  if (!m) return null;
  const day = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString('en-GB', { weekday: 'long', timeZone: 'UTC' });
  return day === 'Invalid Date' ? null : `${day} ${m[4]}`;
}

/**
 * Makes the estimate from the planner's areas and a table of real times between them. Returns `estimateMinutes(a, b)` for two
 * points { lat, lng }, which is also what `mockTravelMinutes` is: a drop-in for it. Its property `tableMinutes(a, b)` is the same
 * time, or null where it would be the straight line: the planner's table trip time (the number, and whether a table gave it).
 *   - two points of different areas: the shortest, over the NEAREST_AREAS nearest areas at each end, of the real time between those
 *     areas plus a hop (accessMinutes) at each end. A point on an area's centre uses only that area. A point has
 *     no distance limit: the hop just grows, so there is no jump where "near an area" ends;
 *   - two points nearest the same area: the straight-line estimate or the two hops, whichever is less. No table pair is in it, so an
 *     area with no usable pair at all has no table data and the trip is the straight line (null from tableMinutes). The area's
 *     shortest trip to a neighbour is not a cap on it: that is a ride between stations;
 *   - a pair the table lacks (no route was found) or holds a value that cannot be a time: skipped; if none is left, the
 *     straight-line estimate.
 *
 * How to call:
 *   const estimate = createAreaEstimator({ areas, table: loadedTable })
 *   estimate({ lat: 1.3274, lng: 103.9464 }, { lat: 1.3443, lng: 103.7207 }) // about 50
 *   estimate.tableMinutes(a, b) // the same number, or null when no table pair gave one
 */
export function createAreaEstimator({ areas, table }) {
  if (!isAreaTimes(table) || !Array.isArray(areas) || areas.length === 0) throw new Error('createAreaEstimator: needs the areas and a table of times');
  // The areas that have at least one usable pair in the table (and the shortest of them): an area without one has no table data.
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
  function tableMinutes(a, b) {
    const from = nearest(a), to = nearest(b);
    if (from[0].area.id === to[0].area.id) {
      const hops = accessMinutes(from[0].km) + accessMinutes(to[0].km);
      // Two points nearest the same area: the two hops or the straight line, whichever is less. The area's shortest trip to a neighbour is NOT
      // a cap: it is a ride between stations, and a person 1 km from a venue in the same area does not make that trip in 2 minutes. (It
      // was one, and Roam then ranked every nearby place at 2.5 minutes.) An area with no usable pair at all has no table data, so the
      // straight line answers.
      return shortestLeaving.has(from[0].area.id) ? Math.min(mockTravelMinutes(a, b), hops) : null;
    }
    let best = Infinity;
    for (const x of from) {
      for (const y of to) {
        const between = x.area.id === y.area.id ? 0 : table.minutes[pairKey(x.area.id, y.area.id)]; // one area for both ends: just the hops
        if (plausible(between)) best = Math.min(best, accessMinutes(x.km) + accessMinutes(y.km) + between);
      }
    }
    return Number.isFinite(best) ? best : null;
  }
  const estimateMinutes = (a, b) => tableMinutes(a, b) ?? mockTravelMinutes(a, b);
  estimateMinutes.tableMinutes = tableMinutes;
  return estimateMinutes;
}
