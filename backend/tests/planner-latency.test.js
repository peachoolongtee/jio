import { once } from 'node:events'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createHttp } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'
import { createPlannerRuns } from '../src/services/planner-runs.js'
import {
  readRoutingDeadline,
  ROUTING_DEADLINE_MAX_MS,
  ROUTING_DEADLINE_MIN_MS,
  ROUTING_DEADLINE_MS,
  runWithRealTravel,
} from '../src/services/travel-times.js'

// How long a person waits on the planner: sample data that never routes (`travel: 'estimate'`), the short wait for OneMap
// (ROUTING_DEADLINE_MS), and what a OneMap that answers late changes (nothing).
// No call leaves this machine: OneMap answers from the stub fixtures, or from the fakes below.

const FRONTEND = 'http://localhost:5173'
const DATE_TIME = '2026-10-10T19:00'

// Counts the OneMap calls that reach the HTTP layer, in stub mode (the same stand-in onemap-limits.test.js uses).
function countingStubHttp() {
  const real = createHttp({ stub: true })
  const calls = { route: 0, login: 0 }
  return {
    calls,
    getJson: (url, options) => {
      if (url.includes('/routingsvc/route')) calls.route += 1
      return real.getJson(url, options)
    },
    postJson: (url, body, options) => {
      if (url.includes('getToken')) calls.login += 1
      return real.postJson(url, body, options)
    },
  }
}

const servers = []
async function startApp(options) {
  const server = createApp({ frontendOrigin: FRONTEND, roundPlannerMinutes: false, ...options }).listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))
afterEach(() => vi.useRealTimers())

const post = async (base, path, body) => {
  const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
  return { status: res.status, body: await res.json() }
}

