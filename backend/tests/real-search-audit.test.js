// The fixes from the audit of the Google search pull request: OneMap's cache left alone, made-up place ids costing
// one look-up and no more, the location search's mask and its conditions, rows that say where they came from, venues
// added late placed under every kind of weather, only outings offered as activities, failures that show in the answer,
// search quality, and the time Google may add to a ranking.
// Nothing touches the network: a fake fetch sits under the real HTTP helper (for Google and OneMap), the weather world
// of tests/helpers answers data.gov.sg, and a clock the test moves drives the caches.
import { once } from 'node:events'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { dropKnownPlaces, loadPlanData } from '../src/db/venues.js'
import { searchVenues } from '../src/planner/engine.js'
import { fromGooglePlace, OUTING_TYPES } from '../src/planner/google-adapter.js'
import { placeVenues } from '../src/planner/weather-window.js'
import { createGooglePlaces, GoogleUnavailableError, NEARBY_FIELDS, PLACE_MISS_MS, PLACE_SEARCH_FIELDS, TEXT_SEARCH_URL } from '../src/services/google-places.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'
import { loadFixture } from '../src/services/stubs.js'
import { at, makeWorld, regionalAnswer, startApp as startWeatherApp } from './helpers/weather-world.js'

const FRONTEND = 'http://localhost:5173'
const KEY = 'AIzaFAKE-KEY-never-print-0123456789'
const NEARBY = loadFixture('google/places-nearby.json')
const TEXT = loadFixture('google/places-text-search.json')
const planData = loadPlanData()
const ORCHARD = { lat: 1.3048, lng: 103.8318 }
const BISHAN = { lat: 1.3504, lng: 103.8485 }
const GROUP = [
  { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
  { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
]

beforeEach(() => {
  vi.spyOn(console, 'warn').mockImplementation(() => {})
  vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => vi.restoreAllMocks())

// ---------------------------------------------------------------- helpers
const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const kindOfCall = (url) => {
  if (url.includes('places:searchText')) return 'text'
  if (url.includes('places:searchNearby')) return 'nearby'
  if (url.includes('/media')) return 'photo'
  return /\/v1\/places\/[^/]+$/.test(url) ? 'details' : 'other'
}
const placeIdOf = (url) => decodeURIComponent(url.split('/').pop())
const everyone = [...NEARBY.places, ...TEXT.places]

// A fetch that never answers until its timeout fires, like a hung Google.
const hang = (url, init) => new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason)))

const makeClock = (start = Date.UTC(2026, 9, 10, 4, 0, 0)) => {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

// The real Google service over a fake fetch. `respond(call)` answers each call; the default answers the invented
// fixtures, and a 404 for any other place id. `calls` records every call, `peak(kind)` the most of one kind at once.
function makeGoogle({ respond, callsPerMinute = 1000, timeoutMs, delayMs = 0 } = {}) {
  const clock = makeClock()
  const calls = []
  const flying = {}
  const peaks = {}
  const defaultRespond = (call) => {
    if (call.kind === 'text') return json(TEXT)
    if (call.kind === 'nearby') return json(NEARBY)
    if (call.kind === 'details') {
      const place = everyone.find((p) => p.id === placeIdOf(call.url))
      return place ? json(place) : json({ error: { status: 'NOT_FOUND' } }, 404)
    }
    return json({})
  }
  const answer = respond ?? defaultRespond
  const fetchImpl = async (url, init) => {
    const call = { url, kind: kindOfCall(url), body: init.body ? JSON.parse(init.body) : undefined, headers: init.headers }
    calls.push(call)
    flying[call.kind] = (flying[call.kind] ?? 0) + 1
    peaks[call.kind] = Math.max(peaks[call.kind] ?? 0, flying[call.kind])
    try {
      if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs))
      return await answer(call, init, defaultRespond)
    } finally {
      flying[call.kind] -= 1
    }
  }
  const logged = []
  const places = createGooglePlaces({
    http: createHttp({ fetchImpl }),
    apiKey: KEY,
    callsPerMinute,
    timeoutMs,
    now: clock.now,
    warn: (...args) => logged.push(args.join(' ')),
  })
  return { places, clock, calls, logged, of: (kind) => calls.filter((c) => c.kind === kind), peak: (kind) => peaks[kind] ?? 0 }
}

// A OneMap service over a fake fetch. `body` is what its search answers (a function of the query, or a value).
function makeOneMap(body) {
  const calls = []
  const fetchImpl = async (url) => {
    calls.push(url)
    return json(typeof body === 'function' ? body(new URL(url).searchParams.get('searchVal')) : body)
  }
  return { onemap: createOneMap({ http: createHttp({ fetchImpl }) }), calls }
}
const oneMapRow = (name, extra = {}) => ({ BUILDING: name, SEARCHVAL: name, ADDRESS: `1 ${name} ROAD`, POSTAL: '123456', LATITUDE: '1.3', LONGITUDE: '103.84', ...extra })

// Servers listen on 127.0.0.1 only and are closed after each test: a server on every address can be given a port that
// another server on this machine already holds on 127.0.0.1 (or the reverse), and a request then reaches the wrong one.
const servers = []
afterEach(() => Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve)))))

// A running planner app. Returns get(path) and post(path, body).
async function startApp(deps = {}) {
  const app = createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }), ...deps })
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  servers.push(server)
  const base = `http://127.0.0.1:${server.address().port}/api`
  return {
    get: async (path) => {
      const res = await fetch(`${base}${path}`)
      return { status: res.status, body: await res.json(), headers: res.headers }
    },
    post: async (path, body) => {
      const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      return { status: res.status, body: await res.json() }
    },
  }
}

const rankBody = (extra = {}) => ({
  members: GROUP,
  occasion: 'casual_meal',
  dateTime: '2026-10-17T19:00',
  durationMinutes: 90,
  categories: ['activity'],
  centre: ORCHARD,
  unknownPolicy: 'lenient',
  topN: 12,
  ...extra,
})
const searchBody = (query, extra = {}) => ({ centre: ORCHARD, dateTime: '2026-10-17T19:00', durationMinutes: 120, categories: ['activity'], query, ...extra })
const invented = (n) => Array.from({ length: n }, (_, i) => `google_invented${i + 1}`)

