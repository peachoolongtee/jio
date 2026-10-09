// google-adapter.js: turns places from Google Places API (New) into engine venues.
//
// Google fills the gap OneMap and CDC leave: restaurants, cafés, bars and dessert shops, with real ratings, a price
// level and opening hours per day of the week. It says nothing about diet or access, so those stay UNKNOWN, and
// the "how quiet / romantic / lively" attributes are defaults for the kind of place, labelled in dataQuality.
//
// Google's terms allow storing only a place's id, so these venues are never saved to a file: services/google-places.js
// fetches them per request (briefly cached) and they are added to the planner data for that request only.
// Data: Google Places API (New), https://developers.google.com/maps/documentation/places/web-service/overview

import { approxRegion } from './cdc-adapter.js';
import { KIND_DEFAULTS } from './venue-adapter.js';

const ATTRIBUTE_KEYS = ['quiet', 'romantic', 'cozy', 'lively', 'privacy', 'workFriendly', 'celebration'];

// Google's price levels as typical SGD per person. Ours, not Google's: Google gives a level, not an amount.
const PRICE_BY_LEVEL = {
  PRICE_LEVEL_FREE: 0,
  PRICE_LEVEL_INEXPENSIVE: 10,
  PRICE_LEVEL_MODERATE: 25,
  PRICE_LEVEL_EXPENSIVE: 50,
  PRICE_LEVEL_VERY_EXPENSIVE: 90,
};

// Cuisine words the members' likes use (mock-data.json), read from Google's place type: "italian_restaurant" -> italian.
const CUISINES = ['japanese', 'korean', 'chinese', 'indian', 'malay', 'thai', 'italian', 'western', 'vietnamese', 'indonesian', 'french', 'mexican'];

/**
 * Which kind of place, and which Jio category, a Google place is.
 * Cafés, coffee and bars are 'drink' and dessert is 'eat', the same as the frontend's own list.
 *
 * How to call:
 *   kindOf({ primaryType: 'italian_restaurant', types: [...] }) // { category: 'eat', kind: 'restaurant', cuisine: 'italian' }
 */
function kindOf(place) {
  const types = [place.primaryType, ...(place.types ?? [])].filter(Boolean);
  const has = (...t) => types.some(x => t.includes(x));
  const cuisine = CUISINES.find(c => types.some(t => t.startsWith(`${c}_`))) ??
    (types.some(t => /chinese_noodle|dim_sum|hot_pot/.test(t)) ? 'chinese' : null);
  if (has('food_court')) return { category: 'eat', kind: 'hawker', cuisine: 'hawker' };
  if (has('bar', 'pub', 'wine_bar', 'cocktail_bar', 'night_club')) return { category: 'drink', kind: 'bar', cuisine: 'bar' };
  if (has('dessert_shop', 'ice_cream_shop', 'dessert_restaurant', 'bakery', 'confectionery')) return { category: 'eat', kind: 'dessert', cuisine: 'dessert' };
  if (has('cafe', 'coffee_shop', 'tea_house', 'cat_cafe')) return { category: 'drink', kind: 'cafe', cuisine: 'cafe' };
  return { category: 'eat', kind: 'restaurant', cuisine: cuisine ?? 'restaurant' };
}

const hhmm = t => `${String(t.hour ?? 0).padStart(2, '0')}:${String(t.minute ?? 0).padStart(2, '0')}`;

/**
 * The opening hours for ONE day of the week, from Google's weekly periods (day 0 is Sunday).
 * A period that runs past midnight closes "the next day", which the engine reads as running past midnight.
 * Last night's late opening that is still going after midnight is added as an early-morning range.
 * A place with one period and no closing time is open all day, every day (Google's way of saying 24 hours).
 * Returns null when Google gave no hours.
 *
 * How to call:
 *   hoursOnDay(place.regularOpeningHours, 6)   // Saturday: [['11:00', '22:00']]
 */
function hoursOnDay(opening, weekday) {
  const periods = opening?.periods;
  if (!Array.isArray(periods) || periods.length === 0) return null;
  if (periods.length === 1 && !periods[0].close) return [['00:00', '24:00']];
  const ranges = [];
  for (const p of periods) {
    if (!p.open || !p.close) continue;
    if (p.open.day === weekday) ranges.push([hhmm(p.open), p.close.day === weekday ? hhmm(p.close) : hhmm(p.close) === '00:00' ? '24:00' : hhmm(p.close)]);
    else if (p.close.day === weekday && (p.open.day + 1) % 7 === weekday && hhmm(p.close) !== '00:00') ranges.push(['00:00', hhmm(p.close)]);
  }
  return ranges;
}

/** Day of the week (0 Sunday) for a planner date-time "YYYY-MM-DDTHH:MM". Read from the date only, so no time zone can shift it. */
function weekdayOf(dateTime) {
  const [y, m, d] = dateTime.slice(0, 10).split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

/**
 * One Google place -> one engine venue, for a visit on a given date-time (the hours are that day's).
 * Returns null for a place that has closed down or has no location.
 *
 * How to call:
 *   const venue = fromGooglePlace(place, '2026-10-10T19:00')
 */
function fromGooglePlace(place, dateTime) {
  const lat = place.location?.latitude, lng = place.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return null;
  const { category, kind, cuisine } = kindOf(place);
  const d = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.restaurant;
  const price = PRICE_BY_LEVEL[place.priceLevel];
  const dayHours = hoursOnDay(place.regularOpeningHours, weekdayOf(dateTime));
  const photo = place.photos?.[0];
  return {
    id: `google_${place.id}`, googlePlaceId: place.id,
    name: place.displayName?.text ?? 'Unnamed place', area: place.formattedAddress ?? '', address: place.formattedAddress ?? null,
    nearestMrt: null, lat, lng, forecastArea: approxRegion({ lat, lng }),
    category, kind, cuisine,
    avgPricePerPerson: price ?? 20, priceBand: price === undefined ? 2 : price <= 8 ? 1 : price <= 20 ? 2 : price <= 40 ? 3 : 4,
    rating: typeof place.rating === 'number' ? place.rating : null, ratingCount: place.userRatingCount ?? null,
    diet: { halal: 'unknown', vegetarian: 'unknown', vegan: 'unknown', healthy: d.healthy ?? 2 },
    setting: 'indoor', exposure: 1, aircon: kind !== 'hawker',
    stepFree: null, sockets: null, wifi: null, cdcAccepted: false,
    maxGroupSize: d.maxGroupSize, hasPrivateRoom: false, cakeFriendly: false, longStayOk: d.longStayOk,
    noise: d.noise, queueMinutesPeak: null,
    // An empty list means closed that day. No hours at all from Google: typical hours, labelled.
    openingHours: dayHours ?? [['11:00', '21:00']],
    mealPeriods: [], // Google's hours already say when it is open; no separate meal rule
    attributes: Object.fromEntries(ATTRIBUTE_KEYS.map((k, i) => [k, d.attributes[i]])),
    photo: photo ? { name: photo.name, credit: photo.authorAttributions?.[0] ?? null } : null,
    source: 'google',
    dataQuality: {
      hoursAssumed: dayHours === null, hoursForWeekday: weekdayOf(dateTime), priceAssumed: price === undefined, priceFromLevel: price !== undefined,
      attributesAreDefaults: true, dietUnknown: true, accessUnknown: true, forecastAreaApprox: true,
    },
  };
}

export { fromGooglePlace, kindOf, hoursOnDay, weekdayOf, PRICE_BY_LEVEL };
