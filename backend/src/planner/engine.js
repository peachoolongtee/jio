// engine.js: converge() and roam(). Both are PURE: data in, ranked results out.
// Routing is injected (deps.travelMinutes) so tests are deterministic and OneMap can be plugged in later.
//
// Pipeline (both engines):
//   seed point -> hard filters -> expanding radius -> prune (cap routing cost) -> route -> score -> rank -> explain

import { centroid, fairnessWeights, minimaxCenter, radiusSearch, mockTravelMinutes, haversineKm, walkMinutes } from './geo.js';
import { filterByConstraints, countReasons, relaxationHints, needsVerification, unknownDietNeeds } from './filters.js';
import * as S from './scoring.js';

/** Apply per-plan overrides (start/end) and drop members who opted out. Default start and end = home.
 *  With no home, end = start: the API accepts a member with only a start point. */
function resolveMembers(members, overrides = {}, optedOut = []) {
  return members
    .filter(m => !optedOut.includes(m.id))
    .map(m => {
      const o = overrides[m.id] || {};
      const start = o.start || m.start || m.home;
      return { ...m, start, end: o.end || m.end || m.home || start };
    });
}

/** Occasion-specific weights: a date or birthday is a splurge, so price counts for less than for a study session. */
function occasionWeights(weights, profile) {
  return weights.price === undefined ? weights : { ...weights, price: weights.price * (profile?.priceSensitivity ?? 1) };
}

/**
 * Fail early with a clear message on input the engine cannot score, instead of a TypeError deep inside.
 * An unknown occasion or weather case is a caller bug (a typo or a missing profile), not an empty result.
 */
function validateInput(input, data) {
  if (!data.occasionProfiles[input.occasion]) {
    throw new Error(`unknown occasion "${input.occasion}" (known: ${Object.keys(data.occasionProfiles).join(', ')})`);
  }
  const weatherCase = input.weatherCase ?? 'clear';
  if (!data.weatherCases[weatherCase]) {
    throw new Error(`unknown weatherCase "${weatherCase}" (known: ${Object.keys(data.weatherCases).join(', ')})`);
  }
}

/** Occasion fit 0-100: the precomputed value if the venue has one, otherwise computed from its attributes. */
const occasionFitOf = (venue, occasion, profile) => venue.occasionFit?.[occasion] ?? S.computeOccasionFit(venue, profile);

/**
 * Travel time for one leg. Real routing can fail (OneMap down, no route found) and return null or NaN.
 * Instead of crashing, fall back to the straight-line estimate and count the leg, so the UI can label
 * the result "approximate".
 */
function routedMinutes(tm, from, to, diagnostics) {
  const minutes = tm(from, to);
  if (Number.isFinite(minutes) && minutes >= 0) return minutes;
  diagnostics.approximateLegs = (diagnostics.approximateLegs ?? 0) + 1;
  return mockTravelMinutes(from, to);
}

/** Penalties that do not depend on travel time. */
function staticFactors(venue, c) {
  return {
    weather: S.weatherPenalty(venue, c.weatherByArea),
    preference: S.preferencePenalty(venue, c.members),
    occasion: 100 - occasionFitOf(venue, c.occasion, c.profile),
    rating: S.ratingPenalty(venue),
    price: S.pricePenalty(venue, c.members),
    cdc: S.cdcPenalty(venue),
    antiRepeat: S.antiRepeatPenalty(venue.id, c.history, { today: c.today, groupId: c.groupId }),
    crowd: S.crowdPenalty(venue, c.hour),
  };
}

/**
 * Cheap pre-score using straight-line distance only (no routing). Keeps the best N so we make
 * at most N x members routing calls. It uses fit and rating as well as distance, so a close but
 * poor-fit venue cannot push a much better one out of the shortlist.
 * Occasion fit is computed the same way as in the final score, so a venue without a precomputed
 * occasionFit is not mistaken for a zero fit and cut here.
 */
