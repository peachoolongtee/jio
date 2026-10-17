// The planner's pool and scoring rules from the "keep fictional venues out of default recommendations" change:
//   - the 36 invented venues and the sample visit history are served only with INCLUDE_FICTIONAL_VENUES=1;
//   - a venue's rating changes no Converge or Roam score and no place in the shortlist;
//   - anti-repeat is 0 without a groupId, and uses today's Singapore date on every request.
// These tests go through loadPlanData() and the app's own default, as production does. The other test files read
// mock-data.json directly or run with the fictional pool on (vitest.config.js), so they cannot catch a broken gate.
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import mock from '../src/db/mock/mock-data.json'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { converge, roam } from '../src/planner/engine.js'
import { createHttp } from '../src/services/http.js'
import { antiRepeatPenalty, DEFAULT_WEIGHTS, singaporeToday } from '../src/planner/scoring.js'

const MOCK_IDS = new Set(mock.venues.map((v) => v.id))
const member = (id) => mock.members.find((m) => m.id === id)
const dinner = { occasion: 'casual_meal', dateTime: '2026-10-10T19:00' }
const orchard = { lat: 1.3048, lng: 103.8318 }
// Next to v09, the venue the sample visit history is about.
const nearV09 = { lat: 1.318, lng: 103.892 }

// Loads the pool as a running server would with the switch in this state: '' is off, '1' is on.
// How to call: const data = loadWith('')
const loadWith = (switchValue, options = {}) => {
  vi.stubEnv('INCLUDE_FICTIONAL_VENUES', switchValue)
  return loadPlanData({ fresh: true, ...options })
}

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllEnvs()
})
// Leaves the cache as the rest of this file's process found it: the test setup's pool, with the switch on.
afterAll(() => {
  vi.unstubAllEnvs()
  loadPlanData({ fresh: true })
})