// ---------------------------------------------------------------- 1. OneMap's cache
describe('Google rows never reach OneMap\'s 24-hour cache', () => {
  it('a Google answer is not kept by the next search when Google then fails, and the cache entry is unchanged', async () => {
    const { onemap, calls } = makeOneMap({ found: 0, results: [] })
    let google = 'answers'
    const searchText = vi.fn(async () => {
      if (google === 'fails') throw new ExternalApiError('google answered 503', { service: 'google', status: 503, url: 'x' })
      return [{ id: 'g1', displayName: { text: 'Teo Heng KTV' }, location: { latitude: 1.3, longitude: 103.84 }, formattedAddress: '1 Example Rd, Singapore 123456' }]
    })
    const app = await startApp({ onemap, places: { enabled: true, searchText } })

    const first = await app.get('/places/search?q=Teo%20Heng')
    expect(first.body.results.map((r) => [r.name, r.source])).toEqual([['Teo Heng KTV', 'google']])
    google = 'fails'
    const second = await app.get('/places/search?q=Teo%20Heng')
    expect(second.status).toBe(200)
    expect(second.body.results).toEqual([]) // the old code answered the Google row again, out of OneMap's cache

    expect(await onemap.search('Teo Heng')).toEqual([]) // the cache entry itself
    expect(calls).toHaveLength(1) // and both searches used it
  })

  it('OneMap rows keep their shape in the cache: the "source" is added to a copy', async () => {
    const { onemap } = makeOneMap({ results: [oneMapRow('A'), oneMapRow('B')] })
    const app = await startApp({ onemap })
    const { body } = await app.get('/places/search?q=Hall')
    expect(body.results.map((r) => r.source)).toEqual(['onemap', 'onemap'])
    const cached = await onemap.search('Hall')
    expect(cached).toHaveLength(2)
    for (const row of cached) expect(row).not.toHaveProperty('source')
  })
})

