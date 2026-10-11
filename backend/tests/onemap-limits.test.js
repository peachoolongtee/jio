// Keeps the shared OneMap account safe: the cap on one request, the budget for the whole server, a rejected
// token, a failed login, an outage, and a OneMap that never answers.
// Nothing here touches the network: stub mode answers from tests/fixtures/, and the rest use fake HTTP objects
// and a clock the test moves by hand.
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { mockTravelMinutes } from '../src/planner/geo.js'
import { createCallBudget, MAX_IN_FLIGHT, OneMapUnavailableError } from '../src/services/budget.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import {
  CIRCUIT_OPEN_MS,
  createOneMap,
  LOGIN_RETRY_MS,
  readOneMapSettings,
  ROUTE_FAILURES_TO_OPEN,
} from '../src/services/onemap.js'
import { SCENARIO_HEADER } from '../src/services/scenario.js'
import { MAX_ROUTED_TRIPS_PER_REQUEST, runWithRealTravel } from '../src/services/travel-times.js'

const FRONTEND = 'http://localhost:5173'
const DATE_TIME = '2026-10-10T19:00'
const SECRETS = { email: 'sam.secret@example.org', password: 'hunter2-not-a-real-password', token: 'SECRET-TOKEN' }
const execFileAsync = promisify(execFile)

// ---------------------------------------------------------------- helpers
// Nothing in a log line may carry the account or a token. Every test is checked after it ran.
let warn, error
beforeEach(() => {
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  error = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  const logged = JSON.stringify([...warn.mock.calls, ...error.mock.calls])
  for (const secret of Object.values(SECRETS)) expect(logged).not.toContain(secret)
  warn.mockRestore()
  error.mockRestore()
})

// A clock the test moves by hand.
const makeClock = (start = Date.UTC(2026, 9, 10, 4, 0, 0)) => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

const okRoute = async () => ({ plan: { itineraries: [{ duration: 1800 }] } })
const okLogin = async (n) => ({ access_token: `${SECRETS.token}-${n}`, expiry_timestamp: '4102444800' })
const down = (status = 503) => new ExternalApiError(`onemap answered ${status}`, { service: 'onemap', status, url: 'x' })

// A fake HTTP helper that counts what it is asked. `route(n, authorization)` and `login(n)` answer or throw.
function fakeHttp({ route = okRoute, login = okLogin, delayMs = 0 } = {}) {
  const log = { logins: 0, routes: 0, searches: 0, auths: [], inFlight: 0, peak: 0 }
  const tracked = async (fn) => {
    log.inFlight += 1
    log.peak = Math.max(log.peak, log.inFlight)
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return await fn()
    } finally {
      log.inFlight -= 1
    }
  }
  return {
    log,
    postJson: () => tracked(async () => { log.logins += 1; return login(log.logins) }),
    getJson: (url, options) =>
      tracked(async () => {
        if (!url.includes('/routingsvc/route')) {
          log.searches += 1
          return { results: [] }
        }
        log.routes += 1
        const authorization = options?.headers?.Authorization
        log.auths.push(authorization)
        return route(log.routes, authorization)
      }),
  }
}

const makeOneMap = (http, clock, options = {}) =>
  createOneMap({ http, email: SECRETS.email, password: SECRETS.password, now: clock.now, ...options })

// Trip number i: every one is far enough to need a route and different from the others after rounding.
const trip = (i) => [{ lat: 1.28 + i * 0.0021, lng: 103.7 }, { lat: 1.4, lng: 103.95 }]
const route = (onemap, i) => onemap.routeMinutes(...trip(i), DATE_TIME)
const settle = (promise) => promise.then((value) => ({ value }), (err) => ({ err }))

// A small seeded random generator, so the groups below are the same on every run.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const groupOf = (n, { differentEnds = false, seed = 7 } = {}) => {
  const rand = rng(seed)
  const spot = () => ({ lat: 1.28 + rand() * 0.16, lng: 103.7 + rand() * 0.26 })
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `M${i}`, home: spot(), ...(differentEnds ? { end: spot() } : {}) }))
}

