// The frontend and the backend planner together: a whole session through api.js, against the real
// Express app started in this process. If the request or response shapes drift apart, this fails.
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../../../../backend/src/app.js'
import * as api from '../api.js'
import { HOST_ID } from '../mock/people.js'

let server

beforeAll(async () => {
  server = createApp({ frontendOrigin: 'http://localhost:5173' }).listen(0)
  await new Promise((resolve) => server.once('listening', resolve))
  api.api.defaults.baseURL = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => server?.close())

describe('a session planned by the backend', () => {
  let id
  const people = { [HOST_ID]: 'tampines', jonathan: 'jurong-east', faith: 'woodlands' }
  const plan = () => api.getPlan(id)

  it('finds the meeting area from everyone\'s start', async () => {
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', homeAreaId: 'tampines' })
    ;({ id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }))
    await api.inviteFriends(id, ['jonathan', 'faith'])
    await api.startSession(id)
    const [first, ...rest] = Object.entries(people)
    await api.setLocation(id, first[0], 'start', { areaId: first[1] })
    // While the planner works out the meeting area, the session says so (the map shows an animation).
    const saving = api.setLocation(id, rest[0][0], 'start', { areaId: rest[0][1] })
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await api.getSession(id)).findingMeeting).toBe(true)
    await saving
    expect((await api.getSession(id)).findingMeeting).toBe(false)
    for (const [person, areaId] of rest.slice(1)) await api.setLocation(id, person, 'start', { areaId })
    const session = await api.getSession(id)
    expect(session.area.id).toBe('bishan')
    expect(session.meeting.maxMinutes).toBeGreaterThan(0)
    expect(session.resultLine).toMatch(/^Fairest for 3 people: nobody travels more than \d+ minutes\.$/)
  })

  it('suggests three places per slot, best first, with what the cards show', async () => {
    await api.useMeetingArea(id)
    for (const person of Object.keys(people)) await api.setPreferences(id, person, { categories: ['eat', 'activity'], until: null })
    const { slots } = await plan()
    expect(slots.map((s) => s.category).sort()).toEqual(['activity', 'eat'])
    for (const slot of slots) {
      expect(slot.options).toHaveLength(3)
      expect(slot.options.map((o) => o.score)).toEqual([...slot.options.map((o) => o.score)].sort((a, b) => a - b))
      for (const o of slot.options) {
        expect(o.venue.category).toBe(slot.category)
        expect(typeof o.venue.price).toBe('number')
        expect(o.walk).toBeGreaterThanOrEqual(0)
        expect(['quiet', 'moderate', 'busy', 'unknown']).toContain(o.crowd)
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
      await expect(plan()).rejects.toThrow(/Cannot reach the Jio planner/)
    } finally {
      api.api.defaults.baseURL = baseURL
    }
  })
})
