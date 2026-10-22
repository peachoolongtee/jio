// Engine features added for the frontend's itinerary flow: meet once, then rank venues for each slot.
import { test } from 'vitest';
import assert from 'node:assert';
import mock from '../src/db/mock/mock-data.json';
import areasFile from '../src/db/mock/areas.json';
import { converge, roam, meetingArea, searchVenues } from '../src/planner/engine.js';
import { filterByConstraints, isOpenFor } from '../src/planner/filters.js';
import { mockTravelMinutes } from '../src/planner/geo.js';
import * as S from '../src/planner/scoring.js';

const data = { ...mock, areas: areasFile.areas };
const member = id => mock.members.find(m => m.id === id);
const bugis = { lat: 1.30065, lng: 103.85585 };
const lunch = { occasion: 'casual_meal', dateTime: '2026-10-10T12:30' };
const solo = { ...member('faith'), dietary: [], home: bugis, maxReturnMinutes: undefined };

// A plain eat venue next to Bugis MRT, open all day, that every member can eat at. Override what a test needs.
const template = mock.venues.find(v => v.category === 'eat');
const venue = (id, extra = {}) => ({
  ...template, id, name: id, lat: bugis.lat, lng: bugis.lng, openingHours: [['00:00', '24:00']], mealPeriods: [],
  diet: { halal: 'full', vegetarian: 'full', vegan: 'full', healthy: 3 }, maxGroupSize: 30, occasionFit: undefined, ...extra,
});
const only = venues => ({ ...data, venues });

// ---------------- open for the whole slot
test('isOpenFor: the whole visit must fit inside the opening hours', () => {
  const lunchPlace = { openingHours: [['11:00', '14:30']] };
  assert.strictEqual(isOpenFor(lunchPlace, '2026-10-10T12:00', 60), true);
  assert.strictEqual(isOpenFor(lunchPlace, '2026-10-10T14:00', 60), false); // closes half way through
  const bar = { openingHours: [['18:00', '03:00']] };
  assert.strictEqual(isOpenFor(bar, '2026-10-10T23:30', 90), true); // runs past midnight
  assert.strictEqual(isOpenFor(bar, '2026-10-11T01:00', 60), true); // inside last night's opening
  assert.strictEqual(isOpenFor(bar, '2026-10-11T02:30', 60), false);
});
test('converge with durationMinutes drops a place that closes during the slot', () => {
  const closesSoon = venue('closesSoon', { openingHours: [['11:00', '13:00']] });
  const allDay = [1, 2, 3].map(i => venue(`allDay${i}`));
  const input = { ...lunch, members: [solo], pruneTo: 10, topN: 10 };
  assert.ok(converge(input, only([closesSoon, ...allDay])).results.some(r => r.venueId === 'closesSoon'));
  assert.ok(!converge({ ...input, durationMinutes: 60 }, only([closesSoon, ...allDay])).results.some(r => r.venueId === 'closesSoon'));
});

// ---------------- near MRT and the last stop
test('near_mrt:N filters by walk time; unknown follows the unknown-data policy', () => {
  const vs = [venue('near', { mrtWalkMinutes: 4 }), venue('far', { mrtWalkMinutes: 15 }), venue('unknown', { mrtWalkMinutes: null })];
  const ctx = { members: [solo], dateTime: lunch.dateTime, groupConstraints: ['near_mrt:10'] };
  assert.deepStrictEqual(filterByConstraints(vs, ctx).passed.map(v => v.id), ['near']);
  assert.deepStrictEqual(filterByConstraints(vs, { ...ctx, unknownPolicy: 'lenient' }).passed.map(v => v.id), ['near', 'unknown']);
});
test('lastStop: only near-MRT places, and the trip home becomes part of the score', () => {
  const vs = [venue('nearMrt', { mrtWalkMinutes: 3 }), venue('farFromMrt', { mrtWalkMinutes: 20 }), venue('alsoNear', { mrtWalkMinutes: 8, lat: bugis.lat + 0.005 })];
  const out = converge({ ...lunch, members: [solo], lastStop: true }, only(vs));
  assert.ok(!out.results.some(r => r.venueId === 'farFromMrt'));
  assert.ok(out.results.every(r => r.breakdown.returnWorst && r.breakdown.returnWorst.weight === 15));
  const normal = converge({ ...lunch, members: [solo] }, only(vs));
  assert.ok(normal.results.every(r => !r.breakdown.returnWorst), 'off by default');
});

