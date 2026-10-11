// A stand-in for the planner backend, for the demo tools only (development builds). The app has no planner of its own:
// the meeting area and every ranking come from the Jio backend (lib/plannerApi.js). With the backend off, a session
// cannot get past "Waiting for others", so the showcase (showcase.js) lets this file answer in the backend's place.
//
// It answers only the two requests the showcase needs, in the shape the backend answers them, so plannerApi.js and
// api.js read the answer as they read the real one:
//   POST /api/meeting-area  the area (of the app's own list) that keeps the longest straight-line trip shortest, and when
//                           asked with `alternatives` or `include`, the runners-up and named areas as `candidates`, so the
//                           meeting spots (a list of areas members vote on) can be priced
//   POST /api/converge      the venues of one category nearest the meeting area that are open for the slot
// The numbers are rough (distance, not transport) and every answer says `approximate` and `travel.source: 'estimate'`, so
// the screens say "about". It never runs unless the real backend did not answer, and the real backend's answers are never changed.
//   const offline = useOfflinePlanner(api)   // api: the axios client of plannerApi.js
//   ...run the showcase...
//   offline.restore()                        // and offline.used says how many answers it gave
//
// The demo tour (tour/) keeps it on while the tour is on and asks for all five requests the screens make, not only these two:
//   useOfflinePlanner(api, { everything: true, giveUpMs: 8000, coolDownMs: 45000 })
// `everything` adds /api/search, /api/itinerary/arrange and /api/places/search. `giveUpMs` stops waiting for a backend that
// is asleep (a host that is waking up takes much longer than a person waits) and `coolDownMs` then skips the backend for a
// while, so the next screens do not each wait again. `backend: false` is for a build that has no backend address at all.
import axios from 'axios'
import { ADDRESSES, AREAS } from '@/lib/mock/places.js'
import { VENUES } from '@/lib/mock/venues.js'
import { distanceKm, toMinutes } from '@/lib/planner/index.js'

// Door to door, in minutes: a short wait, then about 21 km/h across the island by train and walking.
// How to call: tripMinutes(5.2) -> 19
export const tripMinutes = (km) => Math.round(8 + km * 2.8)

// A venue as the backend sends it, which toCardVenue in plannerApi.js turns into the shape the cards read. The ids are
// the backend's own (it is built from the same list), so a showcase made offline still reads when the backend is on.
// How to call: asBackendVenue(VENUES[0])
export function asBackendVenue(v) {
  return {
    ...v,
    avgPricePerPerson: v.price,
    setting: v.indoor ? 'indoor' : 'outdoor',
    nearestMrt: v.mrt,
    mrtWalkMinutes: v.mrtWalk,
    rating: v.rating == null ? null : v.rating / 2,
    openingHours: (v.hours || []).map((range) => range.split('-')),
    mealPeriods: v.serves || [],
    cdcAccepted: (v.tags || []).includes('cdc'),
    tags: v.tags || [],
  }
}

// Is a place open from `start` for `minutes`? hours: ['11:00-00:00'], where a close at or before the open runs past midnight.
// How to call: isOpenFor(['08:00-17:00'], 12 * 60, 90) -> true
export function isOpenFor(hours, start, minutes) {
  if (!hours?.length) return true
  return hours.some((range) => {
    const [open, close] = range.split('-').map((t) => (t === '24:00' ? 1440 : toMinutes(t)))
    const end = close <= open ? close + 1440 : close
    return open <= start && start + minutes <= end
  })
}

// One area priced for the group, as the backend's `candidates` entries are: each member's trip in minutes, the longest and
// the average. It is always approximate, because every time here is straight-line distance.
// How to call: pricedArea(AREAS[0], members, 'ranked') -> { area, worstMinutes, meanMinutes, travelByMember, approximate: true, source: 'ranked' }
function pricedArea(area, members, source) {
  const travelByMember = Object.fromEntries(members.map((m) => [m.id, tripMinutes(distanceKm(m.start, area))]))
  const minutes = Object.values(travelByMember)
  return {
    area: { id: area.id, name: area.name, lat: area.lat, lng: area.lng },
    worstMinutes: Math.max(...minutes),
    meanMinutes: Math.round((minutes.reduce((sum, n) => sum + n, 0) / minutes.length) * 10) / 10,
    travelByMember,
    approximate: true,
    source,
  }
}

