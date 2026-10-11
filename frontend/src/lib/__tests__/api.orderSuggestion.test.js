// The suggested order through api.js: what suggestOrder asks and returns, when confirmPlan applies a suggestion and
// when it ignores it, what the itinerary then says, and that moving or deleting a stop by hand clears it. The
// backend planner and its arrange route are stubbed.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, loadApi, stubPlanner } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), arrangeItinerary: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

// The backend's answer for a request: the stops in the reverse order, one after the other, a meal never before its time.
function reversed(request, extra = {}) {
  const order = request.stops.map((s) => s.id).reverse()
  let freeFrom = request.startAt
  const stops = order.map((id) => {
    const s = request.stops.find((x) => x.id === id)
    const start = Math.max(freeFrom, s.category === 'eat' ? s.start : 0)
    freeFrom = start + s.duration + 10
    return { id, start, end: start + s.duration }
  })
  return { status: 'ok', order, stops, reason: 'Shops first while you are fresh.', source: 'ai', restarted: false, others: 3, ...extra }
}

const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }
// Saved sessions in Voting, by the categories voted for. Built once each, because the planner call waits about a second.
const built = new Map()
async function votingSave(categories) {
  const name = categories.join()
  if (!built.has(name)) {
    const api = await loadApi()
    await api.signUp(PROFILE)
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await api.useMeetingArea(id)
    for (const person of ['ian', 'jonathan']) await api.setPreferences(id, person, { categories, until: null })
    const { slots } = await api.getPlan(id)
    for (const slot of slots.filter((s) => categories.includes(s.category))) {
      for (const person of ['ian', 'jonathan']) await api.vote(id, slot.id, person, slot.options[0].id)
    }
    built.set(name, { text: api.storage.store[STORAGE_KEY], id })
  }
  const { text, id } = built.get(name)
  return { api: await loadApi({ data: { [STORAGE_KEY]: text } }), id }
}
const THREE = ['eat', 'activity', 'shop']
// Building a voting session waits for the planner's loading bar, about a second and a half.
vi.setConfig({ testTimeout: 30000 })

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => {
  stubPlanner(planner)
  planner.arrangeItinerary.mockReset().mockImplementation(async (request) => reversed(request))
})
afterEach(() => vi.unstubAllGlobals())

const itineraryOrder = async (api, id) => (await api.getItinerary(id)).stops.map((s) => s.category)
// The saved plan, as text in storage.
const savedPlan = (api, id) => JSON.parse(api.storage.store[STORAGE_KEY]).sessions.find((s) => s.id === id).plan

describe('suggestOrder', () => {
  it('asks the backend for the voted stops, with a meal anchored to its time, and returns the order with names and times', async () => {
    const { api, id } = await votingSave(THREE)
    const suggestion = await api.suggestOrder(id)
    expect(planner.arrangeItinerary).toHaveBeenCalledTimes(1)
    const request = planner.arrangeItinerary.mock.calls[0][0]
    expect(request.includeCurrent).toBe(true)
    expect(request.stops.map((s) => s.category)).toEqual(['eat', 'activity', 'shop'])
    const eat = request.stops.find((s) => s.category === 'eat')
    expect(Number.isFinite(eat.start)).toBe(true)
    expect(request.endAt).toBe(20 * 60)
    expect(suggestion.order).toEqual(['shop', 'activity', 'eat'].map((c) => request.stops.find((s) => s.category === c).id))
    expect(suggestion.stops.map((s) => s.category)).toEqual(['shop', 'activity', 'eat'])
    for (const s of suggestion.stops) expect(s).toMatchObject({ name: expect.any(String), venueId: expect.any(String), duration: expect.any(Number), start: expect.any(Number) })
    expect(suggestion).toMatchObject({ reason: 'Shops first while you are fresh.', source: 'ai' })
  })

  it('makes the sentence safe on the way in and names an unknown source "rules"', async () => {
    const { api, id } = await votingSave(THREE)
    planner.arrangeItinerary.mockImplementation(async (request) => reversed(request, { reason: `Line one.\n\u0007${'x'.repeat(400)}`, source: 'gpt' }))
    const suggestion = await api.suggestOrder(id)
    expect(suggestion.reason).toHaveLength(200)
    expect(suggestion.reason).not.toMatch(/[\u0000-\u001f]/)
    expect(suggestion.reason.startsWith('Line one. xxx')).toBe(true)
    expect(suggestion.source).toBe('rules')
  })

  it('answers null when no other order works, when the failure comes from the backend, and does not swallow it', async () => {
    const { api, id } = await votingSave(THREE)
    planner.arrangeItinerary.mockResolvedValue({ status: 'no_other_order', message: 'No other order works.', blockers: [] })
    expect(await api.suggestOrder(id)).toBeNull()
    planner.arrangeItinerary.mockRejectedValue(new Error('timeout of 10000ms exceeded'))
    await expect(api.suggestOrder(id)).rejects.toThrow('timeout')
  })

  it('does not ask when fewer than two stops can move, or when the session is not in Voting', async () => {
    const { api, id } = await votingSave(['eat', 'activity'])
    expect(await api.suggestOrder(id)).toBeNull()
    const three = await votingSave(THREE)
    await three.api.confirmPlan(three.id)
    expect(await three.api.suggestOrder(three.id)).toBeNull()
    expect(planner.arrangeItinerary).not.toHaveBeenCalled()
  })
})

