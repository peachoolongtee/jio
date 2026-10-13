import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { LIVE_WEATHER_CASE, withLiveWeather } from '../src/planner/live-weather.js'
import { ExternalApiError } from '../src/services/errors.js'
import { createHttp } from '../src/services/http.js'
import { runWithScenario, SCENARIO_HEADER } from '../src/services/scenario.js'
import { loadFixture } from '../src/services/stubs.js'
import {
  createWeather,
  KNOWN_FORECASTS,
  normaliseForecast,
  parseTwoHourForecast,
  rainRiskOf,
  TWO_HR_FORECAST_URL,
  UNKNOWN_RAIN_RISK,
} from '../src/services/weather.js'

// Everything here is offline: the forecast comes from backend/tests/fixtures/datagov/ or from a fake.
const FRONTEND = 'http://localhost:5173'
const FIVE_MINUTES = 5 * 60 * 1000

const dryFixture = () => loadFixture('datagov/two-hr-forecast.dry.json')
const rainFixture = () => loadFixture('datagov/two-hr-forecast.rain.json')

// Wraps an HTTP helper and counts the calls that go through it.
const counting = (inner) => {
  const http = { calls: 0, getJson: (...args) => ((http.calls += 1), inner.getJson(...args)) }
  return http
}

const apiDown = () => new ExternalApiError('datagov answered 503', { service: 'datagov', status: 503, url: TWO_HR_FORECAST_URL })

// A forecast payload in data.gov.sg's shape with chosen sentences, for the areas in `forecasts`.
const payloadWith = (forecasts) => {
  const payload = dryFixture()
  payload.data.items[0].forecasts = Object.entries(forecasts).map(([area, forecast]) => ({ area, forecast }))
  return payload
}

describe('parseTwoHourForecast', () => {
  it('reads the fixture into 47 areas, each with coordinates and a rain risk', () => {
    const forecast = parseTwoHourForecast(dryFixture())
    expect(forecast.areas).toHaveLength(47)
    for (const a of forecast.areas) {
      expect(typeof a.area).toBe('string')
      expect(a.lat).toBeGreaterThan(1.1)
      expect(a.lat).toBeLessThan(1.5)
      expect(a.lng).toBeGreaterThan(103.5)
      expect(a.lng).toBeLessThan(104.1)
      expect(typeof a.forecast).toBe('string')
      expect(a.rainRisk).toBeGreaterThanOrEqual(0)
      expect(a.rainRisk).toBeLessThanOrEqual(1)
    }
    expect(forecast.areas[0]).toEqual({ area: 'Ang Mo Kio', lat: 1.375, lng: 103.839, forecast: 'Fair (Day)', rainRisk: 0 })
    expect(forecast.validPeriod).toEqual({ start: '2026-10-05T09:30:00+08:00', end: '2026-10-05T11:30:00+08:00' })
  })

  it('gives the dry and rain fixtures visibly different risks', () => {
    expect(new Set(parseTwoHourForecast(dryFixture()).areas.map((a) => a.rainRisk))).toEqual(new Set([0]))
    expect(new Set(parseTwoHourForecast(rainFixture()).areas.map((a) => a.rainRisk))).toEqual(new Set([1]))
  })

  it('reads coordinates by key, whatever the order', () => {
    const payload = dryFixture()
    const first = payload.data.area_metadata[0]
    first.label_location = { longitude: first.label_location.longitude, latitude: first.label_location.latitude }
    expect(parseTwoHourForecast(payload).areas[0]).toMatchObject({ lat: 1.375, lng: 103.839 })
  })

  it('leaves out an area that has no coordinates, instead of guessing', () => {
    const payload = dryFixture()
    payload.data.area_metadata = payload.data.area_metadata.filter((m) => m.name !== 'Bedok')
    const areas = parseTwoHourForecast(payload).areas
    expect(areas).toHaveLength(46)
    expect(areas.map((a) => a.area)).not.toContain('Bedok')
  })

  it('throws ExternalApiError, so callers can fall back, when the answer is not a forecast', () => {
    const bad = [
      null,
      {},
      { code: 24, data: null, errorMsg: 'Rate limit exceeded' },
      { code: 0, data: { area_metadata: [], items: [] } },
      { code: 0, data: { area_metadata: [], items: [{ forecasts: [] }] } },
      { ...dryFixture(), data: { ...dryFixture().data, area_metadata: 'nope' } },
    ]
    for (const payload of bad) expect(() => parseTwoHourForecast(payload)).toThrow(ExternalApiError)
  })
})

