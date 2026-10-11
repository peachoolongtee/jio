// The planner runs on the Jio backend (backend/src/planner). This file is the frontend's side of it:
// it sends the requests and turns the answers into the shapes the screens already read.
// Request and response details: backend/docs/planner-api.md.
//
// Every function takes plain values (members, points, a slot), not a session, so api.js stays the one
// place that knows how a session is stored.
import axios from 'axios'
import { ref } from 'vue'
import * as auth from './auth.js'

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
function toOption(r) {
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
  }
}

// Where the group should meet.
//   members: [{ id, name, start: { lat, lng }, end: { lat, lng } }]
//   routing: false is the demo's "routing off" switch: the geographic centre, named after the nearest area.
// Returns the backend's answer: { area: { id, name, lat, lng }, centre, travelByMember, worstMinutes, method, approximate }.
export async function meetingArea({ members, routing = true }) {
  const { data } = await api.post('/api/meeting-area', { members, method: routing ? 'station' : 'centroid' })
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
  return { options: data.results.map(toOption), current: data.current.map(toOption), widened: !!data.notice, few, empty: null, weather }
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
