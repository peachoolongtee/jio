import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { ExternalApiError } from '../src/services/errors.js'
import { createHttp } from '../src/services/http.js'

// Requests built to keep the server busy or break ranking. Every one must be refused quickly.
// Before the limits existed, 800 distinct group constraints (a 15 kB body) blocked the server for 79 seconds.
const FRONTEND = 'http://localhost:5173'
let server, base

beforeAll(async () => {
  // Requests that pass validation reach the planner, which reads the forecast. Answer it from fixtures.
  server = createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }) }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

// Sends a request and reports the status, the parsed body and how long it took.
const send = async (path, body, { method = 'POST' } = {}) => {
  const started = performance.now()
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body),
  })
  const text = await res.text()
  let json = null
  try {
    json = JSON.parse(text)
  } catch {
    // Left as null, so a test can assert that the answer was JSON.
  }
  return { status: res.status, json, ms: performance.now() - started }
}

const group = [
  { id: 'ian', home: { lat: 1.3541, lng: 103.9446 } },
  { id: 'faith', home: { lat: 1.315, lng: 103.765 } },
  { id: 'jonathan', home: { lat: 1.437, lng: 103.7865 } },
]
const valid = { members: group, occasion: 'catch_up', dateTime: '2026-10-10T19:00' }
const many = (n, make) => Array.from({ length: n }, (_, i) => make(i))
const pathsOf = (r) => r.json.issues.map((i) => i.path)

describe('planner input limits', () => {
  it('still accepts what the app sends', async () => {
    const r = await send('/api/converge', {
      ...valid,
      categories: ['eat'],
      currentOptionIds: many(6, (i) => `venue-${i}`),
      weights: { worst: 25, mean: 5, occasion: 25, preference: 10, weather: 12, price: 8, cdc: 3, antiRepeat: 2, crowd: 20 },
      radiusMeters: 1000,
      topN: 10,
    })
    expect(r.status).toBe(200)
  })

  it('refuses a rating weight: the score has no rating term, so there is nothing to weigh', async () => {
    const converge = await send('/api/converge', { ...valid, weights: { worst: 25, rating: 10 } })
    expect(converge.status).toBe(400)
    expect(converge.json.error).toBe('invalid_input')
    expect(pathsOf(converge)).toContain('weights.rating')
    const roamBody = { ...valid, current: group[0].home, members: [{ id: 'ian' }] }
    expect((await send('/api/roam', { ...roamBody, weights: { distance: 20 } })).status).toBe(200) // the same request without rating
    const roam = await send('/api/roam', { ...roamBody, weights: { distance: 20, rating: 10 } })
    expect(roam.status).toBe(400)
    expect(roam.json.error).toBe('invalid_input')
    expect(pathsOf(roam)).toContain('weights.rating')
  })

  it('refuses more than 4 categories', async () => {
    const r = await send('/api/converge', { ...valid, categories: ['eat', 'drink', 'shop', 'activity', 'eat'] })
    expect(r.status).toBe(400)
    expect(pathsOf(r)).toContain('categories')
  })

  it('accepts repeated categories', async () => {
    const r = await send('/api/converge', { ...valid, categories: ['eat', 'eat', 'eat'] })
    expect(r.status).toBe(200)
  })

  it('refuses hundreds of group constraints at once, quickly', async () => {
    const r = await send('/api/converge', { ...valid, groupConstraints: many(800, (i) => `max_price_pp:${i}`) })
    expect(r.status).toBe(400)
    expect(pathsOf(r)).toContain('groupConstraints')
    expect(r.ms).toBeLessThan(1000)
  })

  it('stays fast at the largest allowed number of constraints', async () => {
    // max_price_pp:0 rejects every venue, which is what triggers the "what could we relax?" pass.
    const r = await send('/api/converge', { ...valid, groupConstraints: many(10, (i) => `max_price_pp:${i}`) })
    expect(r.status).toBe(200)
    expect(r.ms).toBeLessThan(1000)
  })

  it('accepts the id of every saved place as a current option, the longest OneMap ids included', async () => {
    // A saved OneMap place's id carries its address; the longest are 86 characters, over the 80 of other ids.
    const longest = 'onemap_ssot_hawkercentres_marine-parade-central-blk-84-84-marine-parade-central-market'
    expect(longest.length).toBeGreaterThan(80)
    const r = await send('/api/converge', { ...valid, categories: ['eat'], currentOptionIds: [longest], excludeVenueIds: [longest] })
    expect(r.status).toBe(200)
    const tooLong = await send('/api/converge', { ...valid, currentOptionIds: ['x'.repeat(121)] })
    expect(tooLong.status).toBe(400)
  })

  it('refuses a long list of current options, which would each be routed', async () => {
    const r = await send('/api/converge', { ...valid, currentOptionIds: many(500, (i) => `venue-${i}`) })
    expect(r.status).toBe(400)
    expect(pathsOf(r)).toContain('currentOptionIds')
  })

  it('refuses a long list of excluded venues', async () => {
    const r = await send('/api/converge', { ...valid, excludeVenueIds: many(5000, (i) => `venue-${i}`) })
    expect(r.status).toBe(400)
    expect(pathsOf(r)).toContain('excludeVenueIds')
  })

  it('refuses weights large enough to overflow the score', async () => {
    const r = await send('/api/converge', { ...valid, weights: { worst: 1e308, mean: 1e308 } })
    expect(r.status).toBe(400)
    expect(pathsOf(r)).toEqual(expect.arrayContaining(['weights.worst', 'weights.mean']))
  })

  it('never returns a score that is not a number', async () => {
    const r = await send('/api/converge', { ...valid, weights: { worst: 1000, mean: 1000, occasion: 1000 } })
    expect(r.status).toBe(200)
    for (const result of r.json.results) expect(Number.isFinite(result.score)).toBe(true)
  })

  it('refuses over-long ids, names and constraint numbers', async () => {
    const long = 'x'.repeat(500)
    const r = await send('/api/converge', {
      ...valid,
      members: [{ id: long, name: long, home: group[0].home }],
      groupConstraints: ['max_price_pp:123456789'],
    })
    expect(r.status).toBe(400)
    expect(pathsOf(r)).toEqual(expect.arrayContaining(['members.0.id', 'members.0.name', 'groupConstraints.0']))
  })

  it('refuses long per-member lists', async () => {
    const r = await send('/api/roam', {
      ...valid,
      current: group[0].home,
      members: [{ id: 'ian', cuisineLikes: many(100, (i) => `c${i}`) }],
    })
    expect(r.status).toBe(400)
    expect(pathsOf(r)).toContain('members.0.cuisineLikes')
  })

  it('applies the same limits to meeting-area and search', async () => {
    const area = await send('/api/meeting-area', { members: group, optedOut: many(100, (i) => `p${i}`) })
    expect(area.status).toBe(400)
    const search = await send('/api/search', {
      query: 'food',
      centre: group[0].home,
      dateTime: valid.dateTime,
      groupConstraints: many(50, (i) => `near_mrt:${i}`),
    })
    expect(search.status).toBe(400)
    expect(pathsOf(search)).toContain('groupConstraints')
  })
})

