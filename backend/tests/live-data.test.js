// The OneMap services: the cache, address search, public transport routes, and running the engine with real
// travel times. NEA weather has its own tests (Ian's weather service).
// Nothing here touches the network: stub mode answers from tests/fixtures/, and the rest use fake helpers.
import { describe, expect, it, vi } from 'vitest'
import { createCache } from '../src/services/cache.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { createOneMap, oneMapDateTime, WALK_ONLY_KM } from '../src/services/onemap.js'
import { runWithRealTravel } from '../src/services/travel-times.js'
import { converge, meetingArea } from '../src/planner/engine.js'
import { haversineKm } from '../src/planner/geo.js'
import mock from '../src/db/mock/mock-data.json'
import areasFile from '../src/db/mock/areas.json'

const stubHttp = () => createHttp({ stub: true })
const TAMPINES = { lat: 1.3541, lng: 103.9446 }
const BUGIS = { lat: 1.30065, lng: 103.85585 }

// ---------------------------------------------------------------- cache
describe('createCache', () => {
  it('keeps a value until it expires, then fetches again', async () => {
    let t = 0
    const cache = createCache({ ttlMs: 1000, now: () => t })
    const fetch = vi.fn(async () => 'value')
    expect(await cache.getOrSet('k', fetch)).toBe('value')
    expect(await cache.getOrSet('k', fetch)).toBe('value')
    expect(fetch).toHaveBeenCalledTimes(1)
    t = 1000
    await cache.getOrSet('k', fetch)
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('shares one fetch between requests that arrive together, and never stores a failure', async () => {
    const cache = createCache({ ttlMs: 1000 })
    const fetch = vi.fn(async () => 'value')
    await Promise.all([cache.getOrSet('k', fetch), cache.getOrSet('k', fetch), cache.getOrSet('k', fetch)])
    expect(fetch).toHaveBeenCalledTimes(1)
    const failing = vi.fn(async () => { throw new Error('down') })
    await expect(cache.getOrSet('bad', failing)).rejects.toThrow('down')
    await expect(cache.getOrSet('bad', failing)).rejects.toThrow('down')
    expect(failing).toHaveBeenCalledTimes(2)
  })

  it('drops the oldest value when full', () => {
    const cache = createCache({ ttlMs: 1000, maxItems: 2 })
    cache.set('a', 1)
    cache.set('b', 2)
    cache.set('c', 3)
    expect(cache.get('a')).toBeUndefined()
    expect(cache.size()).toBe(2)
  })
})

// ---------------------------------------------------------------- OneMap
describe('OneMap', () => {
  it('oneMapDateTime: MM-DD-YYYY and the hour, Singapore time', () => {
    expect(oneMapDateTime('2026-10-10T19:45')).toEqual({ date: '10-10-2026', time: '19:00:00' })
  })

  it('routing is off without an account, and on in stub mode', () => {
    expect(createOneMap({ http: stubHttp() }).routingEnabled).toBe(false)
    expect(createOneMap({ http: stubHttp(), email: 'a@b.c', password: 'x' }).routingEnabled).toBe(true)
    expect(createOneMap({ http: stubHttp(), stub: true }).routingEnabled).toBe(true)
  })

  it('search returns plain places from the recorded answer', async () => {
    const places = await createOneMap({ http: stubHttp() }).search('178879')
    expect(places[0]).toEqual({
      name: 'SUPREME COURT BUILDING',
      address: '1 SUPREME COURT LANE SUPREME COURT BUILDING SINGAPORE 178879',
      postal: '178879',
      lat: 1.290443022119456,
      lng: 103.8507321636521,
    })
  })

  it('routeMinutes: public transport minutes, cached; a short trip is walked with no call', async () => {
    const http = stubHttp()
    const spy = vi.spyOn(http, 'getJson')
    const onemap = createOneMap({ http, stub: true })
    const minutes = await onemap.routeMinutes(TAMPINES, BUGIS, '2026-10-10T19:00')
    expect(minutes).toBeGreaterThan(20)
    expect(await onemap.routeMinutes(TAMPINES, BUGIS, '2026-10-10T19:40')).toBe(minutes) // same hour: cached
    expect(spy).toHaveBeenCalledTimes(1)
    const nextDoor = { lat: BUGIS.lat + (WALK_ONLY_KM / 2) / 111, lng: BUGIS.lng }
    expect(await onemap.routeMinutes(BUGIS, nextDoor, '2026-10-10T19:00')).toBeLessThan(10)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('logs in once, reuses the token, and logs in again an hour before it runs out', async () => {
    let t = 0
    const expiry = 3 * 3600 // 3 hours, in seconds
    const http = {
      postJson: vi.fn(async () => ({ access_token: `token-${http.postJson.mock.calls.length}`, expiry_timestamp: String(t / 1000 + expiry) })),
      getJson: vi.fn(async () => ({ plan: { itineraries: [{ duration: 1800 }] } })),
    }
    const onemap = createOneMap({ http, email: 'a@b.c', password: 'x', now: () => t })
    await onemap.routeMinutes(TAMPINES, BUGIS, '2026-10-10T19:00')
    await onemap.routeMinutes(TAMPINES, BUGIS, '2026-10-10T20:00')
    expect(http.postJson).toHaveBeenCalledTimes(1)
    expect(http.getJson.mock.calls[1][1]).toEqual({ headers: { Authorization: 'token-1' } })
    t = (expiry - 3000) * 1000 // under an hour left
    await onemap.routeMinutes(TAMPINES, BUGIS, '2026-10-10T21:00')
    expect(http.postJson).toHaveBeenCalledTimes(2)
  })

  it('a route with no itinerary is null, and a login with no token is an API failure', async () => {
    const noRoute = createOneMap({ http: { postJson: async () => ({ access_token: 't', expiry_timestamp: '4102444800' }), getJson: async () => ({ plan: { itineraries: [] } }) }, email: 'a', password: 'b' })
    expect(await noRoute.routeMinutes(TAMPINES, BUGIS, '2026-10-10T19:00')).toBeNull()
    const badLogin = createOneMap({ http: { postJson: async () => ({}), getJson: async () => ({}) }, email: 'a', password: 'b' })
    await expect(badLogin.routeMinutes(TAMPINES, BUGIS, '2026-10-10T19:00')).rejects.toBeInstanceOf(ExternalApiError)
  })
})

// ---------------------------------------------------------------- the engine with real travel times
describe('runWithRealTravel', () => {
  const data = { ...mock, areas: areasFile.areas }
  const members = ['ian', 'faith'].map((id) => mock.members.find((m) => m.id === id))
  const input = { members, occasion: 'casual_meal', dateTime: '2026-10-10T19:00', unknownPolicy: 'lenient' }

  it('without routing: one engine run with the estimate', async () => {
    const run = vi.fn((deps) => converge(input, data, deps))
    const { result, travel } = await runWithRealTravel({ onemap: null, dateTime: input.dateTime, run })
    expect(run).toHaveBeenCalledTimes(1)
    expect(travel).toEqual({ source: 'estimate', routed: 0, failed: 0 })
    expect(result.results.every((r) => r.approximate === false)).toBe(true)
  })

  it('with routing: the engine reads OneMap minutes, and each trip and its reverse are fetched once', async () => {
    const onemap = { routingEnabled: true, routeMinutes: vi.fn(async () => 42) }
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: input.dateTime, run: (deps) => converge(input, data, deps) })
    expect(travel.source).toBe('onemap')
    expect(travel.failed).toBe(0)
    expect(onemap.routeMinutes).toHaveBeenCalledTimes(travel.routed)
    for (const r of result.results) {
      expect(Object.values(r.travelByMember).every((m) => m === 42)).toBe(true)
      expect(r.approximate).toBe(false)
    }
    // Both members end where they start, so the way back reuses the way there: one call per member per venue.
    expect(travel.routed).toBeLessThanOrEqual(result.diagnostics.routingCalls / 2)
  })

  it('a trip OneMap cannot answer falls back to the estimate, marked approximate', async () => {
    let n = 0
    const onemap = {
      routingEnabled: true,
      routeMinutes: async () => {
        n += 1
        if (n % 2) throw new ExternalApiError('onemap answered 503', { service: 'onemap', status: 503, url: 'x' })
        return 30
      },
    }
    const { result, travel } = await runWithRealTravel({ onemap, dateTime: input.dateTime, run: (deps) => converge(input, data, deps) })
    expect(travel.failed).toBeGreaterThan(0)
    expect(result.results.some((r) => r.approximate)).toBe(true)
  })

  it('a bug (not an API failure) is not hidden', async () => {
    const onemap = { routingEnabled: true, routeMinutes: async () => { throw new TypeError('bug') } }
    await expect(runWithRealTravel({ onemap, dateTime: input.dateTime, run: (deps) => converge(input, data, deps) })).rejects.toThrow('bug')
  })

  it('works for the meeting area too, with real routes from the stub', async () => {
    const onemap = createOneMap({ http: stubHttp(), stub: true })
    const { result, travel } = await runWithRealTravel({
      onemap,
      dateTime: input.dateTime,
      run: (deps) => meetingArea({ members, maxCandidates: 16 }, data, deps),
    })
    expect(travel.source).toBe('onemap')
    expect(result.approximate).toBe(false)
    expect(data.areas.some((a) => a.id === result.area.id)).toBe(true)
  })
})
