// Keeps the Google bill and the planner safe: the call budget, the radius and width snapping, the circuit and the
// timeout, answers of the wrong shape, the photo route, the key, and the once-a-minute log.
// Nothing here touches the network: a fake fetch sits under the real HTTP helper, and a clock the test moves by hand
// drives the budget, the circuit and the caches.
import { once } from 'node:events'
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { fromGooglePlace, fromGooglePlaces } from '../src/planner/google-adapter.js'
import { createCallBudget, OneMapUnavailableError } from '../src/services/budget.js'
import {
  createGooglePlaces,
  DEFAULT_GOOGLE_CALLS_PER_MINUTE,
  GOOGLE_CIRCUIT_OPEN_MS,
  GOOGLE_FAILURES_TO_OPEN,
  GOOGLE_MAX_IN_FLIGHT,
  GOOGLE_STALE_WAIT_MS,
  GOOGLE_TIMEOUT_MS,
  GoogleUnavailableError,
  PHOTO_MISS_MS,
  readGoogleSettings,
  safeImageUrl,
  snapPhotoWidth,
  snapRadius,
} from '../src/services/google-places.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { loadFixture } from '../src/services/stubs.js'

const FRONTEND = 'http://localhost:5173'
const KEY = 'AIzaFAKE-KEY-never-print-0123456789'
const GOOD = loadFixture('google/places-nearby.json')
const PHOTO = 'places/stub_place_01/photos/STUB_PHOTO'
const GOOD_LINK = 'https://lh3.googleusercontent.com/stub-photo'
const planData = loadPlanData()

// ---------------------------------------------------------------- helpers
// Nothing in a log line, a response body or a response header may carry the key. Every test is checked after it ran.
let consoleWarn, consoleError
const seen = [] // Every response the app sent, as text, and every log line the Google service wrote.
beforeEach(() => {
  seen.length = 0
  consoleWarn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => {
  expect(JSON.stringify([...seen, ...consoleWarn.mock.calls, ...consoleError.mock.calls])).not.toContain(KEY)
  consoleWarn.mockRestore()
  consoleError.mockRestore()
})

const makeClock = (start = Date.UTC(2026, 9, 10, 4, 0, 0)) => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const isNearby = (url) => url.includes('places:searchNearby')
const point = (i) => ({ lat: 1.3504 + i * 0.002, lng: 103.8428 }) // Each is a different cache key (more than 110 m apart).

// A fetch that never answers until its timeout fires, like a hung Google.
const hang = (url, init) =>
  new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))

// Servers listen on 127.0.0.1 only: a server on every address can be given a port that another program on the machine
// already holds on 127.0.0.1, and the test's request then reaches that program.
const servers = []
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

// A planner app whose Google service runs on the real HTTP helper over a fake fetch.
// `respond(call)` answers each Google call (default: the invented fixture, and a good photo link).
// `callsPerMinute: 'default'` leaves the cap to the service's own default.
async function harness({ respond, callsPerMinute = 1000, timeoutMs, apiKey = KEY, delayMs = 0 } = {}) {
  const clock = makeClock()
  const calls = [] // { url, method, body, headers }
  let answer = respond ?? ((call) => (isNearby(call.url) ? json(GOOD) : json({ photoUri: GOOD_LINK })))
  let inFlight = 0
  let peak = 0
  const fetchImpl = async (url, init) => {
    const call = { url, method: init.method, body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers }
    calls.push(call)
    inFlight += 1
    peak = Math.max(peak, inFlight)
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return await answer(call, init)
    } finally {
      inFlight -= 1
    }
  }
  const logged = []
  const warn = (...args) => {
    logged.push(args.join(' '))
    seen.push(args.join(' '))
  }
  const places = createGooglePlaces({
    http: createHttp({ fetchImpl }),
    apiKey,
    callsPerMinute: callsPerMinute === 'default' ? undefined : callsPerMinute,
    timeoutMs,
    now: clock.now,
    warn,
  })
  const app = createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }), places, planData })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const base = `http://127.0.0.1:${server.address().port}`

  const record = async (res) => {
    const text = await res.text()
    seen.push(text, JSON.stringify([...res.headers]))
    return text
  }
  const post = async (path, body) => {
    const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    const text = await record(res)
    return { status: res.status, body: JSON.parse(text) }
  }
  const slot = (centre, extra = {}) => ({
    members: [{ id: 'a', home: { lat: 1.3541, lng: 103.9446 } }, { id: 'b', home: { lat: 1.315, lng: 103.765 } }],
    occasion: 'casual_meal', dateTime: '2026-10-10T19:00', durationMinutes: 90, categories: ['eat'], centre, unknownPolicy: 'lenient', topN: 10,
    ...extra,
  })
  const converge = (centre = point(0), extra) => post('/converge', slot(centre, extra))
  const photo = async (query) => {
    const res = await fetch(`${base}/api/places/photo?${query}`, { redirect: 'manual' })
    const text = await record(res)
    // A redirect carries a short text body, not JSON.
    const type = res.headers.get('content-type') ?? ''
    return { status: res.status, location: res.headers.get('location'), cacheControl: res.headers.get('cache-control'), body: type.includes('json') ? JSON.parse(text) : null }
  }
  return {
    clock, calls, logged, places, converge, photo, post, slot, base,
    nearbyCalls: () => calls.filter((c) => isNearby(c.url)),
    photoCalls: () => calls.filter((c) => !isNearby(c.url)),
    peak: () => peak,
    answerWith: (fn) => { answer = fn },
  }
}

