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
import axios from 'axios'
import { AREAS } from '@/lib/mock/places.js'
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

const ANSWERS = { '/api/meeting-area': standInMeetingArea, '/api/converge': standInConverge }

// Did the planner not answer at all? No response (nothing listening, a timeout), or an error that is not the backend's own
// ({ error: '<code>' }): the Vite dev server answers 500 with an empty body for a backend that is not there. Anything the
// backend said itself, such as a 400 for a bad request or a 429, is a real answer and passes through.
// How to call: notAnswered(err) -> true
export function notAnswered(err) {
  if (!err?.response) return true
  const { status, data } = err.response
  return status >= 500 && !(data && typeof data === 'object' && data.error)
}

// Let the stand-in answer the two planner requests whenever the backend does not. The real backend is always tried
// first. Replaces the client's adapter until restore() is called.
// How to call: const offline = useOfflinePlanner(api); try { ... } finally { offline.restore() }
export function useOfflinePlanner(client) {
  const previous = client.defaults.adapter
  const real = axios.getAdapter(previous)
  const used = { backend: 0, standIn: 0 }
  client.defaults.adapter = async (config) => {
    const answer = ANSWERS[config.url]
    if (!answer) return real(config)
    try {
      const response = await real(config)
      used.backend += 1
      return response
    } catch (err) {
      if (!notAnswered(err)) throw err
      used.standIn += 1
      const body = typeof config.data === 'string' ? JSON.parse(config.data) : config.data
      return { data: answer(body), status: 200, statusText: 'OK', headers: {}, config, request: null }
    }
  }
  return {
    used,
    // Which kind answered: 'backend', 'stand-in' or 'both' (the backend went away part way), '' if nothing was asked.
    get source() {
      return used.backend && used.standIn ? 'both' : used.backend ? 'backend' : used.standIn ? 'stand-in' : ''
    },
    restore() {
      client.defaults.adapter = previous
    },
  }
}