// ---------------------------------------------------------------- 2. look-ups by id
describe('looking a place up by id', () => {
  it('remembers a 404 for 5 minutes, then asks again', async () => {
    const g = makeGoogle()
    expect(await g.places.details('invented1')).toBeNull()
    expect(await g.places.details('invented1')).toBeNull()
    expect(g.of('details')).toHaveLength(1)
    expect(g.places.peekDetails('invented1')).toEqual({ state: 'missing' })
    g.clock.advance(PLACE_MISS_MS + 1)
    expect(g.places.peekDetails('invented1')).toEqual({ state: 'call' })
    await g.places.details('invented1')
    expect(g.of('details')).toHaveLength(2)
  })

  it('says what a look-up would do without doing it', async () => {
    const g = makeGoogle()
    expect(g.places.peekDetails('stub_text_01')).toEqual({ state: 'call' })
    const place = await g.places.details('stub_text_01')
    expect(g.places.peekDetails('stub_text_01')).toEqual({ state: 'cached', place })
    expect(g.of('details')).toHaveLength(1)
  })

  it('a 404 is not a failure: it does not open the circuit or reach the log', async () => {
    const g = makeGoogle()
    for (let i = 0; i < 5; i++) await g.places.details(`invented${i}`)
    expect(g.logged).toEqual([])
    expect((await g.places.details('stub_text_01')).id).toBe('stub_text_01') // Google was never paused
  })

  it('a 400 is a failure: it is thrown, not remembered, counted toward the circuit, and logged once a minute', async () => {
    const g = makeGoogle({ respond: () => json({ error: { status: 'INVALID_ARGUMENT' } }, 400) })
    await expect(g.places.details('badmask1')).rejects.toMatchObject({ status: 400 })
    await expect(g.places.details('badmask1')).rejects.toMatchObject({ status: 400 })
    expect(g.of('details')).toHaveLength(2) // not remembered as missing
    expect(g.places.peekDetails('badmask1')).toEqual({ state: 'call' })
    expect(g.logged).toHaveLength(1) // one line a minute for the same reason
    expect(g.logged[0]).toContain('HTTP 400')
    await expect(g.places.details('badmask2')).rejects.toMatchObject({ status: 400 }) // the third in a row
    await expect(g.places.details('badmask3')).rejects.toBeInstanceOf(GoogleUnavailableError) // the circuit is open
    expect(g.of('details')).toHaveLength(3)
    g.clock.advance(61_000)
    await expect(g.places.details('badmask1')).rejects.toBeInstanceOf(ExternalApiError)
    expect(g.logged.length).toBeGreaterThan(1) // a minute later it is logged again
  })

  describe('in a ranking', () => {
    const rank = (app, ids, extra) => app.post('/converge', rankBody({ currentOptionIds: ids, ...extra }))

    it('six invented ids: at most 3 look-ups a request, then none, and every answer lists all six as missing', async () => {
      const g = makeGoogle()
      const app = await startApp({ places: g.places })
      const ids = invented(6)

      const first = await rank(app, ids)
      expect(first.status).toBe(200)
      expect(g.of('details').map((c) => placeIdOf(c.url))).toEqual(['invented1', 'invented2', 'invented3'])
      expect(first.body.google.missing).toEqual(ids)

      const second = await rank(app, ids)
      expect(second.status).toBe(200)
      // The three asked about are remembered; the other three had not been asked yet, so they are now.
      expect(g.of('details').map((c) => placeIdOf(c.url))).toEqual(invented(6).map((id) => id.slice(7)))
      expect(second.body.google.missing).toEqual(ids)

      const third = await rank(app, ids)
      expect(g.of('details')).toHaveLength(6) // ten more such requests would cost nothing
      for (let i = 0; i < 10; i++) await rank(app, ids)
      expect(g.of('details')).toHaveLength(6)
      expect(third.body.google.missing).toEqual(ids)
    })

    it('three invented ids: the second identical request makes no look-up at all', async () => {
      const g = makeGoogle()
      const app = await startApp({ places: g.places })
      await rank(app, invented(3))
      expect(g.of('details')).toHaveLength(3)
      const again = await rank(app, invented(3))
      expect(g.of('details')).toHaveLength(3)
      expect(again.body.google.missing).toEqual(invented(3))
    })

    it('runs at most 2 look-ups at once', async () => {
      const g = makeGoogle({ delayMs: 40 })
      const app = await startApp({ places: g.places })
      await rank(app, invented(3))
      expect(g.of('details')).toHaveLength(3)
      expect(g.peak('details')).toBe(2)
    })

    it('a place found is not missing, and a place seen before costs no look-up', async () => {
      const g = makeGoogle()
      const app = await startApp({ places: g.places })
      const first = await rank(app, ['google_stub_text_01', 'google_invented1'])
      expect(first.body.current.map((r) => r.venue.id)).toEqual(['google_stub_text_01'])
      expect(first.body.google.missing).toEqual(['google_invented1'])
      const asked = g.of('details').length
      const second = await rank(app, ['google_stub_text_01', 'google_invented1'])
      expect(g.of('details')).toHaveLength(asked)
      expect(second.body.current.map((r) => r.venue.id)).toEqual(['google_stub_text_01'])
    })

    it('an id that is not a Google place id is never sent, and ids past the sixth are never read', async () => {
      const g = makeGoogle()
      const app = await startApp({ places: g.places })
      const ids = ['google_a b!', 'google_../x', ...invented(8)]
      let body
      for (let i = 0; i < 4; i++) body = (await rank(app, ids)).body
      expect(g.of('details').map((c) => placeIdOf(c.url))).toEqual(invented(6).map((id) => id.slice(7)))
      expect(body.google.missing).toEqual(ids)
    })

    it('a look-up that fails (not a 404) is missing this time, is not remembered, and the ranking is still 200', async () => {
      const g = makeGoogle({ respond: (call, init, fallback) => (call.kind === 'details' ? json({}, 500) : fallback(call)) })
      const app = await startApp({ places: g.places })
      const first = await rank(app, ['google_stub_text_01'])
      expect(first.status).toBe(200)
      expect(first.body.google.missing).toEqual(['google_stub_text_01'])
      expect(g.places.peekDetails('stub_text_01')).toEqual({ state: 'call' })
    })

    it('with Google off the answer is what it always was: no "missing"', async () => {
      const app = await startApp({ places: null })
      const { body } = await rank(app, ['google_stub_text_01'])
      expect(body.google).toEqual({ source: 'off', added: 0 })
    })

    it('a Google place that is not an outing (a bank) is not ranked and is listed as missing', async () => {
      const bank = { id: 'bank1', displayName: { text: 'DBS Bank' }, location: { latitude: 1.3049, longitude: 103.832 }, primaryType: 'bank', types: ['bank', 'finance'], formattedAddress: '1 Bank Rd, Singapore 049145' }
      const g = makeGoogle({ respond: (call, init, fallback) => (call.kind === 'details' ? json(bank) : fallback(call)) })
      const app = await startApp({ places: g.places })
      const { body } = await rank(app, ['google_bank1'])
      expect(body.current).toEqual([])
      expect(body.google.missing).toEqual(['google_bank1'])
    })
  })

  describe('when Google cannot be used', () => {
    it('an empty budget during a look-up and during a text search: 200, and Google is marked unavailable', async () => {
      const g = makeGoogle({ callsPerMinute: 1 })
      const app = await startApp({ places: g.places })
      expect((await app.post('/search', searchBody('Starlight'))).body.google.source).toBe('google') // uses the one call
      const ranked = await app.post('/converge', rankBody({ currentOptionIds: ['google_stub_text_01'] }))
      expect(ranked.status).toBe(200)
      expect(ranked.body.google).toMatchObject({ source: 'unavailable', added: 0, missing: ['google_stub_text_01'] })
      const searched = await app.post('/search', searchBody('Karaoke'))
      expect(searched.status).toBe(200)
      expect(searched.body.google).toEqual({ source: 'unavailable', added: 0 })
      expect(g.calls).toHaveLength(1)
    })

    it('an open circuit during a look-up and during a text search: 200, no call, Google marked unavailable', async () => {
      const g = makeGoogle({ respond: () => json({}, 500) })
      const app = await startApp({ places: g.places })
      for (const q of ['Alpha', 'Bravo', 'Charlie']) expect((await app.post('/search', searchBody(q))).body.google.source).toBe('unavailable')
      const before = g.calls.length
      const ranked = await app.post('/converge', rankBody({ currentOptionIds: ['google_stub_text_01'] }))
      expect(ranked.status).toBe(200)
      expect(ranked.body.google).toMatchObject({ source: 'unavailable', missing: ['google_stub_text_01'] })
      const searched = await app.post('/search', searchBody('Delta'))
      expect(searched.status).toBe(200)
      expect(searched.body.google).toEqual({ source: 'unavailable', added: 0 })
      expect(g.calls).toHaveLength(before)
    })
  })
})

