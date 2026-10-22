// The stand-in for the planner backend (components/dev/offlinePlanner.js): it answers in the backend's shape, only when the
// backend did not answer, and never hides an answer the backend gave.
import axios from 'axios'
import { describe, expect, it } from 'vitest'
import { AREAS } from '../../../lib/mock/places.js'
import { toCardVenue } from '../../../lib/plannerApi.js'
import { isOpenFor, notAnswered, standInConverge, standInMeetingArea, tripMinutes, useOfflinePlanner } from '../offlinePlanner.js'

const area = (id) => AREAS.find((a) => a.id === id)
const person = (id, areaId) => ({ id, name: id, start: { lat: area(areaId).lat, lng: area(areaId).lng } })

describe('opening hours', () => {
  it('is open when the visit fits inside a range', () => {
    expect(isOpenFor(['08:00-17:00'], 12 * 60, 90)).toBe(true)
    expect(isOpenFor(['08:00-17:00'], 16 * 60, 90)).toBe(false)
    expect(isOpenFor(['08:00-17:00'], 7 * 60, 60)).toBe(false)
  })
  it('lets a range run past midnight, and a place with no hours is always open', () => {
    expect(isOpenFor(['11:00-00:00'], 22 * 60, 120)).toBe(true)
    expect(isOpenFor(['00:00-24:00'], 3 * 60, 60)).toBe(true)
    expect(isOpenFor([], 3 * 60, 60)).toBe(true)
  })
})

describe('the meeting area', () => {
  it('is an area from the app\'s own list that keeps the longest trip short', () => {
    const answer = standInMeetingArea({ members: [person('ian', 'bugis'), person('darius', 'lavender')], method: 'station' })
    expect(AREAS.map((a) => a.id)).toContain(answer.area.id)
    expect(['bugis', 'lavender']).toContain(answer.area.id)
    expect(answer.method).toBe('station')
    expect(answer.approximate).toBe(true)
    expect(Object.keys(answer.travelByMember)).toEqual(['ian', 'darius'])
    expect(answer.worstMinutes).toBe(Math.max(...Object.values(answer.travelByMember)))
  })
  it('moves west when someone far to the west joins', () => {
    const east = standInMeetingArea({ members: [person('a', 'bugis'), person('b', 'tampines')] }).area
    const west = standInMeetingArea({ members: [person('a', 'bugis'), person('b', 'tampines'), person('c', 'boon-lay')] }).area
    expect(west.lng).toBeLessThan(east.lng)
  })
  it('puts a trip of 0 km at 8 minutes', () => expect(tripMinutes(0)).toBe(8))
})