// Three people far apart, who get venues at 19:00 (the same group plan-routes.test.js uses).
const GROUP = [
  { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
  { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
  { id: 'jonathan', name: 'Jonathan', home: { lat: 1.437, lng: 103.7865 } },
]
const GROUP_SLOT = { members: GROUP, occasion: 'casual_meal', dateTime: DATE_TIME, unknownPolicy: 'lenient' }

// Counts the OneMap calls that reach the HTTP layer, in stub mode.
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
  const server = createApp({ frontendOrigin: FRONTEND, ...options }).listen(0)
  servers.push(server)
  await once(server, 'listening')
  return `http://127.0.0.1:${server.address().port}`
}
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

const post = async (base, path, body, headers = {}) => {
  const res = await fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

// The numbers in `travel` must add up.
const addsUp = (t) => expect(t.routed + t.cached + t.walked + t.failed + t.estimated).toBe(t.asked)

// A stub app whose OneMap calls are counted.
async function stubApp() {
  const http = countingStubHttp()
  const onemap = createOneMap({ http, email: SECRETS.email, password: SECRETS.password, stub: true })
  return { base: await startApp({ stub: true, http, onemap }), calls: http.calls }
}

// ---------------------------------------------------------------- the cap on one request
describe('one request spends a bounded number of OneMap calls', () => {
  it('meeting area, 30 members: at most 60 route calls, with the default and with maxCandidates 37', async () => {
    for (const body of [{ members: groupOf(30) }, { members: groupOf(30), maxCandidates: 37 }]) {
      const { base, calls } = await stubApp()
      const res = await post(base, '/meeting-area', body)
      expect(res.status).toBe(200)
      expect(calls.route).toBeGreaterThan(0)
      expect(calls.route).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
      expect(res.body.travel.routed).toBe(calls.route) // routed counts real OneMap answers, one per call
      expect(res.body.travel.asked).toBeGreaterThan(MAX_ROUTED_TRIPS_PER_REQUEST) // the cap really did bite
      expect(res.body.travel.estimated).toBeGreaterThan(0)
      addsUp(res.body.travel)
      expect(res.body.approximate).toBe(true) // some areas were left on estimates
    }
  })

  it('meeting area: only the best few areas by estimate are routed (at most 5)', async () => {
    const { base, calls } = await stubApp()
    const res = await post(base, '/meeting-area', { members: groupOf(3), maxCandidates: 37 })
    expect(res.status).toBe(200)
    expect(calls.route).toBeLessThanOrEqual(5 * 3)
    expect(res.body.travel.estimated).toBeGreaterThan(0)
    addsUp(res.body.travel)
  })

  it('converge, 5 members whose ends differ: at most 60 route calls', async () => {
    const { base, calls } = await stubApp()
    const slot = { occasion: 'date', dateTime: '2026-10-10T14:30', categories: ['eat'], unknownPolicy: 'lenient', topN: 6, centre: { lat: 1.3, lng: 103.84 } }
    const res = await post(base, '/converge', { ...slot, members: groupOf(5, { differentEnds: true }) })
    expect(res.status).toBe(200)
    expect(calls.route).toBeGreaterThan(0)
    expect(calls.route).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    expect(res.body.travel.routed).toBe(calls.route)
    addsUp(res.body.travel)
  })

  it('converge with 30 current options and 30 members: they count toward the same cap', async () => {
    const { base, calls } = await stubApp()
    // Thirty people only fit activity venues, so the slot asks for those.
    const currentOptionIds = loadPlanData().venues.filter((v) => v.category === 'activity').slice(0, 30).map((v) => v.id)
    const slot = { occasion: 'date', dateTime: '2026-10-10T14:30', categories: ['activity'], unknownPolicy: 'lenient', topN: 10, centre: { lat: 1.3, lng: 103.84 }, currentOptionIds }
    const res = await post(base, '/converge', { ...slot, members: groupOf(30, { differentEnds: true }) })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(calls.route).toBeGreaterThan(0)
    expect(calls.route).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    expect(res.body.travel.asked).toBeGreaterThan(MAX_ROUTED_TRIPS_PER_REQUEST)
    addsUp(res.body.travel)
  })

  it('converge, 30 members: whole venues only', async () => {
    const { base, calls } = await stubApp()
    const members = groupOf(30, { differentEnds: true })
    const slot = { occasion: 'date', dateTime: '2026-10-10T14:30', categories: ['activity'], unknownPolicy: 'lenient', topN: 20, centre: { lat: 1.3, lng: 103.84 } }
    const res = await post(base, '/converge', { ...slot, members })
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(calls.route).toBeGreaterThan(0)
    expect(calls.route).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    addsUp(res.body.travel)

    // A venue is real for everyone or estimated for everyone: compare each time with the engine's estimate.
    const byId = new Map(members.map((m) => [m.id, m]))
    const seen = new Set()
    for (const r of res.body.results) {
      const kinds = new Set()
      for (const [id, minutes] of Object.entries(r.travelByMember)) {
        const m = byId.get(id)
        kinds.add(Math.abs(minutes - mockTravelMinutes(m.home, r.venue)) < 1e-9 ? 'estimate' : 'real')
      }
      for (const [id, minutes] of Object.entries(r.returnByMember)) {
        const m = byId.get(id)
        kinds.add(Math.abs(minutes - mockTravelMinutes(r.venue, m.end)) < 1e-9 ? 'estimate' : 'real')
      }
      expect(kinds.size).toBe(1)
      seen.add([...kinds][0])
      expect(r.approximate).toBe(kinds.has('estimate'))
    }
    expect(seen).toEqual(new Set(['estimate', 'real'])) // the test saw both a routed venue and an estimated one
  })

  it('a second identical request is answered from the cache: no calls, nothing counted as routed', async () => {
    const { base, calls } = await stubApp()
    const body = { members: groupOf(3), dateTime: DATE_TIME }
    const first = await post(base, '/meeting-area', body)
    const callsAfterFirst = calls.route
    const second = await post(base, '/meeting-area', body)
    expect(calls.route).toBe(callsAfterFirst)
    expect(second.body.travel.routed).toBe(0)
    expect(second.body.travel.cached).toBeGreaterThan(0)
    addsUp(first.body.travel)
    addsUp(second.body.travel)
  })

  it('a routing-fail request cannot pause routing for the next dry one (the circuit is per scenario)', async () => {
    const { base } = await stubApp()
    const body = GROUP_SLOT
    const failing = await post(base, '/converge', body, { [SCENARIO_HEADER]: 'routing-fail' })
    expect(failing.body.travel.source).toBe('estimate')
    expect(failing.body.travel.failed).toBeGreaterThanOrEqual(ROUTE_FAILURES_TO_OPEN)
    expect(failing.body.travel.estimated + failing.body.travel.failed).toBe(failing.body.travel.asked)
    const dry = await post(base, '/converge', body)
    expect(dry.body.travel.source).toBe('onemap')
    expect(dry.body.travel.routed).toBeGreaterThan(0)
  })
})

describe('runWithRealTravel: whole candidates, in order, up to the cap', () => {
  const member = (i) => ({ lat: 1.3 + i * 0.01, lng: 103.7 })
  const venue = (id, lat) => ({ id, lat, lng: 103.95 })
  // A toy engine: every member to every venue. It returns what it was told for each trip.
  const toyRun = (members, venues) => (deps) =>
    venues.map((v) => members.map((m) => deps.travelMinutes(m, v)))

  it('routes candidates in the engine order and stops at the first that would pass the cap', async () => {
    const members = [0, 1, 2, 3].map(member)
    const venues = [venue('a', 1.31), venue('b', 1.32), venue('c', 1.33), venue('d', 1.34)]
    const onemap = { routingEnabled: true, routeMinutes: vi.fn(async () => 25) }
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, maxTrips: 10, run: toyRun(members, venues) })
    expect(onemap.routeMinutes).toHaveBeenCalledTimes(8) // a and b; c would make 12
    expect(result[0].every((m) => m === 25)).toBe(true)
    expect(result[1].every((m) => m === 25)).toBe(true)
    expect(result[2].every((m) => m === null)).toBe(true) // left to the estimate
    expect(result[3].every((m) => m === null)).toBe(true) // d would fit the cap, but c did not: priority order wins
    expect(travel).toEqual({ source: 'onemap', asked: 16, routed: 8, cached: 0, walked: 0, failed: 0, estimated: 8 })
  })

  it('cached and walked trips are free: they do not count toward the cap and are not counted as routed', async () => {
    const members = [0, 1, 2, 3].map(member)
    const venues = [venue('a', 1.31), venue('b', 1.32), venue('c', 1.33)]
    // Venue a is fully cached; at venue b the first member is close enough to walk; everything else needs a call.
    const peekRoute = (a, b) => {
      const [v, m] = b.id ? [b, a] : [a, b]
      if (v.id === 'a') return { kind: 'cached', minutes: 31 }
      if (v.id === 'b' && m.lat === member(0).lat) return { kind: 'walk', minutes: 4 }
      return { kind: 'call' }
    }
    const onemap = { routingEnabled: true, peekRoute, routeMinutes: vi.fn(async () => 25) }
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, maxTrips: 6, run: toyRun(members, venues) })
    // a: 4 cached, free. b: 1 walked + 3 calls. c: 4 calls would pass 6, so c is estimated.
    expect(onemap.routeMinutes).toHaveBeenCalledTimes(3)
    expect(result[0]).toEqual([31, 31, 31, 31])
    expect(result[1].filter((m) => m === 4)).toHaveLength(1)
    expect(result[2].every((m) => m === null)).toBe(true)
    expect(travel).toEqual({ source: 'onemap', asked: 12, routed: 3, cached: 4, walked: 1, failed: 0, estimated: 4 })
  })

  it('a candidate that alone passes the cap routes nothing, and a later free one is still taken', async () => {
    const members = [0, 1, 2, 3].map(member)
    const venues = [venue('a', 1.31), venue('b', 1.32)]
    const peekRoute = (a, b) => ((b.id ?? a.id) === 'b' ? { kind: 'cached', minutes: 12 } : { kind: 'call' })
    const onemap = { routingEnabled: true, peekRoute, routeMinutes: vi.fn(async () => 25) }
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, maxTrips: 3, run: toyRun(members, venues) })
    expect(onemap.routeMinutes).not.toHaveBeenCalled()
    expect(result[0].every((m) => m === null)).toBe(true)
    expect(result[1]).toEqual([12, 12, 12, 12])
    expect(travel).toEqual({ source: 'onemap', asked: 8, routed: 0, cached: 4, walked: 0, failed: 0, estimated: 4 })
  })

  it('a shortlist routes the best candidates by estimate, at most maxCandidates of them', async () => {
    const members = [0, 1].map(member)
    // Estimated result gets worse with latitude distance from the members: z is the closest, then y, x, w.
    const venues = [venue('w', 1.44), venue('x', 1.4), venue('y', 1.34), venue('z', 1.32)]
    const routed = []
    const onemap = { routingEnabled: true, routeMinutes: vi.fn(async (a, b) => { routed.push(b.id); return 20 }) }
    const { result, travel } = await runWithRealTravel({
      onemap, dateTime: DATE_TIME, rankByEstimate: true, maxCandidates: 2, run: toyRun(members, venues),
    })
    expect([...new Set(routed)].sort()).toEqual(['y', 'z'])
    expect(result[0].every((m) => m === null) && result[1].every((m) => m === null)).toBe(true)
    expect(result[2]).toEqual([20, 20])
    expect(travel).toEqual({ source: 'onemap', asked: 8, routed: 4, cached: 0, walked: 0, failed: 0, estimated: 4 })
  })

  it('a trip OneMap has no route for counts as failed, and an unavailable OneMap leaves the trip to the estimate', async () => {
    const members = [0, 1, 2, 3].map(member)
    const venues = [venue('a', 1.31)]
    const answers = [null, 20, 'unavailable', 'down']
    let n = 0
    const onemap = {
      routingEnabled: true,
      routeMinutes: async () => {
        const answer = answers[n++]
        if (answer === 'unavailable') throw new OneMapUnavailableError('budget_empty', 'used up')
        if (answer === 'down') throw down()
        return answer
      },
    }
    const { travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, run: toyRun(members, venues), concurrency: 1 })
    expect(travel).toEqual({ source: 'onemap', asked: 4, routed: 1, cached: 0, walked: 0, failed: 2, estimated: 1 })
  })

  it('a OneMap that never answers still lets the request answer at the deadline, on estimates', async () => {
    const members = [0, 1].map(member)
    const venues = [venue('a', 1.31), venue('b', 1.32)]
    const onemap = { routingEnabled: true, routeMinutes: () => new Promise(() => {}), reportFallback: vi.fn() }
    const started = Date.now()
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, deadlineMs: 30, run: toyRun(members, venues) })
    expect(Date.now() - started).toBeLessThan(2000)
    expect(result.flat().every((m) => m === null)).toBe(true)
    expect(travel).toEqual({ source: 'estimate', asked: 4, routed: 0, cached: 0, walked: 0, failed: 0, estimated: 4 })
    expect(onemap.reportFallback).toHaveBeenCalledWith('deadline')
  })

  it('an answer that arrives after the deadline is not used', async () => {
    const members = [0].map(member)
    const venues = [venue('a', 1.31), venue('b', 1.32)]
    let release
    const gate = new Promise((resolve) => { release = resolve })
    const onemap = {
      routingEnabled: true,
      routeMinutes: async (a, b) => {
        if (b.id === 'b') await gate
        return 20
      },
    }
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: DATE_TIME, deadlineMs: 30, run: toyRun(members, venues) })
    release()
    expect(result).toEqual([[20], [null]])
    expect(travel).toMatchObject({ asked: 2, routed: 1, estimated: 1 })
  })

  it('a bug (not an API failure) is still not hidden', async () => {
    const onemap = { routingEnabled: true, routeMinutes: async () => { throw new TypeError('bug') } }
    await expect(runWithRealTravel({ onemap, dateTime: DATE_TIME, run: toyRun([member(0)], [venue('a', 1.31)]) })).rejects.toThrow('bug')
  })

  it('the request deadline also holds over HTTP', async () => {
    const hung = { routingEnabled: true, routeMinutes: () => new Promise(() => {}), reportFallback: vi.fn() }
    const base = await startApp({ http: createHttp({ stub: true }), onemap: hung, routingDeadlineMs: 40 })
    const res = await post(base, '/converge', GROUP_SLOT)
    expect(res.status).toBe(200)
    expect(res.body.status).toBe('ok')
    expect(res.body.results.length).toBeGreaterThan(0)
    res.body.results.forEach((r) => expect(r.approximate).toBe(true))
    expect(res.body.travel.source).toBe('estimate')
    expect(res.body.travel.estimated).toBe(res.body.travel.asked)
  })
})

