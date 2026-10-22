// venue-adapter.js: turns the frontend's curated venues (frontend/src/lib/mock/venues.js) into engine venues.
//
// The frontend team listed 63 real Singapore places with a lighter format:
//   { id, name, category, kind, area, lat, lng, hours: ['07:30-20:00'], serves, price, indoor,
//     mrt, mrtWalk, popularity (0-1), tags: ['cdc', 'hidden', 'touristy'] }
// The engine needs more fields (diet, attributes, exposure, group size...). Anything the frontend list
// does not say is either UNKNOWN (null / 'unknown', so strict mode treats it honestly) or a DEFAULT for
// that kind of place, and dataQuality says which. Defaults are guesses, not measurements.

import { approxRegion } from './cdc-adapter.js';

/**
 * Typical values per kind of place. These drive occasion fit (via attributes), so they are the
 * "category defaults" step of filling in occasion fit for real venues. Edit freely; they are not measured.
 *   attributes 0-100: quiet, romantic, cozy, lively, privacy, workFriendly, celebration
 *   noise 1 (quiet) to 5 (loud), maxGroupSize, longStayOk, healthy 0-5 (food and drink only)
 */
const KIND_DEFAULTS = {
  hawker:     { attributes: [20, 5, 25, 75, 10, 5, 25],   noise: 4, maxGroupSize: 20, longStayOk: false, healthy: 2 },
  restaurant: { attributes: [55, 55, 60, 50, 55, 15, 65], noise: 3, maxGroupSize: 12, longStayOk: true, healthy: 3 },
  cafe:       { attributes: [65, 45, 75, 35, 45, 70, 35], noise: 2, maxGroupSize: 8, longStayOk: true, healthy: 3 },
  dessert:    { attributes: [50, 50, 65, 50, 35, 25, 55], noise: 3, maxGroupSize: 8, longStayOk: false, healthy: 1 },
  bar:        { attributes: [25, 55, 45, 85, 35, 5, 75],  noise: 4, maxGroupSize: 15, longStayOk: true, healthy: 1 },
  mall:       { attributes: [25, 15, 25, 70, 15, 15, 35], noise: 4, maxGroupSize: 50, longStayOk: true },
  market:     { attributes: [20, 20, 25, 80, 10, 5, 35],  noise: 4, maxGroupSize: 30, longStayOk: false },
  park:       { attributes: [70, 60, 40, 35, 40, 15, 25], noise: 1, maxGroupSize: 50, longStayOk: true },
  museum:     { attributes: [75, 45, 40, 25, 35, 20, 20], noise: 1, maxGroupSize: 30, longStayOk: true },
  cinema:     { attributes: [60, 65, 50, 40, 40, 0, 45],  noise: 2, maxGroupSize: 20, longStayOk: false },
  library:    { attributes: [95, 10, 45, 5, 40, 95, 0],   noise: 1, maxGroupSize: 20, longStayOk: true },
  sports:     { attributes: [20, 10, 10, 80, 10, 0, 40],  noise: 4, maxGroupSize: 20, longStayOk: true },
  attraction: { attributes: [35, 40, 30, 65, 20, 5, 45],  noise: 3, maxGroupSize: 50, longStayOk: true },
};
const ATTRIBUTE_KEYS = ['quiet', 'romantic', 'cozy', 'lively', 'privacy', 'workFriendly', 'celebration'];

const clamp = (x, lo, hi) => Math.min(hi, Math.max(lo, x));

/** Kind defaults, nudged by the frontend's tags: a hidden gem is calmer, a tourist spot is livelier. */
function attributesFor(kind, tags) {
  const base = KIND_DEFAULTS[kind]?.attributes ?? KIND_DEFAULTS.attraction.attributes;
  const a = Object.fromEntries(ATTRIBUTE_KEYS.map((k, i) => [k, base[i]]));
  if (tags.includes('hidden')) { a.cozy += 10; a.quiet += 10; a.lively -= 10; }
  if (tags.includes('touristy')) { a.lively += 10; a.quiet -= 10; }
  for (const k of ATTRIBUTE_KEYS) a[k] = clamp(a[k], 0, 100);
  return a;
}

