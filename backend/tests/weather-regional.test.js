import { describe, expect, it, vi } from 'vitest'
import { loadPlanData } from '../src/db/venues.js'
import { NO_WEATHER_CASE, regionalAreaForecast, withLiveWeather, withNoWeather } from '../src/planner/live-weather.js'
import { weatherOf } from '../src/planner/scoring.js'
import { ExternalApiError } from '../src/services/errors.js'
import { loadFixture, shiftTwentyFourHourForecast } from '../src/services/stubs.js'
import {
  createWeather,
  forecastStateOf,
  KNOWN_FORECASTS,
  parseForecastTime,
  parseTwentyFourHourForecast,
  periodCovering,
  rainRiskOf,
  WEATHER_STATES,
} from '../src/services/weather.js'
import { createRegionLookup, nearestRegion, REGION_POINTS, REGIONS, TWO_HOUR_AREAS } from '../src/services/weather-regions.js'
import { at, HOUR } from './helpers/weather-world.js'

const real = () => loadFixture('datagov/twenty-four-hr-forecast.real.json')

describe('parseTwentyFourHourForecast, on a real answer', () => {
  const forecast = parseTwentyFourHourForecast(real())

  it('reads the three periods with their times and a sentence for each region', () => {
    expect(forecast.periods).toHaveLength(3)
    expect(forecast.periods.map((p) => [p.start, p.end])).toEqual([
      ['2026-10-11T12:00:00+08:00', '2026-10-11T18:00:00+08:00'],
      ['2026-10-11T18:00:00+08:00', '2026-10-12T06:00:00+08:00'],
      ['2026-10-12T06:00:00+08:00', '2026-10-12T12:00:00+08:00'],
    ])
    expect(forecast.periods[0].regions).toEqual({
      east: { forecast: 'Partly Cloudy (Day)', rainRisk: 0 },
      west: { forecast: 'Thundery Showers', rainRisk: 1 },
      north: { forecast: 'Thundery Showers', rainRisk: 1 },
      south: { forecast: 'Partly Cloudy (Day)', rainRisk: 0 },
      central: { forecast: 'Thundery Showers', rainRisk: 1 },
    })
    expect(forecast.lastEndMs).toBe(at('2026-10-12T12:00'))
    expect(forecast.issuedAt).toBe('2026-10-11T14:42:00+08:00')
    expect(forecast.general).toBe('Thundery Showers')
  })

  it('reads by key, whatever the order of keys', () => {
    const payload = real()
    const record = payload.data.records[0]
    record.periods = record.periods.map((p) => ({
      timePeriod: { end: p.timePeriod.end, start: p.timePeriod.start, text: p.timePeriod.text },
      regions: Object.fromEntries(Object.entries(p.regions).reverse()),
    })).reverse()
    payload.data.records[0] = Object.fromEntries(Object.entries(record).reverse())
    const reread = parseTwentyFourHourForecast(payload)
    expect(reread.periods).toHaveLength(3)
    expect(periodCovering(reread, at('2026-10-11T13:00')).regions.west.forecast).toBe('Thundery Showers')
  })

  it('does not assume three periods: four are read as four, and one as one', () => {
    const four = real()
    const record = four.data.records[0]
    const first = record.periods[0]
    record.periods.push({ ...structuredClone(first), timePeriod: { start: '2026-10-12T12:00:00+08:00', end: '2026-10-12T18:00:00+08:00', text: 'x' } })
    expect(parseTwentyFourHourForecast(four).periods).toHaveLength(4)
    const one = real()
    one.data.records[0].periods = one.data.records[0].periods.slice(0, 1)
    expect(parseTwentyFourHourForecast(one).periods).toHaveLength(1)
  })

  it('finds the period that covers a moment: its start is inside, its end is not', () => {
    expect(periodCovering(forecast, at('2026-10-11T12:00')).start).toBe('2026-10-11T12:00:00+08:00')
    expect(periodCovering(forecast, at('2026-10-11T17:59')).start).toBe('2026-10-11T12:00:00+08:00')
    expect(periodCovering(forecast, at('2026-10-11T18:00')).start).toBe('2026-10-11T18:00:00+08:00')
    expect(periodCovering(forecast, at('2026-10-12T11:59'))).not.toBeNull()
    expect(periodCovering(forecast, at('2026-10-12T12:00'))).toBeNull()
    expect(periodCovering(forecast, at('2026-10-11T11:59'))).toBeNull()
  })

  it('takes the latest issue when the answer holds a whole day of them', () => {
    const payload = real()
    const older = structuredClone(payload.data.records[0])
    older.updatedTimestamp = '2026-10-11T05:30:00+08:00'
    older.periods[0].regions.west.text = 'Fair (Day)'
    payload.data.records.unshift(older)
    expect(parseTwentyFourHourForecast(payload).periods[0].regions.west.forecast).toBe('Thundery Showers')
  })

  it('leaves out a period with an unreadable time or no region, and a region with no sentence', () => {
    const payload = real()
    const periods = payload.data.records[0].periods
    periods[0].timePeriod.start = 'noon'
    delete periods[1].regions.south
    periods[2].regions = {}
    const forecast = parseTwentyFourHourForecast(payload)
    expect(forecast.periods).toHaveLength(1)
    expect(Object.keys(forecast.periods[0].regions).sort()).toEqual(['central', 'east', 'north', 'west'])
  })

  it('throws ExternalApiError, so callers can fall back, when the answer is not a forecast', () => {
    const noPeriods = real()
    noPeriods.data.records[0].periods = []
    const bad = [null, {}, { code: 24, errorMsg: 'Rate limit exceeded' }, { code: 0, data: { records: [] } }, { code: 0, data: {} }, noPeriods]
    for (const payload of bad) expect(() => parseTwentyFourHourForecast(payload)).toThrow(ExternalApiError)
  })

  it('reads a time with no offset as Singapore time, never the machine\'s', () => {
    expect(parseForecastTime('2026-10-11T18:00:00')).toBe(at('2026-10-11T18:00'))
    expect(parseForecastTime('2026-10-11T10:00:00Z')).toBe(at('2026-10-11T18:00'))
    expect(parseForecastTime('2026-10-11T18:00:00+08:00')).toBe(at('2026-10-11T18:00'))
    expect(parseForecastTime('tomorrow')).toBeNaN()
    expect(parseForecastTime(undefined)).toBeNaN()
  })

  it('reports an unknown sentence through onUnknown', () => {
    const payload = real()
    payload.data.records[0].periods[0].regions.east.text = 'Blizzard of frogs'
    const heard = []
    const forecast = parseTwentyFourHourForecast(payload, { onUnknown: (t) => heard.push(t) })
    expect(heard).toEqual(['Blizzard of frogs'])
    expect(forecast.periods[0].regions.east.rainRisk).toBe(0.5)
  })
})

