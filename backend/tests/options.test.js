// What each option shows in the UI (walk time, reason tags, rain warning, indoor swap) and search by name.
// These match the frontend planner, so nothing is lost when the frontend switches to the API.
import { test } from 'vitest';
import assert from 'node:assert';
import mock from '../src/db/mock/mock-data.json';
import { converge, roam, searchVenues } from '../src/planner/engine.js';
import { walkMinutes } from '../src/planner/geo.js';
import * as S from '../src/planner/scoring.js';

const bugis = { lat: 1.30065, lng: 103.85585 };
const template = mock.venues.find(v => v.category === 'eat');
const venue = (id, extra = {}) => ({
  ...template, id, name: id, area: 'Bugis', lat: bugis.lat, lng: bugis.lng, openingHours: [['00:00', '24:00']], mealPeriods: [],
  diet: { halal: 'full', vegetarian: 'full', vegan: 'full', healthy: 3 }, maxGroupSize: 30, setting: 'indoor', exposure: 0,
  forecastArea: 'central', tags: [], ...extra,
});
const only = venues => ({ ...mock, venues });
const solo = { ...mock.members.find(m => m.id === 'faith'), dietary: [], home: bugis, maxReturnMinutes: undefined };
const slot = { occasion: 'casual_meal', dateTime: '2026-10-10T12:30', members: [solo], centre: bugis };

// ---------------- walk minutes
test('walkMinutes: the frontend formula (5 km/h, streets 25% longer); under 50 m is 0', () => {
  assert.strictEqual(walkMinutes(bugis, bugis), 0);
  assert.strictEqual(walkMinutes(bugis, { lat: bugis.lat + 0.0003, lng: bugis.lng }), 0); // ~33 m
  assert.strictEqual(walkMinutes(bugis, { lat: bugis.lat + 0.009, lng: bugis.lng }), 15); // 1 km x 1.25 x 12
});
test('every result carries walkMinutes from the meeting point (Converge) or the current point (Roam)', () => {
  const vs = [venue('a'), venue('b', { lat: bugis.lat + 0.005 }), venue('c', { lat: bugis.lat + 0.009 })];
  for (const r of converge(slot, only(vs)).results) assert.strictEqual(r.walkMinutes, walkMinutes(bugis, r.venue));
  const here = { lat: bugis.lat + 0.009, lng: bugis.lng };
  for (const r of roam({ ...slot, current: here }, only(vs)).results) assert.strictEqual(r.walkMinutes, walkMinutes(here, r.venue));
});

// ---------------- reason tags
test('reasonTags: same tags and order as the frontend, at most two', () => {
  const tags = o => S.reasonTags({ walkMinutes: 20, crowd: 'busy', rainy: false, time: '12:30', ...o, venue: { avgPricePerPerson: 30, tags: [], mrtWalkMinutes: 12, ...o.venue } });
  assert.deepStrictEqual(tags({ venue: {} }), []);
  assert.deepStrictEqual(tags({ venue: { setting: 'indoor' }, rainy: true }), ['Indoor']);
  assert.deepStrictEqual(tags({ venue: {}, homeMaxMinutes: 30 }), ['Easy trip home']);
  assert.deepStrictEqual(tags({ venue: {}, homeMaxMinutes: 50 }), []);
  assert.deepStrictEqual(tags({ venue: { mrtWalkMinutes: 4 } }), ['Near MRT']);
  assert.deepStrictEqual(tags({ venue: {}, crowd: 'quiet' }), ['Quiet at 12:30']);
  assert.deepStrictEqual(tags({ venue: {}, walkMinutes: 5 }), ['Short walk']);
  assert.deepStrictEqual(tags({ venue: { tags: ['hidden'] } }), ['Hidden gem']);
  assert.deepStrictEqual(tags({ venue: { avgPricePerPerson: 6 } }), ['Budget friendly']);
  assert.deepStrictEqual(tags({ venue: { mrtWalkMinutes: 2, avgPricePerPerson: 6, tags: ['hidden'] }, walkMinutes: 3 }), ['Near MRT', 'Short walk']);
});
test('results: "Easy trip home" only appears on the last stop', () => {
  const vs = [venue('a', { mrtWalkMinutes: 20 }), venue('b', { mrtWalkMinutes: 20 }), venue('c', { mrtWalkMinutes: 20 })];
  const expensive = vs.map(v => ({ ...v, avgPricePerPerson: 40 }));
  const near = expensive.map(v => ({ ...v, mrtWalkMinutes: 8 })); // passes near_mrt:10, no "Near MRT" tag
  assert.ok(converge({ ...slot, lastStop: true }, only(near)).results.every(r => r.reasons[0] === 'Easy trip home'));
  assert.ok(converge(slot, only(near)).results.every(r => !r.reasons.includes('Easy trip home')));
});

