// Table mode: the planner ranks every meeting area and place on the table of real minutes between the areas (no OneMap call), then routes
// live only the results it shows first and runs the engine again with those routes (services/travel-times.js, planner/area-times.js).
// Nothing here touches the network: OneMap is a double that records the trips it was asked for and answers from a function of the trip.
import { once } from 'node:events'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadAreaTimes } from '../src/db/area-times.js'
import { loadPlanData } from '../src/db/venues.js'
import { ACCESS_FIXED_MINUTES, ACCESS_MINUTES_PER_KM, accessMinutes, AT_CENTRE_KM, createAreaEstimator, pairKey } from '../src/planner/area-times.js'
import { converge, meetingArea, roam } from '../src/planner/engine.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { createPlannerRuns, MEETING_AREAS_ROUTED_ON_TABLE, PLACES_ROUTED_FIRST } from '../src/services/planner-runs.js'
import { isAbout, knownPlaceRow, priceAreaRun, spotRowsFrom } from '../src/services/session-plan.js'
import { runWithRealTravel, TABLE_ROUTE_ROUNDS } from '../src/services/travel-times.js'

const data = loadPlanData()
const table = loadAreaTimes()
const estimator = createAreaEstimator({ areas: data.areas, table })
const DATE_TIME = '2026-10-30T12:00'
const round3 = (x) => Math.round(x * 1000) / 1000
const spot = (p) => `${round3(p.lat)},${round3(p.lng)}`

// A OneMap that answers from `minutes(a, b)` and keeps every trip it was asked for. It has no peekRoute, so every trip is a call.
function oneMapDouble(minutes = (a, b) => estimator(a, b)) {
  const asked = []
  return {
    asked,
    routingEnabled: true,
    reportFallback: vi.fn(),
    routeMinutes: async (a, b) => {
      asked.push({ a, b })
      return minutes(a, b)
    },
    // The ids and rounded points at the far end of the trips asked: a venue or an area has an id, a member's point has none.
    ends: () => new Set(asked.map(({ a, b }) => a.id ?? b.id)),
  }
}
const runsWith = (onemap, extra = {}) => createPlannerRuns({ data, weatherResolver: null, onemap, areaTimes: table, ...extra })

// Three people far apart, starting from their own points (not area centres) so the hops count.
const members = [
  { id: 'a', name: 'A', start: { lat: 1.3321, lng: 103.9101 }, end: { lat: 1.3321, lng: 103.9101 } },
  { id: 'b', name: 'B', start: { lat: 1.3012, lng: 103.7733 }, end: { lat: 1.3012, lng: 103.7733 } },
  { id: 'c', name: 'C', start: { lat: 1.4208, lng: 103.8113 }, end: { lat: 1.4208, lng: 103.8113 } },
]
const meetingInput = (extra = {}) => ({ members, method: 'station', dateTime: DATE_TIME, ...extra })
const askMeeting = (runs, input) => runs.runWithTravel(input, data, runs.meetingAreaWithRouting, runs.meetingAreaTravelFor(input))
const convergeInput = (extra = {}) => ({
  members: members.slice(0, 2), occasion: 'catch_up', dateTime: DATE_TIME, durationMinutes: 90, categories: ['eat'], unknownPolicy: 'lenient',
  centre: { lat: 1.3127, lng: 103.8383 }, ...extra,
})
const sum = (t) => t.routed + t.cached + t.walked + t.table + t.failed + t.estimated

