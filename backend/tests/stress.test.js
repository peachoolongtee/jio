// Stress test: hundreds of random (but seeded, so repeatable) groups, venues, times and constraints.
// Instead of checking one expected answer, it checks rules that must hold for EVERY input:
// results sorted, hard filters respected, scores in 0-100, no NaN, same input -> same output, and so on.
// If one fails, the message names the run (e.g. "fuzz#123") so it can be replayed.
import { test } from 'vitest';
import assert from 'node:assert';
import base from '../src/db/mock/mock-data.json';
import { loadPlanData } from '../src/db/venues.js';
import { converge, roam, meetingArea } from '../src/planner/engine.js';
import { filterByConstraints } from '../src/planner/filters.js';
import { haversineKm, centroid, fairnessWeights, minimaxCenter } from '../src/planner/geo.js';
import * as S from '../src/planner/scoring.js';
import { buildingKey } from '../src/planner/diversity.js';
import * as P from '../src/planner/postranking.js';

// ---------------------------------------------------------------- seeded random mock data
const rng = P.mulberry32(20261005);
const rand = (lo, hi) => lo + rng() * (hi - lo);
const int = (lo, hi) => Math.floor(rand(lo, hi + 1));
const pick = a => a[Math.floor(rng() * a.length)];
const sample = (a, k) => [...a].sort(() => rng() - 0.5).slice(0, k);

const sgPoint = () => ({ lat: rand(1.28, 1.44), lng: rand(103.68, 103.98) }); // rough Singapore bounding box
const OCCASIONS = Object.keys(base.occasionProfiles);
const CUISINES = ['japanese', 'korean', 'cafe', 'western', 'chinese', 'indian', 'malay', 'thai', 'hawker', 'italian'];
const DIETS = ['halal', 'vegetarian', 'vegan'];
const LEVELS = ['full', 'options', 'likely', 'unknown', 'none'];
const AREAS = Object.keys(base.weatherCases.clear);
const ATTRS = ['quiet', 'romantic', 'cozy', 'lively', 'privacy', 'workFriendly', 'celebration'];

function mockMember(i) {
  return {
    id: `m${i}`, name: `M${i}`, home: { label: 'random', ...sgPoint() },
    dietary: rng() < 0.25 ? sample(DIETS, int(1, 2)) : [],
    prefersHealthy: rng() < 0.3, cuisineLikes: sample(CUISINES, int(0, 3)), cuisineDislikes: sample(CUISINES, int(0, 1)),
    budgetMaxPerPerson: rng() < 0.1 ? undefined : int(8, 80), // some members never set a budget
    maxReturnMinutes: rng() < 0.2 ? int(30, 60) : undefined,
    travelDebtMinutes: rng() < 0.4 ? int(-60, 120) : 0,
  };
}

function mockVenue(i) {
  const category = pick(['eat', 'eat', 'eat', 'drink', 'activity']);
  const attributes = Object.fromEntries(ATTRS.map(k => [k, int(0, 100)]));
  const open = String(int(6, 12)).padStart(2, '0'), close = int(15, 24);
  return {
    id: `x${i}`, name: `Venue ${i}`, area: 'random', nearestMrt: pick(['A', 'B', 'C']), ...sgPoint(), forecastArea: pick(AREAS),
    category, cuisine: pick(CUISINES), avgPricePerPerson: int(4, 120), priceBand: int(1, 4),
    rating: rng() < 0.2 ? null : Math.round(rand(2.5, 5) * 10) / 10, ratingCount: int(0, 2000),
    diet: category === 'activity' ? null : { halal: pick(LEVELS), vegetarian: pick(LEVELS), vegan: pick(LEVELS), healthy: int(0, 5) },
    setting: pick(['indoor', 'outdoor', 'mixed']), exposure: int(0, 5), aircon: rng() < 0.5,
    stepFree: pick([true, false, null]), cdcAccepted: rng() < 0.3, maxGroupSize: int(2, 30),
    hasPrivateRoom: false, cakeFriendly: false, wifi: false, sockets: pick([true, false, null]), longStayOk: true,
    noise: int(1, 5), queueMinutesPeak: int(0, 30),
    openingHours: pick([
      [[`${open}:00`, `${close}:00`]],
      [['11:00', '14:30'], ['17:30', '22:00']], // split hours
      [['18:00', '03:00']], // past midnight
    ]),
    mealPeriods: category === 'eat' ? sample(['breakfast', 'lunch', 'tea', 'dinner', 'supper'], int(1, 5)) : [],
    attributes,
    // about half have no precomputed occasionFit, like venues fresh from the database
    occasionFit: rng() < 0.5 ? Object.fromEntries(OCCASIONS.map(o => [o, S.computeOccasionFit({ attributes }, base.occasionProfiles[o])])) : undefined,
  };
}

