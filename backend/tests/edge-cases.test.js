// Regression tests for bugs found by the stress test (tests/stress.test.js). One test per bug.
import { test } from 'vitest';
import assert from 'node:assert';
import data from '../src/db/mock/mock-data.json';
import { converge, roam } from '../src/planner/engine.js';
import { isOpenAt } from '../src/planner/filters.js';
import * as S from '../src/planner/scoring.js';

const member = id => data.members.find(m => m.id === id);
const orchard = { lat: 1.3048, lng: 103.8318 };
const dinner = { occasion: 'casual_meal', dateTime: '2026-10-10T19:00' };
const allFinite = out => out.results.every(r => Number.isFinite(r.score));

// ---------------- 1. routing failure
test('routing that returns null or NaN falls back to the estimate and marks results approximate', () => {
  for (const bad of [null, NaN, undefined, -5]) {
    const out = converge({ ...dinner, members: [member('ian'), member('faith')] }, data, { travelMinutes: () => bad });
    assert.strictEqual(out.status, 'ok', `routing returned ${bad}`);
    assert.ok(allFinite(out));
    assert.ok(out.results.every(r => r.approximate === true));
    assert.ok(out.diagnostics.approximateLegs > 0);
  }
});
test('routing that works marks nothing approximate', () => {
  const out = converge({ ...dinner, members: [member('ian'), member('faith')] }, data);
  assert.ok(out.results.every(r => r.approximate === false));
  assert.strictEqual(out.diagnostics.approximateLegs, undefined);
});
test('roam also survives a routing failure', () => {
  const out = roam({ ...dinner, current: orchard, members: [member('faith')] }, data, { travelMinutes: () => null });
  assert.strictEqual(out.status, 'ok');
  assert.ok(allFinite(out) && out.results.every(r => r.approximate));
});

// ---------------- 2. missing budget
test('a member with no budget does not turn every score into NaN', () => {
  const noBudget = { ...member('faith'), budgetMaxPerPerson: undefined };
  const out = converge({ ...dinner, members: [member('ian'), noBudget] }, data);
  assert.strictEqual(out.status, 'ok');
  assert.ok(allFinite(out));
});
test('pricePenalty: budgets that are missing or 0 are ignored; nobody with a budget = no penalty', () => {
  const v = { avgPricePerPerson: 30 };
  assert.strictEqual(S.pricePenalty(v, [{ budgetMaxPerPerson: 20 }, { budgetMaxPerPerson: undefined }, { budgetMaxPerPerson: 0 }]), 50);
  assert.strictEqual(S.pricePenalty(v, [{}, { budgetMaxPerPerson: 0 }]), 0);
});

// ---------------- 3. unknown occasion / weather case
test('unknown occasion or weatherCase throws a clear error, not a TypeError', () => {
  const members = [member('faith')];
  assert.throws(() => converge({ ...dinner, occasion: 'brunch', members }, data), /unknown occasion "brunch"/);
  assert.throws(() => roam({ ...dinner, occasion: 'brunch', current: orchard, members }, data), /unknown occasion "brunch"/);
  assert.throws(() => converge({ ...dinner, weatherCase: 'storm', members }, data), /unknown weatherCase "storm"/);
});

// ---------------- 4. overnight opening hours
test('isOpenAt: hours that run past midnight', () => {
  const supper = { openingHours: [['22:00', '02:00']] };
  assert.strictEqual(isOpenAt(supper, '2026-10-10T23:30'), true);
  assert.strictEqual(isOpenAt(supper, '2026-10-11T01:15'), true);
  assert.strictEqual(isOpenAt(supper, '2026-10-11T02:00'), false); // closing time is exclusive
  assert.strictEqual(isOpenAt(supper, '2026-10-10T15:00'), false);
  assert.strictEqual(isOpenAt({ openingHours: [['18:00', '24:00']] }, '2026-10-10T23:59'), true); // "24:00" still works
});
test('a supper place open past midnight can be recommended at 00:30', () => {
  const v = data.venues.find(x => x.category === 'eat');
  const supper = { ...v, id: 'supper', lat: orchard.lat, lng: orchard.lng, openingHours: [['18:00', '03:00']], mealPeriods: ['dinner', 'supper'],
    diet: { ...v.diet, halal: 'full', vegetarian: 'full', vegan: 'full' }, maxGroupSize: 20 };
  const out = roam({ ...dinner, dateTime: '2026-10-11T00:30', current: orchard, members: [member('faith')] }, { ...data, venues: [supper] });
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.results[0].venueId, 'supper');
});

// ---------------- 5. pruning without a precomputed occasionFit
test('prune computes occasion fit for venues without a precomputed value instead of treating it as 0', () => {
  // A: right at the centre but a poor fit (precomputed 0). B: 100 m further, a perfect fit, but no precomputed
  // occasionFit (like a venue fresh from the database). With pruneTo 1 only one survives to scoring.
  // Before the fix, B's missing value counted as fit 0, so A won the shortlist.
  const base = { ...data.venues.find(x => x.category === 'drink'), openingHours: [['00:00', '24:00']], maxGroupSize: 30 };
  const attrs = n => Object.fromEntries(Object.keys(base.attributes).map(k => [k, n]));
  const zeroFit = Object.fromEntries(Object.keys(data.occasionProfiles).map(o => [o, 0]));
  const A = { ...base, id: 'A', lat: orchard.lat, lng: orchard.lng, attributes: attrs(0), occasionFit: zeroFit };
  const B = { ...base, id: 'B', lat: orchard.lat + 0.001, lng: orchard.lng, attributes: attrs(100), occasionFit: undefined };
  const far = { ...A, id: 'far', lat: orchard.lat + 0.02 }; // only there so the radius search finds 3 venues
  const out = converge({ ...dinner, pruneTo: 1, members: [{ ...member('faith'), dietary: [], home: orchard }] }, { ...data, venues: [A, B, far] });
  assert.strictEqual(out.results[0].venueId, 'B');
});

// ---------------- 6. regret line ignores differences too small to matter
test('regret line: shows only rounded differences of at least three minutes', () => {
  const row = (id, ian, mean) => ({ venue: { id, name: id }, travelByMember: { ian }, meanRaw: mean });
  assert.strictEqual(S.regretCounterfactual([row('rec', 45.1, 40), row('popular', 45.4, 30)], { ian: 'Ian' }), null);
  assert.strictEqual(S.regretCounterfactual([row('rec', 45, 40), row('popular', 47, 30)], { ian: 'Ian' }), null);
  const r = S.regretCounterfactual([row('rec', 45, 40), row('popular', 48, 30)], { ian: 'Ian' });
  assert.strictEqual(r.text, "Picking popular instead would add 3 minutes to Ian's journey.");
});

// ---------------- 7. member with a start but no home or end (found in a live API smoke test)
test('a member with only a start point heads back to it instead of crashing on the trip home', () => {
  const startOnly = id => ({ id, start: member(id).home });
  for (const lastStop of [false, true]) {
    const out = converge({ ...dinner, lastStop, unknownPolicy: 'lenient', members: [startOnly('ian'), startOnly('faith')] }, data);
    assert.strictEqual(out.status, 'ok', `lastStop ${lastStop}`);
    assert.ok(allFinite(out));
  }
});