// ---------------------------------------------------------------- one budget for the whole server
describe('the shared call budget', () => {
  it('createCallBudget refuses a bad size', () => {
    for (const bad of [0, -1, 1.5, '240', undefined]) {
      expect(() => createCallBudget({ callsPerMinute: bad })).toThrow(/positive integer/)
    }
  })

  it('refills evenly: half a minute gives back half the calls', async () => {
    const clock = makeClock()
    const budget = createCallBudget({ callsPerMinute: 60, now: clock.now })
    for (let i = 0; i < 60; i += 1) await budget.run(async () => {})
    await expect(budget.run(async () => {})).rejects.toMatchObject({ reason: 'budget_empty' })
    clock.advance(30_000)
    for (let i = 0; i < 30; i += 1) await budget.run(async () => {})
    await expect(budget.run(async () => {})).rejects.toBeInstanceOf(OneMapUnavailableError)
    expect(budget.retryAfterSeconds()).toBe(1)
  })

  it('N + k trips across several requests make exactly N route calls; the rest are estimates; a minute later calls resume', async () => {
    const clock = makeClock()
    const http = fakeHttp()
    const routeBudget = 12
    // One login and routeBudget route calls a minute.
    const onemap = makeOneMap(http, clock, { callsPerMinute: routeBudget + 1 })
    const base = await startApp({ http: createHttp({ stub: true }), onemap })
    const roam = (current) => post(base, '/roam', { current, members: [{ id: 'ian' }], occasion: 'casual_meal', dateTime: '2026-10-10T15:00', categories: ['eat', 'drink', 'activity'] })

    const answers = []
    const places = [{ lat: 1.3521, lng: 103.8198 }, { lat: 1.4382, lng: 103.7891 }, { lat: 1.3331, lng: 103.7436 }, { lat: 1.4043, lng: 103.9021 }]
    for (const current of places) {
      const res = await roam(current)
      expect(res.status).toBe(200)
      addsUp(res.body.travel)
      answers.push(res.body)
    }
    const asked = answers.reduce((n, a) => n + a.travel.asked, 0)
    expect(asked).toBeGreaterThan(routeBudget) // otherwise the test proves nothing
    expect(http.log.routes).toBe(routeBudget) // exactly N calls, however many trips were asked for
    expect(http.log.logins).toBe(1)
    expect(answers.reduce((n, a) => n + a.travel.routed, 0)).toBe(routeBudget)
    expect(answers.reduce((n, a) => n + a.travel.estimated, 0)).toBe(asked - routeBudget - answers.reduce((n, a) => n + a.travel.walked, 0))
    // Some request ran into the empty bucket and kept the estimate for the trips it could not pay for.
    expect(answers.some((a) => a.travel.estimated > 0 && a.results.some((r) => r.approximate))).toBe(true)
    // The last request found the bucket empty: every result is an estimate.
    const last = answers[answers.length - 1]
    expect(last.travel.routed).toBe(0)
    expect(last.results.length).toBeGreaterThan(0)
    expect(last.travel.estimated + last.travel.walked).toBe(last.travel.asked) // nothing was paid for
    expect(last.travel.estimated).toBeGreaterThan(0)
    // A venue next door is walked (no call, so it is still real); the rest are estimates, flagged approximate.
    expect(last.results.some((r) => r.approximate)).toBe(true)

    clock.advance(60_000)
    // Kent Ridge: its candidates are all further than a walk, so they need real routes. (Bugis was used here before,
    // but with the OneMap places added it has ten venues within 400 m, all walked, so no route call was needed.)
    const later = await roam({ lat: 1.2936, lng: 103.7845 })
    expect(later.status).toBe(200)
    expect(later.body.travel.routed).toBeGreaterThan(0)
    expect(http.log.routes).toBeGreaterThan(routeBudget)
  })

  it('at most 6 calls are in flight at once, across two requests running together', async () => {
    const clock = makeClock()
    const http = fakeHttp({ delayMs: 15 })
    const onemap = makeOneMap(http, clock, { callsPerMinute: 1000 })
    const base = await startApp({ http: createHttp({ stub: true }), onemap })
    const roam = (current) => post(base, '/roam', { current, members: [{ id: 'ian' }], occasion: 'casual_meal', dateTime: '2026-10-10T15:00', categories: ['eat', 'drink', 'activity'] })
    const [a, b] = await Promise.all([roam({ lat: 1.3521, lng: 103.8198 }), roam({ lat: 1.3331, lng: 103.7436 })])
    expect(a.body.travel.routed + b.body.travel.routed).toBeGreaterThan(6)
    expect(http.log.peak).toBe(MAX_IN_FLIGHT)
    expect(MAX_IN_FLIGHT).toBe(6)
  })

  it('an empty bucket answers a search 503 search_unavailable with Retry-After, and the budget is shared with routing', async () => {
    const clock = makeClock()
    const http = fakeHttp()
    const onemap = makeOneMap(http, clock, { callsPerMinute: 2 })
    const base = await startApp({ http: createHttp({ stub: true }), onemap })
    expect(await route(onemap, 0)).toBe(30) // a login and a route: both calls of the minute
    const res = await fetch(`${base}/api/places/search?q=bishan`)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('search_unavailable')
    expect(res.headers.get('retry-after')).toMatch(/^[1-9]\d*$/)
    expect(Number(res.headers.get('retry-after'))).toBeLessThanOrEqual(60)
    expect(http.log.searches).toBe(0)

    clock.advance(60_000)
    const ok = await fetch(`${base}/api/places/search?q=bishan`)
    expect(ok.status).toBe(200)
    expect(http.log.searches).toBe(1)
  })

  it('a routing trip with an empty bucket does not wait: it fails at once with budget_empty', async () => {
    const clock = makeClock()
    const http = fakeHttp()
    const onemap = makeOneMap(http, clock, { callsPerMinute: 2 })
    await route(onemap, 0)
    const started = Date.now()
    const { err } = await settle(route(onemap, 1))
    expect(Date.now() - started).toBeLessThan(500)
    expect(err).toBeInstanceOf(OneMapUnavailableError)
    expect(err).toBeInstanceOf(ExternalApiError)
    expect(err.reason).toBe('budget_empty')
    expect(http.log.routes).toBe(1)
  })

  it('stub mode runs the same code with a large default budget', async () => {
    const onemap = createOneMap({ http: createHttp({ stub: true }), stub: true })
    const results = await Promise.all(Array.from({ length: 40 }, (_, i) => route(onemap, i)))
    expect(results.every((m) => m > 0)).toBe(true)
  })
})