describe('the table trip time', () => {
  it('is the table plus a fitted hop, nothing at a centre, and no jump just off one', () => {
    expect(accessMinutes(0)).toBe(0)
    expect(accessMinutes(AT_CENTRE_KM - 0.001)).toBe(0)
    expect(accessMinutes(0.4)).toBeCloseTo(ACCESS_FIXED_MINUTES + ACCESS_MINUTES_PER_KM * 0.4, 9)
    expect(accessMinutes(2)).toBeCloseTo(ACCESS_FIXED_MINUTES + ACCESS_MINUTES_PER_KM * 2, 9)
    expect(accessMinutes(AT_CENTRE_KM)).toBeLessThan(1.2) // the step where the hop starts is about a minute
    let last = 0
    for (let km = 0.05; km < 5; km += 0.05) {
      expect(accessMinutes(km)).toBeGreaterThan(last)
      last = accessMinutes(km)
    }
  })

  it('is null, not the straight line, only where no pair of the table can give a time', () => {
    const bugis = data.areas.find((a) => a.id === 'bugis')
    const bedok = data.areas.find((a) => a.id === 'bedok')
    expect(estimator.tableMinutes(bugis, bedok)).toBe(table.minutes[pairKey('bugis', 'bedok')])
    expect(estimator(bugis, bedok)).toBe(estimator.tableMinutes(bugis, bedok))
    const empty = createAreaEstimator({ areas: data.areas, table: { _meta: { areas: data.areas.map((a) => a.id) }, minutes: {} } })
    expect(empty.tableMinutes(bugis, bedok)).toBeNull()
    expect(empty(bugis, bedok)).toBeGreaterThan(0) // the straight line answers
  })
})

