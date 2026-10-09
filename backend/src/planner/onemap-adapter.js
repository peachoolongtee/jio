// onemap-adapter.js: turns places from OneMap's themes into engine venues.
//
// OneMap (Singapore Land Authority) publishes government place lists as "themes": SportSG sport centres,
// tourist attractions, museums, libraries, theatres, parks and hawker centres. They say WHERE a place is, and
// sometimes its photo, opening hours and description, but never its price, rating or diet. Anything a theme
// does not say is a DEFAULT for that kind of place or UNKNOWN, and dataQuality says which, the same way the
// frontend's places are converted (venue-adapter.js).
//
// Data: OneMap themes, Singapore Land Authority, used under the Singapore Open Data Licence.
// Fetched by backend/scripts/build-onemap-places.js; this file only converts.

import { approxRegion, titleCase } from './cdc-adapter.js';
import { KIND_DEFAULTS } from './venue-adapter.js';

/**
 * The OneMap themes Jio uses, and what each becomes. Monuments and community clubs are left out on purpose:
 * most monuments are buildings to look at, not places to spend an afternoon, and community clubs are mostly classes.
 *   hours    used when the theme gives none (labelled hoursAssumed)
 *   price    typical SGD per person (labelled priceAssumed)
 */
const THEMES = {
  sportsg_sport_facilities: { category: 'activity', kind: 'sports', hours: [['07:00', '22:00']], price: 5, setting: 'mixed', exposure: 3 },
  tourism: { category: 'activity', kind: 'attraction', hours: [['09:00', '18:00']], price: 15, setting: 'mixed', exposure: 2 },
  museum: { category: 'activity', kind: 'museum', hours: [['10:00', '19:00']], price: 10, setting: 'indoor', exposure: 1 },
  libraries: { category: 'activity', kind: 'library', hours: [['10:00', '21:00']], price: 0, setting: 'indoor', exposure: 1 },
  theatre: { category: 'activity', kind: 'theatre', hours: [['10:00', '23:00']], price: 40, setting: 'indoor', exposure: 1 },
  nationalparks: { category: 'activity', kind: 'park', hours: [['07:00', '22:00']], price: 0, setting: 'outdoor', exposure: 5 },
  ssot_hawkercentres: { category: 'eat', kind: 'hawker', hours: [['07:00', '21:00']], price: 6, setting: 'mixed', exposure: 1 },
};
const THEME_NAMES = Object.keys(THEMES);

// A theatre is like a cinema for the planner (quiet, seated, evening). Added here so venue-adapter's table stays the frontend's.
const DEFAULTS = { ...KIND_DEFAULTS, theatre: KIND_DEFAULTS.cinema };
const ATTRIBUTE_KEYS = ['quiet', 'romantic', 'cozy', 'lively', 'privacy', 'workFriendly', 'celebration'];