// The area that keeps the farthest member's straight-line trip shortest (the first of any tie, in the app's order). With
// `centroid` it is the area nearest the geographic centre of the starts instead, as the backend does with routing off.
// Asked with `alternatives` or `include`, as the backend is, the answer also carries `candidates`: the chosen area, then the
// `alternatives` next-best areas by the same rule (the first of a tie, in the app's order), then each area in `include` that is
// not already there, with source 'included'. Whatever the method, the runners-up are the shortest-longest-trip areas. An id
// the app does not know is skipped. The times are the planner's estimate, and `travel.source` says so, so the screens say "about".
// How to call: standInMeetingArea({ members: [{ id: 'ian', start: { lat: 1.35, lng: 103.85 } }, ...], method: 'station', alternatives: 2, include: ['bugis'] })
export function standInMeetingArea({ members, method = 'station', alternatives, include }) {
  const starts = members.map((m) => m.start)
  const centre = { lat: starts.reduce((s, p) => s + p.lat, 0) / starts.length, lng: starts.reduce((s, p) => s + p.lng, 0) / starts.length }
  const worst = (area) => Math.max(...starts.map((p) => distanceKm(p, area)))
  const score = method === 'centroid' ? (area) => distanceKm(centre, area) : worst
  let best = AREAS[0]
  for (const area of AREAS) if (score(area) < score(best)) best = area
  const chosen = pricedArea(best, members, 'ranked')
  const answer = {
    area: chosen.area,
    centre,
    travelByMember: chosen.travelByMember,
    worstMinutes: chosen.worstMinutes,
    meanMinutes: chosen.meanMinutes,
    method,
    approximate: true,
    travel: { source: 'estimate' },
  }
  if (alternatives === undefined && include === undefined) return answer
  // Array.sort keeps the app's order among equal scores.
  const runnersUp = AREAS.filter((area) => area.id !== best.id).sort((a, b) => worst(a) - worst(b)).slice(0, Math.max(0, alternatives ?? 0))
  const candidates = [chosen, ...runnersUp.map((area) => pricedArea(area, members, 'ranked'))]
  for (const id of include || []) {
    const area = AREAS.find((a) => a.id === id)
    if (area && !candidates.some((c) => c.area.id === id)) candidates.push(pricedArea(area, members, 'included'))
  }
  return { ...answer, candidates }
}

// Venues of the slot's category around the centre that are open for it, nearest first, as /api/converge answers. If none
// is open the nearest of the category are offered anyway, so a slot is never empty. `current` holds the options the
// group already has that are in the list.
// How to call: standInConverge({ categories: ['eat'], centre, dateTime: '2026-10-17T12:00', durationMinutes: 90, currentOptionIds: [], topN: 10 })
export function standInConverge({ categories = ['eat'], centre, dateTime, durationMinutes = 60, currentOptionIds = [], topN = 5, radiusMeters }) {
  const start = toMinutes(String(dateTime).slice(11, 16))
  const ofKind = VENUES.filter((v) => categories.includes(v.category))
  const km = (v) => distanceKm(centre, v)
  const inRadius = radiusMeters ? ofKind.filter((v) => km(v) * 1000 <= radiusMeters) : ofKind
  const open = inRadius.filter((v) => isOpenFor(v.hours, start, durationMinutes))
  const ranked = [...(open.length ? open : inRadius)].sort((a, b) => km(a) - km(b) || a.id.localeCompare(b.id))
  const toResult = (v, i) => ({
    rank: i + 1,
    venueId: v.id,
    name: v.name,
    venue: asBackendVenue(v),
    score: Math.round(km(v) * 100) / 100,
    walkMinutes: Math.max(1, Math.round((km(v) * 1000) / 80)),
    reasons: ['Close to the meeting area'],
    warnings: [],
    swap: null,
    explanation: 'Ranked by distance from the meeting area, by the demo tools (the planner is not running).',
    verify: [],
    dietUnknown: [],
    approximate: true,
  })
  const results = ranked.slice(0, topN).map(toResult)
  const current = ranked.map(toResult).filter((r) => currentOptionIds.includes(r.venueId))
  return { status: 'ok', centre, results, current, notice: null }
}

// Places whose name contains the words typed, of the slot's categories, nearest to the centre first, as /api/search answers.
// A place that is not open for the slot is listed but says why it does not fit. At most 8.
// How to call: standInSearch({ query: 'market', categories: ['eat'], centre, dateTime: '2026-10-17T12:00', durationMinutes: 90 })
export function standInSearch({ query = '', categories = ['eat'], centre, dateTime, durationMinutes = 60, maxKm }) {
  const words = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  const start = toMinutes(String(dateTime).slice(11, 16))
  const km = (v) => distanceKm(centre, v)
  const found = VENUES.filter((v) => categories.includes(v.category) && words.every((w) => `${v.name} ${v.area}`.toLowerCase().includes(w)) && (!maxKm || km(v) <= maxKm))
  const fits = (v) => isOpenFor(v.hours, start, durationMinutes)
  const ranked = [...found].sort((a, b) => Number(fits(b)) - Number(fits(a)) || km(a) - km(b) || a.id.localeCompare(b.id))
  const results = ranked.slice(0, 8).map((v) => ({
    venueId: v.id,
    name: v.name,
    area: v.area,
    category: v.category,
    walkMinutes: Math.max(1, Math.round((km(v) * 1000) / 80)),
    distanceKm: Math.round(km(v) * 100) / 100,
    fits: fits(v),
    unfit: fits(v) ? [] : ['meal_period'],
  }))
  return { status: 'ok', results }
}

