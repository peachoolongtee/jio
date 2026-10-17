import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadPlanData } from '../src/db/venues.js'
import { createWeatherResolver, forecastKindFor, localStartMs, singaporeNow } from '../src/planner/weather-window.js'
import { ExternalApiError } from '../src/services/errors.js'
import { createWeather } from '../src/services/weather.js'
import { at, HOUR, makeWorld, regionalAnswer, shiftTimes, startApp } from './helpers/weather-world.js'
import { loadFixture } from '../src/services/stubs.js'
import { TWO_HOUR_AREAS } from '../src/services/weather-regions.js'

// Which forecast a stop is judged by, from how far away it is: the area forecast within two hours, the regional
// forecast when a period of it covers the stop, otherwise none. All offline: a fake clock and a fake fetch under the
// real createHttp, which counts the calls by URL.

// Tiong Bahru, where an exposed venue and a sheltered one rank close together (see weather.test.js).
const TIONG_BAHRU = { lat: 1.28614, lng: 103.82706 }
const group = [
  { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
  { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
]
const STOP = '2026-10-12T12:30' // A Monday lunch.
const slot = (dateTime = STOP, extra = {}) => ({
  members: group,
  occasion: 'date',
  dateTime,
  categories: ['eat', 'drink'],
  unknownPolicy: 'lenient',
  topN: 12,
  centre: TIONG_BAHRU,
  ...extra,
})

// Clocks that put STOP at a known distance.
const CLOCK = {
  in30Minutes: at('2026-10-12T12:00'),
  in3Hours: at('2026-10-12T09:30'),
  in17Hours: at('2026-10-11T19:30'),
  in30Hours: at('2026-10-11T06:30'),
  inThePast: at('2026-10-13T08:00'),
}

const THUNDER = 'Heavy Thundery Showers'
const servers = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

// A world where both forecasts are storms everywhere, so any use of weather shows.
const stormy = (clock) => makeWorld({ clock, area: 'rain', regional: (c) => regionalAnswer(c, THUNDER) })

const order = (res) => res.body.results.map((r) => [r.venueId, r.score])
const noWeatherEffect = (res) => {
  expect(res.body.results.length).toBeGreaterThan(0)
  for (const r of res.body.results) {
    expect(r.warnings, r.venueId).toEqual([])
    expect(r.swap, r.venueId).toBeNull()
    expect(r.reasons, r.venueId).not.toContain('Indoor')
    expect(r.weather, r.venueId).toEqual({ state: 'unknown', phrase: null, rainLikely: false })
  }
}

describe('forecastKindFor and the clock helpers', () => {
  const now = at('2026-10-12T12:00')

  it('picks the forecast by how far away the start is', () => {
    expect(forecastKindFor('2026-10-12T12:30', now)).toBe('area')
    expect(forecastKindFor('2026-10-12T14:00', now)).toBe('area') // exactly two hours
    expect(forecastKindFor('2026-10-12T14:01', now)).toBe('regional')
    expect(forecastKindFor('2026-10-13T13:00', now)).toBe('regional') // exactly 25 hours
    expect(forecastKindFor('2026-10-13T13:01', now)).toBe('beyond')
  })

  it('treats a start in the past, and no start at all, as now', () => {
    expect(forecastKindFor('2026-10-01T09:00', now)).toBe('area')
    expect(forecastKindFor(undefined, now)).toBe('area')
  })

  it('reads a Singapore local start the same on any machine', () => {
    expect(localStartMs('2026-10-12T12:00')).toBe(at('2026-10-12T12:00'))
    expect(singaporeNow(at('2026-10-12T12:00'))).toBe('2026-10-12T12:00')
    expect(singaporeNow(Date.parse('2026-10-12T23:59:00Z'))).toBe('2026-10-13T07:59')
    expect(localStartMs('soon')).toBeNaN()
  })
})

describe('which forecast a ranking uses', () => {
  const rank = async (clock, dateTime = STOP, options = {}) => {
    const world = options.world ?? stormy(clock)
    const post = await startApp(world, servers, options.app)
    const res = await post('/converge', slot(dateTime, options.extra))
    return { world, res, post }
  }

  it('a stop in 30 minutes: the area forecast, and only that is fetched', async () => {
    const { world, res } = await rank(CLOCK.in30Minutes)
    expect(res.status).toBe(200)
    expect(world.calls).toMatchObject({ area: 1, regional: 0 })
    expect(res.body.weather).toMatchObject({ source: 'live', basis: 'area', phrase: THUNDER })
    expect(res.body.weather.issuedAt).toBe('2026-10-05T09:30:00+08:00')
    expect(res.body.weather.validUntil).toBe('2026-10-05T11:30:00+08:00')
    expect(res.body.results.some((r) => r.warnings.includes('rain'))).toBe(true)
  })

  it('a stop in 3 hours: the regional forecast, and only that is fetched', async () => {
    const { world, res } = await rank(CLOCK.in3Hours)
    expect(world.calls).toMatchObject({ area: 0, regional: 1 })
    expect(res.body.weather).toMatchObject({ source: 'live', basis: 'regional', phrase: THUNDER })
    expect(res.body.weather.issuedAt).toBeTypeOf('string')
    // The covering period's end, not the end of the whole forecast.
    expect(Date.parse(res.body.weather.validUntil)).toBeGreaterThan(at(STOP))
    expect(Date.parse(res.body.weather.validUntil) - at(STOP)).toBeLessThanOrEqual(12 * HOUR)
    expect(res.body.results.some((r) => r.warnings.includes('rain'))).toBe(true)
  })

  it('a stop in 17 hours: the regional forecast covers it', async () => {
    const { world, res } = await rank(CLOCK.in17Hours)
    expect(world.calls).toMatchObject({ area: 0, regional: 1 })
    expect(res.body.weather).toMatchObject({ source: 'live', basis: 'regional' })
  })

  it('a stop in 30 hours: nothing is fetched, and weather has no effect', async () => {
    const { world, res } = await rank(CLOCK.in30Hours)
    expect(world.calls).toMatchObject({ area: 0, regional: 0 })
    expect(res.body.weather).toEqual({ source: 'none', basis: 'none', reason: 'outside_window' })
    noWeatherEffect(res)
  })

  it('a stop already in the past counts as now: the area forecast', async () => {
    const { world, res } = await rank(CLOCK.inThePast)
    expect(world.calls).toMatchObject({ area: 1, regional: 0 })
    expect(res.body.weather.basis).toBe('area')
  })

  it('a start of "no dateTime" counts as now (the resolver, since the routes require a dateTime)', async () => {
    const world = stormy(CLOCK.in3Hours)
    const resolver = createWeatherResolver({ data: loadPlanData(), weather: createWeather({ http: world.http, now: world.now }), now: world.now })
    const resolved = await resolver.resolve({ start: undefined })
    expect(resolved.weather).toMatchObject({ source: 'live', basis: 'area' })
    expect(world.calls).toMatchObject({ area: 1, regional: 0 })
  })

  it('with "no effect" the ranking equals the ranking with weather forced clear', async () => {
    // The forecast is storms everywhere, so any use of it would change the order.
    const clear = await rank(CLOCK.in3Hours, STOP, { app: { allowSimulatedWeather: true }, extra: { weatherCase: 'clear' } })
    const far = await rank(CLOCK.in30Hours)
    const near = await rank(CLOCK.in30Minutes)
    expect(order(far.res)).toEqual(order(clear.res))
    expect(order(near.res)).not.toEqual(order(far.res))
    for (const r of far.res.body.results) expect(r.breakdown.weather.value).toBeLessThanOrEqual(10)
  })

  it('a regional forecast that does not cover the stop leaves weather without effect, and says why', async () => {
    // 20 hours away at 16:30 the day before: the recorded window ends at 12:00 on the 12th.
    const world = makeWorld({ clock: at('2026-10-11T16:30'), regional: shiftTimes(loadFixture('datagov/twenty-four-hr-forecast.real.json'), 0) })
    const post = await startApp(world, servers)
    const res = await post('/converge', slot('2026-10-12T12:30'))
    expect(world.calls.regional).toBe(1)
    expect(res.body.weather).toEqual({ source: 'none', basis: 'none', reason: 'outside_window' })
    noWeatherEffect(res)
  })

  it('"unavailable" still means the forecast could not be fetched, and is a different answer', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const world = makeWorld({ clock: CLOCK.in30Minutes, area: new ExternalApiError('datagov answered 503', { service: 'datagov', status: 503, url: 'x' }) })
    const post = await startApp(world, servers)
    const res = await post('/converge', slot())
    expect(res.status).toBe(200)
    expect(res.body.weather).toEqual({ source: 'unavailable', basis: 'none', reason: 'unavailable' })
    noWeatherEffect(res)
  })
})

describe('venues added later in the request', () => {
  it('places Google venues in forecast areas under the regional forecast, as under the area forecast', async () => {
    // Stub mode: Google answers from its fixture, the forecast from the stubbed regional answer moved to cover now.
    const { createApp } = await import('../src/app.js')
    const { once } = await import('node:events')
    const server = createApp({ frontendOrigin: 'http://localhost:5173', stub: true }).listen(0, '127.0.0.1')
    servers.push(server)
    await once(server, 'listening')
    const stopIn = (hours) => singaporeNow(Date.now() + hours * HOUR)
    const ask = async (hours) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/converge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-jio-scenario': 'rain' },
        body: JSON.stringify({ ...slot(stopIn(hours)), centre: { lat: 1.3521, lng: 103.8448 }, unknownPolicy: 'lenient' }),
      })
      return res.json()
    }
    const area = await ask(1)
    const regional = await ask(5)
    expect(area.weather.basis).toBe('area')
    expect(regional.weather.basis).toBe('regional')
    expect(regional.google.source).toBe('google')
    expect(regional.google.added).toBe(area.google.added)
    const names = new Set(TWO_HOUR_AREAS.map((a) => a.name))
    for (const r of regional.results) expect(names.has(r.venue.forecastArea), r.venueId).toBe(true)
  })
})