// ---------------------------------------------------------------- 3 and 4. the location search
describe('GET /api/places/search', () => {
  const rows = (n) => Array.from({ length: n }, (_, i) => oneMapRow(`Block ${i + 1}`))
  const setup = async (oneMapBody) => {
    const g = makeGoogle()
    const { onemap } = makeOneMap(oneMapBody)
    const app = await startApp({ onemap, places: g.places })
    return { g, app }
  }

  it('asks Google only when OneMap found nothing: 0 rows ask, 2 and 3 rows do not', async () => {
    for (const [n, asks] of [[0, 1], [2, 0], [3, 0]]) {
      const { g, app } = await setup({ results: rows(n) })
      const { status } = await app.get('/places/search?q=Teo%20Heng')
      expect(status).toBe(200)
      expect(g.of('text'), `${n} rows`).toHaveLength(asks)
    }
  })

  it('does not ask Google for a postal code, a short query or an unfinished word, and asks for a name of 4 letters', async () => {
    const { g, app } = await setup({ results: [] })
    for (const q of ['238859', '12345', '#01-02', 'Teo', 'te', 'a b']) await app.get(`/places/search?q=${encodeURIComponent(q)}`)
    expect(g.of('text')).toHaveLength(0)
    await app.get('/places/search?q=Teoh')
    expect(g.of('text')).toHaveLength(1)
    // Spaces around the words do not count toward the length.
    await app.get(`/places/search?q=${encodeURIComponent('  Tim  ')}`)
    expect(g.of('text')).toHaveLength(1)
  })

  it('sends the short field mask and an island-wide bias, and the full mask is a different cache entry', async () => {
    const { g, app } = await setup({ results: [] })
    await app.get('/places/search?q=Starlight')
    const [call] = g.of('text')
    expect(call.url).toBe(TEXT_SEARCH_URL)
    expect(call.headers['X-Goog-FieldMask']).toBe(PLACE_SEARCH_FIELDS)
    expect(PLACE_SEARCH_FIELDS.split(',').sort()).toEqual(['places.displayName', 'places.formattedAddress', 'places.id', 'places.location'])
    expect(call.body.locationBias.circle).toEqual({ center: { latitude: 1.3521, longitude: 103.8198 }, radius: 25_000 })
    // The same words through the Vote page's search ask with the full mask, as another entry; each is then cached.
    await app.post('/search', searchBody('Starlight'))
    expect(g.of('text').map((c) => c.headers['X-Goog-FieldMask'])).toEqual([PLACE_SEARCH_FIELDS, NEARBY_FIELDS])
    await app.get('/places/search?q=Starlight')
    await app.post('/search', searchBody('Starlight'))
    expect(g.of('text')).toHaveLength(2)
  })

  it('drops a Google place with no name, a name of only digits, or a point outside Singapore, and marks the rest', async () => {
    const at1 = (id, name, lat, lng, address = '1 Road, Singapore 123456') => ({ id, displayName: name === null ? undefined : { text: name }, location: { latitude: lat, longitude: lng }, formattedAddress: address })
    const g = makeGoogle({
      respond: () =>
        json({
          places: [
            at1('a', 'Teo Heng KTV', 1.3, 103.84),
            at1('b', '238859', 1.3, 103.84), // a bare address
            at1('c', null, 1.3, 103.84), // no name
            at1('d', 'Far North Karaoke', 1.8, 103.84), // outside the planner's box
            at1('e', 'Far West Karaoke', 1.3, 103.3),
            at1('f', 'Teo Heng KTV', 1.31, 103.85, '2 Other Rd, Singapore 654321'), // another branch: kept
            at1('g', 'Teo Heng KTV', 1.3, 103.84), // the same place again: once
            at1('h', '   ', 1.3, 103.84),
            at1('i', 'No Postal Cafe', 1.3, 103.84, '3 Lane'),
          ],
        }),
    })
    const { onemap } = makeOneMap({ results: [] })
    const app = await startApp({ onemap, places: g.places })
    const { body } = await app.get('/places/search?q=Karaoke')
    expect(body.results.map((r) => [r.name, r.postal, r.source])).toEqual([
      ['Teo Heng KTV', '123456', 'google'],
      ['Teo Heng KTV', '654321', 'google'],
      ['No Postal Cafe', null, 'google'],
    ])
  })

  it('every row says where it came from, and postal is a string or null whichever it is', async () => {
    const { onemap } = makeOneMap({ results: [oneMapRow('A'), oneMapRow('B', { POSTAL: 'NIL' })] })
    const app = await startApp({ onemap })
    const { body } = await app.get('/places/search?q=Hall')
    expect(body.results.map((r) => [r.source, r.postal])).toEqual([['onemap', '123456'], ['onemap', null]])
    expect(Object.keys(body.results[0]).sort()).toEqual(['address', 'lat', 'lng', 'name', 'postal', 'source'])
  })

  it('a OneMap failure is forgotten only when Google has something to show', async () => {
    const down = () => {
      throw new ExternalApiError('onemap answered 503', { service: 'onemap', status: 503, url: 'x' })
    }
    const raw = [{ id: 'g1', displayName: { text: 'Teo Heng KTV' }, location: { latitude: 1.3, longitude: 103.84 }, formattedAddress: '1 Example Rd, Singapore 123456' }]
    const google = (searchText) => ({ enabled: true, searchText })
    const run = async (searchText) => {
      const app = await startApp({ onemap: { routingEnabled: false, search: async () => down() }, places: google(searchText) })
      return app.get('/places/search?q=Teo%20Heng')
    }
    expect((await run(async () => raw)).status).toBe(200)
    expect((await run(async () => [])).status).toBe(503) // Google answered, but with nothing: OneMap's failure stands
    expect((await run(async () => [{ id: 'z', displayName: { text: '123' }, location: { latitude: 1.3, longitude: 103.8 } }])).status).toBe(503)
    expect((await run(async () => down())).status).toBe(503)
    // OneMap found nothing and Google fails: no failure to report, an empty answer.
    const app = await startApp({ onemap: { routingEnabled: false, search: async () => [] }, places: google(async () => down()) })
    const empty = await app.get('/places/search?q=Teo%20Heng')
    expect(empty.status).toBe(200)
    expect(empty.body.results).toEqual([])
  })
})

