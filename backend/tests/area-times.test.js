// The table of real minutes between the meeting areas, the guess built from it, and that the planner ranks areas with it.
// Nothing here touches the network: OneMap is a double that answers 20 minutes and records the trips it was asked for.
import { once } from 'node:events'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadAreaTimes } from '../src/db/area-times.js'
import { loadPlanData } from '../src/db/venues.js'
import { ACCESS_FIXED_MINUTES, ACCESS_MINUTES_PER_KM, ACCESS_RAMP_KM, accessMinutes, areaTimesCoverage, createAreaEstimator, isAreaTimes, MAX_PLAUSIBLE_MINUTES, pairKey } from '../src/planner/area-times.js'
import { meetingArea } from '../src/planner/engine.js'
import { haversineKm, mockTravelMinutes } from '../src/planner/geo.js'
import { buildAreaTimes, creditFor, DEFAULT_PER_MINUTE, HELP, isNoRoute, MAX_PER_MINUTE, nextTuesdayNoon, readFlags, singaporeDay } from '../scripts/build-area-times.js'
import { createHttp } from '../src/services/http.js'
import { createPlannerRuns } from '../src/services/planner-runs.js'

const AREAS = [
  { id: 'a', name: 'A', lat: 1.3, lng: 103.8 },
  { id: 'b', name: 'B', lat: 1.3, lng: 103.95 },
  { id: 'c', name: 'C', lat: 1.4, lng: 103.8 },
  { id: 'd', name: 'D', lat: 1.4, lng: 103.95 },
]
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'jio-area-times-'))

describe('pairKey and the table shape', () => {
  it('names a pair the same either way round', () => {
    expect(pairKey('bugis', 'bedok')).toBe('bedok|bugis')
    expect(pairKey('bedok', 'bugis')).toBe('bedok|bugis')
  })

  it('knows a table from anything else', () => {
    expect(isAreaTimes({ _meta: { areas: ['a'] }, minutes: { 'a|b': 5 } })).toBe(true)
    for (const bad of [null, undefined, 5, 'x', {}, { minutes: {} }, { _meta: {}, minutes: {} }, { _meta: { areas: [] }, minutes: null }]) expect(isAreaTimes(bad)).toBe(false)
  })
})

describe('nextTuesdayNoon', () => {
  it('is the next Tuesday at 12:30, never today', () => {
    expect(nextTuesdayNoon(new Date('2026-10-21T00:00:00Z'))).toBe('2026-10-27T12:30') // a Wednesday
    expect(nextTuesdayNoon(new Date('2026-10-27T05:00:00Z'))).toBe('2026-11-03T12:30') // a Tuesday: the next one
    expect(nextTuesdayNoon(new Date('2026-10-26T23:00:00Z'))).toBe('2026-10-27T12:30') // a Monday
  })
})