describe('rain risk table', () => {
  it('knows every forecast sentence it lists, with a risk between 0 and 1', () => {
    expect(KNOWN_FORECASTS.length).toBeGreaterThan(20)
    for (const text of KNOWN_FORECASTS) {
      const { risk, known } = rainRiskOf(text)
      expect(known, text).toBe(true)
      expect(risk, text).toBeGreaterThanOrEqual(0)
      expect(risk, text).toBeLessThanOrEqual(1)
    }
  })

  it('covers the 17 sentences NEA sent in 2021 and 2022, with the day and night forms', () => {
    const seen = [
      'Fair (Day)', 'Fair (Night)', 'Fair & Warm', 'Partly Cloudy (Day)', 'Partly Cloudy (Night)', 'Cloudy', 'Windy',
      'Light Rain', 'Passing Showers', 'Light Showers', 'Showers', 'Moderate Rain', 'Heavy Rain', 'Heavy Showers',
      'Thundery Showers', 'Heavy Thundery Showers', 'Heavy Thundery Showers with Gusty Winds',
    ]
    expect(seen).toHaveLength(17)
    for (const text of seen) expect(rainRiskOf(text).known, text).toBe(true)
  })

  it('puts dry weather below the "rain is likely" line and storms above it', () => {
    for (const dry of ['Fair (Day)', 'Fair & Warm', 'Partly Cloudy (Night)', 'Cloudy', 'Windy']) {
      expect(rainRiskOf(dry).risk, dry).toBeLessThan(0.6)
    }
    for (const wet of ['Showers', 'Moderate Rain', 'Heavy Rain', 'Thundery Showers', 'Heavy Thundery Showers']) {
      expect(rainRiskOf(wet).risk, wet).toBeGreaterThanOrEqual(0.6)
    }
    expect(rainRiskOf('Light Rain').risk).toBeLessThan(rainRiskOf('Showers').risk)
    expect(rainRiskOf('Heavy Rain').risk).toBe(1)
  })

  it('ignores case, spacing and the day or night suffix', () => {
    expect(normaliseForecast('  PARTLY   Cloudy (Night) ')).toBe('partly cloudy')
    expect(rainRiskOf('partly cloudy (day)')).toEqual(rainRiskOf('Partly Cloudy (Night)'))
  })

  it('gives an unknown sentence a middle value and does not throw', () => {
    expect(() => rainRiskOf('Blizzard of frogs')).not.toThrow()
    expect(rainRiskOf('Blizzard of frogs')).toEqual({ risk: UNKNOWN_RAIN_RISK, known: false })
    expect(UNKNOWN_RAIN_RISK).toBeGreaterThan(0)
    expect(UNKNOWN_RAIN_RISK).toBeLessThan(0.6)
    expect(() => rainRiskOf(undefined)).not.toThrow()
  })

  it('reports each unknown sentence once, however many requests see it', async () => {
    const warn = vi.fn()
    const payload = payloadWith({ Bedok: 'Blizzard of frogs', Bishan: 'Blizzard of frogs', Changi: 'Fair (Day)' })
    const weather = createWeather({ http: { getJson: async () => payload }, now: () => 0, cacheMs: 0, warn })
    const forecast = await weather.twoHourForecast()
    await weather.twoHourForecast()
    expect(forecast.areas.map((a) => a.rainRisk)).toEqual([UNKNOWN_RAIN_RISK, UNKNOWN_RAIN_RISK, 0])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('Blizzard of frogs')
  })
})

