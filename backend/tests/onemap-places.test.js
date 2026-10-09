// OneMap's government place lists (sport centres, attractions, parks, hawker centres...) and NEA's hawker closure
// dates: converting them, filtering them, and merging them into the venues the planner reads.
import { test } from 'vitest';
import assert from 'node:assert';
import { fromOneMapRow, fromOneMapTheme, parseOpeningHoursText, cleanName, isRealPark } from '../src/planner/onemap-adapter.js';
import { parseClosureRows, attachClosures, isClosedOn } from '../src/planner/hawker-closures.js';
import { filterByConstraints } from '../src/planner/filters.js';
import { createOneMap } from '../src/services/onemap.js';
import { dropKnownPlaces, loadPlanData } from '../src/db/venues.js';
import { roam } from '../src/planner/engine.js';

// Rows as OneMap sends them (trimmed from real answers, 9 Oct 2026).
const SPORT = { NAME: 'Bukit Canberra Sport Centre', DESCRIPTION: 'https://www.activesgcircle.gov.sg/facilities', ADDRESSBLOCKHOUSENUMBER: '21', ADDRESSPOSTALCODE: '756973', ADDRESSSTREETNAME: 'Canberra Link', LatLng: '1.44826336187663,103.822763637644' };
const ATTRACTION = { NAME: 'Sri Mariamman Temple', DESCRIPTION: 'Singapore’s oldest Hindu temple.', OPENING_HOURS: 'Daily from 7am â€“ 12pm, and 6pm â€“ 9pm', PHOTOURL: 'http://www.visitsingapore.com/photo.jpg', PHOTOCREDITS: 'STB', LATITUDE: '1.2826', LONGTITUDE: '103.8452' };
const HAWKER = { NAME: 'Adam Road Food Centre', STATUS: 'Existing', PHOTOURL: 'http://www.nea.gov.sg/images/x.jpg', NUMBER_OF_COOKED_FOOD_STALLS: '32', LatLng: '1.324131966,103.8141632' };

// ---------------- converting rows
test('a sport centre becomes an activity with its address and default hours, labelled as defaults', () => {
  const v = fromOneMapRow('sportsg_sport_facilities', SPORT);
  assert.strictEqual(v.category, 'activity');
  assert.strictEqual(v.kind, 'sports');
  assert.strictEqual(v.address, '21 Canberra Link, Singapore 756973');
  assert.strictEqual(v.website, 'https://www.activesgcircle.gov.sg/facilities');
  assert.strictEqual(v.description, null); // the description was only a link
  assert.deepStrictEqual(v.openingHours, [['07:00', '22:00']]);
  assert.strictEqual(v.dataQuality.hoursAssumed, true);
  assert.strictEqual(v.diet, null); // activities skip diet filters
  assert.strictEqual(v.source, 'onemap');
});
test('a tourist attraction keeps its real hours, its photo (as https) and its credit', () => {
  const v = fromOneMapRow('tourism', ATTRACTION);
  assert.deepStrictEqual(v.openingHours, [['07:00', '12:00'], ['18:00', '21:00']]);
  assert.strictEqual(v.dataQuality.hoursAssumed, false);
  assert.strictEqual(v.photoUrl, 'https://www.visitsingapore.com/photo.jpg');
  assert.strictEqual(v.photoCredit, 'STB');
  assert.strictEqual(v.openingHoursText, 'Daily from 7am – 12pm, and 6pm – 9pm');
  assert.strictEqual(v.lat, 1.2826);
});
test('a hawker centre is food with unknown diet; one under construction is left out', () => {
  const v = fromOneMapRow('ssot_hawkercentres', HAWKER);
  assert.strictEqual(v.category, 'eat');
  assert.deepStrictEqual([v.diet.halal, v.diet.vegetarian], ['unknown', 'unknown']);
  assert.strictEqual(v.foodStalls, 32);
  assert.strictEqual(fromOneMapRow('ssot_hawkercentres', { ...HAWKER, STATUS: 'Under Construction' }), null);
  assert.strictEqual(fromOneMapRow('ssot_hawkercentres', { ...HAWKER, LatLng: '' }), null);
});
test('an unknown theme is a bug, not a silent skip', () => {
  assert.throws(() => fromOneMapRow('nope', SPORT), /unknown theme/);
});

