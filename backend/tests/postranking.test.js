import { test } from 'vitest';
import assert from 'node:assert';
import data from '../src/db/mock/mock-data.json';
import * as P from '../src/planner/postranking.js';
import { converge } from '../src/planner/engine.js';
import { haversineKm } from '../src/planner/geo.js';

const member = id => data.members.find(m => m.id === id);
const sc = id => data.scenarios.find(s => s.id === id);
const inputFor = (s, extra = {}) => ({
  members: s.memberIds.map(member), overrides: s.overrides, optedOut: s.optedOut, occasion: s.occasion,
  dateTime: s.dateTime, groupConstraints: s.groupConstraints, categories: s.categories, weatherCase: s.weatherCase,
  groupId: s.groupId, ...extra,
});

// ---- ledger ----
test('ledger: deltas sum to zero and the person who travelled most is owed the most', () => {
  const next = P.updateLedger({ ian: 0, darius: 0, nicole: 0 }, { ian: 30, darius: 60, nicole: 30 });
  assert.ok(Math.abs(Object.values(next).reduce((a, b) => a + b, 0)) < 1e-9);
  assert.ok(next.darius > next.ian && next.darius > 0 && next.ian < 0);
});
test('ledger: non-attendees are untouched and the input is not mutated', () => {
  const before = { ian: 5, faith: 12 };
  const next = P.updateLedger(before, { ian: 40, darius: 20 });
  assert.strictEqual(next.faith, 12);
  assert.strictEqual(before.ian, 5);
  assert.strictEqual(next.darius, 0 + (20 - 30));
});
test('ledger: decay shrinks balances toward zero', () => {
  assert.deepStrictEqual(P.decayLedger({ a: 100, b: -50 }, 0.9), { a: 90, b: -45 });
});
test('ledger closes the loop: after Darius over-travels, the next midpoint moves toward him', () => {
  const s = sc('S05');
  const zero = s.memberIds.map(id => ({ ...member(id), travelDebtMinutes: 0 }));
  const ledger = P.updateLedger({ darius: 0, jonathan: 0, nicole: 0 }, { darius: 70, jonathan: 40, nicole: 40 });
  const withDebt = zero.map(m => ({ ...m, travelDebtMinutes: Math.max(0, ledger[m.id]) }));
  const a = converge(inputFor(s, { members: zero }), data).centre;
  const b = converge(inputFor(s, { members: withDebt }), data).centre;
  assert.ok(haversineKm(b, member('darius').home) < haversineKm(a, member('darius').home));
});

// ---- voting ----
test('borda: points, and ties broken by the engine order', () => {
  const t = P.bordaCount({ options: ['a', 'b', 'c'], rankings: [['a', 'b', 'c'], ['b', 'a', 'c'], ['c', 'b', 'a']] });
  assert.deepStrictEqual(t.map(x => [x.id, x.points]), [['b', 7], ['a', 6], ['c', 5]]);
  const tie = P.bordaCount({ options: ['a', 'b'], rankings: [['a', 'b'], ['b', 'a']], tieBreakOrder: ['b', 'a'] });
  assert.strictEqual(tie[0].id, 'b');
});
test('veto: one per member, removes the option, never leaves nothing', () => {
  assert.deepStrictEqual(P.applyVetoes({ options: ['a', 'b', 'c'], vetoes: [{ memberId: 'x', optionId: 'a' }] }).options, ['b', 'c']);
  assert.throws(() => P.applyVetoes({ options: ['a', 'b'], vetoes: [{ memberId: 'x', optionId: 'a' }, { memberId: 'x', optionId: 'b' }] }), /already used/);
  const all = P.applyVetoes({ options: ['a'], vetoes: [{ memberId: 'x', optionId: 'a' }] });
  assert.ok(all.ignoredVetoes && all.options.length === 1);
});
test('decideVote: veto then Borda', () => {
  const r = P.decideVote({ options: ['a', 'b', 'c'], rankings: [['a', 'b', 'c'], ['a', 'c', 'b']], vetoes: [{ memberId: 'z', optionId: 'a' }] });
  assert.ok(r.winner !== 'a');
});

// ---- random picker ----
test('randomPick: seeded rng is repeatable; weights bias but do not forbid', () => {
  const items = ['a', 'b', 'c'];
  assert.strictEqual(P.randomPick(items, { rng: P.mulberry32(7) }), P.randomPick(items, { rng: P.mulberry32(7) }));
  const rng = P.mulberry32(1); const counts = { a: 0, b: 0, c: 0 };
  for (let i = 0; i < 3000; i++) counts[P.randomPick(items, { rng, weights: [6, 3, 1] })]++;
  assert.ok(counts.a > counts.b && counts.b > counts.c && counts.c > 0);
  assert.throws(() => P.randomPick([]));
});

// ---- Rain Check ----
test('rainCheck: dry weather or a sheltered venue needs no swap', () => {
  assert.strictEqual(P.rainCheck({ input: inputFor(sc('S02')), confirmedVenueId: 'v14', data }).needed, false); // clear
  assert.strictEqual(P.rainCheck({ input: inputFor(sc('S02b')), confirmedVenueId: 'v01', data }).needed, false); // indoor, exposure 0
});
test('rainCheck: rain at the open-air rooftop bar proposes an indoor swap', () => {
  const r = P.rainCheck({ input: inputFor(sc('S02b')), confirmedVenueId: 'v14', data });
  assert.strictEqual(r.needed, true);
  assert.ok(r.proposal);
  assert.strictEqual(r.proposal.venue.setting, 'indoor');
  assert.notStrictEqual(r.proposal.venueId, 'v14');
});

// ---- recalculation ----
test('recalculate: opt-out reports what moved', () => {
  const r = P.recalculate(inputFor(sc('S01')), { optOut: 'darius' }, data);
  assert.ok(r.after.centre.lng > r.before.centre.lng);
  assert.ok(Array.isArray(r.entered) && Array.isArray(r.left));
  assert.ok(r.entered.length + r.left.length > 0 || r.topChanged);
});
test('recalculate: changing one person\'s start changes the midpoint; unknown change throws', () => {
  const far = { label: 'Woodlands today', lat: 1.4370, lng: 103.7865 };
  const r = P.recalculate(inputFor(sc('S08')), { setStart: { id: 'faith', location: far } }, data);
  assert.notDeepStrictEqual(r.before.centre, r.after.centre);
  assert.throws(() => P.recalculate(inputFor(sc('S01')), { nope: 1 }, data), /unknown change/);
});
test('recalculate: setEnd is honoured (return-trip check uses the new end)', () => {
  const far = { label: 'Far away', lat: 1.4370, lng: 103.7865 };
  const r = P.recalculate(inputFor(sc('S08')), { setEnd: { id: 'ian', location: far } }, data);
  assert.ok(r.after.status === 'empty' || r.after.results.every(x => x.returnByMember.ian <= member('ian').maxReturnMinutes));
});
