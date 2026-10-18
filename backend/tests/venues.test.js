// The joined venue data: converting the frontend's places, merging hawker centres with their CDC copy,
// and the combined list the API serves.
import { test } from 'vitest';
import assert from 'node:assert';
import { fromFrontendVenue, parseHours } from '../src/planner/venue-adapter.js';
import { loadPlanData, mergeCuratedWithCdc, withEstimatedMrtWalk, dropKnownPlaces, carryOverFromCdcSite } from '../src/db/venues.js';
import { converge, roam, searchVenues } from '../src/planner/engine.js';
import { isOpenAt, filterByConstraints } from '../src/planner/filters.js';
import { fromOneMapRow } from '../src/planner/onemap-adapter.js';

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

// ---------------- OneMap hawker centres replacing CDC sites
const cdcSite = (extra = {}) => ({
  id: 'cdc_198783', name: 'Food stalls at 861 North Bridge Road', category: 'eat', source: 'cdc', siteKind: 'large_site', postalCode: '198783',
  lat: 1.30563, lng: 103.86391, cdc: { stallCount: 37 },
  diet: { halal: 'likely', vegetarian: 'likely', vegan: 'unknown', healthy: 2 },
  stalls: [{ name: 'Ah Seng Bak Chor Mee', budgetMeal: false }, { name: 'Warung Pak Din Nasi Padang', budgetMeal: true }],
  ...extra,
});
const oneMapCentre = (name, extra = {}) => ({
  ...fromOneMapRow('ssot_hawkercentres', { NAME: name, STATUS: 'Existing', LatLng: '1.305634,103.863909', ADDRESSPOSTALCODE: '198783' }), ...extra,
});
const strictHalal = { members: [{ id: 'a', dietary: ['halal'] }], dateTime: '2026-10-13T12:30', categories: ['eat'] };

