import { describe, expect, it, vi } from 'vitest'
import { ExternalApiError, assertStubAllowed, createHttp } from '../src/services/http.js'
import { runWithScenario } from '../src/services/scenario.js'
import { loadFixture } from '../src/services/stubs.js'

const FORECAST_URL = 'https://api-open.data.gov.sg/v2/real-time/api/two-hr-forecast'
const TOKEN_URL = 'https://www.onemap.gov.sg/api/auth/post/getToken'
const SEARCH_URL = 'https://www.onemap.gov.sg/api/common/elastic/search?searchVal=178879&returnGeom=Y&getAddrDetails=Y'

// Builds a OneMap route URL between two "lat,lng" points.
const routeUrl = (start, end, extra = 'routeType=pt&date=10-05-2026&time=18:30:00') =>
  `https://www.onemap.gov.sg/api/public/routingsvc/route?start=${start}&end=${end}&${extra}`

const WOODLANDS = '1.4360,103.7860'
const BISHAN = '1.3508,103.8485'
const ORCHARD = '1.3048,103.8318'

// A fake fetch that always answers with the given body and status.
const fakeFetch = (body, status = 200) => vi.fn(async () => new Response(body, { status }))

describe('real mode', () => {
  it('sends a GET with headers and returns the parsed JSON', async () => {
    const fetchImpl = fakeFetch('{"ok":true}')
    const http = createHttp({ fetchImpl })

    const data = await http.getJson(FORECAST_URL, { headers: { Authorization: 'token' } })

    expect(data).toEqual({ ok: true })
    const [url, options] = fetchImpl.mock.calls[0]
    expect(url).toBe(FORECAST_URL)
    expect(options.method).toBe('GET')
    expect(options.headers).toEqual({ Authorization: 'token' })
    expect(options.body).toBeUndefined()
  })

  it('sends a POST with a JSON body', async () => {
    const fetchImpl = fakeFetch('{"access_token":"abc"}')
    const http = createHttp({ fetchImpl })

    const data = await http.postJson(TOKEN_URL, { email: 'a@b.c', password: 'secret' })

    expect(data).toEqual({ access_token: 'abc' })
    const [, options] = fetchImpl.mock.calls[0]
    expect(options.method).toBe('POST')
    expect(options.headers).toEqual({ 'Content-Type': 'application/json' })
    expect(JSON.parse(options.body)).toEqual({ email: 'a@b.c', password: 'secret' })
  })

  it('throws ExternalApiError on a bad status, naming the service', async () => {
    const http = createHttp({ fetchImpl: fakeFetch('{"message":"Unauthorized"}', 401) })

    const err = await http.getJson(routeUrl(WOODLANDS, ORCHARD)).catch((e) => e)

    expect(err).toBeInstanceOf(ExternalApiError)
    expect(err.service).toBe('onemap')
    expect(err.status).toBe(401)
  })

  it('throws on a 200 with an empty body', async () => {
    const http = createHttp({ fetchImpl: fakeFetch('') })

    const err = await http.getJson(FORECAST_URL).catch((e) => e)

    expect(err).toBeInstanceOf(ExternalApiError)
    expect(err.service).toBe('datagov')
    expect(err.message).toMatch(/empty body/)
  })

  it('throws on a body that is not JSON', async () => {
    const http = createHttp({ fetchImpl: fakeFetch('<html>Too many requests</html>') })

    await expect(http.getJson(SEARCH_URL)).rejects.toThrow(/not JSON/)
  })

  it('throws ExternalApiError with no status when the network is down', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed')
    })
    const http = createHttp({ fetchImpl })

    const err = await http.getJson(FORECAST_URL).catch((e) => e)

    expect(err).toBeInstanceOf(ExternalApiError)
    expect(err.status).toBeNull()
  })

  it('gives up after the timeout', async () => {
    // A fetch that never answers, and rejects only when its signal aborts.
    const fetchImpl = (url, { signal }) =>
      new Promise((resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason))
      })
    const http = createHttp({ fetchImpl, timeoutMs: 20 })

    const err = await http.getJson(FORECAST_URL).catch((e) => e)

    expect(err).toBeInstanceOf(ExternalApiError)
    expect(err.message).toMatch(/timed out after 20ms/)
  })
})