// ---------------- opening hours, names, parks
test('parseOpeningHoursText reads OneMap free text, and gives up rather than guessing', () => {
  assert.deepStrictEqual(parseOpeningHoursText('Monday to Saturday, 9am – 5pm'), [['09:00', '17:00']]);
  assert.deepStrictEqual(parseOpeningHoursText('Daily, 9am â€“6pm'), [['09:00', '18:00']]);
  assert.deepStrictEqual(parseOpeningHoursText('Monday to Sunday: 9.30am – 12pm'), [['09:30', '12:00']]);
  assert.deepStrictEqual(parseOpeningHoursText('Daily, 24 hours'), [['00:00', '24:00']]);
  assert.deepStrictEqual(parseOpeningHoursText('Open 24/7'), [['00:00', '24:00']]);
  assert.deepStrictEqual(parseOpeningHoursText('6pm - 2am'), [['18:00', '02:00']]); // past midnight
  assert.strictEqual(parseOpeningHoursText('By appointment'), null);
  assert.strictEqual(parseOpeningHoursText(undefined), null);
});
test('parseOpeningHoursText: two days with the same opening keep the earlier closing time (never says open when shut)', () => {
  const text = 'Sunday to Thursday, 10am - 7pm, Friday to Saturday, 10am - 10pm';
  assert.deepStrictEqual(parseOpeningHoursText(text), [['10:00', '19:00']]);
});
test('cleanName: mojibake, capitals, abbreviations and project notes', () => {
  assert.strictEqual(cleanName('St Andrewâ€™s Cathedral'), 'St Andrew’s Cathedral');
  assert.strictEqual(cleanName('FARQUHAR GARDEN (FCP)'), 'Farquhar Garden');
  assert.strictEqual(cleanName('BULIM PARK (PHASE 1)'), 'Bulim Park');
});
test('isRealPark keeps parks and nature areas, drops playgrounds, fitness corners, open spaces and car parks', () => {
  for (const n of ['BISHAN-ANG MO KIO PARK', 'LABRADOR NATURE RESERVE', 'PULAU UBIN AND CHEK JAWA', 'JANGGUS GARDEN']) assert.ok(isRealPark(n), n);
  for (const n of ['GROVE LANE PG', 'HOLLAND GROVE VIEW FC', 'ROWELL RD OS', 'TRAS LINK PK', 'EAST COAST PARK AREA E1 CAR PARK', 'CHOA CHU KANG WAY PARK (PD WORKSITE)']) assert.ok(!isRealPark(n), n);
});
test('fromOneMapTheme: the same name twice in one place is kept once; somewhere else, it gets its own id', () => {
  const park = { NAME: 'FABER HEIGHTS PARK', LatLng: '1.35,103.75' };
  assert.strictEqual(fromOneMapTheme('nationalparks', [park, park]).length, 1);
  const two = fromOneMapTheme('nationalparks', [park, { ...park, LatLng: '1.40,103.80' }]);
  assert.deepStrictEqual(two.map((v) => v.id), ['onemap_nationalparks_faber-heights-park', 'onemap_nationalparks_faber-heights-park-2']);
});

// ---------------- hawker closures
const CLOSURE_ROW = {
  name: 'Adam Road Food Centre', latitude_hc: '1.324131966', longitude_hc: '103.8141632',
  q1_cleaningstartdate: '30/3/2026', q1_cleaningenddate: '31/3/2026', q2_cleaningstartdate: '8/6/2026', q2_cleaningenddate: '8/6/2026',
  q3_cleaningstartdate: 'NA', q3_cleaningenddate: 'NA', q4_cleaningstartdate: '7/12/2026', q4_cleaningenddate: '8/12/2026',
  other_works_startdate: '1/7/2026', other_works_enddate: '31/7/2026',
};
test('parseClosureRows reads the quarters and repairs, as YYYY-MM-DD, and skips "NA"', () => {
  const [c] = parseClosureRows([CLOSURE_ROW]);
  assert.deepStrictEqual(c.periods, [
    { from: '2026-03-30', to: '2026-03-31', reason: 'cleaning' },
    { from: '2026-06-08', to: '2026-06-08', reason: 'cleaning' },
    { from: '2026-12-07', to: '2026-12-08', reason: 'cleaning' },
    { from: '2026-07-01', to: '2026-07-31', reason: 'repairs' },
  ]);
  assert.deepStrictEqual(parseClosureRows([{ ...CLOSURE_ROW, latitude_hc: 'x' }]), []);
});
test('closures attach to the centre and its large CDC site, not to a café or a coffee shop nearby', () => {
  const closures = parseClosureRows([CLOSURE_ROW]);
  const centre = fromOneMapRow('ssot_hawkercentres', HAWKER);
  const cdcCentre = { id: 'cdc_1', name: 'Food stalls at 2 Adam Road', category: 'eat', source: 'cdc', siteKind: 'large_site', lat: 1.3242, lng: 103.8142 };
  const coffeeShop = { ...cdcCentre, id: 'cdc_2', siteKind: 'food_cluster' };
  const cafe = { id: 'x', name: 'Cafe Next Door', category: 'drink', kind: 'cafe', lat: 1.3241, lng: 103.8141 };
  const [a, b, c, d] = attachClosures([centre, cdcCentre, coffeeShop, cafe], closures);
  assert.strictEqual(a.closures.length, 4);
  assert.strictEqual(b.closures.length, 4);
  assert.strictEqual(c.closures, undefined);
  assert.strictEqual(d.closures, undefined);
});
test('a closed hawker centre is filtered out on its closed days only', () => {
  const [centre] = attachClosures([fromOneMapRow('ssot_hawkercentres', HAWKER)], parseClosureRows([CLOSURE_ROW]));
  const ctx = date => ({ members: [{ id: 'a' }], dateTime: `${date}T12:00`, categories: ['eat'], unknownPolicy: 'lenient' });
  assert.ok(isClosedOn(centre, '2026-07-15'));
  assert.deepStrictEqual(filterByConstraints([centre], ctx('2026-07-15')).rejected[0].reasons, ['closed_for_cleaning']);
  assert.deepStrictEqual(filterByConstraints([centre], ctx('2026-03-31')).rejected[0].reasons, ['closed_for_cleaning']);
  assert.strictEqual(filterByConstraints([centre], ctx('2026-04-01')).passed.length, 1);
});

