// Ticket #149: Google places compete fairly. A rating counts as far as its reviews (scoring.js, covered in cdc.test.js and
// fictional-pool.test.js), food and drink need 20 reviews to be added, one place per building, Google only as a top-up.
// Nothing here calls Google: the places service is a fake, and fixtures are invented.
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { buildingKey, capGoogle, onePerBuilding } from '../src/planner/diversity.js'
import { converge } from '../src/planner/engine.js'
import { isOpenAt } from '../src/planner/filters.js'
import { fromGooglePlace } from '../src/planner/google-adapter.js'
import { createHttp } from '../src/services/http.js'

const row = (id, { category = 'eat', source = 'curated', postalCode, address } = {}) => ({ venue: { id, category, source, postalCode, address } })
const ids = (rows) => rows.map((r) => r.venue.id)

describe('buildingKey', () => {
  it('is the postal code, from whichever field holds it', () => {
    expect(buildingKey({ postalCode: '039596' })).toBe('p:039596')
    expect(buildingKey({ address: '9 Raffles Blvd, #01-40 Millenia Walk, Singapore 039596' })).toBe('p:039596')
    expect(buildingKey({ area: '1 Some Rd, Singapore 123456' })).toBe('p:123456')
  })

  it('is the street number and street when there is no postal code, whatever the unit', () => {
    expect(buildingKey({ address: '21 Canberra Link' })).toBe('s:21 canberra link')
    expect(buildingKey({ address: '21 Canberra Link, #02-14' })).toBe('s:21 canberra link')
    expect(buildingKey({ address: '21 Canberra Link, Unit 5' })).toBe('s:21 canberra link')
  })

  it('is null when the building cannot be told, so such a place is its own building', () => {
    expect(buildingKey({ area: 'Tiong Bahru' })).toBeNull()
    expect(buildingKey({ address: 'Marina Bay' })).toBeNull()
    expect(buildingKey({})).toBeNull()
  })
})

describe('one place per building', () => {
  it('moves a second place at the same address below the places at other buildings, and drops nothing', () => {
    const rows = [
      row('a1', { postalCode: '111111' }), row('a2', { postalCode: '111111' }), row('a3', { postalCode: '111111' }),
      row('b', { postalCode: '222222' }), row('c', { postalCode: '333333' }),
    ]
    expect(ids(onePerBuilding(rows))).toEqual(['a1', 'b', 'c', 'a2', 'a3'])
  })

  it('is per category: a café and a restaurant in one building are both kept in place', () => {
    const rows = [row('r', { category: 'eat', postalCode: '111111' }), row('c', { category: 'drink', postalCode: '111111' }), row('x', { postalCode: '222222' })]
    expect(ids(onePerBuilding(rows))).toEqual(['r', 'c', 'x'])
  })

  it('never merges places whose building is unknown', () => {
    const rows = [row('p', {}), row('q', {}), row('r', {})]
    expect(ids(onePerBuilding(rows))).toEqual(['p', 'q', 'r'])
  })

  it('works across sources: a saved CDC site and a Google stall at one postal code are one building', () => {
    const rows = [row('cdc', { source: 'cdc', postalCode: '520248' }), row('g', { source: 'google', address: '248 Simei St 3, Singapore 520248' }), row('other', { postalCode: '999999' })]
    expect(ids(onePerBuilding(rows))).toEqual(['cdc', 'other', 'g'])
  })
})

describe('Google only as a top-up', () => {
  const mixed = [
    row('g1', { source: 'google' }), row('g2', { source: 'google' }), row('g3', { source: 'google' }), row('g4', { source: 'google' }),
    row('o1'), row('o2'), row('o3'),
  ]

  it('keeps at most 2 Google places among the top 5 of a category, and moves the rest below', () => {
    const out = capGoogle(mixed, 5, 2)
    expect(ids(out)).toEqual(['g1', 'g2', 'o1', 'o2', 'o3', 'g3', 'g4'])
    expect(out.slice(0, 5).filter((r) => r.venue.source === 'google')).toHaveLength(2)
    expect(out).toHaveLength(mixed.length)
  })

  it('never moves a place we already know, and leaves Google alone when there are no more than 2', () => {
    expect(ids(capGoogle([row('o1'), row('o2'), row('g1', { source: 'google' })], 5, 2))).toEqual(['o1', 'o2', 'g1'])
  })

  it('counts each category on its own', () => {
    const rows = [
      row('e1', { source: 'google' }), row('e2', { source: 'google' }), row('e3', { source: 'google' }),
      row('d1', { category: 'drink', source: 'google' }), row('d2', { category: 'drink', source: 'google' }),
    ]
    expect(ids(capGoogle(rows, 5, 2))).toEqual(['e1', 'e2', 'd1', 'd2', 'e3'])
  })

  it('fills the whole list with Google when that is all there is', () => {
    const only = Array.from({ length: 4 }, (_, i) => row(`g${i}`, { source: 'google' }))
    expect(ids(capGoogle(only, 5, 2))).toEqual(['g0', 'g1', 'g2', 'g3'])
  })
})