describe('buildAreaTimes', () => {
  const run = async (options = {}) => {
    const file = path.join(tmp(), 'table.json')
    const calls = []
    const route = async (a, b) => { calls.push(pairKey(a.id, b.id)); return 10 + calls.length }
    const table = await buildAreaTimes({ areas: AREAS, route, dateTime: '2026-10-27T12:30', file, log: () => {}, wait: async () => {}, ...options })
    return { table, calls, file, route }
  }

  it('routes each pair once and saves them under an unordered key', async () => {
    const { table, calls, file } = await run()
    expect(calls).toHaveLength(6) // 4 areas: 6 pairs
    expect(new Set(calls).size).toBe(6)
    expect(Object.keys(table.minutes).sort()).toEqual(['a|b', 'a|c', 'a|d', 'b|c', 'b|d', 'c|d'])
    expect(table._meta).toMatchObject({ dateTime: '2026-10-27T12:30', areas: ['a', 'b', 'c', 'd'], pairs: 6, missing: [] })
    expect(isAreaTimes(JSON.parse(fs.readFileSync(file, 'utf8')))).toBe(true)
  })

  it('stops at the limit and carries on from there, asking for nothing twice', async () => {
    const file = path.join(tmp(), 'table.json')
    const calls = []
    const route = async (a, b) => { calls.push(pairKey(a.id, b.id)); return 12 }
    const common = { areas: AREAS, route, dateTime: '2026-10-27T12:30', file, log: () => {}, wait: async () => {} }
    await buildAreaTimes({ ...common, limit: 2 })
    expect(calls).toHaveLength(2)
    await buildAreaTimes(common)
    expect(calls).toHaveLength(6)
    expect(new Set(calls).size).toBe(6)
    await buildAreaTimes(common) // already complete: nothing to ask
    expect(calls).toHaveLength(6)
  })

  it('starts a fresh table for another moment', async () => {
    const { file, calls } = await run()
    const again = []
    await buildAreaTimes({ areas: AREAS, route: async (a, b) => { again.push(pairKey(a.id, b.id)); return 9 }, dateTime: '2026-11-03T12:30', file, log: () => {}, wait: async () => {} })
    expect(again).toHaveLength(6)
    expect(calls).toHaveLength(6)
  })

  it('writes down a pair with no route and does not ask for it again', async () => {
    const file = path.join(tmp(), 'table.json')
    let asked = 0
    const route = async (a, b) => { asked += 1; return pairKey(a.id, b.id) === 'a|d' ? null : 15 }
    const common = { areas: AREAS, route, dateTime: '2026-10-27T12:30', file, log: () => {}, wait: async () => {} }
    const table = await buildAreaTimes(common)
    expect(table._meta.missing).toEqual(['a|d'])
    expect('a|d' in table.minutes).toBe(false)
    await buildAreaTimes(common)
    expect(asked).toBe(6)
  })

  it('waits and tries again when OneMap fails, and gives up after the retries', async () => {
    const file = path.join(tmp(), 'table.json')
    const waits = []
    let failures = 2
    const route = async () => { if (failures-- > 0) throw Object.assign(new Error('too many requests'), { status: 429 }); return 20 }
    const table = await buildAreaTimes({ areas: AREAS, route, dateTime: '2026-10-27T12:30', file, log: () => {}, wait: async (ms) => { waits.push(ms) }, retryMs: 65_000, perMinute: 60 })
    expect(table._meta.pairs).toBe(6)
    expect(waits.filter((ms) => ms === 65_000)).toHaveLength(2)
    await expect(buildAreaTimes({ areas: AREAS, route: async () => { throw new Error('down') }, dateTime: '2026-12-01T12:30', file: path.join(tmp(), 'x.json'), log: () => {}, wait: async () => {}, retries: 2 })).rejects.toThrow(/Giving up/)
  })

  it('keeps to the pace it was given', async () => {
    const waits = []
    await run({ perMinute: 30, wait: async (ms) => { waits.push(ms) } })
    expect(waits.filter((ms) => ms === 2000)).toHaveLength(6) // 30 a minute: 2 seconds between trips
  })
})