test('mergeCuratedWithCdc: a OneMap centre keeps the halal and vegetarian "likely" of the CDC site it replaces', () => {
  const centre = oneMapCentre('North Bridge Road Market');
  assert.strictEqual(filterByConstraints([centre], strictHalal).passed.length, 0); // on its own it knows nothing, so strict refuses it
  const { venues: [merged], droppedCdcIds } = mergeCuratedWithCdc([centre], [cdcSite()]);
  assert.deepStrictEqual(droppedCdcIds, ['cdc_198783']);
  assert.strictEqual(merged.cdcAccepted, true);
  assert.deepStrictEqual([merged.diet.halal, merged.diet.vegetarian, merged.diet.vegan], ['likely', 'likely', 'unknown']);
  assert.strictEqual(filterByConstraints([merged], strictHalal).passed.length, 1);
  assert.strictEqual(merged.siteKind, 'large_site');
  assert.deepStrictEqual(merged.stalls.map((s) => s.name), ['Ah Seng Bak Chor Mee', 'Warung Pak Din Nasi Padang']);
  assert.strictEqual(merged.dataQuality.dietUnknown, false);
  assert.strictEqual(merged.dataQuality.dietFromNames, true);
  assert.strictEqual(merged.name, 'North Bridge Road Market'); // the name stays OneMap's
});
test('carryOverFromCdcSite: the better level wins per need, "none" never beats anything, healthy stays the centre\'s', () => {
  const venue = { diet: { halal: 'unknown', vegetarian: 'options', vegan: 'none', healthy: 3 }, dataQuality: { dietUnknown: true } };
  const site = { diet: { halal: 'likely', vegetarian: 'likely', vegan: 'unknown', healthy: 2 }, stalls: [], siteKind: 'food_cluster' };
  const kept = carryOverFromCdcSite(venue, site);
  assert.deepStrictEqual(kept.diet, { halal: 'likely', vegetarian: 'options', vegan: 'unknown', healthy: 3 });
  assert.strictEqual(kept.siteKind, 'food_cluster');
});
test('mergeCuratedWithCdc: the stalls of the CDC site stay searchable by name inside the OneMap centre', () => {
  const { venues } = mergeCuratedWithCdc([oneMapCentre('North Bridge Road Market')], [cdcSite()]);
  const found = searchVenues({ query: 'nasi padang', centre: { lat: 1.3056, lng: 103.8639 }, dateTime: '2026-10-13T12:30' }, { venues });
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].matchedStall, 'Warung Pak Din Nasi Padang');
});
test('mergeCuratedWithCdc: a OneMap centre named only by street and block is still a centre, and its CDC copy goes', () => {
  const block = oneMapCentre('Toa Payoh Lorong 4 Blk 93');
  const sites = [cdcSite({ id: 'cdc_310093', name: 'Food stalls at 93 Toa Payoh Lorong 4', postalCode: '310093' })];
  const { venues, droppedCdcIds } = mergeCuratedWithCdc([{ ...block, postalCode: '310093' }], sites);
  assert.deepStrictEqual(droppedCdcIds, ['cdc_310093']);
  assert.strictEqual(venues[0].cdcAccepted, true);
  // A curated venue named like a stall (not a centre, and not from OneMap) is still left alone.
  const stall = fromFrontendVenue(frontendVenue({ category: 'eat', kind: 'cafe', name: 'Blk 93 Coffee', lat: 1.3057, lng: 103.8639 }));
  assert.deepStrictEqual(mergeCuratedWithCdc([stall], [cdcSite()]).droppedCdcIds, []);
});
test('mergeCuratedWithCdc: with several sites in reach, the site is the one with the same postal code, then a large one, then the nearest', () => {
  const near = (id, kind, metres, postalCode) => cdcSite({ id, siteKind: kind, postalCode, lat: 1.305634 + metres / 111000, stalls: [{ name: `${id} stall` }] });
  const centre = { ...oneMapCentre('Redhill Food Centre'), postalCode: '150085' };
  // The first in the file is a small cluster 40 m away; the centre's own site is 60 m away and has its postal code.
  const own = near('cdc_150085', 'large_site', 60, '150085');
  const pick = (sites) => mergeCuratedWithCdc([centre], sites).droppedCdcIds;
  assert.deepStrictEqual(pick([near('cdc_150080', 'food_cluster', 40, '150080'), near('cdc_150079', 'large_site', 20, '150079'), own]), ['cdc_150085']);
  // No postal code on the centre (a curated list): a large site beats a nearer cluster, and the nearer of two large sites wins.
  const noPostal = { ...centre, postalCode: undefined };
  const pickNoPostal = (sites) => mergeCuratedWithCdc([noPostal], sites).droppedCdcIds;
  assert.deepStrictEqual(pickNoPostal([near('cdc_a', 'food_cluster', 10, '1'), near('cdc_b', 'large_site', 120, '2')]), ['cdc_b']);
  assert.deepStrictEqual(pickNoPostal([near('cdc_a', 'large_site', 100, '1'), near('cdc_b', 'large_site', 30, '2')]), ['cdc_b']);
  // A site that is only a single stall is never "the centre".
  assert.deepStrictEqual(pickNoPostal([near('cdc_a', 'food_stall', 5, '1')]), []);
});
test('dropKnownPlaces: a hawker centre is compared by the name in its bracket too (Chinatown Complex, Kovan 209), but its neighbours stay', () => {
  const known = [
    { name: 'Chinatown Complex Food Centre', kind: 'hawker', lat: 1.28275, lng: 103.84425 },
    { name: 'Kovan 209 Market and Food Centre', kind: 'hawker', lat: 1.36025, lng: 103.8855 },
  ];
  const chinatown = { name: 'Smith Street Blk 335 (Chinatown Complex Market)', kind: 'hawker', lat: 1.28275 + 0.00054, lng: 103.84425 }; // 60 m
  const kovan = { name: 'Hougang Street 21 Blk 209 (Kovan Hougang Market and Food Centre)', kind: 'hawker', lat: 1.36025 + 0.00126, lng: 103.8855 }; // 140 m
  const neighbour = { name: 'Smith Street Blk 340 (Another Block Market)', kind: 'hawker', lat: 1.28275 + 0.0008, lng: 103.84425 };
  assert.deepStrictEqual(dropKnownPlaces([chinatown, kovan, neighbour], known).map((v) => v.name), [neighbour.name]);
});
test('loadPlanData: a OneMap hawker centre and its CDC copy are one venue, whatever the centre is called', () => {
  const data = loadPlanData();
  const centres = data.venues.filter((v) => v.source === 'onemap' && v.kind === 'hawker');
  for (const c of centres) assert.ok(!data.venues.some((v) => v.id === c.cdc.siteId), `${c.name} still has its CDC copy`);
  assert.strictEqual(data._meta.sources.cdcMergedIntoOnemap, centres.length);
  assert.strictEqual(data.venues.filter((v) => v.source === 'cdc').length, data._meta.sources.cdc);
  // Sources add up to the saved places: pool + set aside + duplicates + already in a hand-made list.
  const s = data._meta.sources;
  assert.strictEqual(s.onemap + s.onemapExcluded + s.onemapDuplicates + s.onemapSkippedAsKnown, s.onemapSaved);
});