describe('the 18 to 24 hour band', () => {
  // NEA issues at about 05:30, 11:30, 17:30 and 23:30; each issue's last period ends 24 hours after the next
  // 6-hour mark. A stop 20 hours away is covered just after an issue and not covered just before the next.
  const real = () => loadFixture('datagov/twenty-four-hr-forecast.real.json') // window 12:00 to 12:00

  it('covers a stop 20 hours away just after an issue', async () => {
    // Issued 11:30 on the 11th: window 12:00 to 12:00. Clock 11:40, stop 20 hours on = 07:40 on the 12th.
    const world = makeWorld({ clock: at('2026-10-11T11:40'), regional: real() })
    const post = await startApp(world, servers)
    const res = await post('/converge', slot('2026-10-12T07:40'))
    expect(res.body.weather.basis).toBe('regional')
  })

  it('does not cover a stop 20 hours away just before the next issue', async () => {
    // Issued 05:30 on the 11th: window 06:00 to 06:00. Clock 11:20, stop 20 hours on = 07:20 on the 12th.
    const world = makeWorld({ clock: at('2026-10-11T11:20'), regional: shiftTimes(real(), -6 * HOUR) })
    const post = await startApp(world, servers)
    const res = await post('/converge', slot('2026-10-12T07:20'))
    expect(res.body.weather).toEqual({ source: 'none', basis: 'none', reason: 'outside_window' })
    expect(world.calls.regional).toBe(1)
  })

  it('covers a stop 17 hours and 59 minutes away at every hour of the day', async () => {
    for (let hour = 0; hour < 24; hour += 1) {
      const clock = at('2026-10-11T00:00') + hour * HOUR + 17 * 60 * 1000
      const world = makeWorld({ clock, regional: (c) => regionalAnswer(c, 'Fair (Day)') })
      const resolver = createWeatherResolver({ data: loadPlanData(), weather: createWeather({ http: world.http, now: world.now }), now: world.now })
      const f = await resolver.forecastFor({ start: singaporeNow(clock + 17 * HOUR + 59 * 60 * 1000) })
      expect(f.basis, `clock hour ${hour}`).toBe('regional')
    }
  })
})