describe('buildAreaTimes: the saved file and what OneMap says about one trip', () => {
  const dateTime = '2026-10-27T12:30'
  const common = (file, route) => ({ areas: AREAS, route, dateTime, file, log: () => {}, wait: async () => {} })
  const apiError = (status) => Object.assign(new Error(`HTTP ${status}`), { status })
  const save = (file, table) => fs.writeFileSync(file, JSON.stringify(table))

  it('writes down a pair OneMap says it cannot route (400, 404 or 422) and goes on, without retrying or stopping', async () => {
    for (const status of [400, 404, 422]) {
      const file = path.join(tmp(), 'table.json')
      const waits = []
      let asked = 0
      const route = async (a, b) => { asked += 1; if (pairKey(a.id, b.id) === 'b|c') throw apiError(status); return 15 }
      const table = await buildAreaTimes({ ...common(file, route), wait: async (ms) => { waits.push(ms) }, retryMs: 65_000 })
      expect(asked, String(status)).toBe(6) // each pair once: the refused one was not asked again
      expect(waits.includes(65_000)).toBe(false)
      expect(table._meta.missing).toEqual(['b|c'])
      expect('b|c' in table.minutes).toBe(false)
      expect(Object.keys(table.minutes)).toHaveLength(5)
    }
    expect([400, 404, 422].every((status) => isNoRoute(apiError(status)))).toBe(true)
    expect([429, 500, 502, 503, undefined].some((status) => isNoRoute(apiError(status)))).toBe(false)
    expect(isNoRoute(null)).toBe(false)
  })

  it('still retries a failure that may pass (429 or 5xx) and gives up on one that does not', async () => {
    for (const status of [429, 503]) {
      const waits = []
      let failed = false
      const route = async () => { if (!failed) { failed = true; throw apiError(status) } return 12 }
      const table = await buildAreaTimes({ ...common(path.join(tmp(), 'table.json'), route), wait: async (ms) => { waits.push(ms) }, retryMs: 65_000 })
      expect(table._meta.pairs).toBe(6)
      expect(waits.filter((ms) => ms === 65_000)).toHaveLength(1)
    }
  })

  it('carries on from a saved file that has no list of missing pairs', async () => {
    const file = path.join(tmp(), 'table.json')
    save(file, { _meta: { source: 'x', dateTime, areas: ['a', 'b', 'c', 'd'] }, minutes: { 'a|b': 7 } })
    const asked = []
    const table = await buildAreaTimes(common(file, async (a, b) => { asked.push(pairKey(a.id, b.id)); return 9 }))
    expect(asked).toHaveLength(5) // 'a|b' was already there
    expect(table.minutes['a|b']).toBe(7)
    expect(table._meta.missing).toEqual([])
    expect(table._meta.pairs).toBe(6)
    // a file whose `missing` is not a list, and a file that is not a table at all, are also tolerated
    save(file, { _meta: { dateTime, missing: 'x' }, minutes: {} })
    expect((await buildAreaTimes(common(file, async () => 5)))._meta.missing).toEqual([])
    fs.writeFileSync(file, '[1, 2]')
    expect((await buildAreaTimes(common(file, async () => 5)))._meta.pairs).toBe(6)
  })

  it('drops pairs of areas that are gone, keeps the rest, and refreshes the list of areas', async () => {
    const file = path.join(tmp(), 'table.json')
    save(file, {
      _meta: { source: 'x', dateTime, areas: ['a', 'b', 'c', 'old'], missing: ['c|old', 'a|d'] },
      minutes: { 'a|b': 7, 'a|old': 99, 'b|old': 98, 'old|zzz': 97, 'a|b|c': 1 },
    })
    const asked = []
    const table = await buildAreaTimes(common(file, async (a, b) => { asked.push(pairKey(a.id, b.id)); return 9 }))
    expect(table._meta.areas).toEqual(['a', 'b', 'c', 'd'])
    expect(Object.keys(table.minutes).some((key) => key.includes('old') || key.includes('zzz') || key === 'a|b|c')).toBe(false)
    expect(table.minutes['a|b']).toBe(7) // a pair of areas that are still there is kept
    expect(table._meta.missing).toEqual(['a|d']) // the stale one is dropped, the current one is kept and not asked again
    expect(asked).not.toContain('a|d')
    expect(asked).toHaveLength(4) // 6 pairs, less 'a|b' (saved) and 'a|d' (missing)
    expect(isAreaTimes(JSON.parse(fs.readFileSync(file, 'utf8')))).toBe(true)
  })

  it('writes its keys in sorted order, so the same times always make the same file', async () => {
    const answers = { 'a|b': 1, 'a|c': 2, 'a|d': 3, 'b|c': 4, 'b|d': 5, 'c|d': 6 }
    const files = []
    for (const areas of [AREAS, [AREAS[3], AREAS[1], AREAS[0], AREAS[2]]]) { // asked in two different orders
      const file = path.join(tmp(), 'table.json')
      await buildAreaTimes({ ...common(file, async (a, b) => answers[pairKey(a.id, b.id)]), areas })
      files.push(JSON.parse(fs.readFileSync(file, 'utf8')))
    }
    for (const table of files) expect(Object.keys(table.minutes)).toEqual(Object.keys(answers))
    expect(files[0].minutes).toEqual(files[1].minutes)
    const file = path.join(tmp(), 'missing.json')
    await buildAreaTimes({ ...common(file, async (a, b) => (['c|d', 'a|d'].includes(pairKey(a.id, b.id)) ? null : 1)) })
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))._meta.missing).toEqual(['a|d', 'c|d'])
  })
})

describe('loadAreaTimes', () => {
  it('answers null for a missing file, a broken one or one of the wrong shape, and the table for a good one', () => {
    const dir = tmp()
    expect(loadAreaTimes(path.join(dir, 'nope.json'))).toBeNull()
    fs.writeFileSync(path.join(dir, 'bad.json'), '{not json')
    expect(loadAreaTimes(path.join(dir, 'bad.json'))).toBeNull()
    fs.writeFileSync(path.join(dir, 'wrong.json'), JSON.stringify({ hello: 1 }))
    expect(loadAreaTimes(path.join(dir, 'wrong.json'))).toBeNull()
    const good = { _meta: { areas: ['a'] }, minutes: { 'a|b': 4 } }
    fs.writeFileSync(path.join(dir, 'good.json'), JSON.stringify(good))
    expect(loadAreaTimes(path.join(dir, 'good.json'))).toEqual(good)
  })
})