describe('meeting area in table mode', () => {
  it('routes only the best areas, labels each time by where it came from, and counts every trip once', async () => {
    const onemap = oneMapDouble()
    const { result, travel } = await askMeeting(runsWith(onemap), meetingInput({ alternatives: 2 }))
    // The double agrees with the table, so the first two areas of the ranking are all that is routed: MEETING_AREAS_ROUTED_ON_TABLE x 3 people.
    expect(onemap.ends().size).toBe(MEETING_AREAS_ROUTED_ON_TABLE)
    expect(onemap.asked).toHaveLength(MEETING_AREAS_ROUTED_ON_TABLE * members.length)
    expect(travel).toMatchObject({ source: 'onemap', routed: MEETING_AREAS_ROUTED_ON_TABLE * members.length, cached: 0, walked: 0, failed: 0, estimated: 0 })
    expect(travel.table).toBe(travel.asked - travel.routed)
    expect(sum(travel)).toBe(travel.asked)
    // The areas routed are the first two of the ranking, and they are the ones labelled routed.
    expect(result.candidates.filter((c) => c.travelSource === 'routed').map((c) => c.area.id).sort()).toEqual([...onemap.ends()].sort())
    expect(result.travelSource).toBe('routed') // the chosen area
    expect(result.candidates.at(-1).travelSource).toBe('table') // the third was not routed
    // `approximate` is about the straight line alone: a table time is not one.
    expect(result.approximate).toBe(false)
    expect(result.candidates.every((c) => c.approximate === false)).toBe(true)
  })

  it("works with Faith's balanced rule: the area the rule chooses is the one routed first", async () => {
    const onemap = oneMapDouble()
    const runs = runsWith(onemap, { meetingFinalists: 1 })
    const input = meetingInput({ rule: 'balanced', choices: true })
    const { result } = await runs.runWithTravel(input, data, runs.meetingAreaWithRouting, runs.meetingAreaTravelFor(input))
    expect(result.rule).toBe('balanced')
    expect(result.diagnostics.rankedAreaIds[0]).toBe(result.area.id)
    expect(onemap.ends()).toEqual(new Set([result.area.id]))
    expect(result.travelSource).toBe('routed')
  })

  it('asks for no trip of an area it does not show, and only for the chosen one when one is asked for', async () => {
    const onemap = oneMapDouble()
    const { result } = await askMeeting(runsWith(onemap, { meetingFinalists: 1 }), meetingInput())
    expect(onemap.ends()).toEqual(new Set([result.area.id]))
    expect(onemap.asked).toHaveLength(members.length)
  })

  it('lets a live route overturn the table: the chosen area is the best of the routed ones, and a climber is routed in turn', async () => {
    const free = oneMapDouble()
    const first = (await askMeeting(runsWith(free, { meetingFinalists: 1 }), meetingInput())).result.area.id
    // That area takes 40 minutes longer live than the table says.
    const area = data.areas.find((a) => a.id === first)
    const slow = oneMapDouble((a, b) => estimator(a, b) + ((a.id ?? b.id) === first ? 40 : 0))
    const { result, travel } = await askMeeting(runsWith(slow, { meetingFinalists: 1 }), meetingInput())
    expect(area).toBeDefined()
    expect(result.area.id).not.toBe(first)
    expect(result.travelSource).toBe('routed') // the new choice was routed too (the second round)
    expect(slow.ends().has(first)).toBe(true)
    expect(slow.ends().has(result.area.id)).toBe(true)
    expect(travel.routed).toBe(slow.asked.length)
    expect(slow.asked.length).toBeLessThanOrEqual(TABLE_ROUTE_ROUNDS * members.length * 2)
  })

  it('leaves a candidate whole on table times when one of its trips cannot be routed, and counts that trip as failed', async () => {
    const onemap = oneMapDouble()
    const flaky = {
      ...onemap,
      routeMinutes: async (a, b) => {
        if (b.id === undefined && a.id === undefined) return 20
        if (a.lat === members[0].start.lat && a.lng === members[0].start.lng) throw new ExternalApiError('onemap answered 500', { service: 'onemap', status: 500, url: 'x' })
        return onemap.routeMinutes(a, b)
      },
    }
    const { result, travel } = await askMeeting(runsWith(flaky, { meetingFinalists: 1 }), meetingInput())
    expect(travel.failed).toBeGreaterThan(0)
    expect(result.travelSource).toBe('table')
    // Read whole on the table: every member's time is the table's, not a mix.
    const area = data.areas.find((a) => a.id === result.area.id)
    for (const m of members) expect(result.travelByMember[m.id]).toBeCloseTo(estimator(m.start, area), 6)
    expect(result.approximate).toBe(false)
    expect(sum(travel)).toBe(travel.asked)
  })

  it('answers on the table when the deadline passes first, and says so once', async () => {
    const onemap = oneMapDouble()
    const hung = { ...onemap, routeMinutes: () => new Promise(() => {}) }
    const { result, travel } = await askMeeting(runsWith(hung, { routingDeadlineMs: 20 }), meetingInput())
    expect(hung.reportFallback).toHaveBeenCalledTimes(1)
    expect(hung.reportFallback).toHaveBeenCalledWith('deadline')
    expect(result.travelSource).toBe('table')
    expect(travel).toMatchObject({ source: 'table', routed: 0, estimated: 0 })
    expect(travel.table).toBe(travel.asked)
  })

  it('makes no call at all when the deadline has no time', async () => {
    const onemap = oneMapDouble()
    const { travel } = await runsWith(onemap).runWithTravel(meetingInput(), data, runsWith(onemap).meetingAreaWithRouting, { deadlineMs: 0 })
    expect(onemap.asked).toHaveLength(0)
    expect(travel.source).toBe('table')
  })

  it('keeps to the cap of trips for a request, in whole areas', async () => {
    const onemap = oneMapDouble()
    const runs = runsWith(onemap)
    const input = meetingInput()
    const { travel } = await runs.runWithTravel(input, data, runs.meetingAreaWithRouting, { ...runs.meetingAreaTravelFor(input), maxTrips: members.length + 1 })
    expect(onemap.asked).toHaveLength(members.length) // one whole area (3 trips); the next would pass the cap of 4
    expect(travel.routed).toBe(members.length)
  })

  it('does not let a named area change the ranking: the answer is what it is without the name', async () => {
    const bare = oneMapDouble()
    const withName = oneMapDouble()
    const a = await askMeeting(runsWith(bare), meetingInput({ alternatives: 1 }))
    const b = await askMeeting(runsWith(withName), meetingInput({ alternatives: 1, include: ['tuas-link'] }))
    expect(b.result.area.id).toBe(a.result.area.id)
    expect(b.result.travelByMember).toEqual(a.result.travelByMember)
    expect(b.result.candidates.slice(0, 2)).toEqual(a.result.candidates.slice(0, 2))
    const named = b.result.candidates.find((c) => c.area.id === 'tuas-link')
    expect(named).toMatchObject({ source: 'included', travelSource: 'routed' }) // routed for its own entry, after the ranking's
  })

  it('marks the straight line as approximate and nothing else, where the table has no pair', async () => {
    const empty = { ...table, minutes: {} }
    const onemap = oneMapDouble()
    const runs = createPlannerRuns({ data, weatherResolver: null, onemap: { ...onemap, routingEnabled: false }, areaTimes: empty })
    const { result, travel } = await askMeeting(runs, meetingInput({ alternatives: 3 }))
    expect(onemap.asked).toHaveLength(0)
    expect(result.approximate).toBe(true)
    expect(result.travelSource).toBe('estimate')
    expect(result.candidates.every((c) => c.approximate && c.travelSource === 'estimate')).toBe(true)
    // Most trips are the straight line. The few from a point to an area that is one of its own three nearest are only the hop to that
    // station, which needs no pair of the table, and they are the model's, not a guess.
    expect(travel.estimated).toBeGreaterThan(travel.asked / 2)
    expect(travel.estimated + travel.table).toBe(travel.asked)
    // One pair missing is not a straight line for a point off the centre: another pair of the three nearest areas at each end answers. A
    // point on an area's centre has only that area, so the same pair missing leaves nothing but the straight line.
    const sparse = { ...table, minutes: Object.fromEntries(Object.entries(table.minutes).filter(([k]) => k !== pairKey('bugis', 'bedok'))) }
    const bugis = data.areas.find((a) => a.id === 'bugis'), bedok = data.areas.find((a) => a.id === 'bedok')
    const without = createAreaEstimator({ areas: data.areas, table: sparse })
    expect(without.tableMinutes(bugis, bedok)).toBeNull()
    expect(without.tableMinutes({ lat: bugis.lat + 0.003, lng: bugis.lng }, { lat: bedok.lat, lng: bedok.lng + 0.003 })).not.toBeNull()
  })
})

