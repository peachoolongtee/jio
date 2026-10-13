// google-adapter.js: turns places from Google Places API (New) into engine venues.
//
// Google fills the gap OneMap and CDC leave: restaurants, cafés, bars, dessert shops and malls, with real ratings, a price
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

// Google types that make a place a shop. Checked on the PRIMARY type first, because a mall's food court is food.
const MALL_TYPES = ['shopping_mall', 'department_store'];
const MARKET_TYPES = ['market'];

// Google types that make a place an activity, and the kind of place each is (for its attribute defaults).
const ACTIVITY_KIND = {
  movie_theater: 'cinema',
  bowling_alley: 'sports',
  art_gallery: 'museum',
  karaoke: 'attraction',
  video_arcade: 'attraction',
  amusement_center: 'attraction',
  amusement_park: 'attraction',
  aquarium: 'attraction',
  zoo: 'attraction',
};

// Activities a place is mainly for even when Google's primary type says otherwise: every Teo Heng KTV is "bar" first
// and "karaoke" second, and a bowling alley or an arcade may be "restaurant" first. Not art_gallery: many cafés carry
// it for the paintings on their walls.
const MAIN_ACTIVITY_TYPES = ['karaoke', 'bowling_alley', 'video_arcade', 'movie_theater', 'amusement_center', 'amusement_park'];

// Google types of a place someone searched for by name that Jio treats as an outing, an activity for a group. A
// searched place with none of these (a bank, a clinic, a school, a petrol station, a temple that is not also a
// tourist attraction, a place Google gives no type) is not offered as an activity: it comes back marked
// `notAnOuting`, and the search says `not_an_outing`. The list is from Google's Places (New) types, Table A and B:
//   attractions and culture   tourist_attraction, museum, art_gallery, cultural_landmark, historical_landmark,
//                             historical_place, monument, sculpture, cultural_center, performing_arts_theater,
//                             concert_hall, amphitheatre, planetarium, observation_deck
//   parks and nature          park, city_park, national_park, botanical_garden, garden, hiking_area, beach,
//                             picnic_ground, zoo, aquarium, wildlife_park
//   sports and recreation     sports_complex, sports_activity_location, stadium, arena, swimming_pool, ice_skating_rink,
//                             golf_course, adventure_sports_center, athletic_field, gym, fitness_center, water_park
//   entertainment             movie_theater, karaoke, video_arcade, amusement_center, amusement_park, bowling_alley, casino
// A gym is in because climbing gyms and studios are typed 'gym'; an ordinary one is still the group's choice, since
// someone typed its name. Food, drink and shopping are decided before this list is asked, so they are not in it.
export const OUTING_TYPES = [
  'tourist_attraction', 'museum', 'art_gallery', 'cultural_landmark', 'historical_landmark', 'historical_place', 'monument',
  'sculpture', 'cultural_center', 'performing_arts_theater', 'concert_hall', 'amphitheatre', 'planetarium', 'observation_deck',
  'park', 'city_park', 'national_park', 'botanical_garden', 'garden', 'hiking_area', 'beach', 'picnic_ground', 'zoo', 'aquarium',
  'wildlife_park',
  'sports_complex', 'sports_activity_location', 'stadium', 'arena', 'swimming_pool', 'ice_skating_rink', 'golf_course',
  'adventure_sports_center', 'athletic_field', 'gym', 'fitness_center', 'water_park',
  'movie_theater', 'karaoke', 'video_arcade', 'amusement_center', 'amusement_park', 'bowling_alley', 'casino',
];

// Google types of a shop that sells food or medicine. Google also types these 'food', which on its own must not make
// a supermarket a restaurant.
const FOOD_SHOP_TYPES = ['supermarket', 'grocery_store', 'convenience_store', 'liquor_store', 'pharmacy', 'drugstore'];

/**
 * Which kind of place, and which Jio category, a Google place is.
 * Cafés, coffee and bars are 'drink', dessert is 'eat', malls and markets are 'shop', the same as the frontend's own list.
 *
 * `searched` is true for a place someone typed the name of. Its last resort differs: it is an activity only when its types
 * include one of OUTING_TYPES; otherwise the answer carries `notAnOuting: true` (the category is still 'activity', so
 * the shape is the same, and the search marks it unfit). A place from the nearby search keeps the old last resort.
 *
 * How to call:
 *   kindOf({ primaryType: 'italian_restaurant', types: [...] }) // { category: 'eat', kind: 'restaurant', cuisine: 'italian' }
 *   kindOf({ primaryType: 'bank', types: ['bank'] }, { searched: true }) // { category: 'activity', ..., notAnOuting: true }
 */