describe('the engine applies both rules', () => {
  const data = loadPlanData()
  const centre = { lat: 1.3504, lng: 103.8428 }
  const dateTime = '2026-10-14T12:30'
  const base = data.venues.find((v) => v.category === 'eat' && isOpenAt(v, dateTime))
  const twin = (id, extra) => ({ ...base, id, name: id, lat: centre.lat, lng: centre.lng, postalCode: undefined, address: undefined, area: id, rating: null, ratingCount: null, source: 'curated', ...extra })
  const input = { members: [{ id: 'a', home: { lat: 1.37, lng: 103.85 } }, { id: 'b', home: { lat: 1.33, lng: 103.84 } }], occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], centre, unknownPolicy: 'lenient', topN: 5 }
  const run = (venues) => converge(input, { ...data, venues })

  it('shows one stall of a food court and then the other places, with the rest of the court still on the list', () => {
    const court = Array.from({ length: 5 }, (_, i) => twin(`stall${i}`, { postalCode: '111111', rating: 5, ratingCount: 400 }))
    const others = Array.from({ length: 4 }, (_, i) => twin(`other${i}`, { postalCode: `22222${i}` }))
    const out = run([...court, ...others])
    const top = out.results.slice(0, 5).map((r) => r.venueId)
    expect(top.filter((id) => id.startsWith('stall'))).toHaveLength(1)
    expect(top).toHaveLength(5)
  })

  it('keeps Google to 2 of the top 5 even when every Google place is the best rated', () => {
    const google = Array.from({ length: 6 }, (_, i) => twin(`g${i}`, { source: 'google', rating: 4.9, ratingCount: 900, area: `g${i}` }))
    const own = Array.from({ length: 4 }, (_, i) => twin(`own${i}`))
    const out = run([...google, ...own])
    const top = out.results.slice(0, 5)
    expect(top.filter((r) => r.venue.source === 'google')).toHaveLength(2)
    expect(top.filter((r) => r.venue.source !== 'google')).toHaveLength(3)
  })
})

describe('food and drink need 20 Google reviews', () => {
  const place = (extra) => ({ id: 'g1', displayName: { text: 'Test Cafe' }, location: { latitude: 1.3, longitude: 103.8 }, primaryType: 'cafe', rating: 5, ...extra })
  const at = '2026-10-14T12:00'

  it('adds a café with 20 reviews and leaves out one with 19, or with no count at all', () => {
    expect(fromGooglePlace(place({ userRatingCount: 20 }), at)).not.toBeNull()
    expect(fromGooglePlace(place({ userRatingCount: 19 }), at)).toBeNull()
    expect(fromGooglePlace(place({ userRatingCount: 1 }), at)).toBeNull()
    expect(fromGooglePlace(place({}), at)).toBeNull()
  })

  it('does not apply to a place someone searched for by name', () => {
    expect(fromGooglePlace(place({ userRatingCount: 1 }), at, { searched: true })).not.toBeNull()
  })
})

describe('the planner asks Google only for categories where we know fewer than 6 open places', () => {
  const data = loadPlanData()
  const dateTime = '2026-10-14T12:30'
  const centre = { lat: 1.3504, lng: 103.8428 }
  const open = data.venues.filter((v) => isOpenAt(v, dateTime))
  const clones = (category, n) => open.filter((v) => v.category === category).slice(0, n).map((v, i) => ({ ...v, id: `own_${category}_${i}`, lat: centre.lat, lng: centre.lng }))
  const body = (categories) => ({
    members: [{ id: 'a', home: { lat: 1.37, lng: 103.85 } }, { id: 'b', home: { lat: 1.33, lng: 103.84 } }],
    occasion: 'casual_meal', dateTime, durationMinutes: 60, categories, centre, unknownPolicy: 'lenient',
  })

  let server
  let base
  let nearby
  const planData = { ...data, venues: [...clones('eat', 7), ...clones('drink', 2)] }
  beforeAll(async () => {
    nearby = vi.fn(async () => [])
    const places = { enabled: true, nearby, searchText: async () => [], details: async () => null, photoUrl: async () => null, timeoutMs: 500 }
    server = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), places, planData }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = `http://127.0.0.1:${server.address().port}/api`
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))
  const converged = async (categories) => (await fetch(`${base}/converge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(categories)) })).json()

  it('does not ask when we know enough, and says why', async () => {
    nearby.mockClear()
    const out = await converged(['eat'])
    expect(nearby).not.toHaveBeenCalled()
    expect(out.google).toEqual({ source: 'not_needed', added: 0, reason: 'enough_own_places' })
  })

  it('asks only about the category we are short of, and says which it skipped', async () => {
    nearby.mockClear()
    const out = await converged(['eat', 'drink'])
    expect(nearby).toHaveBeenCalledTimes(1)
    expect(nearby.mock.calls[0][1].categories).toEqual(['drink'])
    expect(out.google).toMatchObject({ source: 'google', skipped: ['eat'] })
  })

  it('asks about a category we know nothing of', async () => {
    nearby.mockClear()
    const out = await converged(['activity'])
    expect(nearby.mock.calls[0][1].categories).toEqual(['activity'])
    expect(out.google.source).toBe('google')
  })
})
