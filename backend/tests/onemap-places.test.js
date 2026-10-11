// OneMap's government place lists (sport centres, attractions, parks, hawker centres...) and NEA's hawker closure
// dates: converting them, filtering them, and merging them into the venues the planner reads.
import { test, describe } from 'vitest';
import assert from 'node:assert';
import {
  fromOneMapRow, fromOneMapTheme, parseOpeningHoursText, cleanName, isRealPark, fixText, https, stripContacts, postalCodeOf, repairAddress,
  descriptionOf, closedWeekdaysOf, isByAppointmentOnly, notInPoolBecause, hawkerDisplayName, isSamePlace, dedupeOneMapVenues, preparePool,
} from '../src/planner/onemap-adapter.js';
import { explain, reasonTags } from '../src/planner/scoring.js';
import { parseClosureRows, parseClosureReport, attachClosures, isClosedOn, closureCoverage, closureStaleWarning } from '../src/planner/hawker-closures.js';
import { inStableOrder, snapshotProblems, takeSnapshot } from '../scripts/build-onemap-places.js';
import { OneMapUnavailableError } from '../src/services/onemap.js';
import { mkdtempSync, rmSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { filterByConstraints } from '../src/planner/filters.js';
import { createOneMap } from '../src/services/onemap.js';
import { dropKnownPlaces, loadPlanData } from '../src/db/venues.js';
import { roam } from '../src/planner/engine.js';
import * as A from '../src/planner/cdc-adapter.js';
import { fromGooglePlace } from '../src/planner/google-adapter.js';

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


// ================================================================ repairs from the audit of the OneMap places
// ---------------- copied text
test('fixText: UTF-8 read as Windows-1252 is decoded back, every symbol, not a list of patterns', () => {
  assert.strictEqual(fixText('Marina Bay SandsÂ®'), 'Marina Bay Sands®');
  assert.strictEqual(fixText('Â©Darren Soh/National Gallery'), '©Darren Soh/National Gallery');
  assert.strictEqual(fixText('Universal Studios Singaporeâ„¢ Theme Park'), 'Universal Studios Singapore™ Theme Park');
  assert.strictEqual(fixText('Daily, 9am â€“ 6pm, St Andrewâ€™s'), 'Daily, 9am – 6pm, St Andrew’s');
  assert.strictEqual(fixText('CafÃ© Ã\u00A0 la carte, naÃ¯ve, SeÃ±or'), 'Café à la carte, naïve, Señor'); // letters nobody listed
  assert.strictEqual(fixText('smile ðŸ˜€'), 'smile 😀'); // four bytes
});
test('fixText: text that is already right is left alone, and a run that is not valid UTF-8 is left as it is', () => {
  assert.strictEqual(fixText('St Andrew’s – Café ® ™'), 'St Andrew’s – Café ® ™');
  assert.strictEqual(fixText('Ã and Â alone'), 'Ã and Â alone');
  assert.strictEqual(fixText(null), '');
});
test('fixText: HTML tags and entities go, a tag with its bracket missing too, and a lost apostrophe comes back', () => {
  assert.strictEqual(fixText('The Marina Bay Sands<sup>Â®</sup> SkyPark is'), 'The Marina Bay Sands® SkyPark is');
  assert.strictEqual(fixText('SkyPark<supÂ® Operating Hours - Monday'), 'SkyPark® Operating Hours - Monday');
  assert.strictEqual(fixText('one<br/>two <b>bold</b> &amp; <a href="x">link</a>'), 'one two bold & link');
  assert.strictEqual(fixText('5 < 6'), '5 < 6');
  assert.strictEqual(fixText('the site�s history'), 'the site’s history');
});
test('stripContacts: an email address or a phone number goes, with the sentence that offers it', () => {
  assert.strictEqual(
    stripContacts('Visits are available only by appointment. For more information, email jewishwb@singnet.com.sg or call +65 6337 2189 (ext. 103)'),
    'Visits are available only by appointment.',
  );
  assert.strictEqual(stripContacts('Daily 9am – 6pm. Call 6337 2189 to book. Free entry.'), 'Daily 9am – 6pm. Free entry.');
  assert.strictEqual(stripContacts('Open 9.30am – 5pm, Monday to Friday'), 'Open 9.30am – 5pm, Monday to Friday'); // times are not numbers to call
  assert.strictEqual(stripContacts('Write to hello@example.org'), 'Write to');
});
test('https: adds the scheme to a host name, upgrades http, and gives up on anything that is not a link to a host', () => {
  assert.strictEqual(https('http://www.nea.gov.sg/x.jpg'), 'https://www.nea.gov.sg/x.jpg');
  assert.strictEqual(https('https://www.nea.gov.sg/x.jpg'), 'https://www.nea.gov.sg/x.jpg');
  assert.strictEqual(https('www.yoursingapore.com/content/dam/a.jpg'), 'https://www.yoursingapore.com/content/dam/a.jpg');
  assert.strictEqual(https('//cdn.example.com/a.jpg'), 'https://cdn.example.com/a.jpg');
  for (const bad of ['/content/dam/a.jpg', 'NIL', '', null, undefined, 'javascript:alert(1)', 'ftp://x.com/a', 'a.jpg', 'data:image/png;base64,AAA']) assert.strictEqual(https(bad), null, String(bad));
});
test('postal codes and addresses: "0" is no postal code, a lost leading zero comes back', () => {
  assert.strictEqual(postalCodeOf('88995'), '088995');
  assert.strictEqual(postalCodeOf('0'), null);
  assert.strictEqual(postalCodeOf('NIL'), null);
  assert.strictEqual(postalCodeOf('1234567'), null);
  assert.strictEqual(repairAddress('Esplanade Park, Singapore 0'), 'Esplanade Park');
  assert.strictEqual(repairAddress('1, Singapore 38981'), '1, Singapore 038981');
  assert.strictEqual(repairAddress('21 Canberra Link, Singapore 756973'), '21 Canberra Link, Singapore 756973');
  assert.strictEqual(repairAddress(null), null);
  const row = { NAME: 'Esplanade Park Bandstand', LatLng: '1.29,103.85', ADDRESSSTREETNAME: 'Esplanade Park', ADDRESSPOSTALCODE: '0' };
  const v = fromOneMapRow('tourism', row);
  assert.strictEqual(v.address, 'Esplanade Park');
  assert.strictEqual(v.postalCode, null);
});
test('descriptions: a bare link, a programme code and a branch code are not descriptions', () => {
  for (const code of ['HUP Standard Upgrading', 'HUP Rebuilding', 'Opted out of HUP', 'New Centre', 'New Replacement Centre', 'CCK', 'NAS', 'SBGL', 'https://www.activesgcircle.gov.sg/facilities']) assert.strictEqual(descriptionOf(code), null, code);
  assert.strictEqual(descriptionOf('Singapore’s oldest Hindu temple.'), 'Singapore’s oldest Hindu temple.');
  assert.strictEqual(descriptionOf('Stadium Walk'), 'Stadium Walk'); // a street name is not a code
  const hawker = fromOneMapRow('ssot_hawkercentres', { ...HAWKER, DESCRIPTION: 'HUP Rebuilding' });
  assert.strictEqual(hawker.description, null);
});
test('a row turns into a clean venue: photo link, credit, contact details, text', () => {
  const v = fromOneMapRow('tourism', {
    NAME: 'Marina Bay SandsÂ®', LatLng: '1.283,103.8608', PHOTOURL: 'www.yoursingapore.com/a.jpg', PHOTOCREDITS: 'Â©Darren Soh',
    DESCRIPTION: 'A <b>feat</b> of engineering<sup>Â®</sup>.', OPENING_HOURS: 'Daily, 10am â€“ 6pm. Email info@mbs.example or call 6688 8868.',
  });
  assert.strictEqual(v.name, 'Marina Bay Sands®');
  assert.strictEqual(v.photoUrl, 'https://www.yoursingapore.com/a.jpg');
  assert.strictEqual(v.photoCredit, '©Darren Soh');
  assert.strictEqual(v.description, 'A feat of engineering®.');
  assert.strictEqual(v.openingHoursText, 'Daily, 10am – 6pm.');
  assert.deepStrictEqual(v.openingHours, [['10:00', '18:00']]);
  const noPhoto = fromOneMapRow('tourism', { NAME: 'Hajjah Fatimah Mosque', LatLng: '1.3,103.86', PHOTOURL: '/content/dam/x.jpg', PHOTOCREDITS: 'STB' });
  assert.strictEqual(noPhoto.photoUrl, null);
  assert.strictEqual(noPhoto.photoCredit, null); // a credit for a photo we do not show
});
test('coordinates must be in Singapore: the CDC bounds, wide enough for Pulau Unum', () => {
  assert.ok(fromOneMapRow('nationalparks', { NAME: 'PULAU UNUM', LatLng: '1.43303286322572,104.053781817789' }));
  for (const bad of ['0,0', '103.8,1.3', '1.3,', ',103.8', 'x,y', '1.3,105.2']) assert.strictEqual(fromOneMapRow('tourism', { NAME: 'Nowhere', LatLng: bad }), null, bad);
  assert.strictEqual(fromOneMapRow('tourism', { NAME: 'Nowhere', LATITUDE: '', LONGTITUDE: '' }), null);
});

// ---------------- days of the week, appointments, exclusions
test('closedWeekdaysOf reads plain "closed on" statements and nothing else', () => {
  assert.deepStrictEqual(closedWeekdaysOf('Tuesday to Sunday, 9am – 6pm, Closed on Monday'), [1]);
  assert.deepStrictEqual(closedWeekdaysOf('Tuesday to Sunday, 9am – 5.30pm,Closed on Monday (except on public holidays)'), [1]);
  assert.deepStrictEqual(closedWeekdaysOf('Tuesday to Saturday, 11am - 7pm, Galleries closed on Monday and public holidays.'), [1]);
  assert.deepStrictEqual(closedWeekdaysOf('Closed every Sunday and Monday'), [0, 1]);
  assert.deepStrictEqual(closedWeekdaysOf('Closed on Mondays, Tuesdays & Wednesdays'), [1, 2, 3]);
  assert.deepStrictEqual(closedWeekdaysOf('Closed on Sat to Mon'), [0, 1, 6]);
  assert.deepStrictEqual(closedWeekdaysOf('Closed on public holidays'), []);
  assert.deepStrictEqual(closedWeekdaysOf('Tuesday to Sunday, 12pm – 7pm'), []); // what is open is not read as what is shut
  assert.deepStrictEqual(closedWeekdaysOf('Daily, 5am - 12am. Jacob Ballas Children’s Garden closed every Monday'), []); // one part of a place
  assert.deepStrictEqual(closedWeekdaysOf(null), []);
});
test('isByAppointmentOnly', () => {
  assert.ok(isByAppointmentOnly('Visits are available only by appointment. For more information'));
  assert.ok(isByAppointmentOnly('Visits are by appointment only.Visitors must sign up'));
  assert.ok(!isByAppointmentOnly('Daily, 9am – 6pm'));
  assert.ok(!isByAppointmentOnly(undefined));
});
test('notInPoolBecause: each theatre rule, parks and islets, appointments; and what stays', () => {
  const theatre = name => notInPoolBecause({ oneMapTheme: 'theatre', name });
  assert.strictEqual(theatre('Boon Lay Community Club Mini Theatre'), 'community club or centre hall');
  assert.strictEqual(theatre('Pek Kio Community Centre Performing Theatre'), 'community club or centre hall');
  assert.strictEqual(theatre('The Serangoon CC Mini Theatre'), 'community club or centre hall');
  assert.strictEqual(theatre('Republic Polytechnic Theatre'), 'school, college or polytechnic hall');
  assert.strictEqual(theatre('Theatre@illuminITE College Central'), 'school, college or polytechnic hall');
  assert.strictEqual(theatre('UCC Hall'), 'school, college or polytechnic hall');
  assert.strictEqual(theatre('Tan Cheng Siong Drama Theatre (ACSB)'), 'school, college or polytechnic hall');
  assert.strictEqual(theatre('THE RICE COMPANY LIMITED Auditorium'), 'auditorium');
  assert.strictEqual(theatre('Toa Payoh Central Amphitheatre'), 'amphitheatre');
  assert.strictEqual(theatre('NAFA Studio Theatre'), 'studio room');
  for (const keep of ['Esplanade Theatre', 'Victoria Theatre', 'LASALLE Singapore Airlines Theatre', 'NAFA Lee Foundation Theatre', 'SOTA Drama Theatre', 'Drama Centre Theatre', 'Kallang Theatre', 'Gateway Theatre']) assert.strictEqual(theatre(keep), null, keep);
  assert.strictEqual(notInPoolBecause({ oneMapTheme: 'nationalparks', name: 'Ceylon Road Interim Park' }), 'interim park');
  assert.strictEqual(notInPoolBecause({ oneMapTheme: 'nationalparks', name: 'Pulau Sekudu' }), 'uninhabited islet');
  assert.strictEqual(notInPoolBecause({ oneMapTheme: 'nationalparks', name: 'Pulau Ubin and Chek Jawa' }), null);
  assert.strictEqual(notInPoolBecause({ oneMapTheme: 'tourism', name: 'NUS Baba House', openingHoursText: 'Visits are by appointment only.' }), 'by appointment only');
  assert.strictEqual(notInPoolBecause({ oneMapTheme: 'theatre', name: 'Interim Park Theatre' }), null); // an interim park is a park rule
});
test('hawkerDisplayName: the name in the bracket when a street and block come first, else the name as it is', () => {
  assert.strictEqual(hawkerDisplayName('Redhill Lane Blk 79 (Redhill Market)'), 'Redhill Market');
  assert.strictEqual(hawkerDisplayName('Smith Street Blk 335 (Chinatown Complex Market)'), 'Chinatown Complex Market');
  assert.strictEqual(hawkerDisplayName('Maxwell Food Centre (Kim Hua Market)'), 'Maxwell Food Centre (Kim Hua Market)');
  assert.strictEqual(hawkerDisplayName('Toa Payoh Lorong 4 Blk 93'), 'Toa Payoh Lorong 4 Blk 93');
  const { pool } = preparePool([{ id: 'x', kind: 'hawker', oneMapTheme: 'ssot_hawkercentres', name: 'Redhill Lane Blk 79 (Redhill Market)', openingHoursText: null }]);
  assert.deepStrictEqual([pool[0].name, pool[0].officialName, pool[0].id], ['Redhill Market', 'Redhill Lane Blk 79 (Redhill Market)', 'x']);
});

// ---------------- one place listed twice
const place = (id, theme, name, lat, lng, extra = {}) => ({ id, oneMapTheme: theme, name, lat, lng, category: 'activity', kind: theme, dataQuality: { hoursAssumed: true }, photoUrl: null, ...extra });
test('dedupeOneMapVenues: one row per place, the one with real hours first, then a photo; its id stays', () => {
  const rows = [
    place('a', 'theatre', 'Esplanade Theatre', 1.2898, 103.8555),
    place('b', 'tourism', 'Esplanade Theatre', 1.2900, 103.8560, { photoUrl: 'https://x/p.jpg' }),
    place('c', 'tourism', 'Esplanade Theatres on the Bay', 1.2899, 103.8556, { dataQuality: { hoursAssumed: false } }),
    place('d', 'museum', 'National Museum of Singapore', 1.2966, 103.8485),
    place('e', 'tourism', 'National Museum of Singapore', 1.2970, 103.8486, { photoUrl: 'https://x/m.jpg' }),
    place('f', 'tourism', 'Sultan Mosque', 1.3023, 103.8591),
  ];
  const { venues, clusters } = dedupeOneMapVenues(rows);
  assert.deepStrictEqual(venues.map(v => v.id).sort(), ['c', 'e', 'f']);
  assert.deepStrictEqual(clusters.map(c => c[0]).sort(), ['c', 'e']);
  assert.deepStrictEqual(clusters.find(c => c[0] === 'c').slice(1).sort(), ['a', 'b']);
});
test('isSamePlace: neighbours with alike names stay apart (blocks, the libraries, a park and its hawker centre)', () => {
  const hawker = (id, name, lat) => place(id, 'ssot_hawkercentres', name, lat, 103.81, { category: 'eat', kind: 'hawker' });
  assert.ok(!isSamePlace(hawker('1', 'Redhill Market', 1.2890), hawker('2', 'Redhill Food Centre', 1.2895)));
  assert.ok(!isSamePlace(place('3', 'libraries', 'Central Library', 1.297, 103.854), place('4', 'libraries', 'Central Arts Library', 1.297, 103.854)));
  assert.ok(!isSamePlace(place('5', 'nationalparks', 'Market Street Park', 1.2840, 103.85), hawker('6', 'Market Street Hawker Centre', 1.2842)));
  assert.ok(!isSamePlace(place('7', 'tourism', 'Peranakan Museum', 1.2943, 103.8485), place('8', 'tourism', 'Peranakan Museum', 1.35, 103.9))); // far apart
  assert.ok(isSamePlace(place('9', 'tourism', 'Peranakan Museum Singapore: History & Culture', 1.2943, 103.8485), place('10', 'museum', 'Peranakan Museum', 1.2946, 103.8485)));
});

// ---------------- hawker closure dates
test('parseClosureRows rejects a row with blank, missing or non-numeric coordinates, and says why', () => {
  const blank = { ...CLOSURE_ROW, name: 'Nowhere Market', latitude_hc: '', longitude_hc: '' };
  const spaces = { ...CLOSURE_ROW, name: 'Spaces Market', latitude_hc: '  ', longitude_hc: ' ' };
  const missing = { ...CLOSURE_ROW, name: 'Missing Market', latitude_hc: undefined, longitude_hc: null };
  const zero = { ...CLOSURE_ROW, name: 'Zero Market', latitude_hc: '0', longitude_hc: '0' };
  const noDates = { ...CLOSURE_ROW, name: 'Undated Market', q1_cleaningstartdate: 'NA', q1_cleaningenddate: 'NA', q2_cleaningstartdate: 'NA', q2_cleaningenddate: 'NA', q4_cleaningstartdate: 'NA', q4_cleaningenddate: 'NA', other_works_startdate: 'NA', other_works_enddate: 'NA' };
  assert.deepStrictEqual(parseClosureRows([blank, spaces, missing, zero, noDates]), []);
  const { closures, dropped } = parseClosureReport([CLOSURE_ROW, blank, zero, noDates]);
  assert.strictEqual(closures.length, 1);
  assert.deepStrictEqual(dropped, [
    { name: 'Nowhere Market', reason: 'no_location' }, { name: 'Zero Market', reason: 'no_location' }, { name: 'Undated Market', reason: 'no_dates' },
  ]);
});
test('attachClosures: one row per venue; neighbouring blocks never share one', () => {
  const block = (id, name, lat, kind = 'hawker') => ({ id, name, lat, lng: 103.81, category: 'eat', kind, source: 'onemap' });
  const row = (name, lat, day) => ({ name, lat, lng: 103.81, periods: [{ from: day, to: day, reason: 'cleaning' }] });
  const closures = [row('Redhill Lane Blk 79 (Redhill Market)', 1.2890, '2026-11-02'), row('Redhill Lane Blk 85 (Redhill Food Centre)', 1.2895, '2026-11-03')];
  const venues = [
    { ...block('79', 'Redhill Market', 1.2890), officialName: 'Redhill Lane Blk 79 (Redhill Market)' },
    { ...block('85', 'Redhill Lane Blk 85 (Redhill Food Centre)', 1.2895) },
    block('new', 'Redhill Lane Blk 87', 1.2893), // no row of its own, 30 m from both: takes neither
  ];
  const [a, b, c] = attachClosures(venues, closures);
  assert.deepStrictEqual(a.closures.map(p => p.from), ['2026-11-02']);
  assert.deepStrictEqual(b.closures.map(p => p.from), ['2026-11-03']);
  assert.strictEqual(c.closures, undefined);
});
test('attachClosures: a curated centre takes the nearest row within 100 m, never a union of the neighbours', () => {
  const closures = [
    { name: 'Far Market', lat: 1.3000, lng: 103.8100, periods: [{ from: '2026-11-01', to: '2026-11-01', reason: 'cleaning' }] },
    { name: 'Near Market', lat: 1.3003, lng: 103.8100, periods: [{ from: '2026-11-02', to: '2026-11-02', reason: 'cleaning' }] },
  ];
  const curated = { id: 'c', name: 'Some Food Centre', category: 'eat', kind: 'hawker', source: 'curated', lat: 1.3004, lng: 103.8100 };
  const [v] = attachClosures([curated], closures);
  assert.deepStrictEqual(v.closures.map(p => p.from), ['2026-11-02']);
  const [far] = attachClosures([{ ...curated, lat: 1.3200 }], closures);
  assert.strictEqual(far.closures, undefined); // 2 km from either
});
test('closureCoverage and closureStaleWarning', () => {
  const closures = parseClosureRows([CLOSURE_ROW]);
  assert.deepStrictEqual(closureCoverage(closures), { from: '2026-03-30', to: '2026-12-08', lastCleaning: '2026-12-08', rows: 1, periods: 4 });
  assert.strictEqual(closureCoverage([]), null);
  const coverage = closureCoverage(closures);
  assert.strictEqual(closureStaleWarning(coverage, '2026-10-11'), null);
  assert.strictEqual(closureStaleWarning(coverage, '2026-11-07'), null); // 31 days to go
  assert.match(closureStaleWarning(coverage, '2026-11-08'), /end 2026-12-08, in 30 days/); // within 30 days
  assert.match(closureStaleWarning(coverage, '2026-11-09'), /end 2026-12-08, in 29 days/);
  assert.match(closureStaleWarning(coverage, '2026-12-08'), /end 2026-12-08, in 0 days/);
  assert.match(closureStaleWarning(coverage, '2027-01-05'), /ended 2026-12-08, 28 days ago/);
  assert.match(closureStaleWarning(coverage, '2027-01-05'), /pnpm build:onemap-places/);
  assert.match(closureStaleWarning(null, '2026-10-11'), /No hawker closure dates/);
});

// ---------------- the build script
test('inStableOrder: theme order, then id, whatever order they came in', () => {
  const rows = [{ id: 'b', oneMapTheme: 'museum' }, { id: 'z', oneMapTheme: 'sportsg_sport_facilities' }, { id: 'a', oneMapTheme: 'museum' }, { id: 'c', oneMapTheme: 'sportsg_sport_facilities' }];
  assert.deepStrictEqual(inStableOrder(rows).map(v => v.id), ['c', 'z', 'a', 'b']);
  assert.deepStrictEqual(inStableOrder([...rows].reverse()).map(v => v.id), ['c', 'z', 'a', 'b']);
});
test('snapshotProblems: an empty theme or empty closures means do not overwrite', () => {
  const ok = Object.fromEntries(['sportsg_sport_facilities', 'tourism', 'museum', 'libraries', 'theatre', 'nationalparks', 'ssot_hawkercentres'].map(t => [t, { rows: 5, kept: 4 }]));
  assert.deepStrictEqual(snapshotProblems(ok, [{}]), []);
  assert.match(snapshotProblems({ ...ok, museum: { rows: 0, kept: 0 } }, [{}])[0], /"museum" came back with no rows/);
  assert.match(snapshotProblems({ ...ok, museum: { rows: 3, kept: 0 } }, [{}])[0], /"museum" had 3 rows and none was kept/);
  assert.match(snapshotProblems(ok, [])[0], /closure dates came back empty/);
});
describe('takeSnapshot, with a fake OneMap and fake data.gov.sg', () => {
  const dir = mkdtempSync(join(tmpdir(), 'jio-snapshot-'));
  const fileOf = name => join(dir, name);
  const row = { NAME: 'Test Museum', LatLng: '1.30,103.85', OPENING_HOURS: 'Daily, 10am - 6pm' };
  const closureBody = { result: { records: [CLOSURE_ROW, { ...CLOSURE_ROW, name: 'Blank Market', latitude_hc: '', longitude_hc: '' }] } };
  const clients = (theme, getJson = async () => closureBody) => ({ http: { getJson }, onemap: { theme }, OneMapUnavailableError });
  const lines = [];
  const quiet = () => {
    lines.length = 0;
    vi.spyOn(console, 'log').mockImplementation(m => lines.push(`log: ${m}`));
    vi.spyOn(console, 'error').mockImplementation(m => lines.push(`error: ${m}`));
  };
  test('writes the places in theme-then-id order, and prints how many closure rows were dropped', async () => {
    quiet();
    const file = fileOf('good.json');
    const forTheme = theme => (theme === 'ssot_hawkercentres' ? [{ NAME: 'Test Food Centre', STATUS: 'Existing', LatLng: '1.3,103.8' }]
      : theme === 'nationalparks' ? [{ NAME: 'TEST PARK', LatLng: '1.3,103.8' }] : [{ ...row, NAME: 'Zed' }, { ...row, NAME: 'Alpha' }]);
    const code = await takeSnapshot(file, clients(async theme => forTheme(theme)));
    vi.restoreAllMocks();
    assert.strictEqual(code, 0);
    const written = JSON.parse(readFileSync(file, 'utf8'));
    const first = written.venues.filter(v => v.oneMapTheme === 'sportsg_sport_facilities').map(v => v.name);
    assert.deepStrictEqual(first, ['Alpha', 'Zed']);
    assert.strictEqual(written.hawkerClosures.length, 1);
    assert.ok(lines.some(l => /closure rows dropped: 1 \(Blank Market: no_location\)/.test(l)), lines.join('\n'));
  });
  test('refuses to overwrite the saved file when a theme comes back empty, and says so in one line', async () => {
    quiet();
    const file = fileOf('keep.json');
    writeFileSync(file, 'saved\n');
    const code = await takeSnapshot(file, clients(async theme => (theme === 'museum' ? [] : [row])));
    vi.restoreAllMocks();
    assert.strictEqual(code, 1);
    assert.strictEqual(readFileSync(file, 'utf8'), 'saved\n');
    assert.strictEqual(lines.filter(l => l.startsWith('error:')).length, 1);
    assert.match(lines.join('\n'), /"museum" came back with no rows/);
  });
  test('refuses when the closure dates come back empty', async () => {
    quiet();
    const file = fileOf('noclosures.json');
    const code = await takeSnapshot(file, clients(async () => [row], async () => ({ result: { records: [] } })));
    vi.restoreAllMocks();
    assert.strictEqual(code, 1);
    assert.ok(!existsSync(file));
  });
  test('a failed OneMap login is one clear line and a non-zero exit, not a stack trace', async () => {
    quiet();
    const file = fileOf('login.json');
    const code = await takeSnapshot(file, clients(async () => { throw new OneMapUnavailableError('login_failed', 'the OneMap login failed (HTTP 401)'); }));
    vi.restoreAllMocks();
    assert.strictEqual(code, 1);
    assert.deepStrictEqual(lines, ['error: OneMap login failed: check ONEMAP_EMAIL and ONEMAP_PASSWORD in backend/.env. Nothing was written.']);
    assert.ok(!existsSync(file));
    rmSync(dir, { recursive: true, force: true });
  });
});

// ---------------- guessed values are not shown as facts
test('a typical price (priceAssumed) earns no "Budget friendly" tag and no "within budget" sentence; a real price still does', () => {
  const tags = (venue) => reasonTags({ venue, walkMinutes: 20, crowd: 'busy', rainy: false, time: '12:00' });
  const library = fromOneMapRow('libraries', { NAME: 'Test Library', LatLng: '1.3,103.8' });
  assert.strictEqual(library.avgPricePerPerson, 0);
  assert.strictEqual(library.dataQuality.priceAssumed, true);
  assert.deepStrictEqual(tags(library), []);
  assert.deepStrictEqual(tags({ avgPricePerPerson: 6 }), ['Budget friendly']);
  assert.deepStrictEqual(tags({ avgPricePerPerson: 6, dataQuality: { priceAssumed: false } }), ['Budget friendly']);
  assert.deepStrictEqual(tags({ avgPricePerPerson: 6, dataQuality: { priceAssumed: true } }), []);
  // CDC venues are no exception (the lead's decision of 11 October 2026): their $5 or $6 is a typical price too.
  assert.deepStrictEqual(tags({ avgPricePerPerson: 6, source: 'cdc', dataQuality: { priceAssumed: true } }), []);
  assert.deepStrictEqual(tags({ avgPricePerPerson: 6, source: 'cdc', dataQuality: { priceAssumed: false } }), ['Budget friendly']);
  const row = venue => ({ venue: { exposure: 1, ...venue }, factors: { price: 0, occasion: 90, preference: 90, weather: 20, antiRepeat: 20, rating: 90 }, weights: { price: 8 }, hasHistory: false });
  assert.match(explain(row({ avgPricePerPerson: 6 })), /within budget/i);
  assert.match(explain(row({ avgPricePerPerson: 6, dataQuality: { priceAssumed: false } })), /within budget/i);
  assert.doesNotMatch(explain(row(library)), /within budget/i);
  assert.strictEqual(explain(row({ avgPricePerPerson: 6, dataQuality: { priceAssumed: true } })), 'Best overall balance.');
  // The same for a CDC place: no sentence while its price is typical, the sentence when its price is known.
  assert.strictEqual(explain(row({ avgPricePerPerson: 6, source: 'cdc', dataQuality: { priceAssumed: true } })), 'Best overall balance.');
  assert.match(explain(row({ avgPricePerPerson: 6, source: 'cdc', dataQuality: { priceAssumed: false } })), /within budget/i);
});
test('a typical price makes no claim for a CDC place, a OneMap place or a Google place; a known price still does', () => {
  const tags = (venue) => reasonTags({ venue, walkMinutes: 20, crowd: 'busy', rainy: false, time: '12:00' });
  const row = venue => ({ venue: { exposure: 1, ...venue }, factors: { price: 0, occasion: 90, preference: 90, weather: 20, antiRepeat: 20, rating: 90 }, weights: { price: 8 }, hasHistory: false });
  const cdc = A.buildCdcVenues(A.cleanRecords({ lastUpdated: 'test', locations: [{ id: 'm_lone', name: 'LONE NOODLE', address: '1 Test Road, #01-01,  S555555;', postalCode: '555555', type: 'HAWKER_HEARTLAND_MERCHANT', LAT: 1.31, LON: 103.87, filters: { vouchers: { hawker_heartland_merchant: true }, secondary: { budgetmeal: true } }, lastResetDate: '2024-01-01' }] }), { profiles: {} })[0];
  const oneMap = fromOneMapRow('libraries', { NAME: 'Test Library', LatLng: '1.3,103.8' });
  const google = fromGooglePlace({ id: 'g1', displayName: { text: 'Test Cafe' }, location: { latitude: 1.3, longitude: 103.8 }, primaryType: 'cafe' }, '2026-10-13T12:00');
  const googleWithLevel = fromGooglePlace({ id: 'g2', displayName: { text: 'Test Stall' }, location: { latitude: 1.3, longitude: 103.8 }, primaryType: 'cafe', priceLevel: 'PRICE_LEVEL_FREE' }, '2026-10-13T12:00');
  assert.ok(cdc && cdc.avgPricePerPerson < 10 && cdc.dataQuality.priceAssumed);
  assert.deepStrictEqual(tags(cdc), []);
  assert.doesNotMatch(explain(row(cdc)), /within budget/i);
  assert.deepStrictEqual(tags(oneMap), []);
  assert.doesNotMatch(explain(row(oneMap)), /within budget/i);
  // A Google place with no price level has a typical $20, which is not under $10 anyway; give it a low typical price to show the rule.
  assert.strictEqual(google.dataQuality.priceAssumed, true);
  assert.deepStrictEqual(tags({ ...google, avgPricePerPerson: 6 }), []);
  assert.doesNotMatch(explain(row({ ...google, avgPricePerPerson: 6 })), /within budget/i);
  // A Google place whose price comes from Google's price level is a known price.
  assert.strictEqual(googleWithLevel.dataQuality.priceAssumed, false);
  assert.strictEqual(googleWithLevel.avgPricePerPerson, 0);
  assert.deepStrictEqual(tags(googleWithLevel), ['Budget friendly']);
  assert.match(explain(row(googleWithLevel)), /within budget/i);
  // A CDC place whose price is known (none exists in the data today) keeps both.
  const known = { ...cdc, dataQuality: { ...cdc.dataQuality, priceAssumed: false } };
  assert.deepStrictEqual(tags(known), ['Budget friendly']);
  assert.match(explain(row(known)), /within budget/i);
});
test('every CDC venue the planner loads has its price labelled typical, so none can claim to be cheap', () => {
  const data = loadPlanData();
  const cdc = data.venues.filter(v => v.source === 'cdc');
  assert.ok(cdc.length > 1000);
  assert.deepStrictEqual(cdc.filter(v => v.dataQuality?.priceAssumed !== true).map(v => v.id), []);
  const tags = (venue) => reasonTags({ venue, walkMinutes: 20, crowd: 'busy', rainy: false, time: '12:00' });
  assert.deepStrictEqual(cdc.filter(v => tags(v).includes('Budget friendly')).map(v => v.id), []);
});
test('the price filter is untouched: a venue with a guessed price passes or fails max_price_pp exactly as before', () => {
  const ctx = (limit) => ({ members: [{ id: 'a' }], groupConstraints: [`max_price_pp:${limit}`], dateTime: '2026-10-13T13:00', categories: ['activity'], unknownPolicy: 'lenient' });
  const universal = fromOneMapRow('tourism', { NAME: 'Universal Studios Singapore', LatLng: '1.254,103.8238', OPENING_HOURS: 'Open daily at 10am.' });
  assert.strictEqual(universal.avgPricePerPerson, 15);
  assert.strictEqual(filterByConstraints([universal], ctx(20)).passed.length, 1);
  assert.deepStrictEqual(filterByConstraints([universal], ctx(10)).rejected[0].reasons, ['max_price']);
});
