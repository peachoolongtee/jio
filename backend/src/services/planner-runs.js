import { meetingArea, meetingAreaPlan } from '../planner/engine.js'
import { currentScenario } from './scenario.js'
import { estimateTravel, ROUTING_DEADLINE_MS, runWithRealTravel } from './travel-times.js'

// How the planner engine is run with real travel times, in one place. The stateless planner routes (routes/plan.js) and the
// session endpoints (services/sessions.js) both go through this, so a session request spends the same OneMap budget as a
// planner request (the per-request cap in travel-times.js, the per-process budget in services/onemap.js) and can never bypass it.
//
// How to call (app.js builds one and hands it to both):
//   const runs = createPlannerRuns({ data, weatherResolver, onemap, routingDeadlineMs })
//   const { result, travel } = await runs.runWithTravel(input, data, runs.meetingAreaWithRouting, runs.meetingAreaTravelFor(input))

// Singapore local time now, as the planner writes it: "2026-10-10T19:00".
//
// How to call:
//   nowInSingapore() // '2026-10-10T19:00'
export const nowInSingapore = () => new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 16)

// With routing on, the "best MRT station" check tries only the 16 areas nearest the fairest point, not all 37:
// 16 never missed the best area in 2,000 random groups (see docs/engine-integration.md), and it cuts the calls.
export const MEETING_CANDIDATES_WITH_ROUTING = 16

// Of those, only the 5 whose estimated result is best get real routes. The others keep the estimate.
export const MEETING_AREAS_ROUTED = 5

// Builds the shared runs for one set of plan data and one OneMap service.
//
// Options:
//   data              - Venues and areas the planner reads, from loadPlanData().
//   weatherResolver   - From createWeatherResolver(); decides which forecast a request is scored against.
//   onemap            - From createOneMap(), or null: then every time is the engine's estimate.
//   routingDeadlineMs - The most time one request waits for OneMap routes in total.
//
// What you get back:
//   depsFor()                       Engine deps for a request that makes no OneMap call (the stub scenario can fail routing).
//   resolveWeather(input)           The weather a request is scored against; never throws because the forecast is down.
//   runWithTravel(input, planData, run, options)
//                                   Runs the engine with real travel times when routing is on, the estimate otherwise.
//                                   `options` (or a function of the request) go to runWithRealTravel: { maxCandidates,
//                                   rankByEstimate, namedAreas, maxTrips, deadlineMs }. `maxTrips` and `deadlineMs` let a
//                                   caller that makes several runs for one request share one allowance between them.
//   withRoutingCandidates(input)    The meeting-area input with the 16-area shortlist when routing is on.
//   meetingAreaWithRouting          The engine's meetingArea() with that shortlist, shaped for runWithTravel.
//   meetingAreaTravelFor(input)     The travel options of a meeting-area request (which areas get real routes).
export function createPlannerRuns({ data, weatherResolver, onemap = null, routingDeadlineMs = ROUTING_DEADLINE_MS }) {
  // Stub mode only (Playwright): the x-jio-scenario header picks whether routing fails. The weather scenario
  // reaches the forecast through the HTTP helper, so it needs nothing here. Outside stub mode currentScenario()
  // is always 'dry', so nothing changes.
  //
  // How to call:
  //   run(input, planData, depsFor())
  const depsFor = () => (currentScenario() === 'routing-fail' ? { travelMinutes: () => null } : {})

  // Works out which weather one request is scored against. Never throws because data.gov.sg is down.
  //
  // How to call:
  //   const resolved = await resolveWeather(input) // { weatherCase, planData, forecast, weather, ... }
  //
  // `resolved` is also what placeVenues(resolved, venues) needs to put a venue added later in the request under the
  // same weather. Its `forecast` is the same shape for the area and the regional forecast, and undefined for a simulated
  // forecast and for "no effect".
  const resolveWeather = (input) => weatherResolver.resolve({ start: input.dateTime, weatherCase: input.weatherCase })

  // Runs the engine with real OneMap travel times when routing is on, and with the estimate otherwise.
  //
  // `options` go to runWithRealTravel: { maxCandidates, rankByEstimate, namedAreas, maxTrips, deadlineMs } for the meeting
  // area's shortlist and for a caller's own allowance. They may be a function of the request, for options that depend on
  // what it asks for.
  //
  // How to call:
  //   const { result, travel } = await runWithTravel(input, planData, converge)
  async function runWithTravel(input, planData, run, options = {}) {
    if (!onemap?.routingEnabled) {
      return { result: run(input, planData, depsFor()), travel: estimateTravel() }
    }
    const given = typeof options === 'function' ? options(input) : options
    return runWithRealTravel({
      ...given,
      onemap,
      deadlineMs: given.deadlineMs ?? routingDeadlineMs,
      dateTime: input.dateTime ?? nowInSingapore(),
      run: (deps) => run(input, planData, deps),
    })
  }

  // With routing on, the meeting area tries 16 candidate areas unless the request says otherwise. A method other
  // than station tries them only to find runners-up, so only when the request asks for some.
  //
  // How to call:
  //   const effective = withRoutingCandidates(input) // input, or input with maxCandidates: 16
  const withRoutingCandidates = (input) =>
    onemap?.routingEnabled && (input.method === 'station' || input.alternatives > 0) && !input.maxCandidates
      ? { ...input, maxCandidates: MEETING_CANDIDATES_WITH_ROUTING }
      : input
  const meetingAreaWithRouting = (input, planData, deps) => meetingArea(withRoutingCandidates(input), planData, deps)

  // The meeting area tries many areas, so only the best few by estimate get real routes (see travel-times.js).
  // A request that asks for runners-up or names areas also routes the named ones after those, within the same cap.
  //
  // How to call:
  //   runWithRealTravel({ ...meetingAreaTravelFor(input), onemap, dateTime, run })
  const meetingAreaTravel = { rankByEstimate: true, maxCandidates: MEETING_AREAS_ROUTED }
  const meetingAreaTravelFor = (input) => {
    if (input.alternatives === undefined && input.include === undefined) return meetingAreaTravel
    const { outside } = meetingAreaPlan(withRoutingCandidates(input), data)
    return { ...meetingAreaTravel, namedAreas: { notShortlisted: outside, afterShortlist: input.include ?? [] } }
  }

  return { depsFor, resolveWeather, runWithTravel, withRoutingCandidates, meetingAreaWithRouting, meetingAreaTravelFor }
}