describe('the weather states', () => {
  it('maps every sentence in the rain risk table to one of the four states', () => {
    expect(KNOWN_FORECASTS.length).toBeGreaterThan(25)
    for (const text of KNOWN_FORECASTS) {
      const { state, known } = forecastStateOf(text)
      expect(known, text).toBe(true)
      expect(['dry', 'cloudy', 'showers', 'thundery'], text).toContain(state)
    }
  })

  it('agrees with the rain risk: dry is 0, cloudy is 0.1, showers rain, thundery thunder', () => {
    for (const text of KNOWN_FORECASTS) {
      const { risk } = rainRiskOf(text)
      const { state } = forecastStateOf(text)
      if (state === 'dry') expect(risk, text).toBe(0)
      if (state === 'cloudy') expect(risk, text).toBe(0.1)
      if (state === 'showers') expect(risk, text).toBeGreaterThanOrEqual(0.5)
      if (state === 'thundery') expect(text, text).toContain('thundery')
    }
    for (const text of KNOWN_FORECASTS.filter((t) => t.includes('thundery'))) expect(forecastStateOf(text).state, text).toBe('thundery')
  })

  it('maps the sentences NEA sends, with the day and night forms', () => {
    const cases = {
      'Fair (Day)': 'dry', 'Fair (Night)': 'dry', 'Fair & Warm': 'dry', 'Partly Cloudy (Night)': 'dry', Cloudy: 'cloudy',
      Windy: 'cloudy', Hazy: 'cloudy', 'Light Rain': 'showers', 'Passing Showers': 'showers', Showers: 'showers',
      'Heavy Rain': 'showers', 'Thundery Showers': 'thundery', 'Heavy Thundery Showers with Gusty Winds': 'thundery',
    }
    for (const [text, state] of Object.entries(cases)) expect(forecastStateOf(text).state, text).toBe(state)
  })

  it('gives an unknown sentence the state "unknown" and does not throw', () => {
    expect(forecastStateOf('Blizzard of frogs')).toEqual({ state: 'unknown', known: false })
    expect(() => forecastStateOf(undefined)).not.toThrow()
    expect(WEATHER_STATES).toEqual(['dry', 'cloudy', 'showers', 'thundery', 'unknown'])
  })

  it('logs an unknown sentence once, however many forecasts and requests carry it', async () => {
    const warn = vi.fn()
    const payload = real()
    payload.data.records[0].periods[0].regions.east.text = 'Blizzard of frogs'
    payload.data.records[0].periods[1].regions.east.text = 'Blizzard of frogs'
    const weather = createWeather({ http: { getJson: async () => payload }, now: () => at('2026-10-11T16:00'), regionalCacheMs: 0, warn })
    const forecast = await weather.regionalForecast()
    await weather.regionalForecast()
    expect(warn).toHaveBeenCalledTimes(1)
    expect(warn.mock.calls[0][0]).toContain('Blizzard of frogs')
    expect(weatherOf({ forecastArea: 'x' }, { x: { rainRisk: 0.5, forecast: 'Blizzard of frogs' } })).toEqual({
      state: 'unknown', phrase: 'Blizzard of frogs', rainLikely: false,
    })
    expect(forecast.periods[0].regions.east.rainRisk).toBe(0.5)
  })

  it('derives the state of a simulated case from its rain risk, and "unknown" for a missing area', () => {
    expect(weatherOf({ forecastArea: 'a' }, { a: { rainRisk: 0.85 } })).toEqual({ state: 'showers', phrase: null, rainLikely: true })
    expect(weatherOf({ forecastArea: 'a' }, { a: { rainRisk: 0.1 } })).toEqual({ state: 'dry', phrase: null, rainLikely: false })
    expect(weatherOf({ forecastArea: 'zzz' }, { a: { rainRisk: 0.1 } })).toEqual({ state: 'unknown', phrase: null, rainLikely: false })
  })
})