describe('createWeather', () => {
  it('makes one outbound call for two requests inside five minutes, and a second after that', async () => {
    let clock = 1_000_000
    const http = counting(createHttp({ stub: true }))
    const weather = createWeather({ http, now: () => clock })

    const first = await weather.twoHourForecast()
    clock += FIVE_MINUTES - 1
    const second = await weather.twoHourForecast()
    expect(http.calls).toBe(1)
    expect(second).toBe(first)

    clock += 1 // Exactly five minutes after the first fetch.
    await weather.twoHourForecast()
    expect(http.calls).toBe(2)
  })

  it('shares one fetch between callers that arrive while it is running', async () => {
    let release
    const http = {
      calls: 0,
      getJson: vi.fn(() => {
        http.calls += 1
        return new Promise((resolve) => {
          release = () => resolve(dryFixture())
        })
      }),
    }
    const weather = createWeather({ http, now: () => 0 })
    const pending = Promise.all([weather.twoHourForecast(), weather.twoHourForecast(), weather.twoHourForecast()])
    release()
    const [a, b, c] = await pending
    expect(http.calls).toBe(1)
    expect(a).toBe(b)
    expect(b).toBe(c)
  })

  it('keeps the dry and rain scenarios in separate cache entries', async () => {
    const http = counting(createHttp({ stub: true }))
    const weather = createWeather({ http, now: () => 0 })

    const dry = await runWithScenario('dry', () => weather.twoHourForecast())
    const rain = await runWithScenario('rain', () => weather.twoHourForecast())
    const dryAgain = await runWithScenario('dry', () => weather.twoHourForecast())
    const rainAgain = await runWithScenario('rain', () => weather.twoHourForecast())

    expect(dry.areas.every((a) => a.rainRisk === 0)).toBe(true)
    expect(rain.areas.every((a) => a.rainRisk === 1)).toBe(true)
    expect(dryAgain).toBe(dry)
    expect(rainAgain).toBe(rain)
    expect(http.calls).toBe(2)
  })

  it('asks the data.gov.sg two-hour forecast, through the shared helper', async () => {
    const getJson = vi.fn(async () => dryFixture())
    await createWeather({ http: { getJson }, now: () => 0 }).twoHourForecast()
    expect(getJson).toHaveBeenCalledWith(TWO_HR_FORECAST_URL)
  })

  it('remembers a failure briefly, so an outage does not cost a slow call per request', async () => {
    let clock = 0
    const http = { calls: 0, getJson: async () => ((http.calls += 1), Promise.reject(apiDown())) }
    const weather = createWeather({ http, now: () => clock })

    await expect(weather.twoHourForecast()).rejects.toBeInstanceOf(ExternalApiError)
    clock += 29_999
    await expect(weather.twoHourForecast()).rejects.toBeInstanceOf(ExternalApiError)
    expect(http.calls).toBe(1)

    clock += 1
    await expect(weather.twoHourForecast()).rejects.toBeInstanceOf(ExternalApiError)
    expect(http.calls).toBe(2)
  })

  it('recovers when the API comes back, without waiting for five minutes', async () => {
    let clock = 0
    let up = false
    const http = { getJson: async () => (up ? dryFixture() : Promise.reject(apiDown())) }
    const weather = createWeather({ http, now: () => clock })

    await expect(weather.twoHourForecast()).rejects.toBeInstanceOf(ExternalApiError)
    up = true
    clock += 30_000
    expect((await weather.twoHourForecast()).areas).toHaveLength(47)
  })

  it('does not remember a bug: an error that is not an API failure is tried again', async () => {
    const http = { calls: 0, getJson: async () => ((http.calls += 1), Promise.reject(new TypeError('bug'))) }
    const weather = createWeather({ http, now: () => 0 })
    await expect(weather.twoHourForecast()).rejects.toBeInstanceOf(TypeError)
    await expect(weather.twoHourForecast()).rejects.toBeInstanceOf(TypeError)
    expect(http.calls).toBe(2)
  })

  it('turns a timeout from the real helper into an ExternalApiError', async () => {
    const fetchImpl = async () => {
      throw new DOMException('The operation timed out', 'TimeoutError')
    }
    const weather = createWeather({ http: createHttp({ fetchImpl }), now: () => 0 })
    await expect(weather.twoHourForecast()).rejects.toThrow(/timed out/)
    await expect(weather.twoHourForecast()).rejects.toBeInstanceOf(ExternalApiError)
  })
})

