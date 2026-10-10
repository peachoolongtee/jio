// cdc-adapter.js: turns the CDC merchant snapshot (CDC.json) into venues the engine can rank.
//
// What the CDC file HAS:  name, address, postal code, lat/lng, budget-meal flag. All records are
//                         hawker / heartland merchants (no supermarkets, no restaurants in malls).
// What it does NOT have:  cuisine, halal/vegetarian, price, rating, opening hours, ambience, accessibility.
//
// So this adapter (1) cleans, (2) groups stalls into SITES (one postal code = one hawker centre or block, because
// 254 stalls on one pin must not become 254 venues), (3) guesses food vs not from names, (4) fills the missing
// fields with clearly labelled ASSUMPTIONS ('unknown' / null / dataQuality flags) instead of pretending to know.

import { haversineKm } from './geo.js';
import { computeOccasionFit } from './scoring.js';

// ---------------------------------------------------------------- name heuristics
const rx = words => new RegExp(`\\b(?:${words.join('|')})\\b`, 'i');
const NON_FOOD = rx(['HAIR', 'SALON', 'BEAUTY', 'BARBER', 'DENTAL', 'CLINIC', 'MEDICAL', 'REFLEXOLOGY', 'MASSAGE', 'SPA', 'MOBILE',
  'FLOWER', 'FLORIST', 'PHARMACY', 'OPTICAL', 'TAILOR', 'LAUNDRY', 'DRY CLEAN', 'HARDWARE', 'ELECTRICAL', 'STATIONERY', 'TOYS',
  'GIFT', 'TRAVEL', 'TUITION', 'ENRICHMENT', 'PRINTING', 'KEY', 'LOCKSMITH', 'WELLNESS', 'PHYSIO', 'TCM', 'LIFESTYLE', 'GARMENT',
  'FASHION', 'SHOE', 'BAG', 'WATCH', 'JEWELLERY', 'PET', 'AUTO', 'MOTOR', 'ELECTRONICS', 'COMPUTER', 'PHONE', 'AGENCY', 'PROPERTY']);
const GROCERY = rx(['VEGETABLE', 'VEGETABLES', 'FRUIT', 'FRUITS', 'MEAT', 'POULTRY', 'PROVISION', 'MINIMART', 'MINI MART', 'SUPERMARKET',
  'GROCERY', 'WET MARKET', 'FISH PRODUCT', 'FISH PRODUCTS', 'PROCESSED SEAFOOD', 'SEAFOOD STALL', 'EGG', 'EGGS', 'FLOUR', 'SPICES',
  'DRY GOODS', 'FRESH', 'BUTCHER', 'SUNDRIES', 'FROZEN']);
const EAT = rx(['NASI', 'MEE', 'MIAN', 'MI', 'NOODLE', 'NOODLES', 'RICE', 'CHICKEN', 'DUCK', 'PORK', 'BAK KUT TEH', 'BKT', 'KOPI', 'KOPITIAM',
  'COFFEE', 'CAFE', 'TEA', 'BAKERY', 'BREAD', 'CAKE', 'DESSERT', 'DESSERTS', 'FOOD', 'KITCHEN', 'RESTAURANT', 'DELI', 'SATAY', 'ROTI',
  'PRATA', 'PIZZA', 'BURGER', 'SUSHI', 'RAMEN', 'DIM SUM', 'SOUP', 'CURRY', 'LAKSA', 'BEE HOON', 'HOR FUN', 'KWAY TEOW', 'KWAY CHAP',
  'CHAR KWAY', 'PORRIDGE', 'CONGEE', 'JUICE', 'DRINK', 'DRINKS', 'BEVERAGE', 'SNACK', 'SNACKS', 'EATING HOUSE', 'CANTEEN', 'BBQ', 'GRILL',
  'STEAK', 'WESTERN', 'VEGETARIAN', 'ECONOMIC', 'ECONOMY', 'WANTON', 'DUMPLING', 'DUMPLINGS', 'POPIAH', 'ROJAK', 'CHENDOL', 'KACHANG',
  'TAU HUAY', 'SOYA', 'YONG TAU FOO', 'ZI CHAR', 'TZE CHAR', 'KUEH', 'KUEY', 'MURTABAK', 'BRYANI', 'BIRYANI', 'PADANG', 'MALAY', 'THAI',
  'KOREAN', 'JAPANESE', 'FRIED', 'ROAST', 'ROASTED', 'SEAFOOD', 'FISHBALL', 'PANCAKE', 'WAFFLE', 'BUBBLE', 'ICE', 'PASTA', 'SANDWICH',
  'BIHUN', 'MUSLIM', 'HALAL', 'WARUNG', 'SOTO', 'HOKKIEN', 'TEOCHEW', 'CAI FAN', 'TOAST', 'BAGEL', 'DONUT', 'DOUGHNUT', 'TAPAS', 'BISTRO',
  'EATERY', 'EATING', 'CATERING', 'SIGNATURE', 'DELIGHT', 'DELIGHTS', 'GRILLED', 'STEAMBOAT', 'HOTPOT', 'CHAR SIEW', 'SIEW', 'WONTON']);