describe('the area to region table', () => {
  const names = loadFixture('datagov/two-hr-forecast.dry.json').data.area_metadata.map((m) => m.name)

  it('names every area the two-hour fixture names, with the same label points', () => {
    expect(TWO_HOUR_AREAS.map((a) => a.name).sort()).toEqual([...names].sort())
    const metadata = new Map(loadFixture('datagov/two-hr-forecast.dry.json').data.area_metadata.map((m) => [m.name, m.label_location]))
    for (const a of TWO_HOUR_AREAS) {
      expect(a.lat, a.name).toBe(metadata.get(a.name).latitude)
      expect(a.lng, a.name).toBe(metadata.get(a.name).longitude)
      expect(REGIONS, a.name).toContain(a.region)
    }
  })

  it('puts 14 areas in the west, 12 in the east, 8 in the north, 8 in the south and 5 in the centre', () => {
    const count = (region) => TWO_HOUR_AREAS.filter((a) => a.region === region).length
    expect(REGIONS.map(count)).toEqual([14, 12, 5, 8, 8]) // west, east, central, south, north
  })

  it('keeps an area the table names in its region, even where another label point is nearer', () => {
    const regionOf = createRegionLookup({ warn: () => {} })
    const clementi = TWO_HOUR_AREAS.find((a) => a.name === 'Clementi')
    expect(nearestRegion(clementi)).toBe('south')
    expect(regionOf(clementi)).toBe('west')
    const serangoon = TWO_HOUR_AREAS.find((a) => a.name === 'Serangoon')
    expect(regionOf(serangoon)).toBe('east')
  })

  it('gives a made-up area the nearest region by label point, and logs it once', () => {
    const warn = vi.fn()
    const regionOf = createRegionLookup({ warn })
    expect(regionOf({ name: 'Nowhere', lat: 1.45, lng: 103.82 })).toBe('north')
    expect(regionOf({ name: 'Nowhere', lat: 1.45, lng: 103.82 })).toBe('north')
    expect(regionOf({ name: 'Elsewhere', lat: 1.3, lng: 103.65 })).toBe('west')
    expect(warn).toHaveBeenCalledTimes(2)
    expect(warn.mock.calls[0][0]).toContain('Nowhere')
    for (const [region, point] of Object.entries(REGION_POINTS)) expect(nearestRegion(point)).toBe(region)
  })
})

