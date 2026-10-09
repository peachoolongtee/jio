import pLimit from 'p-limit'
import { mockTravelMinutes } from '../planner/geo.js'
import { ExternalApiError } from './http.js'

// Runs the planner engine with real OneMap travel times.
//
// The engine is synchronous on purpose (pure functions, deterministic tests), but OneMap answers over the
// network. So the engine runs twice:
//   1. A dry run with the engine's own estimate, which only records every trip the engine asks about.
//      The shortlist is chosen by straight-line distance, so the same trips are asked about in both runs.
//   2. Those trips are fetched from OneMap, at most 6 at a time, through the cache in services/onemap.js.
//   3. The real run reads the fetched minutes. A trip OneMap could not answer gets null, and the engine then
//      uses its estimate and marks that result `approximate`, as it already does.
//
// A trip and its reverse share one route ("the way back takes as long as the way there"). Most members end
// where they started, so this halves the calls. It is an approximation, and the docs say so.

// Rounds to about 110 m, the same rounding as the OneMap cache, so near-identical points share one fetch.
const round3 = (x) => Math.round(x * 1000) / 1000
const pointKey = (p) => `${round3(p.lat)},${round3(p.lng)}`
const tripKey = (a, b) => [pointKey(a), pointKey(b)].sort().join('|')

// Runs `run(deps)` with real travel times when OneMap routing is on, and once with the estimate when it is off.
//
// How to call:
//   const { result, travel } = await runWithRealTravel({
//     onemap,
//     dateTime: '2026-10-10T19:00',
//     run: (deps) => converge(input, data, deps),
//   })
//   travel // { source: 'onemap', routed: 18, failed: 0 }
//
// Options:
//   onemap      - The OneMap service, or null. When null or when routing is off, travel stays an estimate.
//   dateTime    - When the trips start, local Singapore time. Public transport depends on the hour.
//   run         - Runs the engine with the deps it is given. Called once or twice; it must not have side effects.
//   concurrency - How many OneMap calls at once. Default 6, to stay under OneMap's rate limit.
export async function runWithRealTravel({ onemap, dateTime, run, concurrency = 6 }) {
  if (!onemap?.routingEnabled) {
    return { result: run({}), travel: { source: 'estimate', routed: 0, failed: 0 } }
  }

  // 1. Which trips does the engine need?
  const trips = new Map()
  run({
    travelMinutes: (a, b) => {
      trips.set(tripKey(a, b), [a, b])
      return mockTravelMinutes(a, b)
    },
  })

  // 2. Fetch them. Only an API failure is tolerated; any other error is a bug and must surface.
  const limit = pLimit(concurrency)
  const minutes = new Map()
  let failed = 0
  await Promise.all(
    [...trips].map(([key, [a, b]]) =>
      limit(async () => {
        try {
          const m = await onemap.routeMinutes(a, b, dateTime)
          if (m === null) failed += 1
          else minutes.set(key, m)
        } catch (err) {
          if (!(err instanceof ExternalApiError)) throw err
          failed += 1
        }
      }),
    ),
  )

  // 3. The real run.
  const result = run({ travelMinutes: (a, b) => minutes.get(tripKey(a, b)) ?? null })
  const routed = trips.size - failed
  return { result, travel: { source: routed > 0 ? 'onemap' : 'estimate', routed, failed } }
}