const HALAL_HINT = /\b(HALAL|MUSLIM|PADANG|MURTABAK|BRYANI|BIRYANI|WARUNG|SOTO|MALAY|MAMAK|NASI LEMAK|SATAY)\b|^AL[-\s]/i;
const VEG_HINT = /\b(VEGETARIAN|VEGAN|VEGGIE|ZHAI|SU SHI)\b/i;
const VEGAN_HINT = /\bVEGAN\b/i;

const CUISINES = [
  ['malay', /\b(NASI|PADANG|SATAY|SOTO|WARUNG|MALAY|MEE REBUS|MEE SIAM|LONTONG|MAMAK)\b/i],
  ['indian', /\b(PRATA|MURTABAK|BRYANI|BIRYANI|THOSAI|DOSA|INDIAN|TANDOORI|ROTI)\b/i],
  ['western', /\b(WESTERN|STEAK|CHOP|PIZZA|BURGER|PASTA|SANDWICH|WAFFLE|PANCAKE|BISTRO|TAPAS)\b/i],
  ['japanese', /\b(SUSHI|RAMEN|JAPANESE|TEMPURA|DON|UDON)\b/i],
  ['korean', /\b(KOREAN|KIMCHI|BIBIMBAP)\b/i],
  ['thai', /\b(THAI|TOM YUM)\b/i],
  ['vegetarian', /\b(VEGETARIAN|VEGAN|ZHAI)\b/i],
  ['cafe', /\b(CAFE|COFFEE|KOPI|TEA|BAKERY|BREAD|CAKE|TOAST|DESSERT|DESSERTS|JUICE|DRINK|DRINKS|BEVERAGE|BUBBLE|DONUT|BAGEL)\b/i],
  ['chinese', /\b(MEE|MIAN|NOODLE|NOODLES|RICE|CHICKEN|DUCK|PORK|BAK KUT TEH|BKT|DIM SUM|WANTON|WONTON|PORRIDGE|CONGEE|DUMPLING|HOKKIEN|TEOCHEW|ZI CHAR|TZE CHAR|KWAY TEOW|HOR FUN|BEE HOON|CAI FAN|ROAST|ROASTED|STEAMBOAT|HOTPOT|POPIAH|YONG TAU FOO)\b/i],
];

/** 'eat' = ready-to-eat food or drinks, 'grocery' = raw/market goods, 'other' = services and shops, 'unknown' = cannot tell. */
function classifyStall(name) {
  const n = name.toUpperCase();
  if (NON_FOOD.test(n) && !EAT.test(n)) return 'other';
  if (EAT.test(n)) return GROCERY.test(n) && /\bSTALL\b/.test(n) && !/\b(NOODLE|RICE|SOUP|MEE|FOOD)\b/.test(n) ? 'grocery' : 'eat';
  if (GROCERY.test(n)) return 'grocery';
  if (NON_FOOD.test(n)) return 'other';
  return 'unknown';
}

function cuisineHint(name) {
  for (const [c, r] of CUISINES) if (r.test(name)) return c;
  return null;
}

/**
 * Diet evidence from a stall NAME. Levels: 'likely' (name suggests it) or 'unknown'. Never 'none' (a name that does not
 * say "halal" proves nothing) and never 'options'/'full' (those mean verified, e.g. from the MUIS list). The engine lets
 * 'likely' through but tells the UI to ask the user to verify.
 */
