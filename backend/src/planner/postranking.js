'use strict';
// postranking.js: everything that happens AFTER the engine ranks venues.
// Ledger, voting, vetoes, random picker, Rain Check and recalculation.

const { converge } = require('./engine');

// ---------------------------------------------------------------- commute ledger
/**
 * Update the fairness ledger after a meetup.
 *   delta = (your actual travel) - (average actual travel of everyone who attended)
 *   positive balance = you travelled MORE than your share, so you are "owed" a closer venue next time.
 * Deltas sum to zero across attendees, so the ledger only moves effort around, it never creates it.
 * Members who did not attend are untouched. Returns a new object.
 * @param {Object<string, number>} balances       { memberId: balanceMinutes }
 * @param {Object<string, number>} travelByMember { memberId: actualMinutes } attendees only
 */
function updateLedger(balances, travelByMember) {
  const ids = Object.keys(travelByMember);
  if (ids.length === 0) return { ...balances };
  const avg = ids.reduce((s, id) => s + travelByMember[id], 0) / ids.length;
  const next = { ...balances };
  for (const id of ids) next[id] = (next[id] ?? 0) + (travelByMember[id] - avg);
  return next;
}

/** Run weekly so old imbalances fade across a term. */
function decayLedger(balances, factor = 0.9) {
  return Object.fromEntries(Object.entries(balances).map(([id, b]) => [id, b * factor]));
}

// ---------------------------------------------------------------- voting
/**
 * Borda count. Each voter ranks options best to worst; position 0 earns N points, position 1 earns N-1, etc.
 * Unranked options earn 0 from that voter. Ties are broken by tieBreakOrder (the engine's rank), so the
 * result is deterministic and testable.
 * @returns {{id:string, points:number}[]} best first
 */
function bordaCount({ options, rankings, tieBreakOrder = options }) {
  const n = options.length;
  const points = Object.fromEntries(options.map(o => [o, 0]));
  for (const ranking of rankings) {
    ranking.forEach((o, pos) => { if (o in points) points[o] += n - pos; });
  }
  return options
    .map(id => ({ id, points: points[id] }))
    .sort((a, b) => b.points - a.points || tieBreakOrder.indexOf(a.id) - tieBreakOrder.indexOf(b.id));
}

/**
 * Veto tokens: each member can veto at most ONE option. Scarcity forces people to object only to what matters.
 * If vetoes would remove every option, they are ignored (and we say so) so the group is never left with nothing.
 * @param vetoes [{ memberId, optionId }]
 */
function applyVetoes({ options, vetoes }) {
  const used = new Set();
  for (const v of vetoes) {
    if (used.has(v.memberId)) throw new Error(`applyVetoes: ${v.memberId} already used their veto`);
    used.add(v.memberId);
  }
  const vetoed = new Set(vetoes.map(v => v.optionId));
  const remaining = options.filter(o => !vetoed.has(o));
  if (remaining.length === 0) return { options, ignoredVetoes: true };
  return { options: remaining, ignoredVetoes: false };
}

/** Veto first, then Borda among what is left. */
function decideVote({ options, rankings, vetoes = [], tieBreakOrder }) {
  const { options: left, ignoredVetoes } = applyVetoes({ options, vetoes });
  const tally = bordaCount({ options: left, rankings, tieBreakOrder: tieBreakOrder ?? options });
  return { winner: tally[0].id, tally, ignoredVetoes };
}

// ---------------------------------------------------------------- random picker
/** Small seeded random number generator so tests are repeatable. */
function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * "Surprise us". Uniform by default. Pass weights (higher = more likely) so better-ranked options
 * are favoured but anything on the shortlist can still win.
 */
function randomPick(items, { rng = Math.random, weights = null } = {}) {
  if (items.length === 0) throw new Error('randomPick: nothing to pick from');
  if (weights === null) return items[Math.floor(rng() * items.length)];
  const total = weights.reduce((a, b) => a + b, 0);
  let r = rng() * total;
  for (let i = 0; i < items.length; i++) { r -= weights[i]; if (r < 0) return items[i]; }
  return items[items.length - 1];
}

// ---------------------------------------------------------------- Rain Check
/**
 * If rain is likely at a confirmed venue that is not sheltered, re-run converge with indoor_only and
 * propose a swap, preferring the same MRT station so the plan changes as little as possible.
 */
function rainCheck({ input, confirmedVenueId, data, threshold = 0.6, minExposure = 2 }) {
  const venue = data.venues.find(v => v.id === confirmedVenueId);
  if (!venue) throw new Error(`rainCheck: unknown venue ${confirmedVenueId}`);
  const rainRisk = data.weatherCases[input.weatherCase ?? 'clear'][venue.forecastArea].rainRisk;
  if (!(rainRisk >= threshold && venue.exposure >= minExposure)) {
    return { needed: false, rainRisk };
  }
  const next = converge({ ...input, groupConstraints: [...(input.groupConstraints ?? []), 'indoor_only'], topN: 10 }, data);
  const options = next.results.filter(r => r.venueId !== confirmedVenueId);
  const sameStation = options.filter(r => r.venue.nearestMrt === venue.nearestMrt);
  const ordered = [...sameStation, ...options.filter(r => !sameStation.includes(r))];
  return {
    needed: true, rainRisk, original: confirmedVenueId,
    proposal: ordered[0] ?? null, sameStation: sameStation.length > 0, alternatives: ordered.slice(1, 4),
  };
}

// ---------------------------------------------------------------- recalculation
function applyChange(input, change) {
  if (change.optOut) return { ...input, optedOut: [...(input.optedOut ?? []), change.optOut] };
  if (change.setStart) {
    const { id, location } = change.setStart;
    return { ...input, overrides: { ...input.overrides, [id]: { ...(input.overrides?.[id]), start: location } } };
  }
  if (change.setEnd) {
    const { id, location } = change.setEnd;
    return { ...input, overrides: { ...input.overrides, [id]: { ...(input.overrides?.[id]), end: location } } };
  }
  if (change.addMember) return { ...input, members: [...input.members, change.addMember] };
  throw new Error('recalculate: unknown change type');
}

/**
 * One entry point for every "something changed" event: opt-out, new start, new end, new member.
 * Re-runs converge with the updated input and reports what moved, so the UI can say
 * "Darius left, the meeting point moved east and 2 new options appeared".
 */
function recalculate(input, change, data, deps) {
  const before = converge(input, data, deps);
  const after = converge(applyChange(input, change), data, deps);
  const b = before.results.map(r => r.venueId);
  const a = after.results.map(r => r.venueId);
  return {
    before, after,
    entered: a.filter(id => !b.includes(id)), left: b.filter(id => !a.includes(id)),
    topChanged: b[0] !== a[0],
  };
}

module.exports = {
  updateLedger, decayLedger, bordaCount, applyVetoes, decideVote, mulberry32, randomPick, rainCheck, recalculate,
};
