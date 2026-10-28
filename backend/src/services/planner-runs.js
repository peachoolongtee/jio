import { createAreaEstimator } from '../planner/area-times.js'
import { converge, meetingArea, meetingAreaPlan, roam } from '../planner/engine.js'
import { currentScenario } from './scenario.js'
import { estimateTravel, ROUTING_DEADLINE_MS, runOnTableTimes, runWithRealTravel } from './travel-times.js'

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

// With routing on, the "best MRT station" check tries only 16 areas, not all 37. Without the table of times between areas they are
// the 16 nearest the fairest point: those never missed the best area in 2,000 random groups (see docs/engine-integration.md), a
// measurement made without the table. With it they are the 16 with the shortest guessed longest trip, which has not been measured
// the same way. It cuts the calls.
export const MEETING_CANDIDATES_WITH_ROUTING = 16

// Of those, only the 5 whose estimated result is best get real routes. The others keep the estimate. A server may raise it
// (MEETING_FINALISTS, at most 12): more finalists with real times make the choice more accurate and use more OneMap calls, which
// are a shared budget. A request still routes at most MAX_ROUTED_TRIPS_PER_REQUEST trips, whole areas only. The areas a request
// names are routed after the first MEETING_AREAS_ROUTED finalists and before the extra ones, so extra finalists never starve them.
export const MEETING_AREAS_ROUTED = 5
export const MEETING_FINALISTS_MAX = 12

// With the table of times between the areas (table mode, services/travel-times.js) every area is ranked on table times with no call, and
// only the best of them get live routes: this many (a meeting area is routed for these and, when the request asks for runners-up or
// names areas, for those too). MEETING_FINALISTS changes it, up to MEETING_FINALISTS_MAX. Two cost no more waiting than one for a group
// of three or fewer (a round of six trips), and they let a live route overturn the table's pick.
export const MEETING_AREAS_ROUTED_ON_TABLE = 2

// The places of a category (or of Roam) routed live in table mode: the best this many of what the answer returns, then the places the
// group is already voting on that still fit (`current`). The rest of the answer is on table times.
export const PLACES_ROUTED_FIRST = 3

// The candidates a Converge or Roam answer shows first, as table mode takes them: the best PLACES_ROUTED_FIRST results, then the options
// the group already has.
//
// How to call:
//   placesFirst({ results: [{ venueId: 'a' }, { venueId: 'b' }], current: [{ venueId: 'z' }] }) // { ranking: ['a', 'b', 'z'] }
export const placesFirst = (result) => ({
  ranking: [...(result.results ?? []).slice(0, PLACES_ROUTED_FIRST), ...(result.current ?? [])].map((r) => r.venueId),
})