// ---------------- merging, and the snapshot the app serves
test('dropKnownPlaces: a place the hand-made lists already have is skipped', () => {
  const known = [{ name: 'Tiong Bahru Market and Food Centre', kind: 'hawker', lat: 1.2852, lng: 103.8325 }];
  const fromOneMap = [
    { name: 'Tiong Bahru Market', kind: 'hawker', lat: 1.2850, lng: 103.8322 },
    { name: 'Bukit Canberra Sport Centre', kind: 'sports', lat: 1.448, lng: 103.822 },
  ];
  assert.deepStrictEqual(dropKnownPlaces(fromOneMap, known).map((v) => v.name), ['Bukit Canberra Sport Centre']);
});
const data = loadPlanData();
test('the snapshot adds sport centres, attractions, museums, libraries, theatres and parks, each once', () => {
  const kinds = new Set(data.venues.filter((v) => v.source === 'onemap').map((v) => v.kind));
  for (const k of ['sports', 'attraction', 'museum', 'library', 'theatre', 'park', 'hawker']) assert.ok(kinds.has(k), k);
  assert.ok(data.venues.filter((v) => v.category === 'activity').length > 300);
  assert.strictEqual(data.venues.filter((v) => /tiong bahru market/i.test(v.name)).length, 1);
  assert.ok(data._meta.sources.hawkerClosures > 100);
});
test('Roam suggests real sport centres now (there were 2 sports places before)', () => {
  const sports = data.venues.filter((v) => v.kind === 'sports' && v.source === 'onemap');
  assert.ok(sports.length >= 40);
  // Standing at a sport centre, asking for activities: that centre is among the suggestions.
  const here = sports.find((v) => /bishan/i.test(v.name)) ?? sports[0];
  const out = roam({ current: { lat: here.lat, lng: here.lng }, members: [{ id: 'a' }], occasion: 'catch_up', dateTime: '2026-10-10T10:00', categories: ['activity'], topN: 20 }, data);
  assert.strictEqual(out.status, 'ok');
  assert.ok(out.results.some((r) => r.venueId === here.id), `${here.name} not suggested`);
});

// ---------------- the OneMap theme download
test('onemap.theme needs an account, sends the token, and drops the first row (it describes the theme)', async () => {
  const http = {
    postJson: async () => ({ access_token: 'tok', expiry_timestamp: '4102444800' }),
    getJson: async (url, { headers }) => {
      assert.match(url, /retrieveTheme\?queryName=museum$/);
      assert.deepStrictEqual(headers, { Authorization: 'tok' });
      return { SrchResults: [{ FeatCount: 1, Theme_Name: 'Museums' }, { NAME: 'National Museum' }] };
    },
  };
  assert.deepStrictEqual(await createOneMap({ http, email: 'a', password: 'b' }).theme('museum'), [{ NAME: 'National Museum' }]);
  await assert.rejects(createOneMap({ http }).theme('museum'), /need an account/);
});
