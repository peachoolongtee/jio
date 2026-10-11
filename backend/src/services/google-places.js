import { createCallBudget } from './budget.js'
import { createCache } from './cache.js'
import { ExternalApiError } from './errors.js'
import { currentScenario } from './scenario.js'

// Google Places API (New): restaurants, cafés, bars, dessert shops and shopping malls near a point, with ratings, a
// price level and opening hours. Needs GOOGLE_MAPS_API_KEY. Without it the service is off and the planner uses its other venues.
// Every call goes through the shared HTTP helper, so stub mode answers from tests/fixtures/google/.
//
// Cost and terms:
//   - One "nearby" search per planner request at most, cached 10 minutes in memory for points about 110 m apart.
//     The search radius is rounded up to the planner's own steps (500, 1000, 2000, 3000 m), so a caller cannot make
//     a new billed search by changing the radius by one metre.
//   - One budget for every Google call, nearby searches and photos together: GOOGLE_CALLS_PER_MINUTE a minute (60 by
//     default) and at most 4 in flight. A call over the budget fails at once; the planner answers without Google.
//   - Three failures in a row pause Google for a minute (a circuit breaker), and a call waits at most 3 seconds.
//   - Set a daily quota on the key in Google Cloud as well, so a busy day can never run up a bill.
//   - Only the fields below are asked for (the field mask). The mask includes rating, review count, opening hours
//     and price level, which Google is likely to bill at a dearer tier than basic fields (to confirm on Google's
//     pricing page). Every extra field can raise the price further.
//   - Google's terms allow storing a place's id, not its details, so results are never written to a file.
//
// Docs: https://developers.google.com/maps/documentation/places/web-service/nearby-search

export const NEARBY_URL = 'https://places.googleapis.com/v1/places:searchNearby'
export const TEXT_SEARCH_URL = 'https://places.googleapis.com/v1/places:searchText'
const DETAILS_URL = (placeId) => `https://places.googleapis.com/v1/places/${placeId}`
const PHOTO_URL = (name, maxWidthPx) => `https://places.googleapis.com/v1/${name}/media?maxWidthPx=${maxWidthPx}&skipHttpRedirect=true`

export const DEFAULT_GOOGLE_CALLS_PER_MINUTE = 60 // Nearby searches and photos together.
export const GOOGLE_MAX_IN_FLIGHT = 4
export const GOOGLE_TIMEOUT_MS = 3000 // Shorter than the HTTP helper's 10 seconds, which would hold a planner request up.
export const GOOGLE_FAILURES_TO_OPEN = 3 // Failed calls in a row that open the circuit.
export const GOOGLE_CIRCUIT_OPEN_MS = 60 * 1000 // How long Google is skipped once the circuit opens.
export const PHOTO_MISS_MS = 5 * 60 * 1000 // A photo Google says does not exist is not asked for again for this long.
const WARN_EVERY_MS = 60 * 1000 // The same reason is logged at most once in this time.
const STUB_CALLS_PER_MINUTE = 1_000_000 // Stub mode runs the same code, with a budget no test will empty.
const MAX_PLACES = 20 // Google's limit for one search, and the most that is read from an answer.

// The planner's own search radii in metres (radiusSearch in planner/geo.js). A search radius is rounded up to the
// next one, so the circle still covers what was asked and 2,901 possible radii become four cache keys.
export const RADIUS_STEPS = [500, 1000, 2000, 3000]

// The image widths a photo can be asked for, in pixels. A width is rounded up to the next one.
export const PHOTO_WIDTHS = [200, 400, 800, 1600]

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

// The same fields for one place (Place Details), which has no "places." in front.
export const DETAILS_FIELDS = NEARBY_FIELDS.split(',').map((f) => f.replace(/^places\./, '')).join(',')

// A Google place id, as Jio stores it after "google_". Anything else is never sent to Google.
export const PLACE_ID = /^[A-Za-z0-9_-]{1,300}$/