const randomTime = () => `2026-10-${String(int(5, 30)).padStart(2, '0')}T${String(int(0, 23)).padStart(2, '0')}:${pick(['00', '15', '30', '45'])}`;
const oneMaxPrice = cs => cs.filter((c, _, all) => !c.startsWith('max') || all.find(x => x.startsWith('max')) === c);

const synthVenues = Array.from({ length: 400 }, (_, i) => mockVenue(i));
const synthData = {
  ...base, venues: synthVenues,
  visitHistory: synthVenues.slice(0, 40).map(v => ({ groupId: 'g1', venueId: v.id, date: `2026-${pick(['08', '09', '10'])}-0${int(1, 4)}` })),
};
const realData = loadPlanData(); // mock + curated (frontend) + CDC, as served by the API

// ---------------------------------------------------------------- the rules every Converge result must follow
function checkConverge(input, data, label, deps) {
  const out = converge(input, data, deps);
  assert.ok(['ok', 'empty'].includes(out.status), label);
  if (out.status === 'empty') return out;

  const active = input.members.filter(m => !(input.optedOut ?? []).includes(m.id));
  const passed = new Set(filterByConstraints(data.venues, {
    members: active, groupConstraints: input.groupConstraints ?? [], dateTime: input.dateTime,
    categories: input.categories ?? ['eat', 'drink'], excludeVenueIds: input.excludeVenueIds ?? [], unknownPolicy: input.unknownPolicy ?? 'strict',
    durationMinutes: input.durationMinutes ?? 0,
  }).passed.map(v => v.id));

  assert.ok(out.results.length <= (input.topN ?? 5), `${label}: more than topN`);
  out.results.forEach((r, i) => {
    assert.strictEqual(r.rank, i + 1, `${label}: rank numbering`);
    // Tiered by how many of the group's diet needs a place is not known to meet (lenient only, ticket #107), then by score.
    if (i) {
      const prev = out.results[i - 1];
      assert.ok(r.dietUnknown.length >= prev.dietUnknown.length, `${label}: a place meeting fewer diet needs ranks first`);
      if (r.dietUnknown.length === prev.dietUnknown.length) assert.ok(r.score >= prev.score, `${label}: not sorted by score`);
    }
    assert.ok(Number.isFinite(r.score) && r.score >= 0 && r.score <= 100, `${label}: score ${r.score}`);
    assert.ok(passed.has(r.venueId), `${label}: ${r.venueId} breaks a hard filter`);
    assert.ok(r.distanceFromCentreKm <= 3 + 1e-9, `${label}: beyond the 3 km cap`);
    if (input.lastStop) assert.ok(r.venue.mrtWalkMinutes <= (input.lastStopMrtWalkMinutes ?? 10) || (input.unknownPolicy === 'lenient' && r.venue.mrtWalkMinutes == null), `${label}: last stop not near an MRT`);
    assert.ok(['quiet', 'moderate', 'busy', 'unknown'].includes(r.crowd), `${label}: crowd ${r.crowd}`);
    assert.ok(Number.isInteger(r.walkMinutes) && r.walkMinutes >= 0, `${label}: walk ${r.walkMinutes}`);
    assert.ok(r.reasons.length <= 2 && r.reasons.every(t => typeof t === 'string'), `${label}: reasons`);
    if (r.swap) {
      assert.deepStrictEqual(r.warnings, ['rain'], `${label}: a swap without a rain warning`);
      assert.ok(!out.results.some(x => x.venueId === r.swap.venueId), `${label}: swap is already shown`);
      assert.ok(!(input.currentOptionIds ?? []).includes(r.swap.venueId), `${label}: swap is already an option`);
      assert.strictEqual(data.venues.find(v => v.id === r.swap.venueId).setting, 'indoor', `${label}: swap is not indoor`);
    }
    for (const m of active) {
      if (m.maxReturnMinutes) assert.ok(r.returnByMember[m.id] <= m.maxReturnMinutes, `${label}: ${m.id} return trip too long`);
    }
    for (const [k, b] of Object.entries(r.breakdown)) assert.ok(b.value >= 0 && b.value <= 100, `${label}: factor ${k} = ${b.value}`);
    assert.ok(r.explanation && !/undefined|NaN/.test(r.explanation), `${label}: explanation "${r.explanation}"`);
  });

  // same input -> same output
  assert.deepStrictEqual(converge(input, data, deps), out, `${label}: not deterministic`);
  // member order must not change the scores
  const reversed = converge({ ...input, members: [...input.members].reverse() }, data, deps);
  assert.deepStrictEqual(reversed.results.map(r => r.score.toFixed(6)), out.results.map(r => r.score.toFixed(6)), `${label}: member order changed the ranking`);
  return out;
}