// ---------------------------------------------------------------- 7. unreadable OneMap answers
describe('a OneMap answer that cannot be read', () => {
  const BAD = [{ results: 'x' }, { results: [null] }, { results: [1] }, { results: {} }, { results: [[]] }, 'text', null, []]

  it('is a OneMap failure, is not cached, and costs one call from the budget each time', async () => {
    for (const bad of BAD) {
      const { onemap, calls } = makeOneMap(bad)
      await expect(onemap.search('Bishan'), JSON.stringify(bad)).rejects.toBeInstanceOf(ExternalApiError)
      await expect(onemap.search('Bishan')).rejects.toBeInstanceOf(ExternalApiError)
      expect(calls).toHaveLength(2)
    }
  })

  it('spends the shared budget like any other call', async () => {
    const fetchImpl = async () => json({ results: 'x' })
    const onemap = createOneMap({ http: createHttp({ fetchImpl }), callsPerMinute: 2 })
    await expect(onemap.search('a1')).rejects.toMatchObject({ message: expect.stringContaining('cannot be read') })
    await expect(onemap.search('a2')).rejects.toMatchObject({ message: expect.stringContaining('cannot be read') })
    await expect(onemap.search('a3')).rejects.toMatchObject({ name: 'OneMapUnavailableError', reason: 'budget_empty' })
  })

  it('leaves good answers as they were: nothing found, rows, and a row without a point', async () => {
    expect(await makeOneMap({}).onemap.search('x')).toEqual([])
    expect(await makeOneMap({ results: [] }).onemap.search('x')).toEqual([])
    expect(await makeOneMap({ results: null }).onemap.search('x')).toEqual([])
    const rowsOut = await makeOneMap({ results: [oneMapRow('A'), oneMapRow('B', { LATITUDE: 'NaN' }), oneMapRow('C', { POSTAL: 'NIL', BUILDING: 'NIL' })] }).onemap.search('x')
    expect(rowsOut).toEqual([
      { name: 'A', address: '1 A ROAD', postal: '123456', lat: 1.3, lng: 103.84 },
      { name: 'C', address: '1 C ROAD', postal: null, lat: 1.3, lng: 103.84 },
    ])
  })

  it('POST /api/search answers 200 for a postal code when OneMap sends either bad shape', async () => {
    for (const bad of [{ results: 'x' }, { results: [null] }]) {
      const { onemap } = makeOneMap(bad)
      const app = await startApp({ onemap, places: null })
      const res = await app.post('/search', searchBody('238859'))
      expect(res.status, JSON.stringify(bad)).toBe(200)
      expect(res.body.google).toEqual({ source: 'off', added: 0 })
    }
  })

  it('GET /api/places/search answers 503 when OneMap is all there is', async () => {
    const { onemap } = makeOneMap({ results: [null] })
    const app = await startApp({ onemap })
    expect((await app.get('/places/search?q=Bishan')).status).toBe(503)
  })
})

// ---------------------------------------------------------------- 6. which places are outings
describe('which kind of place a searched Google place is', () => {
  const place = (primaryType, types, extra = {}) => ({
    id: 'k1',
    displayName: { text: 'Some Place' },
    location: { latitude: 1.3, longitude: 103.84 },
    primaryType,
    types,
    userRatingCount: 3,
    ...extra,
  })
  const kind = (p, searched = true) => {
    const v = fromGooglePlace(p, '2026-10-17T15:00', { searched })
    return v && { category: v.category, notAnOuting: v.notAnOuting === true }
  }

  const TABLE = [
    ['karaoke filed as a bar', place('bar', ['karaoke', 'night_club', 'bar', 'point_of_interest']), { category: 'activity', notAnOuting: false }],
    ['bowling', place('bowling_alley', ['bowling_alley', 'sports_activity_location']), { category: 'activity', notAnOuting: false }],
    ['cinema', place('movie_theater', ['movie_theater', 'point_of_interest']), { category: 'activity', notAnOuting: false }],
    ['museum', place('museum', ['museum', 'tourist_attraction', 'point_of_interest']), { category: 'activity', notAnOuting: false }],
    ['park', place('park', ['park', 'point_of_interest']), { category: 'activity', notAnOuting: false }],
    ['climbing gym', place('gym', ['gym', 'health', 'point_of_interest']), { category: 'activity', notAnOuting: false }],
    ['bank', place('bank', ['bank', 'finance', 'point_of_interest']), { category: 'activity', notAnOuting: true }],
    ['clinic', place('doctor', ['doctor', 'health', 'point_of_interest']), { category: 'activity', notAnOuting: true }],
    ['hospital', place('hospital', ['hospital', 'health', 'point_of_interest']), { category: 'activity', notAnOuting: true }],
    ['school', place('school', ['school', 'point_of_interest']), { category: 'activity', notAnOuting: true }],
    ['ATM', place('atm', ['atm', 'finance', 'point_of_interest']), { category: 'activity', notAnOuting: true }],
    ['petrol station', place('gas_station', ['gas_station', 'point_of_interest']), { category: 'activity', notAnOuting: true }],
    ['temple', place('hindu_temple', ['hindu_temple', 'place_of_worship', 'point_of_interest']), { category: 'activity', notAnOuting: true }],
    ['a place with no types', place(undefined, undefined), { category: 'activity', notAnOuting: true }],
    ['pharmacy', place('pharmacy', ['pharmacy', 'health', 'store', 'point_of_interest']), { category: 'shop', notAnOuting: false }],
    ['pharmacy with no store type', place('pharmacy', ['pharmacy']), { category: 'shop', notAnOuting: false }],
    ['clothing shop', place('clothing_store', ['clothing_store', 'store']), { category: 'shop', notAnOuting: false }],
    ['supermarket', place('supermarket', ['supermarket', 'grocery_store', 'food', 'store', 'point_of_interest']), { category: 'shop', notAnOuting: false }],
    ['convenience store', place('convenience_store', ['convenience_store', 'food', 'store']), { category: 'shop', notAnOuting: false }],
    ['restaurant', place('italian_restaurant', ['italian_restaurant', 'restaurant', 'food']), { category: 'eat', notAnOuting: false }],
    ['a place only typed "food"', place('food', ['food', 'point_of_interest']), { category: 'eat', notAnOuting: false }],
    ['cafe', place('cafe', ['cafe', 'food', 'store']), { category: 'drink', notAnOuting: false }],
  ]
  it.each(TABLE)('%s', (_name, p, expected) => {
    expect(kind(p)).toEqual(expected)
  })

  it('a supermarket is not a restaurant', () => {
    const v = fromGooglePlace(place('supermarket', ['supermarket', 'grocery_store', 'food', 'store']), '2026-10-17T15:00', { searched: true })
    expect(v.kind).not.toBe('restaurant')
    expect(v.diet).toBeNull()
  })

  it('a tuition centre or a school, and an advert for a name, are searched places that are not outings; nearby they are left out', () => {
    const tuition = place('amusement_center', ['amusement_center', 'point_of_interest'], { displayName: { text: 'Bright Minds Tuition Centre' }, userRatingCount: 500 })
    expect(kind(tuition)).toEqual({ category: 'activity', notAnOuting: true })
    expect(kind(tuition, false)).toBeNull()
    const advert = place('art_gallery', ['art_gallery'], { displayName: { text: 'Luxury Film/ Artisan Work/ Protection' }, userRatingCount: 500 })
    expect(kind(advert)).toEqual({ category: 'activity', notAnOuting: true })
    expect(kind(advert, false)).toBeNull()
  })

  it('the review minimum is still skipped for a searched place, and kept for a nearby one', () => {
    const small = place('karaoke', ['karaoke'], { userRatingCount: 4 })
    expect(kind(small)).toEqual({ category: 'activity', notAnOuting: false })
    expect(kind(small, false)).toBeNull()
  })

  it('a nearby place with no outing type keeps the old last resort (Google only sends the types Jio asks for)', () => {
    expect(kind(place('bank', ['bank'], { userRatingCount: 500 }), false)).toEqual({ category: 'activity', notAnOuting: false })
  })

  it('has an outing list of Google types, each once, and none that food, drink or shopping already decide', () => {
    expect(new Set(OUTING_TYPES).size).toBe(OUTING_TYPES.length)
    for (const t of ['restaurant', 'cafe', 'bar', 'store', 'shopping_mall', 'bank', 'school', 'hospital', 'gas_station']) expect(OUTING_TYPES).not.toContain(t)
    for (const t of ['tourist_attraction', 'park', 'museum', 'karaoke', 'bowling_alley', 'movie_theater', 'stadium']) expect(OUTING_TYPES).toContain(t)
  })

  it('POST /api/search says "not_an_outing" for a bank, in an activity slot and in an eat slot, and still shows it', async () => {
    const bank = { id: 'bank1', displayName: { text: 'DBS Bank Orchard' }, location: { latitude: 1.3049, longitude: 103.832 }, primaryType: 'bank', types: ['bank', 'finance'], formattedAddress: '1 Bank Rd, Singapore 049145', userRatingCount: 400 }
    const g = makeGoogle({ respond: () => json({ places: [bank, ...TEXT.places] }) })
    const app = await startApp({ places: g.places })
    for (const categories of [['activity'], ['eat']]) {
      const { body } = await app.post('/search', searchBody('Starlight', { categories }))
      const row = body.results.find((r) => r.venueId === 'google_bank1')
      expect(row, JSON.stringify(categories)).toMatchObject({ fits: false, source: 'google' })
      expect(row.unfit[0]).toBe('not_an_outing')
    }
    const { body } = await app.post('/search', searchBody('Starlight'))
    expect(body.results.find((r) => r.venueId === 'google_stub_text_01')).toMatchObject({ fits: true, unfit: [] }) // a karaoke is still fine
  })
})