function kindOf(place, { searched = false } = {}) {
  const types = [place.primaryType, ...(place.types ?? [])].filter(Boolean);
  const has = (...t) => types.some(x => t.includes(x));
  const cuisine = CUISINES.find(c => types.some(t => t.startsWith(`${c}_`))) ??
    (types.some(t => /chinese_noodle|dim_sum|hot_pot/.test(t)) ? 'chinese' : null);
  if (ACTIVITY_KIND[place.primaryType]) return { category: 'activity', kind: ACTIVITY_KIND[place.primaryType], cuisine: place.primaryType };
  if (MALL_TYPES.includes(place.primaryType)) return { category: 'shop', kind: 'mall', cuisine: 'mall' };
  if (MARKET_TYPES.includes(place.primaryType)) return { category: 'shop', kind: 'market', cuisine: 'market' };
  const mainActivity = MAIN_ACTIVITY_TYPES.find(t => types.includes(t));
  if (mainActivity) return { category: 'activity', kind: ACTIVITY_KIND[mainActivity], cuisine: mainActivity };
  if (has('food_court')) return { category: 'eat', kind: 'hawker', cuisine: 'hawker' };
  if (has('bar', 'pub', 'wine_bar', 'cocktail_bar', 'night_club')) return { category: 'drink', kind: 'bar', cuisine: 'bar' };
  if (has('dessert_shop', 'ice_cream_shop', 'dessert_restaurant', 'bakery', 'confectionery')) return { category: 'eat', kind: 'dessert', cuisine: 'dessert' };
  if (has('cafe', 'coffee_shop', 'tea_house', 'cat_cafe')) return { category: 'drink', kind: 'cafe', cuisine: 'cafe' };
  if (has('restaurant', 'meal_takeaway', 'meal_delivery') || cuisine) return { category: 'eat', kind: 'restaurant', cuisine: cuisine ?? 'restaurant' };
  // 'food' alone is Google's catch-all (a supermarket and a convenience store carry it): a food shop is a shop.
  if (has('food') && !has(...FOOD_SHOP_TYPES)) return { category: 'eat', kind: 'restaurant', cuisine: cuisine ?? 'restaurant' };
  if (has(...FOOD_SHOP_TYPES)) return { category: 'shop', kind: 'mall', cuisine: 'store' };
  const activityType = types.find(t => ACTIVITY_KIND[t]);
  if (activityType) return { category: 'activity', kind: ACTIVITY_KIND[activityType], cuisine: activityType };
  if (has(...MALL_TYPES)) return { category: 'shop', kind: 'mall', cuisine: 'mall' };
  if (has(...MARKET_TYPES)) return { category: 'shop', kind: 'market', cuisine: 'market' };
  if (has('store', 'clothing_store', 'shoe_store', 'book_store', 'electronics_store', 'gift_shop', 'jewelry_store', 'home_goods_store', 'furniture_store', 'sporting_goods_store')) return { category: 'shop', kind: 'mall', cuisine: 'store' };
  // Nothing says food, drink or shopping. Only a place someone searched for by name gets here; the nearby search asks
  // Google for Jio's own types. A searched place is something to do (a climbing gym, a museum, a park) only when
  // Google types it as an outing; a bank or a clinic is not.
  const fallback = { category: 'activity', kind: 'attraction', cuisine: place.primaryType ?? 'attraction' };
  return searched && !has(...OUTING_TYPES) ? { ...fallback, notAnOuting: true } : fallback;
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
  // Entries that are not objects (a null in the list) are ignored.
  const periods = Array.isArray(opening?.periods) ? opening.periods.filter(p => p !== null && typeof p === 'object') : [];
  if (periods.length === 0) return null;
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

// A shop or an activity needs this many Google reviews: fewer usually means one small store, a private studio, or a
// listing nobody visits. Food and drink have no minimum: a small hawker stall with few reviews is still a real meal.
const MIN_REVIEWS = { shop: 50, activity: 30 };

// Google sometimes still marks a place open while its own name says it has shut ("... (No longer in operation)").
const CLOSED_NAME = /no longer in operation|permanently closed|\bclosed down\b/i;

// Activities only. Businesses sometimes tag themselves as a gallery or an amusement centre and stuff an advert into
// the name ("LouisArtStory - Luxury Watch Protection Film/ Artisan Workmanship..."), and coaching schools tag
// themselves as amusement centres. Neither is an outing for a group of friends.
const ADVERT_NAME = name => name.length > 60 || (name.match(/\//g) ?? []).length >= 2;
const LESSONS_NAME = /\b(academy|school|tuition|coaching|enrichment|classes)\b/i;

/**
 * One Google place -> one engine venue, for a visit on a given date-time (the hours are that day's).
 * Returns null for a place that has closed down (by Google's status or its own name), has no location, has no name, or
 * is a shop with fewer than 50 reviews, or an activity with fewer than 30 reviews, an advert for a name, or lessons.
 * With `searched` (someone typed its name, or the group added it from a search), the review minimums do not apply: the
 * group asked for that place, so a small karaoke with few reviews is still theirs to pick.
 * A searched place that is not an outing (a bank, a clinic, a school, an advert for a name) is kept but comes back with
 * `notAnOuting: true`, so the search can say why it cannot be added; a nearby one is left out.
 *
 * How to call:
 *   const venue = fromGooglePlace(place, '2026-10-10T19:00')
 *   const venue = fromGooglePlace(place, '2026-10-10T19:00', { searched: true })
 */
function fromGooglePlace(place, dateTime, { searched = false } = {}) {
  const lat = place.location?.latitude, lng = place.location?.longitude;
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (place.businessStatus && place.businessStatus !== 'OPERATIONAL') return null;
  if (CLOSED_NAME.test(place.displayName?.text ?? '')) return null;
  const name = typeof place.displayName?.text === 'string' ? place.displayName.text.trim() : '';
  if (name === '') return null; // A place with no name cannot be shown to anyone.
  const { category, kind, cuisine, notAnOuting: byType } = kindOf(place, { searched });
  if (!searched && (place.userRatingCount ?? 0) < (MIN_REVIEWS[category] ?? 0)) return null;
  // An advert for a name, or lessons, is not an outing. A nearby place like that is left out; a searched one is shown
  // and marked, so the search can say why it cannot be added.
  const notOutingByName = category === 'activity' && (ADVERT_NAME(name) || LESSONS_NAME.test(name));
  if (notOutingByName && !searched) return null;
  const notAnOuting = byType === true || (searched && notOutingByName);
  const d = KIND_DEFAULTS[kind] ?? KIND_DEFAULTS.restaurant;
  const price = Object.hasOwn(PRICE_BY_LEVEL, place.priceLevel) ? PRICE_BY_LEVEL[place.priceLevel] : undefined;
  const dayHours = hoursOnDay(place.regularOpeningHours, weekdayOf(dateTime));
  const photo = Array.isArray(place.photos) ? place.photos[0] : null;
  // Every author Google names for the photo: Google requires all of them to be shown with it. `credit` is the first.
  const credits = Array.isArray(photo?.authorAttributions) ? photo.authorAttributions.filter(a => a !== null && typeof a === 'object') : [];
  return {
    id: `google_${place.id}`, googlePlaceId: place.id,
    name,
    area: typeof place.formattedAddress === 'string' ? place.formattedAddress : '',
    address: typeof place.formattedAddress === 'string' ? place.formattedAddress : null,
    nearestMrt: null, lat, lng, forecastArea: approxRegion({ lat, lng }),
    category, kind, cuisine,
    avgPricePerPerson: price ?? 20, priceBand: price === undefined ? 2 : price <= 8 ? 1 : price <= 20 ? 2 : price <= 40 ? 3 : 4,
    rating: typeof place.rating === 'number' ? place.rating : null, ratingCount: typeof place.userRatingCount === 'number' ? place.userRatingCount : null,
    // Shops and activities have no diet, so dietary filters skip them (like the frontend's). Food and drink: unknown.
    diet: category === 'shop' || category === 'activity' ? null : { halal: 'unknown', vegetarian: 'unknown', vegan: 'unknown', healthy: d.healthy ?? 2 },
    setting: 'indoor', exposure: 1, aircon: kind !== 'hawker',
    stepFree: null, sockets: null, wifi: null, cdcAccepted: false,
    maxGroupSize: d.maxGroupSize, hasPrivateRoom: false, cakeFriendly: false, longStayOk: d.longStayOk,
    noise: d.noise, queueMinutesPeak: null,
    // An empty list means closed that day. No hours at all from Google: typical hours, labelled.
    openingHours: dayHours ?? [['11:00', '21:00']],
    mealPeriods: [], // Google's hours already say when it is open; no separate meal rule
    attributes: Object.fromEntries(ATTRIBUTE_KEYS.map((k, i) => [k, d.attributes[i]])),
    photo: typeof photo?.name === 'string' ? { name: photo.name, credit: credits[0] ?? null, credits } : null,
    source: 'google',
    ...(notAnOuting && { notAnOuting: true }),
    dataQuality: {
      hoursAssumed: dayHours === null, hoursForWeekday: weekdayOf(dateTime), priceAssumed: price === undefined, priceFromLevel: price !== undefined,
      attributesAreDefaults: true, dietUnknown: category === 'eat' || category === 'drink', accessUnknown: true, forecastAreaApprox: true,
    },
  };
}

/**
 * Google's places -> engine venues, for a visit on a given date-time. Never throws because of what Google sent: an
 * entry that is not an object, has no string id, has no numeric location, or fails to convert is skipped, and so is
 * a place fromGooglePlace leaves out.
 *
 * How to call:
 *   const venues = fromGooglePlaces(raw, '2026-10-10T19:00')
 *   const venues = fromGooglePlaces(raw, '2026-10-10T19:00', { searched: true }) // see fromGooglePlace
 */
function fromGooglePlaces(places, dateTime, options = {}) {
  if (!Array.isArray(places)) return [];
  const venues = [];
  for (const place of places) {
    if (place === null || typeof place !== 'object' || typeof place.id !== 'string' || place.id === '') continue;
    if (!Number.isFinite(place.location?.latitude) || !Number.isFinite(place.location?.longitude)) continue;
    try {
      const venue = fromGooglePlace(place, dateTime, options);
      if (venue) venues.push(venue);
    } catch {
      // One odd place must not cost the request its other venues.
    }
  }
  return venues;
}

export { fromGooglePlace, fromGooglePlaces, kindOf, hoursOnDay, weekdayOf, PRICE_BY_LEVEL };