describe('regional forecast as plan data', () => {
  const regionOf = createRegionLookup({ warn: () => {} })
  const period = parseTwentyFourHourForecast(real()).periods[0]

  it('gives every two-hour area the sentence of its region', () => {
    const forecast = regionalAreaForecast(period, regionOf)
    expect(forecast.areas).toHaveLength(47)
    expect(forecast.validPeriod).toEqual({ start: '2026-10-11T12:00:00+08:00', end: '2026-10-11T18:00:00+08:00' })
    const phrase = (name) => forecast.areas.find((a) => a.area === name).forecast
    expect(phrase('Woodlands')).toBe('Thundery Showers') // north
    expect(phrase('Clementi')).toBe('Thundery Showers') // west
    expect(phrase('Bishan')).toBe('Thundery Showers') // central
    expect(phrase('Tampines')).toBe('Partly Cloudy (Day)') // east
    expect(phrase('City')).toBe('Partly Cloudy (Day)') // south
  })

  it('places venues in the same areas the area forecast does, and scores them by region', () => {
    const data = loadPlanData()
    const live = withLiveWeather(data, regionalAreaForecast(period, regionOf))
    const names = new Set(TWO_HOUR_AREAS.map((a) => a.name))
    for (const v of live.venues) expect(names.has(v.forecastArea), v.id).toBe(true)
  })

  it('leaves out an area whose region has no sentence in the period', () => {
    const partial = { ...period, regions: { ...period.regions } }
    delete partial.regions.west
    const forecast = regionalAreaForecast(partial, regionOf)
    expect(forecast.areas.length).toBe(47 - 14)
  })

  it('"no effect" plan data scores like the clear case and marks every area unknown, without changing the shared data', () => {
    const data = loadPlanData()
    const none = withNoWeather(data)
    expect(withNoWeather(data)).toBe(none)
    expect(none.venues).toBe(data.venues)
    for (const [area, w] of Object.entries(none.weatherCases[NO_WEATHER_CASE])) {
      expect(w.rainRisk).toBe(data.weatherCases.clear[area].rainRisk)
      expect(w.state).toBe('unknown')
    }
    expect(data.weatherCases.clear.central.state).toBeUndefined()
    expect(Object.keys(data.weatherCases)).not.toContain(NO_WEATHER_CASE)
  })
})

describe('the stubbed regional forecast', () => {
  it('always covers the next 18 hours, and reaches 24 hours at most 24 hours and 30 minutes', () => {
    for (let minute = 0; minute < 24 * 60; minute += 7) {
      const now = at('2026-10-11T00:00') + minute * 60 * 1000
      const forecast = parseTwentyFourHourForecast(shiftTwentyFourHourForecast(real(), now))
      expect(forecast.lastEndMs - now, `at minute ${minute}`).toBeGreaterThanOrEqual(18 * HOUR - 1)
      expect(forecast.lastEndMs - now).toBeLessThanOrEqual(24 * HOUR + 30 * 60 * 1000)
      expect(periodCovering(forecast, now + 2 * HOUR + 1), `at minute ${minute}`).not.toBeNull()
    }
  })

  it('keeps the periods in one piece, with no gap and no overlap', () => {
    const forecast = parseTwentyFourHourForecast(shiftTwentyFourHourForecast(real(), at('2026-10-14T09:12')))
    forecast.periods.forEach((p, i) => i > 0 && expect(p.startMs).toBe(forecast.periods[i - 1].endMs))
    expect(forecast.lastEndMs - forecast.periods[0].startMs).toBe(24 * HOUR)
  })

  it('answers the dry and rain scenarios differently', () => {
    const dry = parseTwentyFourHourForecast(loadFixture('datagov/twenty-four-hr-forecast.dry.json'))
    const rain = parseTwentyFourHourForecast(loadFixture('datagov/twenty-four-hr-forecast.rain.json'))
    const risks = (f) => new Set(f.periods.flatMap((p) => Object.values(p.regions).map((r) => r.rainRisk)))
    expect(risks(dry)).toEqual(new Set([0]))
    expect(risks(rain)).toEqual(new Set([1]))
  })

  it('is cached apart from the area forecast, and apart by scenario', async () => {
    const { createHttp } = await import('../src/services/http.js')
    const { runWithScenario } = await import('../src/services/scenario.js')
    const calls = []
    const inner = createHttp({ stub: true })
    const weather = createWeather({ http: { getJson: (url) => (calls.push(url), inner.getJson(url)) } })
    const dry = await runWithScenario('dry', () => weather.regionalForecast())
    const rain = await runWithScenario('rain', () => weather.regionalForecast())
    expect(await runWithScenario('dry', () => weather.regionalForecast())).toBe(dry)
    expect(await runWithScenario('rain', () => weather.regionalForecast())).toBe(rain)
    expect(calls).toHaveLength(2)
    expect(calls.every((u) => u.endsWith('/twenty-four-hr-forecast'))).toBe(true)
    expect(dry).not.toBe(rain)
  })
})
