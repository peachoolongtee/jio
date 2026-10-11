// Searching for places that are not saved: Google text search and Place Details (services/google-places.js), the
// searched-place rules in the adapter, POST /api/search with Google and a postal code, and adding a searched Google
// place as an option (the ranking looks it up by id). Nothing touches the network: stub mode answers from the
// invented fixtures in tests/fixtures/google/, and the rest use fakes.
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { fromGooglePlace } from '../src/planner/google-adapter.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { createGooglePlaces, DETAILS_FIELDS, TEXT_SEARCH_URL } from '../src/services/google-places.js'
import textFixture from './fixtures/google/places-text-search.json'

const ORCHARD = { lat: 1.3048, lng: 103.8318 }
const KARAOKE = textFixture.places[0] // 12 reviews: below the activity minimum of 30

describe('Google text search and Place Details', () => {
  const fakeHttp = () => {
    const http = {
      postJson: vi.fn(async () => textFixture),
      getJson: vi.fn(async (url) => {
        if (url.endsWith('/places/missing')) throw new ExternalApiError('google answered 404', { service: 'google', status: 404, url })
        return KARAOKE
      }),
    }
    return http
  }

  it('searches by words near a point, once per 10 minutes', async () => {
    const http = fakeHttp()
    const places = createGooglePlaces({ http, apiKey: 'test-key' })
    const raw = await places.searchText('Teo Heng', ORCHARD)
    expect(raw.map((p) => p.id)).toEqual(['stub_text_01', 'stub_text_02'])
    const [url, body, { headers }] = http.postJson.mock.calls[0]
    expect(url).toBe(TEXT_SEARCH_URL)
    expect(body).toMatchObject({ textQuery: 'Teo Heng', regionCode: 'sg', locationBias: { circle: { center: { latitude: ORCHARD.lat, longitude: ORCHARD.lng } } } })
    expect(headers['X-Goog-FieldMask']).toContain('places.regularOpeningHours')
    await places.searchText('teo heng ', ORCHARD)
    expect(http.postJson).toHaveBeenCalledTimes(1)
  })

  it('looks one place up by id, says null for a place Google no longer has, and refuses a bad id', async () => {
    const http = fakeHttp()
    const places = createGooglePlaces({ http, apiKey: 'test-key' })
    expect((await places.details('stub_text_01')).id).toBe('stub_text_01')
    expect(http.getJson.mock.calls[0][0]).toBe('https://places.googleapis.com/v1/places/stub_text_01')
    expect(http.getJson.mock.calls[0][1].headers['X-Goog-FieldMask']).toBe(DETAILS_FIELDS)
    expect(DETAILS_FIELDS).not.toContain('places.')
    expect(await places.details('missing')).toBeNull()
    await expect(places.details('../secret')).rejects.toThrow('not a Google place id')
  })

  it('is off without a key', async () => {
    const places = createGooglePlaces({ http: fakeHttp() })
    await expect(places.searchText('x', ORCHARD)).rejects.toThrow('Google Places is off')
  })
})

describe('which kind of place a Google place is', () => {
  it('a karaoke Google files as a bar first is still an activity, and a café with art is still a café', () => {
    const teoHeng = { ...KARAOKE, primaryType: 'bar', types: ['karaoke', 'night_club', 'bar', 'point_of_interest'], userRatingCount: 900 }
    expect(fromGooglePlace(teoHeng, '2026-10-17T19:00')).toMatchObject({ category: 'activity', kind: 'attraction' })
    const artCafe = { ...KARAOKE, primaryType: 'cafe', types: ['cafe', 'art_gallery', 'food'], userRatingCount: 900 }
    expect(fromGooglePlace(artCafe, '2026-10-17T19:00')).toMatchObject({ category: 'drink', kind: 'cafe' })
  })
})

describe('a place of a kind Jio does not list', () => {
  it('is something to do when nothing says food, drink or shopping (a climbing gym)', () => {
    const gym = { ...KARAOKE, displayName: { text: 'Boulder Gym' }, primaryType: 'gym', types: ['gym', 'health', 'point_of_interest'] }
    expect(fromGooglePlace(gym, '2026-10-17T15:00', { searched: true })).toMatchObject({ category: 'activity', kind: 'attraction' })
    const store = { ...KARAOKE, primaryType: 'clothing_store', types: ['clothing_store', 'store'], userRatingCount: 80 }
    expect(fromGooglePlace(store, '2026-10-17T15:00', { searched: true })).toMatchObject({ category: 'shop' })
  })
})

describe('a place someone searched for', () => {
  it('keeps a small karaoke the nearby list would leave out, but never a closed place', () => {
    expect(fromGooglePlace(KARAOKE, '2026-10-17T19:00')).toBeNull() // 12 reviews: not suggested by itself
    expect(fromGooglePlace(KARAOKE, '2026-10-17T19:00', { searched: true })).toMatchObject({ id: 'google_stub_text_01', category: 'activity' })
    const closed = { ...KARAOKE, businessStatus: 'CLOSED_PERMANENTLY' }
    expect(fromGooglePlace(closed, '2026-10-17T19:00', { searched: true })).toBeNull()
  })
})