// ---------------------------------------------------------------- the login token
describe('the OneMap token', () => {
  it('a 401 on a route call: one new login, then the call is retried once and answered', async () => {
    const clock = makeClock()
    const http = fakeHttp({
      route: async (n, authorization) => {
        if (authorization === `${SECRETS.token}-1`) throw down(401)
        return { plan: { itineraries: [{ duration: 1200 }] } }
      },
    })
    const onemap = makeOneMap(http, clock)
    expect(await route(onemap, 0)).toBe(20)
    expect(http.log.logins).toBe(2) // the first, and exactly one new one
    expect(http.log.routes).toBe(2) // the rejected call and its single retry
    expect(http.log.auths).toEqual([`${SECRETS.token}-1`, `${SECRETS.token}-2`])
    expect(await route(onemap, 1)).toBe(20) // the new token is kept
    expect(http.log.logins).toBe(2)
  })

  it('two concurrent 401s share one login', async () => {
    const clock = makeClock()
    const http = fakeHttp({
      delayMs: 5,
      route: async (n, authorization) => {
        if (authorization === `${SECRETS.token}-1`) throw down(401)
        return okRoute()
      },
    })
    const onemap = makeOneMap(http, clock)
    const [a, b] = await Promise.all([route(onemap, 0), route(onemap, 1)])
    expect([a, b]).toEqual([30, 30])
    expect(http.log.logins).toBe(2)
    expect(http.log.routes).toBe(4) // two rejected, two retried
  })

  it('a token that is rejected again after a fresh login does not cost a login per trip', async () => {
    const clock = makeClock()
    const http = fakeHttp({ route: async () => { throw down(401) } })
    const onemap = makeOneMap(http, clock)
    for (let i = 0; i < 6; i += 1) {
      const { err } = await settle(route(onemap, i))
      expect(err).toBeInstanceOf(ExternalApiError)
    }
    expect(http.log.logins).toBe(2) // the first, and one new one; then the 60 second back-off
    expect(http.log.routes).toBe(2) // the rejected call and its retry; later trips never reach OneMap
    clock.advance(LOGIN_RETRY_MS + 1)
    await settle(route(onemap, 7))
    // After the back-off: one login, a rejection, one more login, a second rejection, and the back-off again.
    expect(http.log.logins).toBe(4)
    await settle(route(onemap, 8))
    expect(http.log.logins).toBe(4)
  })

  it('a failed login is not retried for 60 seconds, however many trips are asked for, and is retried after', async () => {
    const clock = makeClock()
    const http = fakeHttp({ login: async (n) => { if (n === 1) throw down(500); return okLogin(n) } })
    const onemap = makeOneMap(http, clock)
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => settle(route(onemap, i))))
    for (let i = 12; i < 24; i += 1) results.push(await settle(route(onemap, i)))
    expect(http.log.logins).toBe(1)
    expect(http.log.routes).toBe(0)
    results.forEach(({ err }) => {
      expect(err).toBeInstanceOf(OneMapUnavailableError)
      expect(err.reason).toBe('login_failed')
      for (const secret of Object.values(SECRETS)) expect(err.message).not.toContain(secret)
    })

    clock.advance(LOGIN_RETRY_MS - 1)
    await settle(route(onemap, 30))
    expect(http.log.logins).toBe(1)
    clock.advance(2)
    expect(await route(onemap, 31)).toBe(30)
    expect(http.log.logins).toBe(2)
  })

  it('while the login is blocked, routing falls back to the estimate over a whole request', async () => {
    const clock = makeClock()
    const http = fakeHttp({ login: async () => { throw down(401) } })
    const onemap = makeOneMap(http, clock)
    const base = await startApp({ http: createHttp({ stub: true }), onemap })
    for (let i = 0; i < 3; i += 1) {
      const res = await post(base, '/converge', GROUP_SLOT)
      expect(res.status).toBe(200)
      expect(res.body.results.length).toBeGreaterThan(0)
      expect(res.body.travel).toMatchObject({ source: 'estimate', routed: 0, cached: 0, failed: 0 })
      expect(res.body.travel.estimated + res.body.travel.walked).toBe(res.body.travel.asked)
      res.body.results.forEach((r) => expect(r.approximate).toBe(true))
    }
    expect(http.log.logins).toBe(1)
  })

  it('a failed refresh while the old token has not expired keeps the old token', async () => {
    const clock = makeClock()
    const issuedAt = clock.now()
    const expiry = String(Math.floor(issuedAt / 1000) + 3 * 3600) // 3 hours
    const http = fakeHttp({
      login: async (n) => {
        if (n === 1) return { access_token: `${SECRETS.token}-1`, expiry_timestamp: expiry }
        throw down(503)
      },
    })
    const onemap = makeOneMap(http, clock)
    await route(onemap, 0)
    clock.advance(2.5 * 3600 * 1000) // inside the last hour: a refresh is due, the token is still good
    for (let i = 1; i <= 4; i += 1) expect(await route(onemap, i)).toBe(30)
    expect(http.log.logins).toBe(2) // one refresh attempt, then the back-off
    expect(new Set(http.log.auths)).toEqual(new Set([`${SECRETS.token}-1`]))
    clock.advance(30 * 60 * 1000) // now it has expired and cannot be renewed
    clock.advance(LOGIN_RETRY_MS)
    const { err } = await settle(route(onemap, 9))
    expect(err).toBeInstanceOf(ExternalApiError)
  })

  it('a missing or unreadable expiry_timestamp does not cause a login per trip, and warns once', async () => {
    for (const expiry of [undefined, 'soon', '', null, '1']) {
      warn.mockClear()
      const clock = makeClock()
      const http = fakeHttp({ login: async (n) => ({ access_token: `${SECRETS.token}-${n}`, expiry_timestamp: expiry }) })
      const onemap = makeOneMap(http, clock)
      for (let i = 0; i < 6; i += 1) await route(onemap, i)
      expect(http.log.logins).toBe(1)
      expect(warn.mock.calls.filter(([m]) => /expiry_timestamp/.test(m))).toHaveLength(1)
      clock.advance(61 * 60 * 1000) // after the hour it is renewed, and the warning is not repeated
      await route(onemap, 7)
      expect(http.log.logins).toBe(2)
      expect(warn.mock.calls.filter(([m]) => /expiry_timestamp/.test(m))).toHaveLength(1)
    }
  })

  it('a login that answers without a token is an API failure, not a crash', async () => {
    const clock = makeClock()
    const onemap = makeOneMap(fakeHttp({ login: async () => ({}) }), clock)
    await expect(route(onemap, 0)).rejects.toBeInstanceOf(ExternalApiError)
  })

  it('warmUp reports whether a login worked and never throws', async () => {
    const clock = makeClock()
    expect(await makeOneMap(fakeHttp(), clock).warmUp()).toBe(true)
    expect(await makeOneMap(fakeHttp({ login: async () => { throw down(401) } }), clock).warmUp()).toBe(false)
    expect(await makeOneMap(fakeHttp({ login: async () => { throw new TypeError('bug') } }), clock).warmUp()).toBe(false)
    expect(await createOneMap({ http: fakeHttp(), now: clock.now }).warmUp()).toBe(false) // no account
  })
})