test('dietPolicy is strict for dietary needs alone: a last stop with an unknown MRT walk is not dropped because the group has a need', () => {
  const halalGroup = [{ ...solo, dietary: ['halal'] }];
  const likely = { halal: 'likely', vegetarian: 'unknown', vegan: 'unknown', healthy: 3 };
  const vs = [
    venue('unknownWalk', { mrtWalkMinutes: null, diet: likely }),
    venue('noHalalData', { mrtWalkMinutes: 3, diet: { ...likely, halal: 'unknown' } }),
    venue('knownWalk', { mrtWalkMinutes: 3, diet: likely }),
  ];
  const ids = out => out.results.map(r => r.venueId).sort();
  const input = { ...lunch, members: halalGroup, lastStop: true, unknownPolicy: 'lenient', dietPolicy: 'strict', topN: 10 };
  // Strict for halal: the place with no halal data goes. Lenient for the MRT walk: the one with an unknown walk stays.
  assert.deepStrictEqual(ids(converge(input, only(vs))), ['knownWalk', 'unknownWalk']);
  // Without dietPolicy the diet follows unknownPolicy, as before: lenient keeps all three.
  assert.deepStrictEqual(ids(converge({ ...input, dietPolicy: undefined }, only(vs))), ['knownWalk', 'noHalalData', 'unknownWalk']);
  // Strict overall (the old way a strict diet was asked for) also drops the unknown walk: the reason dietPolicy exists.
  assert.deepStrictEqual(ids(converge({ ...input, unknownPolicy: 'strict', dietPolicy: undefined }, only(vs))), ['knownWalk']);
  // The same on the filter, and the slot search, which is how a place is added.
  const ctx = { members: halalGroup, dateTime: lunch.dateTime, groupConstraints: ['near_mrt:10', 'step_free'], unknownPolicy: 'lenient', dietPolicy: 'strict' };
  const withAccess = vs.map(v => ({ ...v, stepFree: null }));
  assert.deepStrictEqual(filterByConstraints(withAccess, ctx).passed.map(v => v.id), ['unknownWalk', 'knownWalk']);
  assert.deepStrictEqual(filterByConstraints(withAccess, { ...ctx, dietPolicy: undefined }).passed.map(v => v.id), ['unknownWalk', 'noHalalData', 'knownWalk']);
  const found = searchVenues({ query: 'Walk', centre: bugis, dateTime: lunch.dateTime, members: halalGroup, lastStop: true, unknownPolicy: 'lenient', dietPolicy: 'strict' }, only(vs));
  assert.deepStrictEqual(found.filter(r => r.fits).map(r => r.venueId).sort(), ['knownWalk', 'unknownWalk']);
});

// ---------------- shop category
test('shop venues have no diet, so a halal member does not filter them out', () => {
  const mall = venue('mall', { category: 'shop', diet: null });
  const out = roam({ ...lunch, current: bugis, members: [{ ...solo, dietary: ['halal'] }], categories: ['shop'] }, only([mall]));
  assert.strictEqual(out.status, 'ok');
  assert.strictEqual(out.results[0].venueId, 'mall');
});

// ---------------- a given centre (the meeting area chosen once)
test('converge with centre ranks around that point instead of the group centroid', () => {
  const homes = [member('ian'), member('faith')];
  const out = converge({ ...lunch, members: homes, centre: bugis, unknownPolicy: 'lenient' }, data);
  assert.strictEqual(out.diagnostics.seed, 'given');
  assert.deepStrictEqual(out.centre, bugis);
});

// ---------------- crowd
test('crowd estimate: same profiles and thresholds as the frontend; unknown without kind or popularity', () => {
  const hawker = { kind: 'hawker', popularity: 0.9 };
  assert.strictEqual(S.crowdLevel(hawker, 12), 'busy');   // 0.9 x 1.0
  assert.strictEqual(S.crowdLevel(hawker, 15), 'quiet');  // 0.9 x 0.3
  assert.strictEqual(S.crowdLevel(template, 12), 'unknown');
  assert.strictEqual(S.crowdPenalty(template, 12), 50); // unknown is neutral
});
test('crowd only changes the ranking when given a weight', () => {
  const busy = venue('busy', { kind: 'hawker', popularity: 1 });
  const quiet = venue('quiet', { kind: 'hawker', popularity: 0.2 });
  const filler = [1, 2].map(i => venue(`f${i}`, { lat: bugis.lat + 0.01 }));
  const input = { ...lunch, dateTime: '2026-10-10T12:00', members: [solo] };
  const withCrowd = converge({ ...input, weights: { ...S.DEFAULT_WEIGHTS.converge, crowd: 20 } }, only([busy, quiet, ...filler]));
  assert.ok(withCrowd.results.findIndex(r => r.venueId === 'quiet') < withCrowd.results.findIndex(r => r.venueId === 'busy'));
  assert.strictEqual(withCrowd.results.find(r => r.venueId === 'busy').crowd, 'busy');
  const without = converge(input, only([busy, quiet, ...filler]));
  const score = id => without.results.find(r => r.venueId === id).score;
  assert.strictEqual(score('busy'), score('quiet'));
});

