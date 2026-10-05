import { test } from 'vitest';
import assert from 'node:assert';
import data from '../src/db/mock/mock-data.json';
import { haversineKm, centroid, fairnessWeights, minimaxCenter, radiusSearch } from '../src/planner/geo.js';
import { filterByConstraints, countReasons, relaxationHints, mealPeriodAt, isOpenAt } from '../src/planner/filters.js';

const member = id => data.members.find(m => m.id === id);
const scenario = id => data.scenarios.find(s => s.id === id);
const ctxFor = sc => ({
  members: sc.memberIds.filter(id => !(sc.optedOut || []).includes(id)).map(member),
  groupConstraints: sc.groupConstraints, dateTime: sc.dateTime, categories: sc.categories,
});
const ids = vs => vs.map(v => v.id).sort();

// ---- centroid ----
test('centroid: one point returns that point', () => {
  const c = centroid([{ lat: 1.3, lng: 103.8 }]);
  assert.ok(Math.abs(c.lat - 1.3) < 1e-9 && Math.abs(c.lng - 103.8) < 1e-9);
});
test('centroid: two points sit halfway', () => {
  const a = { lat: 1.33, lng: 103.74 }, b = { lat: 1.35, lng: 103.94 };
  const c = centroid([a, b]);
  assert.ok(Math.abs(haversineKm(c, a) - haversineKm(c, b)) < 0.01);
});
test('centroid: bad inputs throw', () => {
  assert.throws(() => centroid([]));
  assert.throws(() => centroid([{ lat: 1, lng: 103 }], [1, 2]));
  assert.throws(() => centroid([{ lat: 1, lng: 103 }, { lat: 2, lng: 104 }], [0, 0]));
  assert.throws(() => centroid([{ lat: NaN, lng: 103 }]));
});
test('centroid: S05 lands near the nature reserve', () => {
  const c = centroid(scenario('S05').memberIds.map(id => member(id).home));
  assert.ok(Math.abs(c.lat - 1.3915) < 0.001 && Math.abs(c.lng - 103.8107) < 0.001);
});

// ---- fairness ----
test('fairnessWeights: more debt = bigger weight', () => {
  const [darius, ian] = fairnessWeights([member('darius'), member('ian')]);
  assert.ok(darius > ian);
});
test('weighted centroid moves TOWARD the person who has travelled more', () => {
  const d = member('darius'), i = member('ian');
  const plain = centroid([d.home, i.home]);
  const fair = centroid([d.home, i.home], fairnessWeights([d, i]));
  assert.ok(haversineKm(fair, d.home) < haversineKm(plain, d.home));
});

// ---- minimax centre ----
test('minimaxCenter: radius never exceeds the furthest person from the centroid', () => {
  for (const sid of ['S01', 'S05', 'S02']) {
    const pts = scenario(sid).memberIds.map(id => member(id).home);
    const mm = minimaxCenter(pts);
    const far = Math.max(...pts.map(p => haversineKm(centroid(pts), p)));
    assert.ok(mm.radiusKm <= far + 0.05, `${sid}: ${mm.radiusKm} vs ${far}`);
    const farMm = Math.max(...pts.map(p => haversineKm(mm.center, p)));
    assert.ok(Math.abs(farMm - mm.radiusKm) < 0.05, 'reported radius matches furthest person');
  }
});
test('minimaxCenter: two points -> midpoint; one point -> itself', () => {
  const a = { lat: 1.30, lng: 103.80 }, b = { lat: 1.30, lng: 103.90 };
  const mm = minimaxCenter([a, b]);
  assert.ok(Math.abs(haversineKm(mm.center, a) - haversineKm(mm.center, b)) < 0.01);
  assert.strictEqual(minimaxCenter([a]).radiusKm, 0);
});
test('minimaxCenter: an outlier pulls the centre but the centroid is pulled less than the minimax', () => {
  const pts = [{ lat: 1.30, lng: 103.80 }, { lat: 1.30, lng: 103.81 }, { lat: 1.30, lng: 103.82 }, { lat: 1.30, lng: 103.95 }];
  const worstFrom = c => Math.max(...pts.map(p => haversineKm(c, p)));
  assert.ok(worstFrom(minimaxCenter(pts).center) < worstFrom(centroid(pts)) - 1);
});

