import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { SCENARIO_HEADER } from '../src/services/scenario.js'

// The planner endpoints over real HTTP, on the joined mock + curated + CDC data.
const FRONTEND = 'http://localhost:5173'
let server, base, stubServer, stubBase

const listen = async (app) => {
  const s = app.listen(0)
  await once(s, 'listening')
  return [s, `http://127.0.0.1:${s.address().port}`]
}

beforeAll(async () => {
  // The plain server still answers its forecast from fixtures: a test must never call data.gov.sg.
  ;[server, base] = await listen(createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }) }))
  ;[stubServer, stubBase] = await listen(createApp({ frontendOrigin: FRONTEND, stub: true }))
})
afterAll(() => Promise.all([server, stubServer].map((s) => new Promise((resolve) => s.close(resolve)))))

const post = async (path, body, { url = base, headers = {} } = {}) => {
  const res = await fetch(`${url}/api${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
  return { status: res.status, body: await res.json() }
}

const TAMPINES = { lat: 1.3541, lng: 103.9446 }
const CLEMENTI = { lat: 1.315, lng: 103.765 }
const WOODLANDS = { lat: 1.437, lng: 103.7865 }
const group = [
  { id: 'ian', name: 'Ian', home: TAMPINES },
  { id: 'faith', name: 'Faith', home: CLEMENTI, dietary: ['Halal'] }, // capital H on purpose
  { id: 'jonathan', name: 'Jonathan', home: WOODLANDS },
]

describe('POST /api/meeting-area', () => {
  it('returns a named area and everyone’s travel time', async () => {
    const { status, body } = await post('/meeting-area', { members: group })
    expect(status).toBe(200)
    expect(body.method).toBe('station')
    expect(typeof body.area.name).toBe('string')
    expect(Object.keys(body.travelByMember).sort()).toEqual(['faith', 'ian', 'jonathan'])
    expect(body.approximate).toBe(false)
  })

  it('accepts the other methods', async () => {
    const { status, body } = await post('/meeting-area', { members: group, method: 'weighted_centroid' })
    expect(status).toBe(200)
    expect(body.method).toBe('weighted_centroid')
  })

  it('rejects a member with no location, and everyone opting out', async () => {
    const noHome = await post('/meeting-area', { members: [{ id: 'x' }] })
    expect(noHome.status).toBe(400)
    expect(noHome.body.issues[0].message).toMatch(/start or a home/)
    const allOut = await post('/meeting-area', { members: group, optedOut: ['ian', 'faith', 'jonathan'] })
    expect(allOut.status).toBe(400)
  })
})

describe('POST /api/converge', () => {
  const slot = {
    members: group,
    occasion: 'casual_meal',
    dateTime: '2026-10-10T12:30',
    durationMinutes: 90,
    categories: ['eat'],
    unknownPolicy: 'lenient',
  }

  it('ranks venues for one slot around a given meeting point', async () => {
    const meet = await post('/meeting-area', { members: group })
    const { status, body } = await post('/converge', { ...slot, centre: meet.body.centre })
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    expect(body.centre).toEqual(meet.body.centre)
    expect(body.results.length).toBeGreaterThan(0)
    for (const r of body.results) {
      expect(r.venue.category).toBe('eat')
      expect(['quiet', 'moderate', 'busy', 'unknown']).toContain(r.crowd)
      expect(Array.isArray(r.dietUnknown)).toBe(true)
      expect(Number.isInteger(r.walkMinutes)).toBe(true)
      expect(r.reasons.length).toBeLessThanOrEqual(2)
      expect(r.warnings).toEqual([]) // clear weather by default
      expect(r.swap).toBeNull()
    }
  })

  it('lowercases dietary needs, so "Halal" works', async () => {
    // Bugis, where hawker centres are known to be likely halal, so strict mode has places to keep.
    const centre = { lat: 1.3008, lng: 103.8559 }
    const capital = await post('/converge', { ...slot, centre, unknownPolicy: 'strict' })
    expect(capital.body.status).toBe('ok')
    expect(capital.body.results.length).toBeGreaterThan(0)
    capital.body.results.forEach((r) => expect(['full', 'options', 'likely']).toContain(r.venue.diet.halal))
    // The same as asking in lower case, and fewer than asking with no need at all.
    const lower = await post('/converge', { ...slot, centre, unknownPolicy: 'strict', members: group.map((m) => (m.dietary ? { ...m, dietary: ['halal'] } : m)) })
    expect(lower.body.results.map((r) => r.venueId)).toEqual(capital.body.results.map((r) => r.venueId))
    const none = await post('/converge', { ...slot, centre, unknownPolicy: 'strict', members: group.map(({ dietary, ...m }) => m) })
    expect(none.body.diagnostics.passedFilters).toBeGreaterThan(capital.body.diagnostics.passedFilters)
  })

  it('answers 400 with every bad field named', async () => {
    const { status, body } = await post('/converge', {
      ...slot,
      occasion: 'brunch',
      dateTime: '2026-10-10 7pm',
      groupConstraints: ['step-free'],
      weights: { worst: -5 },
    })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_input')
    expect(body.issues.map((i) => i.path).sort()).toEqual(['dateTime', 'groupConstraints.0', 'occasion', 'weights.worst'])
  })

  it('rejects weights for a factor Converge does not have', async () => {
    const { status } = await post('/converge', { ...slot, weights: { distance: 10 } })
    expect(status).toBe(400)
  })

  it('answers 400, not 500, for a body that is not JSON', async () => {
    const { status, body } = await post('/converge', '{bad json')
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_json')
  })
})

describe('POST /api/roam', () => {
  it('ranks places near the current point, including shops', async () => {
    const { status, body } = await post('/roam', {
      current: { lat: 1.30065, lng: 103.85585 },
      members: [{ id: 'ian' }],
      occasion: 'casual_meal',
      dateTime: '2026-10-10T15:00',
      categories: ['shop'],
    })
    expect(status).toBe(200)
    expect(body.status).toBe('ok')
    body.results.forEach((r) => expect(r.venue.category).toBe('shop'))
  })

  it('rejects a point outside Singapore (for example lat and lng swapped)', async () => {
    const { status } = await post('/roam', { current: { lat: 103.85, lng: 1.3 }, members: [{ id: 'ian' }], occasion: 'casual_meal', dateTime: '2026-10-10T15:00' })
    expect(status).toBe(400)
  })
})

describe('POST /api/search', () => {
  const search = { centre: { lat: 1.35092, lng: 103.84822 }, dateTime: '2026-10-10T12:30', durationMinutes: 60, categories: ['eat'] }

  it('finds venues and CDC stalls by name, and says whether each fits', async () => {
    const { status, body } = await post('/search', { ...search, query: 'Chicken Rice' })
    expect(status).toBe(200)
    expect(body.results.length).toBeGreaterThan(0)
    expect(body.results.length).toBeLessThanOrEqual(12)
    expect(body.results.some((r) => r.matchedStall)).toBe(true)
    for (const r of body.results) {
      expect(r.fits).toBe(r.unfit.length === 0)
      expect(Number.isInteger(r.walkMinutes)).toBe(true)
    }
    const firstUnfit = body.results.findIndex((r) => !r.fits)
    if (firstUnfit !== -1) expect(body.results.slice(firstUnfit).every((r) => !r.fits)).toBe(true)
  })

  it('rejects an empty query and a missing centre', async () => {
    expect((await post('/search', { ...search, query: '  ' })).status).toBe(400)
    expect((await post('/search', { query: 'rice', dateTime: '2026-10-10T12:30' })).status).toBe(400)
  })
})

describe('stub mode scenarios (for Playwright)', () => {
  const body = { members: group, occasion: 'casual_meal', dateTime: '2026-10-10T19:00', unknownPolicy: 'lenient' }

  it('routing-fail: results still come back, marked approximate', async () => {
    const res = await post('/converge', body, { url: stubBase, headers: { [SCENARIO_HEADER]: 'routing-fail' } })
    expect(res.status).toBe(200)
    if (res.body.status === 'ok') res.body.results.forEach((r) => expect(r.approximate).toBe(true))
    const meet = await post('/meeting-area', { members: group }, { url: stubBase, headers: { [SCENARIO_HEADER]: 'routing-fail' } })
    expect(meet.body.approximate).toBe(true)
  })

  it('rain: the live forecast from the rain fixture, unless the body picks a weather case', async () => {
    const { weatherCases } = loadPlanData()
    const roamBody = { ...body, current: { lat: 1.30065, lng: 103.85585 }, members: [{ id: 'ian' }] }
    // weather penalty = rainRisk x exposure / 5 x 100 (scoring.js weatherPenalty)
    const penalty = (r, rainRisk) => rainRisk * (r.venue.exposure / 5) * 100
    // Live: the dry fixture says "Fair (Day)" everywhere (risk 0), the rain one "Heavy Thundery Showers" (risk 1).
    const checkLive = (res, rainRisk) => {
      expect(res.body.weather.source).toBe('live')
      res.body.results.forEach((r) => expect(r.breakdown.weather.value).toBeCloseTo(penalty(r, rainRisk), 9))
    }
    // Simulated: the old case table, looked up by the venue's region.
    const checkSimulated = (res, weatherCase) => {
      expect(res.body.weather).toEqual({ source: 'simulated', basis: 'simulated' })
      res.body.results.forEach((r) => expect(r.breakdown.weather.value).toBeCloseTo(penalty(r, weatherCases[weatherCase][r.venue.forecastArea].rainRisk), 9))
    }

    const wet = await post('/roam', roamBody, { url: stubBase, headers: { [SCENARIO_HEADER]: 'rain' } })
    expect(wet.body.results.some((r) => r.venue.exposure > 0)).toBe(true) // otherwise this test proves nothing
    checkLive(wet, 1)
    checkLive(await post('/roam', roamBody, { url: stubBase }), 0)
    checkSimulated(await post('/roam', { ...roamBody, weatherCase: 'clear' }, { url: stubBase, headers: { [SCENARIO_HEADER]: 'rain' } }), 'clear')
  })
})

describe('POST /api/converge with a chosen radius', () => {
  const BISHAN = { lat: 1.35092, lng: 103.84822 }
  const slot = { members: group, occasion: 'catch_up', dateTime: '2026-10-10T12:30', categories: ['eat'], centre: BISHAN, unknownPolicy: 'lenient' }
  const km = (a, b) => Math.hypot((a.lat - b.lat) * 111, (a.lng - b.lng) * 111 * Math.cos((a.lat * Math.PI) / 180))

  it('only suggests places inside radiusMeters', async () => {
    const { status, body } = await post('/converge', { ...slot, radiusMeters: 500, topN: 10 })
    expect(status).toBe(200)
    expect(body.results.length).toBeGreaterThan(0)
    for (const r of body.results) expect(km(BISHAN, r.venue)).toBeLessThanOrEqual(0.5)
  })

  it('rejects a radius under 100 m or over 3 km', async () => {
    for (const radiusMeters of [50, 5000]) {
      const { status, body } = await post('/converge', { ...slot, radiusMeters })
      expect(status).toBe(400)
      expect(body.issues[0].path).toBe('radiusMeters')
    }
  })
})

describe('OneMap: travel times and address search', () => {
  const servers = []
  const start = async (options) => {
    const [s, url] = await listen(createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }), ...options }))
    servers.push(s)
    return url
  }
  afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))
  const slot = { members: group, occasion: 'casual_meal', dateTime: '2026-10-10T19:00', unknownPolicy: 'lenient' }

  it('every answer says where its travel times came from', async () => {
    const routed = await post('/converge', slot, { url: stubBase }) // stub routes stand in for OneMap
    expect(routed.body.travel.source).toBe('onemap')
    expect(routed.body.travel.routed).toBeGreaterThan(0)
    const meet = await post('/meeting-area', { members: group }, { url: stubBase })
    expect(meet.body.travel.source).toBe('onemap')
    const plain = await post('/converge', slot) // no OneMap service: the engine's estimate
    expect(plain.body.travel).toEqual({ source: 'estimate', asked: 0, routed: 0, cached: 0, walked: 0, failed: 0, estimated: 0 })
  })

  it('routing-fail: OneMap routes fail, travel falls back to the estimate and results are marked approximate', async () => {
    const res = await post('/converge', slot, { url: stubBase, headers: { [SCENARIO_HEADER]: 'routing-fail' } })
    expect(res.body.travel.source).toBe('estimate')
    // Earlier requests to this server already failed enough calls to pause routing, so some trips are failed
    // calls and the rest were never asked. Together they are every trip.
    expect(res.body.travel.asked).toBeGreaterThan(0)
    expect(res.body.travel.failed + res.body.travel.estimated).toBe(res.body.travel.asked)
    if (res.body.status === 'ok') res.body.results.forEach((r) => expect(r.approximate).toBe(true))
  })

  it('GET /api/places/search: OneMap results, 400 for an empty query, 503 when OneMap is down or not set up', async () => {
    const ok = await fetch(`${stubBase}/api/places/search?q=178879`)
    expect(ok.status).toBe(200)
    expect((await ok.json()).results[0]).toMatchObject({ postal: '178879', lat: expect.any(Number), lng: expect.any(Number) })
    expect((await fetch(`${stubBase}/api/places/search?q=%20`)).status).toBe(400)

    const down = async () => { throw new ExternalApiError('onemap answered 500', { service: 'onemap', status: 500, url: 'x' }) }
    const downUrl = await start({ onemap: { routingEnabled: false, search: down } })
    const res = await fetch(`${downUrl}/api/places/search?q=bishan`)
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('search_unavailable')
    expect((await fetch(`${base}/api/places/search?q=bishan`)).status).toBe(503) // a server with no OneMap service
  })
})

describe('how many options a slot gets (minOptions, shortlistSize)', () => {
  const NEWTON = { lat: 1.31279, lng: 103.83812 }
  const slot = (extra) => ({
    members: group, occasion: 'catch_up', dateTime: '2026-10-10T14:00', durationMinutes: 90, categories: ['activity'],
    centre: NEWTON, unknownPolicy: 'lenient', topN: 20, ...extra,
  })

  it('by default the search stops at the first circle with 3 places, and 10 are scored', async () => {
    const { body } = await post('/converge', slot({}))
    expect(body.results.length).toBeLessThanOrEqual(10)
    expect(body.diagnostics.inRadius).toBeGreaterThanOrEqual(3)
  })

  it('minOptions widens the search until that many fit, and shortlistSize scores more of them', async () => {
    const few = await post('/converge', slot({}))
    const many = await post('/converge', slot({ minOptions: 15, shortlistSize: 20 }))
    expect(many.body.diagnostics.radiusUsed).toBeGreaterThanOrEqual(few.body.diagnostics.radiusUsed)
    expect(many.body.results.length).toBeGreaterThan(few.body.results.length)
    expect(many.body.results.length).toBeLessThanOrEqual(20)
  })

  it('refuses more than 30, or less than 1', async () => {
    expect((await post('/converge', slot({ shortlistSize: 31 }))).status).toBe(400)
    expect((await post('/converge', slot({ minOptions: 0 }))).status).toBe(400)
  })
})
