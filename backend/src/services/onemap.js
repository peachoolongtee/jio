import { haversineKm, walkMinutes } from '../planner/geo.js'
import { createCallBudget, DEFAULT_CALLS_PER_MINUTE, OneMapUnavailableError } from './budget.js'
import { createCache, queryKey } from './cache.js'
import { ExternalApiError } from './http.js'
import { currentScenario } from './scenario.js'

export { OneMapUnavailableError }

// OneMap (Singapore Land Authority): address search and public transport routing.
//
// Search needs no account. Routing needs one: the server logs in with ONEMAP_EMAIL and ONEMAP_PASSWORD, gets a
// token that lasts 3 days, and gets a new one an hour before it runs out. The token never leaves the server.
// Every call goes through the shared HTTP helper, so stub mode answers from fixtures.
//
// The account is shared by the whole server and allows 300 calls a minute, so this service also keeps it safe:
//   - One budget (services/budget.js) for every call, whether routing, search or login: at most 6 in flight,
//     and ONEMAP_CALLS_PER_MINUTE calls a minute. An empty budget never makes a caller wait.
//   - A rejected token (401) is dropped, replaced by one login that concurrent callers share, and the call is
//     retried once. A failed login is not tried again for a minute.
//   - Five route calls in a row that fail pause routing for 30 seconds (a circuit breaker).
//   - A failed answer is never cached as a travel time.
//
// Docs: https://www.onemap.gov.sg/apidocs/

const BASE = 'https://www.onemap.gov.sg'
export const TOKEN_URL = `${BASE}/api/auth/post/getToken`
export const SEARCH_URL = `${BASE}/api/common/elastic/search`
export const ROUTE_URL = `${BASE}/api/public/routingsvc/route`
export const THEME_URL = `${BASE}/api/public/themesvc/retrieveTheme`

const ROUTE_TTL_MS = 6 * 60 * 60 * 1000 // Timetables do not change within a day, so a route stays good for hours.
const SEARCH_TTL_MS = 24 * 60 * 60 * 1000 // Addresses hardly ever change.
const TOKEN_REFRESH_EARLY_MS = 60 * 60 * 1000 // Get a new token an hour before the old one expires.
const UNKNOWN_EXPIRY_MS = 60 * 60 * 1000 // A token whose expiry we cannot read is trusted for an hour.
export const LOGIN_RETRY_MS = 60 * 1000 // After a failed login, wait this long before trying again.
export const ROUTE_FAILURES_TO_OPEN = 5 // Failed route calls in a row that open the circuit.
export const CIRCUIT_OPEN_MS = 30 * 1000 // How long routing stays paused once the circuit opens.
const WARN_EVERY_MS = 60 * 1000 // The same fallback reason is logged at most once in this time.
const STUB_CALLS_PER_MINUTE = 1_000_000 // Stub mode runs the same code, with a budget no test will empty.

// A route call that fails with one of these is about that trip (no route, bad point), not about OneMap being
// unwell, so it does not count toward opening the circuit.
const TRIP_SPECIFIC_STATUSES = new Set([400, 404, 422])

// The example values in .env.example. A server started with either is misconfigured.
export const ONEMAP_EMAIL_PLACEHOLDER = 'you@example.com'
export const ONEMAP_PASSWORD_PLACEHOLDER = 'your-onemap-password'

// What each reason is called in the log. Never put a credential or a token in these.
const FALLBACK_TEXT = {
  budget_empty: 'the OneMap call budget for this minute is used up',
  circuit_open: 'OneMap failed several calls in a row, so routing is paused for a short while',
  login_failed: 'the OneMap login failed, so routing is paused until the next try',
  deadline: 'OneMap did not answer in time for this request',
  upstream_error: 'OneMap answered with an error',
}

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