function dietHints(name) {
  return {
    halal: HALAL_HINT.test(name) ? 'likely' : 'unknown',
    vegetarian: VEG_HINT.test(name) ? 'likely' : 'unknown',
    vegan: VEGAN_HINT.test(name) ? 'likely' : 'unknown',
  };
}

// ---------------------------------------------------------------- cleaning
const SMALL = new Set(['and', 'of', 'the', 'at', 'in', 'on', 'to', 'for', 'a']);
const KEEP_UPPER = new Set(['BBQ', 'BKT', 'HDB', 'NTU', 'NUS', 'SMU', 'CBD', 'KFC', 'II', 'III', 'IV', 'TCM', 'BCHC', 'KL', 'HK', 'CK', 'XO']);
function titleCase(s) {
  return s.toLowerCase().replace(/[a-z0-9'’]+/g, (w, i) => {
    const up = w.toUpperCase();
    if (KEEP_UPPER.has(up)) return up;
    if (i > 0 && SMALL.has(w)) return w;
    return w.charAt(0).toUpperCase() + w.slice(1);
  });
}

/** "(248 SIMEI) WEYOUNG DELICACY PTE LTD" -> "Weyoung Delicacy". Best effort, display only. */
function displayName(raw) {
  let n = raw.replace(/\s+/g, ' ').trim();
  n = n.replace(/\b(PTE\.?\s*LTD\.?|PTD\s*LTD|LLP|SDN BHD)\b\.?/gi, '').replace(/^\([^)]*\)\s*/, '').replace(/\s*\([^)]*\)\s*$/, '').trim();
  return titleCase(n || raw);
}

