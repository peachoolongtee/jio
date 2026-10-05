// engine.js: converge() and roam(). Both are PURE: data in, ranked results out.
// Routing is injected (deps.travelMinutes) so tests are deterministic and OneMap can be plugged in later.
//
// Pipeline (both engines):
//   seed point -> hard filters -> expanding radius -> prune (cap routing cost) -> route -> score -> rank -> explain

import { centroid, fairnessWeights, minimaxCenter, radiusSearch, mockTravelMinutes } from './geo.js';
import { filterByConstraints, countReasons, relaxationHints, needsVerification } from './filters.js';
import * as S from './scoring.js';

/** Apply per-plan overrides (start/end) and drop members who opted out. Default start and end = home. */
function resolveMembers(members, overrides = {}, optedOut = []) {
  return members
    .filter(m => !optedOut.includes(m.id))
    .map(m => {
      const o = overrides[m.id] || {};
      return { ...m, start: o.start || m.start || m.home, end: o.end || m.end || m.home };
    });
}

/** Occasion-specific weights: a date or birthday is a splurge, so price counts for less than for a study session. */
function occasionWeights(weights, profile) {
  return weights.price === undefined ? weights : { ...weights, price: weights.price * (profile?.priceSensitivity ?? 1) };
}

/** Penalties that do not depend on travel time. */
function staticFactors(venue, c) {
  return {
    weather: S.weatherPenalty(venue, c.weatherByArea),
    preference: S.preferencePenalty(venue, c.members),
    occasion: 100 - (venue.occasionFit?.[c.occasion] ?? S.computeOccasionFit(venue, c.profile)),
    rating: S.ratingPenalty(venue),
    price: S.pricePenalty(venue, c.members),
    cdc: S.cdcPenalty(venue),
    antiRepeat: S.antiRepeatPenalty(venue.id, c.history, { today: c.today, groupId: c.groupId }),
  };
}

/**
 * Cheap pre-score using straight-line distance only (no routing). Keeps the best N so we make
 * at most N x members routing calls. It uses fit and rating as well as distance, so a close but
 * poor-fit venue cannot push a much better one out of the shortlist.
 */
function prune(candidates, c, keep) {
  if (candidates.length <= keep) return candidates;
  const dn = S.normalizeMinMax(candidates.map(x => x.distanceKm));
  return candidates
    .map((x, i) => ({ x, pre: 0.5 * dn[i] + 0.3 * (100 - (x.venue.occasionFit?.[c.occasion] ?? 0)) + 0.2 * S.ratingPenalty(x.venue) }))
    .sort((a, b) => a.pre - b.pre)
    .slice(0, keep)
    .map(o => o.x);
}

function context(input, data, members) {
  return {
    members, occasion: input.occasion, profile: data.occasionProfiles[input.occasion],
    weatherByArea: data.weatherCases[input.weatherCase ?? 'clear'],
    history: data.visitHistory ?? [], today: input.today ?? data._meta.today, groupId: input.groupId ?? null,
  };
}

/** Fewer than minResults options inside the cap: still show them, but tell the UI how far to look for more. */
function fewOptions(rs) {
  if (rs.reachedMin) return null;
  return { type: 'few_options', found: rs.candidates.length, widenToKm: rs.nthNearestKm === null ? null : Math.ceil(rs.nthNearestKm) };
}

function emptyResult(reason, extra) {
  return { status: 'empty', reason, results: [], ...extra };
}

/**
 * Converge: several people, one fair place.
 * @param {object} input  { members, overrides?, optedOut?, occasion, dateTime, groupConstraints?, categories?,
 *                          weatherCase?, groupId?, unknownPolicy? ('strict' default | 'lenient'), seed?, pruneTo?, topN?,
 *                          weights?, radius?, fairnessScaleMinutes?,
 *                          travelCeilingMinutes? (default 60) }
 *                        seed: 'weighted_centroid' (default) | 'centroid' | 'minimax'
 * @param {object} data   { venues, occasionProfiles, weatherCases, visitHistory, _meta }
 * @param {object} deps   { travelMinutes?(from, to) }
 */
