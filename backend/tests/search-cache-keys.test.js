// The search caches treat spellings of one search as one search: case, extra spaces, accents and curly quotes do not make a
// second call to OneMap or Google. Nothing here touches the network: both services run in stub mode, with a counter on the
// HTTP helper.
import { describe, expect, it } from 'vitest'
import { queryKey } from '../src/services/cache.js'
import { createGooglePlaces } from '../src/services/google-places.js'
import { createHttp } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'

const counted = () => {
  const http = createHttp({ stub: true })
  const calls = { get: 0, post: 0, urls: [], bodies: [] }
  const get = http.getJson.bind(http)
  const post = http.postJson.bind(http)
  http.getJson = (...args) => { calls.get += 1; calls.urls.push(args[0]); return get(...args) }
  http.postJson = (...args) => { calls.post += 1; calls.bodies.push(args[1]); return post(...args) }
  return { http, calls }
}
const CENTRE = { lat: 1.3521, lng: 103.8198 }

describe('queryKey', () => {
  it('makes spellings of one search the same key', () => {
    const key = queryKey('teo heng')
    for (const v of ['Teo Heng', '  teo heng ', 'TEO HENG', 'teo   heng', 'Teo\tHeng', 'teo\nheng']) expect(queryKey(v)).toBe(key)
    expect(queryKey('CAFÉ')).toBe('cafe')
    expect(queryKey('Kreta Ayer People’s Theatre')).toBe(queryKey("kreta ayer people's theatre"))
    expect(queryKey('Ｂｉｓｈａｎ')).toBe('bishan') // full-width letters
  })

  it('keeps different searches apart', () => {
    expect(queryKey('teo heng')).not.toBe(queryKey('teo hang'))
    expect(queryKey('bishan 1')).not.toBe(queryKey('bishan 11'))
    expect(queryKey('')).toBe('')
    expect(queryKey(null)).toBe('')
  })

  it('keeps words in other scripts apart when only a vowel sign or a voicing mark differs', () => {
    expect(queryKey('கா')).not.toBe(queryKey('க')) // Tamil
    expect(queryKey('が')).not.toBe(queryKey('か')) // Japanese
    expect(queryKey('की')).not.toBe(queryKey('क')) // Devanagari
    expect(queryKey('ที่')).not.toBe(queryKey('ที')) // Thai
  })

  it('still treats an accented Latin word as the plain one', () => {
    expect(queryKey('Café')).toBe(queryKey('cafe'))
    expect(queryKey('Crème Brûlée')).toBe(queryKey('creme brulee'))
  })

  it('leaves no stray mark after a capital I with a dot', () => {
    expect(queryKey('İstanbul')).toBe(queryKey('istanbul'))
  })
})

describe('the OneMap address search cache', () => {
  it('asks OneMap once for every spelling of one search', async () => {
    const { http, calls } = counted()
    const onemap = createOneMap({ http, stub: true })
    await onemap.search('Bishan MRT')
    await onemap.search('  bishan   mrt ')
    await onemap.search('BISHAN MRT')
    expect(calls.get).toBe(1)
    await onemap.search('Tampines MRT')
    expect(calls.get).toBe(2)
  })

  it('shares one call between spellings that arrive at the same moment', async () => {
    const { http, calls } = counted()
    const onemap = createOneMap({ http, stub: true })
    await Promise.all(['Bishan MRT', 'bishan  mrt', 'BISHAN MRT'].map((q) => onemap.search(q)))
    expect(calls.get).toBe(1)
  })
})

describe('the text sent out', () => {
  it('is the search as typed, while only the key is made plain', async () => {
    const typed = '  CAFÉ   Ｂｉｓｈａｎ  '
    const one = counted()
    await createOneMap({ http: one.http, stub: true }).search(typed)
    expect(one.calls.urls).toHaveLength(1)
    expect(one.calls.urls[0]).toContain(`searchVal=${encodeURIComponent(typed.trim())}`)
    expect(queryKey(typed)).toBe('cafe bishan')

    const two = counted()
    await createGooglePlaces({ http: two.http, stub: true }).searchText(typed, CENTRE)
    expect(two.calls.bodies).toHaveLength(1)
    expect(two.calls.bodies[0].textQuery).toBe(typed.trim())
  })
})

describe('the Google text search cache', () => {
  it('asks Google once for every spelling of one search near the same point', async () => {
    const { http, calls } = counted()
    const places = createGooglePlaces({ http, stub: true })
    await places.searchText('Teo Heng', CENTRE)
    await places.searchText(' teo   heng', CENTRE)
    await places.searchText('TEO HENG', CENTRE)
    expect(calls.post).toBe(1)
  })

  it('still asks again for a different search, or for the same words around another point', async () => {
    const { http, calls } = counted()
    const places = createGooglePlaces({ http, stub: true })
    await places.searchText('Teo Heng', CENTRE)
    await places.searchText('Have Fun Karaoke', CENTRE)
    await places.searchText('Teo Heng', { lat: 1.45, lng: 103.7 })
    expect(calls.post).toBe(3)
  })
})
