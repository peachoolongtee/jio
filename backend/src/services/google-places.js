import { createCache } from './cache.js'
import { currentScenario } from './scenario.js'

// Google Places API (New): restaurants, cafés, bars, dessert shops and shopping malls near a point, with ratings, a
// price level and opening hours. Needs GOOGLE_MAPS_API_KEY. Without it the service is off and the planner uses its other venues.
// Every call goes through the shared HTTP helper, so stub mode answers from tests/fixtures/google/.
//
// Cost and terms:
//   - One "nearby" search per planner request at most, cached 10 minutes in memory for points about 110 m apart.
//     Set a daily quota on the key in Google Cloud so a busy day can never run up a bill.
//   - Only the fields below are asked for (the field mask): every extra field can move the request to a dearer tier.
//   - Google's terms allow storing a place's id, not its details, so results are never written to a file.
//
// Docs: https://developers.google.com/maps/documentation/places/web-service/nearby-search

export const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby'
const PHOTO_URL = (name, maxWidthPx) => `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`

// The fields Jio uses. Keep this list short: it decides the price of every request.
export const NEARBY_FIELDS = [
  'places.id',
  'places.displayName',
  'places.location',
  'places.types',
  'places.primaryType',
  'places.formattedAddress',
  'places.priceLevel',
  'places.rating',
  'places.userRatingCount',
  'places.regularOpeningHours',
  'places.photos',
  'places.businessStatus',
].join(',')

// Google's place types for each Jio category. Activities come from OneMap's lists instead (sport centres, parks...).
export const TYPES_BY_CATEGORY = {
  eat: ['restaurant', 'food_court', 'dessert_shop'],
  drink: ['cafe', 'coffee_shop', 'bar'],
  // Malls only: 'department_store' and 'market' brought back single jewellery shops and grocers, not outings.
  shop: ['shopping_mall'],
}

// A photo address as Google gives it: places/<place id>/photos/<photo id>.
export const PHOTO_NAME = /^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/

const round3 = (x) => Math.round(x * 1000) / 1000

// Builds the Google Places service.
//
// How to call:
//   const places = createGooglePlaces({ http, apiKey: process.env.GOOGLE_MAPS_API_KEY })
//   places.enabled                                                        // false without a key
//   const raw = await places.nearby({ lat: 1.35, lng: 103.85 }, { categories: ['eat'], radiusMeters: 1000 })
//   const url = await places.photoUrl('places/ChIJ.../photos/AUc...')    // a short-lived image link with no key in it
//
// Options:
//   http   - The shared HTTP helper (services/http.js).
//   apiKey - GOOGLE_MAPS_API_KEY. Without it, enabled is false.
//   stub   - true in stub mode: on without a key, because the fixtures answer.
//   now    - Returns the time in milliseconds. Tests pass a fake clock.
export function createGooglePlaces({ http, apiKey = null, stub = false, now = Date.now }) {
  const enabled = Boolean(apiKey) || stub
  const nearbyCache = createCache({ ttlMs: 10 * 60 * 1000, maxItems: 500, now })
  const photoCache = createCache({ ttlMs: 30 * 60 * 1000, maxItems: 2000, now })
  const headers = (fieldMask) => ({ 'X-Goog-Api-Key': apiKey ?? 'stub', ...(fieldMask && { 'X-Goog-FieldMask': fieldMask }) })

  // Google's raw places near a point, for the Jio categories given ('eat', 'drink' and 'shop' have Google types).
  // Returns [] when no category needs Google. At most 20 places: Google's limit for one request.
  //
  // How to call:
  //   const raw = await places.nearby({ lat, lng }, { categories: ['eat', 'drink'], radiusMeters: 1000 })
  //
  // Throws ExternalApiError when Google fails, and Error when the service is off.
  async function nearby(point, { categories = ['eat', 'drink'], radiusMeters = 1000 } = {}) {
    if (!enabled) throw new Error('Google Places is off: set GOOGLE_MAPS_API_KEY')
    const includedTypes = [...new Set(categories.flatMap((c) => TYPES_BY_CATEGORY[c] ?? []))].sort()
    if (includedTypes.length === 0) return []
    const radius = Math.min(Math.max(radiusMeters, 100), 3000)
    const key = `nearby:${currentScenario()}:${round3(point.lat)},${round3(point.lng)}:${radius}:${includedTypes.join('+')}`
    return nearbyCache.getOrSet(key, async () => {
      const body = await http.postJson(
        NEARBY_URL,
        {
          includedTypes,
          maxResultCount: 20,
          // Nearest first, not most popular: the planner looks within 500 m first and only widens when it has
          // fewer than 3 options, so far-away popular places would never be considered.
          rankPreference: 'DISTANCE',
          locationRestriction: { circle: { center: { latitude: point.lat, longitude: point.lng }, radius } },
        },
        { headers: headers(NEARBY_FIELDS) },
      )
      return body?.places ?? []
    })
  }

  // A short-lived link to one place photo, for the browser. The key stays here: the browser only ever sees the
  // link Google hands back. Cached 30 minutes.
  //
  // How to call:
  //   const url = await places.photoUrl('places/ChIJ.../photos/AUc...', 400)
  //
  // Throws ExternalApiError when Google fails, and Error for a name that is not a photo address.
  async function photoUrl(name, maxWidthPx = 400) {
    if (!enabled) throw new Error('Google Places is off: set GOOGLE_MAPS_API_KEY')
    if (!PHOTO_NAME.test(name)) throw new Error('not a Google photo name')
    return photoCache.getOrSet(`photo:${currentScenario()}:${name}:${maxWidthPx}`, async () => {
      const body = await http.getJson(PHOTO_URL(name, maxWidthPx), { headers: headers() })
      return body?.photoUri ?? null
    })
  }

  return { enabled, nearby, photoUrl }
}