describe('places in table mode', () => {
  it('routes only the places it shows first, then the options the group already has', async () => {
    const onemap = oneMapDouble()
    const runs = runsWith(onemap)
    const { result, travel } = await runs.runWithTravel(convergeInput(), data, converge)
    expect(result.results.length).toBeGreaterThanOrEqual(PLACES_ROUTED_FIRST + 1)
    const shown = new Set(result.results.slice(0, PLACES_ROUTED_FIRST).map((r) => spot(r.venue)))
    // The double agrees with the table, so the order never changed: every trip asked ended at one of the first three places.
    expect(onemap.asked.length).toBeGreaterThan(0)
    for (const { a, b } of onemap.asked) expect(shown.has(spot(a.id ? a : b))).toBe(true)
    expect(onemap.asked.length).toBeLessThanOrEqual(PLACES_ROUTED_FIRST * 2)
    expect(result.results.slice(0, PLACES_ROUTED_FIRST).map((r) => r.travelSource)).toEqual(['routed', 'routed', 'routed'])
    expect(result.results.slice(PLACES_ROUTED_FIRST).every((r) => r.travelSource === 'table')).toBe(true)
    expect(result.results.every((r) => r.approximate === false)).toBe(true)
    expect(travel.table).toBeGreaterThan(0)
    expect(sum(travel)).toBe(travel.asked)

    // The group's own options are shown too: one that is not in the first three is routed when it is among `current`.
    const later = result.results[PLACES_ROUTED_FIRST + 1].venueId
    const again = oneMapDouble()
    const second = await runsWith(again).runWithTravel(convergeInput({ currentOptionIds: [later] }), data, converge)
    expect(second.result.current.map((r) => [r.venueId, r.travelSource])).toEqual([[later, 'routed']])
  })

  it('re-ranks on the routed times and routes the place that climbs into the first three', async () => {
    const free = oneMapDouble()
    const base = (await runsWith(free).runWithTravel(convergeInput(), data, converge)).result.results
    const top = new Set([spot(base[0].venue)])
    // Whatever ends at the best place takes 30 minutes longer than the table says.
    const slow = oneMapDouble((a, b) => estimator(a, b) + (top.has(spot(a.id ? a : b)) ? 30 : 0))
    const { result } = await runsWith(slow).runWithTravel(convergeInput(), data, converge)
    expect(result.results[0].venueId).not.toBe(base[0].venueId)
    expect(result.results.slice(0, PLACES_ROUTED_FIRST).every((r) => r.travelSource === 'routed')).toBe(true)
    const shownEnds = new Set(result.results.slice(0, 5).map((r) => spot(r.venue)))
    for (const { a, b } of slow.asked) expect(shownEnds.has(spot(a.id ? a : b)) || top.has(spot(a.id ? a : b))).toBe(true) // nothing that was never shown
  })

  it('does the same for Roam: one trip a place, the first three routed', async () => {
    const onemap = oneMapDouble()
    const runs = runsWith(onemap)
    const input = { members: [{ id: 'a', name: 'A' }], occasion: 'catch_up', dateTime: DATE_TIME, categories: ['eat'], unknownPolicy: 'lenient', current: { lat: 1.3127, lng: 103.8383 } }
    const { result } = await runs.runWithTravel(input, data, roam, { cache: false })
    expect(result.results.slice(0, PLACES_ROUTED_FIRST).every((r) => r.travelSource === 'routed')).toBe(true)
    expect(onemap.asked.length).toBeLessThanOrEqual(PLACES_ROUTED_FIRST * TABLE_ROUTE_ROUNDS)
  })

  it('never routes a candidate that costs no call twice: a trip the cache or a walk answers is free, and the candidate is read on it', async () => {
    const cached = new Map()
    const onemap = {
      ...oneMapDouble(),
      // Every trip is "cached" at 25 minutes: nothing costs a call.
      peekRoute: (a, b) => ({ kind: 'cached', minutes: 25 + (cached.get(spot(b)) ?? 0) }),
      routeMinutes: vi.fn(async () => 99),
    }
    const { result, travel } = await runsWith(onemap).runWithTravel(convergeInput(), data, converge)
    expect(onemap.routeMinutes).not.toHaveBeenCalled()
    expect(result.results.every((r) => r.travelSource === 'routed' && r.worstMinutes === 25)).toBe(true)
    expect(travel).toMatchObject({ source: 'onemap', routed: 0, table: 0 })
    expect(travel.cached).toBe(travel.asked)
  })
})