describe('a thundery region', () => {
  it('scores an exposed venue down with a rain warning and an indoor swap, and an indoor venue only carries the state', async () => {
    const clock = CLOCK.in3Hours
    const stormWorld = makeWorld({ clock, regional: (c) => regionalAnswer(c, 'Thundery Showers') })
    const dryWorld = makeWorld({ clock, regional: (c) => regionalAnswer(c, 'Fair (Day)') })
    const storm = await (await startApp(stormWorld, servers))('/converge', slot())
    const dry = await (await startApp(dryWorld, servers))('/converge', slot())

    const exposed = storm.body.results.find((r) => r.venue.setting !== 'indoor' && r.venue.exposure >= 2)
    expect(exposed, 'an exposed venue in the results').toBeTruthy()
    expect(exposed.warnings).toEqual(['rain'])
    expect(exposed.swap).toMatchObject({ venueId: expect.any(String), name: expect.any(String) })
    expect(exposed.swap.weather).toEqual({ state: 'thundery', phrase: 'Thundery Showers', rainLikely: true })
    expect(exposed.weather).toEqual({ state: 'thundery', phrase: 'Thundery Showers', rainLikely: true })
    expect(exposed.breakdown.weather.value).toBeGreaterThan(0)
    const sameInDry = dry.body.results.find((r) => r.venueId === exposed.venueId)
    if (sameInDry) expect(exposed.score).toBeGreaterThan(sameInDry.score)

    const indoor = storm.body.results.find((r) => r.venue.setting === 'indoor')
    expect(indoor, 'an indoor venue in the results').toBeTruthy()
    expect(indoor.weather).toEqual({ state: 'thundery', phrase: 'Thundery Showers', rainLikely: true })
    expect(indoor.warnings).toEqual([])
    expect(indoor.swap).toBeNull()
    expect(indoor.reasons.length).toBeLessThanOrEqual(2)

    expect(dry.body.results.every((r) => r.weather.state === 'dry' && !r.weather.rainLikely)).toBe(true)
  })

  it('gives each venue the forecast of its own region, and the western ones alone get the storm', async () => {
    const { TWO_HOUR_AREAS } = await import('../src/services/weather-regions.js')
    const clock = CLOCK.in3Hours
    const world = makeWorld({ clock, regional: (c) => regionalAnswer(c, { west: 'Thundery Showers' }) })
    const res = await (await startApp(world, servers))('/converge', slot(STOP, { centre: { lat: 1.33, lng: 103.74 }, topN: 20 }))
    const states = new Set()
    for (const r of res.body.results) {
      let best = TWO_HOUR_AREAS[0]
      let bestD = Infinity
      for (const a of TWO_HOUR_AREAS) {
        const d = (a.lat - r.venue.lat) ** 2 + (a.lng - r.venue.lng) ** 2
        if (d < bestD) [best, bestD] = [a, d]
      }
      states.add(r.weather.state)
      // Squared degrees are a fair stand-in for distance at this latitude: any disagreement with haversine is at
      // the boundary of two areas of the same region, so check the region the venue's area is in.
      expect(r.weather.state === 'thundery', `${r.name} near ${best.name} (${best.region})`).toBe(best.region === 'west')
    }
    expect(states.has('thundery')).toBe(true)
  })
})