// Builds the shared runs for one set of plan data and one OneMap service.
//
// Options:
//   data              - Venues and areas the planner reads, from loadPlanData().
//   weatherResolver   - From createWeatherResolver(); decides which forecast a request is scored against.
//   onemap            - From createOneMap(), or null: then every time is the engine's estimate.
//   routingDeadlineMs - The most time one request waits for OneMap routes in total.
//   meetingFinalists  - How many areas a meeting-area request routes with real times. Default 5, at most 12 (MEETING_FINALISTS).
//   areaTimes         - A table of real minutes between the areas (scripts/build-area-times.js), or null. With it, the meeting area
//                       ranks and fills in trips with a guess that knows the MRT, not the straight line (planner/area-times.js).
//
// What you get back:
//   depsFor()                       Engine deps for a request that makes no OneMap call (the stub scenario can fail routing).
//   resolveWeather(input)           The weather a request is scored against; never throws because the forecast is down.
//   runWithTravel(input, planData, run, options)
//                                   Runs the engine with real travel times when routing is on, the estimate otherwise (also when the
//                                   request says `travel: 'estimate'`: then no OneMap call is made at all).
//                                   `options` (or a function of the request) go to runWithRealTravel: { maxCandidates,
//                                   rankByEstimate, namedAreas, maxTrips, deadlineMs }. `maxTrips` and `deadlineMs` let a
//                                   caller that makes several runs for one request share one allowance between them.
//   withRoutingCandidates(input)    The meeting-area input with the 16-area shortlist when routing is on.
//   meetingAreaWithRouting          The engine's meetingArea() with that shortlist, shaped for runWithTravel.
//   meetingAreaTravelFor(input)     The travel options of a meeting-area request (which areas get real routes).
export function createPlannerRuns({
  data,
  weatherResolver,
  onemap = null,
  routingDeadlineMs = ROUTING_DEADLINE_MS,
  areaTimes = null,
  meetingFinalists = undefined,
}) {
  // The guess for trips that get no real route, and for ranking the areas. Null: the straight line, as it always was.
  const estimate = areaTimes ? createAreaEstimator({ areas: data.areas, table: areaTimes }) : null
  // The table trip time (planner/area-times.js), which puts the server in table mode: null without the table.
  const table = estimate ? estimate.tableMinutes : null
  const finalists = meetingFinalists ?? (table ? MEETING_AREAS_ROUTED_ON_TABLE : MEETING_AREAS_ROUTED)
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
    // A request that says `travel: 'estimate'` never routes, whatever the server can do: the same run as a server with no OneMap. With the
    // table of times between the areas that run is on table times (real transit minutes, free); without it, on the straight line.
    if (!onemap?.routingEnabled || input.travel === 'estimate') {
      if (table) return runOnTableTimes({ run: (deps) => run(input, planData, { ...depsFor(), ...deps }), table, estimate })
      return { result: run(input, planData, { ...depsFor(), ...(estimate && { estimateMinutes: estimate }) }), travel: estimateTravel() }
    }
    const given = typeof options === 'function' ? options(input) : options
    return runWithRealTravel({
      ...given,
      onemap,
      deadlineMs: given.deadlineMs ?? routingDeadlineMs,
      ...(estimate && { estimate }),
      ...(table && { table, routeFirst: given.routeFirst ?? routeFirstFor.get(run) }),
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
    onemap?.routingEnabled && input.travel !== 'estimate' && (input.method === 'station' || input.alternatives > 0) && !input.maxCandidates
      ? { ...input, maxCandidates: MEETING_CANDIDATES_WITH_ROUTING }
      : input
  const meetingAreaWithRouting = (input, planData, deps) => meetingArea(withRoutingCandidates(input), planData, deps)

  // Which results a run shows first, for table mode: the best places for Converge and Roam. The meeting area names its own
  // (meetingAreaTravelFor). A run not listed here (pricing one area, the trips home) has one candidate, which is shown.
  const routeFirstFor = new Map([[converge, placesFirst], [roam, placesFirst]])

  // The areas a meeting-area answer routes first, as table mode takes them: the best `finalists` of the ranking as it stands (the
  // chosen area first), and apart from those the areas the request named, which are measured for their own entry only. The runners-up
  // the request asked for are shown on table times unless they are among the best `finalists`: they are not what the answer commits to.
  // For a method other than station the meeting point is always routed first, so nothing comes from the ranking.
  //
  // How to call:
  //   areasFirst({ method: 'station', area: { id: 'bugis' }, diagnostics: { rankedAreaIds: ['bugis', 'city-hall', 'bishan'] }, candidates: [...] }) // { ranking: ['bugis', 'city-hall'], named: [] }
  const areasFirst = (result) => ({
    ranking: result.method === 'station' ? (result.diagnostics?.rankedAreaIds ?? [result.area.id]).slice(0, finalists) : [],
    named: (result.candidates ?? []).filter((c) => c.source === 'included').map((c) => c.area.id),
  })

  // The meeting area tries many areas, so only the best few by estimate get real routes (see travel-times.js).
  // A request that asks for runners-up or names areas also routes the named ones after those, within the same cap.
  //
  // How to call:
  //   runWithRealTravel({ ...meetingAreaTravelFor(input), onemap, dateTime, run })
  const meetingAreaTravel = { rankByEstimate: true, maxCandidates: Math.min(MEETING_FINALISTS_MAX, Math.max(1, finalists)), ...(table && { routeFirst: areasFirst }) }
  const meetingAreaTravelFor = (input) => {
    if (input.alternatives === undefined && input.include === undefined) return meetingAreaTravel
    const { outside } = meetingAreaPlan(withRoutingCandidates(input), data, estimate)
    return { ...meetingAreaTravel, namedAreas: { notShortlisted: outside, afterShortlist: input.include ?? [], protectedShortlist: MEETING_AREAS_ROUTED } }
  }

  return { depsFor, resolveWeather, runWithTravel, withRoutingCandidates, meetingAreaWithRouting, meetingAreaTravelFor }
}