/** "861 North Bridge Road, #01-83,  S198783;" -> "861 North Bridge Road". */
function streetLabel(address) {
  let a = address.replace(/;+\s*$/, '').replace(/\s+/g, ' ');
  a = a.replace(/,?\s*#[^,]*/g, '').replace(/,?\s*S\d{6}\b/g, '').replace(/\bSingapore\s*\d{6}\b/i, '').replace(/,\s*$/, '').trim();
  const first = a.split(',')[0].trim();
  return titleCase(first || a);
}

// Singapore's bounds, with room for its far islands (Pulau Unum, a OneMap park, is at lng 104.054).
/**
 * Is the point on the main island or one of its islands? Used by the CDC build and the OneMap adapter.
 *
 * How to call:
 *   withinSingapore({ lat: 1.3, lng: 103.85 }) // true
 *   withinSingapore({ lat: 0, lng: 0 })        // false
 */
const withinSingapore = ({ lat, lng }) => Number.isFinite(lat) && Number.isFinite(lng) && lat > 1.15 && lat < 1.48 && lng > 103.6 && lng < 104.1;
const validCoord = r => withinSingapore({ lat: r.LAT, lng: r.LON });

/**
 * Clean the raw snapshot. Returns kept records plus a report of what was dropped and why.
 * Drops: invalid coordinates (0,0 and null exist in the file) and exact duplicates (same name + postal code).
 */
function cleanRecords(raw) {
  const report = { total: raw.locations.length, invalidCoords: [], duplicates: 0 };
  const seen = new Set(), kept = [];
  for (const r of raw.locations) {
    if (!validCoord(r)) { report.invalidCoords.push({ name: r.name, postalCode: r.postalCode }); continue; }
    const key = `${r.name.trim().toUpperCase()}|${r.postalCode}`;
    if (seen.has(key)) { report.duplicates++; continue; }
    seen.add(key);
    kept.push(r);
  }
  report.kept = kept.length;
  return { records: kept, report };
}

// ---------------------------------------------------------------- forecast areas
/**
 * Nearest forecast area by distance. Feed it the REAL NEA area centroids from the 2-hour nowcast response
 * (areas: [{ name, lat, lng }]) so each venue is mapped once at seed time.
 */
function nearestArea(point, areas) {
  let best = null, bd = Infinity;
  for (const a of areas) { const d = haversineKm(point, a); if (d < bd) { bd = d; best = a.name; } }
  return best;
}

/** Rough region labels matching the mock weather cases. APPROXIMATE: replace with nearestArea() on real NEA data. */
function approxRegion({ lat, lng }) {
  if (lat > 1.39 && lng < 103.87) return 'north';
  if (lat > 1.37 && lng >= 103.87) return 'northeast';
  if (lng < 103.80) return 'west';
  if (lng >= 103.88 && lat < 1.37) return 'east';
  return 'central';
}

// ---------------------------------------------------------------- sites
const median = xs => { const s = [...xs].sort((a, b) => a - b), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

const DEFAULT_ATTRIBUTES = { quiet: 20, romantic: 5, cozy: 25, lively: 75, privacy: 10, workFriendly: 5, celebration: 25 }; // typical hawker centre, NOT measured

// 'large_site' is NOT guaranteed to be a hawker centre: a shopping centre with 140 CDC merchants looks the same here.
function siteKind(stallCount, eatCount) {
  if (stallCount >= 30 && eatCount >= 5) return 'large_site';
  if (eatCount >= 3) return 'food_cluster';
  return 'food_stall';
}

/**
 * Group stalls by postal code into sites and build engine-shaped venues for the sites that have food.
 * @param {{records: object[]}} cleaned
 * @param {{profiles?: object, areas?: {name:string,lat:number,lng:number}[], snapshot?: string}} opts
 */
function buildCdcVenues(cleaned, { profiles = {}, areas = null, snapshot = 'unknown' } = {}) {
  const byPostal = new Map();
  for (const r of cleaned.records) {
    if (!byPostal.has(r.postalCode)) byPostal.set(r.postalCode, []);
    byPostal.get(r.postalCode).push(r);
  }
  const venues = [];
  for (const [postal, rows] of byPostal) {
    const stalls = rows.map(r => ({ name: displayName(r.name), budgetMeal: !!r.filters?.secondary?.budgetmeal, cls: classifyStall(r.name), raw: r.name }));
    const eat = stalls.filter(s => s.cls === 'eat');
    if (eat.length === 0) continue;
    const point = { lat: median(rows.map(r => r.LAT)), lng: median(rows.map(r => r.LON)) };
    const kind = siteKind(rows.length, eat.length);
    const hints = eat.map(s => ({ ...dietHints(s.raw), cuisine: cuisineHint(s.raw) }));
    const anyHint = k => hints.some(h => h[k] === 'likely');
    const cuisines = hints.map(h => h.cuisine).filter(Boolean);
    const cuisine = kind === 'food_stall' ? (cuisines[0] ?? 'hawker') : 'hawker';
    const street = streetLabel(rows[0].address);
    const name = kind === 'food_stall' ? eat[0].name : `Food stalls at ${street}`;
    const budgetStalls = eat.filter(s => s.budgetMeal).length;
    const v = {
      id: `cdc_${postal}`, name, area: street, nearestMrt: null, lat: point.lat, lng: point.lng,
      forecastArea: areas ? nearestArea(point, areas) : approxRegion(point),
      category: 'eat', cuisine,
      avgPricePerPerson: budgetStalls > 0 ? 5 : 6, rating: null, ratingCount: null,
      diet: {
        halal: anyHint('halal') ? 'likely' : 'unknown',
        vegetarian: anyHint('vegetarian') ? 'likely' : 'unknown',
        vegan: anyHint('vegan') ? 'likely' : 'unknown',
        healthy: 2,
      },
      setting: 'mixed', exposure: kind === 'large_site' ? 1 : 2, aircon: false, stepFree: null, cdcAccepted: true,
      maxGroupSize: kind === 'large_site' ? 20 : kind === 'food_cluster' ? 12 : 6,
      hasPrivateRoom: false, cakeFriendly: false, wifi: false, sockets: null, longStayOk: false, noise: 4, queueMinutesPeak: null,
      openingHours: [['07:00', '21:00']], mealPeriods: ['breakfast', 'lunch', 'tea', 'dinner'],
      attributes: { ...DEFAULT_ATTRIBUTES },
      source: 'cdc', siteKind: kind, postalCode: postal,
      cdc: { stallCount: rows.length, eatStallCount: eat.length, budgetMealStalls: budgetStalls },
      stalls: eat.map(s => ({ name: s.name, budgetMeal: s.budgetMeal })),
      dataQuality: { hoursAssumed: true, priceAssumed: true, ratingUnknown: true, dietFromNames: true, stepFreeUnknown: true,
                     attributesAreDefaults: true, forecastAreaApprox: !areas, snapshot },
    };
    v.priceBand = 1;
    v.occasionFit = Object.fromEntries(Object.entries(profiles).map(([k, p]) => [k, computeOccasionFit(v, p)]));
    venues.push(v);
  }
  return venues;
}

// ---------------------------------------------------------------- joining other venues to CDC
const STOP = new Set(['PTE', 'LTD', 'STALL', 'FOOD', 'THE', 'AND', 'CAFE', 'RESTAURANT', 'KITCHEN', 'SINGAPORE', 'SG', 'CO', 'HAWKER', 'CENTRE', 'CENTER']);
const tokens = s => new Set(s.toUpperCase().replace(/[^A-Z0-9 ]/g, ' ').split(/\s+/).filter(t => t.length > 1 && !STOP.has(t)));
function jaccard(a, b) {
  if (a.size === 0 || b.size === 0) return 0;
  let inter = 0; for (const t of a) if (b.has(t)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Does a venue from ANOTHER source (OneMap, seeded list) accept CDC vouchers? This is how the original plan
 * ("a CDC flag on seeded venues") becomes real.
 *   - same postal code or within maxMeters AND a stall name that matches  -> 'stall'
 *   - the venue is a hawker centre within siteMeters of a CDC food site, or has its postal code -> 'site' (centre
 *     participates, stalls vary). Several sites in reach: same postal code first, then a large site, then the nearest.
 *     (venue.type === 'hawker_centre' comes from the other source, e.g. OneMap's hawker centre layer)
 *   - otherwise                                                           -> false
 * Never guesses from distance alone: a cafe next to a hawker centre does not accept CDC vouchers.
 *
 * How to call:
 *   matchVenueToCdc({ ...centre, type: 'hawker_centre' }, cdcVenues) // { cdcAccepted: 'site', siteId: 'cdc_198783', meters: 0 }
 */
function matchVenueToCdc(venue, cdcVenues, { maxMeters = 80, siteMeters = 150, minSimilarity = 0.5 } = {}) {
  const vt = tokens(venue.name);
  let best = null;
  const siteCandidates = [];
  for (const site of cdcVenues) {
    const d = haversineKm(venue, site) * 1000;
    const samePostal = !!venue.postalCode && venue.postalCode === site.postalCode;
    // A hawker centre and its CDC site share a postal code, so that counts at any distance. Without a postal code, 150 m.
    const siteInReach = venue.type === 'hawker_centre' && site.siteKind !== 'food_stall' && (d <= siteMeters || samePostal);
    if (!samePostal && d > Math.max(maxMeters, siteMeters)) continue;
    if (samePostal || d <= maxMeters) {
      for (const st of site.stalls) {
        const sim = jaccard(vt, tokens(st.name));
        if (sim >= minSimilarity && (!best || sim > best.similarity)) best = { match: 'stall', siteId: site.id, stall: st.name, similarity: sim, meters: Math.round(d) };
      }
    }
    if (siteInReach) siteCandidates.push({ site, d, samePostal });
  }
  // A matching stall name wins. Otherwise the site is the best of those in reach: the one with the same postal code,
  // then a large site (the centre itself, not a coffee shop beside it), then the nearest. The first in file order is not a
  // reason: Redhill Blk 85 used to take Blk 79's site because it came first.
  if (!best && siteCandidates.length > 0) {
    siteCandidates.sort((a, b) => Number(b.samePostal) - Number(a.samePostal)
      || Number(b.site.siteKind === 'large_site') - Number(a.site.siteKind === 'large_site') || a.d - b.d);
    const { site, d } = siteCandidates[0];
    best = { match: 'site', siteId: site.id, similarity: null, meters: Math.round(d) };
  }
  return best ? { cdcAccepted: best.match, ...best } : { cdcAccepted: false };
}

/** How alike two place names are, 0 (nothing shared) to 1 (same words), ignoring words like "the" and "centre". */
const nameSimilarity = (a, b) => jaccard(tokens(a), tokens(b));

export {
  classifyStall, cuisineHint, dietHints, displayName, streetLabel, cleanRecords, buildCdcVenues, matchVenueToCdc,
  nearestArea, approxRegion, titleCase, nameSimilarity, withinSingapore,
};