describe('createAreaEstimator', () => {
  const table = { _meta: { areas: ['a', 'b', 'c', 'd'] }, minutes: { 'a|b': 20, 'a|c': 30, 'b|d': 40 } }
  const estimate = createAreaEstimator({ areas: AREAS, table })
  const near = (area, dLat = 0, dLng = 0) => ({ lat: area.lat + dLat, lng: area.lng + dLng })

  it('is the real time between the two nearest areas for two points in different areas, plus a hop at each end', () => {
    expect(estimate(near(AREAS[0]), near(AREAS[1]))).toBeCloseTo(20, 5) // both on their area: just the table
    const a = near(AREAS[0], 0.009, 0) // about 1 km north of A
    const b = near(AREAS[1], 0, -0.009) // about 1 km west of B
    expect(estimate(a, b)).toBeCloseTo(accessMinutes(haversineKm(a, AREAS[0])) + 20 + accessMinutes(haversineKm(b, AREAS[1])), 5)
  })

  it('is the same either way round', () => {
    const p = near(AREAS[0], 0.004), q = near(AREAS[2], 0.004)
    expect(estimate(p, q)).toBeCloseTo(estimate(q, p), 5)
  })

  it('is the least of the straight line and the two hops inside one area, and not capped by the ride to a neighbouring area', () => {
    const x = near(AREAS[0], 0.003), y = near(AREAS[0], -0.003) // about 0.33 km either side of A's centre
    const hops = accessMinutes(haversineKm(x, AREAS[0])) + accessMinutes(haversineKm(y, AREAS[0]))
    expect(estimate(x, y)).toBeCloseTo(Math.min(hops, mockTravelMinutes(x, y)), 9)
    expect(estimate(x, y)).toBeLessThanOrEqual(mockTravelMinutes(x, y))
    // A's shortest trip to another area is 20 (a|b), and a trip of 2.2 km each side of the centre is longer than the hops of a quick
    // neighbour would be: the table's neighbour ride is no cap on it.
    const quick = createAreaEstimator({ areas: AREAS, table: { _meta: { areas: ['a', 'b', 'c', 'd'] }, minutes: { 'a|b': 1, 'a|c': 30 } } })
    const wide = near(AREAS[0], 0.02), other = near(AREAS[0], -0.02)
    expect(quick(wide, other)).toBeCloseTo(Math.min(mockTravelMinutes(wide, other), accessMinutes(haversineKm(wide, AREAS[0])) + accessMinutes(haversineKm(other, AREAS[0]))), 9)
    expect(quick(wide, other)).toBeGreaterThan(10)
  })

  it('uses the straight line for a pair the table lacks', () => {
    expect(estimate(near(AREAS[2]), near(AREAS[3]))).toBe(mockTravelMinutes(near(AREAS[2]), near(AREAS[3]))) // 'c|d' is not in the table
  })

  it('tries the nearest areas at each end for an exact address, and takes the shortest way', () => {
    // P is 0.5 km from A and 0.6 km from B, which is 1.1 km from A. To C the table says 60 from A but only 20 from B.
    const areas = [{ id: 'a', lat: 1.3, lng: 103.8 }, { id: 'b', lat: 1.3, lng: 103.81 }, { id: 'c', lat: 1.3, lng: 103.95 }]
    const best = createAreaEstimator({ areas, table: { _meta: { areas: ['a', 'b', 'c'] }, minutes: { 'a|b': 4, 'a|c': 60, 'b|c': 20 } } })
    const p = { lat: 1.3, lng: 103.8045 }
    const viaB = accessMinutes(haversineKm(p, areas[1])) + 20
    expect(best(p, areas[2])).toBeCloseTo(viaB, 9)
    expect(best(p, areas[2])).toBeLessThan(accessMinutes(haversineKm(p, areas[0])) + 60) // not only through the nearest, A
    expect(best(areas[2], p)).toBeCloseTo(viaB, 9)
  })

  it('has no jump where a point stops being near an area: a far west point is guessed from the table, not the straight line', () => {
    const real = loadPlanData().areas
    const tuas = real.find((a) => a.id === 'tuas-link')
    const bugis = real.find((a) => a.id === 'bugis')
    const withSaved = createAreaEstimator({ areas: real, table: loadAreaTimes() })
    const west = (km) => ({ lat: tuas.lat, lng: tuas.lng - km / 111.2 }) // due west of the westernmost area
    const at = (km) => withSaved(west(km), bugis)
    const step = (km) => Math.abs(at(km + 0.1) - at(km))
    for (const km of [5.9, 6, 8, 11]) expect(step(km), `${km} km`).toBeLessThan(0.1 * ACCESS_MINUTES_PER_KM * 1.01)
    // 8 km west: a hop of 8 km and the table's Tuas Link to Bugis time, a long way below the straight line's figure.
    expect(at(8)).toBeCloseTo(accessMinutes(8) + loadAreaTimes().minutes[pairKey('bugis', 'tuas-link')], 0)
    expect(at(8)).toBeLessThan(mockTravelMinutes(west(8), bugis) - 5)
  })

  it('leaves a session alone: a trip between two area centres is exactly the table\'s time', () => {
    const real = loadPlanData().areas
    const saved = loadAreaTimes()
    const withSaved = createAreaEstimator({ areas: real, table: saved })
    for (const [a, b] of [['bugis', 'tampines'], ['orchard', 'somerset'], ['woodlands', 'harbourfront'], ['clementi', 'paya-lebar']]) {
      const from = real.find((x) => x.id === a), to = real.find((x) => x.id === b)
      expect(withSaved(from, to)).toBe(saved.minutes[pairKey(a, b)])
    }
  })

  it('does not cap a trip inside Orchard at the 2.5 minutes to Somerset: a place a few hundred metres away takes the walk it takes', () => {
    const real = loadPlanData().areas
    const saved = loadAreaTimes()
    const withSaved = createAreaEstimator({ areas: real, table: saved })
    const orchard = real.find((a) => a.id === 'orchard'), somerset = real.find((a) => a.id === 'somerset')
    expect(withSaved(orchard, somerset)).toBe(saved.minutes[pairKey('orchard', 'somerset')]) // the ride, 2.5
    // Points whose nearest area is Orchard, 0.2 to 0.7 km from its centre and from each other.
    for (const [dLat, dLng] of [[0.002, 0], [0.004, -0.004], [-0.002, 0.001], [0.001, 0.003]]) {
      const inside = { lat: orchard.lat + dLat, lng: orchard.lng + dLng }
      expect(real.reduce((best, a) => (haversineKm(inside, a) < haversineKm(inside, best) ? a : best)).id, String([dLat, dLng])).toBe('orchard')
      expect(withSaved(orchard, inside), String([dLat, dLng])).toBeCloseTo(Math.min(mockTravelMinutes(orchard, inside), accessMinutes(haversineKm(inside, orchard))), 9)
      expect(withSaved(inside, orchard)).toBeCloseTo(withSaved(orchard, inside), 9)
    }
    const far = { lat: orchard.lat + 0.004, lng: orchard.lng - 0.004 }, near2 = { lat: orchard.lat - 0.002, lng: orchard.lng + 0.001 }
    expect(withSaved(far, near2)).toBeGreaterThan(5) // two places in the same area are not 2.5 minutes apart
  })

  it('refuses to be made without areas or a table', () => {
    expect(() => createAreaEstimator({ areas: [], table })).toThrow()
    expect(() => createAreaEstimator({ areas: AREAS, table: null })).toThrow()
  })
})