describe('the meeting area with runners-up and named areas', () => {
  const members = [person('ian', 'toa-payoh'), person('darius', 'bishan'), person('faith', 'novena')]

  it('answers no candidates unless asked, and says its times are an estimate', () => {
    const answer = standInMeetingArea({ members })
    expect(answer.candidates).toBeUndefined()
    expect(answer.travel).toEqual({ source: 'estimate' })
    expect(answer.meanMinutes).toBeGreaterThan(0)
  })

  it('lists the chosen area, then the runners-up best first, then the named areas', () => {
    const answer = standInMeetingArea({ members, alternatives: 2, include: ['serangoon', 'kovan'] })
    const ids = answer.candidates.map((c) => c.area.id)
    expect(ids[0]).toBe(answer.area.id)
    expect(ids).toHaveLength(5)
    expect(ids.slice(3)).toEqual(['serangoon', 'kovan'])
    expect(answer.candidates.map((c) => c.source)).toEqual(['ranked', 'ranked', 'ranked', 'included', 'included'])
    // Runners-up are ordered by the longest trip, which never gets shorter down the list.
    const worst = answer.candidates.slice(0, 3).map((c) => c.worstMinutes)
    expect(worst).toEqual([...worst].sort((a, b) => a - b))
  })

  it('prices every candidate for every member: longest trip, average, each trip, approximate', () => {
    const answer = standInMeetingArea({ members, alternatives: 1, include: ['kovan'] })
    for (const c of answer.candidates) {
      expect(Object.keys(c.travelByMember)).toEqual(['ian', 'darius', 'faith'])
      expect(c.worstMinutes).toBe(Math.max(...Object.values(c.travelByMember)))
      const mean = Object.values(c.travelByMember).reduce((a, b) => a + b, 0) / 3
      expect(Math.abs(c.meanMinutes - mean)).toBeLessThan(0.1)
      expect(c.approximate).toBe(true)
      expect(c.area).toEqual({ id: c.area.id, name: area(c.area.id).name, lat: area(c.area.id).lat, lng: area(c.area.id).lng })
    }
    // The first candidate is the top-level answer.
    const [first] = answer.candidates
    expect(first).toMatchObject({ area: answer.area, worstMinutes: answer.worstMinutes, meanMinutes: answer.meanMinutes, travelByMember: answer.travelByMember })
  })

  it('lists a named area once, in its ranked place, and skips one it does not know', () => {
    const plain = standInMeetingArea({ members, alternatives: 2 })
    const runnerUp = plain.candidates[1].area.id
    const answer = standInMeetingArea({ members, alternatives: 2, include: [runnerUp, plain.area.id, 'atlantis'] })
    expect(answer.candidates.map((c) => c.area.id)).toEqual(plain.candidates.map((c) => c.area.id))
    expect(answer.candidates.every((c) => c.source === 'ranked')).toBe(true)
  })

  it('answers only the named area when asked for just that (the planner prices a chosen spot this way)', () => {
    const answer = standInMeetingArea({ members, include: ['bugis'] })
    expect(answer.candidates.map((c) => [c.area.id, c.source])).toEqual([[answer.area.id, 'ranked'], ...(answer.area.id === 'bugis' ? [] : [['bugis', 'included']])])
  })

  it('does not change the chosen area, and is the same every time', () => {
    const plain = standInMeetingArea({ members })
    const asked = standInMeetingArea({ members, alternatives: 3, include: ['bugis', 'kovan'] })
    const { candidates, ...rest } = asked
    expect(rest).toEqual(plain)
    expect(standInMeetingArea({ members, alternatives: 3, include: ['bugis', 'kovan'] })).toEqual(asked)
  })

  it('has runners-up by the longest trip even when the centre was asked for', () => {
    const answer = standInMeetingArea({ members, method: 'centroid', alternatives: 2 })
    expect(answer.method).toBe('centroid')
    expect(new Set(answer.candidates.map((c) => c.area.id)).size).toBe(3)
  })

  it('is read by the data layer as a list of spots, with "about" times', async () => {
    const { loadApi, tomorrow } = await import('../../../lib/__tests__/planFixture.js')
    const { DEMO_ACCOUNT } = await import('../demoAccount.js')
    const api = await loadApi()
    await api.signUp(DEMO_ACCOUNT)
    api.api.defaults.baseURL = 'http://127.0.0.1:1'
    const offline = useOfflinePlanner(api.api)
    const { id } = await api.createSession({ title: 'Lunch', date: tomorrow(), start: '12:00', end: '15:00' })
    await api.inviteFriends(id, ['darius', 'faith'])
    await api.startSession(id)
    for (const [who, areaId] of Object.entries({ ian: 'toa-payoh', darius: 'bishan', faith: 'novena' })) await api.setLocation(id, who, 'start', { areaId })
    await api.suggestSpot(id, 'faith', 'kovan', { here: true })
    const { list } = (await api.getSession(id)).spots
    expect(list.map((s) => s.by)).toEqual(['app', 'app', 'app', 'faith'])
    expect(list[3]).toMatchObject({ areaId: 'kovan', here: true })
    for (const spot of list) {
      expect(Object.keys(spot.times).sort()).toEqual(['darius', 'faith', 'ian'])
      expect(spot.approximate).toBe(true)
      expect(spot.worstMinutes).toBe(Math.max(...Object.values(spot.times)))
    }
    offline.restore()
  })
})

