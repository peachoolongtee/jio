'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const mock = require('./mock-data.json');
const A = require('./cdc-adapter');
const { converge, roam } = require('./engine');
const { filterByConstraints, needsVerification } = require('./filters');
const S = require('./scoring');

const rec = (name, postal, lat, lng, bm = false, address = `1 Test Road, #01-01,  S${postal};`) => ({
  id: `m_${name}_${postal}`, name, address, postalCode: postal, type: 'HAWKER_HEARTLAND_MERCHANT', LAT: lat, LON: lng,
  filters: { vouchers: { supermarket: false, hawker_heartland_merchant: true }, secondary: { budgetmeal: bm } }, lastResetDate: '2024-01-01',
});
const raw = records => ({ lastUpdated: 'test', locations: records });

// ---------------- classification ----------------
test('classifyStall: food, groceries, services, and honest unknowns', () => {
  assert.strictEqual(A.classifyStall('MEI JI FISHBALL NOODLES'), 'eat');
  assert.strictEqual(A.classifyStall('HOT & COLD DRINKS'), 'eat');
  assert.strictEqual(A.classifyStall('WEI LEI MIXED VEG RICE'), 'eat');      // "VEG" must not make it grocery
  assert.strictEqual(A.classifyStall('LIM FRUITS'), 'grocery');
  assert.strictEqual(A.classifyStall('VEGETABLE STALL 43'), 'grocery');
  assert.strictEqual(A.classifyStall('FORTUNE SUPERMARKET PTE LTD (560107)'), 'grocery');
  assert.strictEqual(A.classifyStall('MICKEY HAIR SALON'), 'other');
  assert.strictEqual(A.classifyStall('TAI DENTAL SURGERY (CHAI CHEE) PTE LTD'), 'other');
  assert.strictEqual(A.classifyStall('ROUND BOY ROASTERS'), 'unknown');      // coffee roaster or roast meats? cannot tell
});
test('classifyStall: brand names it cannot read stay unknown, never guessed', () => {
  assert.strictEqual(A.classifyStall('YUAN JIA'), 'unknown');
  assert.strictEqual(A.classifyStall('SITI ZAHERA STORE'), 'unknown');
});
test('dietHints: only ever "likely" or "unknown", never none/options/full', () => {
  assert.strictEqual(A.dietHints('AL-MADINA').halal, 'likely');
  assert.strictEqual(A.dietHints('TONG XIN VEGETARIAN').vegetarian, 'likely');
  assert.strictEqual(A.dietHints('MIXED VEG RICE').vegetarian, 'unknown');   // economy rice is not vegetarian
  assert.strictEqual(A.dietHints('ABC CHICKEN RICE').halal, 'unknown');      // a name that is silent proves nothing
  assert.strictEqual(A.dietHints('GREEN VEGAN CAFE').vegan, 'likely');
});
test('cuisineHint', () => {
  assert.strictEqual(A.cuisineHint('SEDAP NASI PADANG'), 'malay');
  assert.strictEqual(A.cuisineHint('PRATA HOUSE'), 'indian');
  assert.strictEqual(A.cuisineHint('CHOP STEAK'), 'western');
  assert.strictEqual(A.cuisineHint('XYZ'), null);
});
test('displayName and streetLabel clean the ALL-CAPS raw text', () => {
  assert.strictEqual(A.displayName('(248 SIMEI) WEYOUNG DELICACY PTE LTD'), 'Weyoung Delicacy');
  assert.strictEqual(A.displayName('YUAN JI DELIGHTS PTE. LTD.'), 'Yuan Ji Delights');
  assert.strictEqual(A.streetLabel('861 North Bridge Road, #01-83,  S198783;'), '861 North Bridge Road');
  assert.strictEqual(A.streetLabel('221 Boon Lay Place Boon Lay Shopping Centre Singapore 640221'), '221 Boon Lay Place Boon Lay Shopping Centre');
});

// ---------------- cleaning ----------------
test('cleanRecords drops bad coordinates and exact duplicates, and says so', () => {
  const { records, report } = A.cleanRecords(raw([
    rec('A NOODLE', '111111', 1.30, 103.85), rec('A NOODLE', '111111', 1.30, 103.85),
    rec('B RICE', '222222', 0, 0), { ...rec('C RICE', '333333', 1.3, 103.8), LAT: null },
  ]));
  assert.strictEqual(records.length, 1);
  assert.strictEqual(report.duplicates, 1);
  assert.strictEqual(report.invalidCoords.length, 2);
});

