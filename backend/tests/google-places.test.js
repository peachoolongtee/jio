// Google Places (New): restaurants, cafés, bars and dessert shops with ratings, price levels and opening hours.
// Nothing here calls Google: the service tests use fake helpers, and the route tests use stub mode, which answers
// from tests/fixtures/google/ (six invented places near Bishan MRT: made-up ids, names, addresses and ratings).
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { fromGooglePlace, hoursOnDay, kindOf, weekdayOf } from '../src/planner/google-adapter.js'
import { createGooglePlaces, NEARBY_FIELDS } from '../src/services/google-places.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { loadFixture } from '../src/services/stubs.js'
import { createApp } from '../src/app.js'

const { places: SAMPLE } = loadFixture('google/places-nearby.json')
const byName = (text) => SAMPLE.find((p) => p.displayName.text.startsWith(text))
const BISHAN = { lat: 1.35092, lng: 103.84822 }
const day = (d, hour, minute = 0) => ({ day: d, hour, minute })

// ---------------------------------------------------------------- converting places
describe('google-adapter', () => {
  it('kindOf: restaurants are food with a cuisine, cafés and bars are drink, food courts are hawker, desserts are food', () => {
    expect(kindOf({ primaryType: 'italian_restaurant' })).toEqual({ category: 'eat', kind: 'restaurant', cuisine: 'italian' })
    expect(kindOf({ primaryType: 'chinese_noodle_restaurant' })).toMatchObject({ cuisine: 'chinese' })
    expect(kindOf({ primaryType: 'cafe' })).toMatchObject({ category: 'drink', kind: 'cafe' })
    expect(kindOf({ primaryType: 'bar' })).toMatchObject({ category: 'drink', kind: 'bar' })
    // Mixue: typed tea_house first, with ice cream and dessert types after. The main type wins, so it is a drink.
    expect(kindOf({ primaryType: 'tea_house', types: ['tea_house', 'ice_cream_shop', 'dessert_shop', 'food', 'point_of_interest'] })).toMatchObject({ category: 'drink', kind: 'cafe' })
    // A dessert shop with a drink type after its main one stays a dessert.
    expect(kindOf({ primaryType: 'dessert_shop', types: ['dessert_shop', 'cafe', 'food'] })).toMatchObject({ category: 'eat', kind: 'dessert' })
    // A listing Google gave no type: its name decides, for a tea or coffee word and for a known chain, and a bank is still not an outing.
    expect(kindOf({ displayName: { text: 'Each-A-Cup (448 Ang Mo Kio)' } }, { searched: true })).toMatchObject({ category: 'drink', kind: 'cafe' })
    expect(kindOf({ displayName: { text: 'Uncle Lim Kopi' } })).toMatchObject({ category: 'drink' })
    expect(kindOf({ displayName: { text: 'DBS Bank' } }, { searched: true })).toMatchObject({ category: 'activity', notAnOuting: true })
    // A bubble tea shop as Google types it (CHAGEE The Woodleigh Mall): a tea store, with no cafe type, is a drink, not a meal.
    expect(kindOf({ primaryType: 'tea_store', types: ['tea_store', 'food_store', 'food', 'store', 'point_of_interest', 'establishment'] })).toMatchObject({ category: 'drink', kind: 'cafe' })
    expect(kindOf({ primaryType: 'food_court' })).toMatchObject({ category: 'eat', kind: 'hawker' })
    expect(kindOf({ primaryType: 'dessert_shop' })).toMatchObject({ category: 'eat', kind: 'dessert' })
    expect(kindOf({ primaryType: 'restaurant' })).toMatchObject({ kind: 'restaurant', cuisine: 'restaurant' })
  })

  it('kindOf: malls, department stores and markets are shops; a restaurant inside a mall is still food', () => {
    expect(kindOf({ primaryType: 'shopping_mall', types: ['shopping_mall', 'point_of_interest'] })).toEqual({ category: 'shop', kind: 'mall', cuisine: 'mall' })
    expect(kindOf({ primaryType: 'department_store' })).toMatchObject({ category: 'shop', kind: 'mall' })
    expect(kindOf({ primaryType: 'market' })).toMatchObject({ category: 'shop', kind: 'market' })
    expect(kindOf({ primaryType: 'japanese_restaurant', types: ['japanese_restaurant', 'restaurant', 'shopping_mall'] })).toMatchObject({ category: 'eat', cuisine: 'japanese' })
    expect(kindOf({ primaryType: 'food_court', types: ['food_court', 'shopping_mall'] })).toMatchObject({ category: 'eat', kind: 'hawker' })
  })

  it('a Google mall has no diet (so diet filters skip it, like the frontend\'s malls)', () => {
    const mall = fromGooglePlace({ ...byName('Lantern Lane'), primaryType: 'shopping_mall', types: ['shopping_mall'] }, '2026-10-10T14:00')
    expect(mall).toMatchObject({ category: 'shop', kind: 'mall', diet: null })
    expect(mall.dataQuality.dietUnknown).toBe(false)
  })

  it('kindOf: bowling, cinemas, karaoke, arcades and galleries are activities, with no diet', () => {
    expect(kindOf({ primaryType: 'bowling_alley' })).toEqual({ category: 'activity', kind: 'sports', cuisine: 'bowling_alley' })
    expect(kindOf({ primaryType: 'movie_theater' })).toMatchObject({ category: 'activity', kind: 'cinema' })
    expect(kindOf({ primaryType: 'art_gallery' })).toMatchObject({ category: 'activity', kind: 'museum' })
    expect(kindOf({ primaryType: 'karaoke', types: ['karaoke', 'bar'] })).toMatchObject({ category: 'activity', kind: 'attraction' })
    const bowling = fromGooglePlace({ ...byName('Lantern Lane'), primaryType: 'bowling_alley', types: ['bowling_alley'], userRatingCount: 300 }, '2026-10-10T14:00')
    expect(bowling).toMatchObject({ category: 'activity', diet: null })
    expect(fromGooglePlace({ ...byName('Lantern Lane'), primaryType: 'bowling_alley', types: ['bowling_alley'], userRatingCount: 10 }, '2026-10-10T14:00')).toBeNull()

    const activity = (text, type = 'art_gallery') => fromGooglePlace({ ...byName('Lantern Lane'), displayName: { text }, primaryType: type, types: [type], userRatingCount: 400 }, '2026-10-10T14:00')
    expect(activity('LouisArtStory - Luxury Watch Protection Film/ Artisan Workmanship in Orchard/Risks Transfer on Fine Arts')).toBeNull()
    expect(activity('ELITE Sports Academy', 'amusement_center')).toBeNull()
    expect(activity('The FRIENDS Experience: The One in Singapore', 'amusement_center')).not.toBeNull()
    expect(activity('Golden Village Bishan', 'movie_theater')).not.toBeNull()
  })

  it('leaves out a shop with under 50 reviews, and any place whose name says it has closed', () => {
    const tiny = { ...byName('Lantern Lane'), primaryType: 'shopping_mall', types: ['shopping_mall'], userRatingCount: 12 }
    expect(fromGooglePlace(tiny, '2026-10-10T14:00')).toBeNull()
    const shut = { ...byName('Lantern Lane'), displayName: { text: 'Wisma Drug Store (No longer in operation)' } }
    expect(fromGooglePlace(shut, '2026-10-10T14:00')).toBeNull()
  })

  it('weekdayOf reads the date only (0 is Sunday)', () => {
    expect(weekdayOf('2026-10-10T23:59')).toBe(6) // a Saturday
    expect(weekdayOf('2026-10-11T00:30')).toBe(0)
  })

  it('hoursOnDay: that day only, past midnight, last night carrying over, closed days, and 24 hours', () => {
    const periods = [
      { open: day(5, 11), close: day(6, 2) }, // Friday 11:00 to Saturday 02:00
      { open: day(6, 11), close: day(6, 22) }, // Saturday 11:00 to 22:00
    ]
    expect(hoursOnDay({ periods }, 5)).toEqual([['11:00', '02:00']])
    expect(hoursOnDay({ periods }, 6)).toEqual([['00:00', '02:00'], ['11:00', '22:00']])
    expect(hoursOnDay({ periods }, 1)).toEqual([]) // Monday: closed
    expect(hoursOnDay({ periods: [{ open: day(0, 0) }] }, 3)).toEqual([['00:00', '24:00']])
    expect(hoursOnDay({ periods: [{ open: day(2, 18), close: day(3, 0) }] }, 2)).toEqual([['18:00', '24:00']])
    expect(hoursOnDay(undefined, 3)).toBeNull()
  })

  it('an invented place becomes a venue: Google id kept, real rating, price from the level, that day\'s hours', () => {
    const v = fromGooglePlace(byName('Nonna Example'), '2026-10-10T19:00')
    expect(v.id).toBe(`google_${byName('Nonna Example').id}`)
    expect(v).toMatchObject({ category: 'eat', kind: 'restaurant', cuisine: 'italian', source: 'google', avgPricePerPerson: 25 })
    expect(v.rating).toBe(byName('Nonna Example').rating)
    expect(v.diet).toEqual({ halal: 'unknown', vegetarian: 'unknown', vegan: 'unknown', healthy: 3 })
    expect(v.dataQuality).toMatchObject({ hoursAssumed: false, hoursForWeekday: 6, priceFromLevel: true })
    expect(v.openingHours.length).toBeGreaterThan(0)
  })

  it('the 24-hour food court is open at 3am; a closed-down place or one with no location is left out', () => {
    const court = fromGooglePlace(byName('Example Food'), '2026-10-10T03:00')
    expect(court.openingHours).toEqual([['00:00', '24:00']])
    expect(court.kind).toBe('hawker')
    expect(fromGooglePlace({ ...byName('Lantern Lane'), businessStatus: 'CLOSED_PERMANENTLY' }, '2026-10-10T12:00')).toBeNull()
    expect(fromGooglePlace({ ...byName('Lantern Lane'), location: undefined }, '2026-10-10T12:00')).toBeNull()
  })

  it('no price level: a typical price, labelled as a guess; a photo keeps its name and credit', () => {
    const v = fromGooglePlace({ ...byName('Lantern Lane'), priceLevel: undefined }, '2026-10-10T12:00')
    expect(v.dataQuality.priceAssumed).toBe(true)
    expect(v.photo.name).toMatch(/^places\/.+\/photos\/STUB_PHOTO$/)
    expect(v.photo.credit.displayName).toBe('A Google user')
  })
})