describe('withLiveWeather', () => {
  const data = loadPlanData()
  const forecastFor = (sentences) => parseTwoHourForecast(payloadWith(sentences))
  const everyArea = (sentence, except = {}) =>
    Object.fromEntries([...dryFixture().data.area_metadata.map((m) => [m.name, except[m.name] ?? sentence])])

  it('places every venue in the nearest of the 47 forecast areas, by coordinates', () => {
    const live = withLiveWeather(data, parseTwoHourForecast(dryFixture()))
    const names = new Set(dryFixture().data.area_metadata.map((m) => m.name))
    expect(live.venues).toHaveLength(data.venues.length)
    for (const v of live.venues) expect(names.has(v.forecastArea), v.id).toBe(true)
    // Tampines MRT is in Tampines, and Raffles Place is in the City.
    const areaOf = (lat, lng) => live.venues.find((v) => Math.abs(v.lat - lat) < 0.002 && Math.abs(v.lng - lng) < 0.002)?.forecastArea
    expect(areaOf(1.3545, 103.9453)).toBe('Tampines')
  })

  it('scores a venue from its own area: rain in Tampines only', () => {
    const live = withLiveWeather(data, forecastFor(everyArea('Fair (Day)', { Tampines: 'Heavy Rain' })))
    const risk = (v) => live.weatherCases[LIVE_WEATHER_CASE][v.forecastArea].rainRisk
    const inTampines = live.venues.filter((v) => v.forecastArea === 'Tampines')
    const elsewhere = live.venues.filter((v) => v.forecastArea !== 'Tampines')
    expect(inTampines.length).toBeGreaterThan(0)
    expect(inTampines.every((v) => risk(v) === 1)).toBe(true)
    expect(elsewhere.every((v) => risk(v) === 0)).toBe(true)
  })

  it('does not change the shared plan data', () => {
    const before = data.venues.map((v) => v.forecastArea)
    const caseNames = Object.keys(data.weatherCases)
    withLiveWeather(data, parseTwoHourForecast(rainFixture()))
    expect(data.venues.map((v) => v.forecastArea)).toEqual(before)
    expect(Object.keys(data.weatherCases)).toEqual(caseNames)
    expect(before.every((a) => ['central', 'east', 'west', 'north', 'northeast'].includes(a))).toBe(true)
  })

  it('places venues again when the forecast areas change', () => {
    const full = withLiveWeather(data, parseTwoHourForecast(dryFixture()))
    const payload = dryFixture()
    payload.data.area_metadata = payload.data.area_metadata.filter((m) => m.name === 'Bedok')
    const bedokOnly = withLiveWeather(data, parseTwoHourForecast(payload))
    expect(new Set(bedokOnly.venues.map((v) => v.forecastArea))).toEqual(new Set(['Bedok']))
    expect(new Set(full.venues.map((v) => v.forecastArea)).size).toBeGreaterThan(1)
  })
})