describe('the free runs', () => {
  it("`travel: 'estimate'` uses the table, makes no call, and says table", async () => {
    const onemap = oneMapDouble()
    const runs = runsWith(onemap)
    const input = convergeInput({ travel: 'estimate' })
    const { result, travel } = await runs.runWithTravel(input, data, converge)
    expect(onemap.asked).toHaveLength(0)
    expect(travel).toMatchObject({ source: 'table', routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 })
    expect(travel.table).toBe(travel.asked)
    expect(travel.asked).toBeGreaterThan(0)
    expect(result.results.every((r) => r.travelSource === 'table' && r.approximate === false)).toBe(true)
  })

  it('does the same with no OneMap at all, and for the meeting area', async () => {
    const runs = createPlannerRuns({ data, weatherResolver: null, onemap: null, areaTimes: table })
    const { result, travel } = await askMeeting(runs, meetingInput({ alternatives: 2 }))
    expect(travel.source).toBe('table')
    expect(result.travelSource).toBe('table')
    expect(result.candidates.every((c) => c.travelSource === 'table')).toBe(true)
  })

  it('stays what it was without the table: the straight line, `estimate`, no `table` field and no labels', async () => {
    const runs = createPlannerRuns({ data, weatherResolver: null, onemap: null })
    const { result, travel } = await runs.runWithTravel(convergeInput(), data, converge)
    expect(travel).toEqual({ source: 'estimate', asked: 0, routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 })
    expect(result.results[0]).not.toHaveProperty('travelSource')
  })

  it('leaves a run that does not use the table alone: no table, the whole pruned list is still routed in order', async () => {
    const onemap = oneMapDouble()
    const { travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, run: (deps) => converge(convergeInput(), data, deps) })
    expect(travel).not.toHaveProperty('table')
    expect(onemap.asked.length).toBeGreaterThan(PLACES_ROUTED_FIRST * 2)
  })
})