// ---------------- dietary needs (ticket #107)
test('mergeCuratedWithCdc: a curated hawker centre keeps the stalls and dietary hints of the CDC site it replaces', () => {
  const centre = fromFrontendVenue(frontendVenue({ id: 'nbr', name: 'North Bridge Road Market', category: 'eat', kind: 'hawker', lat: 1.30565, lng: 103.86392 }));
  assert.strictEqual(filterByConstraints([centre], strictHalal).passed.length, 0); // on its own it knows nothing
  const { venues: [merged], droppedCdcIds } = mergeCuratedWithCdc([centre], [cdcSite()]);
  assert.deepStrictEqual(droppedCdcIds, ['cdc_198783']);
  assert.deepStrictEqual([merged.diet.halal, merged.diet.vegetarian, merged.diet.vegan], ['likely', 'likely', 'unknown']);
  assert.deepStrictEqual(merged.stalls.map((s) => s.name), ['Ah Seng Bak Chor Mee', 'Warung Pak Din Nasi Padang']);
  assert.strictEqual(merged.dataQuality.dietUnknown, false);
  assert.strictEqual(filterByConstraints([merged], strictHalal).passed.length, 1);
  assert.strictEqual(merged.name, 'North Bridge Road Market');
});

const drinkAt = (kind, extra = {}) => fromFrontendVenue(frontendVenue({ id: `d-${kind}`, name: `A ${kind}`, kind, hours: ['08:00-23:59'], serves: ['breakfast', 'lunch', 'tea', 'dinner', 'supper'], ...extra }));
const drinkCtx = (dietary) => ({ members: [{ id: 'a', dietary }], dateTime: '2026-10-13T15:00', categories: ['drink'], unknownPolicy: 'strict' });

test('a halal need keeps bars out of a drink stop, and cafés with no dietary data stay', () => {
  const cafe = drinkAt('cafe');
  const bar = drinkAt('bar');
  const noHalal = { ...drinkAt('lounge'), diet: { ...cafe.diet, halal: 'none' } };
  const { passed, rejected } = filterByConstraints([cafe, bar, noHalal], drinkCtx(['halal']));
  assert.deepStrictEqual(passed.map((p) => p.venue?.id ?? p.id), ['d-cafe']);
  assert.deepStrictEqual(rejected.map((r) => r.reasons), [['diet:halal'], ['diet:halal']]);
});

test('vegetarian and vegan needs do not change a drink stop, even in strict mode', () => {
  const { passed } = filterByConstraints([drinkAt('cafe'), drinkAt('bar')], drinkCtx(['vegetarian', 'vegan']));
  assert.strictEqual(passed.length, 2);
});