// ---- radius search ----
test('radiusSearch: expands until enough venues, and reports the first hit', () => {
  const centre = { lat: 1.3915, lng: 103.8107 };
  const r = radiusSearch(data.venues.filter(v => v.id === 'v22' || v.id === 'v23'), centre);
  assert.strictEqual(r.firstHitRadius, 2000);
  assert.strictEqual(r.candidates.length, 1);
  assert.strictEqual(r.reachedMin, false);
});
test('radiusSearch: nothing in range reports the nearest distance', () => {
  const r = radiusSearch([data.venues.find(v => v.id === 'v01')], { lat: 1.4, lng: 103.9 });
  assert.strictEqual(r.candidates.length, 0);
  assert.ok(r.nearestKm > 3);
});
test('radiusSearch: extraSteps keeps expanding past the first 3 results', () => {
  const centre = { lat: 1.2913, lng: 103.8398 };
  const base = radiusSearch(data.venues, centre, { minResults: 3 });
  const more = radiusSearch(data.venues, centre, { minResults: 3, extraSteps: 1 });
  assert.ok(more.candidates.length >= base.candidates.length);
});

// ---- filters ----
test('filter S01: halal + vegetarian + vegan all enforced', () => {
  assert.deepStrictEqual(ids(filterByConstraints(data.venues, ctxFor(scenario('S01'))).passed),
    ['v04', 'v06', 'v12', 'v22', 'v25', 'v26', 'v28']);
});
test('filter S04: closed venues rejected (split hours, early close)', () => {
  const { rejected } = filterByConstraints(data.venues, ctxFor(scenario('S04')));
  const closed = rejected.filter(r => r.reasons.includes('closed')).map(r => r.venue.id);
  for (const id of ['v01', 'v05', 'v11']) assert.ok(closed.includes(id));
});
test('filter: meal period blocks a lunch/dinner-only place at 3pm even if it is open', () => {
  const v04 = data.venues.find(v => v.id === 'v04'); // open 11:30-23:00 but serves lunch + dinner only
  assert.strictEqual(mealPeriodAt('2026-10-10T15:00'), 'tea');
  assert.ok(isOpenAt(v04, '2026-10-10T15:00'));
  const { rejected } = filterByConstraints([v04], { members: [member('ian')], dateTime: '2026-10-10T15:00' });
  assert.deepStrictEqual(rejected[0].reasons, ['meal_period']);
});
test('filter S06: nothing passes, reasons say why, and hints say what to relax', () => {
  const ctx = ctxFor(scenario('S06'));
  const { passed, rejected } = filterByConstraints(data.venues, ctx);
  assert.strictEqual(passed.length, 0);
  assert.ok(countReasons(rejected)['diet:vegan'] > 0);
  const hints = relaxationHints(data.venues, ctx);
  assert.ok(hints[0].passes > 0, 'best hint should unlock venues');
  assert.ok(hints.find(h => h.drop === 'step_free').passes === 0, 'step_free is not the blocker');
});
test('filter: activities skip dietary rules but obey the clock', () => {
  const ctx = { members: [member('darius')], dateTime: '2026-10-10T14:45', categories: ['activity'] };
  assert.ok(filterByConstraints(data.venues, ctx).passed.some(v => v.id === 'a02'));
  assert.ok(!filterByConstraints(data.venues, { ...ctx, dateTime: '2026-10-10T20:00' }).passed.some(v => v.id === 'a04'));
});
test('filter: excludeVenueIds and unknown constraints', () => {
  const ctx = { members: [member('ian')], dateTime: '2026-10-10T19:00', excludeVenueIds: ['v09'] };
  assert.ok(!filterByConstraints(data.venues, ctx).passed.some(v => v.id === 'v09'));
  assert.throws(() => filterByConstraints(data.venues, { ...ctx, groupConstraints: ['step-free'] }), /unknown group constraint/);
});
