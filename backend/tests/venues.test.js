// The joined venue data: converting the frontend's places, merging hawker centres with their CDC copy,
// and the combined list the API serves.
import { test } from 'vitest';
import assert from 'node:assert';
import { fromFrontendVenue, parseHours } from '../src/planner/venue-adapter.js';
import { loadPlanData, mergeCuratedWithCdc, withEstimatedMrtWalk } from '../src/db/venues.js';
import { converge, roam } from '../src/planner/engine.js';
import { isOpenAt } from '../src/planner/filters.js';

const frontendVenue = (extra = {}) => ({
  id: 'test-cafe', name: 'Test Cafe', category: 'drink', kind: 'cafe', area: 'Bugis', lat: 1.3007, lng: 103.8558,
  hours: ['08:00-17:00'], serves: ['breakfast', 'lunch', 'tea'], price: 12, indoor: true, mrt: 'Bugis', mrtWalk: 2,
  rating: 8.4, popularity: 0.6, tags: [], ...extra,
});

// ---------------- converting one frontend venue
test('fromFrontendVenue: keeps the id, rescales the rating, maps hours and MRT walk', () => {
  const v = fromFrontendVenue(frontendVenue());
  assert.strictEqual(v.id, 'test-cafe');
  assert.strictEqual(v.rating, 4.2); // 8.4 out of 10 -> 4.2 out of 5
  assert.deepStrictEqual(v.openingHours, [['08:00', '17:00']]);
  assert.strictEqual(v.mrtWalkMinutes, 2);
  assert.strictEqual(v.exposure, 0); // indoor and 2 min from the MRT
  assert.strictEqual(v.source, 'curated');
});
test('fromFrontendVenue: what the list does not say stays unknown, never "none"', () => {
  const v = fromFrontendVenue(frontendVenue());
  assert.deepStrictEqual([v.diet.halal, v.diet.vegetarian, v.diet.vegan], ['unknown', 'unknown', 'unknown']);
  assert.strictEqual(v.stepFree, null);
  assert.strictEqual(v.dataQuality.attributesAreDefaults, true);
});
test('fromFrontendVenue: shop and activity have no diet, so dietary filters skip them', () => {
  assert.strictEqual(fromFrontendVenue(frontendVenue({ category: 'shop', kind: 'mall' })).diet, null);
  assert.strictEqual(fromFrontendVenue(frontendVenue({ category: 'activity', kind: 'park', indoor: false })).diet, null);
});
test('fromFrontendVenue: tags shape the attributes and the CDC flag', () => {
  const plain = fromFrontendVenue(frontendVenue());
  const hidden = fromFrontendVenue(frontendVenue({ tags: ['hidden', 'cdc'] }));
  assert.ok(hidden.attributes.quiet > plain.attributes.quiet);
  assert.strictEqual(hidden.cdcAccepted, true);
  assert.strictEqual(plain.cdcAccepted, false);
});
test('fromFrontendVenue: an open-air park is fully exposed to rain', () => {
  assert.strictEqual(fromFrontendVenue(frontendVenue({ category: 'activity', kind: 'park', indoor: false })).exposure, 5);
});
test('parseHours: past-midnight ranges are kept as they are, and bad text throws', () => {
  const bar = { openingHours: parseHours(['17:00-02:00']) };
  assert.strictEqual(isOpenAt(bar, '2026-10-10T01:00'), true);
  assert.throws(() => parseHours(['5pm-2am']), /bad hours/);
});

// ---------------- merging with CDC
test('mergeCuratedWithCdc: a hawker centre replaces its CDC copy; a stall inside a centre does not', () => {
  const site = { id: 'cdc_1', lat: 1.3, lng: 103.85, siteKind: 'large_site', postalCode: '111', cdc: { stallCount: 40 }, stalls: [{ name: 'Ah Seng Noodles' }] };
  const centre = fromFrontendVenue(frontendVenue({ id: 'centre', name: 'Test Food Centre', category: 'eat', kind: 'hawker', lat: 1.3005, lng: 103.85 }));
  const stall = fromFrontendVenue(frontendVenue({ id: 'stall', name: 'Ah Seng Noodles', category: 'eat', kind: 'hawker', lat: 1.3002, lng: 103.85 }));
  const withCentre = mergeCuratedWithCdc([centre], [site]);
  assert.deepStrictEqual(withCentre.droppedCdcIds, ['cdc_1']);
  assert.strictEqual(withCentre.venues[0].cdc.siteId, 'cdc_1');
  const withStall = mergeCuratedWithCdc([stall], [site]);
  assert.deepStrictEqual(withStall.droppedCdcIds, []); // the centre's other stalls are still a valid CDC venue
  assert.strictEqual(withStall.venues[0].cdcAccepted, true);
});
test('mergeCuratedWithCdc: a café next to a hawker centre is not merged (never by distance alone)', () => {
  const site = { id: 'cdc_1', lat: 1.3, lng: 103.85, siteKind: 'large_site', postalCode: '111', cdc: { stallCount: 40 }, stalls: [{ name: 'Ah Seng Noodles' }] };
  const cafe = fromFrontendVenue(frontendVenue({ category: 'eat', kind: 'cafe', lat: 1.3002, lng: 103.85 }));
  assert.deepStrictEqual(mergeCuratedWithCdc([cafe], [site]).droppedCdcIds, []);
});

