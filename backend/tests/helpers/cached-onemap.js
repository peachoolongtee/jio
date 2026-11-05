import { loadAreaTimes } from '../../src/db/area-times.js'
import { loadPlanData } from '../../src/db/venues.js'
import { createAreaEstimator } from '../../src/planner/area-times.js'
import { haversineKm } from '../../src/planner/geo.js'

// A OneMap stand-in for the tests of table mode, with what the real service has that the simple doubles lack: `peekRoute` (so a trip can
// be free), a route cache that `cache: false` leaves alone, a walk under 400 m, and a latency. It answers from a function of the trip and
// records every call, so a test can say which trips were asked for. Nothing touches the network.
//
// Options:
//   minutes    - (a, b) => minutes. Default: the planner's own table time plus a stable wobble of -2 to +3 minutes per trip, so a routed time
//                is close to the table's without being the same.
//   latencyMs  - How long a call takes (real time). Default 3.
//   cached     - Trips to start with in the cache: [[a, b, minutes]].
//   areas      - The areas the default times are read on. Default: the planner's current areas.
//
// What you get: the OneMap service's routingEnabled, routeMinutes, peekRoute and reportFallback, and
//   calls      [{ a, b, cache }] every routeMinutes call
//   cache      the Map of kept routes (point pair -> minutes)
//   ends()     the set of ids at the far end of the calls (a venue or an area has an id, a person's point has none)
//
// How to call:
//   const onemap = cachedOneMap({ latencyMs: 5 })
//   createApp({ ..., onemap, areaTimes: loadAreaTimes() })
const round3 = (x) => Math.round(x * 1000) / 1000
const keyOf = (a, b) => [a, b].map((p) => `${round3(p.lat)},${round3(p.lng)}`).sort().join('|')
const hash = (text) => {
  let h = 2166136261
  for (const c of text) {
    h ^= c.charCodeAt(0)
    h = Math.imul(h, 16777619)
  }
  return (h >>> 0) / 4294967296
}

export function cachedOneMap({ minutes = null, latencyMs = 3, cached = [], areas = loadPlanData().areas } = {}) {
  const estimator = createAreaEstimator({ areas, table: loadAreaTimes() })
  const answer = minutes ?? ((a, b) => Math.max(3, estimator(a, b) - 2 + 5 * hash(keyOf(a, b))))
  const cache = new Map(cached.map(([a, b, m]) => [keyOf(a, b), m]))
  const calls = []
  return {
    routingEnabled: true,
    calls,
    cache,
    reportFallback: () => {},
    ends: () => new Set(calls.map(({ a, b }) => a.id ?? b.id)),
    peekRoute: (a, b) => {
      if (haversineKm(a, b) < 0.4) return { kind: 'walk', minutes: Math.round(haversineKm(a, b) * 12 * 10) / 10 }
      return cache.has(keyOf(a, b)) ? { kind: 'cached', minutes: cache.get(keyOf(a, b)) } : { kind: 'call' }
    },
    routeMinutes: async (a, b, _dateTime, { cache: keep = true } = {}) => {
      calls.push({ a, b, cache: keep })
      await new Promise((resolve) => setTimeout(resolve, latencyMs))
      const m = answer(a, b)
      if (keep) cache.set(keyOf(a, b), m)
      return m
    },
  }
}