// ---------------------------------------------------------------- an outage
describe('the circuit breaker and failed answers', () => {
  it('after 5 failed route calls in a row, no call is made for 30 seconds, and then calls resume', async () => {
    const clock = makeClock()
    const http = fakeHttp({ route: async () => { throw down(503) } })
    const onemap = makeOneMap(http, clock)
    for (let i = 0; i < ROUTE_FAILURES_TO_OPEN; i += 1) {
      const { err } = await settle(route(onemap, i))
      expect(err).toBeInstanceOf(ExternalApiError)
      expect(err).not.toBeInstanceOf(OneMapUnavailableError)
    }
    expect(http.log.routes).toBe(ROUTE_FAILURES_TO_OPEN)

    for (let i = 10; i < 20; i += 1) {
      const { err } = await settle(route(onemap, i))
      expect(err).toBeInstanceOf(OneMapUnavailableError)
      expect(err.reason).toBe('circuit_open')
    }
    expect(http.log.routes).toBe(ROUTE_FAILURES_TO_OPEN) // nothing reached OneMap
    clock.advance(CIRCUIT_OPEN_MS - 1)
    await settle(route(onemap, 21))
    expect(http.log.routes).toBe(ROUTE_FAILURES_TO_OPEN)

    clock.advance(2)
    await settle(route(onemap, 22))
    expect(http.log.routes).toBe(ROUTE_FAILURES_TO_OPEN + 1) // calls resume
  })

  it('a success in between keeps the circuit closed', async () => {
    const clock = makeClock()
    const http = fakeHttp({ route: async (n) => { if (n % 3 === 0) return okRoute(); throw down(503) } })
    const onemap = makeOneMap(http, clock)
    for (let i = 0; i < 30; i += 1) await settle(route(onemap, i))
    expect(http.log.routes).toBe(30)
  })

  it('an answer about one trip (404, no route) does not count toward the circuit', async () => {
    const clock = makeClock()
    const http = fakeHttp({ route: async () => { throw down(404) } })
    const onemap = makeOneMap(http, clock)
    for (let i = 0; i < 12; i += 1) await settle(route(onemap, i))
    expect(http.log.routes).toBe(12)
  })

  it('a failed route is never cached as a travel time', async () => {
    const clock = makeClock()
    const http = fakeHttp({ route: async (n) => { if (n === 1) throw down(503); if (n === 2) return {}; return okRoute() } })
    const onemap = makeOneMap(http, clock)
    await expect(route(onemap, 0)).rejects.toBeInstanceOf(ExternalApiError) // an error status
    await expect(route(onemap, 0)).rejects.toBeInstanceOf(ExternalApiError) // a 200 with no plan at all
    expect(await route(onemap, 0)).toBe(30)
    expect(http.log.routes).toBe(3)
    expect(await route(onemap, 0)).toBe(30) // the real answer is cached
    expect(http.log.routes).toBe(3)
  })

  it('"no route found" is a real answer: null, cached', async () => {
    const clock = makeClock()
    const http = fakeHttp({ route: async () => ({ plan: { itineraries: [] } }) })
    const onemap = makeOneMap(http, clock)
    expect(await route(onemap, 0)).toBeNull()
    expect(await route(onemap, 0)).toBeNull()
    expect(http.log.routes).toBe(1)
    expect(onemap.peekRoute(...trip(0), DATE_TIME)).toEqual({ kind: 'cached', minutes: null })
  })

  it('peekRoute says walk, cached or call, without spending a call', async () => {
    const clock = makeClock()
    const http = fakeHttp()
    const onemap = makeOneMap(http, clock)
    const near = [{ lat: 1.3, lng: 103.85 }, { lat: 1.3005, lng: 103.85 }]
    expect(onemap.peekRoute(...near, DATE_TIME)).toMatchObject({ kind: 'walk' })
    expect(onemap.peekRoute(...trip(0), DATE_TIME)).toEqual({ kind: 'call' })
    await route(onemap, 0)
    expect(onemap.peekRoute(...trip(0), DATE_TIME)).toEqual({ kind: 'cached', minutes: 30 })
    expect(http.log.routes).toBe(1)
    expect(http.log.logins).toBe(1)
  })
})