describe('errors are always JSON', () => {
  it('answers 413 for a body over 100 kB', async () => {
    const r = await send('/api/converge', { ...valid, excludeVenueIds: many(30000, (i) => `venue-id-${i}`) })
    expect(r.status).toBe(413)
    expect(r.json.error).toBe('too_large')
  })

  it('answers another client mistake from the body parser with its own status, as JSON', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await fetch(`${base}/api/converge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'content-encoding': 'bogus' },
      body: JSON.stringify(valid),
    })
    expect(res.status).toBe(415)
    expect(await res.json()).toEqual({ error: 'bad_request', message: 'The request could not be read.' })
    expect(errorLog).not.toHaveBeenCalled()
    errorLog.mockRestore()
  })

  it('answers 500, not the upstream status, when an external API error escapes a route', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const app = createApp({
      frontendOrigin: FRONTEND,
      mount: (a) =>
        a.get('/probe', () => {
          throw new ExternalApiError('onemap answered 401', { service: 'onemap', status: 401, url: 'https://onemap.test/route' })
        }),
    }).listen(0, '127.0.0.1')
    await once(app, 'listening')
    try {
      const res = await fetch(`http://127.0.0.1:${app.address().port}/probe`)
      expect(res.status).toBe(500)
      expect(await res.json()).toEqual({ error: 'server_error', message: 'Something went wrong on the server.' })
      expect(errorLog).toHaveBeenCalledTimes(1)
    } finally {
      await new Promise((resolve) => app.close(resolve))
      errorLog.mockRestore()
    }
  })

  it('answers 404 as JSON for an address that does not exist', async () => {
    const unknown = await send('/api/nope', {})
    expect(unknown.status).toBe(404)
    expect(unknown.json.error).toBe('not_found')

    const wrongMethod = await send('/api/converge', null, { method: 'GET' })
    expect(wrongMethod.status).toBe(404)
    expect(wrongMethod.json.error).toBe('not_found')
  })
})