describe('over HTTP', () => {
  const servers = []
  afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))
  afterEach(() => vi.restoreAllMocks())

  async function post(path, body, onemap, areaTimes = table) {
    const server = createApp({ frontendOrigin: 'http://localhost:5173', planData: data, http: createHttp({ stub: true }), onemap, areaTimes, roundPlannerMinutes: false }).listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }

  it('answers a meeting-area request with `travel.table` and a label on each area', async () => {
    const onemap = oneMapDouble()
    const wire = (m) => ({ id: m.id, name: m.name, start: m.start, end: m.end })
    const res = await post('/meeting-area', { members: members.map(wire), dateTime: DATE_TIME, alternatives: 2 }, onemap)
    expect(res.status).toBe(200)
    expect(res.body.travel).toMatchObject({ source: 'onemap', failed: 0, estimated: 0 })
    expect(res.body.travel.table).toBeGreaterThan(0)
    expect(res.body.travelSource).toBe('routed')
    expect(res.body.candidates.map((c) => c.travelSource)).toContain('table')
    expect(res.body.approximate).toBe(false)
  })

  it('answers `travel: estimate` from the table over HTTP without asking OneMap', async () => {
    const onemap = oneMapDouble()
    const res = await post('/converge', { ...convergeInput({ travel: 'estimate' }), members: members.slice(0, 2).map((m) => ({ id: m.id, name: m.name, start: m.start, end: m.end })) }, onemap)
    expect(res.status).toBe(200)
    expect(onemap.asked).toHaveLength(0)
    expect(res.body.travel.source).toBe('table')
    expect(res.body.results.every((r) => r.travelSource === 'table')).toBe(true)
  })
})

describe('sessions: what a stored figure says', () => {
  it('stores a table-timed spot as approximate ("about") and a routed one as exact; the planner\'s own flag stays about the straight line', () => {
    const candidate = (id, travelSource, approximate = false) => ({ area: { id }, source: 'ranked', worstMinutes: 30, meanMinutes: 25, travelByMember: { '1111111a-1111-4111-8111-11111111111b': 30 }, approximate, travelSource })
    const rows = spotRowsFrom({ candidates: [candidate('bugis', 'routed'), candidate('bishan', 'table'), candidate('orchard', 'estimate', true)] }, { source: 'onemap' })
    expect(rows.map((r) => r.approximate)).toEqual([false, true, true])
    expect(isAbout({ approximate: false, travelSource: 'table' })).toBe(true)
    expect(isAbout({ approximate: false, travelSource: 'routed' })).toBe(false)
    expect(isAbout({ approximate: false })).toBe(false) // an answer from a server without the table says nothing
  })

  it('prices a known place on routed times when it can, and says "about" when it fell back to the table', async () => {
    const input = { members: [{ id: 'u1', start: members[0].start }, { id: 'u2', start: members[1].start }], area: { id: 'bugis', lat: 1.30065, lng: 103.85585 }, dateTime: DATE_TIME }
    const routed = await runsWith(oneMapDouble()).runWithTravel(input, data, priceAreaRun)
    expect(routed.result.travelSource).toBe('routed')
    expect(knownPlaceRow('bugis', routed.result, routed.travel).approximate).toBe(false)
    const hung = { ...oneMapDouble(), routeMinutes: () => new Promise(() => {}) }
    const fallback = await runsWith(hung, { routingDeadlineMs: 20 }).runWithTravel(input, data, priceAreaRun)
    expect(fallback.result.travelSource).toBe('table')
    expect(knownPlaceRow('bugis', fallback.result, fallback.travel).approximate).toBe(true)
  })
})