describe('saying what is happening', () => {
  it('logs a fallback reason at most once a minute, names it, and never carries a credential', async () => {
    const clock = makeClock()
    const http = fakeHttp({ route: async () => { throw down(503) } })
    const onemap = makeOneMap(http, clock)
    for (let i = 0; i < 20; i += 1) await settle(route(onemap, i))
    const lines = () => warn.mock.calls.map(([m]) => m)
    expect(lines().filter((m) => /upstream_error/.test(m))).toHaveLength(1)
    expect(lines().filter((m) => /circuit_open/.test(m))).toHaveLength(1)
    clock.advance(61_000)
    await settle(route(onemap, 30)) // the circuit is closed again after 30 seconds: this call fails and is logged
    expect(lines().filter((m) => /upstream_error/.test(m))).toHaveLength(2)
  })

  it('names the budget, the login and the deadline', async () => {
    const clock = makeClock()
    const onemap = makeOneMap(fakeHttp(), clock, { callsPerMinute: 2 })
    await route(onemap, 0)
    await settle(route(onemap, 1))
    expect(warn.mock.calls.some(([m]) => /budget_empty/.test(m))).toBe(true)
    onemap.reportFallback('deadline')
    onemap.reportFallback('deadline')
    expect(warn.mock.calls.filter(([m]) => /deadline/.test(m))).toHaveLength(1)

    const refused = makeOneMap(fakeHttp({ login: async () => { throw down(401) } }), clock)
    await settle(route(refused, 0))
    expect(warn.mock.calls.some(([m]) => /login_failed/.test(m))).toBe(true)
  })

  it('does not log when routing is simply off (no account)', async () => {
    const clock = makeClock()
    const base = await startApp({ http: createHttp({ stub: true }), onemap: createOneMap({ http: fakeHttp(), now: clock.now }) })
    const res = await post(base, '/converge', GROUP_SLOT)
    expect(res.body.travel).toEqual({ source: 'estimate', asked: 0, routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 })
    expect(warn.mock.calls.filter(([m]) => /OneMap/.test(m))).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- GET /api/places/search input
describe('GET /api/places/search checks q', () => {
  it('answers 400 invalid_input with an issue on q for a missing, empty, blank, array-valued or over-long q', async () => {
    const http = fakeHttp()
    const base = await startApp({ http: createHttp({ stub: true }), onemap: makeOneMap(http, makeClock()) })
    const cases = ['', '?q=', '?q=%20%20', '?q=a&q=b', `?q=${'x'.repeat(81)}`, '?q[a]=1']
    for (const query of cases) {
      const res = await fetch(`${base}/api/places/search${query}`)
      expect(res.status, query).toBe(400)
      const body = await res.json()
      expect(body.error, query).toBe('invalid_input')
      expect(body.issues.map((i) => i.path), query).toContain('q')
    }
    expect(http.log.searches).toBe(0)
    expect(http.log.logins).toBe(0)
  })

  it('answers a good query from the shared OneMap service, and counts it against the budget', async () => {
    const http = fakeHttp()
    const base = await startApp({ http: createHttp({ stub: true }), onemap: makeOneMap(http, makeClock()) })
    const res = await fetch(`${base}/api/places/search?q=${'x'.repeat(80)}`)
    expect(res.status).toBe(200)
    expect(http.log.searches).toBe(1)
  })
})

// ---------------------------------------------------------------- start-up settings
describe('OneMap settings at start-up', () => {
  it('accepts both, neither, and a budget', () => {
    expect(readOneMapSettings({})).toEqual({ email: null, password: null, callsPerMinute: undefined })
    expect(readOneMapSettings({ ONEMAP_EMAIL: '', ONEMAP_PASSWORD: '  ' })).toEqual({ email: null, password: null, callsPerMinute: undefined })
    expect(readOneMapSettings({ ONEMAP_EMAIL: 'a@b.c', ONEMAP_PASSWORD: 'x', ONEMAP_CALLS_PER_MINUTE: '120' })).toEqual({
      email: 'a@b.c',
      password: 'x',
      callsPerMinute: 120,
    })
  })

  it('refuses exactly one of the two, naming the missing variable and never a value', () => {
    const noPassword = readOneMapSettings({ ONEMAP_EMAIL: SECRETS.email })
    expect(noPassword.error).toMatch(/ONEMAP_PASSWORD/)
    const noEmail = readOneMapSettings({ ONEMAP_PASSWORD: SECRETS.password })
    expect(noEmail.error).toMatch(/ONEMAP_EMAIL/)
    for (const { error: message } of [noPassword, noEmail]) {
      for (const secret of Object.values(SECRETS)) expect(message).not.toContain(secret)
    }
  })

  it('counts the example values from .env.example as not set', () => {
    // Both still examples: a fresh copy of .env.example starts, with routing off.
    const both = readOneMapSettings({ ONEMAP_EMAIL: 'you@example.com', ONEMAP_PASSWORD: 'your-onemap-password' })
    expect(both.error).toBeUndefined()
    expect(both.email).toBeNull()
    expect(both.password).toBeNull()
    // One real value beside an example is half an account, and is refused by name.
    expect(readOneMapSettings({ ONEMAP_EMAIL: 'you@example.com', ONEMAP_PASSWORD: 'real-secret' }).error).toMatch(/ONEMAP_EMAIL/)
    expect(readOneMapSettings({ ONEMAP_EMAIL: 'real@x.sg', ONEMAP_PASSWORD: 'your-onemap-password' }).error).toMatch(/ONEMAP_PASSWORD/)
  })

  it('refuses a call budget that is not a whole number above 0', () => {
    for (const bad of ['0', '-5', '1.5', 'many', '1e3x']) {
      const settings = readOneMapSettings({ ONEMAP_CALLS_PER_MINUTE: bad })
      expect(settings.error, bad).toMatch(/ONEMAP_CALLS_PER_MINUTE/)
    }
  })

  it('createOneMap refuses a bad budget too', () => {
    expect(() => createOneMap({ http: fakeHttp(), callsPerMinute: 0 })).toThrow(/positive integer/)
  })

  it('the server exits 1 and names the variables when started with half an account or a bad budget', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'jio-start-')) // No .env here, so nothing is read from the project.
    const entry = fileURLToPath(new URL('../src/index.js', import.meta.url))
    const run = (extra) =>
      execFileAsync(process.execPath, [entry], {
        cwd,
        env: { PATH: process.env.PATH, NODE_OPTIONS: process.env.NODE_OPTIONS ?? '', ...extra },
        timeout: 20_000,
      }).then(() => ({ code: 0, stderr: '' }), (e) => ({ code: e.code, stderr: String(e.stderr) }))
    try {
      const half = await run({ STUB_EXTERNALS: '1', ONEMAP_EMAIL: SECRETS.email })
      expect(half.code).toBe(1)
      expect(half.stderr).toMatch(/ONEMAP_PASSWORD/)
      expect(half.stderr).not.toContain(SECRETS.email)

      const example = await run({ STUB_EXTERNALS: '1', ONEMAP_EMAIL: SECRETS.email, ONEMAP_PASSWORD: 'your-onemap-password' })
      expect(example.code).toBe(1)
      expect(example.stderr).toMatch(/ONEMAP_PASSWORD/)
      expect(example.stderr).not.toContain(SECRETS.email)

      const budget = await run({ STUB_EXTERNALS: '1', ONEMAP_CALLS_PER_MINUTE: 'lots' })
      expect(budget.code).toBe(1)
      expect(budget.stderr).toMatch(/ONEMAP_CALLS_PER_MINUTE/)
    } finally {
      rmSync(cwd, { recursive: true, force: true })
    }
  })
})