// ---------------------------------------------------------------- 5. weather bases
describe('Google venues join a ranking under every kind of weather', () => {
  const THUNDER = 'Heavy Thundery Showers'
  const STOP = '2026-10-12T12:30'
  const BASES = [
    { basis: 'area', clock: at('2026-10-12T12:00'), extra: {}, phrase: THUNDER, state: 'thundery' },
    { basis: 'regional', clock: at('2026-10-12T09:30'), extra: {}, phrase: THUNDER, state: 'thundery' },
    { basis: 'simulated', clock: at('2026-10-12T12:00'), extra: { weatherCase: 'rain' }, phrase: null, state: 'showers' },
    { basis: 'none', clock: at('2026-10-11T06:30'), extra: {}, phrase: null, state: 'unknown' },
  ]
  const local = []
  afterEach(() => Promise.all(local.splice(0).map((s) => new Promise((resolve) => s.close(resolve)))))
  const body = (extra) => ({ members: GROUP, occasion: 'casual_meal', dateTime: STOP, durationMinutes: 90, unknownPolicy: 'lenient', topN: 20, ...extra })

  for (const { basis, clock, extra, phrase, state } of BASES) {
    it.each(['/converge', '/roam'])(`${basis}: %s answers 200 with a sane weather on a nearby and a looked-up Google venue`, async (route) => {
      const world = makeWorld({ clock, area: 'rain', regional: (c) => regionalAnswer(c, THUNDER) })
      const g = makeGoogle()
      const post = await startWeatherApp(world, local, { places: g.places, allowSimulatedWeather: true })
      const where = route === '/roam' ? (point) => ({ current: point }) : (point) => ({ centre: point })

      // Nearby: the invented places around Bishan.
      const nearby = await post(route, body({ categories: ['eat', 'drink'], ...where(BISHAN), ...extra }))
      expect(nearby.status).toBe(200)
      expect(nearby.body.weather.basis).toBe(basis)
      const found = nearby.body.results.filter((r) => r.venue.id.startsWith('google_'))
      expect(found.length).toBeGreaterThan(0)
      // Looked up by id: the invented karaoke near Orchard, which is not among the nearest.
      const looked = await post(route, body({ categories: ['activity'], currentOptionIds: ['google_stub_text_01'], ...where(ORCHARD), ...extra }))
      expect(looked.status).toBe(200)
      expect(looked.body.weather.basis).toBe(basis)
      expect(looked.body.google.missing).toBeUndefined()
      const lookedRows = looked.body.results.filter((r) => r.venue.id === 'google_stub_text_01')
      expect(lookedRows).toHaveLength(1)

      for (const row of [...found, ...lookedRows]) {
        expect(['dry', 'cloudy', 'showers', 'thundery', 'unknown']).toContain(row.weather.state)
        if (basis === 'simulated') expect(row.weather.state).not.toBe('unknown')
        else expect(row.weather.state, row.venue.id).toBe(state)
        expect(row.weather.phrase).toBe(phrase)
        expect(Number.isFinite(row.score)).toBe(true)
      }
    })
  }

  describe('placeVenues', () => {
    const venue = (extra = {}) => ({ id: 'google_x', lat: 1.3504, lng: 103.8485, forecastArea: 'central', ...extra })
    const live = { areas: [{ area: 'Bishan', lat: 1.35, lng: 103.85, forecast: 'Fair', rainRisk: 0 }, { area: 'Bukit Timah', lat: 1.33, lng: 103.78, forecast: 'Fair', rainRisk: 0 }] }
    const weatherCases = { clear: { central: {}, east: {} }, live: { Bishan: {}, 'Bukit Timah': {} }, none: { central: {} } }

    it('places a venue in the nearest forecast area for a live forecast, and leaves its region label for the others', () => {
      expect(placeVenues({ planData: { weatherCases }, weatherCase: 'live', forecast: live }, [venue()])[0].forecastArea).toBe('Bishan')
      expect(placeVenues({ planData: { weatherCases }, weatherCase: 'clear', forecast: undefined }, [venue()])[0].forecastArea).toBe('central')
      expect(placeVenues({ planData: { weatherCases }, weatherCase: 'none', forecast: undefined }, [venue()])[0].forecastArea).toBe('central')
    })

    it('leaves out a venue the weather case has no area for, instead of failing the ranking', () => {
      expect(placeVenues({ planData: { weatherCases }, weatherCase: 'none', forecast: undefined }, [venue({ forecastArea: 'mars' })])).toEqual([])
      expect(placeVenues({ planData: { weatherCases }, weatherCase: 'live', forecast: { areas: [] } }, [venue()])).toEqual([])
    })
  })
})