describe('which venues the planner serves', () => {
  it('holds no invented venue and no sample visit by default', () => {
    const data = loadWith('')
    expect(data.venues.some((v) => v.source === 'mock')).toBe(false)
    expect(data.venues.some((v) => MOCK_IDS.has(v.id))).toBe(false)
    expect(data.visitHistory).toEqual([])
    expect(data._meta.sources.mock).toBe(0)
    // The real sources are all still there.
    const sources = new Set(data.venues.map((v) => v.source))
    expect(sources.has('curated') || data._meta.sources.curated > 0).toBe(true)
    expect(data._meta.sources.onemap).toBeGreaterThan(400)
    expect(data._meta.sources.cdc).toBeGreaterThan(1000)
  })

  it('brings both back with INCLUDE_FICTIONAL_VENUES=1', () => {
    const data = loadWith('1')
    expect(data.venues.filter((v) => v.source === 'mock')).toHaveLength(mock.venues.length)
    expect(data.visitHistory).toEqual(mock.visitHistory)
    expect(data.visitHistory.length).toBeGreaterThan(0)
    expect(data._meta.sources.mock).toBe(mock.venues.length)
  })

  it('does not follow NODE_ENV in either direction', () => {
    vi.stubEnv('NODE_ENV', 'test')
    expect(loadWith('').venues.some((v) => v.source === 'mock')).toBe(false)
    vi.stubEnv('NODE_ENV', 'development')
    expect(loadWith('1').venues.some((v) => v.source === 'mock')).toBe(true)
    vi.stubEnv('NODE_ENV', 'production')
    expect(loadWith('1').venues.some((v) => v.source === 'mock')).toBe(true)
  })

  it('lets the option override the environment, and does not serve the other pool from the cache', () => {
    const off = loadWith('', { includeFictional: true })
    expect(off.venues.some((v) => v.source === 'mock')).toBe(true)
    // The same switch state, asked the other way, without `fresh`: the cached pool must not come back.
    expect(loadPlanData({ includeFictional: false }).venues.some((v) => v.source === 'mock')).toBe(false)
    expect(loadPlanData({ includeFictional: true }).venues.some((v) => v.source === 'mock')).toBe(true)
  })

  it('is what the app serves by default, with no invented place in an answer', async () => {
    loadWith('')
    const server = createApp({ frontendOrigin: 'http://localhost:5173', http: createHttp({ stub: true }) }).listen(0)
    await once(server, 'listening')
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/api/converge`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ occasion: 'casual_meal', dateTime: '2026-10-10T19:00', topN: 10, members: [{ id: 'a', home: orchard }, { id: 'b', home: { lat: 1.3, lng: 103.85 } }] }),
      })
      const body = await res.json()
      expect(res.status).toBe(200)
      expect(body.results.length).toBeGreaterThan(0)
      for (const r of body.results) {
        expect(MOCK_IDS.has(r.venueId)).toBe(false)
        expect(r.venue.source).not.toBe('mock')
      }
    } finally {
      await new Promise((resolve) => server.close(resolve))
    }
  })
})

describe('rating and the score', () => {
  // The mock data without its dated history, with its venues replaced by the given ones.
  const withVenues = (venues) => ({ ...mock, venues })
  const base = mock.venues.find((v) => v.id === 'v03')
  const here = { lat: base.lat, lng: base.lng }
  const twin = (id, rating, ratingCount) => ({ ...base, id, name: id, rating, ratingCount })

  it('is not an overridable weight and not a default one', () => {
    expect('rating' in DEFAULT_WEIGHTS.converge).toBe(false)
    expect('rating' in DEFAULT_WEIGHTS.roam).toBe(false)
  })

  // Ticket #149 (agreed with the lead on 16 October 2026) replaced "rating never counts" with "a rating counts as far as its
  // reviews": weightedRating() mixes 20 reviews at 4.0 into every rating, and no rating (or no review count) is 4.0.
  // `rating` is still not a weight a caller can send, and still not a default one (the test above).
  it('ranks a well-reviewed venue above an unrated one above a one-review five-star, in Converge', () => {
    const data = withVenues([twin('lo', 5, 1), twin('none', null, 0), twin('hi', 4.6, 500)])
    const out = converge({ ...dinner, members: [member('ian'), member('faith')], centre: here, topN: 5 }, data)
    expect(out.results.map((r) => r.venueId)).toEqual(['hi', 'lo', 'none'])
    const rank = Object.fromEntries(out.results.map((r) => [r.venueId, r]))
    // 5.0 from one review is 4.05: barely above an unrated place (4.0); 4.6 from 500 reviews is 4.58.
    expect(rank.hi.score).toBeLessThan(rank.lo.score)
    expect(rank.lo.score).toBeLessThan(rank.none.score)
    expect(rank.hi.breakdown.rating.value).toBeCloseTo(100 - 4.5769 * 20, 1)
    expect(rank.none.breakdown.rating.value).toBe(20)
    expect(out.results[0].venueId).toBe('hi')
  })

  it('ranks a well-reviewed venue above a one-review five-star in Roam, and tags it only with enough reviews', () => {
    const data = withVenues([twin('few', 5, 1), twin('many', 4.6, 512)])
    const out = roam({ ...dinner, current: here, members: [member('faith')], topN: 5 }, data)
    expect(out.results.map((r) => r.venueId)).toEqual(['many', 'few'])
    expect(out.results[0].reasons).toContain('rated 4.6 from 512 reviews')
    expect(out.results[1].reasons.join(' ')).not.toMatch(/rated/)
  })

  // Twelve venues at one point, alike but for rating (100 reviews each). The shortlist keeps the four best-rated, so the
  // cut to the shortlist uses the weighted rating too.
  const spread = (ratingOf) => Array.from({ length: 12 }, (_, i) => ({
    ...base, id: `s${i}`, name: `s${i}`, lat: here.lat, lng: here.lng, rating: ratingOf(i), ratingCount: 100,
  }))

  it('keeps the best-rated venues in the Converge shortlist, whatever order they come in', () => {
    const run = (ratingOf) => converge({ ...dinner, members: [member('faith')], centre: here, radius: { minResults: 12 }, pruneTo: 4, topN: 4 }, withVenues(spread(ratingOf)))
    const ascending = run((i) => 0.5 + i * 0.4)
    const descending = run((i) => 4.9 - i * 0.4)
    expect(ascending.results.map((r) => r.venueId).sort()).toEqual(['s8', 's9', 's10', 's11'].sort())
    expect(descending.results.map((r) => r.venueId).sort()).toEqual(['s0', 's1', 's2', 's3'].sort())
  })

  it('keeps the best-rated venues in the Roam shortlist, whatever order they come in', () => {
    const run = (ratingOf) => roam({ ...dinner, current: here, members: [member('faith')], radius: { minResults: 12 }, pruneTo: 4, topN: 4 }, withVenues(spread(ratingOf)))
    const ascending = run((i) => 0.5 + i * 0.4)
    expect(ascending.results.map((r) => r.venueId)).toEqual(['s11', 's10', 's9', 's8'])
  })

  it('keeps rating and ratingCount on the venue, for display', () => {
    const out = roam({ ...dinner, current: here, members: [member('faith')], topN: 5 }, withVenues([twin('hi', 4.5, 120)]))
    expect(out.results[0].venue).toMatchObject({ rating: 4.5, ratingCount: 120 })
  })
})

describe('anti-repeat', () => {
  const history = [{ groupId: 'g1', venueId: 'v09', date: '2026-10-03' }]

  it('is 0 without a groupId, whoever the history is about', () => {
    expect(antiRepeatPenalty('v09', history, { today: '2026-10-04' })).toBe(0)
    expect(antiRepeatPenalty('v09', history, { today: '2026-10-04', groupId: null })).toBe(0)
    expect(antiRepeatPenalty('v09', history, { today: '2026-10-04', groupId: '' })).toBe(0)
    expect(antiRepeatPenalty('v09', history, { today: '2026-10-04', groupId: 'g1' })).toBe(100)
  })

  it('is 0 in a ranking with no groupId, and bites in one for the matching group', () => {
    const data = loadWith('1')
    const day = (input) => {
      // The date the sample visits are measured against: the day after the visit, in Singapore.
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date('2026-10-04T04:00:00Z'))
      const out = roam({ ...dinner, current: nearV09, members: [member('faith')], topN: 20, categories: ['eat', 'drink', 'activity'], ...input }, data)
      vi.useRealTimers()
      return out.results.find((r) => r.venueId === 'v09')
    }
    const visited = mock.visitHistory.find((h) => h.venueId === 'v09' && h.groupId === 'g1')
    expect(visited).toBeDefined()
    const without = day({})
    const matching = day({ groupId: 'g1' })
    const other = day({ groupId: 'someone-else' })
    expect(without?.breakdown.antiRepeat.value).toBe(0)
    expect(other?.breakdown.antiRepeat.value).toBe(0)
    expect(matching?.breakdown.antiRepeat.value).toBe(100)
  })

  it('uses the date of each request, not the date the server loaded its data', () => {
    const data = loadWith('1')
    const asked = (isoTime) => {
      vi.useFakeTimers({ toFake: ['Date'] })
      vi.setSystemTime(new Date(isoTime))
      const out = roam({ ...dinner, current: nearV09, members: [member('faith')], topN: 20, groupId: 'g1' }, data)
      vi.useRealTimers()
      return out.results.find((r) => r.venueId === 'v09')?.breakdown.antiRepeat.value
    }
    // The same loaded data, asked on the day after the visit and then well over 60 days later.
    expect(data._meta.today).toBeUndefined()
    expect(asked('2026-10-04T04:00:00Z')).toBe(100)
    expect(asked('2026-12-20T04:00:00Z')).toBe(0)
  })

  it('counts the day as Singapore does: 16:00 UTC is already tomorrow there', () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-17T15:59:00Z'))
    expect(singaporeToday()).toBe('2026-10-17')
    vi.setSystemTime(new Date('2026-10-17T16:00:00Z'))
    expect(singaporeToday()).toBe('2026-10-18')
  })

  it('still takes a fixed date from the request or from the data (a fixed clock for tests)', () => {
    const run = (input, data) => roam({ ...dinner, current: nearV09, members: [member('faith')], topN: 20, groupId: 'g1', ...input }, data)
    const factor = (out) => out.results.find((r) => r.venueId === 'v09')?.breakdown.antiRepeat.value
    expect(factor(run({ today: '2026-10-04' }, loadWith('1')))).toBe(100)
    expect(factor(run({ today: '2027-06-01' }, loadWith('1')))).toBe(0)
    expect(factor(run({}, mock))).toBe(100) // mock-data.json pins 2026-10-04 itself
  })
})