describe('simulation', () => {
  it('"rain" for a stop next week gives marks and a swap when allowed, and fetches nothing', async () => {
    const world = makeWorld({ clock: at('2026-10-05T09:00') })
    const post = await startApp(world, servers, { allowSimulatedWeather: true })
    const res = await post('/converge', slot('2026-10-12T12:30', { weatherCase: 'rain' }))
    expect(res.body.weather).toEqual({ source: 'simulated', basis: 'simulated' })
    expect(world.calls).toMatchObject({ area: 0, regional: 0 })
    const warned = res.body.results.filter((r) => r.warnings.includes('rain'))
    expect(warned.length).toBeGreaterThan(0)
    expect(warned[0].swap).toBeTruthy()
    expect(warned[0].swap.weather).toMatchObject({ rainLikely: true, phrase: null })
    expect(warned[0].weather).toEqual({ state: 'showers', phrase: null, rainLikely: true })
  })

  it('is ignored and flagged when not allowed, so a stop next week has no weather effect', async () => {
    const world = makeWorld({ clock: at('2026-10-05T09:00') })
    const post = await startApp(world, servers)
    const res = await post('/converge', slot('2026-10-12T12:30', { weatherCase: 'rain' }))
    expect(res.status).toBe(200)
    expect(res.body.weather).toEqual({ source: 'none', basis: 'none', reason: 'outside_window', simulationIgnored: true })
    noWeatherEffect(res)
  })

  it('"clear" simulated shows dry and no marks', async () => {
    const world = makeWorld({ clock: at('2026-10-05T09:00') })
    const post = await startApp(world, servers, { allowSimulatedWeather: true })
    const res = await post('/converge', slot('2026-10-12T12:30', { weatherCase: 'clear' }))
    expect(res.body.results.every((r) => r.warnings.length === 0 && r.weather.state === 'dry')).toBe(true)
  })

  it('/roam gets the new fields too', async () => {
    const world = stormy(CLOCK.in30Minutes)
    const post = await startApp(world, servers)
    const res = await post('/roam', { ...slot(), members: [{ id: 'ian' }], current: TIONG_BAHRU, centre: undefined })
    expect(res.status).toBe(200)
    expect(res.body.weather).toMatchObject({ source: 'live', basis: 'area' })
    expect(res.body.results.every((r) => r.weather.state === 'thundery')).toBe(true)
  })
})