describe('stub mode', () => {
  // Fails the test if the real network is ever touched.
  const fetchImpl = vi.fn(async () => {
    throw new Error('stub mode must not call fetch')
  })
  const http = createHttp({ stub: true, fetchImpl })

  const forecastStrings = (data) => new Set(data.data.items[0].forecasts.map((f) => f.forecast))

  it('returns the dry forecast by default, without calling fetch', async () => {
    const data = await http.getJson(FORECAST_URL)

    expect(data.data.area_metadata).toHaveLength(47)
    expect(forecastStrings(data)).toEqual(new Set(['Fair (Day)']))
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('returns the rain forecast in the rain scenario', async () => {
    const data = await runWithScenario('rain', () => http.getJson(FORECAST_URL))

    expect(forecastStrings(data)).toEqual(new Set(['Heavy Thundery Showers']))
  })

  it('keeps scenarios separate when requests run in parallel', async () => {
    const [rain, dry] = await Promise.all([
      runWithScenario('rain', () => http.getJson(FORECAST_URL)),
      runWithScenario('dry', () => http.getJson(FORECAST_URL)),
    ])

    expect(forecastStrings(rain)).toEqual(new Set(['Heavy Thundery Showers']))
    expect(forecastStrings(dry)).toEqual(new Set(['Fair (Day)']))
  })

  it('answers the OneMap token and search calls', async () => {
    const token = await http.postJson(TOKEN_URL, { email: 'a@b.c', password: 'secret' })
    const search = await http.getJson(SEARCH_URL)

    expect(token.access_token).toBeTruthy()
    // Epoch seconds in a string, like the real API, and far in the future.
    expect(Number(token.expiry_timestamp) * 1000).toBeGreaterThan(Date.now())
    expect(search.results[0].POSTAL).toBe('178879')
  })

  it('builds a public transport route in OneMap’s shape', async () => {
    const route = await http.getJson(routeUrl(WOODLANDS, ORCHARD))
    const itinerary = route.plan.itineraries[0]
    const sample = loadFixture('onemap/route.pt.sample.json').plan.itineraries[0]

    // Same fields as the documented sample response.
    expect(Object.keys(itinerary).sort()).toEqual(Object.keys(sample).sort())
    expect(Number.isInteger(itinerary.duration)).toBe(true)
    expect(Number.isInteger(itinerary.transfers)).toBe(true)
    // The duration matches the start and end times, and the legs fill it exactly.
    expect(itinerary.endTime - itinerary.startTime).toBe(itinerary.duration * 1000)
    expect(itinerary.legs[0].startTime).toBe(itinerary.startTime)
    expect(itinerary.legs.at(-1).endTime).toBe(itinerary.endTime)
    // 18:30 Singapore time on 5 Oct 2026, taken from the request.
    expect(new Date(itinerary.startTime).toISOString()).toBe('2026-10-05T10:30:00.000Z')
  })

  it('gives the same route for the same request, and a longer one for a farther venue', async () => {
    const first = await http.getJson(routeUrl(WOODLANDS, ORCHARD))
    const again = await http.getJson(routeUrl(WOODLANDS, ORCHARD))
    const nearer = await http.getJson(routeUrl(BISHAN, ORCHARD))

    expect(again).toEqual(first)
    expect(first.plan.itineraries[0].duration).toBeGreaterThan(nearer.plan.itineraries[0].duration)
  })

  it('builds a walking route with a route_summary', async () => {
    const walk = await http.getJson(routeUrl('1.3048,103.8318', '1.3009,103.8390', 'routeType=walk'))

    expect(walk.status).toBe(0)
    expect(walk.route_summary.total_time).toBeGreaterThan(0)
    expect(walk.route_summary.total_distance).toBeGreaterThan(0)
  })

  it('fails every route call in the routing-fail scenario, but not the weather', async () => {
    await runWithScenario('routing-fail', async () => {
      const err = await http.getJson(routeUrl(WOODLANDS, ORCHARD)).catch((e) => e)
      expect(err).toBeInstanceOf(ExternalApiError)
      expect(err.service).toBe('onemap')
      expect(err.status).toBe(503)

      const forecast = await http.getJson(FORECAST_URL)
      expect(forecastStrings(forecast)).toEqual(new Set(['Fair (Day)']))
    })
  })

  it('throws a plain Error for a URL with no stub, and never falls through to fetch', async () => {
    const err = await http.getJson('https://api-open.data.gov.sg/v2/real-time/api/uv').catch((e) => e)

    // A missing stub is our bug, so fallback code that catches ExternalApiError must not hide it.
    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(ExternalApiError)
    expect(err.message).toMatch(/No stub for GET/)
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('hands out a fresh copy of a fixture each time', async () => {
    const first = await http.getJson(FORECAST_URL)
    first.data.items[0].forecasts[0].forecast = 'changed by a caller'

    const second = await http.getJson(FORECAST_URL)

    expect(second.data.items[0].forecasts[0].forecast).toBe('Fair (Day)')
  })
})

describe('assertStubAllowed', () => {
  it('refuses stub mode in production', () => {
    expect(() => assertStubAllowed({ stub: true, nodeEnv: 'production' })).toThrow(/production/)
  })

  it('allows stub mode outside production, and production without stubs', () => {
    expect(() => assertStubAllowed({ stub: true, nodeEnv: 'test' })).not.toThrow()
    expect(() => assertStubAllowed({ stub: true, nodeEnv: undefined })).not.toThrow()
    expect(() => assertStubAllowed({ stub: false, nodeEnv: 'production' })).not.toThrow()
  })
})