describe('the planner routes and the weather', () => {
  const servers = []
  afterEach(async () => {
    vi.restoreAllMocks()
    await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
  })

  // Starts an app on a free port and returns a function that posts to it.
  const start = async (options) => {
    const server = createApp({ frontendOrigin: FRONTEND, ...options }).listen(0)
    servers.push(server)
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}`
    return async (path, body, headers = {}) => {
      const res = await fetch(`${base}/api${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', ...headers },
        body: JSON.stringify(body),
      })
      return { status: res.status, body: await res.json() }
    }
  }

  const group = [
    { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
    { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
    { id: 'jonathan', name: 'Jonathan', home: { lat: 1.437, lng: 103.7865 } },
  ]
  // A date at a place around Tiong Bahru: there, rain moves a more sheltered venue above a more exposed one.
  const TIONG_BAHRU = { lat: 1.28614, lng: 103.82706 }
  const slot = {
    members: group,
    occasion: 'date',
    dateTime: '2026-10-10T14:30',
    categories: ['eat'],
    unknownPolicy: 'lenient',
    topN: 6,
    centre: TIONG_BAHRU,
  }
  const roamBody = { ...slot, current: TIONG_BAHRU, members: [{ id: 'ian' }] }
  delete roamBody.centre

  it('ranks a more sheltered venue higher in rain than in dry weather (same request, stub scenarios)', async () => {
    const post = await start({ stub: true })
    const dry = await post('/converge', slot, { [SCENARIO_HEADER]: 'dry' })
    const rain = await post('/converge', slot, { [SCENARIO_HEADER]: 'rain' })

    expect(dry.status).toBe(200)
    expect(rain.status).toBe(200)
    expect(dry.body.weather.source).toBe('live')
    expect(rain.body.weather.source).toBe('live')
    expect(dry.body.weather.validUntil).toBe('2026-10-05T11:30:00+08:00')

    const order = (res) => res.body.results.map((r) => r.venueId)
    expect(order(rain)).not.toEqual(order(dry))

    // Compare every pair of venues shown in both: when the order flips in the rain, the one that moved up
    // must be the more sheltered one, and at least one pair must flip.
    const exposure = Object.fromEntries([...dry.body.results, ...rain.body.results].map((r) => [r.venueId, r.venue.exposure]))
    const shared = order(dry).filter((id) => order(rain).includes(id))
    let flips = 0
    for (const a of shared) {
      for (const b of shared) {
        const aFirstDry = order(dry).indexOf(a) < order(dry).indexOf(b)
        const aFirstRain = order(rain).indexOf(a) < order(rain).indexOf(b)
        if (aFirstDry !== aFirstRain && aFirstRain) {
          flips += 1
          expect(exposure[a], `${a} overtook ${b} in the rain`).toBeLessThan(exposure[b])
        }
      }
    }
    expect(flips).toBeGreaterThan(0)
  })

  it('gives /roam the same weather field and the same rain effect', async () => {
    const post = await start({ stub: true })
    const dry = await post('/roam', roamBody, { [SCENARIO_HEADER]: 'dry' })
    const rain = await post('/roam', roamBody, { [SCENARIO_HEADER]: 'rain' })
    expect(dry.body.weather.source).toBe('live')
    expect(rain.body.weather.source).toBe('live')
    const avg = (res) => res.body.results.reduce((s, r) => s + r.breakdown.weather.value, 0) / res.body.results.length
    expect(avg(dry)).toBe(0)
    expect(avg(rain)).toBeGreaterThan(0)
  })

  it('leaves the weather field off /meeting-area and /search, which do not use weather', async () => {
    const post = await start({ stub: true })
    const meet = await post('/meeting-area', { members: group })
    const search = await post('/search', { query: 'chicken rice', centre: TIONG_BAHRU, dateTime: slot.dateTime })
    expect(meet.status).toBe(200)
    expect(search.status).toBe(200)
    expect(meet.body).not.toHaveProperty('weather')
    expect(search.body).not.toHaveProperty('weather')
  })

  it('answers 200 with weather.source "unavailable" when the forecast cannot be fetched', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const http = { getJson: async () => Promise.reject(apiDown()) }
    const post = await start({ http })

    const converge = await post('/converge', slot)
    expect(converge.status).toBe(200)
    expect(converge.body.status).toBe('ok')
    expect(converge.body.weather).toEqual({ source: 'unavailable', basis: 'none', reason: 'unavailable' })
    const roam = await post('/roam', roamBody)
    expect(roam.status).toBe(200)
    expect(roam.body.weather).toEqual({ source: 'unavailable', basis: 'none', reason: 'unavailable' })
    expect(warn).toHaveBeenCalled()
  })

  it('plans an unavailable forecast exactly like the clear case', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const down = await start({ http: { getJson: async () => Promise.reject(apiDown()) }, allowSimulatedWeather: true })
    const unavailable = await down('/converge', slot)
    const clear = await down('/converge', { ...slot, weatherCase: 'clear' })
    expect(unavailable.body.weather.source).toBe('unavailable')
    expect(clear.body.weather.source).toBe('simulated')
    expect(unavailable.body.results.map((r) => [r.venueId, r.score])).toEqual(clear.body.results.map((r) => [r.venueId, r.score]))
  })

  it('does not hide a bug: an error that is not an API failure answers 500', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const post = await start({ http: { getJson: async () => Promise.reject(new TypeError('bug')) } })
    const res = await post('/converge', slot)
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('server_error')
  })

  it('ignores weatherCase when the simulated forecast is switched off, uses the real forecast and says so', async () => {
    const getJson = vi.fn(async () => dryFixture())
    const post = await start({ http: { getJson } })
    for (const path of ['/converge', '/roam']) {
      const body = path === '/roam' ? roamBody : slot
      const plain = await post(path, body)
      const res = await post(path, { ...body, weatherCase: 'rain' })
      expect(res.status).toBe(200)
      expect(res.body.weather.source).toBe('live')
      expect(res.body.weather.simulationIgnored).toBe(true)
      // The same answer as a request that never sent the field, apart from the marker.
      expect(plain.body.weather.simulationIgnored).toBeUndefined()
      expect({ ...res.body, weather: undefined }).toEqual({ ...plain.body, weather: undefined })
    }
    expect(getJson).toHaveBeenCalledTimes(1)
  })

  it('still reports a bad weatherCase value as a field error when the flag is off', async () => {
    const post = await start({ http: createHttp({ stub: true }) })
    const res = await post('/converge', { ...slot, weatherCase: 'storm' })
    expect(res.status).toBe(400)
    expect(res.body.issues.map((i) => i.path)).toEqual(['weatherCase'])
  })

  it('uses the weatherCase and says "simulated" when the flag is on, without asking data.gov.sg', async () => {
    const getJson = vi.fn(async () => dryFixture())
    const post = await start({ http: { getJson }, allowSimulatedWeather: true })
    const res = await post('/converge', { ...slot, weatherCase: 'rain' })
    expect(res.status).toBe(200)
    expect(res.body.weather).toEqual({ source: 'simulated', basis: 'simulated' })
    expect(getJson).not.toHaveBeenCalled()
    // The venues carry the old five-region labels in a simulated forecast.
    res.body.results.forEach((r) => expect(['central', 'east', 'west', 'north', 'northeast']).toContain(r.venue.forecastArea))
  })

  it('treats the flag as on in stub mode, and still lets the scenario header pick the live fixture', async () => {
    const post = await start({ stub: true })
    const simulated = await post('/converge', { ...slot, weatherCase: 'rain' })
    expect(simulated.status).toBe(200)
    expect(simulated.body.weather.source).toBe('simulated')
    const live = await post('/converge', slot, { [SCENARIO_HEADER]: 'rain' })
    expect(live.body.weather.source).toBe('live')
  })

  it('names live areas on the venues it returns', async () => {
    const post = await start({ stub: true })
    const res = await post('/converge', slot)
    const areas = new Set(dryFixture().data.area_metadata.map((m) => m.name))
    res.body.results.forEach((r) => expect(areas.has(r.venue.forecastArea)).toBe(true))
  })
})