// ---------------------------------------------------------------- 1. the call budget
describe('Google call budget', () => {
  it('after N distinct nearby searches in a minute, the next makes no fetch and the planner still answers 200', async () => {
    const h = await harness({ callsPerMinute: 3 })
    for (let i = 0; i < 3; i++) expect((await h.converge(point(i))).body.google.source).toBe('google')
    expect(h.nearbyCalls()).toHaveLength(3)

    const over = await h.converge(point(3))
    expect(over.status).toBe(200)
    expect(over.body.google).toEqual({ source: 'unavailable', added: 0 })
    expect(over.body.results.length).toBeGreaterThan(0)
    expect(h.nearbyCalls()).toHaveLength(3)

    // A repeat of a search already made is a cache hit: it costs nothing.
    expect((await h.converge(point(0))).body.google.source).toBe('google')
    expect(h.nearbyCalls()).toHaveLength(3)

    h.clock.advance(60_000)
    expect((await h.converge(point(3))).body.google.source).toBe('google')
    expect(h.nearbyCalls()).toHaveLength(4)
  })

  it('photo calls draw on the same budget as nearby searches', async () => {
    const h = await harness({ callsPerMinute: 2 })
    expect((await h.converge(point(0))).body.google.source).toBe('google') // 1 of 2
    expect((await h.photo(`name=${PHOTO}`)).status).toBe(302) // 2 of 2
    const refused = await h.photo('name=places/stub_place_01/photos/OTHER')
    expect(refused.status).toBe(503)
    expect(refused.body.error).toBe('photos_unavailable')
    expect((await h.converge(point(1))).body.google.source).toBe('unavailable')
    expect(h.calls).toHaveLength(2)

    h.clock.advance(60_000)
    expect((await h.photo('name=places/stub_place_01/photos/OTHER')).status).toBe(302)
    expect(h.calls).toHaveLength(3)
  })

  it('runs at most 4 calls at once, and refuses with GoogleUnavailableError("budget_empty") when empty', async () => {
    const h = await harness({ callsPerMinute: 10, delayMs: 20 })
    const results = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => h.places.nearby(point(i), { categories: ['eat'] })))
    expect(GOOGLE_MAX_IN_FLIGHT).toBe(4)
    expect(h.peak()).toBeLessThanOrEqual(4)
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(10)
    const refused = results.filter((r) => r.status === 'rejected').map((r) => r.reason)
    expect(refused).toHaveLength(2)
    for (const err of refused) {
      expect(err).toBeInstanceOf(GoogleUnavailableError)
      expect(err).toBeInstanceOf(ExternalApiError)
      expect(err).toMatchObject({ service: 'google', reason: 'budget_empty' })
    }
  })

  it('defaults to 60 calls a minute', async () => {
    expect(DEFAULT_GOOGLE_CALLS_PER_MINUTE).toBe(60)
    const h = await harness({ callsPerMinute: 'default' })
    for (let i = 0; i < 60; i++) await h.places.nearby(point(i), { categories: ['eat'] })
    expect(h.nearbyCalls()).toHaveLength(60)
    await expect(h.places.nearby(point(60), { categories: ['eat'] })).rejects.toMatchObject({ reason: 'budget_empty' })
    expect(h.nearbyCalls()).toHaveLength(60)
  })

  it('the shared budget keeps OneMap\'s error by default and takes another service\'s error when given one', async () => {
    const oneMap = createCallBudget({ callsPerMinute: 1 })
    await oneMap.run(async () => 'ok')
    await expect(oneMap.run(async () => 'no')).rejects.toBeInstanceOf(OneMapUnavailableError)
    await expect(oneMap.run(async () => 'no')).rejects.toThrow('the OneMap call budget for this minute is used up')

    const google = createCallBudget({
      callsPerMinute: 1,
      service: 'Google',
      unavailable: (reason, message, details) => new GoogleUnavailableError(reason, message, details),
    })
    await google.run(async () => 'ok')
    const err = await google.run(async () => 'no').catch((e) => e)
    expect(err).toBeInstanceOf(GoogleUnavailableError)
    expect(err.message).toBe('the Google call budget for this minute is used up')
  })
})

