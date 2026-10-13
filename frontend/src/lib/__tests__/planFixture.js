// Shared set-up for the data-layer tests: a fake local storage, a stand-in for the backend planner, and a
// session that is already confirmed. Not a test file itself (the name does not end in .test.js).
//
// A test file mocks the planner module once, then uses these:
//   const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
//   vi.mock('../plannerApi.js', () => planner)
//   beforeEach(() => stubPlanner(planner))
import { vi } from 'vitest'
import { AREAS } from '../mock/places.js'
import { VENUES } from '../mock/venues.js'

export const STORAGE_KEY = 'jio-demo-v1'

// A local storage that holds a map. `limit` is the most characters the demo's own save may take: a bigger write
// throws the way a full browser storage does. Small writes (the probe) always work.
// How to call: const storage = fakeStorage({ limit: 50_000 }); vi.stubGlobal('localStorage', storage)
export function fakeStorage({ data = {}, limit = Infinity } = {}) {
  const store = { ...data }
  return {
    store,
    limit,
    // Every successful write of the demo's own save, so a test can count how many saves a call made.
    writes: 0,
    getItem: (key) => (key in store ? store[key] : null),
    setItem(key, value) {
      if (key === STORAGE_KEY && String(value).length > this.limit) {
        throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
      }
      store[key] = String(value)
      if (key === STORAGE_KEY) this.writes += 1
    },
    removeItem: (key) => {
      delete store[key]
    },
  }
}

// Fresh copy of api.js on top of the given storage, as if the page had just loaded.
// How to call: const api = await loadApi({ data: { [STORAGE_KEY]: saved }, limit: 100_000 })
export async function loadApi(options = {}) {
  vi.resetModules()
  const storage = fakeStorage(options)
  vi.stubGlobal('localStorage', storage)
  const api = await import('../api.js')
  return { ...api, storage }
}

// The backend planner, answered from the mock venues: the meeting area is Bishan, and each slot gets the first
// three venues of its category. Calls are counted by the vi.fn()s.
export function stubPlanner(planner) {
  planner.meetingArea.mockReset().mockImplementation(async ({ members }) => ({
    area: AREAS.find((a) => a.id === 'bishan'),
    method: 'station',
    travelByMember: Object.fromEntries(members.map((m) => [m.id, 20])),
    approximate: false,
  }))
  const option = (venue, i) => ({ venue, rank: i + 1, score: i, walk: 5 + i, crowd: 'quiet', reasons: ['Close to everyone'], warnings: [], swap: null, explanation: '', dietUnknown: [], verify: [], approximate: false })
  planner.rankSlot.mockReset().mockImplementation(async ({ slot, currentOptionIds = [] }) => {
    const fits = VENUES.filter((v) => v.category === slot.category)
    const options = fits.slice(0, 3).map(option)
    const current = fits.filter((v) => currentOptionIds.includes(v.id)).map(option)
    return { options, current, widened: false, few: null, empty: null }
  })
  planner.searchSlot.mockReset().mockResolvedValue([])
}

// A save in which the account is signed up and one session is confirmed with a stop for Eat and one for Activity.
// Built once per test file by running the real flow; the planner must be stubbed already. Returns { text, id },
// the stored text and the session's id.
let built = null
export async function confirmedSave() {
  if (built) return built
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  await api.useMeetingArea(id)
  for (const person of ['ian', 'jonathan']) await api.setPreferences(id, person, { categories: ['eat', 'activity'], until: null })
  const { slots } = await api.getPlan(id)
  // Every category is offered at once; voting only in Eat and Activity makes those the plan's two stops.
  for (const slot of slots.filter((s) => ['eat', 'activity'].includes(s.category))) {
    for (const person of ['ian', 'jonathan']) await api.vote(id, slot.id, person, slot.options[0].id)
  }
  await api.confirmPlan(id)
  built = { text: api.storage.store[STORAGE_KEY], id }
  return built
}

// The backend's answer to a request for an order: the stops in the reverse order, one after the other, a meal never before
// its time. `hold` is minutes the Eat stop waits after the stop before it (its table is booked for later), so it starts
// later than the travel alone would have it.
// How to call: planner.arrangeItinerary.mockImplementation(async (request) => reversedOrder(request, 60))
export function reversedOrder(request, hold = 0) {
  const order = request.stops.map((s) => s.id).reverse()
  let freeFrom = request.startAt
  const stops = order.map((id) => {
    const s = request.stops.find((x) => x.id === id)
    const start = Math.max(freeFrom + (s.category === 'eat' ? hold : 0), s.category === 'eat' ? s.start : 0)
    freeFrom = start + s.duration + 10
    return { id, start, end: start + s.duration }
  })
  return { status: 'ok', order, stops, reason: 'Shops first while you are fresh.', source: 'ai', restarted: false, others: 3 }
}

// A save in which three people voted for Eat, Activity and Shop, the Eat vote split (Ian for the third Eat place, the other two
// for the first), and the plan was confirmed with the suggested order (reversedOrder: Shop, Activity, then Eat held at its
// time, after a wait of an hour). The planner must be stubbed. Built once per test file. Returns { text, id }.
let builtOrdered = null
export async function orderedSave(planner) {
  if (builtOrdered) return builtOrdered
  planner.arrangeItinerary.mockReset().mockImplementation(async (request) => reversedOrder(request, 60))
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan', 'darius'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  await api.setLocation(id, 'darius', 'start', { areaId: 'bugis' })
  await api.useMeetingArea(id)
  for (const person of ['ian', 'jonathan', 'darius']) await api.setPreferences(id, person, { categories: ['eat', 'activity', 'shop'], until: null })
  const { slots } = await api.getPlan(id)
  for (const slot of slots.filter((s) => ['eat', 'activity', 'shop'].includes(s.category))) {
    for (const person of ['ian', 'jonathan', 'darius']) {
      const pick = slot.category === 'eat' && person === 'ian' ? slot.options[2] : slot.options[0]
      await api.vote(id, slot.id, person, pick.id)
    }
  }
  await api.confirmPlan(id, await api.suggestOrder(id))
  builtOrdered = { text: api.storage.store[STORAGE_KEY], id }
  return builtOrdered
}

// api.js loaded on top of orderedSave.
// How to call: const { api, id } = await loadOrdered(planner)
export async function loadOrdered(planner, options = {}) {
  const { text, id } = await orderedSave(planner)
  const api = await loadApi({ ...options, data: { [STORAGE_KEY]: options.text ?? text } })
  return { api, id }
}

// api.js loaded on top of the confirmed save.
// How to call: const { api, id } = await loadConfirmed({ limit: 200_000 })
export async function loadConfirmed(options = {}) {
  const { text, id } = await confirmedSave()
  const api = await loadApi({ ...options, data: { [STORAGE_KEY]: text } })
  return { api, id }
}
