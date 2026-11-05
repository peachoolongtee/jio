// Ticket #149: Google places compete fairly. A rating counts as far as its reviews (scoring.js, covered in cdc.test.js and
// fictional-pool.test.js), food and drink need 20 reviews to be added, one place per building, Google only as a top-up.
// Nothing here calls Google: the places service is a fake, and fixtures are invented.
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { buildingKey, capGoogle, onePerBuilding } from '../src/planner/diversity.js'
import { converge, roam } from '../src/planner/engine.js'
import { filterByConstraints, isOpenAt, weekdayOf } from '../src/planner/filters.js'
import { fromGooglePlace } from '../src/planner/google-adapter.js'
import { createHttp } from '../src/services/http.js'
import { DEFAULT_WEIGHTS, reasonTags, weightedRating } from '../src/planner/scoring.js'

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

// ---------------------------------------------------------------- review fixes: the count of our own places
// Starts the app with a fake places service (never Google) and the given plan data; returns what a test needs.
//
// How to call:
//   const app = await serve(planData); const out = await app.post('/converge', body); await app.close()
async function serve(planData, extra = {}) {
  const nearby = vi.fn(async () => [])
  const places = { enabled: true, nearby, searchText: async () => [], details: vi.fn(async () => null), photoUrl: async () => null, timeoutMs: 500, ...extra }
  const server = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }), places, planData }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}/api`
  return {
    nearby,
    details: places.details,
    post: async (path, body) => (await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json(),
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

describe('our own places are counted with the engine\'s own filters before Google is asked', () => {
  const data = loadPlanData()
  const dateTime = '2026-10-14T12:30' // a Wednesday
  const centre = { lat: 1.3504, lng: 103.8428 }
  const members = [{ id: 'a', home: { lat: 1.37, lng: 103.85 } }, { id: 'b', home: { lat: 1.33, lng: 103.84 } }]
  const baseBody = { members, occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], centre, unknownPolicy: 'lenient' }
  const baseline = (category) =>
    filterByConstraints(data.venues, { members, groupConstraints: [], dateTime, categories: [category], unknownPolicy: 'lenient', durationMinutes: 60, excludeVenueIds: [] }).passed
  // n of our places that pass the plain request, standing at the centre, each changed by `patch`.
  const clones = (category, n, patch = {}) =>
    baseline(category).slice(0, n).map((v, i) => ({ ...v, id: `own_${category}_${i}`, lat: centre.lat, lng: centre.lng, ...patch }))

  let app
  afterEach(async () => { await app?.close() })
  const asked = async (venues, body) => {
    app = await serve({ ...data, venues })
    const out = await app.post('/converge', { ...baseBody, ...body })
    return { out, called: app.nearby.mock.calls.length > 0 }
  }

  it('has enough venues in the pool to test with', () => {
    expect(baseline('eat').length).toBeGreaterThanOrEqual(7)
  })

  it('asks with exactly 5 of our places, and does not with exactly 6 (the boundary)', async () => {
    expect((await asked(clones('eat', 5), {})).called).toBe(true)
    await app.close()
    const six = await asked(clones('eat', 6), {})
    expect(six.called).toBe(false)
    expect(six.out.google).toEqual({ source: 'not_needed', added: 0, reason: 'enough_own_places' })
  })

  it('counts only places inside the circle Google would search', async () => {
    const far = clones('eat', 7, { lat: centre.lat + 0.02 }) // about 2.2 km away
    expect((await asked(far, {})).called).toBe(true)
  })

  // Each case: a patch that makes the engine reject all 7 of our places for the request (Google must be asked), and a patch
  // that lets them pass the same request (Google must not be asked). Before the fix only category, distance and opening
  // time were counted, so every "rejects" case below skipped Google.
  const wed = weekdayOf(dateTime)
  const cases = [
    { name: 'a dietary need', body: { members: members.map((m) => ({ ...m, dietary: ['halal'] })) },
      rejects: { diet: { halal: 'none', vegetarian: 'full', vegan: 'full', healthy: 3 } }, passes: { diet: { halal: 'full', vegetarian: 'full', vegan: 'full', healthy: 3 } } },
    { name: 'a last stop (needs an MRT station close by)', body: { lastStop: true },
      rejects: { mrtWalkMinutes: 25 }, passes: { mrtWalkMinutes: 3 } },
    { name: 'a near_mrt constraint', body: { groupConstraints: ['near_mrt:5'] },
      rejects: { mrtWalkMinutes: 12 }, passes: { mrtWalkMinutes: 3 } },
    { name: 'max_price_pp', body: { groupConstraints: ['max_price_pp:10'] },
      rejects: { avgPricePerPerson: 40 }, passes: { avgPricePerPerson: 5 } },
    { name: 'indoor_only', body: { groupConstraints: ['indoor_only'] },
      rejects: { setting: 'outdoor' }, passes: { setting: 'indoor' } },
    { name: 'a weekday it is closed', body: {},
      rejects: { closedWeekdays: [wed] }, passes: { closedWeekdays: [] } },
    { name: 'a cleaning closure', body: {},
      rejects: { closures: [{ from: '2026-10-13', to: '2026-10-15' }] }, passes: { closures: [] } },
    { name: 'a visit longer than it stays open', body: {},
      rejects: { openingHours: [['09:00', '13:00']] }, passes: { openingHours: [['09:00', '15:00']] } },
    { name: 'a group bigger than it holds', body: {},
      rejects: { maxGroupSize: 1 }, passes: { maxGroupSize: 10 } },
  ]
  for (const c of cases) {
    it(`asks when ${c.name} leaves too few of our places, and does not when they still fit`, async () => {
      expect((await asked(clones('eat', 7, c.rejects), c.body)).called).toBe(true)
      await app.close()
      const fits = await asked(clones('eat', 7, c.passes), c.body)
      expect(fits.called).toBe(false)
      expect(fits.out.google.reason).toBe('enough_own_places')
    })
  }

  it('does not count a place the request excludes', async () => {
    const ten = clones('eat', 7)
    const exclude = { excludeVenueIds: [ten[0].id, ten[1].id] }
    expect((await asked(ten, exclude)).called).toBe(true)
    await app.close()
    expect((await asked(ten, {})).called).toBe(false)
  })

  it('counts a member who has opted out as gone, in Converge', async () => {
    const needsHalal = [{ ...members[0], dietary: ['halal'] }, members[1]]
    const none = { diet: { halal: 'none', vegetarian: 'full', vegan: 'full', healthy: 3 } }
    expect((await asked(clones('eat', 7, none), { members: needsHalal })).called).toBe(true)
    await app.close()
    expect((await asked(clones('eat', 7, none), { members: needsHalal, optedOut: ['a'] })).called).toBe(false)
  })

  it('counts Roam with the same filters', async () => {
    app = await serve({ ...data, venues: clones('eat', 7, { mrtWalkMinutes: 25 }) })
    const body = { members, occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], current: centre, unknownPolicy: 'lenient', groupConstraints: ['near_mrt:5'] }
    await app.post('/roam', body)
    expect(app.nearby).toHaveBeenCalledTimes(1)
    await app.close()
    app = await serve({ ...data, venues: clones('eat', 7, { mrtWalkMinutes: 3 }) })
    await app.post('/roam', body)
    expect(app.nearby).not.toHaveBeenCalled()
  })

  it('still looks up a google_ option by id when the nearby search is skipped for enough own places', async () => {
    const raw = {
      id: 'ChIJoption1', displayName: { text: 'Chosen Noodle House' }, formattedAddress: '1 Example Rd, Singapore 123456',
      location: { latitude: centre.lat, longitude: centre.lng }, primaryType: 'restaurant', rating: 4.4, userRatingCount: 120,
    }
    app = await serve({ ...data, venues: clones('eat', 7) }, { details: vi.fn(async (id) => (id === 'ChIJoption1' ? raw : null)) })
    const out = await app.post('/converge', { ...baseBody, currentOptionIds: ['google_ChIJoption1'] })
    expect(app.nearby).not.toHaveBeenCalled()
    expect(app.details).toHaveBeenCalledWith('ChIJoption1')
    expect(out.google).toMatchObject({ source: 'not_needed', reason: 'enough_own_places' })
    expect(out.google.missing).toBeUndefined()
    expect(out.current.map((r) => r.venueId)).toContain('google_ChIJoption1')
  })
})

// ---------------------------------------------------------------- review fixes: the cap window, the rating share, the pre-score
describe('the Google cap is on the first 5 places, whatever topN is', () => {
  const data = loadPlanData()
  const centre = { lat: 1.3504, lng: 103.8428 }
  const dateTime = '2026-10-14T12:30'
  const members = [{ id: 'a', home: { lat: 1.37, lng: 103.85 } }, { id: 'b', home: { lat: 1.33, lng: 103.84 } }]
  const base = filterByConstraints(data.venues, { members, groupConstraints: [], dateTime, categories: ['eat'], unknownPolicy: 'lenient', durationMinutes: 60 }).passed[0]
  const twin = (id, extra) => ({ ...base, id, name: id, lat: centre.lat, lng: centre.lng, postalCode: undefined, address: undefined, area: id, mealPeriods: [], ...extra })
  const converged = { members, occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], centre, unknownPolicy: 'lenient', topN: 10 }
  const roamed = { members, occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], current: centre, unknownPolicy: 'lenient', topN: 10 }
  // Best first by rating alone: own0-4, then Google 0-3, then own5 (every place is at one point, so travel is equal).
  const venues = [
    ...[0, 1, 2, 3, 4].map((i) => twin(`own${i}`, { rating: 4.9 - i * 0.01, ratingCount: 900 })),
    ...[0, 1, 2, 3].map((i) => twin(`g${i}`, { source: 'google', rating: 4.1 - i * 0.01, ratingCount: 900 })),
    twin('own5', { rating: 3.0, ratingCount: 900 }),
  ]
  const order = ['own0', 'own1', 'own2', 'own3', 'own4', 'g0', 'g1', 'g2', 'g3', 'own5']

  it('Converge with topN 10: Google is capped at 2 only within the first 5, and may fill positions 6 on', () => {
    const out = converge(converged, { ...data, venues })
    expect(out.results.map((r) => r.venueId)).toEqual(order)
    expect(out.results.slice(0, 5).filter((r) => r.venue.source === 'google')).toHaveLength(0)
    expect(out.results.slice(5).filter((r) => r.venue.source === 'google')).toHaveLength(4)
  })

  it('Roam with topN 10 does the same', () => {
    const out = roam(roamed, { ...data, venues })
    expect(out.results.map((r) => r.venueId)).toEqual(order)
  })

  it('still allows only 2 Google places in the first 5 with topN 10', () => {
    const googleFirst = venues.map((v) => (v.source === 'google' ? { ...v, rating: 4.95 } : v))
    for (const out of [converge(converged, { ...data, venues: googleFirst }), roam(roamed, { ...data, venues: googleFirst })]) {
      expect(out.results.slice(0, 5).filter((r) => r.venue.source === 'google')).toHaveLength(2)
      expect(out.results.slice(5).filter((r) => r.venue.source === 'google')).toHaveLength(2)
    }
  })
})

describe('the rating keeps its share of the score whatever weights a request sends', () => {
  const data = loadPlanData()
  const centre = { lat: 1.3504, lng: 103.8428 }
  const dateTime = '2026-10-14T12:30'
  const members = [{ id: 'a', home: { lat: 1.37, lng: 103.85 } }, { id: 'b', home: { lat: 1.33, lng: 103.84 } }]
  const eat = filterByConstraints(data.venues, { members, groupConstraints: [], dateTime, categories: ['eat'], unknownPolicy: 'lenient', durationMinutes: 60 }).passed
  const pool = { ...data, venues: eat.slice(0, 6).map((v, i) => ({ ...v, mealPeriods: [], lat: centre.lat, lng: centre.lng, rating: 4.5, ratingCount: 100 + i })) }
  const input = { members, occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], centre, unknownPolicy: 'lenient', topN: 5 }
  const share = (breakdown) => breakdown.rating.weight / Object.values(breakdown).reduce((sum, b) => sum + b.weight, 0)

  it('is the same share for the defaults, { worst: 1 } and a heavy custom set, in Converge', () => {
    const shares = [undefined, { worst: 1 }, { worst: 500, occasion: 300 }].map((weights) => share(converge({ ...input, ...(weights && { weights }) }, pool).results[0].breakdown))
    // 8 out of a default total of 90, next to that total: 8 / 98.
    for (const s of shares) expect(s).toBeCloseTo(8 / 98, 10)
  })

  it('is the same share in Roam', () => {
    const roamInput = { ...input, current: centre }
    delete roamInput.centre
    const shares = [undefined, { distance: 1 }, { distance: 90, occasion: 10 }].map((weights) => share(roam({ ...roamInput, ...(weights && { weights }) }, pool).results[0].breakdown))
    for (const s of shares) expect(s).toBeCloseTo(8 / 96, 10) // 8 out of a default total of 88
  })

  it('keeps the default weight of 8 for the defaults and does not let all-zero weights switch the rating off', () => {
    expect(Object.values(DEFAULT_WEIGHTS.converge).reduce((a, b) => a + b, 0)).toBe(90)
    expect(Object.values(DEFAULT_WEIGHTS.roam).reduce((a, b) => a + b, 0)).toBe(88)
    const out = converge({ ...input, weights: { worst: 0 } }, pool)
    expect(out.results[0].breakdown.rating.weight).toBe(8)
  })
})

describe('weightedRating and the reasons', () => {
  it('matches the worked example in its documentation: 4.6 stars from 500 reviews is 2380 / 520', () => {
    expect(weightedRating({ rating: 4.6, ratingCount: 500 })).toBeCloseTo(2380 / 520, 10)
    expect(weightedRating({ rating: 4.6, ratingCount: 500 })).toBeCloseTo(4.5769, 4)
    expect(weightedRating({ rating: 5, ratingCount: 1 })).toBeCloseTo(4.0476, 4)
  })
})

describe('the "Rated ..." reason', () => {
  const venue = (extra) => ({ avgPricePerPerson: 20, tags: ['hidden'], mrtWalkMinutes: 12, setting: 'indoor', rating: 4.6, ratingCount: 512, ...extra })
  const tags = (extra, walkMinutes = 3) => reasonTags({ venue: venue(extra), walkMinutes, crowd: 'moderate', rainy: false, time: '12:30' })

  it('starts with a capital letter and reads "Rated 4.6 from 512 reviews"', () => {
    expect(tags({})).toContain('Rated 4.6 from 512 reviews')
    expect(tags({}).join(' ')).not.toMatch(/\brated\b/)
  })

  it('comes ahead of "Short walk" and "Hidden gem" when it is earned, so the two-tag cut keeps it', () => {
    expect(tags({})).toEqual(['Rated 4.6 from 512 reviews', 'Short walk'])
    expect(tags({}, 12)).toEqual(['Rated 4.6 from 512 reviews', 'Hidden gem'])
  })

  it('still follows "Near MRT" and "Quiet at ...", which come first', () => {
    expect(tags({ mrtWalkMinutes: 2 })).toEqual(['Near MRT', 'Rated 4.6 from 512 reviews'])
  })

  it('needs 50 reviews and a weighted rating of 4.2: a low rating or a thin count is not a reason', () => {
    expect(tags({ ratingCount: 50, rating: 4.6 }).join(' ')).toMatch(/Rated 4.6 from 50 reviews/)
    expect(tags({ ratingCount: 49 }).join(' ')).not.toMatch(/Rated/)
    expect(tags({ rating: 3.1, ratingCount: 800 }).join(' ')).not.toMatch(/Rated/)
    expect(tags({ rating: 4.2, ratingCount: 800 }).join(' ')).not.toMatch(/Rated/) // 4.2 raw is 4.19 weighted: just under
    expect(tags({ rating: 4.3, ratingCount: 800 }).join(' ')).toMatch(/Rated 4.3 from 800 reviews/)
    expect(tags({ rating: null, ratingCount: null }).join(' ')).not.toMatch(/Rated/)
  })
})

describe('the first cut keeps the old distance-to-fit ratio when nothing has a rating', () => {
  const data = loadPlanData()
  const centre = { lat: 1.3504, lng: 103.8428 }
  const dateTime = '2026-10-14T12:30'
  const members = [{ id: 'a', home: { lat: 1.37, lng: 103.85 } }, { id: 'b', home: { lat: 1.33, lng: 103.84 } }]
  const base = filterByConstraints(data.venues, { members, groupConstraints: [], dateTime, categories: ['eat'], unknownPolicy: 'lenient', durationMinutes: 60 }).passed[0]
  // 14 unrated places at growing distances and with fits that do not follow the distance. These fits make a 0.55 : 0.30
  // split of distance and fit shortlist other places than 0.625 : 0.375 does (checked when the test was written).
  const venues = Array.from({ length: 14 }, (_, i) => ({
    ...base, id: `p${i}`, name: `p${i}`, area: `p${i}`, postalCode: undefined, address: undefined, mealPeriods: [], rating: null, ratingCount: null,
    lat: centre.lat + (i + 1) * 0.0011, lng: centre.lng, occasionFit: { casual_meal: (i * 13) % 100 },
  }))

  it('shortlists the same places dev did (0.625 x distance + 0.375 x misfit), by the old formula', () => {
    const km = (v) => Math.abs(v.lat - centre.lat) * 111.19
    const dists = venues.map(km), lo = Math.min(...dists), hi = Math.max(...dists)
    const old = venues
      .map((v, i) => ({ id: v.id, pre: 0.625 * ((100 * (dists[i] - lo)) / (hi - lo)) + 0.375 * (100 - v.occasionFit.casual_meal) }))
      .sort((a, b) => a.pre - b.pre)
      .slice(0, 5)
      .map((o) => o.id)
    const out = converge({ members, occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], centre, unknownPolicy: 'lenient', radiusMeters: 3000, pruneTo: 5, topN: 20 }, { ...data, venues })
    expect(out.results.map((r) => r.venueId).sort()).toEqual([...old].sort())
  })
})