// A simulation of what verifying on live routes is worth, with a "live" that is the table plus an error of the size measured on live
// OneMap routes (28 October 2026: mean absolute 3.8 minutes on 26 trips fitted, 5.6 on 23 more). It does not call anything, and the
// numbers are the simulation's, not OneMap's: the real comparison is in backend/docs/planner-api.md.
describe('table mode against an all-live ranking (simulated errors)', () => {
  let seed = 20261028
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647
  const hash = (text) => {
    let h = 2166136261
    for (const c of text) {
      h ^= c.charCodeAt(0)
      h = Math.imul(h, 16777619)
    }
    return (h >>> 0) / 4294967296
  }
  // Mean about -1 minute (live a little longer than the table), spread 4.8, the same for the same trip either way round.
  const live = (a, b) => {
    const key = [spot(a), spot(b)].sort().join('|')
    const z = Math.sqrt(-2 * Math.log(hash(`${key}a`) + 1e-12)) * Math.cos(2 * Math.PI * hash(`${key}b`))
    return Math.max(3, estimator(a, b) + 1 + 4.8 * z)
  }
  const places = data.venues.filter((v) => v.lat && v.lng)

  it('agrees with the all-live pick far more often than the table alone, for the meeting area and for the first place', async () => {
    const onemap = { routingEnabled: true, reportFallback() {}, routeMinutes: async (a, b) => live(a, b) }
    const runs = runsWith(onemap)
    const stats = { n: 0, same: 0, tableSame: 0, regret: 0, tableRegret: 0, calls: 0, placeN: 0, placeSame: 0, placeTableSame: 0, top3: 0, tableTop3: 0 }
    for (let i = 0; i < 40; i++) {
      const starts = Array.from({ length: 3 + (i % 2) }, () => places[Math.floor(rnd() * places.length)])
      const group = starts.map((v, j) => ({ id: `m${j}`, name: `M${j}`, start: { lat: v.lat, lng: v.lng }, end: { lat: v.lat, lng: v.lng } }))
      const input = { members: group, method: 'station', dateTime: DATE_TIME }
      const wide = runs.withRoutingCandidates(input)
      const truth = meetingArea(wide, data, { travelMinutes: live, estimateMinutes: estimator })
      const tableOnly = meetingArea(wide, data, { estimateMinutes: estimator })
      const mine = await runs.runWithTravel(input, data, runs.meetingAreaWithRouting, runs.meetingAreaTravelFor(input))
      const worstLive = (area) => Math.max(...group.map((m) => live(m.start, data.areas.find((a) => a.id === area))))
      stats.n += 1
      stats.same += mine.result.area.id === truth.area.id
      stats.tableSame += tableOnly.area.id === truth.area.id
      stats.regret += worstLive(mine.result.area.id) - worstLive(truth.area.id)
      stats.tableRegret += worstLive(tableOnly.area.id) - worstLive(truth.area.id)
      stats.calls += mine.travel.routed

      const slotInput = { members: group.slice(0, 2), occasion: 'catch_up', dateTime: DATE_TIME, durationMinutes: 90, categories: ['eat'], unknownPolicy: 'lenient', centre: { lat: truth.area.lat, lng: truth.area.lng } }
      const best = converge(slotInput, data, { travelMinutes: live })
      if (best.status !== 'ok') continue
      const tableBest = converge(slotInput, data, { travelMinutes: estimator.tableMinutes, estimateMinutes: estimator })
      const asked = await runs.runWithTravel(slotInput, data, converge)
      const first3 = best.results.slice(0, 3).map((r) => r.venueId)
      stats.placeN += 1
      stats.placeSame += asked.result.results[0].venueId === first3[0]
      stats.placeTableSame += tableBest.results[0].venueId === first3[0]
      stats.top3 += asked.result.results.slice(0, 3).filter((r) => first3.includes(r.venueId)).length
      stats.tableTop3 += tableBest.results.slice(0, 3).filter((r) => first3.includes(r.venueId)).length
    }
    // Measured when this test was written (seeded, so it repeats; 40 groups): the pick was the all-live one in 31 groups against 15 for the table
    // alone, and 0.3 minute worse on the longest trip on average against 3.6, with about 10 routed trips a request; the first place was the
    // all-live one in 35 groups against 29, and 89 of the first three places were the all-live ones against 83 (of 120). The bounds sit under those.
    expect(stats.same / stats.n).toBeGreaterThan(0.7)
    expect(stats.same).toBeGreaterThan(stats.tableSame * 1.5)
    expect(stats.regret / stats.n).toBeLessThan(1)
    expect(stats.regret).toBeLessThan(stats.tableRegret)
    expect(stats.calls / stats.n).toBeLessThan(14)
    expect(stats.placeSame / stats.placeN).toBeGreaterThan(0.8)
    expect(stats.placeSame).toBeGreaterThan(stats.placeTableSame)
    expect(stats.top3 / (3 * stats.placeN)).toBeGreaterThan(0.65)
    expect(stats.top3).toBeGreaterThan(stats.tableTop3)
  })
})