describe('POST /api/search and adding a searched place', () => {
  let server, base
  beforeAll(async () => {
    server = createApp({ frontendOrigin: 'http://localhost:5173', stub: true }).listen(0)
    await once(server, 'listening')
    base = `http://127.0.0.1:${server.address().port}`
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))

  const post = async (path, body) => {
    const res = await fetch(`${base}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const search = { centre: ORCHARD, dateTime: '2026-10-17T19:00', durationMinutes: 120, categories: ['activity'] }

  it('finds a Google place by name that is not saved, and says it fits', async () => {
    const { status, body } = await post('/search', { ...search, query: 'Starlight' })
    expect(status).toBe(200)
    expect(body.google).toEqual({ source: 'google', added: 2 })
    const karaoke = body.results.find((r) => r.venueId === 'google_stub_text_01')
    expect(karaoke).toMatchObject({ name: 'Starlight Karaoke Box', category: 'activity', fits: true, source: 'google' })
    // A place of another kind is shown, not hidden, and says why it does not fit an activity slot.
    const noodles = body.results.find((r) => r.venueId === 'google_stub_text_02')
    expect(noodles).toMatchObject({ category: 'eat', fits: false, unfit: ['category'] })
  })

  it('a searched Google place can be ranked as an option: the planner looks it up by id', async () => {
    const group = [
      { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
      { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
    ]
    const { body } = await post('/converge', {
      members: group,
      occasion: 'casual_meal',
      dateTime: '2026-10-17T19:00',
      durationMinutes: 120,
      categories: ['activity'],
      centre: ORCHARD,
      unknownPolicy: 'lenient',
      currentOptionIds: ['google_stub_text_01'],
    })
    expect(body.status).toBe('ok')
    expect(body.current.map((r) => r.venue.id)).toContain('google_stub_text_01')
  })

  it('a postal code also asks Google with "Singapore", and Google being down never fails the search', async () => {
    const searchText = vi.fn(async () => {
      throw new ExternalApiError('google answered 503', { service: 'google', status: 503, url: 'x' })
    })
    const places = { enabled: true, nearby: async () => [], searchText, details: async () => null, photoUrl: async () => null }
    const onemap = { routingEnabled: false, search: vi.fn(async () => [{ name: 'X', address: 'Y', postal: '238859', lat: ORCHARD.lat, lng: ORCHARD.lng }]) }
    const app = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), places, onemap }).listen(0)
    await once(app, 'listening')
    try {
      const res = await fetch(`http://127.0.0.1:${app.address().port}/api/search`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...search, query: '238859' }),
      })
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.google).toEqual({ source: 'unavailable', added: 0 })
      expect(searchText.mock.calls[0][0]).toBe('Singapore 238859')
      expect(onemap.search).toHaveBeenCalledWith('238859')
    } finally {
      await new Promise((resolve) => app.close(resolve))
    }
  })
})

describe('GET /api/places/search (start and end points, meeting spots)', () => {
  const start = async (deps) => {
    const app = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), ...deps }).listen(0)
    await once(app, 'listening')
    const get = async (q) => {
      const res = await fetch(`http://127.0.0.1:${app.address().port}/api/places/search?q=${encodeURIComponent(q)}`)
      return { status: res.status, body: await res.json() }
    }
    return { get, close: () => new Promise((resolve) => app.close(resolve)) }
  }
  const raw = [{ id: 'g1', displayName: { text: 'Teo Heng KTV' }, location: { latitude: 1.3, longitude: 103.84 }, formattedAddress: '1 Example Rd, Singapore 123456' }]

  it('asks Google by name only when OneMap finds fewer than 3', async () => {
    const searchText = vi.fn(async () => raw)
    const three = [1, 2, 3].map((i) => ({ name: `Block ${i}`, address: 'A', postal: '520201', lat: 1.35, lng: 103.94 }))
    const many = await start({ onemap: { routingEnabled: false, search: async () => three }, places: { enabled: true, searchText } })
    try {
      expect((await many.get('520201')).body.results).toHaveLength(3)
      expect(searchText).not.toHaveBeenCalled()
    } finally {
      await many.close()
    }
    const none = await start({ onemap: { routingEnabled: false, search: async () => [] }, places: { enabled: true, searchText } })
    try {
      const { body } = await none.get('Teo Heng')
      expect(body.results).toEqual([{ name: 'Teo Heng KTV', address: '1 Example Rd, Singapore 123456', postal: '123456', lat: 1.3, lng: 103.84 }])
    } finally {
      await none.close()
    }
  })

  it('names a home address by its street when OneMap names it only by its postal code', async () => {
    const homes = [1, 2, 3].map((i) => ({ name: '760201', address: `20${i} YISHUN STREET 21 SINGAPORE 760201`, postal: '760201', lat: 1.43, lng: 103.83 }))
    const app = await start({ onemap: { routingEnabled: false, search: async () => homes } })
    try {
      expect((await app.get('760201')).body.results[0].name).toBe('201 YISHUN STREET 21 SINGAPORE 760201')
    } finally {
      await app.close()
    }
  })

  it('answers with Google when OneMap is down, and 503 only when both are', async () => {
    const down = async () => {
      throw new ExternalApiError('onemap answered 503', { service: 'onemap', status: 503, url: 'x' })
    }
    const googleUp = await start({ onemap: { routingEnabled: false, search: down }, places: { enabled: true, searchText: async () => raw } })
    try {
      expect((await googleUp.get('Teo Heng')).body.results[0].name).toBe('Teo Heng KTV')
    } finally {
      await googleUp.close()
    }
    const bothDown = await start({ onemap: { routingEnabled: false, search: down }, places: { enabled: true, searchText: down } })
    try {
      expect((await bothDown.get('Teo Heng')).status).toBe(503)
    } finally {
      await bothDown.close()
    }
  })
})