// ---------------------------------------------------------------- 1. radius snapping
describe('Google search radius', () => {
  it('rounds up to the planner\'s own steps, at most 3000', () => {
    expect([100, 499, 500, 501, 1000, 1001, 2000, 2001, 2999, 3000, 9999].map(snapRadius)).toEqual([500, 500, 500, 1000, 1000, 2000, 2000, 3000, 3000, 3000, 3000])
    expect(snapRadius(Number.NaN)).toBe(1000)
  })

  it('8 different radiusMeters inside one step make 1 fetch, and the circle sent covers what was asked', async () => {
    const h = await harness()
    for (const radiusMeters of [1001, 1100, 1250, 1500, 1700, 1850, 1999, 2000]) {
      expect((await h.converge(point(0), { radiusMeters })).body.google.source).toBe('google')
    }
    expect(h.nearbyCalls()).toHaveLength(1)
    expect(h.nearbyCalls()[0].body.locationRestriction.circle.radius).toBe(2000)
  })

  it('the default radius is still 1000', async () => {
    const h = await harness()
    await h.converge(point(0))
    expect(h.nearbyCalls()[0].body.locationRestriction.circle.radius).toBe(1000)
  })
})

// ---------------------------------------------------------------- 2. the circuit, the timeout and the log
describe('Google circuit and timeout', () => {
  const failing = () => json({ error: 'nope' }, 503)

  it('opens after 3 failures in a row, makes no fetch for a minute, then tries one call; one success closes it', async () => {
    const h = await harness({ respond: failing })
    for (let i = 0; i < GOOGLE_FAILURES_TO_OPEN; i++) {
      expect((await h.converge(point(i))).body.google.source).toBe('unavailable')
    }
    expect(h.nearbyCalls()).toHaveLength(3)

    const started = Date.now()
    const fourth = await h.converge(point(3))
    expect(Date.now() - started).toBeLessThan(GOOGLE_TIMEOUT_MS / 2)
    expect(fourth.status).toBe(200)
    expect(fourth.body.google.source).toBe('unavailable')
    expect(h.nearbyCalls()).toHaveLength(3)

    h.clock.advance(GOOGLE_CIRCUIT_OPEN_MS - 1)
    await h.converge(point(4))
    expect(h.nearbyCalls()).toHaveLength(3)

    h.clock.advance(1) // The minute is over: one call is tried, and it fails, so the pause starts again.
    await h.converge(point(5))
    expect(h.nearbyCalls()).toHaveLength(4)
    await h.converge(point(6))
    expect(h.nearbyCalls()).toHaveLength(4)

    h.clock.advance(GOOGLE_CIRCUIT_OPEN_MS)
    h.answerWith((call) => json(GOOD))
    expect((await h.converge(point(7))).body.google.source).toBe('google')
    expect(h.nearbyCalls()).toHaveLength(5)
    // Closed: the next searches are all made.
    expect((await h.converge(point(8))).body.google.source).toBe('google')
    expect((await h.converge(point(9))).body.google.source).toBe('google')
    expect(h.nearbyCalls()).toHaveLength(7)
  })

  it('a success in between keeps the count at "in a row"', async () => {
    const h = await harness({ respond: failing })
    await h.converge(point(0))
    await h.converge(point(1))
    h.answerWith(() => json(GOOD))
    await h.converge(point(2))
    h.answerWith(failing)
    await h.converge(point(3))
    await h.converge(point(4))
    await h.converge(point(5)) // Only 2 failures since the success: still closed, so this one fetches.
    expect(h.nearbyCalls()).toHaveLength(6)
  })

  it('after the pause, only one call at a time is let through to test Google', async () => {
    const h = await harness({ respond: failing, delayMs: 20 })
    for (let i = 0; i < 3; i++) await h.places.nearby(point(i), { categories: ['eat'] }).catch(() => {})
    h.clock.advance(GOOGLE_CIRCUIT_OPEN_MS)
    const before = h.calls.length
    const results = await Promise.allSettled([3, 4, 5].map((i) => h.places.nearby(point(i), { categories: ['eat'] })))
    expect(h.calls.length - before).toBe(1)
    expect(results.map((r) => r.reason.reason).sort()).toEqual(['circuit_open', 'circuit_open', undefined])
  })

  it('a hung Google gives "unavailable" when the timeout fires, and the planner request is not held up beyond it', async () => {
    const h = await harness({ respond: hang, timeoutMs: 100 })
    const started = Date.now()
    const res = await h.converge(point(0))
    const took = Date.now() - started
    expect(res.status).toBe(200)
    expect(res.body.google).toEqual({ source: 'unavailable', added: 0 })
    expect(res.body.results.length).toBeGreaterThan(0)
    expect(took).toBeGreaterThanOrEqual(80)
    expect(took).toBeLessThan(2000)
  })

  it('six concurrent requests to a hung Google all get answered, and the next one returns at once with no fetch', async () => {
    const h = await harness({ respond: hang, timeoutMs: 100 })
    const started = Date.now()
    const all = await Promise.all(Array.from({ length: 6 }, (_, i) => h.converge(point(i))))
    expect(Date.now() - started).toBeLessThan(1500)
    for (const r of all) {
      expect(r.status).toBe(200)
      expect(r.body.google.source).toBe('unavailable')
    }
    const fetched = h.nearbyCalls().length
    expect(h.peak()).toBeLessThanOrEqual(GOOGLE_MAX_IN_FLIGHT)
    const before = Date.now()
    await h.converge(point(7))
    expect(Date.now() - before).toBeLessThan(500)
    expect(h.nearbyCalls()).toHaveLength(fetched)
  })

  it('a call that waited a long time for a slot while Google was failing is not started', async () => {
    // Four calls hang and fill every slot; a fifth waits. When the first hung call fails (one failure: the circuit is not
    // open yet) the fifth gets its slot, but it waited a whole timeout, so it is refused and makes no request of its own.
    const clock = makeClock()
    const hung = []
    const http = {
      postJson: vi.fn(() => new Promise((_, reject) => hung.push(() => reject(new ExternalApiError('google timed out', { service: 'google', status: null, url: 'u' }))))),
      getJson: vi.fn(),
    }
    const places = createGooglePlaces({ http, apiKey: KEY, now: clock.now, callsPerMinute: 1000 })
    const calls = Array.from({ length: GOOGLE_MAX_IN_FLIGHT + 1 }, (_, i) => places.nearby(point(i), { categories: ['eat'] }).then(() => 'ok', (err) => err))
    await vi.waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(GOOGLE_MAX_IN_FLIGHT))
    clock.advance(GOOGLE_STALE_WAIT_MS + 2000)
    hung[0]()
    const fifth = await calls[GOOGLE_MAX_IN_FLIGHT]
    expect(fifth).toBeInstanceOf(GoogleUnavailableError)
    expect(http.postJson).toHaveBeenCalledTimes(GOOGLE_MAX_IN_FLIGHT) // the fifth never made a request
    hung.slice(1).forEach((fail) => fail())
    await Promise.all(calls)
  })

  it('a call that waited just as long while Google was healthy still goes ahead', async () => {
    const clock = makeClock()
    const finish = []
    const http = {
      postJson: vi.fn(() => new Promise((resolve) => finish.push(() => resolve({ places: [] })))),
      getJson: vi.fn(),
    }
    const places = createGooglePlaces({ http, apiKey: KEY, now: clock.now, callsPerMinute: 1000 })
    const calls = Array.from({ length: GOOGLE_MAX_IN_FLIGHT + 1 }, (_, i) => places.nearby(point(i), { categories: ['eat'] }))
    await vi.waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(GOOGLE_MAX_IN_FLIGHT))
    clock.advance(GOOGLE_STALE_WAIT_MS + 2000)
    finish[0]() // a success: no failure to be suspicious of
    await vi.waitFor(() => expect(http.postJson).toHaveBeenCalledTimes(GOOGLE_MAX_IN_FLIGHT + 1))
    finish.slice(1).forEach((done) => done())
    await Promise.all(calls)
  })

  it('asks the HTTP helper for a 3 second wait, and the helper takes a wait per call', async () => {
    expect(GOOGLE_TIMEOUT_MS).toBe(3000)
    const http = { postJson: vi.fn(async () => ({ places: [] })), getJson: vi.fn(async () => ({ photoUri: GOOD_LINK })) }
    const places = createGooglePlaces({ http, apiKey: KEY })
    await places.nearby(point(0), { categories: ['eat'] })
    await places.photoUrl(PHOTO)
    expect(http.postJson.mock.calls[0][2].timeoutMs).toBe(3000)
    expect(http.getJson.mock.calls[0][1].timeoutMs).toBe(3000)

    const slowHttp = createHttp({ fetchImpl: hang, timeoutMs: 10_000 })
    await expect(slowHttp.getJson('https://places.googleapis.com/v1/x', { timeoutMs: 30 })).rejects.toThrow('timed out after 30ms')
    await expect(slowHttp.postJson('https://places.googleapis.com/v1/x', {}, { timeoutMs: 30 })).rejects.toThrow('timed out after 30ms')
  })

  it('writes one warning per reason a minute: 10 failing requests make one "upstream_error" line and one "circuit_open" line', async () => {
    const h = await harness({ respond: failing })
    for (let i = 0; i < 10; i++) await h.converge(point(i))
    expect(h.logged).toHaveLength(2)
    expect(h.logged.filter((l) => l.includes('upstream_error'))).toHaveLength(1)
    expect(h.logged.filter((l) => l.includes('circuit_open'))).toHaveLength(1)
    expect(h.logged[0]).toContain('HTTP 503')
    expect(consoleWarn).not.toHaveBeenCalled() // The planner route no longer logs each request itself.

    h.clock.advance(61_000)
    await h.converge(point(11)) // The test call after the pause fails again, in a new minute: logged again.
    expect(h.logged).toHaveLength(3)
  })
})

