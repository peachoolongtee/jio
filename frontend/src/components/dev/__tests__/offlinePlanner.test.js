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