// ---------------- rain warning and indoor swap
const park = (id, extra = {}) => venue(id, { category: 'eat', setting: 'outdoor', exposure: 5, ...extra });
test('rainWarning: only when rain is likely AND the venue is exposed', () => {
  const rain = mock.weatherCases.rain, clear = mock.weatherCases.clear;
  assert.strictEqual(S.rainWarning(park('p'), rain), true);
  assert.strictEqual(S.rainWarning(park('p'), clear), false);
  assert.strictEqual(S.rainWarning(venue('inside'), rain), false);
  assert.strictEqual(S.rainWarning(park('sheltered', { setting: 'mixed', exposure: 1 }), rain), false);
});
test('in rain, an exposed option gets a warning and the best indoor venue that is not already shown', () => {
  const vs = [park('park1'), park('park2'), park('park3'), venue('indoor1', { lat: bugis.lat + 0.004 }), venue('indoor2', { lat: bugis.lat + 0.006 })];
  const out = converge({ ...slot, weatherCase: 'rain', topN: 3, weights: { worst: 100 } }, only(vs)); // closest first: the parks
  const shown = out.results.map(r => r.venueId);
  assert.deepStrictEqual(shown, ['park1', 'park2', 'park3']);
  for (const r of out.results) {
    assert.deepStrictEqual(r.warnings, ['rain']);
    assert.strictEqual(r.swap.venueId, 'indoor1');
  }
  // indoor1 is already an option the group is voting on, so the swap moves to indoor2. indoor2 is ~670 m away,
  // outside the 500 m circle the radius search stopped at, so this also checks the fallback to the filtered list.
  const voting = converge({ ...slot, weatherCase: 'rain', topN: 3, weights: { worst: 100 }, currentOptionIds: ['indoor1'] }, only(vs));
  assert.ok(voting.results.every(r => r.swap.venueId === 'indoor2'));
});
test('no warning and no swap in clear weather; swap is null when no spare indoor venue exists', () => {
  const vs = [park('park1'), park('park2'), park('park3')];
  assert.ok(converge(slot, only(vs)).results.every(r => r.warnings.length === 0 && r.swap === null));
  assert.ok(converge({ ...slot, weatherCase: 'rain' }, only(vs)).results.every(r => r.warnings[0] === 'rain' && r.swap === null));
});

// ---------------- search by name
test('searchVenues: matches name, area or a CDC stall; fitting places first, then by walk', () => {
  const vs = [
    venue('Far Noodle House', { lat: bugis.lat + 0.05 }),
    venue('Noodle Corner', { lat: bugis.lat + 0.002 }),
    venue('Closed Noodles', { openingHours: [['18:00', '22:00']] }),
    venue('Food stalls at 1 Test Road', { area: 'Test Road', stalls: [{ name: 'Ah Seng Noodle' }] }),
    venue('Unrelated Cafe'),
  ];
  const results = searchVenues({ query: 'noodle', centre: bugis, dateTime: '2026-10-10T12:30' }, only(vs));
  assert.deepStrictEqual(results.map(r => r.venueId), ['Food stalls at 1 Test Road', 'Noodle Corner', 'Closed Noodles', 'Far Noodle House']);
  assert.strictEqual(results[0].matchedStall, 'Ah Seng Noodle');
  assert.deepStrictEqual(results.find(r => r.venueId === 'Closed Noodles').unfit, ['closed']);
  assert.deepStrictEqual(results.find(r => r.venueId === 'Far Noodle House').unfit, ['far']);
  assert.strictEqual(searchVenues({ query: 'test road', centre: bugis, dateTime: '2026-10-10T12:30' }, only(vs))[0].venueId, 'Food stalls at 1 Test Road');
});
test('searchVenues: uses the slot rules (duration, category, diet, last stop), and an empty query finds nothing', () => {
  const vs = [venue('Lunch Spot', { openingHours: [['11:00', '13:00']], diet: { halal: 'none', vegetarian: 'full', vegan: 'full', healthy: 3 }, mrtWalkMinutes: 15 })];
  const base = { query: 'lunch', centre: bugis, dateTime: '2026-10-10T12:30' };
  assert.strictEqual(searchVenues(base, only(vs))[0].fits, true);
  const strictSlot = searchVenues({ ...base, durationMinutes: 60, categories: ['drink'], lastStop: true, members: [{ ...solo, dietary: ['halal'] }] }, only(vs));
  assert.deepStrictEqual(strictSlot[0].unfit.sort(), ['category', 'closed', 'diet:halal', 'near_mrt']);
  assert.deepStrictEqual(searchVenues({ ...base, query: '   ' }, only(vs)), []);
});