// ---------------------------------------------------------------- the planner uses it
describe('the meeting area ranks and fills in with the table', () => {
  const data = loadPlanData()
  const bugis = data.areas.find((a) => a.id === 'bugis')
  // A table that says every trip takes 90 minutes, except the ones to or from Bugis: 5.
  const minutes = {}
  for (const a of data.areas) for (const b of data.areas) if (a.id < b.id) minutes[pairKey(a.id, b.id)] = a.id === 'bugis' || b.id === 'bugis' ? 5 : 90
  const table = { _meta: { areas: data.areas.map((a) => a.id), dateTime: 'x' }, minutes }
  const members = [
    { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
    { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
    { id: 'jonathan', name: 'Jonathan', home: { lat: 1.437, lng: 103.7865 } },
  ]
  const servers = []
  afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

  it('answers from the table when OneMap is off: the area it makes the best, not the straight line\'s', async () => {
    const without = createPlannerRuns({ data, weatherResolver: null, onemap: null })
    const withTable = createPlannerRuns({ data, weatherResolver: null, onemap: null, areaTimes: table })
    const ask = (runs) => runs.runWithTravel({ members }, data, runs.meetingAreaWithRouting, runs.meetingAreaTravelFor({ members }))
    expect((await ask(without)).result.area.id).not.toBe('bugis')
    expect((await ask(withTable)).result.area.id).toBe('bugis')
  })

  it("routes the table's best areas first when OneMap is on, and leaves the straight line's order alone without a table", async () => {
    const routedWith = async (areaTimes) => {
      const routed = []
      const onemap = { routingEnabled: true, routeMinutes: async (a, b) => { routed.push(a.id ?? b.id); return 20 } }
      const server = createApp({ frontendOrigin: 'http://localhost:5173', planData: data, http: createHttp({ stub: true }), onemap, areaTimes }).listen(0, '127.0.0.1')
      servers.push(server)
      await once(server, 'listening')
      await fetch(`http://127.0.0.1:${server.address().port}/api/meeting-area`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ members, dateTime: '2026-10-27T12:30' }) })
      return new Set(routed)
    }
    expect((await routedWith(table)).has('bugis')).toBe(true)
    expect((await routedWith(null)).has('bugis')).toBe(false)
  })

  it("does not change the engine's answer when no guess is given", () => {
    expect(meetingArea({ members }, data).area.id).toBe(meetingArea({ members }, data, {}).area.id)
    expect(bugis).toBeDefined()
  })
})