// Reads a search answer into plain places, or throws ExternalApiError when it cannot be read: not an object, a
// `results` that is not a list, or a result that is not an object. `{}` and `{ results: [] }` are a good answer with
// nothing in it. A result with no usable point is skipped, as it always was.
//
// How to call (inside this file):
//   const places = readSearchAnswer(body)
function readSearchAnswer(body) {
  const bad = (why) => new ExternalApiError(`onemap sent a search answer that cannot be read (${why})`, { service: 'onemap', status: null, url: SEARCH_URL })
  if (body === null || typeof body !== 'object' || Array.isArray(body)) throw bad('not an object')
  const results = body.results ?? []
  if (!Array.isArray(results)) throw bad('results is not a list')
  if (results.some((r) => r === null || typeof r !== 'object' || Array.isArray(r))) throw bad('a result is not an object')
  return results.map(toPlace).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng))
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


// Reads the OneMap settings from the environment and checks them. Used by index.js at start-up.
//
// How to call:
//   const settings = readOneMapSettings(process.env)
//   if (settings.error) { console.error(settings.error); process.exit(1) }
//   const { email, password, callsPerMinute } = settings   // email and password are null without an account
//
// An example value from .env.example counts as not set, so a fresh copy of that file starts with routing off.
// It refuses (returns `error`) in two cases, and the message names the variables, never their values:
//   - only one of ONEMAP_EMAIL and ONEMAP_PASSWORD holds a real value;
//   - ONEMAP_CALLS_PER_MINUTE is set and is not a whole number above 0.
// `callsPerMinute` is undefined when the variable is blank; createOneMap then uses its default (240).
export function readOneMapSettings(env) {
  const set = (value) => typeof value === 'string' && value.trim() !== ''
  const email = set(env.ONEMAP_EMAIL) && env.ONEMAP_EMAIL !== ONEMAP_EMAIL_PLACEHOLDER ? env.ONEMAP_EMAIL : null
  const password = set(env.ONEMAP_PASSWORD) && env.ONEMAP_PASSWORD !== ONEMAP_PASSWORD_PLACEHOLDER ? env.ONEMAP_PASSWORD : null

  if ((email === null) !== (password === null)) {
    const missing = email === null ? 'ONEMAP_EMAIL' : 'ONEMAP_PASSWORD'
    return { error: `OneMap is only partly configured. Missing: ${missing}. Set both ONEMAP_EMAIL and ONEMAP_PASSWORD, or neither.` }
  }

  let callsPerMinute
  if (set(env.ONEMAP_CALLS_PER_MINUTE)) {
    callsPerMinute = Number(env.ONEMAP_CALLS_PER_MINUTE)
    if (!Number.isInteger(callsPerMinute) || callsPerMinute <= 0) {
      return { error: 'ONEMAP_CALLS_PER_MINUTE must be a whole number above 0.' }
    }
  }
  return { email, password, callsPerMinute }
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
//   callsPerMinute  - The budget for every OneMap call from this server. Default 240, which leaves headroom
//                     under the shared account's 300. In stub mode the default is large, so tests do not hit it.
//   now             - Returns the time in milliseconds. Tests pass a fake clock; it moves the budget, the login
//                     back-off, the circuit and the cache.
//   warn            - Where fallback reasons are logged. Defaults to console.warn.
//
// The shape of what it returns:
//   search(query)                           places; throws OneMapUnavailableError('budget_empty') when out of budget
//   routeMinutes(from, to, dateTime)        minutes, or null for "no route"; throws ExternalApiError on failure
//   peekRoute(from, to, dateTime)           { kind: 'walk' | 'cached' | 'call', minutes? }: what routeMinutes would
//                                           do, without doing it. The planner uses it to count calls beforehand.
//   reportFallback(reason)                  logs a fallback reason, at most once a minute per reason
//   warmUp()                                tries one login and says whether it worked; never throws
export function createOneMap({
  http,
  email = null,
  password = null,
  stub = false,
  callsPerMinute = stub ? STUB_CALLS_PER_MINUTE : DEFAULT_CALLS_PER_MINUTE,
  now = Date.now,
  warn = (...args) => console.warn(...args),
}) {
  const hasAccount = Boolean(email && password)
  const routingEnabled = hasAccount || stub
  const routes = createCache({ ttlMs: ROUTE_TTL_MS, now })
  const searches = createCache({ ttlMs: SEARCH_TTL_MS, maxItems: 1000, now })
  const budget = createCallBudget({ callsPerMinute, now })

  let token = null // { value, expiresAt, refreshAt }
  let loginRequest = null // The login in progress, shared by everyone who needs the token meanwhile.
  let loginBlockedUntil = 0 // No login is tried before this time, after one failed.
  let warnedAboutExpiry = false
  // The circuit breaker, one per stub scenario so that a routing-fail test cannot pause the next dry one.
  // Outside stub mode the scenario is always 'dry', so there is exactly one.
  const circuits = new Map() // scenario -> { failures, openUntil }
  const lastWarned = new Map() // reason -> time of the last log line

  const unavailable = (reason, message) => new OneMapUnavailableError(reason, message, { url: ROUTE_URL })

  // Logs why routing fell back to the estimate, at most once a minute per reason. Never logs a credential.
  //
  // How to call:
  //   onemap.reportFallback('deadline')
  //   onemap.reportFallback('upstream_error', 'HTTP 503')
  function reportFallback(reason, detail = '') {
    const t = now()
    const last = lastWarned.get(reason)
    if (last !== undefined && t - last < WARN_EVERY_MS) return
    lastWarned.set(reason, t)
    warn(`OneMap routing fell back to the estimate (${reason}): ${FALLBACK_TEXT[reason] ?? reason}${detail ? ` [${detail}]` : ''}.`)
  }

  // Reads when a login answer expires. A missing, non-numeric or already past expiry_timestamp must not make
  // every call log in again, so such a token is trusted for an hour, and the log says so once.
  function makeToken(body) {
    const issuedAt = now()
    // expiry_timestamp is epoch seconds, sent as a string.
    const stated = Number(body.expiry_timestamp) * 1000
    let expiresAt = stated
    if (!Number.isFinite(stated) || stated <= issuedAt) {
      expiresAt = issuedAt + UNKNOWN_EXPIRY_MS
      if (!warnedAboutExpiry) {
        warnedAboutExpiry = true
        warn('OneMap login answered without a usable expiry_timestamp: treating the token as valid for one hour.')
      }
    }
    // Refresh an hour early, or halfway through the life of a token that is shorter than two hours.
    const refreshAt = expiresAt - Math.min(TOKEN_REFRESH_EARLY_MS, (expiresAt - issuedAt) / 2)
    return { value: body.access_token, expiresAt, refreshAt }
  }

  const blockLogins = () => {
    loginBlockedUntil = now() + LOGIN_RETRY_MS
  }

  // Logs in. Callers who arrive while a login runs share it. A failed login blocks the next one for a minute.
  // The login spends one call from the budget; running out of budget is not a login failure and blocks nothing.
  //
  // How to call (inside this file):
  //   const value = await login()
  //
  // Throws OneMapUnavailableError('login_failed') when OneMap refuses or cannot be reached.
  function login() {
    if (loginRequest) return loginRequest
    if (now() < loginBlockedUntil) {
      return Promise.reject(unavailable('login_failed', 'the OneMap login failed a moment ago and is not tried again yet'))
    }
    loginRequest = (async () => {
      try {
        const body = await budget.run(() => http.postJson(TOKEN_URL, { email, password }))
        if (!body?.access_token) {
          throw new ExternalApiError('onemap login answered without a token', { service: 'onemap', url: TOKEN_URL })
        }
        token = makeToken(body)
        loginBlockedUntil = 0
        return token.value
      } catch (err) {
        if (err instanceof OneMapUnavailableError) throw err
        if (err instanceof ExternalApiError) {
          blockLogins()
          // The message names the status only: never the account, the token or the response.
          throw unavailable('login_failed', `the OneMap login failed${err.status ? ` (HTTP ${err.status})` : ''}`)
        }
        throw err
      } finally {
        loginRequest = null
      }
    })()
    return loginRequest
  }

  // Returns a token that can be used now. Logs in when there is none or it is due for renewal. If the renewal
  // fails while the old token has not expired, the old one is kept.
  //
  // How to call (inside this file):
  //   const value = await currentToken()
  async function currentToken() {
    const held = token
    if (held && now() < held.refreshAt) return held.value
    try {
      return await login()
    } catch (err) {
      if (held && token === held && now() < held.expiresAt) return held.value
      throw err
    }
  }

  // GET with the OneMap token. A 401 means the token was rejected: drop it, log in once (concurrent callers share
  // that login) and retry the call once. If the new token is rejected too, stop logging in for a minute, so a
  // wrong account cannot cost a login per trip.
  //
  // How to call (inside this file):
  //   const body = await getWithToken(url, guard)
  async function getWithToken(url, guard) {
    const send = (value) => budget.run(() => http.getJson(url, { headers: { Authorization: value } }), { guard })
    const isRejection = (err) => err instanceof ExternalApiError && !(err instanceof OneMapUnavailableError) && err.status === 401

    const used = await currentToken()
    try {
      return await send(used)
    } catch (err) {
      if (!isRejection(err)) throw err
      if (token?.value === used) token = null // Only the token that was rejected: a concurrent 401 may have replaced it.
      const fresh = await currentToken()
      try {
        return await send(fresh)
      } catch (second) {
        if (isRejection(second)) {
          if (token?.value === fresh) token = null
          blockLogins()
        }
        throw second
      }
    }
  }

  const circuitFor = () => {
    const scenario = currentScenario()
    let circuit = circuits.get(scenario)
    if (!circuit) {
      circuit = { failures: 0, openUntil: 0 }
      circuits.set(scenario, circuit)
    }
    return circuit
  }

  // Works out what a route needs: a walk, or a cache key and a URL.
  function describeRoute(from, to, dateTime) {
    if (haversineKm(from, to) < WALK_ONLY_KM) return { walk: walkMinutes(from, to) }
    const a = `${round3(from.lat)},${round3(from.lng)}`
    const b = `${round3(to.lat)},${round3(to.lng)}`
    const { date, time } = oneMapDateTime(dateTime)
    return {
      key: `route:${currentScenario()}:${a}:${b}:${date}:${time}`,
      url:
        `${ROUTE_URL}?start=${a}&end=${b}&routeType=pt&date=${date}&time=${time}` +
        '&mode=TRANSIT&maxWalkDistance=1000&numItineraries=1',
    }
  }

  // One real route call: the circuit, the token, the budget. Only this counts toward the circuit.
  async function fetchRoute(url) {
    const circuit = circuitFor()
    const guard = () => {
      if (now() < circuit.openUntil) throw unavailable('circuit_open', 'routing is paused after repeated OneMap failures')
    }
    guard()
    let body
    try {
      body = await getWithToken(url, guard)
      // An answer with no plan at all is a failure, not "no route": it must not be cached for hours.
      if (!Array.isArray(body?.plan?.itineraries)) {
        throw new ExternalApiError('onemap sent a route answer without a plan', { service: 'onemap', status: null, url: ROUTE_URL })
      }
    } catch (err) {
      const aboutTheTrip = err instanceof ExternalApiError && TRIP_SPECIFIC_STATUSES.has(err.status)
      if (err instanceof ExternalApiError && !(err instanceof OneMapUnavailableError) && !aboutTheTrip) {
        circuit.failures += 1
        // Once open, one failure after the pause opens it again straight away, so a still-sick OneMap
        // is probed by a single failed batch, not five.
        if (circuit.failures >= ROUTE_FAILURES_TO_OPEN) circuit.openUntil = now() + CIRCUIT_OPEN_MS
      }
      throw err
    }
    circuit.failures = 0
    const seconds = body.plan.itineraries[0]?.duration
    return Number.isFinite(seconds) ? seconds / 60 : null
  }

  // Searches addresses, postal codes and building names. Results are cached for a day.
  //
  // How to call:
  //   const places = await onemap.search('Bishan MRT')
  //   places[0] // { name: 'BISHAN MRT STATION', address: '...', postal: '...', lat: 1.35, lng: 103.84 }
  //
  // Throws ExternalApiError when OneMap fails or answers with something that cannot be read (never cached), and
  // OneMapUnavailableError (a kind of ExternalApiError) with reason 'budget_empty' and retryAfterSeconds when the
  // shared call budget is used up. The array returned is the cache's own: copy it before changing it.
  async function search(query) {
    const q = query.trim()
    const key = `search:${currentScenario()}:${queryKey(q)}`
    return searches.getOrSet(key, async () => {
      const url = `${SEARCH_URL}?searchVal=${encodeURIComponent(q)}&returnGeom=Y&getAddrDetails=Y&pageNum=1`
      const body = await budget.run(() => http.getJson(url))
      return readSearchAnswer(body)
    })
  }

  // Says what routeMinutes would do for a trip, without doing it and without spending anything:
  //   { kind: 'walk', minutes }     under 400 m: walked, no call
  //   { kind: 'cached', minutes }   answered before; minutes is null when OneMap said there is no route
  //   { kind: 'call' }              needs a OneMap call
  //
  // How to call:
  //   const plan = onemap.peekRoute(from, to, '2026-10-10T19:00')
  //   if (plan.kind === 'call') callsNeeded += 1
  //
  // Throws Error when routing is not enabled.
  function peekRoute(from, to, dateTime) {
    if (!routingEnabled) throw new Error('OneMap routing is off: set ONEMAP_EMAIL and ONEMAP_PASSWORD')
    const d = describeRoute(from, to, dateTime)
    if (d.walk !== undefined) return { kind: 'walk', minutes: d.walk }
    const hit = routes.get(d.key)
    return hit === undefined ? { kind: 'call' } : { kind: 'cached', minutes: hit }
  }

  // Public transport minutes from one point to another, leaving at about dateTime (Singapore time).
  // Trips under 400 m are walked instead, with no API call. Returns null when OneMap finds no route.
  // Routes are cached for 6 hours, by points rounded to about 110 m and the hour. A failure is never cached.
  //
  // How to call:
  //   const minutes = await onemap.routeMinutes({ lat: 1.35, lng: 103.94 }, { lat: 1.30, lng: 103.85 }, '2026-10-10T19:00')
  //
  // Throws ExternalApiError when OneMap fails, and Error when routing is not enabled. When OneMap is not
  // available right now (budget used up, circuit open, login failed) it throws OneMapUnavailableError at once,
  // without waiting; the caller falls back to the estimate.
  async function routeMinutes(from, to, dateTime) {
    if (!routingEnabled) throw new Error('OneMap routing is off: set ONEMAP_EMAIL and ONEMAP_PASSWORD')
    const d = describeRoute(from, to, dateTime)
    if (d.walk !== undefined) return d.walk
    try {
      return await routes.getOrSet(d.key, () => fetchRoute(d.url))
    } catch (err) {
      if (err instanceof OneMapUnavailableError) reportFallback(err.reason)
      else if (err instanceof ExternalApiError) reportFallback('upstream_error', err.status ? `HTTP ${err.status}` : 'no response')
      throw err
    }
  }

  // Every place in one OneMap theme (for example 'sportsg_sport_facilities'), as OneMap sends them. Needs the
  // account. Used by scripts/build-onemap-places.js to take a snapshot, never per request. Goes through the same
  // call budget and token retry as routing (getWithToken), so a snapshot cannot use up the shared account.
  //
  // How to call:
  //   const rows = await onemap.theme('museum')   // [{ NAME, DESCRIPTION, LatLng, ... }]
  //
  // Throws ExternalApiError when OneMap fails, OneMapUnavailableError when the budget is empty or the login
  // failed, and Error when there is no account.
  async function theme(queryName) {
    if (!hasAccount) throw new Error('OneMap themes need an account: set ONEMAP_EMAIL and ONEMAP_PASSWORD')
    const body = await getWithToken(`${THEME_URL}?queryName=${encodeURIComponent(queryName)}`)
    // The first row describes the theme itself (its name and when it was updated), not a place.
    return (body?.SrchResults ?? []).slice(1)
  }

  // Tries one login and says whether it worked. For start-up: it never throws, and a failure only means
  // routing falls back to the estimate until OneMap answers.
  //
  // How to call:
  //   const ok = await onemap.warmUp()   // true | false
  async function warmUp() {
    if (!routingEnabled) return false
    try {
      await currentToken()
      return true
    } catch {
      return false
    }
  }

  return { routingEnabled, search, routeMinutes, peekRoute, reportFallback, warmUp, theme }
}
