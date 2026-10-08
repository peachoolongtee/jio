import { test } from 'vitest';
import assert from 'node:assert';
import data from '../src/db/mock/mock-data.json';
import { converge, roam, occasionWeights } from '../src/planner/engine.js';
import { haversineKm, centroid, fairnessWeights } from '../src/planner/geo.js';
import * as S from '../src/planner/scoring.js';

const member = id => data.members.find(m => m.id === id);
const sc = id => data.scenarios.find(s => s.id === id);
const inputFor = (s, extra = {}) => ({
  members: s.memberIds.map(member), overrides: s.overrides, optedOut: s.optedOut, occasion: s.occasion,
  dateTime: s.dateTime, groupConstraints: s.groupConstraints, categories: s.categories, weatherCase: s.weatherCase,
  groupId: s.groupId, ...extra,
});
const run = (id, extra) => converge(inputFor(sc(id), extra), data);
const rid = r => r.results.map(x => x.venueId);

test('S01 birthday: only halal+vegetarian+vegan venues, explained, and fair', () => {
  const r = run('S01');
  assert.strictEqual(r.status, 'ok');
  assert.ok(rid(r).every(id => ['v25', 'v26', 'v28'].includes(id)), rid(r).join());
  assert.ok(r.results.every(x => x.explanation.length > 10));
  // Fairness shifts the midpoint toward Darius and Jonathan, leaving only one option inside 3km: say so.
  assert.strictEqual(r.notice.type, 'few_options');
  assert.ok(r.notice.widenToKm > 3);
  const wider = run('S01', { radius: { steps: [500, 1000, 2000, 3000, 6000] } });
  assert.ok(wider.results.length > r.results.length, 'widening finds more options');
});
test('S02 date: romantic venues lead; rain pushes the rooftop bar down', () => {
  const clear = run('S02', { topN: 6 }), rain = run('S02b', { topN: 6 });
  assert.ok(['v01', 'v05'].includes(clear.results[0].venueId));
  assert.ok(['v01', 'v05'].every(id => rid(clear).slice(0, 3).includes(id)), `date venues should lead: ${rid(clear)}`);
  assert.ok(rid(clear).includes('v14'), 'rooftop bar is a candidate in clear weather');
  const score = (res, id) => res.results.find(x => x.venueId === id)?.score;
  assert.ok(score(clear, 'v14') !== undefined);
  assert.ok(score(rain, 'v14') === undefined || score(rain, 'v14') > score(clear, 'v14'));
});
test('S03 study at 3pm: only quiet venues with sockets, study cafe on top', () => {
  const r = run('S03');
  assert.ok(['v08', 'v20'].includes(r.results[0].venueId));
  assert.ok(r.results.every(x => x.venue.sockets && x.venue.noise <= 2));
});
test('S04 3pm: closed and lunch-only places never appear', () => {
  const r = run('S04');
  for (const id of ['v01', 'v05', 'v11', 'v04']) assert.ok(!rid(r).includes(id), `${id} should not appear`);
});
test('S05 empty midpoint: radius expands and finds Springleaf', () => {
  const plain = run('S05', { seed: 'centroid' });
  assert.strictEqual(plain.diagnostics.firstHitRadius, 2000);   // plain centroid: 1.1km away
  const fair = run('S05');                                      // default: midpoint shifts toward Darius and Jonathan
  assert.strictEqual(fair.status, 'ok');
  assert.strictEqual(fair.diagnostics.firstHitRadius, 3000);    // 2.6km away, so one step further
  assert.deepStrictEqual(rid(fair), ['v22']);
});
test('S05 beyond the cap: with a 500m cap the engine says so instead of returning nothing silently', () => {
  const r = run('S05', { radius: { steps: [500, 1000] } });
  assert.strictEqual(r.status, 'empty');
  assert.strictEqual(r.reason, 'outside_max_radius');
  assert.ok(r.hints.nearestKm > 1 && r.hints.widenToKm >= 2);
});
test('S06 no venue satisfies everything: empty with relaxation hints', () => {
  const r = run('S06');
  assert.strictEqual(r.status, 'empty');
  assert.strictEqual(r.reason, 'no_venue_passes_constraints');
  assert.ok(r.hints[0].passes > 0);
});
test('S07 opt-out: midpoint moves east and halal constraint disappears', () => {
  const all = run('S01'), out = run('S07');
  assert.ok(out.centre.lng > all.centre.lng);
  assert.ok(out.diagnostics.passedFilters > all.diagnostics.passedFilters);
});
test('S08 overrides: results respect each personal end point and return-trip limit', () => {
  const r = run('S08');
  assert.strictEqual(r.status, 'ok');
  for (const x of r.results) {
    assert.ok(x.returnByMember.ian <= member('ian').maxReturnMinutes);
    assert.ok(x.returnByMember.darryl <= member('darryl').maxReturnMinutes);
  }
});
test('return-trip limit: a tiny limit empties the result with a clear reason', () => {
  const r = converge(inputFor(sc('S08'), { members: sc('S08').memberIds.map(id => ({ ...member(id), maxReturnMinutes: 5 })) }), data);
  assert.strictEqual(r.reason, 'return_trip_too_long');
});
test('fairness: a member with travel debt pulls the midpoint toward them (S05)', () => {
  const s = sc('S05');
  const fair = converge(inputFor(s), data).centre;
  const noDebt = converge(inputFor(s, { members: s.memberIds.map(id => ({ ...member(id), travelDebtMinutes: 0 })) }), data).centre;
  const d = member('darius').home;
  assert.ok(haversineKm(fair, d) < haversineKm(noDebt, d));
});
test('seed option: minimax seed never gives a worse worst-case radius than the centroid seed', () => {
  const s = sc('S01'), pts = s.memberIds.map(id => member(id).home);
  const mm = converge(inputFor(s, { seed: 'minimax' }), data).centre;
  const ce = converge(inputFor(s, { seed: 'centroid' }), data).centre;
  const worst = c => Math.max(...pts.map(p => haversineKm(c, p)));
  assert.ok(worst(mm) <= worst(ce) + 1e-6);
});
test('cost bound: routing calls are capped by pruneTo x members x 2', () => {
  const r = run('S02');
  assert.ok(r.diagnostics.routingCalls <= 10 * 2 * 2);
});
test('regret counterfactual: only returned when it is true and positive', () => {
  for (const id of ['S01', 'S02', 'S08']) {
    const r = run(id);
    if (r.regret) {
      assert.ok(r.regret.extraMinutes > 0);
      assert.match(r.regret.text, /instead would add \d+ minutes to/);
    }
  }
});
test('weights: raising the weather weight changes the rain ranking of the rooftop bar', () => {
  const heavy = { ...S.DEFAULT_WEIGHTS.converge, weather: 80 };
  const base = converge(inputFor(sc('S02b')), data), hv = converge(inputFor(sc('S02b'), { weights: heavy }), data);
  const pos = (r, id) => rid(r).indexOf(id);
  assert.ok(pos(hv, 'v14') === -1 || pos(hv, 'v14') >= pos(base, 'v14'));
});
test('priceSensitivity: an expensive venue is punished less for a date than for a study session', () => {
  const w = S.DEFAULT_WEIGHTS.converge;
  assert.ok(occasionWeights(w, data.occasionProfiles.date).price < occasionWeights(w, data.occasionProfiles.study).price);
  assert.strictEqual(occasionWeights(w, undefined).price, w.price);
});
test('converge with no active members throws', () => {
  assert.throws(() => converge(inputFor(sc('S01'), { optedOut: sc('S01').memberIds }), data), /no active members/);
});

