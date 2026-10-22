// The weather screens' data against the real backend, started in this process on its stub fixtures (no outside call): the
// planner's answers, as plannerApi.js and api.js turn them, for a confirmed plan, the check on the day, the indoor swap and
// Home's question. If the request or answer shapes drift apart from backend/src/routes/weather.js, this fails.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../../backend/src/app.js'
import { createHttp } from '../../../../backend/src/services/http.js'
import * as api from '../api.js'
import { HOST_ID } from '../mock/people.js'
import { stopMark, venueSetting } from '../weatherText.js'

let server
let id

beforeAll(async () => {
  server = createApp({ frontendOrigin: 'http://localhost:5173', allowSimulatedWeather: true, http: createHttp({ stub: true }) }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  api.api.defaults.baseURL = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => server?.close())

describe('a plan confirmed in the rain, and its day', () => {
  it('confirms a plan whose open-air stop has a rain warning, and keeps the weather of each stop', async () => {
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'tampines' })
    // Made the day before: a session cannot be made for a day that has passed. The clock is real again after, so the stops are in the
    // past for the forecast the stand-in backend answers (which is what these tests read).
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
    try {
      ;({ id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }))
    } finally {
      vi.useRealTimers()
    }
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setLocation(id, HOST_ID, 'start', { areaId: 'tampines' })
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await api.useMeetingArea(id)
    for (const person of [HOST_ID, 'jonathan']) await api.setPreferences(id, person, { categories: ['eat', 'activity'], until: null })
    await api.setConditions({ rain: true })
    const { slots, weather } = await api.getPlan(id)
    expect(weather).toMatchObject({ source: 'simulated', basis: 'simulated' })
    const activity = slots.find((s) => s.category === 'activity')
    const open = activity.options.find((o) => o.warnings.includes('rain') && o.swap)
    expect(open, 'an open-air activity with an indoor swap').toBeTruthy()
    expect(open.weather).toMatchObject({ state: 'showers', rainLikely: true, source: 'simulated' })
    const eat = slots.find((s) => s.category === 'eat')
    for (const person of [HOST_ID, 'jonathan']) {
      await api.vote(id, activity.id, person, open.id)
      await api.vote(id, eat.id, person, eat.options[0].id)
    }
    await api.confirmPlan(id)
    const itinerary = await api.getItinerary(id)
    expect(itinerary.weather).toMatchObject({ source: 'simulated' })
    const park = itinerary.stops.find((s) => s.slotId === activity.id)
    expect(park.venue.id).toBe(open.id)
    expect(park.weather).toMatchObject({ state: 'showers', rainLikely: true, source: 'simulated' })
    // The mark the itinerary draws: an open-air stop with rain likely.
    expect(stopMark(park.weather, venueSetting(park.venue))).toMatchObject({ label: 'Outdoor, showers', tone: 'warning' })
  })

  it('checks the stops on the day, with the real route, and the simulated rain reaches every stop', async () => {
    const check = await api.checkStopWeather(id)
    expect(check.weather).toMatchObject({ source: 'simulated', basis: 'simulated' })
    const itinerary = await api.getItinerary(id)
    expect(Object.keys(check.stops).sort()).toEqual(itinerary.stops.map((s) => s.slotId).sort())
    for (const stop of itinerary.stops) expect(check.stops[stop.slotId]).toMatchObject({ state: 'showers', rainLikely: true, source: 'simulated' })
  })

  it('checks the same stops with the rain switch off: a live forecast, from the fixtures, with its time', async () => {
    await api.setConditions({ rain: false })
    const check = await api.checkStopWeather(id)
    expect(check.weather).toMatchObject({ source: 'live', basis: 'area' })
    expect(check.weather.issuedAt).toMatch(/\+08:00$/)
    for (const w of Object.values(check.stops)) {
      expect(w).toMatchObject({ source: 'live', basis: 'area', rainLikely: false })
      expect(['dry', 'cloudy']).toContain(w.state)
    }
  })

  it('finds the indoor place for the open-air stop, and swaps it once', async () => {
    await api.setConditions({ rain: true })
    const before = await api.getItinerary(id)
    const park = before.stops.find((s) => s.category === 'activity')
    const swap = await api.findRainSwap(id, park.slotId)
    expect(swap).toMatchObject({ id: expect.any(String), name: expect.any(String) })
    expect(swap.id).not.toBe(park.venue.id)
    await api.swapOption(id, park.slotId, park.venue.id, swap.id)
    const after = (await api.getItinerary(id)).stops.find((s) => s.slotId === park.slotId)
    expect(after.venue.id).toBe(swap.id)
    expect(venueSetting(after.venue).indoor).toBe(true)
    // Rain over the indoor place is "Indoor", in the neutral tone.
    expect(stopMark(after.weather, venueSetting(after.venue))).toMatchObject({ label: 'Indoor', tone: 'neutral' })
    // The check still says rain is likely there, but the stop is no longer exposed, so it earns no warning.
    const check = await api.checkStopWeather(id)
    expect(check.stops[park.slotId].rainLikely).toBe(true)
    expect(venueSetting(after.venue).exposed).toBe(false)
  })

  it('answers Home\'s question for a place and a time', async () => {
    const answer = await api.weatherAt([{ id: 'bishan', point: { lat: 1.3508, lng: 103.8485 }, start: '2026-10-10T15:00' }])
    expect(answer.weather).toMatchObject({ source: 'simulated' })
    expect(answer.stops.bishan).toMatchObject({ rainLikely: true })
    await api.setConditions({ rain: false })
    const live = await api.weatherAt([{ id: 'bishan', point: { lat: 1.3508, lng: 103.8485 }, start: '2026-10-10T15:00' }])
    expect(live.weather).toMatchObject({ source: 'live' })
    expect(live.stops.bishan.rainLikely).toBe(false)
  })

  it('reads a stop far ahead as outside the forecast window', async () => {
    const far = await api.weatherAt([{ id: 'bishan', point: { lat: 1.3508, lng: 103.8485 }, start: '2099-01-01T15:00' }])
    expect(far.weather).toMatchObject({ source: 'none', reason: 'outside_window' })
    expect(far.stops.bishan).toMatchObject({ state: 'unknown', source: 'none', reason: 'outside_window', rainLikely: false })
  })
})