// The most places one text search returns, and how far around the point it prefers places (it can still return
// places further away; the planner then marks them "far").
const TEXT_SEARCH_MAX = 10
const TEXT_SEARCH_BIAS_METERS = 5000

// Google's place types for each Jio category. For activities, OneMap's lists already have the government places
// (parks, SportSG centres, museums, libraries, theatres), so Google adds the private ones OneMap does not list.
export const TYPES_BY_CATEGORY = {
  eat: ['restaurant', 'food_court', 'dessert_shop'],
  drink: ['cafe', 'coffee_shop', 'bar'],
  // Malls only: 'department_store' and 'market' brought back single jewellery shops and grocers, not outings.
  shop: ['shopping_mall'],
  activity: ['bowling_alley', 'movie_theater', 'karaoke', 'video_arcade', 'amusement_center', 'amusement_park', 'art_gallery', 'aquarium', 'zoo'],
}

// A photo address as Google gives it: places/<place id>/photos/<photo id>. Each id is 1 to 300 characters.
export const PHOTO_NAME = /^places\/[A-Za-z0-9_-]{1,300}\/photos\/[A-Za-z0-9_-]{1,300}$/

// Hosts a photo link may point to: Google's image servers and their subdomains.
const IMAGE_HOSTS = ['googleusercontent.com', 'ggpht.com']

// What each reason is called in the log. Never put the key or a response in these.
const FALLBACK_TEXT = {
  budget_empty: 'the Google call budget for this minute is used up',
  circuit_open: 'Google failed several calls in a row, so it is skipped for a short while',
  bad_response: 'Google answered with something the planner cannot read',
  upstream_error: 'Google answered with an error or did not answer',
}

const round3 = (x) => Math.round(x * 1000) / 1000

// Why Google could not be used for a call. A subclass of ExternalApiError, so code that already falls back on
// "Google failed" covers these too, and an uncaught one still answers 500.
//
// `reason` is one of:
//   budget_empty  the call budget for this minute is used up
//   circuit_open  three calls in a row failed, so Google is paused for a while
//   bad_response  Google answered 200 with something unreadable (a places list that is not a list, a photo link
//                 that is not a Google image address)
//
// How to call (google-places.js throws it; callers catch it):
//   try { await places.nearby(point) } catch (err) {
//     if (err instanceof GoogleUnavailableError) console.log(err.reason) // 'budget_empty'
//   }
export class GoogleUnavailableError extends ExternalApiError {
  constructor(reason, message, { retryAfterSeconds = null, url } = {}) {
    super(message, { service: 'google', status: null, url })
    this.name = 'GoogleUnavailableError'
    this.reason = reason
    // Whole seconds until a call is likely to be allowed again, or null when unknown.
    this.retryAfterSeconds = retryAfterSeconds
  }
}

// Rounds a search radius up to the next planner step, at most 3000 m.
//
// How to call:
//   snapRadius(1001) // 2000
export function snapRadius(radiusMeters) {
  const r = Number(radiusMeters)
  if (!Number.isFinite(r)) return 1000
  return RADIUS_STEPS.find((step) => step >= r) ?? RADIUS_STEPS[RADIUS_STEPS.length - 1]
}

// Rounds a photo width up to 200, 400, 800 or 1600 pixels. A width that is not a number is 400.
//
// How to call:
//   snapPhotoWidth(250.7) // 400
export function snapPhotoWidth(maxWidthPx) {
  const w = Math.round(Number(maxWidthPx))
  if (!Number.isFinite(w)) return PHOTO_WIDTHS[1]
  return PHOTO_WIDTHS.find((step) => step >= w) ?? PHOTO_WIDTHS[PHOTO_WIDTHS.length - 1]
}