// ---- roam ----
const roamInput = (id, extra = {}) => {
  const r = data.roamScenarios.find(s => s.id === id);
  return { current: r.current, members: r.memberIds.map(member), occasion: r.occasion, dateTime: r.dateTime,
           groupConstraints: r.groupConstraints, categories: r.categories, excludeVenueIds: r.excludeVenueIds,
           weatherCase: r.weatherCase, ...extra };
};
test('R01 roam: just-visited venue excluded, activities offered, all results open', () => {
  const r = roam(roamInput('R01'), data);
  assert.ok(!rid(r).includes('v04'));
  assert.ok(r.results.some(x => x.venue.category === 'activity'));
  assert.ok(r.results.every(x => x.explanation.length > 5));
});
test('R02 roam: outdoor promenade scores worse in rain than in clear weather', () => {
  const rain = roam(roamInput('R02'), data), clear = roam(roamInput('R02', { weatherCase: 'clear' }), data);
  const a = rain.results.find(x => x.venueId === 'a03'), b = clear.results.find(x => x.venueId === 'a03');
  assert.ok(a && b && a.score > b.score);
});

// ---- scoring unit tests ----
test('scoring: travelPenalty is absolute (small gaps stay small), normalizeMinMax, and combine', () => {
  assert.strictEqual(S.travelPenalty(30), 50);
  assert.strictEqual(S.travelPenalty(90), 100);
  assert.ok(S.travelPenalty(15) - S.travelPenalty(12) < 6);
  assert.deepStrictEqual(S.normalizeMinMax([10, 20, 30]), [0, 50, 100]);
  assert.deepStrictEqual(S.normalizeMinMax([5, 5]), [0, 0]);
  const { score } = S.combine({ a: 0, b: 100 }, { a: 50, b: 50 });
  assert.strictEqual(score, 50);
  assert.throws(() => S.combine({ a: 1 }, { b: 1 }), /missing factor/);
});
test('scoring: occasion fit from attributes matches the precomputed mock values', () => {
  for (const v of data.venues) for (const [o, p] of Object.entries(data.occasionProfiles)) {
    assert.strictEqual(S.computeOccasionFit(v, p), v.occasionFit[o]);
  }
});
test('scoring: anti-repeat falls from 100 (recent) to 0 (60+ days) and ignores other groups', () => {
  const h = data.visitHistory, o = { today: '2026-10-04', groupId: 'g1' };
  assert.strictEqual(S.antiRepeatPenalty('v09', h, o), 100);           // 1 day ago
  assert.ok(S.antiRepeatPenalty('v11', h, o) > 0 && S.antiRepeatPenalty('v11', h, o) < 100); // 15 days
  assert.ok(Math.abs(S.antiRepeatPenalty('v13', h, o) - 36.96) < 0.01); // 43 days: partway down
  assert.strictEqual(S.antiRepeatPenalty('v21', h, o), 0);              // 84 days: forgotten
  assert.strictEqual(S.antiRepeatPenalty('v09', h, { today: '2026-10-04', groupId: 'other' }), 0); // different group
});
test('scoring: pareto front keeps only non-dominated options', () => {
  const items = [{ id: 'a', t: 10, p: 50 }, { id: 'b', t: 20, p: 20 }, { id: 'c', t: 25, p: 60 }];
  assert.deepStrictEqual(S.paretoFront(items, ['t', 'p']).map(x => x.id), ['a', 'b']);
});