function prune(candidates, c, keep) {
  if (candidates.length <= keep) return candidates;
  const dn = S.normalizeMinMax(candidates.map(x => x.distanceKm));
  return candidates
    .map((x, i) => ({ x, pre: 0.5 * dn[i] + 0.3 * (100 - occasionFitOf(x.venue, c.occasion, c.profile)) + 0.2 * S.ratingPenalty(x.venue) }))
    .sort((a, b) => a.pre - b.pre)
    .slice(0, keep)
    .map(o => o.x);
}

/**
 * The shortlist plus the options the group is already voting on (input.currentOptionIds) that pass the hard filters
 * and sit inside the 3 km cap (the same cap as search), or inside the radius the group chose. The radius search stops at the first radius with 3 venues
 * and prune keeps 10, so without this a place added by search or swapped in for rain would never be scored.
 */
function withCurrentOptions(shortlist, passed, centre, currentIds = [], maxKm = 3) {
  const have = new Set(shortlist.map(x => x.venue.id));
  const want = new Set(currentIds);
  const extra = passed
    .filter(v => want.has(v.id) && !have.has(v.id))
    .map(venue => ({ venue, distanceKm: haversineKm(centre, venue) }))
    .filter(x => x.distanceKm <= maxKm);
  return [...shortlist, ...extra];
}

function context(input, data, members) {
  return {
    members, occasion: input.occasion, profile: data.occasionProfiles[input.occasion],
    weatherByArea: data.weatherCases[input.weatherCase ?? 'clear'],
    history: data.visitHistory ?? [], today: input.today ?? data._meta.today, groupId: input.groupId ?? null,
    hour: Number(input.dateTime.slice(11, 13)), time: input.dateTime.slice(11, 16),
  };
}

/**
 * What the UI shows under each option, matching the frontend planner so nothing is lost when it switches over:
 *   walkMinutes  from the meeting point (Converge) or the current point (Roam)
 *   crowd        'quiet' | 'moderate' | 'busy' | 'unknown', always shown as an estimate
 *   reasons      up to two short tags ("Near MRT", "Budget friendly"...)
 *   warnings     ['rain'] when rain is likely and the venue is exposed
 *   swap         for a rain warning, the indoor alternative from indoorSwap() below
 */
function optionLabels(r, from, c, swap, homeMaxMinutes = null) {
  const walk = walkMinutes(from, r.venue);
  const crowd = S.crowdLevel(r.venue, c.hour);
  const warnings = S.rainWarning(r.venue, c.weatherByArea) ? ['rain'] : [];
  return {
    walkMinutes: walk, crowd, warnings, swap: warnings.length ? swap : null,
    reasons: S.reasonTags({ venue: r.venue, walkMinutes: walk, crowd, rainy: S.rainLikelyAt(r.venue, c.weatherByArea), homeMaxMinutes, time: c.time }),
  };
}

/**
 * The indoor venue a rain warning suggests instead (the frontend's indoorSwap). It must not be shown already or
 * already be an option the group is voting on (input.currentOptionIds).
 *   1. the best-ranked indoor venue on the scored shortlist;
 *   2. if there is none (the radius search stops once it has 3 venues, so indoor places just further out are
 *      never scored), the nearest indoor venue that passed the hard filters, within the 3 km cap;
 *   3. otherwise null.
 */
function indoorSwap(rows, shownRows, passed, from, input) {
  const taken = new Set([...shownRows.map(r => r.venue.id), ...(input.currentOptionIds ?? [])]);
  const ranked = rows.find(x => x.venue.setting === 'indoor' && !taken.has(x.venue.id));
  if (ranked) return { venueId: ranked.venue.id, name: ranked.venue.name };
  let nearest = null, nearestKm = 3;
  for (const v of passed) {
    if (v.setting !== 'indoor' || taken.has(v.id)) continue;
    const km = haversineKm(from, v);
    if (km <= nearestKm) [nearest, nearestKm] = [v, km];
  }
  return nearest ? { venueId: nearest.id, name: nearest.name } : null;
}