// ---------------- unknown diet in lenient mode is flagged, not silent
test('dietUnknown lists the needs a lenient result has no data for', () => {
  const unknownHalal = venue('unknownHalal', { diet: { halal: 'unknown', vegetarian: 'full', vegan: 'full', healthy: 3 } });
  const out = converge({ ...lunch, members: [{ ...solo, dietary: ['halal'] }], unknownPolicy: 'lenient' }, only([unknownHalal]));
  assert.deepStrictEqual(out.results[0].dietUnknown, ['halal']);
  assert.strictEqual(converge({ ...lunch, members: [{ ...solo, dietary: ['halal'] }] }, only([unknownHalal])).status, 'empty'); // strict
});

// ---------------- meeting area
const group = ['ian', 'darius', 'jonathan', 'nicole'].map(member);
const worstTo = (members, point) => Math.max(...members.map(m => mockTravelMinutes(m.home, point)));

test('meetingArea station: picks the area where the longest journey is shortest', () => {
  const out = meetingArea({ members: group, maxCandidates: 50 }, data);
  const bestPossible = Math.min(...data.areas.map(a => worstTo(group, a)));
  assert.strictEqual(out.method, 'station');
  assert.ok(Math.abs(out.worstMinutes - bestPossible) < 1e-9);
  assert.deepStrictEqual(out.centre, { lat: out.area.lat, lng: out.area.lng });
});
test('meetingArea station: maxCandidates 16 finds the same answer as trying every area, for every pair and trio', () => {
  // 8 is NOT enough: Jurong East + Woodlands gets Ang Mo Kio (51.9 min) instead of Bishan (49.4 min).
  const ids = mock.members.map(m => m.id);
  for (let i = 0; i < ids.length; i++) for (let j = i + 1; j < ids.length; j++) for (const k of [null, ...ids.slice(j + 1)]) {
    const members = [ids[i], ids[j], k].filter(Boolean).map(member);
    const fast = meetingArea({ members, maxCandidates: 16 }, data), full = meetingArea({ members }, data);
    assert.ok(Math.abs(fast.worstMinutes - full.worstMinutes) < 1e-9, members.map(m => m.id).join('+'));
  }
  const pair = ['darius', 'jonathan'].map(member);
  assert.ok(meetingArea({ members: pair, maxCandidates: 8 }, data).worstMinutes > meetingArea({ members: pair }, data).worstMinutes);
});
test('meetingArea weighted_centroid: debt pulls the point toward the person owed, named after the nearest area', () => {
  const even = group.map(m => ({ ...m, travelDebtMinutes: 0 }));
  const owed = even.map(m => (m.id === 'ian' ? { ...m, travelDebtMinutes: 120 } : m));
  const a = meetingArea({ members: even, method: 'weighted_centroid' }, data);
  const b = meetingArea({ members: owed, method: 'weighted_centroid' }, data);
  assert.ok(b.travelByMember.ian < a.travelByMember.ian);
  assert.ok(data.areas.some(x => x.id === b.area.id));
});
test('meetingArea: routing failure falls back and says approximate; bad method throws', () => {
  assert.strictEqual(meetingArea({ members: group }, data, { travelMinutes: () => null }).approximate, true);
  assert.throws(() => meetingArea({ members: group, method: 'nope' }, data), /unknown method/);
});
test('the full flow: meet once, then rank each slot around the same point', () => {
  const meet = meetingArea({ members: group }, data);
  const slot = (dateTime, categories, extra = {}) =>
    converge({ members: group, occasion: 'catch_up', dateTime, durationMinutes: 90, categories, centre: meet.centre, unknownPolicy: 'lenient', ...extra }, data);
  for (const out of [slot('2026-10-10T12:00', ['eat']), slot('2026-10-10T14:00', ['drink']), slot('2026-10-10T18:30', ['eat'], { lastStop: true })]) {
    if (out.status === 'ok') assert.deepStrictEqual(out.centre, meet.centre);
  }
});