// The address of a photo link when it is safe to send a browser there: a string that is an https address on one of
// Google's image hosts. Anything else (a number, an object, javascript:, another host) is null.
//
// How to call:
//   safeImageUrl('https://lh3.googleusercontent.com/abc') // 'https://lh3.googleusercontent.com/abc'
//   safeImageUrl('https://evil.example/x')                // null
export function safeImageUrl(value) {
  if (typeof value !== 'string') return null
  let url
  try {
    url = new URL(value)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' || url.username || url.password) return null
  const host = url.hostname.toLowerCase()
  return IMAGE_HOSTS.some((h) => host === h || host.endsWith(`.${h}`)) ? url.href : null
}

// Reads the Google settings from the environment. Used by index.js at start-up.
//
// How to call:
//   const { apiKey, callsPerMinute, warnings } = readGoogleSettings(process.env)
//   warnings.forEach((w) => console.warn(w))
//
// `apiKey` is the trimmed key, or null when GOOGLE_MAPS_API_KEY is missing, blank, or malformed (it holds a space or a
// control character inside it, or a character outside printable ASCII). A malformed key switches Google off and adds
// a warning that names the variable, never its value. `callsPerMinute` is GOOGLE_CALLS_PER_MINUTE, or 60 when it is
// missing or not a whole number above 0 (an invalid value adds a warning).
export function readGoogleSettings(env) {
  const warnings = []
  const raw = typeof env.GOOGLE_MAPS_API_KEY === 'string' ? env.GOOGLE_MAPS_API_KEY.trim() : ''
  let apiKey = null
  if (raw !== '') {
    if (/^[\x21-\x7e]+$/.test(raw)) apiKey = raw
    else warnings.push('GOOGLE_MAPS_API_KEY is malformed (it holds a space, a control character or a character that is not plain ASCII), so Google Places is OFF. Check the value in backend/.env.')
  }
  let callsPerMinute = DEFAULT_GOOGLE_CALLS_PER_MINUTE
  const cap = env.GOOGLE_CALLS_PER_MINUTE
  if (typeof cap === 'string' && cap.trim() !== '') {
    const n = Number(cap)
    if (Number.isInteger(n) && n > 0) callsPerMinute = n
    else warnings.push(`GOOGLE_CALLS_PER_MINUTE must be a whole number above 0, so the default of ${DEFAULT_GOOGLE_CALLS_PER_MINUTE} is used.`)
  }
  return { apiKey, callsPerMinute, warnings }
}

// A plain object that carries a place id: the least a Google place must have to be worth keeping.
const isPlaceObject = (p) => p !== null && typeof p === 'object' && !Array.isArray(p) && typeof p.id === 'string' && p.id !== ''

// A photo or place Google says does not exist (404) or does not accept (400). About that one thing, not about Google
// being unwell.
const isMissingPhoto = (err) =>
  err instanceof ExternalApiError && !(err instanceof GoogleUnavailableError) && (err.status === 404 || err.status === 400)

// Builds the Google Places service.
//
// How to call:
//   const places = createGooglePlaces({ http, apiKey: process.env.GOOGLE_MAPS_API_KEY })
//   places.enabled                                                        // false without a key
//   const raw = await places.nearby({ lat: 1.35, lng: 103.85 }, { categories: ['eat'], radiusMeters: 1000 })
//   const url = await places.photoUrl('places/ChIJ.../photos/AUc...')    // a short-lived image link with no key in it
//
// Options:
//   http           - The shared HTTP helper (services/http.js).
//   apiKey         - GOOGLE_MAPS_API_KEY (see readGoogleSettings). Without it, enabled is false.
//   stub           - true in stub mode: on without a key, because the fixtures answer.
//   callsPerMinute - The budget for every Google call from this server. Default 60. In stub mode the default is large.
//   timeoutMs      - How long one Google call may take. Default 3000. Tests shorten it.
//   now            - Returns the time in milliseconds. Tests pass a fake clock; it moves the budget, the circuit,
//                    the caches and the log's once-a-minute rule.
//   warn           - Where failures are logged, at most once a minute per reason. Defaults to console.warn.
export function createGooglePlaces({
  http,
  apiKey = null,
  stub = false,
  callsPerMinute = stub ? STUB_CALLS_PER_MINUTE : DEFAULT_GOOGLE_CALLS_PER_MINUTE,
  timeoutMs = GOOGLE_TIMEOUT_MS,
  now = Date.now,
  warn = (...args) => console.warn(...args),
}) {
  const key = typeof apiKey === 'string' ? apiKey.trim() : ''
  const enabled = key !== '' || stub
  const nearbyCache = createCache({ ttlMs: 10 * 60 * 1000, maxItems: 500, now })
  const textCache = createCache({ ttlMs: 10 * 60 * 1000, maxItems: 500, now })
  const detailsCache = createCache({ ttlMs: 10 * 60 * 1000, maxItems: 1000, now })
  const photoCache = createCache({ ttlMs: 30 * 60 * 1000, maxItems: 2000, now })
  const photoMisses = createCache({ ttlMs: PHOTO_MISS_MS, maxItems: 2000, now })
  const budget = createCallBudget({
    callsPerMinute,
    maxInFlight: GOOGLE_MAX_IN_FLIGHT,
    now,
    service: 'Google',
    unavailable: (reason, message, details) => new GoogleUnavailableError(reason, message, details),
  })
  const circuit = { failures: 0, openUntil: 0, probing: false }
  const lastWarned = new Map() // reason -> time of the last log line
  const headers = (fieldMask) => ({ 'X-Goog-Api-Key': key || 'stub', ...(fieldMask && { 'X-Goog-FieldMask': fieldMask }) })

  // Logs why Google was not used, at most once a minute per reason. Never logs the key, a URL or a response.
  //
  // How to call (inside this file):
  //   reportFailure(err)
  function reportFailure(err) {
    const refused = err instanceof GoogleUnavailableError
    const reason = refused ? err.reason : 'upstream_error'
    const t = now()
    const last = lastWarned.get(reason)
    if (last !== undefined && t - last < WARN_EVERY_MS) return
    lastWarned.set(reason, t)
    let detail = ''
    if (!refused) detail = err.status ? `HTTP ${err.status}` : /timed out/.test(err.message) ? 'timed out' : 'no response'
    warn(`Google Places is not available (${reason}): ${FALLBACK_TEXT[reason] ?? reason}${detail ? ` [${detail}]` : ''}. The planner uses its other venues.`)
  }

  // Runs one Google call within the budget and the circuit. A call over the budget, or made while the circuit is
  // open, throws GoogleUnavailableError at once and makes no request. Three failures in a row open the circuit for
  // a minute; after that one call at a time is tried, and one success closes it.
  //
  // `benign(err)` marks a failure that is about the thing asked for, not about Google being unwell (a photo that
  // does not exist). It neither counts toward the circuit nor is logged.
  //
  // How to call (inside this file):
  //   const body = await guarded(() => http.getJson(url, { headers: headers(), timeoutMs }))
  async function guarded(fn, { benign = () => false } = {}) {
    let probe = false
    // Refuses while the circuit is open. Once the pause is over, lets exactly one call through as a probe.
    const claim = () => {
      if (probe || circuit.failures < GOOGLE_FAILURES_TO_OPEN) return
      if (now() < circuit.openUntil || circuit.probing) {
        throw new GoogleUnavailableError('circuit_open', 'Google is paused after repeated failures')
      }
      circuit.probing = true
      probe = true
    }
    try {
      claim()
      return await budget.run(
        async () => {
          try {
            const result = await fn()
            circuit.failures = 0
            return result
          } catch (err) {
            if (err instanceof ExternalApiError && !benign(err)) {
              circuit.failures += 1
              // After the pause one more failure opens it again straight away, so a still-sick Google is probed by one call.
              if (circuit.failures >= GOOGLE_FAILURES_TO_OPEN) circuit.openUntil = now() + GOOGLE_CIRCUIT_OPEN_MS
            }
            throw err
          }
        },
        { guard: claim },
      )
    } catch (err) {
      if (err instanceof ExternalApiError && !benign(err)) reportFailure(err)
      throw err
    } finally {
      if (probe) circuit.probing = false
    }
  }

  // Reads the places out of a nearby answer. Google sends {} when nothing matches. A places value that is not a list
  // is a failure. Entries that are not objects with a string id are dropped, and `dropped` says how many.
  //
  // How to call (inside this file):
  //   const { places, dropped } = readPlaces(body)
  function readPlaces(body) {
    const bad = (why) => new GoogleUnavailableError('bad_response', `Google sent a nearby answer that cannot be read (${why})`)
    if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('not an object')
    if (body.places === undefined) return { places: [], dropped: 0 }
    if (!Array.isArray(body.places)) throw bad('places is not a list')
    const list = body.places.slice(0, MAX_PLACES)
    const places = list.filter(isPlaceObject)
    return { places, dropped: list.length - places.length }
  }

  // Google's raw places near a point, for the Jio categories given (every category has Google types).
  // Returns [] when no category needs Google. At most 20 places: Google's limit for one request.
  // The radius is rounded up to the next of 500, 1000, 2000 and 3000 m. An answer that had unreadable entries is
  // returned without them but not cached, so a good answer is picked up on the next request.
  //
  // How to call:
  //   const raw = await places.nearby({ lat, lng }, { categories: ['eat', 'drink'], radiusMeters: 1000 })
  //
  // Throws ExternalApiError when Google fails (GoogleUnavailableError when the budget is empty, the circuit is open
  // or the answer cannot be read), and Error when the service is off.
  async function nearby(point, { categories = ['eat', 'drink'], radiusMeters = 1000 } = {}) {
    if (!enabled) throw new Error('Google Places is off: set GOOGLE_MAPS_API_KEY')
    const includedTypes = [...new Set(categories.flatMap((c) => TYPES_BY_CATEGORY[c] ?? []))].sort()
    if (includedTypes.length === 0) return []
    const radius = snapRadius(radiusMeters)
    const cacheKey = `nearby:${currentScenario()}:${round3(point.lat)},${round3(point.lng)}:${radius}:${includedTypes.join('+')}`
    let partial = false
    const list = await nearbyCache.getOrSet(cacheKey, () =>
      guarded(async () => {
        const body = await http.postJson(
          NEARBY_URL,
          {
            includedTypes,
            maxResultCount: MAX_PLACES,
            // Nearest first, not most popular: the planner looks within 500 m first and only widens when it has
            // fewer than 3 options, so far-away popular places would never be considered.
            rankPreference: 'DISTANCE',
            locationRestriction: { circle: { center: { latitude: point.lat, longitude: point.lng }, radius } },
          },
          { headers: headers(NEARBY_FIELDS), timeoutMs },
        )
        const { places, dropped } = readPlaces(body)
        partial = dropped > 0
        return places
      }),
    )
    // A zero lifetime makes the entry expire at once: the cache keeps nothing from an answer that was only part good.
    if (partial) nearbyCache.set(cacheKey, list, { ttlMs: 0 })
    return list
  }

  // A short-lived link to one place photo, for the browser. The key stays here: the browser only ever sees the
  // link Google hands back, and only when it is an https address on one of Google's image hosts. The width is
  // rounded up to 200, 400, 800 or 1600 pixels. Cached 30 minutes. Returns null when Google has no such photo (404
  // or 400), and remembers that for 5 minutes without asking again.
  //
  // How to call:
  //   const url = await places.photoUrl('places/ChIJ.../photos/AUc...', 400)
  //
  // Throws ExternalApiError when Google fails, GoogleUnavailableError('bad_response') when the link it sends back
  // is not a Google image address, and Error for a name that is not a photo address.
  async function photoUrl(name, maxWidthPx = 400) {
    if (!enabled) throw new Error('Google Places is off: set GOOGLE_MAPS_API_KEY')
    if (!PHOTO_NAME.test(name)) throw new Error('not a Google photo name')
    const width = snapPhotoWidth(maxWidthPx)
    const cacheKey = `photo:${currentScenario()}:${name}:${width}`
    if (photoMisses.get(cacheKey)) return null
    try {
      return await photoCache.getOrSet(cacheKey, () =>
        guarded(
          async () => {
            const body = await http.getJson(PHOTO_URL(name, width), { headers: headers(), timeoutMs })
            const link = safeImageUrl(body?.photoUri)
            if (!link) {
              throw new GoogleUnavailableError('bad_response', 'Google sent a photo link that is not a Google image address')
            }
            return link
          },
          { benign: isMissingPhoto },
        ),
      )
    } catch (err) {
      if (!isMissingPhoto(err)) throw err
      photoMisses.set(cacheKey, true)
      return null
    }
  }

  // Google's raw places matching a name, an address or a postal code, preferring places near `point`. At most 10.
  // For searching by name ("Teo Heng", "Have Fun Karaoke", "238859") where the nearby list only has the 20 nearest.
  // Cached 10 minutes. Uses the same call budget and circuit as every other Google call.
  //
  // How to call:
  //   const raw = await places.searchText('Teo Heng', { lat: 1.3048, lng: 103.8318 })
  //
  // Throws ExternalApiError when Google fails (GoogleUnavailableError when the budget is empty, the circuit is open
  // or the answer cannot be read), and Error when the service is off.
  async function searchText(query, point) {
    if (!enabled) throw new Error('Google Places is off: set GOOGLE_MAPS_API_KEY')
    const textQuery = String(query).trim().slice(0, 100)
    if (!textQuery) return []
    const cacheKey = `text:${currentScenario()}:${round3(point.lat)},${round3(point.lng)}:${textQuery.toLowerCase()}`
    let partial = false
    const list = await textCache.getOrSet(cacheKey, () =>
      guarded(async () => {
        const body = await http.postJson(
          TEXT_SEARCH_URL,
          {
            textQuery,
            pageSize: TEXT_SEARCH_MAX,
            regionCode: 'sg',
            languageCode: 'en',
            locationBias: { circle: { center: { latitude: point.lat, longitude: point.lng }, radius: TEXT_SEARCH_BIAS_METERS } },
          },
          { headers: headers(NEARBY_FIELDS), timeoutMs },
        )
        const { places, dropped } = readPlaces(body)
        partial = dropped > 0
        return places.slice(0, TEXT_SEARCH_MAX)
      }),
    )
    if (partial) textCache.set(cacheKey, list, { ttlMs: 0 })
    return list
  }

  // One Google place by its id, with the same fields as a nearby search, or null when Google has no such place.
  // For a Google place the group added from a search: it is not among the 20 nearest, so the planner looks it up by
  // id to rank it. Google's terms allow keeping a place id; the details are fetched again and cached 10 minutes.
  //
  // How to call:
  //   const raw = await places.details('ChIJ...')
  //
  // Throws ExternalApiError when Google fails, and Error for an id that is not a Google place id.
  async function details(placeId) {
    if (!enabled) throw new Error('Google Places is off: set GOOGLE_MAPS_API_KEY')
    if (!PLACE_ID.test(placeId)) throw new Error('not a Google place id')
    const cacheKey = `details:${currentScenario()}:${placeId}`
    try {
      return await detailsCache.getOrSet(cacheKey, () =>
        guarded(
          async () => {
            const body = await http.getJson(DETAILS_URL(placeId), { headers: headers(DETAILS_FIELDS), timeoutMs })
            if (!isPlaceObject(body)) throw new GoogleUnavailableError('bad_response', 'Google sent a place that cannot be read')
            return body
          },
          { benign: isMissingPhoto },
        ),
      )
    } catch (err) {
      if (isMissingPhoto(err)) return null
      throw err
    }
  }

  return { enabled, nearby, photoUrl, searchText, details }
}