// ---------------------------------------------------------------- a table that cannot be trusted
describe('a table with values that cannot be times', () => {
  const t = { _meta: { areas: ['a', 'b', 'c', 'd'] } }
  const pointA = { lat: AREAS[0].lat, lng: AREAS[0].lng }
  const pointB = { lat: AREAS[1].lat, lng: AREAS[1].lng }
  const straight = mockTravelMinutes(pointA, pointB)

  it('is not a table when it is a list, or holds a list', () => {
    expect(isAreaTimes([])).toBe(false)
    expect(isAreaTimes({ ...t, minutes: [1, 2, 3] })).toBe(false)
    expect(isAreaTimes({ ...t, minutes: { 'a|b': 5 } })).toBe(true)
  })

  it('uses the straight line for a pair holding a negative, huge, missing or non-number value', () => {
    for (const bad of [-50, MAX_PLAUSIBLE_MINUTES + 1, 1e9, NaN, Infinity, '20', null, true, {}, []]) {
      const estimate = createAreaEstimator({ areas: AREAS, table: { ...t, minutes: { 'a|b': bad } } })
      expect(estimate(pointA, pointB), String(bad)).toBe(straight)
    }
    const fine = createAreaEstimator({ areas: AREAS, table: { ...t, minutes: { 'a|b': 0 } } })
    expect(fine(pointA, pointB)).toBe(0) // zero is a time (the same station)
  })

  it('says how many of the current areas\' pairs the table covers', () => {
    expect(areaTimesCoverage(AREAS, { ...t, minutes: { 'a|b': 5, 'a|c': 6 } })).toEqual({ found: 2, expected: 6 })
    expect(areaTimesCoverage(AREAS, { ...t, minutes: { 'a|b': -1, 'a|c': 'x' } })).toEqual({ found: 0, expected: 6 })
    expect(areaTimesCoverage([...AREAS, { id: 'e', lat: 1.5, lng: 103.9 }], { ...t, minutes: {} }).expected).toBe(10)
  })
})

describe('the saved table in the repository', () => {
  const planData = loadPlanData()
  const saved = loadAreaTimes()

  it('exists, is a table, and covers every pair of the planner\'s current areas (rebuild it when the areas change)', () => {
    expect(saved).not.toBeNull()
    const { found, expected } = areaTimesCoverage(planData.areas, saved)
    expect(found).toBe(expected)
  })

  it('holds only believable times, in no more pairs than the areas make, and says who made them', () => {
    const values = Object.values(saved.minutes)
    expect(values.every((v) => typeof v === 'number' && v >= 0 && v <= MAX_PLAUSIBLE_MINUTES)).toBe(true)
    expect(values.length).toBeLessThanOrEqual((planData.areas.length * (planData.areas.length - 1)) / 2)
    expect(saved._meta.credit).toBe(creditFor(saved._meta.startedAt ?? saved._meta.builtAt, saved._meta.builtAt))
    expect(saved._meta.credit).toMatch(/OneMap/)
    expect(saved._meta.credit).toContain(`accessed ${singaporeDay(saved._meta.builtAt)}`) // the access date goes with the data
    expect(saved._meta.dateTime).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/)
  })

  it('stores one value for each pair, under its sorted key', () => {
    expect('bugis|tampines' in saved.minutes).toBe(true)
    expect('tampines|bugis' in saved.minutes).toBe(false)
  })
})

