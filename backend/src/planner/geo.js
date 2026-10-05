'use strict';
// geo.js: geographic helpers shared by Converge and Roam.
// Pure functions only: no API calls, no database, no console output.

const toRad = d => (d * Math.PI) / 180;
const toDeg = r => (r * 180) / Math.PI;
const EARTH_KM = 6371;

/** Straight-line (great-circle) distance in km between two {lat, lng} points. */
function haversineKm(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_KM * Math.asin(Math.sqrt(h));
}

/**
 * Stand-in for OneMap routing so tests are deterministic.
 * ~22 km/h door-to-door on public transport, plus a fixed 6 minutes of waiting and walking.
 * The engine takes a travelMinutes(from, to) function as a dependency, so swapping in the
 * real OneMap call later means changing one argument, not the engine.
 */
const mockTravelMinutes = (a, b) => 6 + (haversineKm(a, b) * 1.35 * 60) / 22;

/**
 * Geographic centroid with optional weights.
 * Lat/lng are angles on a sphere, so averaging them directly drifts over distance.
 * Instead: convert to 3D (x, y, z), average, convert back.
 */
function centroid(points, weights = null) {
  if (!Array.isArray(points) || points.length === 0) {
    throw new Error('centroid: need at least one point');
  }
  if (weights !== null && weights.length !== points.length) {
    throw new Error('centroid: weights must be the same length as points');
  }
  let x = 0, y = 0, z = 0, total = 0;
  points.forEach((p, i) => {
    if (!Number.isFinite(p.lat) || !Number.isFinite(p.lng)) {
      throw new Error(`centroid: point ${i} needs numeric lat and lng`);
    }
    const w = weights === null ? 1 : weights[i];
    if (!Number.isFinite(w) || w < 0) throw new Error(`centroid: weight ${i} must be a number >= 0`);
    x += w * Math.cos(toRad(p.lat)) * Math.cos(toRad(p.lng));
    y += w * Math.cos(toRad(p.lat)) * Math.sin(toRad(p.lng));
    z += w * Math.sin(toRad(p.lat));
    total += w;
  });
  if (total === 0) throw new Error('centroid: weights cannot all be zero');
  x /= total; y /= total; z /= total;
  if (Math.hypot(x, y, z) < 1e-12) throw new Error('centroid: points cancel out');
  return { lat: toDeg(Math.atan2(z, Math.hypot(x, y))), lng: toDeg(Math.atan2(y, x)) };
}

/**
 * Fairness weights. People who have travelled MORE than their share get a BIGGER weight,
 * so the midpoint moves toward them this time:  weight = 1 + max(0, debt) / scale.
 * (1 / (1 + debt) is a trap: it moves the point AWAY from the person who travelled most.)
 */
function fairnessWeights(members, scaleMinutes = 60) {
  return members.map(m => 1 + Math.max(0, m.travelDebtMinutes ?? 0) / scaleMinutes);
}

/**
 * Minimax centre: the point that minimises the DISTANCE TO THE FURTHEST PERSON.
 * This is the centre of the smallest circle that contains every point.
 *
 * Why this matters: the centroid minimises the average (squared) distance, but our
 * fairness goal is "nobody travels too far", which is a worst-case goal. The two are
 * different points. Exact brute force: the smallest enclosing circle is always defined
 * by 2 points (as a diameter) or 3 points (circumcircle), so try every pair and triple.
 * Fine for the handful of people in a group (n <= 12).
 */
function minimaxCenter(points) {
  const n = points.length;
  if (n === 0) throw new Error('minimaxCenter: need at least one point');
  if (n > 12) throw new Error('minimaxCenter: brute force supports up to 12 points');
  const lat0 = points.reduce((s, p) => s + p.lat, 0) / n;
  const lng0 = points.reduce((s, p) => s + p.lng, 0) / n;
  const k = Math.cos(toRad(lat0));
  // Flat local projection in km. Accurate at city scale.
  const P = points.map(p => ({ x: EARTH_KM * toRad(p.lng - lng0) * k, y: EARTH_KM * toRad(p.lat - lat0) }));
  const encloses = c => P.every(p => Math.hypot(p.x - c.x, p.y - c.y) <= c.r + 1e-9);
  let best = n === 1 ? { x: P[0].x, y: P[0].y, r: 0 } : null;
  const consider = c => { if (c && encloses(c) && (!best || c.r < best.r)) best = c; };
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      consider({ x: (P[i].x + P[j].x) / 2, y: (P[i].y + P[j].y) / 2, r: Math.hypot(P[i].x - P[j].x, P[i].y - P[j].y) / 2 });
      for (let m = j + 1; m < n; m++) consider(circumcircle(P[i], P[j], P[m]));
    }
  }
  return {
    center: { lat: lat0 + toDeg(best.y / EARTH_KM), lng: lng0 + toDeg(best.x / (EARTH_KM * k)) },
    radiusKm: best.r,
  };
}

function circumcircle(a, b, c) {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-12) return null; // three points in a line
  const a2 = a.x ** 2 + a.y ** 2, b2 = b.x ** 2 + b.y ** 2, c2 = c.x ** 2 + c.y ** 2;
  const x = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const y = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { x, y, r: Math.hypot(a.x - x, a.y - y) };
}

/**
 * Expanding radius search. Looks within 500m, then 1km, 2km, 3km (the cap).
 * Stops at the first radius that has >= minResults venues; extraSteps keeps expanding a
 * little further so a mediocre nearby venue cannot crowd out a much better one slightly
 * further away (the scorer penalises distance anyway).
 * Pass venues that ALREADY passed the hard filters, otherwise the radius expands for nothing.
 *
 * @returns {{candidates:{venue:object, distanceKm:number}[], radiusUsed:number, firstHitRadius:number|null,
 *            reachedMin:boolean, nearestKm:number|null, nthNearestKm:number|null}}
 */
function radiusSearch(venues, centre, opts = {}) {
  const { steps = [500, 1000, 2000, 3000], minResults = 3, extraSteps = 0 } = opts;
  const all = venues
    .map(venue => ({ venue, distanceKm: haversineKm(centre, venue) }))
    .sort((a, b) => a.distanceKm - b.distanceKm);
  const within = r => all.filter(x => x.distanceKm * 1000 <= r);
  let firstHitRadius = null, enoughIdx = -1;
  steps.forEach((r, i) => {
    const count = within(r).length;
    if (count > 0 && firstHitRadius === null) firstHitRadius = r;
    if (enoughIdx === -1 && count >= minResults) enoughIdx = i;
  });
  const useIdx = enoughIdx === -1 ? steps.length - 1 : Math.min(enoughIdx + extraSteps, steps.length - 1);
  return {
    candidates: within(steps[useIdx]),
    radiusUsed: steps[useIdx],
    firstHitRadius,
    reachedMin: enoughIdx !== -1,
    nearestKm: all.length ? all[0].distanceKm : null,
    nthNearestKm: all.length >= minResults ? all[minResults - 1].distanceKm : null, // how far you would need to look for enough options
  };
}

module.exports = { haversineKm, mockTravelMinutes, centroid, fairnessWeights, minimaxCenter, radiusSearch };