// Three people far apart (the group plan-routes.test.js uses).
const GROUP = [
  { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
  { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
  { id: 'jonathan', name: 'Jonathan', home: { lat: 1.437, lng: 103.7865 } },
]
const CENTRE = { lat: 1.3521, lng: 103.8198 }
const REQUESTS = {
  '/meeting-area': { members: GROUP, method: 'station', alternatives: 2, dateTime: DATE_TIME },
  '/converge': { members: GROUP, occasion: 'casual_meal', dateTime: DATE_TIME, unknownPolicy: 'lenient', centre: CENTRE, categories: ['eat'] },
  '/roam': { members: [{ id: 'ian' }], occasion: 'casual_meal', dateTime: '2026-10-10T15:00', categories: ['eat'], current: CENTRE },
}

// A stub app whose OneMap calls are counted.
async function stubApp(options = {}) {
  const http = countingStubHttp()
  const onemap = createOneMap({ http, email: 'someone@example.test', password: 'not-a-real-password', stub: true })
  return { base: await startApp({ stub: true, http, onemap, ...options }), calls: http.calls }
}

describe("travel: 'estimate' makes no OneMap call", () => {
  it.each(Object.keys(REQUESTS))('%s answers from the estimate and never asks OneMap', async (path) => {
    const { base, calls } = await stubApp()
    const res = await post(base, path, { ...REQUESTS[path], travel: 'estimate' })
    expect(res.status).toBe(200)
    expect(res.body.travel).toEqual({ source: 'estimate', asked: 0, routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 })
    expect(calls).toEqual({ route: 0, login: 0 })
  })

  it('a seeded run of many requests, one after another, counts 0 OneMap calls', async () => {
    const { base, calls } = await stubApp()
    for (let round = 0; round < 3; round += 1) {
      for (const path of Object.keys(REQUESTS)) {
        const res = await post(base, path, { ...REQUESTS[path], travel: 'estimate' })
        expect(res.status).toBe(200)
      }
    }
    expect(calls.route).toBe(0)
    expect(calls.login).toBe(0)
  })

  it('the same requests without it, or with travel: live, are routed as they always were', async () => {
    for (const extra of [{}, { travel: 'live' }]) {
      const { base, calls } = await stubApp()
      const res = await post(base, '/converge', { ...REQUESTS['/converge'], ...extra })
      expect(res.status).toBe(200)
      expect(res.body.travel.source).toBe('onemap')
      expect(res.body.travel.routed).toBeGreaterThan(0)
      expect(calls.route).toBeGreaterThan(0)
    }
  })

  it('the meeting area is the one a server with no OneMap picks, and it is not shortlisted down to 16 areas', async () => {
    const { base, calls } = await stubApp()
    const bare = await startApp({ http: createHttp({ stub: true }) })
    const estimated = await post(base, '/meeting-area', { ...REQUESTS['/meeting-area'], travel: 'estimate' })
    const without = await post(bare, '/meeting-area', REQUESTS['/meeting-area'])
    expect(estimated.body.area).toEqual(without.body.area)
    expect(estimated.body.travelByMember).toEqual(without.body.travelByMember)
    expect(estimated.body.candidates).toEqual(without.body.candidates)
    expect(calls.route).toBe(0)
  })

  it('refuses a value that is not one of the two words', async () => {
    const { base, calls } = await stubApp()
    for (const path of Object.keys(REQUESTS)) {
      for (const travel of ['fast', 'ESTIMATE', true, 1, null, ['estimate']]) {
        const res = await post(base, path, { ...REQUESTS[path], travel })
        expect(res.status, `${path} ${JSON.stringify(travel)}`).toBe(400)
        expect(res.body.error).toBe('invalid_input')
        expect(res.body.issues.map((i) => i.path)).toContain('travel')
      }
    }
    expect(calls.route).toBe(0)
  })
})

describe('the routing deadline', () => {
  const member = (i) => ({ lat: 1.3 + i * 0.01, lng: 103.7 })
  const venue = (id, lat) => ({ id, lat, lng: 103.95 })
  const toyRun = (members, venues) => (deps) => venues.map((v) => members.map((m) => deps.travelMinutes(m, v)))

  it('is 3 seconds unless the server says otherwise, between a floor and a ceiling', () => {
    expect(ROUTING_DEADLINE_MS).toBe(3000)
    expect(ROUTING_DEADLINE_MIN_MS).toBeLessThan(ROUTING_DEADLINE_MS)
    expect(ROUTING_DEADLINE_MAX_MS).toBeGreaterThan(ROUTING_DEADLINE_MS)
  })

  it('the planner waits for 3 seconds by default and not a moment longer (fake timers)', async () => {
    vi.useFakeTimers()
    const hung = { routingEnabled: true, routeMinutes: () => new Promise(() => {}), reportFallback: vi.fn() }
    const runs = createPlannerRuns({ data: { areas: [] }, weatherResolver: null, onemap: hung })
    const members = [member(0)]
    let settled = null
    const run = runs.runWithTravel({ dateTime: DATE_TIME }, {}, (_input, _data, deps) => [deps.travelMinutes(members[0], venue('a', 1.31))])
    run.then((out) => { settled = out })
    await vi.advanceTimersByTimeAsync(ROUTING_DEADLINE_MS - 1)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled.travel).toMatchObject({ source: 'estimate', asked: 1, routed: 0, estimated: 1 })
    expect(hung.reportFallback).toHaveBeenCalledWith('deadline')
  })

  it('a server setting changes the wait', async () => {
    vi.useFakeTimers()
    const hung = { routingEnabled: true, routeMinutes: () => new Promise(() => {}), reportFallback: vi.fn() }
    const runs = createPlannerRuns({ data: { areas: [] }, weatherResolver: null, onemap: hung, routingDeadlineMs: 1200 })
    let settled = null
    runs.runWithTravel({ dateTime: DATE_TIME }, {}, (_input, _data, deps) => [deps.travelMinutes(member(0), venue('a', 1.31))]).then((out) => { settled = out })
    await vi.advanceTimersByTimeAsync(1199)
    expect(settled).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(settled).not.toBeNull()
  })

  it('a request returns at the deadline with the slow trips estimated, and a late answer changes nothing', async () => {
    // Two trips per round answer at once; the rest take 400 ms. With a deadline of 100 ms the request must not wait for them.
    const members = [0].map(member)
    const venues = ['a', 'b', 'c', 'd'].map((id, i) => venue(id, 1.31 + i * 0.01))
    const answered = []
    const onemap = {
      routingEnabled: true,
      reportFallback: vi.fn(),
      routeMinutes: async (_a, b) => {
        if (b.id === 'c' || b.id === 'd') await new Promise((resolve) => setTimeout(resolve, 400))
        answered.push(b.id)
        return 20
      },
    }
    const started = Date.now()
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, deadlineMs: 100, concurrency: 4, run: toyRun(members, venues) })
    const waited = Date.now() - started
    expect(waited).toBeGreaterThanOrEqual(90)
    expect(waited).toBeLessThan(350)
    expect(result).toEqual([[20], [20], [null], [null]])
    expect(travel).toEqual({ source: 'onemap', asked: 4, routed: 2, cached: 0, walked: 0, failed: 0, estimated: 2 })
    expect(onemap.reportFallback).toHaveBeenCalledWith('deadline')
    // The slow answers arrive after the request was answered. The answer already given is a snapshot: it does not move.
    const before = JSON.stringify({ result, travel })
    await new Promise((resolve) => setTimeout(resolve, 450))
    expect(answered.sort()).toEqual(['a', 'b', 'c', 'd'])
    expect(JSON.stringify({ result, travel })).toBe(before)
  })

  it('over HTTP the slow trips come back estimated and flagged approximate', async () => {
    const slow = {
      routingEnabled: true,
      reportFallback: vi.fn(),
      routeMinutes: () => new Promise((resolve) => setTimeout(() => resolve(25), 600)),
    }
    const base = await startApp({ http: createHttp({ stub: true }), onemap: slow, routingDeadlineMs: 80 })
    const started = Date.now()
    const res = await post(base, '/converge', REQUESTS['/converge'])
    expect(Date.now() - started).toBeLessThan(550)
    expect(res.status).toBe(200)
    expect(res.body.travel.source).toBe('estimate')
    expect(res.body.travel.estimated).toBe(res.body.travel.asked)
    res.body.results.forEach((r) => expect(r.approximate).toBe(true))
  })
})

