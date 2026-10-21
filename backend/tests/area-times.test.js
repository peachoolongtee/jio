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
import { ACCESS_MINUTES_PER_KM, createAreaEstimator, isAreaTimes, MAX_ACCESS_KM, pairKey } from '../src/planner/area-times.js'
import { meetingArea } from '../src/planner/engine.js'
import { mockTravelMinutes } from '../src/planner/geo.js'
import { buildAreaTimes, nextTuesdayNoon } from '../scripts/build-area-times.js'
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
    const hops = (haversine) => haversine * ACCESS_MINUTES_PER_KM
    expect(estimate(a, b)).toBeCloseTo(hops(1.0) + 20 + hops(0.99), 0)
  })

  it('is the same either way round, and the straight line inside one area', () => {
    const p = near(AREAS[0], 0.004), q = near(AREAS[2], 0.004)
    expect(estimate(p, q)).toBeCloseTo(estimate(q, p), 5)
    const x = near(AREAS[0], 0.003), y = near(AREAS[0], -0.003)
    expect(estimate(x, y)).toBe(mockTravelMinutes(x, y))
  })

  it('falls back to the straight line for a pair the table lacks, and for a point far from every area', () => {
    expect(estimate(near(AREAS[2]), near(AREAS[3]))).toBe(mockTravelMinutes(near(AREAS[2]), near(AREAS[3]))) // 'c|d' is not in the table
    const far = { lat: 1.3, lng: 104.3 } // 40 km east of everything
    expect(estimate(near(AREAS[0]), far)).toBe(mockTravelMinutes(near(AREAS[0]), far))
    expect(MAX_ACCESS_KM).toBe(6)
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
    return { ask, areasRouted: () => new Set(routed).size, trips: () => routed.length }
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
})