/** 0 = linked to the MRT, 5 = open air with a long walk. Indoor places only get wet on the walk from the MRT. */
function exposureFor(indoor, kind, mrtWalk) {
  if (!indoor) return kind === 'park' || kind === 'sports' ? 5 : 4;
  if (mrtWalk <= 2) return 0;
  return mrtWalk <= 8 ? 1 : 2;
}

const priceBandFor = price => (price <= 8 ? 1 : price <= 20 ? 2 : price <= 40 ? 3 : 4);

/** "07:30-20:00" -> ["07:30", "20:00"]. A close before the open ("17:00-02:00") runs past midnight; isOpenAt handles it. */
function parseHours(hours) {
  return (hours ?? []).map(text => {
    const [open, close] = text.split('-');
    if (!/^\d\d:\d\d$/.test(open ?? '') || !/^\d\d:\d\d$/.test(close ?? '')) throw new Error(`venue-adapter: bad hours "${text}"`);
    return [open, close];
  });
}

// A place of this kind is a centre of many stalls: MUIS certifies a stall, never the centre.
const CENTRE_KINDS = ['hawker', 'market'];

/**
 * One frontend venue -> one engine venue. Keeps the frontend's id so the UI can match results to its own list.
 * A place with certification from MUIS (`halal: { muisStalls, checked }`, ticket #107) carries it in dataQuality (the count,
 * the date and `halalScope`) so a screen can say where it came from. A single certified shop or restaurant is halal 'options'
 * (verified). A centre with certified stalls is only halal 'likely': one stall's certificate does not make the centre halal,
 * so a halal group is told to check the stall (`verify`).
 * How to call: fromFrontendVenue(VENUES[0])
 */
function fromFrontendVenue(v) {
  const tags = v.tags ?? [];
  const food = v.category === 'eat' || v.category === 'drink';
  const muis = food && Number.isInteger(v.halal?.muisStalls) && v.halal.muisStalls > 0 ? v.halal : null;
  const d = KIND_DEFAULTS[v.kind] ?? KIND_DEFAULTS.attraction;
  const stallsOnly = muis !== null && CENTRE_KINDS.includes(v.kind);
  const halalLevel = muis === null ? 'unknown' : stallsOnly ? 'likely' : 'options';
  return {
    id: v.id, name: v.name, area: v.area, nearestMrt: v.mrt ?? null, mrtWalkMinutes: v.mrtWalk ?? null,
    lat: v.lat, lng: v.lng, forecastArea: approxRegion(v),
    category: v.category, kind: v.kind,
    cuisine: v.kind, // the frontend list has no cuisine, so preference matching can only use the kind (cafe, hawker...)
    avgPricePerPerson: v.price, priceBand: priceBandFor(v.price),
    rating: typeof v.rating === 'number' ? Math.round((v.rating / 2) * 10) / 10 : null, // frontend 0-10 -> engine 0-5
    ratingCount: null,
    diet: food ? { halal: halalLevel, vegetarian: 'unknown', vegan: 'unknown', healthy: d.healthy ?? 2 } : null,
    setting: v.indoor ? 'indoor' : 'outdoor', exposure: exposureFor(v.indoor, v.kind, v.mrtWalk ?? 10),
    aircon: v.indoor && !['hawker', 'market'].includes(v.kind),
    stepFree: null, sockets: null, wifi: null,
    cdcAccepted: tags.includes('cdc'),
    maxGroupSize: d.maxGroupSize, hasPrivateRoom: false, cakeFriendly: false, longStayOk: d.longStayOk,
    noise: d.noise, queueMinutesPeak: null,
    openingHours: parseHours(v.hours),
    mealPeriods: food ? [...(v.serves ?? [])] : [],
    attributes: attributesFor(v.kind, tags),
    popularity: v.popularity ?? null, tags: [...tags],
    source: 'curated',
    dataQuality: {
      attributesAreDefaults: true, dietUnknown: food && !muis, accessUnknown: true, ratingRescaledFrom10: true, forecastAreaApprox: true,
      ...(muis ? { halalSource: 'muis', halalScope: stallsOnly ? 'stalls' : 'venue', muisStalls: muis.muisStalls, halalCheckedAt: muis.checked } : {}),
    },
  };
}

export { fromFrontendVenue, KIND_DEFAULTS, parseHours };