function converge(input, data, deps = {}) {
  const tm = deps.travelMinutes ?? mockTravelMinutes;
  const members = resolveMembers(input.members, input.overrides, input.optedOut);
  if (members.length === 0) throw new Error('converge: no active members');
  const { seed = 'weighted_centroid', pruneTo = 10, topN = 5 } = input;
  const baseWeights = input.weights ?? S.DEFAULT_WEIGHTS.converge;

  // 1. seed point
  const starts = members.map(m => m.start);
  const fw = fairnessWeights(members, input.fairnessScaleMinutes ?? 60);
  const centre =
    seed === 'minimax' ? minimaxCenter(starts).center :
    seed === 'centroid' ? centroid(starts) :
    centroid(starts, fw);

  // 2. hard filters
  const ctx = {
    members, groupConstraints: input.groupConstraints ?? [], dateTime: input.dateTime,
    categories: input.categories ?? ['eat', 'drink'], excludeVenueIds: input.excludeVenueIds ?? [],
    unknownPolicy: input.unknownPolicy ?? 'strict',
  };
  const filt = filterByConstraints(data.venues, ctx);
  const diagnostics = { rejectedCounts: countReasons(filt.rejected), passedFilters: filt.passed.length, seed, activeMembers: members.map(m => m.id) };
  if (filt.passed.length === 0) {
    return emptyResult('no_venue_passes_constraints', { centre, hints: relaxationHints(data.venues, ctx), diagnostics });
  }

  // 3. expanding radius
  const rs = radiusSearch(filt.passed, centre, input.radius);
  Object.assign(diagnostics, { radiusUsed: rs.radiusUsed, firstHitRadius: rs.firstHitRadius, inRadius: rs.candidates.length });
  if (rs.candidates.length === 0) {
    const widenToKm = Math.ceil(rs.nearestKm);
    return emptyResult('outside_max_radius', { centre, hints: { nearestKm: rs.nearestKm, widenToKm }, diagnostics });
  }

  // 4. prune, then route
  const pruned = prune(rs.candidates, { occasion: input.occasion }, pruneTo);
  diagnostics.routingCalls = pruned.length * members.length * 2;
  const c = context(input, data, members);
  const weights = occasionWeights(baseWeights, c.profile);

  let rows = pruned.map(({ venue, distanceKm }) => {
    const travel = members.map(m => tm(m.start, venue));
    const back = members.map(m => tm(venue, m.end));
    const worstIdx = travel.indexOf(Math.max(...travel));
    const wSum = fw.reduce((a, b) => a + b, 0);
    return {
      venue, distanceKm, back,
      travelByMember: Object.fromEntries(members.map((m, i) => [m.id, travel[i]])),
      returnByMember: Object.fromEntries(members.map((m, i) => [m.id, back[i]])),
      worstMinutes: travel[worstIdx], worstMemberId: members[worstIdx].id,
      meanRaw: travel.reduce((a, b) => a + b, 0) / travel.length,
      meanFair: travel.reduce((s, t, i) => s + fw[i] * t, 0) / wSum, // fairness-weighted mean
      factors: staticFactors(venue, c),
    };
  });

  // 5. per-member return-trip limit (the last stop must not be too far from anyone's END point)
  const before = rows.length;
  rows = rows.filter(r => r.back.every((b, i) => b <= (members[i].maxReturnMinutes ?? Infinity)));
  diagnostics.droppedByReturnTrip = before - rows.length;
  if (rows.length === 0) return emptyResult('return_trip_too_long', { centre, diagnostics });

  // 6. score. Travel is an absolute penalty against a ceiling (default 60 min), not stretched across candidates.
  const ceiling = input.travelCeilingMinutes ?? 60;
  rows.forEach(r => {
    r.factors.worst = S.travelPenalty(r.worstMinutes, ceiling);
    r.factors.mean = S.travelPenalty(r.meanFair, ceiling);
    const { score, breakdown } = S.combine(r.factors, weights);
    r.score = score; r.breakdown = breakdown; r.weights = weights;
    r.hasHistory = c.history.length > 0;
  });
  rows.sort((a, b) => a.score - b.score);

  // 7. explain
  const names = Object.fromEntries(members.map(m => [m.id, m.name]));
  const label = c.profile?.label ?? 'meetup';
  const results = rows.slice(0, topN).map((r, i) => ({
    rank: i + 1, venueId: r.venue.id, name: r.venue.name, venue: r.venue, score: r.score,
    worstMinutes: r.worstMinutes, worstMember: names[r.worstMemberId], meanMinutes: r.meanRaw,
    travelByMember: r.travelByMember, returnByMember: r.returnByMember, distanceFromCentreKm: r.distanceKm,
    breakdown: r.breakdown, explanation: S.explain(r, label), verify: needsVerification(r.venue, members),
  }));
  return { status: 'ok', centre, results, regret: S.regretCounterfactual(rows, names), notice: fewOptions(rs), diagnostics };
}