// ---------------------------------------------------------------- 3. answers of the wrong shape
describe('Google answers of the wrong shape', () => {
  const near = { lat: 1.3504, lng: 103.8428 }
  const shapes = [
    ['places is a string', { places: 'oops' }, 'unavailable'],
    ['places is an object', { places: {} }, 'unavailable'],
    ['places holds null', { places: [null] }, 'google'],
  ]

  it.each(shapes)('%s: the request is still answered with the other venues, and the bad answer is not kept', async (_name, bad, source) => {
    const h = await harness({ respond: () => json(bad) })
    const first = await h.converge(near)
    expect(first.status).toBe(200)
    expect(first.body.google.source).toBe(source)
    expect(first.body.google.added).toBe(0)
    expect(first.body.results.length).toBeGreaterThan(0)

    h.answerWith(() => json(GOOD))
    const second = await h.converge(near)
    expect(second.body.google.source).toBe('google')
    expect(second.body.google.added).toBeGreaterThan(0)
    expect(h.nearbyCalls()).toHaveLength(2)
  })

  it('a place whose opening hours hold a null is still used, with the null ignored', async () => {
    const place = GOOD.places.find((p) => p.id === 'stub_place_03')
    const odd = { places: [{ ...place, regularOpeningHours: { periods: [null, { open: { day: 6, hour: 11 }, close: { day: 6, hour: 22 } }] } }] }
    const h = await harness({ respond: () => json(odd) })
    const res = await h.converge(near)
    expect(res.status).toBe(200)
    expect(res.body.google).toEqual({ source: 'google', added: 1 })
  })

  it('good places next to bad entries are kept, and the answer is not cached', async () => {
    const h = await harness({ respond: () => json({ places: [null, 'x', { id: 7 }, ...GOOD.places] }) })
    expect((await h.converge(near)).body.google.added).toBeGreaterThan(0)
    await h.converge(near)
    expect(h.nearbyCalls()).toHaveLength(2)
  })

  it('a failed shape counts toward the circuit; a clean empty answer ({}) does not', async () => {
    const h = await harness({ respond: () => json({}) })
    for (let i = 0; i < 5; i++) expect((await h.converge(point(i))).body.google.source).toBe('google')
    expect(h.nearbyCalls()).toHaveLength(5)
    h.answerWith(() => json({ places: 'oops' }))
    for (let i = 5; i < 9; i++) await h.converge(point(i))
    expect(h.nearbyCalls()).toHaveLength(8)
  })

  it('fromGooglePlaces skips what it cannot read and keeps the rest', () => {
    const good = GOOD.places[0]
    const venues = fromGooglePlaces(
      [null, 'x', 7, [], {}, { ...good, id: undefined }, { ...good, id: '' }, { ...good, location: 'here' }, { ...good, location: { latitude: 'a', longitude: 1 } }, { ...good, id: 'bad_types', types: 5 }, good],
      '2026-10-10T19:00',
    )
    expect(venues.map((v) => v.googlePlaceId)).toEqual([good.id])
    expect(fromGooglePlaces('oops', '2026-10-10T19:00')).toEqual([])
    expect(fromGooglePlaces(undefined, '2026-10-10T19:00')).toEqual([])
  })

  it('a photo keeps every author, and `credit` stays the first', () => {
    const place = {
      ...GOOD.places[0],
      photos: [{ name: PHOTO, authorAttributions: [{ displayName: 'One', uri: 'https://x/1' }, null, { displayName: 'Two', uri: 'https://x/2' }] }],
    }
    const { photo } = fromGooglePlace(place, '2026-10-10T19:00')
    expect(photo.credit).toEqual({ displayName: 'One', uri: 'https://x/1' })
    expect(photo.credits.map((c) => c.displayName)).toEqual(['One', 'Two'])
    expect(fromGooglePlace({ ...place, photos: [{ name: PHOTO }] }, '2026-10-10T19:00').photo).toEqual({ name: PHOTO, credit: null, credits: [] })
    expect(fromGooglePlace({ ...place, photos: [{ widthPx: 1 }] }, '2026-10-10T19:00').photo).toBeNull()
  })
})