test('a drink place carries no dietary caveat, a food place still does', () => {
  const data = loadPlanData();
  const centre = { lat: 1.2803, lng: 103.8448 };
  const members = [{ id: 'a', home: centre, dietary: ['halal'] }];
  const drinks = converge({ members, centre, occasion: 'catch_up', dateTime: '2026-10-13T15:00', durationMinutes: 60, categories: ['drink'], unknownPolicy: 'lenient' }, data);
  assert.strictEqual(drinks.status, 'ok');
  for (const r of drinks.results) {
    assert.notStrictEqual(r.venue.kind, 'bar');
    assert.deepStrictEqual([r.verify, r.dietUnknown], [[], []]);
  }
  const food = converge({ members, centre, occasion: 'catch_up', dateTime: '2026-10-13T12:30', durationMinutes: 60, categories: ['eat'], unknownPolicy: 'lenient' }, data);
  assert.ok(food.results.some((r) => r.dietUnknown.includes('halal') || r.verify.includes('halal')));
});

test('searchVenues says which needs are only likely, and which have no data', () => {
  const { venues } = mergeCuratedWithCdc([oneMapCentre('North Bridge Road Market')], [cdcSite()]);
  const members = [{ id: 'a', dietary: ['halal', 'vegan'] }];
  const [found] = searchVenues({ query: 'north bridge', centre: { lat: 1.3056, lng: 103.8639 }, dateTime: '2026-10-13T12:30', members, unknownPolicy: 'lenient' }, { venues });
  assert.deepStrictEqual(found.verify, ['halal']);
  assert.deepStrictEqual(found.dietUnknown, ['vegan']);
  const [plain] = searchVenues({ query: 'north bridge', centre: { lat: 1.3056, lng: 103.8639 }, dateTime: '2026-10-13T12:30' }, { venues });
  assert.deepStrictEqual([plain.verify, plain.dietUnknown], [[], []]);
});

test('lenient mode ranks places that likely meet more of the group’s needs first: all met, then fewer, then none known', () => {
  const data = loadPlanData();
  const centre = { lat: 1.3008, lng: 103.8559 }; // Bugis: food centres likely halal and vegetarian, nothing known vegan
  const members = [{ id: 'a', home: centre, dietary: ['halal', 'vegetarian', 'vegan'] }];
  const ask = (more = {}) => converge({ members, centre, occasion: 'catch_up', dateTime: '2026-10-13T12:30', durationMinutes: 60, categories: ['eat'], unknownPolicy: 'lenient', topN: 10, ...more }, data);
  const { status, results } = ask();
  assert.strictEqual(status, 'ok');
  const misses = results.map((r) => r.dietUnknown.length);
  // Never a place that meets fewer needs above one that meets more.
  assert.deepStrictEqual(misses, [...misses].sort((a, b) => a - b));
  // The best meets at least two of the three, and places with nothing known still follow.
  assert.ok(misses[0] <= 1);
  assert.ok(misses.includes(3), 'places with nothing known still follow');
  // The tiering beats the score: a place with nothing known can score better and still come below.
  const firstUnknown = results.find((r) => r.dietUnknown.length === 3);
  assert.ok(results.indexOf(firstUnknown) > 0);
  // Within a tier the planner's score still decides.
  for (let i = 1; i < results.length; i++) if (misses[i] === misses[i - 1]) assert.ok(results[i].score >= results[i - 1].score - 1e-9);
  // With no needs nothing is reordered: plain score order.
  const plain = converge({ members: [{ id: 'a', home: centre }], centre, occasion: 'catch_up', dateTime: '2026-10-13T12:30', durationMinutes: 60, categories: ['eat'], unknownPolicy: 'lenient', topN: 10 }, data);
  const scores = plain.results.map((r) => r.score);
  assert.deepStrictEqual(scores, [...scores].sort((a, b) => a - b));
});

test('roam ranks the same way: the food places that likely meet more needs first', () => {
  const data = loadPlanData();
  const current = { lat: 1.3008, lng: 103.8559 };
  const r = roam({ current, members: [{ id: 'a', dietary: ['halal', 'vegetarian', 'vegan'] }], occasion: 'catch_up', dateTime: '2026-10-13T12:30', durationMinutes: 60, categories: ['eat'], unknownPolicy: 'lenient', topN: 10 }, data);
  assert.strictEqual(r.status, 'ok');
  const misses = r.results.map((x) => x.dietUnknown.length);
  assert.deepStrictEqual(misses, [...misses].sort((a, b) => a - b));
  assert.ok(misses[0] < 3);
});
