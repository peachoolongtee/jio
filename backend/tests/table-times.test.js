// Table mode: the planner ranks every meeting area and place on the table of real minutes between the areas (no OneMap call), then routes
// live only the results it shows first and runs the engine again with those routes (services/travel-times.js, planner/area-times.js).
// Nothing here touches the network: OneMap is a double that records the trips it was asked for and answers from a function of the trip.
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadAreaTimes } from '../src/db/area-times.js'
import { loadPlanData } from '../src/db/venues.js'
import { ACCESS_FIXED_MINUTES, ACCESS_MINUTES_PER_KM, accessMinutes, AT_CENTRE_KM, createAreaEstimator, pairKey, tableMoment } from '../src/planner/area-times.js'
import { converge, meetingArea, roam } from '../src/planner/engine.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { createPlannerRuns, MEETING_AREAS_ROUTED_ON_TABLE, PLACES_ROUTED_FIRST } from '../src/services/planner-runs.js'
import { isAbout, knownPlaceRow, priceAreaRun, spotRowsFrom } from '../src/services/session-plan.js'
import { runOnTableTimes, runWithRealTravel, TABLE_ROUND_MIN_MS, TABLE_ROUTE_ROUNDS } from '../src/services/travel-times.js'
import { newAllowance, spend } from '../src/services/session-voting.js'
import { evaluate, hopWith, loadTrips } from '../scripts/fit-access-hop.js'
import { cachedOneMap } from './helpers/cached-onemap.js'

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