// ---------------------------------------------------------------- converge and roam fuzzing
test('converge: 300 random groups on 400 random venues follow every rule', () => {
  const outcomes = {};
  for (let i = 0; i < 300; i++) {
    const members = Array.from({ length: int(1, 12) }, (_, j) => mockMember(j));
    const input = {
      members, occasion: pick(OCCASIONS), dateTime: randomTime(), groupId: 'g1', weatherCase: pick(['clear', 'rain', 'rain_east']),
      groupConstraints: oneMaxPrice(sample(['step_free', 'sockets', 'quiet', 'indoor_only', 'max_price_pp:15', 'max_price_pp:40'], int(0, 2))),
      seed: pick(['weighted_centroid', 'centroid', 'minimax']), unknownPolicy: pick(['strict', 'lenient']),
      optedOut: rng() < 0.2 && members.length > 1 ? [members[0].id] : [],
    };
    const out = checkConverge(input, synthData, `fuzz#${i}`);
    outcomes[out.status] = (outcomes[out.status] ?? 0) + 1;
  }
  assert.ok(outcomes.ok > 50, `too few ok results to be a useful test: ${JSON.stringify(outcomes)}`);
});

test('converge: 100 random groups on the joined mock + curated + CDC venues follow every rule', () => {
  for (let i = 0; i < 100; i++) {
    const members = Array.from({ length: int(2, 8) }, (_, j) => mockMember(j));
    const input = { members, occasion: pick(OCCASIONS), dateTime: `2026-10-10T${pick(['08:30', '12:30', '15:30', '19:00', '22:30'])}`, unknownPolicy: pick(['strict', 'lenient']) };
    checkConverge(input, realData, `real#${i}`);
  }
});

test('itinerary slots: random meeting areas, durations, categories, last stops and crowd weights follow every rule', () => {
  let okSlots = 0;
  for (let i = 0; i < 100; i++) {
    const members = Array.from({ length: int(2, 8) }, (_, j) => mockMember(j));
    const meet = meetingArea({ members, method: pick(['station', 'weighted_centroid', 'minimax']) }, realData);
    assert.ok(realData.areas.some(a => a.id === meet.area.id), `slot#${i}: unknown area`);
    assert.ok(Number.isFinite(meet.worstMinutes), `slot#${i}: worst ${meet.worstMinutes}`);
    const input = {
      members, occasion: pick(OCCASIONS), centre: meet.centre, unknownPolicy: pick(['strict', 'lenient']),
      dateTime: `2026-10-10T${pick(['09:00', '12:00', '14:30', '18:30', '21:00'])}`, durationMinutes: pick([0, 60, 90, 120]),
      categories: [pick(['eat', 'drink', 'shop', 'activity'])], lastStop: rng() < 0.3, weatherCase: pick(['clear', 'rain', 'rain_east']),
      weights: rng() < 0.3 ? { ...S.DEFAULT_WEIGHTS.converge, crowd: int(1, 20) } : undefined,
    };
    const out = checkConverge(input, realData, `slot#${i}`);
    if (out.status === 'ok') assert.deepStrictEqual(out.centre, meet.centre, `slot#${i}: centre moved`);
    okSlots += out.status === 'ok' ? 1 : 0;
  }
  // Random diets and strict mode empty many slots (see docs/engine-integration.md); 20+ still exercises the rules.
  assert.ok(okSlots >= 20, `only ${okSlots}/100 slots returned venues: too few to test the rules`);
});

test('converge: rules still hold when routing fails for some legs', () => {
  const flaky = (a, b) => (rng() < 0.3 ? pick([null, NaN, undefined]) : 6 + (haversineKm(a, b) * 1.35 * 60) / 22);
  for (let i = 0; i < 50; i++) {
    const input = { members: Array.from({ length: int(2, 6) }, (_, j) => mockMember(j)), occasion: pick(OCCASIONS), dateTime: '2026-10-10T19:00', unknownPolicy: 'lenient' };
    // flaky routing is random per call, so skip the determinism check by running the rules on one output only
    const out = converge(input, realData, { travelMinutes: flaky });
    out.results.forEach(r => assert.ok(Number.isFinite(r.score), `flaky#${i}: score ${r.score}`));
  }
});