// ---------------- sites ----------------
const siteRecords = () => {
  const out = [];
  for (let i = 0; i < 40; i++) out.push(rec(i < 8 ? `STALL ${i} NOODLE` : `SHOP ${i}`, '050335', 1.2823, 103.8432, i === 1)); // big site
  out.push(rec('AL-MADINA NASI PADANG', '050335', 1.2823, 103.8432));
  out.push(rec('HAIR SALON X', '444444', 1.35, 103.9));                        // service only: not a food venue
  out.push(rec('LONE NOODLE', '555555', 1.31, 103.87, true));                  // single stall
  return out;
};
test('buildCdcVenues: one venue per site, not per stall; non-food sites dropped', () => {
  const v = A.buildCdcVenues(A.cleanRecords(raw(siteRecords())), { profiles: mock.occasionProfiles });
  assert.deepStrictEqual(v.map(x => x.id).sort(), ['cdc_050335', 'cdc_555555']);
  const big = v.find(x => x.id === 'cdc_050335');
  assert.strictEqual(big.siteKind, 'large_site');
  assert.strictEqual(big.cdc.stallCount, 41);
  assert.ok(big.cdc.eatStallCount >= 9);
  assert.strictEqual(big.cdc.budgetMealStalls, 1);
  assert.strictEqual(big.diet.halal, 'likely');
  assert.strictEqual(big.diet.vegan, 'unknown');
});
test('buildCdcVenues: unknown facts are labelled, not invented', () => {
  const [v] = A.buildCdcVenues(A.cleanRecords(raw([rec('LONE NOODLE', '555555', 1.31, 103.87, true)])), { profiles: mock.occasionProfiles });
  assert.strictEqual(v.rating, null);
  assert.strictEqual(v.stepFree, null);
  assert.strictEqual(v.cdcAccepted, true);
  assert.strictEqual(v.name, 'Lone Noodle');
  assert.ok(v.dataQuality.hoursAssumed && v.dataQuality.priceAssumed && v.dataQuality.forecastAreaApprox);
  assert.ok(Number.isInteger(v.occasionFit.casual_meal));
});
test('nearestArea maps a venue to the closest real forecast area', () => {
  const areas = [{ name: 'Bishan', lat: 1.3526, lng: 103.8352 }, { name: 'Tampines', lat: 1.3496, lng: 103.9568 }];
  assert.strictEqual(A.nearestArea({ lat: 1.35, lng: 103.94 }, areas), 'Tampines');
});

// ---------------- joining other venues to CDC ----------------
test('matchVenueToCdc: stall by name, hawker centre by site, and never by distance alone', () => {
  const cdc = A.buildCdcVenues(A.cleanRecords(raw(siteRecords())), { profiles: mock.occasionProfiles });
  const near = { lat: 1.28232, lng: 103.84322 }; // a few metres away
  assert.strictEqual(A.matchVenueToCdc({ ...near, name: 'Al-Madina Nasi Padang' }, cdc).cdcAccepted, 'stall');
  assert.strictEqual(A.matchVenueToCdc({ ...near, name: 'Chinatown Complex', type: 'hawker_centre' }, cdc).cdcAccepted, 'site');
  assert.strictEqual(A.matchVenueToCdc({ ...near, name: 'Fancy Wine Bar', type: 'bar' }, cdc).cdcAccepted, false);
  assert.strictEqual(A.matchVenueToCdc({ lat: 1.40, lng: 103.80, name: 'Al-Madina Nasi Padang' }, cdc).cdcAccepted, false);
});

