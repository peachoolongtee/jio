// The frontend and the backend planner together: a whole session through api.js, against the real
// Express app started in this process. If the request or response shapes drift apart, this fails.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createApp } from '../../../../backend/src/app.js'
import { createHttp } from '../../../../backend/src/services/http.js'
import * as api from '../api.js'
import { HOST_ID } from '../mock/people.js'

let server

beforeAll(async () => {
  // The sessions here are dated Saturday 10 October 2026. A read after a session's end time finishes it (lib/api.js
  // settleOutings), so the clock is held the day before, as in the other data-layer tests. Only Date is faked.
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  // The rain test below fakes the forecast, so the server has to allow that.
  // Stub HTTP: the weather and any routing are answered from the backend's fixtures, so these tests never
  // wait on data.gov.sg or OneMap. Without it the first ranking fetched the live forecast and ran close to the
  // 5 second limit.
  server = createApp({ frontendOrigin: 'http://localhost:5173', allowSimulatedWeather: true, http: createHttp({ stub: true }) }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  api.api.defaults.baseURL = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => {
  server?.close()
  vi.useRealTimers()
})

describe('a session planned by the backend', () => {
  let id
  const people = { [HOST_ID]: 'tampines', jonathan: 'jurong-east', faith: 'woodlands' }
  const plan = () => api.getPlan(id)

  it('finds the meeting area from everyone\'s start', async () => {
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'tampines' })
    ;({ id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }))
    await api.inviteFriends(id, ['jonathan', 'faith'])
    await api.startSession(id)
    const entries = Object.entries(people)
    for (const [person, areaId] of entries.slice(0, -1)) await api.setLocation(id, person, 'start', { areaId })
    // The meeting area waits until everyone has shared where they start.
    expect((await api.getSession(id)).meeting).toBeFalsy()
    // While the planner works out the meeting area, the session says so (the map shows an animation).
    const [lastPerson, lastArea] = entries.at(-1)
    const saving = api.setLocation(id, lastPerson, 'start', { areaId: lastArea })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await api.getSession(id)).findingMeeting).toBe(true)
    await saving
    expect((await api.getSession(id)).findingMeeting).toBe(false)
    const session = await api.getSession(id)
    expect(session.area.id).toBe('bishan')
    expect(session.meeting.maxMinutes).toBeGreaterThan(0)
    expect(session.resultLine).toMatch(/^Fairest for 3 people: nobody travels more than about \d+ minutes\.$/)
  })

  it('suggests three places in every category, best first, with what the cards show', async () => {
    await api.useMeetingArea(id)
    for (const person of Object.keys(people)) await api.setPreferences(id, person, { categories: ['eat', 'activity'], until: null })
    const { slots } = await plan()
    expect(slots.map((s) => s.category).sort()).toEqual(['activity', 'drink', 'eat', 'shop'])
    for (const slot of slots) {
      expect(slot.options).toHaveLength(3)
      expect(slot.options.map((o) => o.score)).toEqual([...slot.options.map((o) => o.score)].sort((a, b) => a - b))
      for (const o of slot.options) {
        expect(o.venue.category).toBe(slot.category)
        expect(typeof o.venue.price).toBe('number')
        expect(o.walk).toBeGreaterThanOrEqual(0)
        expect(o).not.toHaveProperty('crowd')
        expect(o.reasons.length).toBeLessThanOrEqual(2)
      }
    }
  })

  it('keeps suggestions inside the radius the group picks, and widens again on Auto', async () => {
    const km = (a, b) => Math.hypot((a.lat - b.lat) * 111.32, (a.lng - b.lng) * 111.32 * Math.cos((a.lat * Math.PI) / 180))
    await api.setRadius(id, 250)
    const near = await plan()
    expect(near.radius).toBe(250)
    for (const slot of near.slots) {
      for (const o of slot.options) expect(km(near.area, o.venue)).toBeLessThanOrEqual(0.25)
      if (!slot.options.length) expect(slot.empty?.reason).toBeTruthy()
    }
    await api.setRadius(id, null)
    const auto = await plan()
    expect(auto.radius).toBeNull()
    for (const slot of auto.slots) expect(slot.options).toHaveLength(3)
    await expect(api.setRadius(id, 50)).rejects.toThrow(/100 m to 3 km/)
  })

  it('adds a place found by search, even one past the suggestions, and keeps showing it', async () => {
    const eat = (await plan()).slots.find((s) => s.category === 'eat')
    const results = await api.searchVenuesForSlot(id, eat.id, 'food stalls')
    const pick = results.filter((r) => !r.unfit && !r.added).at(-1)
    expect(pick).toBeTruthy()
    await api.addOption(id, eat.id, pick.id)
    const after = (await plan()).slots.find((s) => s.id === eat.id)
    expect(after.options.map((o) => o.id)).toContain(pick.id)
    expect(after.options.find((o) => o.id === pick.id).venue.name).toBe(pick.name)
  })

  it('lists a place once even when it is added twice at the same moment', async () => {
    const eat = (await plan()).slots.find((s) => s.category === 'eat')
    const results = await api.searchVenuesForSlot(id, eat.id, 'food stalls')
    const pick = results.filter((r) => !r.unfit && !r.added).at(-2)
    expect(pick).toBeTruthy()
    await Promise.all([api.addOption(id, eat.id, pick.id), api.addOption(id, eat.id, pick.id)])
    const after = (await plan()).slots.find((s) => s.id === eat.id)
    expect(after.options.filter((o) => o.id === pick.id)).toHaveLength(1)
  })

  it('refuses a place that does not fit the slot', async () => {
    const eat = (await plan()).slots.find((s) => s.category === 'eat')
    const [far] = await api.searchVenuesForSlot(id, eat.id, 'maxwell food centre')
    expect(far.unfit).toBe('far')
    await expect(api.addOption(id, eat.id, far.id)).rejects.toThrow(/does not fit this slot/)
  })

  it('warns about rain on outdoor options and swaps one for an indoor place', async () => {
    await api.setConditions({ rain: true })
    const { slots } = await plan()
    const slot = slots.find((s) => s.options.some((o) => o.warnings.includes('rain') && o.swap))
    expect(slot, 'an outdoor option with an indoor swap').toBeTruthy()
    const outdoor = slot.options.find((o) => o.warnings.includes('rain') && o.swap)
    await api.swapOption(id, slot.id, outdoor.id, outdoor.swap.id)
    const after = (await plan()).slots.find((s) => s.id === slot.id)
    expect(after.options.map((o) => o.id)).toContain(outdoor.swap.id)
    expect(after.options.map((o) => o.id)).not.toContain(outdoor.id)
    await api.setConditions({ rain: false })
  })

  it('plans only the categories people voted in, and a second tap takes a vote back', async () => {
    const [person] = Object.keys(people)
    const eat = (await plan()).slots.find((s) => s.category === 'eat')
    await api.vote(id, eat.id, person, eat.options[0].id)
    expect((await plan()).planned.map((s) => s.category)).toEqual(['eat'])
    await api.vote(id, eat.id, person, eat.options[0].id)
    expect((await plan()).planned).toEqual([])
  })

  it('confirms the voted places into an itinerary', async () => {
    const { slots } = await plan()
    for (const slot of slots) for (const person of Object.keys(people)) await api.vote(id, slot.id, person, slot.options.at(-1).id)
    await api.confirmPlan(id)
    const itinerary = await api.getItinerary(id)
    expect(itinerary.stops).toHaveLength(slots.length)
    for (const stop of itinerary.stops) {
      const slot = slots.find((s) => s.id === stop.slotId)
      expect(stop.venue.id).toBe(slot.options.at(-1).id)
      expect(stop.venue.name).toBeTruthy()
    }
  })

  it('says how to fix it when the backend is not running, and saves nothing half-way', async () => {
    const baseURL = api.api.defaults.baseURL
    api.api.defaults.baseURL = 'http://127.0.0.1:9'
    try {
      const before = await api.getSession(id)
      await expect(api.setLocation(id, HOST_ID, 'end', { areaId: 'bugis' })).rejects.toThrow(/Cannot reach the Jio planner/)
      await expect(api.replan(id)).rejects.toThrow(/Cannot reach the Jio planner/)
      const after = await api.getSession(id)
      expect(after.locations).toEqual(before.locations)
      expect(after.status).toBe(before.status)
      expect(after.plan).toEqual(before.plan)
      // A confirmed session's plan is read from storage, so it still answers.
      await expect(plan()).resolves.toBeTruthy()
    } finally {
      api.api.defaults.baseURL = baseURL
    }
  })
})