describe('ROUTING_DEADLINE_MS in the environment', () => {
  it('blank or missing means the default', () => {
    expect(readRoutingDeadline({})).toEqual({})
    expect(readRoutingDeadline({ ROUTING_DEADLINE_MS: '' })).toEqual({})
    expect(readRoutingDeadline({ ROUTING_DEADLINE_MS: '  ' })).toEqual({})
  })

  it('takes a whole number of milliseconds from the floor to the ceiling', () => {
    expect(readRoutingDeadline({ ROUTING_DEADLINE_MS: '5000' })).toEqual({ deadlineMs: 5000 })
    expect(readRoutingDeadline({ ROUTING_DEADLINE_MS: String(ROUTING_DEADLINE_MIN_MS) })).toEqual({ deadlineMs: ROUTING_DEADLINE_MIN_MS })
    expect(readRoutingDeadline({ ROUTING_DEADLINE_MS: String(ROUTING_DEADLINE_MAX_MS) })).toEqual({ deadlineMs: ROUTING_DEADLINE_MAX_MS })
  })

  it('refuses anything else, naming the variable and never the value', () => {
    for (const bad of ['0', '-3000', '999', '15001', '2500.5', 'soon', '3s', '1e3', 'Infinity', 'NaN']) {
      const { error, deadlineMs } = readRoutingDeadline({ ROUTING_DEADLINE_MS: bad })
      expect(deadlineMs, bad).toBeUndefined()
      expect(error, bad).toMatch(/^ROUTING_DEADLINE_MS must be a whole number/)
      expect(error).not.toMatch(/\d+s\b|soon|NaN|Infinity/)
    }
  })
})