describe('the regional forecast is cached', () => {
  it('ten rankings for tomorrow make one regional call, and a call resumes when the cache expires', async () => {
    const world = makeWorld({ clock: CLOCK.in17Hours })
    const post = await startApp(world, servers)
    for (let i = 0; i < 10; i += 1) expect((await post('/converge', slot())).body.weather.basis).toBe('regional')
    expect(world.calls).toMatchObject({ area: 0, regional: 1 })

    world.clock += 10 * 60 * 1000 - 1
    await post('/converge', slot())
    expect(world.calls.regional).toBe(1)

    world.clock += 1
    await post('/converge', slot())
    expect(world.calls.regional).toBe(2)
  })

  it('shares one request between rankings that arrive together', async () => {
    const world = makeWorld({ clock: CLOCK.in17Hours })
    const post = await startApp(world, servers)
    await Promise.all(Array.from({ length: 6 }, () => post('/converge', slot())))
    expect(world.calls.regional).toBe(1)
  })

  it('fetches again when the cached forecast has run out of periods', async () => {
    const world = makeWorld({ clock: at('2026-10-11T17:40') })
    const post = await startApp(world, servers)
    await post('/converge', slot('2026-10-12T09:00'))
    expect(world.calls.regional).toBe(1)
    // Seven minutes on is inside the cache; but if the clock jumps past the end of the last period, it is stale.
    world.clock = at('2026-10-12T18:30')
    await post('/converge', slot('2026-10-12T21:00'))
    expect(world.calls.regional).toBe(2)
  })
})