describe('the hop of the table trip time against the live trips it was fitted to (scripts/fit-access-hop.js)', () => {
  it('keeps the trips as distances and residuals only, and the hop in the code fits them: about a minute on average, about four and a half off', () => {
    const trips = loadTrips()
    expect(trips.length).toBeGreaterThanOrEqual(70)
    const raw = JSON.stringify(JSON.parse(readFileSync(fileURLToPath(new URL('../scripts/data/access-hop-trips.json', import.meta.url)), 'utf8')))
    expect(raw).not.toMatch(/"lat"|"lng"|"minutes"|itiner|geometry/i) // no coordinates, no route, no response
    const fit = evaluate(trips, hopWith({ fixed: ACCESS_FIXED_MINUTES, perKm: ACCESS_MINUTES_PER_KM, rampKm: 0.4, centreKm: AT_CENTRE_KM }))
    expect(Math.abs(fit.mean)).toBeLessThan(1.5)
    expect(fit.mae).toBeLessThan(5)
    // The first version of the hop (3.7 minutes a km) fits far worse: this is what the refit bought.
    expect(evaluate(trips, hopWith({ fixed: 0, perKm: 3.68, rampKm: 0.4, centreKm: AT_CENTRE_KM })).mean).toBeLessThan(-10)
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
    // `routed` and `source` describe the times in the answer: the routes that arrived for the candidate left on the table are not counted as used.
    expect(travel.routed).toBe(0)
    expect(travel.source).toBe('table')
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

  it('makes no call at all when the deadline has no time, with the options a real meeting-area request has', async () => {
    const onemap = oneMapDouble()
    const runs = runsWith(onemap)
    const input = meetingInput({ alternatives: 2 })
    const { result, travel } = await runs.runWithTravel(input, data, runs.meetingAreaWithRouting, { ...runs.meetingAreaTravelFor(input), deadlineMs: 0 })
    expect(onemap.asked).toHaveLength(0)
    expect(onemap.reportFallback).toHaveBeenCalledWith('deadline')
    expect(travel.source).toBe('table')
    expect(result.candidates.every((c) => c.travelSource === 'table')).toBe(true)
  })

  it('keeps to the cap of trips for a request, in whole areas', async () => {
    const onemap = oneMapDouble()
    const runs = runsWith(onemap)
    const input = meetingInput()
    const { travel } = await runs.runWithTravel(input, data, runs.meetingAreaWithRouting, { ...runs.meetingAreaTravelFor(input), maxTrips: members.length + 1 })
    expect(onemap.asked).toHaveLength(members.length) // one whole area (3 trips); the next would pass the cap of 4
    expect(travel.routed).toBe(members.length)
  })

  it('spends one shared allowance across the rounds: with trips for only one place left after the first, the others stay on the table, and a clock nearly spent skips round two', async () => {
    // Two people, so a place costs two trips. An allowance of 3 trips fits one place whole; the next would pass it.
    const onemap = oneMapDouble()
    const tight = newAllowance(3000, 3)
    const runs = runsWith(onemap)
    const input = convergeInput()
    const { result, travel } = await runs.runWithTravel(input, data, converge, () => tight.routing())
    spend(tight, travel)
    expect(onemap.asked).toHaveLength(2)
    expect(tight.called).toBe(2)
    expect(result.results.map((r) => r.travelSource).filter((s) => s === 'routed')).toHaveLength(1)
    expect(result.results.every((r) => r.approximate === false)).toBe(true)

    // A shared clock of 900 ms and calls of 700 ms: round one uses 700, 200 are left, and round two would need 500. The same allowance serves a second run.
    const base = oneMapDouble()
    const slow = { ...base, routeMinutes: async (a, b) => { await new Promise((resolve) => setTimeout(resolve, 700)); return base.routeMinutes(a, b) } }
    const clock = newAllowance(900)
    const first = await runsWith(slow).runWithTravel(input, data, converge, () => clock.routing())
    const calls = base.asked.length
    expect(calls).toBeGreaterThan(0)
    const second = await runsWith(slow).runWithTravel(convergeInput({ centre: { lat: 1.3521, lng: 103.8198 } }), data, converge, () => clock.routing())
    expect(base.asked.length).toBe(calls) // the clock had run out: no call for the second run
    expect(second.travel.source).toBe('table')
    expect(first.travel.routed).toBeGreaterThan(0)
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

  it('puts the named areas after the ranking in time: they are routed last, so they cannot starve a later round', async () => {
    const free = oneMapDouble()
    const first = (await askMeeting(runsWith(free, { meetingFinalists: 1 }), meetingInput())).result.area.id
    const slow = oneMapDouble((a, b) => estimator(a, b) + ((a.id ?? b.id) === first ? 40 : 0)) // the first choice falls: a second round routes the climber
    const { result } = await askMeeting(runsWith(slow, { meetingFinalists: 1 }), meetingInput({ alternatives: 1, include: ['tuas-link'] }))
    const order = slow.asked.map(({ a, b }) => a.id ?? b.id)
    expect(order).toContain('tuas-link')
    expect(order.lastIndexOf(result.area.id)).toBeLessThan(order.indexOf('tuas-link')) // the chosen area's trips all came before the named area's
    expect(order.indexOf(first)).toBeLessThan(order.indexOf('tuas-link'))
  })

  it('does not start a later round with less than the floor of time left, and says the deadline passed once', async () => {
    const free = oneMapDouble()
    const first = (await askMeeting(runsWith(free, { meetingFinalists: 1 }), meetingInput())).result.area.id
    // Each call takes 700 ms of a 1000 ms deadline, and the first choice is 40 minutes slower than the table: a second round would be needed, with 300 ms left.
    const base = oneMapDouble((a, b) => estimator(a, b) + ((a.id ?? b.id) === first ? 40 : 0))
    const slow = { ...base, routeMinutes: async (a, b) => { await new Promise((resolve) => setTimeout(resolve, 700)); return base.routeMinutes(a, b) } }
    const runs = runsWith(slow, { meetingFinalists: 1, routingDeadlineMs: 1000 })
    const { travel } = await askMeeting(runs, meetingInput())
    expect(TABLE_ROUND_MIN_MS).toBeGreaterThan(300)
    expect(base.asked).toHaveLength(members.length) // only the first round's calls
    expect(base.reportFallback).toHaveBeenCalledTimes(1)
    expect(travel.routed).toBe(members.length)
  })

  it('picks the same area for `travel: estimate` as for a request routed with a OneMap that agrees with the table, from the same 16 areas', async () => {
    const runs = runsWith(oneMapDouble())
    const input = meetingInput({ alternatives: 2 })
    const estimateOnly = await askMeeting(runs, { ...input, travel: 'estimate' })
    const routed = await askMeeting(runs, input)
    expect(estimateOnly.result.area.id).toBe(routed.result.area.id)
    expect(estimateOnly.result.diagnostics.rankedAreaIds).toHaveLength(16)
    expect(routed.result.diagnostics.rankedAreaIds).toHaveLength(16)
  })

  it('says what moment the table is for, when any time in the answer is the table\'s', async () => {
    expect(tableMoment(table)).toBe('Tuesday 12:30')
    expect(tableMoment({ _meta: { dateTime: 'soon' } })).toBeNull()
    expect(tableMoment(null)).toBeNull()
    const { travel } = await askMeeting(runsWith(oneMapDouble()), meetingInput())
    expect(travel.tableAt).toBe('Tuesday 12:30')
    const all = await askMeeting(runsWith(oneMapDouble()), { ...meetingInput(), travel: 'estimate' })
    expect(all.travel.tableAt).toBe('Tuesday 12:30')
    const without = createPlannerRuns({ data, weatherResolver: null, onemap: null })
    expect((await askMeeting(without, meetingInput())).travel).not.toHaveProperty('tableAt') // a server without the table
  })

  it('does not run the engine again on the same input when nothing is free: the dry run is the first answer', async () => {
    let runs = 0
    const onemap = oneMapDouble()
    const run = (deps) => { runs += 1; return converge(convergeInput(), data, deps) }
    const common = { onemap, dateTime: DATE_TIME, run, table: estimator.tableMinutes, estimate: estimator }
    await runWithRealTravel({ ...common, routeFirst: () => ({ ranking: [] }) })
    expect(runs).toBe(1) // the dry run only: nothing to route, nothing to run again
    runs = 0
    await runWithRealTravel({ ...common, routeFirst: (r) => ({ ranking: [r.results[0].venueId] }) })
    expect(runs).toBe(2) // the dry run, and one run on the routed first place
  })

  it('does not let a name move the planner\'s pick through the cache: a named area routed in one request is not read live by the next unless the ranking shows it', async () => {
    const seen = await askMeeting(runsWith(oneMapDouble()), { ...meetingInput(), travel: 'estimate' })
    const named = seen.result.diagnostics.rankedAreaIds[7] // inside the ranking's 16, but not one of the areas shown first
    // Live, the named area is far quicker than the table says, so a ranking that read it would pick it.
    const minutes = (a, b) => estimator(a, b) - ((a.id ?? b.id) === named ? 30 : 0) + 1
    const cache = cachedOneMap({ minutes, latencyMs: 3 })
    const runs = runsWith(cache)
    const input = meetingInput({ alternatives: 1, include: [named] })
    const first = await askMeeting(runs, input)
    expect(cache.ends().has(named)).toBe(true) // routed for its own entry, and now in the cache
    const second = await askMeeting(runs, input) // the cache is warm: the named area costs no call
    const bare = await askMeeting(runsWith(cachedOneMap({ minutes, latencyMs: 3 })), meetingInput({ alternatives: 1 }))
    expect(first.result.area.id).not.toBe(named)
    expect(second.result.area.id).toBe(first.result.area.id)
    expect(second.result.area.id).toBe(bare.result.area.id)
    expect(second.result.travelByMember).toEqual(first.result.travelByMember)
    const entry = second.result.candidates.find((c) => c.area.id === named)
    expect(entry).toMatchObject({ source: 'included', travelSource: 'routed' }) // its own entry has the cached live times
    expect(entry.worstMinutes).toBeLessThan(first.result.worstMinutes) // and they really are quicker than the pick
  })

  it('answers the same with a name as without it when the cache already holds the named area and the ranking shows it', async () => {
    const ranked = (await askMeeting(runsWith(oneMapDouble()), { ...meetingInput(), travel: 'estimate' })).result.diagnostics.rankedAreaIds
    for (const named of [ranked[0], ranked[1]]) {
      // Live, that area is 25 minutes worse than the table says: if the ranking read it on the table the pick would be wrong.
      const minutes = (a, b) => estimator(a, b) + ((a.id ?? b.id) === named ? 25 : 0)
      const cache = cachedOneMap({ minutes, latencyMs: 2 })
      const runs = runsWith(cache, { meetingFinalists: 2 })
      await askMeeting(runs, meetingInput({ alternatives: 2 })) // warms the cache with the ranking's own routes
      expect(cache.ends().has(named)).toBe(true)
      const bare = await askMeeting(runs, meetingInput({ alternatives: 2 }))
      const withName = await askMeeting(runs, meetingInput({ alternatives: 2, include: [named] }))
      expect(withName.result.area.id, named).toBe(bare.result.area.id)
      expect(withName.result.travelByMember).toEqual(bare.result.travelByMember)
      expect(withName.result.travelSource).toBe(bare.result.travelSource)
      expect(withName.result.candidates.filter((c) => c.source === 'ranked')).toEqual(bare.result.candidates)
    }
  })

  it('keeps trips back for the areas a person named: with 12 finalists and 6 people the ranking alone would use the whole cap of 60', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, start: { lat: 1.30 + i * 0.02, lng: 103.75 + i * 0.03 }, end: { lat: 1.30 + i * 0.02, lng: 103.75 + i * 0.03 } }))
    const input = { members: six, method: 'station', dateTime: DATE_TIME, include: ['tuas-link', 'changi-airport'] }
    const reserved = oneMapDouble()
    const withNames = await askMeeting(runsWith(reserved, { meetingFinalists: 12 }), input)
    expect(reserved.asked.length).toBeLessThanOrEqual(60)
    for (const id of ['tuas-link', 'changi-airport']) {
      expect(reserved.ends().has(id), id).toBe(true)
      expect(withNames.result.candidates.find((c) => c.area.id === id).travelSource).toBe('routed')
    }
    // Without names the ranking has the whole cap (10 areas of 6), so the reserve is what the names cost the ranking, no more.
    const alone = oneMapDouble()
    await askMeeting(runsWith(alone, { meetingFinalists: 12 }), { ...input, include: undefined })
    expect(alone.asked.length).toBeGreaterThan(reserved.asked.length - 13)
    expect(alone.asked.length).toBeLessThanOrEqual(60)
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
    // A later place is routed only when it shares a route that was asked for (places in one building, to about 110 m, share their trips): no call of its own.
    const askedAt = new Set(onemap.asked.map(({ a, b }) => spot(a.id ? a : b)))
    for (const r of result.results.slice(PLACES_ROUTED_FIRST)) expect(r.travelSource === 'table' || askedAt.has(spot(r.venue)), r.venueId).toBe(true)
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

  it('Roam: the table does not make the places beside the person take as long as the ride to the next station, so the first three shown are routed', async () => {
    // Tiong Bahru is a ride of 1 minute from its neighbour in this table. A person there and the places near them (56 in the same area)
    // are not 1 minute apart: that cap once put every one of them at the neighbour's time, under any routed time, so the first three shown stayed unrouted.
    const quick = { ...table, minutes: { ...table.minutes, [pairKey('outram-park', 'tiong-bahru')]: 1 } }
    const centre = data.areas.find((a) => a.id === 'tiong-bahru')
    const input = { members: [{ id: 'a', name: 'A' }], occasion: 'catch_up', dateTime: DATE_TIME, categories: ['eat'], unknownPolicy: 'lenient', current: { lat: centre.lat + 0.002, lng: centre.lng } }
    const free = await runsWith(oneMapDouble(), { areaTimes: quick }).runWithTravel({ ...input, travel: 'estimate' }, data, roam)
    expect(Math.min(...free.result.results.map((r) => r.travelMinutes))).toBeGreaterThan(5)
    // Live a little slower than the table (the same trips, +1 and +2 minutes): the places routed first stay ahead of those not routed.
    for (const live of [(a, b) => estimator(a, b) + 1, (a, b) => estimator(a, b) + 2]) {
      const onemap = oneMapDouble(live)
      const { result } = await runsWith(onemap, { areaTimes: quick }).runWithTravel(input, data, roam, { cache: false })
      expect(result.results.slice(0, PLACES_ROUTED_FIRST).map((r) => r.travelSource)).toEqual(['routed', 'routed', 'routed'])
      expect(result.results.slice(0, PLACES_ROUTED_FIRST).every((r) => r.travelMinutes > 5)).toBe(true)
    }
  })

  it('reads the places not routed on the table moved by how far this request\'s routes differ from it, so a rush hour does not put unrouted places first', async () => {
    // Live runs 8 minutes longer than the table on every trip (the table is a Tuesday midday). Without the shift each place routed would fall below every
    // place not routed, and the first three shown would be the table's.
    const onemap = oneMapDouble((a, b) => estimator(a, b) + 8)
    const { result } = await runsWith(onemap).runWithTravel(convergeInput(), data, converge)
    expect(result.results.slice(0, PLACES_ROUTED_FIRST).map((r) => r.travelSource)).toEqual(['routed', 'routed', 'routed'])
    // The places after them are the table's, moved by the same eight minutes: their times are not the table's own.
    const free = await runsWith(oneMapDouble()).runWithTravel({ ...convergeInput(), travel: 'estimate' }, data, converge)
    const later = result.results.find((r) => r.travelSource === 'table')
    const alone = free.result.results.find((r) => r.venueId === later.venueId)
    expect(later.worstMinutes - alone.worstMinutes).toBeCloseTo(8, 0)
    expect(later.approximate).toBe(false)
  })

  describe('the shift of the places not routed', () => {
    const two = members.slice(0, 2)
    const input = (extra = {}) => convergeInput({ members: two, ...extra })
    const personOf = (a, b) => (a.id !== undefined ? b : a)
    // Live = the table plus a number of minutes that depends on whose trip it is (and on the place, for an outlier).
    const liveWith = (offset) => (a, b) => estimator(a, b) + offset(personOf(a, b) === a ? a : b, a.id ?? b.id)
    const isFirst = (p) => p.lat === two[0].start.lat && p.lng === two[0].start.lng
    const gapsOf = async (offset, options = {}) => {
      const runs = runsWith(oneMapDouble(liveWith(offset)))
      const free = (await runs.runWithTravel({ ...input(), travel: 'estimate' }, data, converge)).result.results
      const { result } = await runs.runWithTravel(input(), data, converge, options)
      const later = result.results.filter((r) => r.travelSource === 'table')
      expect(later.length).toBeGreaterThan(0)
      return later.map((r) => {
        const alone = free.find((f) => f.venueId === r.venueId)
        return alone ? [r.travelByMember[two[0].id] - alone.travelByMember[two[0].id], r.travelByMember[two[1].id] - alone.travelByMember[two[1].id]] : null
      }).filter(Boolean)
    }

    it('is per person: each person\'s unrouted trips move by what that person\'s routed trips differ from the table', async () => {
      const gaps = await gapsOf((p) => (isFirst(p) ? 10 : -5))
      expect(gaps.length).toBeGreaterThan(0)
      for (const [first, second] of gaps) {
        expect(first).toBeCloseTo(10, 0)
        expect(second).toBeCloseTo(-5, 0)
      }
    })

    it('ignores one outlier among a person\'s routed trips (the median, not the mean)', async () => {
      let outlier = null
      const gaps = await gapsOf((_, id) => {
        outlier ??= id // the first place asked about is 60 minutes off for everyone
        return id === outlier ? 60 : 0
      })
      for (const [first, second] of gaps) {
        expect(Math.abs(first)).toBeLessThan(1)
        expect(Math.abs(second)).toBeLessThan(1)
      }
    })

    it('can be negative, and is kept within 15 minutes', async () => {
      for (const [offset, expected] of [[-5, -5], [40, 15], [-40, -15]]) {
        const gaps = await gapsOf(() => offset)
        for (const g of gaps.flat()) expect(g, String(offset)).toBeGreaterThanOrEqual(Math.min(0, expected) - 0.5)
        for (const [first] of gaps) expect(first).toBeCloseTo(expected, 0)
      }
    })

    it('takes the median of everyone\'s gaps when a person has fewer than two routed trips, and is 0 with fewer than two in all', async () => {
      // One place routed (rounds: 1, only the first named): each of the two people has one routed trip, so both take the median of the two gaps: (10 + 4) / 2.
      const live = liveWith((p) => (isFirst(p) ? 10 : 4))
      const free = (await runsWith(oneMapDouble(live)).runWithTravel({ ...input(), travel: 'estimate' }, data, converge)).result.results
      const only = (r) => ({ ranking: [r.results[0].venueId] })
      const { result } = await runWithRealTravel({ onemap: oneMapDouble(live), dateTime: DATE_TIME, run: (deps) => converge(input(), data, deps), table: estimator.tableMinutes, estimate: estimator, routeFirst: only, rounds: 1 })
      const later = result.results.find((r) => r.travelSource === 'table')
      const alone = free.find((f) => f.venueId === later.venueId)
      expect(later.travelByMember[two[0].id] - alone.travelByMember[two[0].id]).toBeCloseTo(7, 0)
      expect(later.travelByMember[two[1].id] - alone.travelByMember[two[1].id]).toBeCloseTo(7, 0)
      // One person, one place routed: a single gap, so no shift.
      const solo = { ...input(), members: [two[0]] }
      const freeSolo = (await runsWith(oneMapDouble(live)).runWithTravel({ ...solo, travel: 'estimate' }, data, converge)).result.results
      const one = await runWithRealTravel({ onemap: oneMapDouble(live), dateTime: DATE_TIME, run: (deps) => converge(solo, data, deps), table: estimator.tableMinutes, estimate: estimator, routeFirst: only, rounds: 1 })
      const laterSolo = one.result.results.find((r) => r.travelSource === 'table')
      expect(laterSolo.travelByMember[two[0].id]).toBeCloseTo(freeSolo.find((f) => f.venueId === laterSolo.venueId).travelByMember[two[0].id], 6)
    })

    it('leaves a table time of 0 at 0, as the dry run has it', async () => {
      // Two people on the centres of Bugis and Orchard. Only Orchard is routed, 8 minutes slower than the table; Bugis is read on the table moved by the shift,
      // and the trip from the person at Bugis to Bugis is nothing, as it was before anything was routed.
      const bugis = data.areas.find((a) => a.id === 'bugis'), orchard = data.areas.find((a) => a.id === 'orchard')
      const group = [bugis, orchard].map((a, i) => ({ id: `c${i}`, name: `C${i}`, start: { lat: a.lat, lng: a.lng }, end: { lat: a.lat, lng: a.lng } }))
      const run = (deps) => meetingArea({ members: group, method: 'station', alternatives: 3, dateTime: DATE_TIME }, data, deps)
      const dry = runOnTableTimes({ run, table: estimator.tableMinutes, estimate: estimator }).result
      expect(dry.candidates.find((c) => c.area.id === 'bugis').travelByMember.c0).toBe(0)
      const { result } = await runWithRealTravel({
        onemap: oneMapDouble((a, b) => estimator(a, b) + 8), dateTime: DATE_TIME, run, table: estimator.tableMinutes, estimate: estimator,
        routeFirst: () => ({ ranking: ['orchard'] }), rounds: 1,
      })
      const entry = result.candidates.find((c) => c.area.id === 'bugis')
      if (entry) expect(entry.travelByMember.c0).toBe(0)
    })
  })

  it('never buys a trip twice in one request when the cache is off: places in one building share a route, and a later round or the named pass finds it answered', async () => {
    const orchard = data.areas.find((a) => a.id === 'tiong-bahru')
    const input = { members: [{ id: 'a', name: 'A' }], occasion: 'catch_up', dateTime: DATE_TIME, categories: ['eat'], unknownPolicy: 'lenient', current: { lat: orchard.lat + 0.002, lng: orchard.lng } }
    const onemap = oneMapDouble((a, b) => estimator(a, b) + 6)
    await runsWith(onemap).runWithTravel(input, data, roam, { cache: false })
    const keys = onemap.asked.map(({ a, b }) => [spot(a), spot(b)].sort().join('|'))
    expect(keys.length).toBeGreaterThan(0)
    expect(new Set(keys).size).toBe(keys.length) // each trip asked for once
  })

  it('mixes cached and uncached trips: a place whose trips are all cached is read live for free, one half cached is routed whole', async () => {
    const base = cachedOneMap({ latencyMs: 2 })
    const runs = runsWith(base)
    const first = await runs.runWithTravel(convergeInput(), data, converge)
    const callsAfterFirst = base.calls.length
    expect(callsAfterFirst).toBeGreaterThan(0)
    // The same ranking again: everything it routed is cached, so no call, and the answer is the same.
    const again = await runs.runWithTravel(convergeInput(), data, converge)
    expect(base.calls).toHaveLength(callsAfterFirst)
    expect(again.travel.cached).toBeGreaterThan(0)
    expect(again.travel.routed).toBe(0)
    expect(again.result.results.map((r) => r.venueId)).toEqual(first.result.results.map((r) => r.venueId))
    // A third person joins: the first two people's trips to each place are cached, the new person's are not. The place is routed whole.
    const three = convergeInput({ members })
    const joined = await runs.runWithTravel(three, data, converge)
    expect(joined.result.results.slice(0, PLACES_ROUTED_FIRST).every((r) => r.travelSource === 'routed')).toBe(true)
    expect(joined.travel.cached).toBeGreaterThan(0)
    expect(joined.travel.routed).toBeGreaterThan(0)
    expect(sum(joined.travel)).toBe(joined.travel.asked)
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

// A GUARD ON THE DESIGN, not a measurement. Its "live" is the table plus noise of the size seen on live OneMap routes (28 October 2026: mean
// absolute 4.3 minutes on 73 trips, 5.6 on the 23 that were taken out of sample), so it only shows that verifying the first results on
// routes and running the engine again beats the table alone when live differs from the table by that much. It calls nothing, and it
// cannot say how often the real OneMap would agree: that needs live routes, and the few measured are in backend/docs/planner-api.md.
describe('a guard on the design: table mode against an all-live ranking, where "live" is the table plus noise (not a measurement)', () => {
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

  it('keeps verifying on routes worth it: it agrees with the simulated all-live pick far more often than the table alone', async () => {
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
    // Seen when this test was written (seeded, so it repeats; 40 groups): the pick was the simulated all-live one in 33 groups against 15 for the table
    // alone, and 0.3 minute worse on the longest trip on average against 3.6, with about 10 routed trips a request; the first place was the
    // simulated all-live one in 36 groups against 30, and 93 of the first three places were its places against 81 (of 120). The bounds sit under those.
    expect(stats.same / stats.n).toBeGreaterThan(0.7)
    expect(stats.same).toBeGreaterThan(stats.tableSame * 1.5)
    expect(stats.regret / stats.n).toBeLessThan(1)
    expect(stats.regret).toBeLessThan(stats.tableRegret)
    expect(stats.calls / stats.n).toBeLessThan(14)
    expect(stats.placeSame / stats.placeN).toBeGreaterThan(0.8)
    expect(stats.placeSame).toBeGreaterThan(stats.placeTableSame)
    expect(stats.top3 / (3 * stats.placeN)).toBeGreaterThan(0.7)
    expect(stats.top3).toBeGreaterThan(stats.tableTop3)
  })
})
