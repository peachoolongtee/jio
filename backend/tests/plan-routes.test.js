import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { createHttp } from '../src/services/http.js'
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
    const { body } = await post('/converge', { ...slot, unknownPolicy: 'strict' })
    expect(['ok', 'empty']).toContain(body.status)
    if (body.status === 'ok') body.results.forEach((r) => expect(['full', 'options', 'likely']).toContain(r.venue.diet.halal))
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
      expect(res.body.weather).toEqual({ source: 'simulated' })
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