describe('the builder\'s flags', () => {
  const now = new Date('2026-10-21T00:00:00Z')

  it('has sensible defaults', () => {
    expect(readFlags([], now)).toEqual({ perMinute: 50, dateTime: '2026-10-27T12:30', limit: Infinity, out: undefined })
    expect(readFlags(['--per-minute', '40', '--date', '2026-11-03T08:00', '--limit', '5', '--out', '/tmp/x.json'], now)).toEqual({ perMinute: 40, dateTime: '2026-11-03T08:00', limit: 5, out: '/tmp/x.json' })
  })

  it('refuses a pace that could hurt the shared OneMap account, and anything that is not a number', () => {
    for (const bad of ['0', '-5', String(MAX_PER_MINUTE + 1), '1000', '1.5', 'fast', 'NaN', '']) expect(() => readFlags(['--per-minute', bad], now), bad).toThrow(/per-minute/)
    expect(() => readFlags(['--per-minute', String(MAX_PER_MINUTE)], now)).not.toThrow()
  })

  it('refuses a date that is not a Singapore date-time, and a limit that is not a whole number', () => {
    for (const bad of ['tomorrow', '2026-10-27', '2026-10-27 12:30', '2026-13-45T25:61', '../../etc/passwd']) expect(() => readFlags(['--date', bad], now), bad).toThrow(/date/)
    for (const bad of ['0', '-1', '2.5', 'many']) expect(() => readFlags(['--limit', bad], now), bad).toThrow(/limit/)
  })

  it('credits OneMap, with the day it was taken, in a table it builds', async () => {
    const file = path.join(tmp(), 'table.json')
    const table = await buildAreaTimes({ areas: AREAS, route: async () => 10, dateTime: '2026-10-27T12:30', file, log: () => {}, wait: async () => {} })
    expect(table._meta.credit).toBe(creditFor(table._meta.startedAt, table._meta.builtAt))
    expect(table._meta.credit).toContain(`accessed ${singaporeDay(new Date().toISOString())}`)
    expect(creditFor('2026-10-21T01:00:00.000Z', '2026-10-21T03:00:00.000Z')).toContain('accessed 2026-10-21.')
    expect(creditFor('2026-10-21T01:00:00.000Z', '2026-10-23T03:00:00.000Z')).toContain('accessed 2026-10-21 to 2026-10-23.') // a build that took days
    expect(singaporeDay('2026-10-21T17:00:00.000Z')).toBe('2026-10-22') // eight hours ahead of UTC
  })

  it('has one default pace, the documents\' 50 a minute, and a help text that says to stop the running server first', () => {
    expect(DEFAULT_PER_MINUTE).toBe(50)
    expect(readFlags([], now).perMinute).toBe(50)
    expect(HELP).toMatch(/STOP THE RUNNING SERVER FIRST/)
    expect(HELP).toMatch(/300/)
    expect(HELP).toMatch(/default 50/)
    expect(fs.readFileSync(new URL('../docs/planner-api.md', import.meta.url), 'utf8')).toContain('paced at 50 a minute')
  })
})

