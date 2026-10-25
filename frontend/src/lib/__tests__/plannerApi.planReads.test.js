// The frontend's calls to the Jio server's three reads for a confirmed plan (the rain swap, Replace's list, Roam): each one's method, path,
// query and body, and how a Roam answer from a session's server reaches the cards. The planner client's own adapter stands in for the server.
import { afterEach, describe, expect, it } from 'vitest'
import { api, getSessionStopChoices, getSessionStopSwap, lastWeather, roamSession } from '../plannerApi.js'

const ID = '3b1f5c2a-9d4e-4f6a-8b7c-1a2b3c4d5e6f'
const STOP = '5d0c7e41-2b3a-4c5d-9e8f-0a1b2c3d4e5f'

afterEach(() => {
  delete api.defaults.adapter
  lastWeather.value = null
})

// Answers every request with `data`, keeping what was sent. How to call: const sent = answer({ swap: null })
function answer(data) {
  const sent = []
  api.defaults.adapter = async (config) => {
    sent.push({ method: config.method, url: config.url, params: config.params, data: config.data ? JSON.parse(config.data) : undefined })
    return { data, status: 200, statusText: 'OK', headers: {}, config }
  }
  return sent
}

describe('the rain swap and Replace\'s list', () => {
  it('asks for the swap with a GET and nothing else', async () => {
    const sent = answer({ swap: { venueId: 'toa-payoh-library', name: 'Toa Payoh Public Library' } })
    expect(await getSessionStopSwap(ID, STOP)).toEqual({ swap: { venueId: 'toa-payoh-library', name: 'Toa Payoh Public Library' } })
    expect(sent).toEqual([{ method: 'get', url: `/api/sessions/${ID}/stops/${STOP}/swap`, params: undefined, data: undefined }])
  })

  it('asks for Replace\'s list with the kind alone (the server ranks for the stop\'s own time), and refuses an answer that is not a list', async () => {
    const sent = answer({ category: 'drink', options: [] })
    await getSessionStopChoices(ID, STOP, { category: 'drink', start: 900 })
    await getSessionStopChoices(ID, STOP)
    expect(sent.map((c) => [c.method, c.url, c.params])).toEqual([
      ['get', `/api/sessions/${ID}/stops/${STOP}/choices`, { category: 'drink' }],
      ['get', `/api/sessions/${ID}/stops/${STOP}/choices`, {}],
    ])
    answer({ nope: true })
    await expect(getSessionStopChoices(ID, STOP)).rejects.toThrow()
  })
})

describe('Roam in a session', () => {
  const result = { rank: 1, venueId: 'a', name: 'Ya Kun', venue: { id: 'a', name: 'Ya Kun', category: 'eat', avgPricePerPerson: 6, setting: 'indoor', rating: 4.2 }, score: 12, travelMinutes: 7, distanceKm: 0.4, walkMinutes: 6, reasons: [], warnings: [], swap: null, explanation: 'x', approximate: false }

  it('posts the point and the kinds, or an empty body for the meeting area', async () => {
    const sent = answer({ status: 'ok', results: [], notice: null, weather: null })
    await roamSession(ID, { current: { lat: 1.35, lng: 103.85, label: 'x' }, categories: ['eat'] })
    await roamSession(ID, {})
    expect(sent.map((c) => [c.method, c.url, c.data])).toEqual([
      ['post', `/api/sessions/${ID}/roam`, { current: { lat: 1.35, lng: 103.85 }, categories: ['eat'] }],
      ['post', `/api/sessions/${ID}/roam`, {}],
    ])
  })

  it('reads a place with the flag the server sends in place of the needs it does not name, who put it forward, and whether it is a stop', async () => {
    answer({ status: 'ok', results: [{ ...result, checkNeeds: true, isStop: true, proposedBy: 'u1' }, { ...result, venueId: 'b', isStop: false }], notice: null, weather: { source: 'live' } })
    const { places, empty } = await roamSession(ID, {})
    expect(empty).toBeNull()
    expect(places[0]).toMatchObject({ id: 'a', checkNeeds: true, isStop: true, proposedBy: 'u1', verify: [], dietUnknown: [], travelMinutes: 7, distanceM: 400 })
    expect(places[1]).toMatchObject({ id: 'b', isStop: false, proposedBy: null, verify: [], dietUnknown: [] })
    expect(places[1]).not.toHaveProperty('checkNeeds')
    expect(lastWeather.value).toEqual({ source: 'live' })
  })

  it('reads an empty answer as no places, keeping the answer', async () => {
    answer({ status: 'empty', reason: 'outside_max_radius', hints: { nearestKm: 4.2, widenToKm: 5 }, results: [], weather: null })
    expect(await roamSession(ID, {})).toMatchObject({ places: [], empty: { reason: 'outside_max_radius' } })
  })
})