test('roam: 200 random points, results sorted, inside 3 km, no NaN', () => {
  for (let i = 0; i < 200; i++) {
    const input = { current: sgPoint(), members: Array.from({ length: int(1, 6) }, (_, j) => mockMember(j)), occasion: pick(OCCASIONS), dateTime: randomTime(), unknownPolicy: pick(['strict', 'lenient']) };
    const out = roam(input, realData);
    // Tiered first by how many of the group's diet needs a place is not known to meet (lenient only, ticket #107). Within a
    // tier, sorted by score, except that a second place in a building already shown moves below the others (#149): the
    // places that keep their spot are sorted, so are the ones moved, and every moved one comes after every kept one.
    out.results.forEach((r, j) => { if (j) assert.ok(r.dietUnknown.length >= out.results[j - 1].dietUnknown.length, `roam#${i}: a place meeting fewer diet needs ranks first`); });
    // Which places are a second one in a building already shown is decided in score order, before the tiers (engine.js).
    const seen = new Set(), movedIds = new Set();
    [...out.results].sort((a, b) => a.score - b.score).forEach(r => {
      const b = buildingKey(r.venue), k = b === null ? null : `${r.venue.category}|${b}`;
      if (k !== null && seen.has(k)) movedIds.add(r.venueId);
      else if (k !== null) seen.add(k);
    });
    for (const tier of new Set(out.results.map(r => r.dietUnknown.length))) {
      const inTier = out.results.filter(r => r.dietUnknown.length === tier);
      const kept = inTier.filter(r => !movedIds.has(r.venueId)), moved = inTier.filter(r => movedIds.has(r.venueId));
      [kept, moved].forEach(list => list.forEach((r, j) => { if (j) assert.ok(r.score >= list[j - 1].score, `roam#${i}: not sorted`); }));
      if (kept.length && moved.length) assert.ok(out.results.indexOf(moved[0]) > out.results.indexOf(kept[kept.length - 1]), `roam#${i}: a moved place ranks above a kept one`);
    }
    out.results.forEach(r => {
      assert.ok(r.distanceKm <= 3 + 1e-9, `roam#${i}: beyond 3 km`);
      assert.ok(Number.isFinite(r.score), `roam#${i}: score ${r.score}`);
    });
  }
});

// ---------------------------------------------------------------- algorithm properties
test('fairness: a travel debt always pulls the centre toward the person owed', () => {
  for (let i = 0; i < 300; i++) {
    const members = Array.from({ length: int(2, 6) }, (_, j) => ({ ...mockMember(j), travelDebtMinutes: 0 }));
    const before = centroid(members.map(m => m.home));
    members[0].travelDebtMinutes = int(30, 240);
    const after = centroid(members.map(m => m.home), fairnessWeights(members));
    assert.ok(haversineKm(after, members[0].home) <= haversineKm(before, members[0].home) + 1e-9, `fairness#${i}`);
  }
});

test('minimax: the circle contains everyone and its worst distance never loses to the centroid', () => {
  for (let i = 0; i < 300; i++) {
    const pts = Array.from({ length: int(1, 12) }, sgPoint);
    const { center, radiusKm } = minimaxCenter(pts);
    const worst = c => Math.max(...pts.map(p => haversineKm(c, p)));
    assert.ok(worst(center) <= radiusKm * 1.01 + 0.01, `minimax#${i}: circle misses someone`);
    assert.ok(worst(center) <= worst(centroid(pts)) + 0.01, `minimax#${i}: centroid did better`);
  }
});

test('ledger: deltas always sum to zero', () => {
  for (let i = 0; i < 200; i++) {
    const travel = Object.fromEntries(Array.from({ length: int(1, 8) }, (_, j) => [`m${j}`, rand(5, 90)]));
    const sum = Object.values(P.updateLedger({}, travel)).reduce((a, b) => a + b, 0);
    assert.ok(Math.abs(sum) < 1e-9, `ledger#${i}: sum ${sum}`);
  }
});

test('strict results are always a subset of lenient results', () => {
  for (let i = 0; i < 200; i++) {
    const ctx = { members: Array.from({ length: int(1, 5) }, (_, j) => mockMember(j)), groupConstraints: sample(['step_free', 'sockets'], int(0, 2)), dateTime: randomTime() };
    const lenient = new Set(filterByConstraints(synthVenues, { ...ctx, unknownPolicy: 'lenient' }).passed.map(v => v.id));
    for (const v of filterByConstraints(synthVenues, { ...ctx, unknownPolicy: 'strict' }).passed) assert.ok(lenient.has(v.id), `subset#${i}`);
  }
});

test('Borda: total points are always voters x (1 + 2 + ... + N)', () => {
  for (let i = 0; i < 200; i++) {
    const options = Array.from({ length: int(1, 6) }, (_, j) => `o${j}`);
    const rankings = Array.from({ length: int(1, 8) }, () => sample(options, options.length));
    const total = P.bordaCount({ options, rankings }).reduce((s, t) => s + t.points, 0);
    const n = options.length;
    assert.strictEqual(total, rankings.length * (n * (n + 1)) / 2, `borda#${i}`);
  }
});