/** OneMap's text is sometimes UTF-8 read as Latin-1 ("â€“" for "–"). Puts the characters back. */
function fixText(s) {
  return String(s ?? '')
    .replace(/â€“|â€”/g, '–')
    .replace(/â€™|â€˜/g, '’')
    .replace(/â€œ|â€\u009d|â€/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

// OneMap's short park words, written out: "TRAS LINK PK" -> "Tras Link Park".
const ABBREVIATIONS = [[/\bPK\b/g, 'PARK'], [/\bGDN\b/g, 'GARDEN'], [/\bRD\b/g, 'ROAD'], [/\bAVE\b/g, 'AVENUE'], [/\bST\b/g, 'STREET'], [/\bDR\b/g, 'DRIVE']];

/** A display name: mojibake fixed, ALL-CAPS names title-cased, park abbreviations written out, and project notes
 *  like "(FCP)" or "(Phase 1)" dropped. */
function cleanName(name) {
  let s = fixText(name).replace(/\s*\((FCP|PHASE \d+|PLOT \d+)\)/gi, '');
  if (s === s.toUpperCase()) {
    for (const [re, word] of ABBREVIATIONS) s = s.replace(re, word);
    s = titleCase(s);
  }
  return s;
}

/**
 * Parks: keep real parks, gardens and nature areas; drop playgrounds (PG), fitness corners (FC), open spaces (OS)
 * and neighbourhood pocket parks written "PK", which would flood every activity list.
 */
function isRealPark(name) {
  const n = name.toUpperCase();
  if (/\b(PG|FC|OS|PLAYGROUND|FITNESS|PK|WORKSITE)\b|CAR ?PARK|INTERIM BOUNDARY/.test(n)) return false;
  return /\b(PARK|GARDENS?|RESERVE|NATURE|BEACH|RESERVOIR|WETLANDS?|CREEK|PULAU|HILL|TRAIL|ISLAND)\b/.test(n);
}

/** Hawker centres: only the ones open now. */
const isOpenHawkerCentre = row => /^existing/i.test(row.STATUS ?? '');

/** "9.30am", "12pm", "7 pm", "24:00" -> "09:30", "12:00", "19:00". null when it is not a time. */
function toClock(text) {
  const m = /^(\d{1,2})(?:[.:](\d{2}))?\s*(am|pm|noon)?$/i.exec(text.trim());
  if (!m) return null;
  let h = Number(m[1]);
  const min = Number(m[2] ?? 0);
  const ampm = (m[3] ?? '').toLowerCase();
  if (ampm === 'pm' && h < 12) h += 12;
  if (ampm === 'am' && h === 12) h = 0;
  if (ampm === '' && !m[2]) return null; // a bare number is not a time
  if (h > 24 || min > 59) return null;
  return `${String(h).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
}

/**
 * Reads OneMap's free-text opening hours into the engine's ranges, or null when it cannot.
 * "Daily from 7am – 12pm, and 6pm – 9pm" -> [['07:00','12:00'], ['18:00','21:00']]. "Daily, 24 hours" -> all day.
 * The engine has no days of the week yet, so different days' hours are combined, keeping the SHORTER closing time
 * for the same opening time: it may hide a late opening, but never suggests a place that is closed.
 *
 * How to call:
 *   parseOpeningHoursText('Monday to Saturday, 9am – 5pm') // [['09:00', '17:00']]
 */
function parseOpeningHoursText(text) {
  const s = fixText(text);
  if (!s) return null;
  if (/24\s*hours|24\s*\/\s*7/i.test(s)) return [['00:00', '24:00']];
  const ranges = [];
  const re = /(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm|noon))\s*(?:–|-|to)\s*(\d{1,2}(?:[.:]\d{2})?\s*(?:am|pm|noon))/gi;
  for (const m of s.matchAll(re)) {
    const open = toClock(m[1]), close = toClock(m[2]);
    if (open && close && open !== close) ranges.push([open, close]);
  }
  if (ranges.length === 0) return null;
  const byOpen = new Map();
  for (const [open, close] of ranges) if (!byOpen.has(open) || close < byOpen.get(open)) byOpen.set(open, close);
  return [...byOpen].sort((a, b) => a[0].localeCompare(b[0]));
}

/** "1.30690013235842,103.800367271426" -> { lat, lng }, or the tourism theme's LATITUDE / LONGTITUDE (sic). */
function pointOf(row) {
  const [lat, lng] = String(row.LatLng ?? '').split(',').map(Number);
  if (Number.isFinite(lat) && Number.isFinite(lng)) return { lat, lng };
  const la = Number(row.LATITUDE), ln = Number(row.LONGTITUDE ?? row.LONGITUDE);
  return Number.isFinite(la) && Number.isFinite(ln) ? { lat: la, lng: ln } : null;
}

/** Old government image links are http://. A secure page blocks them, so ask for https://. */
const https = url => (url ? String(url).replace(/^http:\/\//i, 'https://') : null);

const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60);

function addressOf(row) {
  const parts = [row.ADDRESSBLOCKHOUSENUMBER, row.ADDRESSSTREETNAME, row.ADDRESSBUILDINGNAME].filter(x => x && x !== 'NIL').map(fixText);
  const postal = row.ADDRESSPOSTALCODE && row.ADDRESSPOSTALCODE !== 'NIL' ? row.ADDRESSPOSTALCODE : null;
  const text = parts.join(' ') || fixText(row.ADDRESS_MYENV) || null;
  return { address: text ? (postal ? `${text}, Singapore ${postal}` : text) : null, postalCode: postal };
}

/**
 * One OneMap theme row -> one engine venue, or null when the row should be left out (a playground, a hawker centre
 * under construction, a row with no location).
 *
 * How to call:
 *   const venue = fromOneMapRow('sportsg_sport_facilities', row)
 */
function fromOneMapRow(themeName, row) {
  const theme = THEMES[themeName];
  if (!theme) throw new Error(`onemap-adapter: unknown theme "${themeName}"`);
  const point = pointOf(row);
  const name = cleanName(row.NAME);
  if (!point || !name) return null;
  if (themeName === 'nationalparks' && !isRealPark(row.NAME)) return null;
  if (themeName === 'ssot_hawkercentres' && !isOpenHawkerCentre(row)) return null;

  const d = DEFAULTS[theme.kind];
  const parsedHours = parseOpeningHoursText(row.OPENING_HOURS);
  const { address, postalCode } = addressOf(row);
  const food = theme.category === 'eat';
  return {
    id: `onemap_${themeName}_${slug(name)}`, name, area: address ?? name, nearestMrt: null,
    lat: point.lat, lng: point.lng, forecastArea: approxRegion(point),
    category: theme.category, kind: theme.kind, cuisine: theme.kind,
    avgPricePerPerson: theme.price, priceBand: theme.price <= 8 ? 1 : theme.price <= 20 ? 2 : theme.price <= 40 ? 3 : 4,
    rating: null, ratingCount: null,
    diet: food ? { halal: 'unknown', vegetarian: 'unknown', vegan: 'unknown', healthy: d.healthy ?? 2 } : null,
    setting: theme.setting, exposure: theme.exposure, aircon: theme.setting === 'indoor',
    stepFree: null, sockets: null, wifi: null, cdcAccepted: false,
    maxGroupSize: d.maxGroupSize, hasPrivateRoom: false, cakeFriendly: false, longStayOk: d.longStayOk,
    noise: d.noise, queueMinutesPeak: null,
    openingHours: parsedHours ?? theme.hours,
    mealPeriods: food ? ['breakfast', 'lunch', 'tea', 'dinner'] : [],
    attributes: Object.fromEntries(ATTRIBUTE_KEYS.map((k, i) => [k, d.attributes[i]])),
    address, postalCode,
    description: fixText(row.DESCRIPTION) && !/^https?:\/\//.test(row.DESCRIPTION) ? fixText(row.DESCRIPTION) : null,
    website: https(row.HYPERLINK ?? (/^https?:\/\//.test(row.DESCRIPTION ?? '') ? row.DESCRIPTION : null)),
    photoUrl: https(row.PHOTOURL),
    photoCredit: row.PHOTOURL ? fixText(row.PHOTOCREDITS) || 'OneMap / Singapore government' : null,
    openingHoursText: fixText(row.OPENING_HOURS) || null,
    foodStalls: Number(row.NUMBER_OF_COOKED_FOOD_STALLS) || null,
    source: 'onemap', oneMapTheme: themeName,
    dataQuality: {
      hoursAssumed: !parsedHours, priceAssumed: true, ratingUnknown: true, attributesAreDefaults: true,
      dietUnknown: food, accessUnknown: true, forecastAreaApprox: true,
    },
  };
}

/**
 * A whole theme -> venues: converts every row, drops the ones left out, and makes ids unique
 * (OneMap lists "Tras Link PK" twice).
 *
 * How to call:
 *   const venues = fromOneMapTheme('nationalparks', rows)
 */
function fromOneMapTheme(themeName, rows) {
  const seen = new Map();
  const out = [];
  for (const row of rows) {
    const v = fromOneMapRow(themeName, row);
    if (!v) continue;
    const n = seen.get(v.id) ?? 0;
    seen.set(v.id, n + 1);
    if (n > 0) {
      // A second row with the same name: keep it only if it is somewhere else (300 m apart), as its own venue.
      const first = out.find(x => x.id === v.id);
      if (Math.hypot(first.lat - v.lat, first.lng - v.lng) * 111 < 0.3) continue;
      v.id = `${v.id}-${n + 1}`;
    }
    out.push(v);
  }
  return out;
}

export { THEMES, THEME_NAMES, fromOneMapRow, fromOneMapTheme, parseOpeningHoursText, cleanName, isRealPark, fixText };
