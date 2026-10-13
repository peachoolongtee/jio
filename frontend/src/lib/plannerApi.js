// The planner runs on the Jio backend (backend/src/planner). This file is the frontend's side of it:
// it sends the requests and turns the answers into the shapes the screens already read.
// Request and response details: backend/docs/planner-api.md.
//
// Every function takes plain values (members, points, a slot), not a session, so api.js stays the one
// place that knows how a session is stored.
import axios from 'axios'
import { ref } from 'vue'
import * as auth from './auth.js'
import { weatherFrom } from './weatherText.js'

// Calls to the Jio backend (planner, geocode and weather proxy).
// Each request carries the Supabase session token when there is one (see the interceptors below). The backend
// verifies it locally; a local account or a build without Supabase has none, and the requests go without.
// In development, leave VITE_API_BASE_URL blank: requests go to /api on the page's own address and the Vite dev
// server forwards them to the backend (see vite.config.js). Deployed, it is the backend's URL.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '',
  timeout: 15000,
})

// What the login check's answers say, in words a person can act on.
const SESSION_ENDED = 'Your session has ended. Log in again.'
const LOGIN_NEEDED = 'The planner needs you to be logged in. Log in and try again.'
const AUTH_UNAVAILABLE = 'Jio cannot check your login right now. Try again in a moment.'

// What a failed request says. Screens show err.message, so say what went wrong in words a person can act on.
// Developer text (commands, environment variable names, request details) is only for development builds;
// `dev` is a parameter so both wordings can be tested.
// How to call: plannerErrorMessage(err, { dev: false }) -> 'Too many requests. Wait a few seconds and try again.'
export function plannerErrorMessage(err, { dev = import.meta.env.DEV, baseURL = api.defaults.baseURL } = {}) {
  // No answer at all: the backend is not running, or it refused this page's address (CORS allows one
  // origin, FRONTEND_ORIGIN). The browser reports both the same way, so name both in development.
  if (!err?.response) {
    if (!dev) return 'Cannot reach the Jio planner right now. Check your connection and try again.'
    // No base URL: the Vite dev server forwards /api to the backend, so only the backend can be missing.
    return baseURL
      ? `Cannot reach the Jio planner at ${baseURL}. Check the backend is running ("pnpm dev:backend") ` +
          `and that this page is open at the address it allows (FRONTEND_ORIGIN, by default http://localhost:5173).`
      : 'Cannot reach the Jio planner. Check the backend is running in another terminal ("pnpm dev:backend").'
  }
  const { status, data } = err.response
  if (status === 429) return 'Too many requests. Wait a few seconds and try again.'
  // The login check's two answers (backend/src/middleware/auth.js). A 401 reaches here only when it could not be fixed
  // by refreshing the token, which is a request that carried none.
  if (status === 503 && data?.error === 'auth_unavailable') return AUTH_UNAVAILABLE
  if (status === 401 && data?.error === 'unauthenticated') return LOGIN_NEEDED
  const issues = data?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')
  if (issues) return dev ? `The planner could not use this request (${issues}).` : 'The planner could not use this request. Try again.'
  // A 404 message names the route, which is developer text.
  if (status === 404 && !dev) return 'The planner had a problem. Try again.'
  return data?.message || 'The planner had a problem. Try again.'
}

// A production build with no VITE_API_BASE_URL would send every request to the static host that serves the page, which
// answers with its HTML page. The request is refused with this sentence for the person; the developer text goes to the
// console once, because the check only runs outside development (in development an empty address means the Vite proxy).
const NO_BACKEND = 'The Jio planner is not available right now. Try again later.'
let toldDeveloper = false

// How to call: refuseWithoutBackend() (throws NO_BACKEND)
function refuseWithoutBackend() {
  if (!toldDeveloper) {
    toldDeveloper = true
    console.error('Jio: this build has no VITE_API_BASE_URL, so it has no backend to call. Set it to the backend URL (see frontend/.env.example) and build again.')
  }
  throw Object.assign(new Error(NO_BACKEND), { planner: true })
}

