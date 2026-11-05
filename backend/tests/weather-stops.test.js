import { afterEach, describe, expect, it, vi } from 'vitest'
import { SCENARIO_HEADER } from '../src/services/scenario.js'
import { at, makeWorld, regionalAnswer, startApp } from './helpers/weather-world.js'

// POST /api/weather/stops: the weather at the stops of a plan. Offline, with a fake clock and a fake fetch.

const NOW = at('2026-10-11T16:10')
const servers = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

const TAMPINES = { lat: 1.3545, lng: 103.9453 } // Tampines, in the east.
const CLEMENTI = { lat: 1.315, lng: 103.765 } // Clementi, in the west.
const stop = (id, start, extra = {}) => ({ id, point: CLEMENTI, start, ...extra })

// Storms in the west and centre only, so the stops show where they are.
const westStorm = (c) => regionalAnswer(c, { west: 'Thundery Showers', central: 'Thundery Showers', east: 'Fair (Day)' })
const world = (options = {}) => makeWorld({ clock: NOW, area: 'rain', regional: westStorm, ...options })

describe('POST /api/weather/stops', () => {
  it('answers each stop with the forecast it is judged by: now, tomorrow and next week', async () => {
    const w = world()
    const post = await startApp(w, servers)
    const res = await post('/weather/stops', {
      stops: [
        stop('soon', '2026-10-11T17:00', { setting: 'outdoor', exposure: 5 }),
        stop('tomorrow', '2026-10-12T09:00', { setting: 'outdoor', exposure: 5 }),
        { ...stop('tomorrow-east', '2026-10-12T09:00', { setting: 'outdoor', exposure: 5 }), point: TAMPINES },
        stop('tomorrow-indoor', '2026-10-12T09:00', { setting: 'indoor', exposure: 0 }),
        stop('next-week', '2026-10-18T12:00', { setting: 'outdoor', exposure: 5 }),
      ],
    })
    expect(res.status).toBe(200)
    const by = Object.fromEntries(res.body.stops.map((s) => [s.id, s]))
    expect(res.body.stops.map((s) => s.id)).toEqual(['soon', 'tomorrow', 'tomorrow-east', 'tomorrow-indoor', 'next-week'])

    expect(by.soon).toMatchObject({ basis: 'area', state: 'thundery', phrase: 'Heavy Thundery Showers', rainLikely: true, rainWarning: true })
    expect(by.soon.issuedAt).toBe('2026-10-05T09:30:00+08:00')
    expect(by.tomorrow).toMatchObject({ basis: 'regional', state: 'thundery', phrase: 'Thundery Showers', rainLikely: true, rainWarning: true })
    // The east is dry in the same period: the same time, another region.
    expect(by['tomorrow-east']).toMatchObject({ basis: 'regional', state: 'dry', phrase: 'Fair (Day)', rainLikely: false, rainWarning: false })
    // Rain over an indoor stop carries the state and no warning.
    expect(by['tomorrow-indoor']).toMatchObject({ basis: 'regional', state: 'thundery', rainLikely: true, rainWarning: false })
    expect(by['next-week']).toEqual({ id: 'next-week', basis: 'none', reason: 'outside_window', state: 'unknown', phrase: null, rainLikely: false, rainWarning: false })

    expect(res.body.weather).toMatchObject({ source: 'live', basis: 'mixed' })
    expect(res.body.weather.issuedAt).toBeTypeOf('string')
    // At most one call per forecast kind, however many stops.
    expect(w.calls).toMatchObject({ area: 1, regional: 1 })
  })

  it('earns a rain warning only by the planner\'s rule: rain likely, not indoor, exposure of 2 or more', async () => {
    const post = await startApp(world(), servers)
    const start = '2026-10-12T09:00'
    const res = await post('/weather/stops', {
      stops: [
        stop('a', start, { setting: 'outdoor', exposure: 2 }),
        stop('b', start, { setting: 'mixed', exposure: 1.9 }),
        stop('c', start, { setting: 'mixed', exposure: 4 }),
        stop('d', start, { setting: 'indoor', exposure: 5 }),
        stop('e', start),
      ],
    })
    expect(Object.fromEntries(res.body.stops.map((s) => [s.id, s.rainWarning]))).toEqual({ a: true, b: false, c: true, d: false, e: false })
  })

  it('gives the top-level block of one kind when every stop shares it', async () => {
    const post = await startApp(world(), servers)
    const res = await post('/weather/stops', { stops: [stop('a', '2026-10-12T09:00'), stop('b', '2026-10-12T05:00')] })
    expect(res.body.weather).toMatchObject({ source: 'live', basis: 'regional', phrase: 'Thundery Showers' })
    expect(res.body.weather.validUntil).toBeTypeOf('string')

    const far = await post('/weather/stops', { stops: [stop('a', '2026-10-30T09:00')] })
    expect(far.body.weather).toEqual({ source: 'none', basis: 'none', reason: 'outside_window' })
  })

  it('degrades to "no effect" when the forecast fails, and still answers 200', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const w = world({ regional: { status: 503 } })
    const post = await startApp(w, servers)
    const res = await post('/weather/stops', { stops: [stop('a', '2026-10-12T09:00'), stop('b', '2026-10-12T05:00'), stop('c', '2026-10-11T16:30')] })
    expect(res.status).toBe(200)
    expect(res.body.stops.map((s) => [s.basis, s.reason ?? null])).toEqual([['none', 'unavailable'], ['none', 'unavailable'], ['area', null]])
    expect(res.body.weather).toMatchObject({ source: 'live', basis: 'mixed' })
    // Never the area forecast for a stop the regional one should cover: one area call, for the stop that is near.
    expect(w.calls).toMatchObject({ area: 1, regional: 1 })
  })

  it('reports an unavailable forecast as the source when nothing at all could be fetched', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const post = await startApp(world({ regional: { status: 503 } }), servers)
    const res = await post('/weather/stops', { stops: [stop('a', '2026-10-12T09:00')] })
    expect(res.body.weather).toEqual({ source: 'unavailable', basis: 'none', reason: 'unavailable' })
  })

  describe('weatherCase', () => {
    it('applies at any date when simulated weather is allowed, and fetches nothing', async () => {
      const w = world()
      const post = await startApp(w, servers, { allowSimulatedWeather: true })
      const res = await post('/weather/stops', {
        weatherCase: 'rain',
        stops: [stop('now', '2026-10-11T16:30', { exposure: 5, setting: 'outdoor' }), stop('week', '2026-10-18T12:00', { exposure: 5, setting: 'outdoor' })],
      })
      expect(res.body.stops.every((s) => s.basis === 'simulated' && s.state === 'showers' && s.rainWarning === true && s.phrase === null)).toBe(true)
      expect(res.body.weather).toEqual({ source: 'simulated', basis: 'simulated' })
      expect(w.calls).toMatchObject({ area: 0, regional: 0 })
    })

    it('is ignored and flagged when not allowed, never refused', async () => {
      const post = await startApp(world(), servers)
      const res = await post('/weather/stops', { weatherCase: 'rain', stops: [stop('week', '2026-10-18T12:00')] })
      expect(res.status).toBe(200)
      expect(res.body.weather).toEqual({ source: 'none', basis: 'none', reason: 'outside_window', simulationIgnored: true })
    })

    it('is allowed in stub mode, where the scenario header picks the live fixture', async () => {
      const w = world()
      const post = await startApp(w, servers, { stub: true })
      const body = { stops: [stop('a', '2026-10-11T16:30', { exposure: 5, setting: 'outdoor' })] }
      const simulated = await post('/weather/stops', { ...body, weatherCase: 'rain' })
      expect(simulated.body.weather.basis).toBe('simulated')
      const live = await post('/weather/stops', body, { [SCENARIO_HEADER]: 'rain' })
      expect(live.body.weather).toMatchObject({ source: 'live', basis: 'area', phrase: 'Heavy Thundery Showers' })
    })

    it('still reports a bad weatherCase as a field error', async () => {
      const post = await startApp(world(), servers)
      const res = await post('/weather/stops', { weatherCase: 'storm', stops: [stop('a', '2026-10-12T09:00')] })
      expect(res.status).toBe(400)
      expect(res.body.issues.map((i) => i.path)).toEqual(['weatherCase'])
    })
  })

  describe('stub mode', () => {
    it('answers a stop tomorrow from the stubbed regional forecast, whatever the time of day', async () => {
      const post = await startApp(world(), servers, { stub: true, now: undefined, http: undefined })
      const startOf = (hours) => new Date(Date.now() + hours * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 16)
      const res = await post(
        '/weather/stops',
        { stops: [stop('a', startOf(5)), stop('b', startOf(17))] },
        { [SCENARIO_HEADER]: 'rain' },
      )
      expect(res.body.stops.map((s) => [s.basis, s.state])).toEqual([['regional', 'thundery'], ['regional', 'thundery']])
      const dry = await post('/weather/stops', { stops: [stop('a', startOf(5))] })
      expect(dry.body.stops[0]).toMatchObject({ basis: 'regional', state: 'dry', phrase: expect.stringContaining('Partly Cloudy') })
    })
  })

  describe('bounds', () => {
    const post = async () => startApp(world(), servers)
    const ok = stop('a', '2026-10-12T09:00')
    const invalid = (res, ...paths) => {
      expect(res.status).toBe(400)
      expect(res.body.error).toBe('invalid_input')
      expect(res.body.message).toBeTypeOf('string')
      for (const path of paths) expect(res.body.issues.map((i) => i.path)).toContain(path)
    }

    it('accepts 8 stops and refuses 9', async () => {
      const p = await post()
      const stops = (n) => Array.from({ length: n }, (_, i) => stop(`s${i}`, '2026-10-12T09:00'))
      expect((await p('/weather/stops', { stops: stops(8) })).status).toBe(200)
      invalid(await p('/weather/stops', { stops: stops(9) }), 'stops')
    })

    it('refuses no stops, a missing body, and repeated ids', async () => {
      const p = await post()
      invalid(await p('/weather/stops', { stops: [] }), 'stops')
      invalid(await p('/weather/stops', {}), 'stops')
      invalid(await p('/weather/stops', { stops: [ok, ok] }), 'stops')
    })

    it('refuses a point outside Singapore, including swapped latitude and longitude', async () => {
      const p = await post()
      invalid(await p('/weather/stops', { stops: [{ ...ok, point: { lat: 51.5, lng: -0.12 } }] }), 'stops.0.point.lat', 'stops.0.point.lng')
      invalid(await p('/weather/stops', { stops: [{ ...ok, point: { lat: 103.8, lng: 1.3 } }] }), 'stops.0.point.lat')
      invalid(await p('/weather/stops', { stops: [{ ...ok, point: { lat: 1.3 } }] }), 'stops.0.point.lng')
    })

    it('refuses a bad time', async () => {
      const p = await post()
      for (const start of ['tomorrow', '2026-10-12', '2026-10-12T25:00', '2026-10-12T09:00:00+08:00', '']) {
        invalid(await p('/weather/stops', { stops: [{ ...ok, start }] }), 'stops.0.start')
      }
      invalid(await p('/weather/stops', { stops: [{ id: 'a', point: ok.point }] }), 'stops.0.start')
    })

    it('refuses an exposure outside 0 to 5 and a setting that is not one of three', async () => {
      const p = await post()
      invalid(await p('/weather/stops', { stops: [{ ...ok, exposure: 6 }] }), 'stops.0.exposure')
      invalid(await p('/weather/stops', { stops: [{ ...ok, exposure: -1 }] }), 'stops.0.exposure')
      invalid(await p('/weather/stops', { stops: [{ ...ok, setting: 'underwater' }] }), 'stops.0.setting')
      expect((await p('/weather/stops', { stops: [{ ...ok, exposure: 5, setting: 'mixed' }, { ...ok, id: 'b', exposure: 0 }] })).status).toBe(200)
    })

    it('refuses an id that is empty or too long', async () => {
      const p = await post()
      invalid(await p('/weather/stops', { stops: [{ ...ok, id: '' }] }), 'stops.0.id')
      invalid(await p('/weather/stops', { stops: [{ ...ok, id: 'x'.repeat(81) }] }), 'stops.0.id')
    })

    it('answers 404 in the flat error shape for a GET', async () => {
      const w = world()
      const server = (await import('../src/app.js')).createApp({ frontendOrigin: 'http://localhost:5173', http: w.http, now: w.now }).listen(0, '127.0.0.1')
      servers.push(server)
      await new Promise((resolve) => server.once('listening', resolve))
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/weather/stops`)
      expect(res.status).toBe(404)
      expect(Object.keys(await res.json()).sort()).toEqual(['error', 'message'])
    })
  })

  describe('rate limit', () => {
    it('is under the same limit as the planner routes, and the two count together', async () => {
      const post = await startApp(world(), servers, { planRateLimit: { windowMs: 60_000, max: 3 } })
      const body = { stops: [stop('a', '2026-10-12T09:00')] }
      expect((await post('/weather/stops', body)).status).toBe(200)
      expect((await post('/search', { query: 'chicken', centre: CLEMENTI, dateTime: '2026-10-12T12:00' })).status).toBe(200)
      expect((await post('/weather/stops', body)).status).toBe(200)
      const refused = await post('/weather/stops', body)
      expect(refused.status).toBe(429)
      expect(refused.body.error).toBe('rate_limited')
      expect(refused.headers.get('retry-after')).toBeTruthy()
      expect((await post('/converge', {})).status).toBe(429)
    })

    it('does not limit anything when the app has no limit', async () => {
      const post = await startApp(world(), servers)
      for (let i = 0; i < 10; i += 1) expect((await post('/weather/stops', { stops: [stop('a', '2026-10-12T09:00')] })).status).toBe(200)
    })
  })

  it('does not rank anything or suggest a swap', async () => {
    const post = await startApp(world(), servers)
    const res = await post('/weather/stops', { stops: [stop('a', '2026-10-12T09:00', { exposure: 5, setting: 'outdoor' })] })
    expect(Object.keys(res.body).sort()).toEqual(['stops', 'weather'])
    expect(res.body.stops[0]).not.toHaveProperty('swap')
    expect(res.body.stops[0]).not.toHaveProperty('score')
  })
})
