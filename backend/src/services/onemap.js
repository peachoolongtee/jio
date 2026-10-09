import { haversineKm, walkMinutes } from '../planner/geo.js'
import { createCache } from './cache.js'
import { ExternalApiError } from './http.js'
import { currentScenario } from './scenario.js'

// OneMap (Singapore Land Authority): address search and public transport routing.
//
// Search needs no account. Routing needs one: the server logs in with ONEMAP_EMAIL and ONEMAP_PASSWORD, gets a
// token that lasts 3 days, and gets a new one an hour before it runs out. The token never leaves the server.
// Every call goes through the shared HTTP helper, so stub mode answers from fixtures.
//
// Docs: https://www.onemap.gov.sg/apidocs/

const BASE = 'https://www.onemap.gov.sg'
export const TOKEN_URL = `${BASE}/api/auth/post/getToken`
export const SEARCH_URL = `${BASE}/api/common/elastic/search`
export const ROUTE_URL = `${BASE}/api/public/routingsvc/route`

const ROUTE_TTL_MS = 6 * 60 * 60 * 1000 // Timetables do not change within a day, so a route stays good for hours.
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000 // Addresses hardly ever change.
const TOKEN_REFRESH_EARLY_MS = 60 * 60 * 1000 // Get a new token an hour before the old one expires.

// Trips shorter than this are walked: no public transport route is asked for, which saves an API call.
export const WALK_ONLY_KM = 0.4

// Rounds a coordinate to 3 decimal places, about 110 m. Points that close share one cached route.
const round3 = (x) => Math.round(x * 1000) / 1000

// "2026-10-10T19:30" -> { date: '10-10-2026', time: '19:00:00' }. OneMap wants MM-DD-YYYY and Singapore time.
// The time is rounded down to the hour so that one cached route serves a whole hour.
//
// How to call:
//   oneMapDateTime('2026-10-10T19:30') // { date: '10-10-2026', time: '19:00:00' }
export function oneMapDateTime(dateTime) {
  const [y, m, d] = dateTime.slice(0, 10).split('-')
  return { date: `${m}-${d}-${y}`, time: `${dateTime.slice(11, 13)}:00:00` }
}

// Reads one search result into a plain shape.
function toPlace(r) {
  return {
    name: r.BUILDING && r.BUILDING !== 'NIL' ? r.BUILDING : r.SEARCHVAL,
    address: r.ADDRESS,
    postal: r.POSTAL && r.POSTAL !== 'NIL' ? r.POSTAL : null,
    lat: Number(r.LATITUDE),
    lng: Number(r.LONGITUDE),
  }
}

// Builds the OneMap service.
//
// How to call:
//   const onemap = createOneMap({ http, email: process.env.ONEMAP_EMAIL, password: process.env.ONEMAP_PASSWORD })
//   onemap.routingEnabled                                          // false until an account is set
//   const places = await onemap.search('178879')                  // [{ name, address, postal, lat, lng }]
//   const minutes = await onemap.routeMinutes(from, to, '2026-10-10T19:00')
//
// Options:
//   http            - The shared HTTP helper (services/http.js).
//   email, password - The OneMap account. Without both, routing is off and the planner keeps its own estimate.
//   stub            - true in stub mode: routing is on without an account, because the fixtures answer.
//   now             - Returns the time in milliseconds. Tests pass a fake clock.
export function createOneMap({ http, email = null, password = null, stub = false, now = Date.now }) {
  const hasAccount = Boolean(email && password)
  const routingEnabled = hasAccount || stub
  const routes = createCache({ ttlMs: ROUTE_TTL_MS, now })
  const searches = createCache({ ttlMs: SEARCH_TTL_MS, maxItems: 1000, now })
  let token = null // { value, expiresAt }
  let tokenRequest = null // The login in progress, shared by everyone who needs the token meanwhile.

  // Returns a valid token, logging in again when there is none or it is about to run out.
  async function getToken() {
    if (token && token.expiresAt - TOKEN_REFRESH_EARLY_MS > now()) return token.value
    if (!tokenRequest) {
      tokenRequest = (async () => {
        try {
          const body = await http.postJson(TOKEN_URL, { email, password })
          if (!body?.access_token) {
            throw new ExternalApiError('onemap login answered without a token', { service: 'onemap', url: TOKEN_URL })
          }
          // expiry_timestamp is epoch seconds, sent as a string.
          token = { value: body.access_token, expiresAt: Number(body.expiry_timestamp) * 1000 }
          return token.value
        } finally {
          tokenRequest = null
        }
      })()
    }
    return tokenRequest
  }

  // Searches addresses, postal codes and building names. Results are cached for a day.
  //
  // How to call:
  //   const places = await onemap.search('Bishan MRT')
  //   places[0] // { name: 'BISHAN MRT STATION', address: '...', postal: '...', lat: 1.35, lng: 103.84 }
  //
  // Throws ExternalApiError when OneMap fails.
  async function search(query) {
    const q = query.trim()
    const key = `search:${currentScenario()}:${q.toLowerCase()}`
    return searches.getOrSet(key, async () => {
      const url = `${SEARCH_URL}?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`
      const body = await http.getJson(url)
      return (body?.results ?? []).map(toPlace).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
    })
  }

  // Public transport minutes from one point to another, leaving at about dateTime (Singapore time).
  // Trips under 400 m are walked instead, with no API call. Returns null when OneMap finds no route.
  // Routes are cached for 6 hours, by points rounded to about 110 m and the hour.
  //
  // How to call:
  //   const minutes = await onemap.routeMinutes({ lat: 1.35, lng: 103.94 }, { lat: 1.30, lng: 103.85 }, '2026-10-10T19:00')
  //
  // Throws ExternalApiError when OneMap fails, and Error when routing is not enabled.
  async function routeMinutes(from, to, dateTime) {
    if (!routingEnabled) throw new Error('OneMap routing is off: set ONEMAP_EMAIL and ONEMAP_PASSWORD')
    if (haversineKm(from, to) < WALK_ONLY_KM) return walkMinutes(from, to)
    const a = `${round3(from.lat)},${round3(from.lng)}`
    const b = `${round3(to.lat)},${round3(to.lng)}`
    const { date, time } = oneMapDateTime(dateTime)
    const key = `route:${currentScenario()}:${a}:${b}:${date}:${time}`
    return routes.getOrSet(key, async () => {
      const url =
        `${ROUTE_URL}?start=${a}&end=${b}&routeType=pt&date=${date}&time=${time}` +
        '&mode=TRANSIT&maxWalkDistance=1000&numItineraries=1'
      const body = await http.getJson(url, { headers: { Authorization: await getToken() } })
      const seconds = body?.plan?.itineraries?.[0]?.duration
      return Number.isFinite(seconds) ? seconds / 60 : null
    })
  }

  return { routingEnabled, search, routeMinutes }
}