// ---------------- engine honesty with unknowns ----------------
const cdcVenues = () => A.buildCdcVenues(A.cleanRecords(raw([
  ...Array.from({ length: 12 }, (_, i) => rec(`MALAY NASI ${i}`, '100001', 1.3500, 103.8450, i === 0)),
  ...Array.from({ length: 6 }, (_, i) => rec(`MIXED RICE ${i}`, '100002', 1.3510, 103.8460)),
])), { profiles: mock.occasionProfiles });
const data = { ...mock, venues: cdcVenues() };
const member = id => mock.members.find(m => m.id === id);
// seed: 'centroid' keeps these fixtures independent of travel-debt weighting (tested elsewhere)
const baseInput = (ids, extra = {}) => ({ members: ids.map(member), occasion: 'casual_meal', dateTime: '2026-10-10T12:30', weatherCase: 'clear', seed: 'centroid', ...extra });

test('engine: halal "likely" passes but is flagged to verify; a venue with no evidence is excluded by default', () => {
  const r = converge(baseInput(['ian', 'darius']), data);
  assert.strictEqual(r.status, 'ok');
  assert.deepStrictEqual(r.results.map(x => x.venueId), ['cdc_100001']);          // has "MALAY" stalls
  assert.deepStrictEqual(r.results[0].verify, ['halal']);
  assert.strictEqual(filterByConstraints(data.venues, { members: [member('darius')], dateTime: '2026-10-10T12:30' }).passed.length, 1);
});
test('engine: lenient policy admits unknown venues; strict still refuses', () => {
  const lenient = converge(baseInput(['ian', 'darius'], { unknownPolicy: 'lenient' }), data);
  assert.strictEqual(lenient.results.length, 2);
  const strict = filterByConstraints(data.venues, { members: [member('darius')], dateTime: '2026-10-10T12:30' });
  assert.ok(strict.rejected.some(r => r.reasons.includes('diet:halal')));
});
test('engine: step_free and sockets are unknown for CDC sites, so strict mode rejects them and says why', () => {
  const ctx = { members: [member('ian')], groupConstraints: ['step_free'], dateTime: '2026-10-10T12:30' };
  assert.strictEqual(filterByConstraints(data.venues, ctx).passed.length, 0);
  assert.strictEqual(filterByConstraints(data.venues, { ...ctx, unknownPolicy: 'lenient' }).passed.length, 2);
});
test('scoring: unknown rating is neutral, not a reward or a punishment', () => {
  assert.strictEqual(S.ratingPenalty({ rating: null }), 50);
  assert.strictEqual(S.ratingPenalty({ rating: 5 }), 0);
  assert.ok(!/rated null/.test(S.explain({ venue: { rating: null, exposure: 2, cdcAccepted: true }, factors: { occasion: 90, weather: 20, preference: 80, rating: 50, price: 0, antiRepeat: 0 }, weights: { rating: 10, cdc: 3 }, hasHistory: false })));
});
test('roam on CDC sites: a hawker area scores as cheap, CDC-accepting and explained', () => {
  const r = roam({ current: { lat: 1.351, lng: 103.846 }, members: [member('ian')], occasion: 'casual_meal', dateTime: '2026-10-10T12:30', unknownPolicy: 'lenient' }, data);
  assert.strictEqual(r.status, 'ok');
  assert.ok(r.results[0].explanation.includes('accepts CDC vouchers'));
});

// ---------------- real snapshot (skipped when the 11MB file is not next to the tests) ----------------
const real = fs.existsSync('./CDC.json');
test('real CDC.json: counts, site grouping and data-quality flags', { skip: !real }, () => {
  const r = JSON.parse(fs.readFileSync('./CDC.json', 'utf8'));
  const { records, report } = A.cleanRecords(r);
  assert.strictEqual(report.invalidCoords.length, 4);
  assert.ok(records.length > 25000);
  const v = A.buildCdcVenues({ records }, { profiles: mock.occasionProfiles });
  assert.ok(v.length > 1000 && v.length < records.length / 5, `venues: ${v.length}`);
  assert.ok(v.every(x => x.cdcAccepted === true && x.rating === null && x.lat > 1.15 && x.lat < 1.48));
  assert.ok(v.every(x => ['halal', 'vegetarian', 'vegan'].every(k => ['likely', 'unknown'].includes(x.diet[k]))), 'only evidence-based levels');
  assert.strictEqual(new Set(v.map(x => x.id)).size, v.length);
  const chinatown = v.find(x => x.postalCode === '050335');
  assert.ok(chinatown && chinatown.cdc.stallCount > 200 && chinatown.siteKind === 'large_site');
});