// What an answer that is not JSON says (usually the static host's HTML page, with status 200).
// How to call: notJsonMessage({ dev: false }) -> 'The planner sent an answer Jio could not read. Try again later.'
export function notJsonMessage({ dev = import.meta.env.DEV } = {}) {
  return dev
    ? 'The planner answered with something other than JSON. Check VITE_API_BASE_URL points at the backend, not the page itself.'
    : 'The planner sent an answer Jio could not read. Try again later.'
}

// Several requests that fail together share one refresh while it runs.
let refreshing = null

// Does this request go to the planner itself (a relative path, or an address on the planner's own origin)? Only such a
// request may carry the login token: an absolute address on another site must never get it.
// How to call: goesToPlanner({ baseURL: 'https://jio-api.example.com', url: '/api/converge' }) -> true
export function goesToPlanner(config) {
  const target = String(config?.url || '')
  // Relative paths are joined to the base address by axios. A protocol-relative address ("//host") is absolute.
  if (!/^([a-z][a-z\d+\-.]*:)?\/\//i.test(target)) return true
  const page = typeof location !== 'undefined' ? location.origin : 'http://localhost'
  try {
    const own = new URL(config.baseURL || page, page).origin
    return new URL(target, own).origin === own
  } catch {
    return false
  }
}

// Sign the person out after the planner refused their login, without letting a failure to do so escape: the error the
// caller sees is the "session has ended" sentence.
// How to call: await endSession()
async function endSession() {
  try {
    await auth.signOut()
  } catch {
    // The caller is told the session has ended whatever happened.
  }
}

// A token to retry a request with after the login check refused `sentToken`. If the session already holds a different
// token (another request's refresh finished since), that one is used and nothing is refreshed. Otherwise the session is
// refreshed (once for requests that fail together). Resolves null, after ending the session, when the refresh is refused.
// Rejects with the "try again" error when the refresh failed for a reason that may pass (no connection, a server error):
// the session is left as it is and the person stays signed in.
// How to call: const token = await renewedToken('token-1')
async function renewedToken(sentToken) {
  const current = await auth.accessToken()
  if (current && current !== sentToken) return current
  if (!refreshing) {
    refreshing = (async () => {
      const token = await auth.refreshedToken()
      if (!token) await endSession()
      return token
    })().finally(() => {
      refreshing = null
    })
  }
  return refreshing
}

// Before each request: stop when a production build has no backend to call, then attach the token read right now (to the
// planner only). A retry (see below) already holds its new token and keeps it.
api.interceptors.request.use(async (config) => {
  const absolute = /^https?:\/\//i.test(config.url || '')
  if (!config.baseURL && !absolute && !import.meta.env.DEV) {
    refuseWithoutBackend()
  }
  if (!config.jioRetried && goesToPlanner(config)) {
    const token = await auth.accessToken()
    if (token) config.headers.set('Authorization', `Bearer ${token}`)
  }
  return config
})

// A 401 from the login check on a request that carried a token: send it again once with the session's current token,
// refreshing first only if the request failed with the current one. A refresh that is refused, or a second 401, ends the
// Supabase session (lib/auth.js signOut, so api.js's listener signs the app out and the screens show the login). A
// refresh that failed for a reason that may pass (no connection, a server error) fails this request with a "try again"
// sentence and leaves the person signed in. It is called here, not api.js's signOut, because api.js imports this file.
api.interceptors.response.use(
  (res) => {
    // A string or nothing is not the planner (the static host's page, say). Reading it as "no places" would be wrong.
    if (res.data === null || typeof res.data !== 'object') throw new Error(notJsonMessage())
    return res
  },
  async (err) => {
    if (err?.planner) throw err
    const loginCheck = err?.response?.status === 401 && err.response.data?.error === 'unauthenticated'
    // A request with no token (a local account) is not retried and signs nobody out.
    if (loginCheck && err.config?.headers?.has?.('Authorization')) {
      if (!err.config.jioRetried) {
        const sent = String(err.config.headers.get('Authorization') || '').replace(/^Bearer /, '')
        let token
        try {
          token = await renewedToken(sent)
        } catch {
          throw new Error(AUTH_UNAVAILABLE)
        }
        if (token) {
          err.config.jioRetried = true
          err.config.headers.set('Authorization', `Bearer ${token}`)
          return api.request(err.config)
        }
      } else {
        await endSession()
      }
      throw new Error(SESSION_ENDED)
    }
    throw new Error(plannerErrorMessage(err))
  },
)

// The weather the planner used for the last ranking: { source: 'live' | 'simulated' | 'unavailable', simulationIgnored? }.
// The demo panel reads it to say when the server ignored the rain switch. Null until a ranking has come back.
export const lastWeather = ref(null)

// The backend has no occasion picker yet, so every session is a catch-up.
export const DEFAULT_OCCASION = 'catch_up'

// The places the frontend has no diet data for would all be hidden by 'strict', so suggestions are 'lenient'
// and each option says which diet needs are unknown (dietUnknown).
const UNKNOWN_POLICY = 'lenient'

// The backend's "does not fit" words, in the words the search sheet already knows.
const UNFIT_WORDS = { meal_period: 'meal', near_mrt: 'mrt' }

const point = ({ lat, lng }) => ({ lat, lng })

// A backend venue with the field names the cards read (price, indoor, mrtWalk, rating out of 10...).
// The backend's own fields stay on it too.
export function toCardVenue(v) {
  return {
    ...v,
    price: v.avgPricePerPerson,
    indoor: v.setting === 'indoor',
    mrt: v.nearestMrt,
    mrtWalk: v.mrtWalkMinutes,
    rating: v.rating == null ? null : v.rating * 2,
    hours: (v.openingHours || []).map(([open, close]) => `${open}-${close}`),
    serves: v.mealPeriods || [],
    tags: [...new Set([...(v.tags || []), ...(v.cdcAccepted ? ['cdc'] : [])])],
  }
}

// One ranked backend result as an option. `score` is a penalty: lower is better, and `rank` 1 is the best.
// `block` is the answer's `weather` block; with the result's own `weather` it becomes the option's `weather` (lib/weatherText.js),
// which is left out when the planner sent none.
function toOption(r, block = null) {
  const weather = weatherFrom(r.weather, block)
  return {
    venue: toCardVenue(r.venue),
    rank: r.rank,
    score: r.score,
    walk: r.walkMinutes,
    reasons: r.reasons,
    warnings: r.warnings,
    swap: r.swap ? { id: r.swap.venueId, name: r.swap.name } : null,
    explanation: r.explanation,
    verify: r.verify,
    dietUnknown: r.dietUnknown,
    approximate: r.approximate,
    ...(weather ? { weather } : {}),
  }
}

// Where the group should meet.
//   members: [{ id, name, start: { lat, lng }, end: { lat, lng } }]
//   routing: false is the demo's "routing off" switch: the geographic centre, named after the nearest area.
//   alternatives: how many runners-up to ask for besides the chosen area (0 to 3). The app's three spots are alternatives: 2.
//   include:      area ids to work out whatever their rank (up to 8), such as the spots members suggested.
// Both are optional. Left out, the request is exactly what it always was and the answer has no `candidates`.
// Returns the backend's answer: { area: { id, name, lat, lng }, centre, travelByMember, worstMinutes, method, approximate, travel }.
// With alternatives or include it also has candidates, the chosen area first:
// [{ area, worstMinutes, meanMinutes, travelByMember, approximate, source: 'ranked' | 'included' }].
// `approximate` is false when routing is off, although every time is then an estimate: travel.source is 'estimate' then
// (and 'onemap' when at least one trip got a real time). Say "about" for either.
// How to call: await meetingArea({ members, routing: true, alternatives: 2, include: ['bugis'] })
export async function meetingArea({ members, routing = true, alternatives, include }) {
  const body = { members, method: routing ? 'station' : 'centroid' }
  if (alternatives !== undefined) body.alternatives = alternatives
  if (include?.length) body.include = include
  const { data } = await api.post('/api/meeting-area', body)
  return data
}

// Rank places for one slot around the meeting area.
//   slot: { start (minutes after midnight), time ("HH:MM"), duration, category }
//   currentOptionIds: the options the group is voting on. They are always scored, and come back in `current`
//                     for as long as they still fit.
//   radiusMeters:     the radius the group chose (100 to 3000), or undefined to let the planner widen on its own.
// Returns { options (best first), current (the current options that still fit), widened, few, empty, weather }.
// weather: what the planner used, { source: 'live' | 'simulated' | 'unavailable', simulationIgnored? }.
// The weather case is only sent while the demo rain switch is on; otherwise the planner uses the live forecast.
// few: { found, widenToKm } when fewer than 3 places fit inside the search radius.
export async function rankSlot({ members, centre, date, slot, lastStop, currentOptionIds = [], conditions = {}, radiusMeters, topN }) {
  const { data } = await api.post('/api/converge', {
    members,
    occasion: DEFAULT_OCCASION,
    dateTime: `${date}T${slot.time}`,
    durationMinutes: slot.duration,
    categories: [slot.category],
    centre: point(centre),
    lastStop,
    currentOptionIds,
    ...(conditions.rain ? { weatherCase: 'rain' } : {}),
    unknownPolicy: UNKNOWN_POLICY,
    radiusMeters,
    topN,
  })
  const weather = data.weather ?? null
  lastWeather.value = weather
  if (data.status !== 'ok') return { options: [], current: [], widened: false, few: null, empty: data, weather }
  const few = data.notice?.type === 'few_options' ? { found: data.notice.found, widenToKm: data.notice.widenToKm } : null
  const option = (r) => toOption(r, weather)
  return { options: data.results.map(option), current: data.current.map(option), widened: !!data.notice, few, empty: null, weather }
}

// How long a Roam list is waited for. The planner routes each place from the current point, so a slow answer is given up
// on sooner than a ranking: the person is standing somewhere, waiting.
export const ROAM_TIMEOUT_MS = 10000

// One Roam result as a card: the voting page's card (toOption) with the planner's time and distance from the current point.
// `distanceM` is the straight-line distance in metres, since the cards say "250 m" and "1.2 km".
function toRoamPlace(r, block = null) {
  return {
    ...toOption(r, block),
    id: r.venueId,
    travelMinutes: r.travelMinutes,
    distanceKm: r.distanceKm,
    distanceM: Number.isFinite(r.distanceKm) ? Math.round(r.distanceKm * 1000) : null,
  }
}

// "What next?": the places near one point, best first. The point is used for this request only; nothing here keeps it,
// and the answer does not repeat it.
//   members:   [{ id, name }] the people in the meetup (the planner needs only an id)
//   current:   { lat, lng } where the group is
//   date, time: when the stop would start, "YYYY-MM-DD" and "HH:MM"; minutes: how long it would last
//   categories: any of eat, drink, shop, activity. Left out, the planner uses eat, drink and activity.
// Returns { places (best first, each as a voting-page card plus id, travelMinutes, distanceKm, distanceM), empty (the
// planner's answer when nothing fits, else null), widened, weather }.
// How to call: await roamNearby({ members: [{ id: 'ian' }], current: { lat: 1.35, lng: 103.85 }, date: '2026-10-11', time: '15:00', minutes: 60 })
export async function roamNearby({ members, current, date, time, minutes, categories, conditions = {}, topN }) {
  const { data } = await api.post(
    '/api/roam',
    {
      members,
      occasion: DEFAULT_OCCASION,
      dateTime: `${date}T${time}`,
      durationMinutes: minutes,
      ...(categories?.length ? { categories } : {}),
      current: point(current),
      ...(conditions.rain ? { weatherCase: 'rain' } : {}),
      unknownPolicy: UNKNOWN_POLICY,
      topN,
    },
    { timeout: ROAM_TIMEOUT_MS },
  )
  const weather = data.weather ?? null
  lastWeather.value = weather
  if (data.status !== 'ok') return { places: [], empty: data, widened: false, weather }
  if (!Array.isArray(data.results)) throw new Error(notJsonMessage())
  return { places: data.results.map((r) => toRoamPlace(r, weather)), empty: null, widened: !!data.notice, weather }
}

// The weather at each stop of a plan, from the planner (POST /api/weather/stops): the itinerary asks when it opens on its day and
// every 30 minutes after. It ranks nothing and suggests no swap.
//   stops: [{ id, point: { lat, lng }, start: 'YYYY-MM-DDTHH:MM' (Singapore time), setting?, exposure? }], at most 8
//   conditions: the demo switches; with `rain` on the planner is asked for a simulated rain (it may ignore that: see `weather`)
// Resolves { stops: { [id]: weather object (lib/weatherText.js) }, weather: the answer's block } and records the block in
// `lastWeather`. Rejects in the client's usual way when the planner cannot answer.
// How to call: await stopsWeather({ stops: [{ id: 'eat', point: { lat: 1.35, lng: 103.85 }, start: '2026-10-11T15:00' }] })
export async function stopsWeather({ stops, conditions = {} }) {
  const { data } = await api.post('/api/weather/stops', { stops, ...(conditions.rain ? { weatherCase: 'rain' } : {}) })
  if (!Array.isArray(data.stops)) throw new Error(notJsonMessage())
  const block = data.weather ?? null
  lastWeather.value = block
  const found = {}
  for (const s of data.stops) if (typeof s?.id === 'string') found[s.id] = weatherFrom(s, block)
  return { stops: found, weather: block }
}

// How long the order is waited for: the host can confirm the voted order, so a slow answer is given up on.
export const ARRANGE_TIMEOUT_MS = 10000

// The AI order for a plan, chosen by Claude on the backend (asked for when the group confirms). Food stops keep their
// place and time (meals stay at meal times); the drink, shop and activity stops may move. `includeCurrent` lets the
// voted order be chosen when it is already the best.
//   stops:   [{ id, name, category, kind?, lat, lng, duration, start?, hours: ['10:00-22:00'], indoor?, mrtWalk? }] in the voted order
//   startAt, endAt: when the plan starts and the session ends, in minutes after midnight
// Returns { status: 'ok', order: [stop ids], stops: [{ id, start, end }], reason, source: 'ai' | 'rules' }
//      or { status: 'no_other_order', message }.
// How to call: await arrangeItinerary({ stops, startAt: 600, endAt: 1020, includeCurrent: true })
export async function arrangeItinerary({ stops, startAt, endAt, shown = [], rain = false, includeCurrent = false }) {
  const { data } = await api.post('/api/itinerary/arrange', { stops, startAt, endAt, shown, rain, includeCurrent }, { timeout: ARRANGE_TIMEOUT_MS })
  return data
}

// Find places by name for a slot. Each says whether it fits, and the first reason it does not.
export async function searchSlot({ query, members, centre, date, slot, lastStop, maxKm }) {
  const { data } = await api.post('/api/search', {
    query,
    centre: point(centre),
    dateTime: `${date}T${slot.time}`,
    durationMinutes: slot.duration,
    categories: [slot.category],
    lastStop,
    members,
    unknownPolicy: UNKNOWN_POLICY,
    maxKm,
  })
  return data.results.map((r) => {
    const reason = r.unfit[0] || ''
    return { id: r.venueId, name: r.name, area: r.area, category: r.category, walk: r.walkMinutes, unfit: UNFIT_WORDS[reason] || reason }
  })
}

// How long an address search is waited for. Typing makes many of them, so a slow one is given up on sooner than a ranking.
export const PLACE_SEARCH_TIMEOUT_MS = 6000

// Find an address, postal code or building by name with OneMap, through the backend (it needs no account).
// Resolves the backend's results, at most 10: [{ name, address, postal, lat, lng }], possibly none.
// Rejects in the client's usual way (an Error whose message a person can read) when the backend cannot answer, and with
// an AbortError when `signal` aborts first, so the caller can tell a replaced search from a failed one.
// How to call: await searchAddresses('tampines mall', { signal: controller.signal })
export async function searchAddresses(query, { signal } = {}) {
  try {
    const { data } = await api.get('/api/places/search', { params: { q: query }, timeout: PLACE_SEARCH_TIMEOUT_MS, signal })
    if (!Array.isArray(data.results)) throw new Error(notJsonMessage())
    return data.results
  } catch (err) {
    // The response interceptor turns every failure into a plain Error, so a cancelled request is recognised by its signal.
    if (signal?.aborted) throw Object.assign(new Error('The search was cancelled.'), { name: 'AbortError' })
    throw err
  }
}