// An order for the plan's stops: the order they were voted in, timed one after another (a meal never earlier than its time).
// It never invents a different order, so it answers "no other order" when asked for one that is not the current.
// How to call: standInArrange({ stops: [{ id: 'eat', duration: 90, start: 720 }], startAt: 720, endAt: 1080, includeCurrent: true })
export function standInArrange({ stops = [], startAt = 0, includeCurrent = false }) {
  if (!includeCurrent) return { status: 'no_other_order', message: 'The planner is not running, so there is no other order to suggest.' }
  let clock = startAt
  const timed = stops.map((stop) => {
    const start = Math.max(clock, Number.isFinite(stop.start) ? stop.start : clock)
    clock = start + stop.duration
    return { id: stop.id, start, end: clock }
  })
  return { status: 'ok', order: stops.map((stop) => stop.id), stops: timed, reason: 'Kept in the order the group voted. The planner is not running, so no other order was tried.', source: 'rules' }
}

// Addresses and buildings from the app's sample list that match the words typed, as /api/places/search answers. They have a
// postal code and a point inside the area they are in, as the real answer does; the real answer has many more.
// How to call: standInPlaces({ q: 'tampines mall' }) -> { results: [{ name, address, postal, lat, lng }] }
export function standInPlaces({ q = '' } = {}) {
  const text = String(q).trim().toLowerCase()
  const results = ADDRESSES.filter((a) => text && (a.label.toLowerCase().includes(text) || a.postal.startsWith(text)))
    .slice(0, 10)
    .map((a) => {
      const area = AREAS.find((x) => x.id === a.areaId)
      return { name: a.label.split(',')[0].toUpperCase(), address: a.label, postal: a.postal, lat: area.lat, lng: area.lng }
    })
  return { results }
}

// What answers each request. The first two are always stood in for; the rest only when asked for (`everything`).
const ANSWERS = { '/api/meeting-area': standInMeetingArea, '/api/converge': standInConverge }
const MORE_ANSWERS = { '/api/search': standInSearch, '/api/itinerary/arrange': standInArrange, '/api/places/search': standInPlaces }

// Did the planner not answer at all? No response (nothing listening, a timeout), or an error that is not the backend's own
// ({ error: '<code>' }): the Vite dev server answers 500 with an empty body for a backend that is not there. Anything the
// backend said itself, such as a 400 for a bad request or a 429, is a real answer and passes through.
// How to call: notAnswered(err) -> true
export function notAnswered(err) {
  if (!err?.response) return true
  const { status, data } = err.response
  return status >= 500 && !(data && typeof data === 'object' && data.error)
}

// Let the stand-in answer planner requests whenever the backend does not. The real backend is always tried first (except
// with `backend: false`). Replaces the client's adapter until restore() is called.
//   everything   also answer /api/search, /api/itinerary/arrange and /api/places/search (default: the two the showcase needs)
//   backend      false: there is no backend to ask, so answer at once
//   giveUpMs     stop waiting for the backend after this long (0: wait as long as the client's own timeout)
//   coolDownMs   after the backend gave no answer, do not ask it again for this long
//   onAnswer     (source: 'backend' | 'stand-in') after every request this handles, for a screen to say which answered
//   now          the clock, for a test
// How to call: const offline = useOfflinePlanner(api); try { ... } finally { offline.restore() }
export function useOfflinePlanner(client, { everything = false, backend = true, giveUpMs = 0, coolDownMs = 0, onAnswer = () => {}, now = Date.now } = {}) {
  const previous = client.defaults.adapter
  const real = axios.getAdapter(previous)
  const used = { backend: 0, standIn: 0 }
  const answers = everything ? { ...ANSWERS, ...MORE_ANSWERS } : ANSWERS
  let silentSince = -Infinity
  const standIn = (answer, config) => {
    used.standIn += 1
    onAnswer('stand-in')
    const body = typeof config.data === 'string' && config.data ? JSON.parse(config.data) : config.data
    return { data: answer(config.method === 'get' ? config.params || {} : body || {}), status: 200, statusText: 'OK', headers: {}, config, request: null }
  }
  let active = true
  const mine = async (config) => {
    const answer = answers[config.url]
    if (!active || !answer) return real(config)
    if (!backend || now() - silentSince < coolDownMs) return standIn(answer, config)
    try {
      const response = await real(giveUpMs ? { ...config, timeout: Math.min(config.timeout || giveUpMs, giveUpMs) } : config)
      used.backend += 1
      onAnswer('backend')
      return response
    } catch (err) {
      if (!notAnswered(err)) throw err
      silentSince = now()
      return standIn(answer, config)
    }
  }
  client.defaults.adapter = mine
  return {
    used,
    // Which kind answered: 'backend', 'stand-in' or 'both' (the backend went away part way), '' if nothing was asked.
    get source() {
      return used.backend && used.standIn ? 'both' : used.backend ? 'backend' : used.standIn ? 'stand-in' : ''
    },
    // Put the client back. If something else was put on top of this since (the showcase, while the tour is on), it stays and
    // this one only stops answering, so taking one off never takes the other with it.
    restore() {
      active = false
      if (client.defaults.adapter === mine) client.defaults.adapter = previous
    },
  }
}