// ---------------- estimated MRT walk
test('withEstimatedMrtWalk: fills a missing walk from the nearest station, and never overwrites a known one', () => {
  const stations = [{ name: 'Bugis', lat: 1.30065, lng: 103.85585 }, { name: 'Tampines', lat: 1.35408, lng: 103.94535 }];
  const nextToBugis = withEstimatedMrtWalk({ id: 'x', lat: 1.3010, lng: 103.8565, mrtWalkMinutes: undefined }, stations);
  assert.strictEqual(nextToBugis.nearestMrt, 'Bugis');
  assert.ok(nextToBugis.mrtWalkMinutes >= 1 && nextToBugis.mrtWalkMinutes <= 3, String(nextToBugis.mrtWalkMinutes));
  assert.strictEqual(nextToBugis.mrtWalkEstimated, true);
  const known = { id: 'y', lat: 1.3010, lng: 103.8565, mrtWalkMinutes: 12 };
  assert.strictEqual(withEstimatedMrtWalk(known, stations), known);
});

// ---------------- the combined data the API serves
const data = loadPlanData();
test('loadPlanData: all four sources, no duplicate ids, every venue has what the engine reads', () => {
  const { sources } = data._meta;
  assert.ok(sources.mock === 36 && sources.curated === 63 && sources.cdc > 1000 && sources.onemap > 400);
  assert.strictEqual(data.venues.length, sources.mock + sources.curated + sources.onemap + sources.cdc);
  assert.strictEqual(new Set(data.venues.map(v => v.id)).size, data.venues.length);
  for (const v of data.venues) {
    assert.ok(Number.isFinite(v.lat) && Number.isFinite(v.lng), v.id);
    assert.ok(['eat', 'drink', 'shop', 'activity'].includes(v.category), `${v.id}: ${v.category}`);
    assert.ok(Array.isArray(v.openingHours) && v.openingHours.length > 0, v.id);
    assert.ok(v.forecastArea in data.weatherCases.clear, `${v.id}: ${v.forecastArea}`);
    assert.ok(v.attributes && typeof v.maxGroupSize === 'number', v.id);
    assert.ok(Number.isInteger(v.mrtWalkMinutes) && v.mrtWalkMinutes >= 0, `${v.id}: mrtWalk ${v.mrtWalkMinutes}`);
  }
  assert.ok(data.areas.length > 30);
});
test('loadPlanData: Maxwell Food Centre appears once, as the named curated venue with CDC info', () => {
  const maxwell = data.venues.filter(v => v.name === 'Maxwell Food Centre');
  assert.strictEqual(maxwell.length, 1);
  assert.strictEqual(maxwell[0].cdcAccepted, true);
  assert.ok(!data.venues.some(v => v.id === maxwell[0].cdc.siteId), 'the CDC copy is gone');
});
test('the engine ranks all three sources together', () => {
  const member = { id: 'a', name: 'A', home: { lat: 1.2803, lng: 103.8447 }, dietary: [], budgetMaxPerPerson: 20 };
  const out = converge({ members: [member], occasion: 'casual_meal', dateTime: '2026-10-10T12:30', unknownPolicy: 'lenient', topN: 10, pruneTo: 30 }, data);
  assert.strictEqual(out.status, 'ok');
  const sources = new Set(out.results.map(r => r.venue.source));
  assert.ok(sources.has('curated') && sources.has('cdc'), [...sources].join());
  const near = roam({ current: { lat: 1.2803, lng: 103.8447 }, members: [member], occasion: 'casual_meal', dateTime: '2026-10-10T15:00', categories: ['shop'] }, data);
  assert.strictEqual(near.status, 'ok');
  assert.ok(near.results.every(r => r.venue.category === 'shop'));
});