/**
 * Roam: one point, "what is nearby right now". Stateless apart from excludeVenueIds (places just visited).
 * @param {object} input { current:{lat,lng}, members, occasion, dateTime, groupConstraints?, categories?,
 *                         excludeVenueIds?, weatherCase?, groupId?, pruneTo?, topN?, weights?, radius? }
 */
function roam(input, data, deps = {}) {
  const tm = deps.travelMinutes ?? mockTravelMinutes;
  const members = input.members.map(m => ({ ...m }));
  const { pruneTo = 10, topN = 5 } = input;
  const baseWeights = input.weights ?? S.DEFAULT_WEIGHTS.roam;
  const ctx = {
    members, groupConstraints: input.groupConstraints ?? [], dateTime: input.dateTime,
    categories: input.categories ?? ['eat', 'drink', 'activity'], excludeVenueIds: input.excludeVenueIds ?? [],
    unknownPolicy: input.unknownPolicy ?? 'strict',
  };
  const filt = filterByConstraints(data.venues, ctx);
  const diagnostics = { rejectedCounts: countReasons(filt.rejected), passedFilters: filt.passed.length };
  if (filt.passed.length === 0) {
    return emptyResult('no_venue_passes_constraints', { hints: relaxationHints(data.venues, ctx), diagnostics });
  }
  const rs = radiusSearch(filt.passed, input.current, input.radius);
  Object.assign(diagnostics, { radiusUsed: rs.radiusUsed, firstHitRadius: rs.firstHitRadius, inRadius: rs.candidates.length });
  if (rs.candidates.length === 0) {
    return emptyResult('outside_max_radius', { hints: { nearestKm: rs.nearestKm, widenToKm: Math.ceil(rs.nearestKm) }, diagnostics });
  }
  const pruned = prune(rs.candidates, { occasion: input.occasion }, pruneTo);
  diagnostics.routingCalls = pruned.length;
  const c = context(input, data, members);
  const weights = occasionWeights(baseWeights, c.profile);

  const rows = pruned.map(({ venue, distanceKm }) => ({
    venue, distanceKm, travelMinutes: tm(input.current, venue), factors: staticFactors(venue, c),
  }));
  const ceiling = input.travelCeilingMinutes ?? 30; // Roam is "nearby", so a tighter ceiling than Converge
  rows.forEach(r => {
    r.factors.distance = S.travelPenalty(r.travelMinutes, ceiling);
    const { score, breakdown } = S.combine(r.factors, weights);
    r.score = score; r.breakdown = breakdown; r.weights = weights; r.hasHistory = c.history.length > 0;
  });
  rows.sort((a, b) => a.score - b.score);
  const label = c.profile?.label ?? 'meetup';
  const results = rows.slice(0, topN).map((r, i) => ({
    rank: i + 1, venueId: r.venue.id, name: r.venue.name, venue: r.venue, score: r.score,
    travelMinutes: r.travelMinutes, distanceKm: r.distanceKm, breakdown: r.breakdown, explanation: S.explain(r, label),
    verify: needsVerification(r.venue, members),
  }));
  return { status: 'ok', centre: input.current, results, notice: fewOptions(rs), diagnostics };
}

export { converge, roam, resolveMembers, occasionWeights };