describe('when the regional forecast cannot be used', () => {
  const timeout = () => new DOMException('The operation timed out', 'TimeoutError')
  const noPeriods = (c) => {
    const payload = regionalAnswer(c, 'Fair (Day)')
    payload.data.records[0].periods = []
    return payload
  }
  const onlyEnded = (c) => regionalAnswer(c - 48 * HOUR, 'Fair (Day)')
  const cases = {
    'a 500 answer': { status: 500 },
    'a timeout': timeout(),
    'malformed JSON': { text: '{"code": 0, "data": ' },
    'an HTML page': { text: '<html>maintenance</html>' },
    'zero periods': noPeriods,
    'only periods that have ended': onlyEnded,
    'a body of the wrong shape': { code: 0, data: { records: [{ periods: 'nope' }] } },
  }

  for (const [name, regional] of Object.entries(cases)) {
    it(`${name}: 200, no weather effect, "unavailable", one log line a minute at most`, async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const world = makeWorld({ clock: CLOCK.in3Hours, regional })
      const post = await startApp(world, servers)
      const lines = () => warn.mock.calls.filter((c) => String(c[0]).startsWith('Weather unavailable'))

      for (let i = 0; i < 4; i += 1) {
        const res = await post('/converge', slot())
        expect(res.status).toBe(200)
        expect(res.body.status).toBe('ok')
        expect(res.body.weather).toEqual({ source: 'unavailable', basis: 'none', reason: 'unavailable' })
        noWeatherEffect(res)
      }
      // Four requests inside the 30-second failure memory: one fetch, one log line.
      expect(world.calls.regional).toBe(1)
      expect(world.calls.area).toBe(0) // Never falls back to the area forecast.
      expect(lines()).toHaveLength(1)

      // 31 seconds on, it asks again and fails again, but the minute has not passed: still one line.
      world.clock += 31_000
      await post('/converge', slot())
      expect(world.calls.regional).toBe(2)
      expect(lines()).toHaveLength(1)

      // A minute after the first line, the next failure is logged.
      world.clock += 31_000
      await post('/converge', slot())
      expect(lines()).toHaveLength(2)
    })
  }

  it('recovers when the forecast comes back, without waiting for the cache', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const world = makeWorld({ clock: CLOCK.in3Hours, regional: { status: 503 } })
    const post = await startApp(world, servers)
    expect((await post('/converge', slot())).body.weather.reason).toBe('unavailable')
    world.regional = (c) => regionalAnswer(c, 'Fair (Day)')
    world.clock += 30_000
    expect((await post('/converge', slot())).body.weather.basis).toBe('regional')
  })

  it('does not hide a bug: an error that is not an API failure answers 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const world = makeWorld({ clock: CLOCK.in3Hours })
    const http = { getJson: async () => Promise.reject(new TypeError('bug')) }
    const post = await startApp(world, servers, { http })
    expect((await post('/converge', slot())).status).toBe(500)
  })
})

describe('time zones', () => {
  // The same comparison under two TZ values. The machine's zone must play no part: Singapore start times are
  // read with Date.UTC, and the forecast's times carry +08:00.
  const answer = async () => {
    const world = makeWorld({ clock: at('2026-10-11T16:10'), area: 'rain', regional: (c) => regionalAnswer(c, 'Thundery Showers') })
    const resolver = createWeatherResolver({ data: loadPlanData(), weather: createWeather({ http: world.http, now: world.now }), now: world.now })
    const starts = ['2026-10-11T16:40', '2026-10-11T19:10', '2026-10-12T09:10', '2026-10-12T22:10', '2026-10-10T09:00']
    const out = []
    for (const start of starts) {
      const f = await resolver.forecastFor({ start })
      out.push([start, forecastKindFor(start, world.now()), f.basis, f.validUntil ?? null, f.reason ?? null])
    }
    return { out, offset: new Date(2026, 9, 12, 12, 0).getTimezoneOffset(), singapore: singaporeNow(world.now()) }
  }

  it('gives the same answer under Asia/Singapore and America/Los_Angeles, and the zone really changed', async () => {
    const original = process.env.TZ
    try {
      process.env.TZ = 'Asia/Singapore'
      const sg = await answer()
      process.env.TZ = 'America/Los_Angeles'
      const la = await answer()
      expect(sg.offset).toBe(-480)
      expect(la.offset).toBe(420)
      expect(la.out).toEqual(sg.out)
      expect(la.singapore).toBe(sg.singapore)
      expect(sg.out.map((r) => r[2])).toEqual(['area', 'regional', 'regional', 'none', 'area'])
    } finally {
      if (original === undefined) delete process.env.TZ
      else process.env.TZ = original
    }
  })
})