// ---------------------------------------------------------------- 4. the photo route
describe('GET /api/places/photo', () => {
  it('rounds a width to an integer and up to 200, 400, 800 or 1600', async () => {
    expect([1, 100, 200, 201, 250.7, 400, 401, 800, 801, 1600, 1601, 99999, Number.NaN, '300'].map(snapPhotoWidth)).toEqual([200, 200, 200, 400, 400, 400, 800, 800, 1600, 1600, 1600, 1600, 400, 400])
    const h = await harness()
    const cases = [['250.7', 400], ['100', 200], ['201', 400], ['800', 800], ['801', 1600], ['99999', 1600], ['abc', 400], ['-5', 200], ['0', 400]]
    for (const [i, [maxWidth, expected]] of cases.entries()) {
      const res = await h.photo(`name=places/p${i}/photos/x&maxWidth=${maxWidth}`)
      expect(res.status, maxWidth).toBe(302)
      expect(h.photoCalls().at(-1).url, maxWidth).toContain(`maxWidthPx=${expected}&`)
    }
    expect(h.photoCalls().every((c) => /maxWidthPx=\d+&/.test(c.url))).toBe(true)
  })

  it('odd widths that land on the same size share one Google call', async () => {
    const h = await harness()
    for (const maxWidth of ['250.7', '300', '399', '400', '201']) await h.photo(`name=${PHOTO}&maxWidth=${maxWidth}`)
    expect(h.photoCalls()).toHaveLength(1)
    await h.photo(`name=${PHOTO}`) // No width: 400 as well.
    expect(h.photoCalls()).toHaveLength(1)
  })

  it('refuses a name with an id over 300 characters (400, with a message) and makes no call', async () => {
    const h = await harness()
    for (const name of [`places/${'a'.repeat(10_000)}/photos/b`, `places/a/photos/${'b'.repeat(301)}`, `places/${'a'.repeat(301)}/photos/b`, 'places//photos/b', 'places/a/photos/']) {
      const res = await h.photo(`name=${name}`)
      expect(res.status, name.slice(0, 40)).toBe(400)
      expect(res.body.error).toBe('invalid_input')
      expect(typeof res.body.message).toBe('string')
      expect(res.body.issues[0].path).toBe('name')
    }
    expect(h.calls).toHaveLength(0)
    expect((await h.photo(`name=places/${'a'.repeat(300)}/photos/${'b'.repeat(300)}`)).status).toBe(302)
  })

  it('redirects with a cache header to a Google image link', async () => {
    const h = await harness()
    const res = await h.photo(`name=${PHOTO}`)
    expect(res.status).toBe(302)
    expect(res.location).toBe(GOOD_LINK)
    expect(res.cacheControl).toBe('public, max-age=1800')
    expect(h.photoCalls()[0].headers['X-Goog-Api-Key']).toBe(KEY) // The key goes to Google, never to the browser.
    expect(h.photoCalls()[0].url).not.toContain(KEY)
  })

  it.each([
    ['a number', 12345],
    ['an object', { url: GOOD_LINK }],
    ['a list', [GOOD_LINK]],
    ['null', null],
    ['nothing', undefined],
    ['javascript:', 'javascript:alert(1)'],
    ['another host', 'https://evil.example/x'],
    ['a look-alike host', 'https://googleusercontent.com.evil.example/x'],
    ['a host that only ends the same', 'https://evilgoogleusercontent.com/x'],
    ['the Google host in the user name', 'https://lh3.googleusercontent.com@evil.example/x'],
    ['http:', 'http://lh3.googleusercontent.com/x'],
    ['a data: link', 'data:text/html,hi'],
    ['no address at all', 'lh3.googleusercontent.com/x'],
  ])('answers 502 for a photoUri that is %s: no redirect, and nothing cached', async (_name, photoUri) => {
    const h = await harness({ respond: () => json({ photoUri }) })
    const res = await h.photo(`name=${PHOTO}`)
    expect(res.status).toBe(502)
    expect(res.location).toBeNull()
    expect(res.body.error).toBe('photos_unavailable')
    expect(typeof res.body.message).toBe('string')
    await h.photo(`name=${PHOTO}`)
    expect(h.photoCalls()).toHaveLength(2)
  })

  it('accepts googleusercontent.com, ggpht.com and their subdomains over https, and sends the address as parsed', async () => {
    for (const link of ['https://googleusercontent.com/a', 'https://lh3.googleusercontent.com/a=s400', 'https://lh5.ggpht.com/a', 'https://GGPHT.com/a']) {
      const h = await harness({ respond: () => json({ photoUri: link }) })
      const res = await h.photo(`name=${PHOTO}`)
      expect(res.status, link).toBe(302)
      expect(res.location, link).toBe(new URL(link).href)
    }
    expect(safeImageUrl('https://lh3.googleusercontent.com:8443/a')).not.toBeNull() // Same host, other port: still Google's.
    expect(safeImageUrl('https://x.googleusercontent.com.')).toBeNull()
  })

  it.each([404, 400])('a Google %i is remembered for 5 minutes, answers 404, and does not count toward the circuit', async (status) => {
    const h = await harness({ respond: (call) => (isNearby(call.url) ? json(GOOD) : json({ error: 'gone' }, status)) })
    const first = await h.photo(`name=${PHOTO}`)
    expect(first.status).toBe(404)
    expect(first.body.error).toBe('not_found')
    expect(h.photoCalls()).toHaveLength(1)

    h.clock.advance(PHOTO_MISS_MS - 1000)
    expect((await h.photo(`name=${PHOTO}`)).status).toBe(404)
    expect(h.photoCalls()).toHaveLength(1)

    h.clock.advance(1001)
    expect((await h.photo(`name=${PHOTO}`)).status).toBe(404)
    expect(h.photoCalls()).toHaveLength(2)

    // Several missing photos in a row never pause Google.
    for (let i = 0; i < 5; i++) await h.photo(`name=places/p${i}/photos/x`)
    expect((await h.converge(point(0))).body.google.source).toBe('google')
    expect(h.logged).toHaveLength(0)
  })

  it('any other Google failure is 503 "photos_unavailable" and counts toward the circuit', async () => {
    const h = await harness({ respond: () => json({}, 500) })
    for (let i = 0; i < 3; i++) {
      const res = await h.photo(`name=places/p${i}/photos/x`)
      expect(res.status).toBe(503)
      expect(res.body.error).toBe('photos_unavailable')
    }
    const paused = await h.photo('name=places/p9/photos/x')
    expect(paused.status).toBe(503)
    expect(h.photoCalls()).toHaveLength(3)
  })

  it('still answers from the stub fixtures in stub mode', async () => {
    const server = createApp({ frontendOrigin: FRONTEND, stub: true, planData }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/places/photo?name=places/abc/photos/def&maxWidth=250.7`, { redirect: 'manual' })
    expect(res.status).toBe(302)
    expect(res.headers.get('location')).toBe(GOOD_LINK)
    expect(res.headers.get('cache-control')).toBe('public, max-age=1800')
  })
})

// ---------------------------------------------------------------- 5. the key
describe('GOOGLE_MAPS_API_KEY and GOOGLE_CALLS_PER_MINUTE', () => {
  it('trims the key; blank, whitespace-only and malformed values are not a key', () => {
    expect(readGoogleSettings({ GOOGLE_MAPS_API_KEY: `  ${KEY}\n` })).toEqual({ apiKey: KEY, callsPerMinute: 60, warnings: [] })
    for (const blank of [undefined, '', '   ', '\t\n']) {
      expect(readGoogleSettings({ GOOGLE_MAPS_API_KEY: blank })).toEqual({ apiKey: null, callsPerMinute: 60, warnings: [] })
    }
    for (const bad of ['abc def', 'abc\tdef', 'abc\ndef', 'abc\u0000def', 'abc\u007fdef', 'clé-ü', 'ab cd']) {
      const settings = readGoogleSettings({ GOOGLE_MAPS_API_KEY: bad })
      expect(settings.apiKey, JSON.stringify(bad)).toBeNull()
      expect(settings.warnings).toHaveLength(1)
      expect(settings.warnings[0]).toContain('GOOGLE_MAPS_API_KEY is malformed')
      expect(settings.warnings[0]).not.toContain('abc')
      expect(settings.warnings[0]).not.toContain('def')
    }
  })

  it('reads the call cap; a missing or invalid value means 60', () => {
    expect(readGoogleSettings({ GOOGLE_CALLS_PER_MINUTE: '25' }).callsPerMinute).toBe(25)
    expect(readGoogleSettings({ GOOGLE_CALLS_PER_MINUTE: ' 25 ' }).callsPerMinute).toBe(25)
    for (const missing of [undefined, '', '  ']) {
      expect(readGoogleSettings({ GOOGLE_CALLS_PER_MINUTE: missing })).toMatchObject({ callsPerMinute: 60, warnings: [] })
    }
    for (const bad of ['0', '-3', '2.5', 'many', 'NaN', 'Infinity']) {
      const settings = readGoogleSettings({ GOOGLE_CALLS_PER_MINUTE: bad })
      expect(settings.callsPerMinute, bad).toBe(60)
      expect(settings.warnings[0]).toContain('GOOGLE_CALLS_PER_MINUTE')
    }
  })

  it('a whitespace-only or malformed key leaves Google off, with zero fetches', async () => {
    for (const value of ['   ', '\n', 'AIza key with spaces']) {
      const { apiKey } = readGoogleSettings({ GOOGLE_MAPS_API_KEY: value })
      const h = await harness({ apiKey })
      expect(h.places.enabled).toBe(false)
      const res = await h.converge(point(0))
      expect(res.status).toBe(200)
      expect(res.body.google).toEqual({ source: 'off', added: 0 })
      expect((await h.photo(`name=${PHOTO}`)).status).toBe(503)
      expect(h.calls).toHaveLength(0)
    }
  })

  it('a key is trimmed even when it reaches the service untrimmed, and goes only in the header', async () => {
    const h = await harness({ apiKey: `  ${KEY}  ` })
    await h.converge(point(0))
    expect(h.nearbyCalls()[0].headers['X-Goog-Api-Key']).toBe(KEY)
    expect(h.nearbyCalls()[0].url).not.toContain('AIza')
  })

  it('never puts the key in a response, a header or a log line, even when every call fails', async () => {
    const h = await harness({ respond: () => json({ error: { message: 'bad key' } }, 403) })
    for (let i = 0; i < 5; i++) await h.converge(point(i))
    await h.photo(`name=${PHOTO}`)
    expect(h.logged.length).toBeGreaterThan(0)
    // The afterEach hook checks every response and log line collected in `seen`.
    expect(seen.length).toBeGreaterThan(5)
  })
})

// ---------------------------------------------------------------- 7. the ranking point
describe('the point Google places are fetched around', () => {
  const home = (lat, lng) => ({ lat, lng })
  const members = [
    { id: 'a', home: home(1.3541, 103.9446) },
    { id: 'b', home: home(1.315, 103.765) },
    { id: 'c', home: home(1.437, 103.7865), travelDebtMinutes: 90 },
  ]

  async function pointFor(extra) {
    const asked = []
    const places = { enabled: true, nearby: vi.fn(async (p) => { asked.push(p); return [] }), photoUrl: vi.fn() }
    const server = createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }), places, planData }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/converge`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ members, occasion: 'casual_meal', dateTime: '2026-10-10T19:00', categories: ['eat'], unknownPolicy: 'lenient', ...extra }),
    })
    const body = await res.json()
    return { asked: asked[0], centre: body.centre }
  }

  it.each([['minimax'], ['centroid'], ['weighted_centroid'], [undefined]])('seed %s: Google is asked around the same point the engine ranks around', async (seed) => {
    const { asked, centre } = await pointFor(seed ? { seed } : {})
    expect(centre).toBeDefined()
    expect(asked.lat).toBeCloseTo(centre.lat, 9)
    expect(asked.lng).toBeCloseTo(centre.lng, 9)
  })

  it('the three seeds are different points for this group (so the test above can tell them apart)', async () => {
    const a = (await pointFor({ seed: 'minimax' })).asked
    const b = (await pointFor({ seed: 'centroid' })).asked
    const c = (await pointFor({})).asked
    expect(a.lat).not.toBeCloseTo(b.lat, 4)
    expect(b.lat === c.lat && b.lng === c.lng).toBe(false)
  })

  it('a given centre wins over the seed', async () => {
    const centre = { lat: 1.3, lng: 103.8 }
    expect((await pointFor({ seed: 'minimax', centre })).asked).toEqual(centre)
  })
})