// ---------------------------------------------------------------- 9. search quality
describe('POST /api/search', () => {
  it('does not ask Google for fewer than 3 characters, and says so', async () => {
    const g = makeGoogle()
    const app = await startApp({ places: g.places })
    const { body, status } = await app.post('/search', searchBody('ab'))
    expect(status).toBe(200)
    expect(body.google).toEqual({ source: 'not_needed', added: 0 })
    expect(g.of('text')).toHaveLength(0)
    expect((await app.post('/search', searchBody('abc'))).body.google.source).toBe('google')
    expect(g.of('text')).toHaveLength(1)
  })

  it('matches a saved place\'s address only from 3 characters', () => {
    const base = planData.venues.find((v) => v.category === 'activity' && v.lat)
    const venue = { ...base, id: 'saved1', name: 'Zzz Hall', area: 'Nowhere', stalls: undefined, address: '12 Orchard Rd' }
    const data = { ...planData, venues: [venue] }
    const find = (query) => searchVenues({ query, centre: { lat: venue.lat, lng: venue.lng }, dateTime: '2026-10-17T15:00', categories: ['activity'], unknownPolicy: 'lenient' }, data).map((r) => r.venueId)
    expect(find('orc')).toEqual(['saved1'])
    expect(find('12 orchard')).toEqual(['saved1'])
    expect(find('rd')).toEqual([]) // two characters would match half the island's addresses
    expect(find('or')).toEqual([])
    expect(find('zz')).toEqual(['saved1']) // the name still matches from any length
  })

  it('puts a place whose name holds the words ahead of one matched another way, among those that fit', () => {
    const base = planData.venues.find((v) => v.category === 'activity' && v.lat)
    const near = { ...base, id: 'near', name: 'Alpha Hall', area: 'Marina Zone', stalls: undefined, address: null }
    const far = { ...base, id: 'far', name: 'Marina Court', area: 'East', stalls: undefined, address: null, lat: base.lat + 0.004 }
    const data = { ...planData, venues: [near, far] }
    const out = searchVenues({ query: 'marina', centre: { lat: base.lat, lng: base.lng }, dateTime: '2026-10-17T15:00', categories: ['activity'], unknownPolicy: 'lenient' }, data)
    expect(out.map((r) => r.venueId)).toEqual(['far', 'near']) // "near" is closer but only its area matches
  })

  it('shows a searched cafe that an unrelated saved cafe stands 44 m from', async () => {
    const saved = planData.venues.find((v) => v.kind === 'cafe' && v.lat)
    const searched = { id: 'zebra1', displayName: { text: 'Zebra Coffee Lab' }, location: { latitude: saved.lat + 0.0004, longitude: saved.lng }, primaryType: 'cafe', types: ['cafe', 'food'], formattedAddress: '1 Example Rd, Singapore 123456', userRatingCount: 80 }
    const g = makeGoogle({ respond: () => json({ places: [searched] }) })
    const app = await startApp({ places: g.places })
    const { body } = await app.post('/search', searchBody('Zebra Coffee', { centre: { lat: saved.lat, lng: saved.lng }, categories: ['drink'] }))
    expect(body.google).toEqual({ source: 'google', added: 1 })
    expect(body.results.map((r) => r.venueId)).toContain('google_zebra1')
    // Names are still compared: the same cafe, saved under a similar name nearby, is not shown twice.
    const same = { ...searched, id: 'dup1', displayName: { text: saved.name } }
    const again = fromGooglePlace(same, '2026-10-17T15:00', { searched: true })
    expect(dropKnownPlaces([again], [saved], { sameKindMeters: 0 })).toEqual([])
  })

  it('dropKnownPlaces can compare names only', () => {
    const a = { id: 'a', name: 'Alpha Cafe', kind: 'cafe', lat: 1.3, lng: 103.8 }
    const near = { id: 'b', name: 'Totally Different', kind: 'cafe', lat: 1.3004, lng: 103.8 }
    expect(dropKnownPlaces([a], [near])).toEqual([])
    expect(dropKnownPlaces([a], [near], { sameKindMeters: 0 })).toEqual([a])
    expect(dropKnownPlaces([a], [{ ...near, name: 'Alpha Cafe' }], { sameKindMeters: 0 })).toEqual([])
  })

  it('"alsoMatch" in a request body changes nothing: only the server decides what else matches', async () => {
    const app = await startApp({ places: null })
    const some = planData.venues.slice(0, 5).map((v) => v.id)
    const plain = await app.post('/search', searchBody('orchard'))
    const sneaky = await app.post('/search', { ...searchBody('orchard'), alsoMatch: some })
    expect(sneaky.status).toBe(200)
    expect(sneaky.body).toEqual(plain.body)
  })

  it('a Google place with no name is not shown as "Unnamed place"', async () => {
    const nameless = { id: 'n1', location: { latitude: 1.3049, longitude: 103.832 }, primaryType: 'karaoke', types: ['karaoke'], formattedAddress: '1 Rd' }
    const g = makeGoogle({ respond: () => json({ places: [nameless, ...TEXT.places] }) })
    const app = await startApp({ places: g.places })
    const { body } = await app.post('/search', searchBody('Starlight'))
    expect(body.google.added).toBe(2)
    expect(JSON.stringify(body)).not.toContain('Unnamed')
    expect(fromGooglePlace(nameless, '2026-10-17T19:00', { searched: true })).toBeNull()
    expect(fromGooglePlace({ ...nameless, displayName: { text: '  ' } }, '2026-10-17T19:00', { searched: true })).toBeNull()
  })
})