describe('confirming a suggestion', () => {
  it('applies the suggested order and keeps its times as the earliest start of each stop', async () => {
    const { api, id } = await votingSave(THREE)
    const suggestion = await api.suggestOrder(id)
    await api.confirmPlan(id, suggestion)
    const itinerary = await api.getItinerary(id)
    expect(itinerary.stops.map((s) => s.category)).toEqual(['shop', 'activity', 'eat'])
    expect(itinerary.aiNote).toEqual({ reason: 'Shops first while you are fresh.', source: 'ai' })
    // No stop starts before the time the backend gave it.
    suggestion.stops.forEach((s, i) => expect(itinerary.stops[i].start).toBeGreaterThanOrEqual(s.start))
    expect(savedPlan(api, id).stops.map((s) => s.notBefore)).toEqual(suggestion.stops.map((s) => s.start))
  })

  it('accepts the plain copy of a suggestion the screen holds as a reactive object', async () => {
    const { api, id } = await votingSave(THREE)
    const suggestion = await api.suggestOrder(id)
    await api.confirmPlan(id, JSON.parse(JSON.stringify(suggestion)))
    expect(await itineraryOrder(api, id)).toEqual(['shop', 'activity', 'eat'])
  })

  it('keeps the voted order, with no note and no earliest times, when no suggestion is passed', async () => {
    const { api, id } = await votingSave(THREE)
    await api.confirmPlan(id, null)
    expect(await itineraryOrder(api, id)).toEqual(['eat', 'activity', 'shop'])
    expect((await api.getItinerary(id)).aiNote).toBeNull()
    for (const stop of savedPlan(api, id).stops) expect(stop).not.toHaveProperty('notBefore')
    expect(savedPlan(api, id)).not.toHaveProperty('aiNote')
  })

  describe('ignores a suggestion that does not fit the stops being confirmed', () => {
    const cases = {
      'another place for a stop': (s) => ({ ...s, stops: s.stops.map((x, i) => (i === 0 ? { ...x, venueId: 'somewhere-else' } : x)) }),
      'a stop left out': (s) => ({ ...s, order: s.order.slice(1), stops: s.stops.slice(1) }),
      'a stop twice': (s) => ({ ...s, order: [s.order[0], s.order[0], s.order[2]], stops: [s.stops[0], s.stops[0], s.stops[2]] }),
      'times of another order': (s) => ({ ...s, stops: [...s.stops].reverse() }),
      'a different length of stay': (s) => ({ ...s, stops: s.stops.map((x, i) => (i === 1 ? { ...x, duration: x.duration + 15 } : x)) }),
      'stops that overlap': (s) => ({ ...s, stops: s.stops.map((x, i) => (i === 1 ? { ...x, start: s.stops[0].start } : x)) }),
      'a time that is not a number': (s) => ({ ...s, stops: s.stops.map((x, i) => (i === 2 ? { ...x, start: 'soon' } : x)) }),
    }
    it.each(Object.keys(cases))('%s', async (name) => {
      const { api, id } = await votingSave(THREE)
      const suggestion = cases[name](await api.suggestOrder(id))
      await api.confirmPlan(id, suggestion)
      expect(await itineraryOrder(api, id)).toEqual(['eat', 'activity', 'shop'])
      expect((await api.getItinerary(id)).aiNote).toBeNull()
      for (const stop of savedPlan(api, id).stops) expect(stop).not.toHaveProperty('notBefore')
    })
  })

  it('ignores a meal that is moved earlier than its time from voting', async () => {
    const { api, id } = await votingSave(THREE)
    const suggestion = await api.suggestOrder(id)
    const mealTime = planner.arrangeItinerary.mock.calls[0][0].stops.find((s) => s.category === 'eat').start
    const meal = { ...suggestion.stops.find((s) => s.category === 'eat'), start: mealTime - 30 }
    const others = suggestion.stops.filter((s) => s.category !== 'eat').map((s, i) => ({ ...s, start: mealTime + 600 + i * 300 }))
    const early = { ...suggestion, order: [meal, ...others].map((s) => s.slotId), stops: [meal, ...others] }
    await api.confirmPlan(id, early)
    expect((await api.getItinerary(id)).aiNote).toBeNull()
    // The same answer with the meal on time is applied, so the early time was the only thing wrong with it.
    const onTime = { ...early, stops: [{ ...meal, start: mealTime }, ...others] }
    const again = await votingSave(THREE)
    await again.api.confirmPlan(again.id, onTime)
    expect((await again.api.getItinerary(again.id)).aiNote).not.toBeNull()
  })

  it('cuts and cleans a sentence that was stored too long', async () => {
    const { api, id } = await votingSave(THREE)
    const suggestion = await api.suggestOrder(id)
    await api.confirmPlan(id, { ...suggestion, reason: `<img src=x onerror=alert(1)>\n${'y'.repeat(500)}`, source: 'ai' })
    const { aiNote } = await api.getItinerary(id)
    expect(aiNote.reason).toHaveLength(200)
    expect(aiNote.reason.startsWith('<img src=x onerror=alert(1)> yyy')).toBe(true)
    expect(aiNote.reason).not.toMatch(/[\u0000-\u001f]/)
  })
})