describe('meeting spots planned by the backend', () => {
  it('lists the app\'s three, prices a member\'s suggestion the same way, and settles on the approved one', async () => {
    if (!(await api.getUser())) await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'tampines' })
    const { id } = await api.createSession({ title: 'Spots', date: '2026-10-11', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan', 'faith'])
    await api.startSession(id)
    await api.setLocation(id, HOST_ID, 'start', { areaId: 'tampines' })
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    // Faith has not shared a start, so the meeting area waits, but the spots are listed from two starts on.
    const listed = await api.getSession(id)
    expect(listed.meeting).toBeNull()
    expect(listed.spots.list).toHaveLength(3)
    expect(new Set(listed.spots.list.map((s) => s.areaId)).size).toBe(3)
    for (const spot of listed.spots.list) {
      expect(spot.by).toBe('app')
      expect(Object.keys(spot.times).sort()).toEqual([HOST_ID, 'jonathan'].sort())
      expect(spot.worstMinutes).toBe(Math.max(...Object.values(spot.times)))
    }
    // The fairest comes first: nothing after it has a shorter longest trip.
    expect(listed.spots.list.every((s) => s.worstMinutes >= listed.spots.list[0].worstMinutes)).toBe(true)
    // A member's suggestion is priced by the same request, for the same people.
    const pick = ['kovan', 'pasir-ris', 'woodlands'].find((a) => !listed.spots.list.some((s) => s.areaId === a))
    const suggested = await api.suggestSpot(id, 'faith', pick)
    const spot = suggested.spots.list.find((s) => s.areaId === pick)
    expect(spot).toMatchObject({ by: 'faith', here: false })
    expect(Object.keys(spot.times).sort()).toEqual([HOST_ID, 'jonathan'].sort())
    expect(spot.worstMinutes).toBe(Math.max(...Object.values(spot.times)))
    expect(suggested.spots.list).toHaveLength(4)
    // The approved spot is the one offered, and the host settles on it.
    const approved = await api.approveSpot(id, 'jonathan', pick, true)
    expect(approved.spots.preselectedAreaId).toBe(pick)
    const settled = await api.confirmSpot(id, pick)
    expect(settled).toMatchObject({ status: 'voting', area: { id: pick } })
    expect(settled.meeting).toMatchObject({ areaId: pick, method: 'voted', count: 2 })
    expect((await api.getPlan(id)).slots.some((s) => s.options.length > 0)).toBe(true)
  })
})