// ---------------------------------------------------------------- the service
describe('createGooglePlaces', () => {
  const fakeHttp = () => ({ postJson: vi.fn(async () => ({ places: SAMPLE })), getJson: vi.fn(async () => ({ photoUri: 'https://lh3.googleusercontent.com/img1' })) })

  it('is off without a key, and on in stub mode', async () => {
    expect(createGooglePlaces({ http: fakeHttp() }).enabled).toBe(false)
    expect(createGooglePlaces({ http: fakeHttp(), stub: true }).enabled).toBe(true)
    await expect(createGooglePlaces({ http: fakeHttp() }).nearby(BISHAN)).rejects.toThrow(/GOOGLE_MAPS_API_KEY/)
  })

  it('asks for the nearest food places with only the fields Jio uses, and the key in a header', async () => {
    const http = fakeHttp()
    await createGooglePlaces({ http, apiKey: 'k' }).nearby(BISHAN, { categories: ['eat'] })
    await createGooglePlaces({ http, apiKey: 'k' }).nearby(BISHAN, { categories: ['shop'] })
    expect(http.postJson.mock.calls[1][1].includedTypes).toEqual(['shopping_mall'])
    await createGooglePlaces({ http, apiKey: 'k' }).nearby(BISHAN, { categories: ['activity'] })
    expect(http.postJson.mock.calls[2][1].includedTypes).toEqual(
      ['amusement_center', 'amusement_park', 'aquarium', 'art_gallery', 'bowling_alley', 'karaoke', 'movie_theater', 'video_arcade', 'zoo'],
    )
    const [url, body, { headers }] = http.postJson.mock.calls[0]
    expect(url).toBe('https://places.googleapis.com/v1/places:searchNearby')
    expect(body).toMatchObject({ includedTypes: ['dessert_shop', 'food_court', 'restaurant'], maxResultCount: 20, rankPreference: 'DISTANCE' })
    expect(body.locationRestriction.circle).toEqual({ center: { latitude: BISHAN.lat, longitude: BISHAN.lng }, radius: 1000 })
    expect(headers).toEqual({ 'X-Goog-Api-Key': 'k', 'X-Goog-FieldMask': NEARBY_FIELDS })
  })

  it('caches by place (about 110 m) and categories, and asks for nothing when no category needs Google', async () => {
    const http = fakeHttp()
    const places = createGooglePlaces({ http, apiKey: 'k' })
    await places.nearby(BISHAN, { categories: ['eat', 'drink'] })
    await places.nearby({ lat: BISHAN.lat + 0.0002, lng: BISHAN.lng }, { categories: ['drink', 'eat'] })
    expect(http.postJson).toHaveBeenCalledTimes(1)
    expect(await places.nearby(BISHAN, { categories: [] })).toEqual([])
    expect(http.postJson).toHaveBeenCalledTimes(1)
  })

  it('photoUrl: only real photo names, and the key never leaves the server', async () => {
    const http = fakeHttp()
    const places = createGooglePlaces({ http, apiKey: 'k' })
    expect(await places.photoUrl('places/abc/photos/def', 400)).toBe('https://lh3.googleusercontent.com/img1')
    expect(http.getJson.mock.calls[0][0]).toBe('https://places.googleapis.com/v1/places/abc/photos/def/media?maxWidthPx=400&skipHttpRedirect=true')
    await expect(places.photoUrl('../../secret')).rejects.toThrow(/not a Google photo name/)
  })
})