// ---------------------------------------------------------------- 8. the error shape
describe('invalid_input', () => {
  it('has a message as well as the issues', async () => {
    const h = await harness()
    const res = await h.post('/converge', { ...h.slot(point(0)), occasion: 'brunch', weights: { worst: -5 } })
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_input')
    expect(typeof res.body.message).toBe('string')
    expect(res.body.message.length).toBeGreaterThan(0)
    expect(res.body.issues.map((i) => i.path).sort()).toEqual(['occasion', 'weights.worst'])
    expect(h.calls).toHaveLength(0)
  })
})

// ---------------------------------------------------------------- defaults
describe('defaults with Google off', () => {
  const FIXED = { occasion: 'casual_meal', dateTime: '2026-10-10T19:00', durationMinutes: 90, unknownPolicy: 'lenient' }
  const group = [
    { id: 'ian', home: { lat: 1.3541, lng: 103.9446 } },
    { id: 'faith', home: { lat: 1.315, lng: 103.765 }, dietary: ['Halal'] },
  ]

  it('a converge and a roam answer the same with minOptions and shortlistSize left out as with the engine\'s own 3 and 10', async () => {
    const server = createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }), planData }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    servers.push(server)
    const call = async (path, body) => {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, text: await res.text() }
    }
    const requests = [
      ['/converge', { ...FIXED, members: group, categories: ['eat', 'drink'] }],
      ['/converge', { ...FIXED, members: group, categories: ['shop'], seed: 'minimax' }],
      ['/roam', { ...FIXED, current: { lat: 1.3008, lng: 103.8558 }, members: [{ id: 'ian' }], categories: ['eat', 'drink', 'activity'] }],
    ]
    for (const [path, body] of requests) {
      const plain = await call(path, body)
      const explicit = await call(path, { ...body, minOptions: 3, shortlistSize: 10 })
      expect(plain.status).toBe(200)
      expect(JSON.parse(plain.text).google).toEqual({ source: 'off', added: 0 })
      expect(explicit.text, path).toBe(plain.text)
    }
  })
})