describe('the ranking', () => {
  const centre = { lat: area('bugis').lat, lng: area('bugis').lng }
  it('offers venues of the slot\'s category, nearest first, open for the slot', () => {
    const answer = standInConverge({ categories: ['eat'], centre, dateTime: '2026-10-17T12:00', durationMinutes: 90, topN: 5 })
    expect(answer.status).toBe('ok')
    expect(answer.results).toHaveLength(5)
    expect(answer.results.every((r) => r.venue.category === 'eat')).toBe(true)
    expect(answer.results.map((r) => r.score)).toEqual([...answer.results.map((r) => r.score)].sort((a, b) => a - b))
    expect(answer.results.map((r) => r.rank)).toEqual([1, 2, 3, 4, 5])
  })
  it('answers venues that toCardVenue turns into what the cards read', () => {
    const [first] = standInConverge({ categories: ['drink'], centre, dateTime: '2026-10-17T15:00', durationMinutes: 60 }).results
    const card = toCardVenue(first.venue)
    expect(typeof card.price).toBe('number')
    expect(card.indoor).toBe(first.venue.setting === 'indoor')
    expect(card.mrt).toBeTruthy()
    expect(card.hours[0]).toMatch(/^\d\d:\d\d-\d\d:\d\d$/)
  })
  it('returns the options the group already has in `current`, and keeps to a radius', () => {
    const base = { categories: ['eat'], centre, dateTime: '2026-10-17T12:00', durationMinutes: 90, topN: 3 }
    const ids = standInConverge({ ...base, topN: 10 }).results.map((r) => r.venueId)
    const answer = standInConverge({ ...base, currentOptionIds: [ids[7]] })
    expect(answer.current.map((r) => r.venueId)).toEqual([ids[7]])
    const near = standInConverge({ ...base, radiusMeters: 500 })
    for (const r of near.results) expect(r.walkMinutes).toBeLessThanOrEqual(7)
  })
})

describe('when it answers', () => {
  it('counts an error with no response, or a proxy 500 with no body, as no answer', () => {
    expect(notAnswered(new Error('connect ECONNREFUSED'))).toBe(true)
    expect(notAnswered({ response: { status: 500, data: '' } })).toBe(true)
    expect(notAnswered({ response: { status: 502, data: undefined } })).toBe(true)
  })
  it('counts anything the backend said itself as an answer', () => {
    expect(notAnswered({ response: { status: 400, data: { error: 'invalid_input' } } })).toBe(false)
    expect(notAnswered({ response: { status: 429, data: { error: 'rate_limited' } } })).toBe(false)
    expect(notAnswered({ response: { status: 500, data: { error: 'internal', message: 'x' } } })).toBe(false)
    expect(notAnswered({ response: { status: 404, data: '' } })).toBe(false)
  })

  it('stands in for a backend that is not there, passes a real error through, and restores the client', async () => {
    const client = axios.create({ baseURL: 'http://127.0.0.1:1', timeout: 2000 })
    const adapter = client.defaults.adapter
    const offline = useOfflinePlanner(client)
    const { data } = await client.post('/api/meeting-area', { members: [person('a', 'bugis'), person('b', 'lavender')], method: 'station' })
    expect(data.area.id).toBeTruthy()
    expect(offline.source).toBe('stand-in')
    // A request it does not stand in for fails as it would.
    await expect(client.get('/api/places/search')).rejects.toThrow()
    offline.restore()
    expect(client.defaults.adapter).toBe(adapter)
  })

  it('uses the real answer when the backend gives one', async () => {
    const client = axios.create({
      adapter: async (config) => ({ data: { area: { id: 'real' } }, status: 200, statusText: 'OK', headers: {}, config }),
    })
    const offline = useOfflinePlanner(client)
    const { data } = await client.post('/api/meeting-area', {})
    expect(data.area.id).toBe('real')
    expect(offline.source).toBe('backend')
    offline.restore()
  })

  it('does not hide the backend\'s own 400', async () => {
    const client = axios.create({
      adapter: async (config) => {
        const error = new Error('Request failed with status code 400')
        error.response = { status: 400, data: { error: 'invalid_input' }, config }
        throw error
      },
    })
    useOfflinePlanner(client)
    await expect(client.post('/api/converge', {})).rejects.toThrow(/400/)
  })
})