// ---------------------------------------------------------------- over HTTP
describe('Google places in the planner routes', () => {
  const FRONTEND = 'http://localhost:5173'
  const servers = []
  const start = async (options) => {
    const s = createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }), ownPlacesEnough: Infinity, ...options }).listen(0, '127.0.0.1')
    await once(s, 'listening')
    servers.push(s)
    return `http://127.0.0.1:${s.address().port}`
  }
  let stubUrl
  beforeAll(async () => {
    stubUrl = await start({ stub: true })
  })
  afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

  const post = async (url, path, body) => {
    const res = await fetch(`${url}/api${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const slot = (categories) => ({
    members: [{ id: 'a', home: { lat: 1.3541, lng: 103.9446 } }, { id: 'b', home: { lat: 1.315, lng: 103.765 } }],
    occasion: 'casual_meal', dateTime: '2026-10-10T19:00', durationMinutes: 90, categories, centre: BISHAN, unknownPolicy: 'lenient', topN: 10,
  })

  it('adds Google places to a food slot, places them in a live forecast area, and says how many', async () => {
    // Centred where three of the invented restaurants are (about 600 m west of Bishan MRT), so they are in range.
    const { body } = await post(stubUrl, '/converge', { ...slot(['eat']), centre: { lat: 1.3504, lng: 103.8428 } })
    expect(body.google.source).toBe('google')
    expect(body.google.added).toBeGreaterThan(0)
    const fromGoogle = body.results.filter((r) => r.venue.source === 'google')
    expect(fromGoogle.length).toBeGreaterThan(0)
    // With live weather, every venue sits in one of NEA's named areas, not a rough region like "central".
    expect(body.weather.source).toBe('live')
    for (const r of fromGoogle) expect(['central', 'north', 'south', 'east', 'west', 'northeast']).not.toContain(r.venue.forecastArea)
  })

  it('only adds places of the slot\'s category: a drink slot gets no restaurants', async () => {
    const { body } = await post(stubUrl, '/converge', { ...slot(['drink']), centre: { lat: 1.3497, lng: 103.8507 } })
    expect(body.google.source).toBe('google')
    for (const r of body.results.filter((x) => x.venue.source === 'google')) expect(r.venue.category).toBe('drink')
  })

  it('shop and activity slots ask Google too, and a server without a key does not', async () => {
    expect((await post(stubUrl, '/converge', slot(['shop']))).body.google.source).toBe('google')
    expect((await post(stubUrl, '/converge', slot(['activity']))).body.google.source).toBe('google')
    const plain = await start({})
    expect((await post(plain, '/converge', slot(['eat']))).body.google).toEqual({ source: 'off', added: 0 })
  })

  it('when Google is down, the slot is still answered with the other venues', async () => {
    const down = async () => { throw new ExternalApiError('google answered 503', { service: 'google', status: 503, url: 'x' }) }
    const url = await start({ places: { enabled: true, nearby: down, photoUrl: down } })
    const res = await post(url, '/converge', slot(['eat']))
    expect(res.status).toBe(200)
    expect(res.body.google).toEqual({ source: 'unavailable', added: 0 })
    expect(res.body.results.length).toBeGreaterThan(0)
  })

  it('GET /api/places/photo redirects to the image, refuses a bad name, and answers 503 without Google', async () => {
    const ok = await fetch(`${stubUrl}/api/places/photo?name=places/abc/photos/def`, { redirect: 'manual' })
    expect(ok.status).toBe(302)
    expect(ok.headers.get('location')).toBe('https://lh3.googleusercontent.com/stub-photo')
    expect((await fetch(`${stubUrl}/api/places/photo?name=../etc`)).status).toBe(400)
    const plain = await start({})
    expect((await fetch(`${plain}/api/places/photo?name=places/abc/photos/def`)).status).toBe(503)
  })
})