describe('what the table does not touch', () => {
  const data = loadPlanData()
  const table = loadAreaTimes()
  const members = [
    { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
    { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
  ]
  const servers = []
  afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

  // Answers the same request on two apps, one with the table and one without, with OneMap doubles that answer the same way.
  const bothWays = async (path, body) => {
    const answers = []
    for (const areaTimes of [null, table]) {
      const onemap = { routingEnabled: true, routeMinutes: async (a, b) => 10 + Math.round(Math.abs(a.lat - b.lat) * 400 + Math.abs(a.lng - b.lng) * 300) }
      const server = createApp({ frontendOrigin: 'http://localhost:5173', planData: data, http: createHttp({ stub: true }), onemap, areaTimes }).listen(0, '127.0.0.1')
      servers.push(server)
      await once(server, 'listening')
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      answers.push(await res.json())
    }
    return answers
  }

  // The table now times the places a ranking does not route (tests/table-times.test.js), so the numbers and the order may differ from
  // the straight line's. What it must not change is the shape: the same fields, plus `travelSource` on each result and `table` in `travel`.
  it('answers /api/converge and /api/roam with the same fields as without the table, plus where each time came from', async () => {
    const slot = { members, occasion: 'casual_meal', dateTime: '2026-10-27T12:30', durationMinutes: 60, categories: ['eat'], unknownPolicy: 'lenient', topN: 5 }
    const sorted = (o) => Object.keys(o).sort()
    const [without, withTable] = await bothWays('/converge', { ...slot, centre: { lat: 1.3504, lng: 103.8428 } })
    expect(without.status).toBe('ok')
    expect(sorted(withTable)).toEqual(sorted(without))
    expect(withTable.results).toHaveLength(without.results.length)
    expect(sorted(withTable.results[0])).toEqual([...sorted(without.results[0]), 'travelSource'].sort())
    expect(sorted(withTable.travel)).toEqual([...sorted(without.travel), 'table', 'tableAt'].sort())
    const [roamWithout, roamWith] = await bothWays('/roam', { ...slot, current: { lat: 1.3504, lng: 103.8428 } })
    expect(sorted(roamWith)).toEqual(sorted(roamWithout))
    expect(sorted(roamWith.results[0])).toEqual([...sorted(roamWithout.results[0]), 'travelSource'].sort())
  })

  it('answers with the same fields for the meeting area, only the areas it picked may differ', async () => {
    const [without, withTable] = await bothWays('/meeting-area', { members, dateTime: '2026-10-27T12:30', alternatives: 2 })
    expect(Object.keys(withTable).sort()).toEqual([...Object.keys(without), 'travelSource'].sort())
    expect(withTable.candidates).toHaveLength(without.candidates.length)
  })
})

// ---------------------------------------------------------------- how many finalists get real routes
describe('MEETING_FINALISTS (the meetingFinalists option)', () => {
  const planData = loadPlanData()
  const trio = [
    { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
    { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
    { id: 'jonathan', name: 'Jonathan', home: { lat: 1.437, lng: 103.7865 } },
  ]
  const servers = []
  afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

  // An app whose OneMap double answers 20 minutes for every trip and records the trips it was asked for.
  const serve = async (options = {}) => {
    const routed = []
    const onemap = { routingEnabled: true, routeMinutes: async (a, b) => { routed.push(a.id ?? b.id); return 20 } }
    const server = createApp({ frontendOrigin: 'http://localhost:5173', planData, http: createHttp({ stub: true }), onemap, ...options }).listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const ask = async (body) => (await fetch(`http://127.0.0.1:${server.address().port}/api/meeting-area`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json()
    return { ask, areasRouted: () => new Set(routed).size, routedIds: () => new Set(routed), trips: () => routed.length }
  }

  it('routes 5 areas by default, and as many as the server is set to, never more than 12', async () => {
    const dflt = await serve()
    await dflt.ask({ members: trio, dateTime: '2026-10-20T12:30' })
    expect(dflt.areasRouted()).toBe(5)
    const eight = await serve({ meetingFinalists: 8 })
    await eight.ask({ members: trio, dateTime: '2026-10-20T12:30' })
    expect(eight.areasRouted()).toBe(8)
    expect(eight.trips()).toBe(8 * trio.length)
    const huge = await serve({ meetingFinalists: 99 })
    await huge.ask({ members: trio, dateTime: '2026-10-20T12:30' })
    expect(huge.areasRouted()).toBe(12)
  })

  it('still routes at most 60 trips a request, whole areas only', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, home: { lat: 1.3 + i * 0.01, lng: 103.75 + i * 0.015 } }))
    const app = await serve({ meetingFinalists: 12 })
    await app.ask({ members: many, dateTime: '2026-10-20T12:30' })
    expect(app.trips()).toBeLessThanOrEqual(60)
    expect(app.trips() % many.length).toBe(0) // whole areas: every routed area has all ten trips
  })

  it('keeps room for the areas a request names: with 6 members and 12 finalists they are routed, and only the extra finalists lose out', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, home: { lat: 1.3 + i * 0.02, lng: 103.75 + i * 0.03 } }))
    const named = ['tuas-link', 'harbourfront']
    // Twelve finalists would take 72 trips: more than the 60 allowed, so ten whole areas would fill it and the named ones get none.
    const unnamed = await serve({ meetingFinalists: 12 })
    await unnamed.ask({ members: six, dateTime: '2026-10-20T12:30' })
    expect(unnamed.trips()).toBe(60)
    expect(unnamed.areasRouted()).toBe(10)
    const withNamed = await serve({ meetingFinalists: 12 })
    const answer = await withNamed.ask({ members: six, dateTime: '2026-10-20T12:30', include: named })
    expect(answer.candidates.filter((c) => c.source === 'included').map((c) => c.area.id).sort()).toEqual([...named].sort())
    for (const id of named) expect(withNamed.routedIds().has(id), id).toBe(true) // the named areas got real routes
    expect(withNamed.trips()).toBeLessThanOrEqual(60)
    expect(withNamed.trips() % six.length).toBe(0) // whole areas
    expect(withNamed.areasRouted()).toBe(10) // the same 60 trips: two named areas and eight finalists, not ten finalists
    // The first five finalists keep their place: they are routed whether or not areas are named, and they are what the default routes.
    const dflt = await serve({ meetingFinalists: 5 })
    await dflt.ask({ members: six, dateTime: '2026-10-20T12:30' })
    for (const id of dflt.routedIds()) expect(withNamed.routedIds().has(id), id).toBe(true)
  })

  it('with the default 5 finalists, naming areas changes nothing about which finalists are routed', async () => {
    const six = Array.from({ length: 6 }, (_, i) => ({ id: `p${i}`, name: `P${i}`, home: { lat: 1.3 + i * 0.02, lng: 103.75 + i * 0.03 } }))
    const plain = await serve()
    const first = await plain.ask({ members: six, dateTime: '2026-10-20T12:30', alternatives: 2 })
    const naming = await serve()
    const second = await naming.ask({ members: six, dateTime: '2026-10-20T12:30', alternatives: 2, include: ['tuas-link', 'harbourfront'] })
    expect(second.area).toEqual(first.area)
    expect(second.candidates.filter((c) => c.source !== 'included')).toEqual(first.candidates)
    for (const id of plain.routedIds()) expect(naming.routedIds().has(id)).toBe(true)
  })
})