// ---------------------------------------------------------------- 10. time
describe('the time Google can add to a ranking', () => {
  it('the nearby search and the look-ups run together, not one after the other', async () => {
    const g = makeGoogle({ delayMs: 300 })
    const app = await startApp({ places: g.places })
    const started = Date.now()
    const res = await app.post('/converge', rankBody({ categories: ['eat'], centre: BISHAN, currentOptionIds: ['google_invented1', 'google_invented2'] }))
    const took = Date.now() - started
    expect(res.status).toBe(200)
    expect(g.of('nearby')).toHaveLength(1)
    expect(g.of('details')).toHaveLength(2)
    expect(took).toBeLessThan(520) // one after the other would take at least 600
  })

  it('a hung Google costs a ranking one timeout and a short grace, not one timeout per step', async () => {
    const g = makeGoogle({ respond: hang, timeoutMs: 400 })
    const app = await startApp({ places: g.places })
    const started = Date.now()
    const res = await app.post('/converge', rankBody({ categories: ['eat'], centre: BISHAN, currentOptionIds: invented(6) }))
    const took = Date.now() - started
    expect(res.status).toBe(200)
    expect(res.body.google).toMatchObject({ source: 'unavailable', added: 0, missing: invented(6) })
    expect(took).toBeGreaterThanOrEqual(350)
    expect(took).toBeLessThan(400 + 250 + 300) // the timeout, the grace, and room for the machine
    expect(g.of('nearby')).toHaveLength(1)
    expect(g.of('details').length).toBeLessThanOrEqual(3)
  })

  it('a look-up still running at the deadline is left behind: the ranking answers, and lists it as missing', async () => {
    // Two look-ups hang until the 400 ms timeout; the third starts then and would take 600 ms more.
    const g = makeGoogle({
      timeoutMs: 400,
      respond: async (call, init, fallback) => {
        if (call.kind !== 'details') return fallback(call)
        const id = placeIdOf(call.url)
        if (id.startsWith('invented')) return hang(call.url, init)
        await new Promise((resolve) => setTimeout(resolve, 600))
        return fallback(call)
      },
    })
    const app = await startApp({ places: g.places })
    const started = Date.now()
    const res = await app.post('/converge', rankBody({ currentOptionIds: ['google_invented1', 'google_invented2', 'google_stub_text_01'] }))
    const took = Date.now() - started
    expect(res.status).toBe(200)
    expect(res.body.current).toEqual([])
    expect(res.body.google.missing).toEqual(['google_invented1', 'google_invented2', 'google_stub_text_01'])
    expect(took).toBeGreaterThanOrEqual(600) // the deadline is 400 + 250
    expect(took).toBeLessThan(400 + 250 + 300)
    // The slow look-up finishes in the background and is cached for the next request.
    await new Promise((resolve) => setTimeout(resolve, 500))
    const next = await app.post('/converge', rankBody({ currentOptionIds: ['google_stub_text_01'] }))
    expect(next.body.current.map((r) => r.venue.id)).toEqual(['google_stub_text_01'])
  })
})

// ---------------------------------------------------------------- the service keeps masks apart
describe('searchText', () => {
  it('keeps a different field mask, or a different bias, as a different cache entry', async () => {
    const g = makeGoogle()
    await g.places.searchText('Starlight', ORCHARD)
    await g.places.searchText('Starlight', ORCHARD, { fieldMask: PLACE_SEARCH_FIELDS })
    await g.places.searchText('Starlight', ORCHARD, { fieldMask: PLACE_SEARCH_FIELDS, biasMeters: 25_000 })
    expect(g.of('text')).toHaveLength(3)
    await g.places.searchText('starlight ', ORCHARD, { fieldMask: PLACE_SEARCH_FIELDS, biasMeters: 25_000 })
    expect(g.of('text')).toHaveLength(3)
    expect(g.of('text').map((c) => c.headers['X-Goog-FieldMask'])).toEqual([NEARBY_FIELDS, PLACE_SEARCH_FIELDS, PLACE_SEARCH_FIELDS])
    expect(g.of('text').map((c) => c.body.locationBias.circle.radius)).toEqual([5000, 5000, 25_000])
  })

  it('never asks for a bias wider than Google allows', async () => {
    const g = makeGoogle()
    await g.places.searchText('Starlight', ORCHARD, { biasMeters: 900_000 })
    expect(g.of('text')[0].body.locationBias.circle.radius).toBe(50_000)
  })
})
