// The planner runs on the Jio backend (backend/src/planner). This file is the frontend's side of it:
// it sends the requests and turns the answers into the shapes the screens already read.
// Request and response details: backend/docs/planner-api.md.
//
// Every function takes plain values (members, points, a slot), not a session, so api.js stays the one
// place that knows how a session is stored.
import axios from 'axios'
import { ref } from 'vue'

// Calls to the Jio backend (planner, geocode and weather proxy).
// Attaching the Supabase session token waits on the JWT verification decision.
// In development, leave VITE_API_BASE_URL blank: requests go to /api on the page's own address and the Vite dev
// server forwards them to the backend (see vite.config.js). Deployed, it is the backend's URL.
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || '',
  timeout: 15000,
})

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
  const issues = data?.issues?.map((i) => `${i.path}: ${i.message}`).join('; ')
  if (issues) return dev ? `The planner could not use this request (${issues}).` : 'The planner could not use this request. Try again.'
  // A 404 message names the route, which is developer text.
  if (status === 404 && !dev) return 'The planner had a problem. Try again.'
  return data?.message || 'The planner had a problem. Try again.'
}

api.interceptors.response.use(
  (res) => res,
  (err) => {
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

// The AI order for a plan, chosen by Claude on the backend (asked for when the group confirms). Food stops keep their
// place and time (meals stay at meal times); the drink, shop and activity stops may move. `includeCurrent` lets the
// voted order be chosen when it is already the best.
//   stops:   [{ id, name, category, kind?, lat, lng, duration, start?, hours: ['10:00-22:00'], indoor?, mrtWalk? }] in the voted order
//   startAt, endAt: when the plan starts and the session ends, in minutes after midnight
// Returns { status: 'ok', order: [stop ids], stops: [{ id, start, end }], reason, source: 'ai' | 'rules' }
//      or { status: 'no_other_order', message }.
// How to call: await arrangeItinerary({ stops, startAt: 600, endAt: 1020, includeCurrent: true })
export async function arrangeItinerary({ stops, startAt, endAt, shown = [], rain = false, includeCurrent = false }) {
  const { data } = await api.post('/api/itinerary/arrange', { stops, startAt, endAt, shown, rain, includeCurrent }, { timeout: 30000 })
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