/**
 * Last stop of the day (the frontend's rule): it must be near an MRT station, and the trip HOME counts.
 * Adds a near_mrt constraint and gives returnWorst (longest trip home) a weight, unless the caller set one.
 */
function lastStopRules(input, weights) {
  if (!input.lastStop) return { constraints: input.groupConstraints ?? [], weights };
  const walk = input.lastStopMrtWalkMinutes ?? 10;
  return {
    constraints: [...(input.groupConstraints ?? []).filter(c => !c.startsWith('near_mrt:')), `near_mrt:${walk}`],
    weights: { returnWorst: 15, ...weights },
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
  validateInput(input, data);
  const members = resolveMembers(input.members, input.overrides, input.optedOut);
  if (members.length === 0) throw new Error('converge: no active members');
  const { seed = 'weighted_centroid', pruneTo = 10, topN = 5 } = input;
  const last = lastStopRules(input, input.weights ?? S.DEFAULT_WEIGHTS.converge);
  const baseWeights = last.weights;

  // 1. seed point. input.centre skips this: the itinerary flow picks the meeting area ONCE (meetingArea below)
  //    and then ranks every slot around that same point.
  const starts = members.map(m => m.start);
  const fw = fairnessWeights(members, input.fairnessScaleMinutes ?? 60);
  const centre =
    input.centre ? { lat: input.centre.lat, lng: input.centre.lng } :
    seed === 'minimax' ? minimaxCenter(starts).center :
    seed === 'centroid' ? centroid(starts) :
    centroid(starts, fw);

  // 2. hard filters
  const ctx = {
    members, groupConstraints: last.constraints, dateTime: input.dateTime,
    categories: input.categories ?? ['eat', 'drink'], excludeVenueIds: input.excludeVenueIds ?? [],
    unknownPolicy: input.unknownPolicy ?? 'strict', durationMinutes: input.durationMinutes ?? 0,
  };
  const filt = filterByConstraints(data.venues, ctx);
  const diagnostics = {
    rejectedCounts: countReasons(filt.rejected), passedFilters: filt.passed.length,
    seed: input.centre ? 'given' : seed, activeMembers: members.map(m => m.id),
  };
  if (filt.passed.length === 0) {
    return emptyResult('no_venue_passes_constraints', { centre, hints: relaxationHints(data.venues, ctx), diagnostics });
  }

  // 3. expanding radius, or exactly the radius the group chose (input.radiusMeters)
  const rs = radiusSearch(filt.passed, centre, input.radiusMeters ? { steps: [input.radiusMeters] } : input.radius);
  Object.assign(diagnostics, { radiusUsed: rs.radiusUsed, firstHitRadius: rs.firstHitRadius, inRadius: rs.candidates.length });
  if (rs.candidates.length === 0) {
    const widenToKm = Math.ceil(rs.nearestKm);
    return emptyResult('outside_max_radius', { centre, hints: { nearestKm: rs.nearestKm, widenToKm }, diagnostics });
  }

  // 4. prune, then route. The options the group is already voting on are always routed and scored too.
  const pruned = withCurrentOptions(
    prune(rs.candidates, { occasion: input.occasion, profile: data.occasionProfiles[input.occasion] }, pruneTo),
    filt.passed, centre, input.currentOptionIds, (input.radiusMeters ?? 3000) / 1000,
  );
  diagnostics.routingCalls = pruned.length * members.length * 2;
  const c = context(input, data, members);
  const weights = occasionWeights(baseWeights, c.profile);

  let rows = pruned.map(({ venue, distanceKm }) => {
    const fallbacksBefore = diagnostics.approximateLegs ?? 0;
    const travel = members.map(m => routedMinutes(tm, m.start, venue, diagnostics));
    const back = members.map(m => routedMinutes(tm, venue, m.end, diagnostics));
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
      approximate: (diagnostics.approximateLegs ?? 0) > fallbacksBefore,
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
    r.factors.returnWorst = S.travelPenalty(Math.max(...r.back), ceiling);
    const { score, breakdown } = S.combine(r.factors, weights);
    r.score = score; r.breakdown = breakdown; r.weights = weights;
    r.hasHistory = c.history.length > 0;
  });
  rows.sort((a, b) => a.score - b.score);

  // 7. explain
  const names = Object.fromEntries(members.map(m => [m.id, m.name]));
  const label = c.profile?.label ?? 'meetup';
  const shown = rows.slice(0, topN), swap = indoorSwap(rows, shown, filt.passed, centre, input);
  const toResult = (r, i) => ({
    rank: i + 1, venueId: r.venue.id, name: r.venue.name, venue: r.venue, score: r.score,
    worstMinutes: r.worstMinutes, worstMember: names[r.worstMemberId], meanMinutes: r.meanRaw,
    travelByMember: r.travelByMember, returnByMember: r.returnByMember, distanceFromCentreKm: r.distanceKm,
    breakdown: r.breakdown, explanation: S.explain(r, label), verify: needsVerification(r.venue, members),
    approximate: r.approximate, dietUnknown: unknownDietNeeds(r.venue, members),
    ...optionLabels(r, centre, c, swap, input.lastStop ? Math.max(...r.back) : null),
  });
  const results = shown.map(toResult);
  // Every current option that still fits, in rank order, ranked among all scored venues. An id missing here no longer fits.
  const currentIds = new Set(input.currentOptionIds ?? []);
  const current = rows.map(toResult).filter(r => currentIds.has(r.venueId));
  return { status: 'ok', centre, results, current, regret: S.regretCounterfactual(rows, names), notice: fewOptions(rs), diagnostics };
}

/**
 * Roam: one point, "what is nearby right now". Stateless apart from excludeVenueIds (places just visited).
 * @param {object} input { current:{lat,lng}, members, occasion, dateTime, groupConstraints?, categories?,
 *                         excludeVenueIds?, weatherCase?, groupId?, pruneTo?, topN?, weights?, radius? }
 */
function roam(input, data, deps = {}) {
  const tm = deps.travelMinutes ?? mockTravelMinutes;
  validateInput(input, data);
  const members = input.members.map(m => ({ ...m }));
  const { pruneTo = 10, topN = 5 } = input;
  const baseWeights = input.weights ?? S.DEFAULT_WEIGHTS.roam;
  const ctx = {
    members, groupConstraints: input.groupConstraints ?? [], dateTime: input.dateTime,
    categories: input.categories ?? ['eat', 'drink', 'activity'], excludeVenueIds: input.excludeVenueIds ?? [],
    unknownPolicy: input.unknownPolicy ?? 'strict', durationMinutes: input.durationMinutes ?? 0,
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
  const pruned = prune(rs.candidates, { occasion: input.occasion, profile: data.occasionProfiles[input.occasion] }, pruneTo);
  diagnostics.routingCalls = pruned.length;
  const c = context(input, data, members);
  const weights = occasionWeights(baseWeights, c.profile);

  const rows = pruned.map(({ venue, distanceKm }) => {
    const fallbacksBefore = diagnostics.approximateLegs ?? 0;
    const travelMinutes = routedMinutes(tm, input.current, venue, diagnostics);
    return { venue, distanceKm, travelMinutes, factors: staticFactors(venue, c), approximate: (diagnostics.approximateLegs ?? 0) > fallbacksBefore };
  });
  const ceiling = input.travelCeilingMinutes ?? 30; // Roam is "nearby", so a tighter ceiling than Converge
  rows.forEach(r => {
    r.factors.distance = S.travelPenalty(r.travelMinutes, ceiling);
    const { score, breakdown } = S.combine(r.factors, weights);
    r.score = score; r.breakdown = breakdown; r.weights = weights; r.hasHistory = c.history.length > 0;
  });
  rows.sort((a, b) => a.score - b.score);
  const label = c.profile?.label ?? 'meetup';
  const shown = rows.slice(0, topN), swap = indoorSwap(rows, shown, filt.passed, input.current, input);
  const results = shown.map((r, i) => ({
    rank: i + 1, venueId: r.venue.id, name: r.venue.name, venue: r.venue, score: r.score,
    travelMinutes: r.travelMinutes, distanceKm: r.distanceKm, breakdown: r.breakdown, explanation: S.explain(r, label),
    verify: needsVerification(r.venue, members), approximate: r.approximate, dietUnknown: unknownDietNeeds(r.venue, members),
    ...optionLabels(r, input.current, c, swap),
  }));
  return { status: 'ok', centre: input.current, results, notice: fewOptions(rs), diagnostics };
}

/**
 * Where should the group meet? Always answers with a NAMED place (MRT station or neighbourhood) for the UI,
 * plus each person's travel time to it. Then pass result.centre to converge() as input.centre for every slot.
 *
 * method:
 *   'station' (default, the frontend team's rule): try candidate areas and pick the one where the LONGEST
 *     journey is shortest; a tie goes to the lower fairness-weighted average, so travel debt only breaks ties.
 *     By default EVERY area is tried (exact). That is members x areas routing calls (37 areas today), so with real
 *     OneMap routing pass maxCandidates to try only the areas nearest the minimax centre. Measured on 2,000 random
 *     groups: 8 candidates missed the fairest area 3.4% of the time (up to 7.5 min worse); 16 never did.
 *   'weighted_centroid' | 'centroid' | 'minimax': the engine's own seed points (debt pulls the weighted centroid
 *     toward people who travelled more), then named after the nearest area. The meeting point is the exact centre.
 *
 * @param input { members, overrides?, optedOut?, method?, maxCandidates?, fairnessScaleMinutes? }
 * @param data  { areas: [{ id, name, lat, lng }] }
 */
function meetingArea(input, data, deps = {}) {
  const tm = deps.travelMinutes ?? mockTravelMinutes;
  const members = resolveMembers(input.members, input.overrides, input.optedOut);
  if (members.length === 0) throw new Error('meetingArea: no active members');
  if (!data.areas?.length) throw new Error('meetingArea: data.areas is empty');
  const method = input.method ?? 'station';
  const starts = members.map(m => m.start);
  const fw = fairnessWeights(members, input.fairnessScaleMinutes ?? 60);
  const wSum = fw.reduce((a, b) => a + b, 0);
  const nearestArea = p => data.areas.reduce((best, a) => (haversineKm(p, a) < haversineKm(p, best) ? a : best));

  const diagnostics = { routingCalls: 0 };
  const journeys = point => {
    const travel = members.map(m => routedMinutes(tm, m.start, point, diagnostics));
    diagnostics.routingCalls += travel.length;
    return { travel, worst: Math.max(...travel), fairMean: travel.reduce((s, t, i) => s + fw[i] * t, 0) / wSum };
  };

  let area, centre, best;
  if (method === 'station') {
    const fairest = starts.length <= 12 ? minimaxCenter(starts).center : centroid(starts);
    const candidates = [...data.areas]
      .sort((a, b) => haversineKm(fairest, a) - haversineKm(fairest, b))
      .slice(0, input.maxCandidates ?? data.areas.length);
    for (const a of candidates) {
      const j = journeys(a);
      if (!best || j.worst < best.j.worst || (j.worst === best.j.worst && j.fairMean < best.j.fairMean)) best = { a, j };
    }
    area = best.a;
    centre = { lat: area.lat, lng: area.lng };
  } else {
    centre =
      method === 'minimax' ? minimaxCenter(starts).center :
      method === 'centroid' ? centroid(starts) :
      method === 'weighted_centroid' ? centroid(starts, fw) :
      null;
    if (!centre) throw new Error(`meetingArea: unknown method "${method}"`);
    area = nearestArea(centre);
    best = { j: journeys(centre) };
  }

  const { travel, worst } = best.j;
  const worstIdx = travel.indexOf(worst);
  return {
    method,
    area: { id: area.id, name: area.name, lat: area.lat, lng: area.lng },
    centre,
    distanceFromAreaKm: haversineKm(centre, area),
    worstMinutes: worst, worstMember: members[worstIdx].name ?? members[worstIdx].id,
    meanMinutes: travel.reduce((a, b) => a + b, 0) / travel.length,
    travelByMember: Object.fromEntries(members.map((m, i) => [m.id, travel[i]])),
    approximate: (diagnostics.approximateLegs ?? 0) > 0,
    diagnostics: { ...diagnostics, activeMembers: members.map(m => m.id) },
  };
}

/**
 * Search by name, to add an option by hand (the frontend's searchVenuesForSlot). Matches the venue name, its
 * area, its address (so a postal code finds it), the name of a stall at a CDC site, or any id in `alsoMatch` (places
 * the route found another way: by Google, or at a postal code's building). Every match says whether it fits the slot and, if not, why:
 * the hard-filter reasons ('closed', 'diet:halal', 'category', 'near_mrt'...) plus 'far' when it is more than
 * maxKm (default 3, the engine's cap) from the meeting point. Fitting places first, then by walking time.
 * @param input { query, centre, dateTime, members?, durationMinutes?, categories?, lastStop?, groupConstraints?,
 *                unknownPolicy?, maxKm?, limit? (default 12), alsoMatch? (venue ids) }
 */
function searchVenues(input, data) {
  const q = input.query.trim().toLowerCase();
  if (!q) return [];
  // A place matches by its name, area, address (so a postal code finds it) or a stall's name, or because the caller
  // already knows it is a match (`alsoMatch`: ids found by Google or at a postal code's building).
  const alsoMatch = new Set(input.alsoMatch ?? []);
  const matches = data.venues
    .map(v => ({ v, stall: v.stalls?.find(st => st.name.toLowerCase().includes(q))?.name ?? null }))
    .filter(({ v, stall }) => alsoMatch.has(v.id) || v.name.toLowerCase().includes(q) || (v.area ?? '').toLowerCase().includes(q) || (typeof v.address === 'string' && v.address.toLowerCase().includes(q)) || stall);

  const ctx = {
    members: input.members ?? [], groupConstraints: lastStopRules(input, {}).constraints, dateTime: input.dateTime,
    categories: input.categories ?? ['eat', 'drink', 'shop', 'activity'],
    unknownPolicy: input.unknownPolicy ?? 'strict', durationMinutes: input.durationMinutes ?? 0,
  };
  const reasonsById = new Map(filterByConstraints(matches.map(m => m.v), ctx).rejected.map(r => [r.venue.id, r.reasons]));
  const maxKm = input.maxKm ?? 3;

  return matches
    .map(({ v, stall }) => {
      const distanceKm = haversineKm(input.centre, v);
      const unfit = [...(reasonsById.get(v.id) ?? []), ...(distanceKm > maxKm ? ['far'] : [])];
      return {
        venueId: v.id, name: v.name, area: v.area, category: v.category, source: v.source, matchedStall: stall,
        walkMinutes: walkMinutes(input.centre, v), distanceKm, fits: unfit.length === 0, unfit,
      };
    })
    .sort((a, b) => Number(!a.fits) - Number(!b.fits) || a.walkMinutes - b.walkMinutes)
    .slice(0, input.limit ?? 12);
}

export { converge, roam, meetingArea, searchVenues, resolveMembers, occasionWeights };