describe('moving or deleting a stop by hand', () => {
  async function confirmedWithSuggestion() {
    const { api, id } = await votingSave(THREE)
    await api.confirmPlan(id, await api.suggestOrder(id))
    expect((await api.getItinerary(id)).aiNote).not.toBeNull()
    expect(savedPlan(api, id).stops.every((s) => s.notBefore != null)).toBe(true)
    return { api, id }
  }

  it('clears the note and every earliest time when a stop is moved', async () => {
    const { api, id } = await confirmedWithSuggestion()
    await api.reorderStops(id, 0, 2)
    expect((await api.getItinerary(id)).aiNote).toBeNull()
    for (const stop of savedPlan(api, id).stops) expect(stop).not.toHaveProperty('notBefore')
    expect(savedPlan(api, id).aiNote).toBeNull()
  })

  it('clears the note and every earliest time when a stop is deleted', async () => {
    const { api, id } = await confirmedWithSuggestion()
    await api.deleteStop(id, 1)
    expect((await api.getItinerary(id)).aiNote).toBeNull()
    for (const stop of savedPlan(api, id).stops) expect(stop).not.toHaveProperty('notBefore')
  })

  it('keeps the note when a stop is moved to where it already is', async () => {
    const { api, id } = await confirmedWithSuggestion()
    await api.reorderStops(id, 1, 1)
    expect((await api.getItinerary(id)).aiNote).not.toBeNull()
  })
})

describe('a save from before the suggested order existed', () => {
  it('loads and gives an itinerary without a note, whether or not the keys are there', async () => {
    const { api, id } = await votingSave(THREE)
    await api.confirmPlan(id, null)
    const saved = JSON.parse(api.storage.store[STORAGE_KEY])
    const plan = saved.sessions.find((s) => s.id === id).plan
    delete plan.aiNote
    for (const stop of plan.stops) delete stop.notBefore
    const old = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
    const itinerary = await old.getItinerary(id)
    expect(itinerary.aiNote).toBeNull()
    expect(itinerary.stops.map((s) => s.category)).toEqual(['eat', 'activity', 'shop'])
    expect(itinerary.stops.every((s) => Number.isFinite(s.start) && s.end > s.start)).toBe(true)
    // And it can still be edited.
    await old.reorderStops(id, 0, 1)
    expect((await old.getItinerary(id)).stops.map((s) => s.category)).toEqual(['activity', 'eat', 'shop'])
  })

  it('reads a hand-edited note as plain, cut text', async () => {
    const { api, id } = await votingSave(THREE)
    await api.confirmPlan(id, await api.suggestOrder(id))
    const saved = JSON.parse(api.storage.store[STORAGE_KEY])
    saved.sessions.find((s) => s.id === id).plan.aiNote = { reason: `a\nb${'z'.repeat(300)}`, source: 'robot' }
    const edited = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
    const { aiNote } = await edited.getItinerary(id)
    expect(aiNote.reason).toHaveLength(200)
    expect(aiNote.reason.startsWith('a bzzz')).toBe(true)
    expect(aiNote.source).toBe('rules')
    saved.sessions.find((s) => s.id === id).plan.aiNote = { reason: 42 }
    const odd = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
    expect((await odd.getItinerary(id)).aiNote).toEqual({ reason: '', source: 'rules' })
  })
})
