// Weather through the data layer (api.js), with the backend planner stood in for: what is kept with a plan when it is confirmed,
// what an old save shows, what the check on the day asks the planner, which indoor place the planner offers for a stop, and the
// host's swap and dismissal. The screens read these; nothing here draws.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, loadApi, stubPlanner } from './planFixture.js'
import { VENUES } from '../mock/venues.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), stopsWeather: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.setConfig({ testTimeout: 30000 })

const BLOCK = { source: 'live', basis: 'area', issuedAt: '2026-10-10T09:30:00+08:00', validUntil: '2026-10-10T11:30:00+08:00' }
const RAINY = { state: 'showers', phrase: 'Light Showers', rainLikely: true, ...BLOCK }
const SWAP = { id: 'toa-payoh-library', name: 'Toa Payoh Public Library' }
// The activity slot offers an open-air park first, so the plan has a stop that rain matters to.
const ACTIVITY = ['henderson-waves', 'national-gallery', 'toa-payoh-library']

// The planner: three places for each slot (the park first for Activity), each with the weather that was asked about and, for
// an open-air place, the indoor swap. `weatherFor(venue)` can be changed by a test.
let weatherFor
function stubWeatherPlanner() {
  stubPlanner(planner)
  weatherFor = () => RAINY
  const option = (venue, i) => ({
    venue, rank: i + 1, score: i, walk: 5 + i, reasons: [], warnings: venue.indoor ? [] : ['rain'], swap: venue.indoor ? null : SWAP,
    explanation: '', dietUnknown: [], verify: [], approximate: false, weather: weatherFor(venue),
  })
  planner.rankSlot.mockReset().mockImplementation(async ({ slot, currentOptionIds = [] }) => {
    const pool = VENUES.filter((v) => v.category === slot.category)
    const first = slot.category === 'activity' ? ACTIVITY.map((id) => VENUES.find((v) => v.id === id)) : pool.slice(0, 3)
    return {
      options: first.map(option),
      current: VENUES.filter((v) => currentOptionIds.includes(v.id)).map(option),
      widened: false, few: null, empty: null, weather: BLOCK,
    }
  })
  planner.stopsWeather.mockReset().mockImplementation(async ({ stops }) => ({
    stops: Object.fromEntries(stops.map((s) => [s.id, { ...RAINY }])),
    weather: BLOCK,
  }))
}

// One session, confirmed with an Eat stop and an Activity stop (the park), built once and loaded fresh for each test.
const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }
let saved = null
async function build() {
  if (saved) return saved
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T10:00:00'))
  const api = await loadApi()
  await api.signUp(PROFILE)
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  await api.useMeetingArea(id)
  for (const person of ['ian', 'jonathan']) await api.setPreferences(id, person, { categories: ['eat', 'activity'], until: null })
  const { slots } = await api.getPlan(id)
  for (const slot of slots.filter((s) => ['eat', 'activity'].includes(s.category))) {
    for (const person of ['ian', 'jonathan']) await api.vote(id, slot.id, person, slot.options[0].id)
  }
  await api.confirmPlan(id)
  saved = { text: api.storage.store[STORAGE_KEY], id }
  return saved
}
// api.js on top of the confirmed save; `edit` changes the saved text first (a different host, an old save).
async function open(edit = (text) => text) {
  const { text, id } = await build()
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T10:00:00'))
  return { api: await loadApi({ data: { [STORAGE_KEY]: edit(text) } }), id }
}
const stripWeather = (text) => {
  const save = JSON.parse(text)
  for (const s of save.sessions) for (const slot of Object.values(s.confirmedRanking || {})) for (const detail of Object.values(slot)) delete detail.weather
  return JSON.stringify(save)
}
const hostedBy = (host) => (text) => {
  const save = JSON.parse(text)
  save.sessions.forEach((s) => (s.hostId = host))
  return JSON.stringify(save)
}

beforeEach(() => stubWeatherPlanner())

describe('what a confirmed plan keeps of the weather', () => {
  it('keeps each stop\'s weather when the plan is confirmed, and the forecast it came from', async () => {
    const { api, id } = await open()
    const itinerary = await api.getItinerary(id)
    expect(itinerary.stops.map((s) => s.category).sort()).toEqual(['activity', 'eat'])
    for (const stop of itinerary.stops) {
      expect(stop.weather).toMatchObject({ state: 'showers', rainLikely: true, phrase: 'Light Showers', source: 'live', basis: 'area', issuedAt: BLOCK.issuedAt })
    }
    expect(itinerary.weather).toMatchObject({ source: 'live', basis: 'area', issuedAt: BLOCK.issuedAt, phrase: 'Light Showers' })
  })

  it('shows them again without asking the planner', async () => {
    const { api, id } = await open()
    planner.rankSlot.mockClear()
    planner.stopsWeather.mockClear()
    await api.getItinerary(id)
    await api.getPlan(id)
    expect(planner.rankSlot).not.toHaveBeenCalled()
    expect(planner.stopsWeather).not.toHaveBeenCalled()
  })

  it('gives the plan\'s options their weather and one forecast block for the list', async () => {
    const { api, id } = await open()
    const plan = await api.getPlan(id)
    expect(plan.weather).toMatchObject({ source: 'live', basis: 'area' })
    // The stops' slots kept theirs; a category nobody voted in was not part of the plan, so it kept nothing.
    const options = plan.slots.filter((s) => ['eat', 'activity'].includes(s.category)).flatMap((s) => s.options)
    expect(options.length).toBeGreaterThan(0)
    for (const o of options) expect(o.weather).toMatchObject({ state: 'showers', rainLikely: true })
  })

  it('shows a save from before weather was kept with no weather and no error', async () => {
    const { api, id } = await open(stripWeather)
    const itinerary = await api.getItinerary(id)
    expect(itinerary.stops).toHaveLength(2)
    for (const stop of itinerary.stops) expect(stop.weather).toBeNull()
    expect(itinerary.weather).toBeNull()
    const plan = await api.getPlan(id)
    expect(plan.weather).toBeUndefined()
    for (const o of plan.slots.flatMap((s) => s.options)) expect(o.weather).toBeUndefined()
  })

  it('needs no new version of the save: the old save is loaded as it is', async () => {
    const { text } = await build()
    expect(JSON.parse(stripWeather(text)).version).toBe(JSON.parse(text).version)
  })
})

describe('the voting page\'s forecast', () => {
  it('has the planner\'s block for the list while the group votes', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
    const api = await loadApi()
    await api.signUp(PROFILE)
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await api.useMeetingArea(id)
    const outside = { source: 'none', basis: 'none', reason: 'outside_window' }
    const rank = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => ({ ...(await rank(args)), weather: outside }))
    const plan = await api.getPlan(id)
    expect(plan.weather).toEqual({ source: 'none', basis: 'none', reason: 'outside_window' })
  })
})

describe('the check on the day', () => {
  it('asks the planner about each stop at its time, with how exposed it is', async () => {
    const { api, id } = await open()
    const itinerary = await api.getItinerary(id)
    const answer = await api.checkStopWeather(id)
    expect(planner.stopsWeather).toHaveBeenCalledTimes(1)
    const { stops, conditions } = planner.stopsWeather.mock.calls[0][0]
    expect(conditions).toMatchObject({ rain: false })
    expect(stops.map((s) => s.id)).toEqual(itinerary.stops.map((s) => s.slotId))
    for (const [i, s] of stops.entries()) {
      const stop = itinerary.stops[i]
      expect(s.start).toBe(`2026-10-10T${String(Math.floor(stop.start / 60)).padStart(2, '0')}:${String(stop.start % 60).padStart(2, '0')}`)
      expect(s.point).toEqual({ lat: stop.venue.lat, lng: stop.venue.lng })
      expect(['indoor', 'outdoor']).toContain(s.setting)
      expect(s.exposure).toBeGreaterThanOrEqual(0)
    }
    const park = stops.find((s) => s.id === 'activity')
    expect(park).toMatchObject({ setting: 'outdoor', exposure: 5 })
    expect(answer.stops.activity).toMatchObject({ state: 'showers', rainLikely: true })
    expect(answer.weather).toEqual(BLOCK)
    expect(answer.checkedAt).toBe(Date.now())
  })

  it('asks for the day it is when the demo says it is the session day, and for the simulated rain when that is on', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    const { api, id } = await open()
    vi.setSystemTime(new Date('2026-10-14T10:00:00'))
    await api.setConditions({ sessionDay: true, rain: true })
    await api.checkStopWeather(id)
    const { stops, conditions } = planner.stopsWeather.mock.calls[0][0]
    expect(conditions).toMatchObject({ rain: true, sessionDay: true })
    for (const s of stops) expect(s.start.startsWith('2026-10-14T')).toBe(true)
  })

  it('lets a failed request through, for the caller to keep its last answer', async () => {
    const { api, id } = await open()
    planner.stopsWeather.mockRejectedValue(new Error('Cannot reach the Jio planner right now.'))
    await expect(api.checkStopWeather(id)).rejects.toThrow('Cannot reach')
  })
})

describe('the indoor place for a stop in the rain', () => {
  it('is the swap the planner gives for the stop, asked at the stop\'s time on the day', async () => {
    const { api, id } = await open()
    planner.rankSlot.mockClear()
    const swap = await api.findRainSwap(id, 'activity')
    expect(swap).toEqual(SWAP)
    expect(planner.rankSlot).toHaveBeenCalledTimes(1)
    const call = planner.rankSlot.mock.calls[0][0]
    expect(call.date).toBe('2026-10-10')
    expect(call.currentOptionIds).toEqual(['henderson-waves'])
    expect(call.slot).toMatchObject({ id: 'activity', category: 'activity' })
  })

  it('is null when the planner offers none, and changes nothing', async () => {
    const { api, id } = await open()
    const rank = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      const out = await rank(args)
      return { ...out, current: out.current.map((o) => ({ ...o, swap: null })) }
    })
    const before = JSON.stringify(await api.getItinerary(id))
    expect(await api.findRainSwap(id, 'activity')).toBeNull()
    expect(await api.findRainSwap(id, 'no-such-slot')).toBeNull()
    expect(JSON.stringify(await api.getItinerary(id))).toBe(before)
  })
})

describe('the host\'s swap on a confirmed plan', () => {
  it('puts the indoor place in the stop and keeps its weather with the plan', async () => {
    const { api, id } = await open()
    const before = (await api.getItinerary(id)).stops.find((s) => s.slotId === 'activity')
    expect(before.venue.id).toBe('henderson-waves')
    const session = await api.swapOption(id, 'activity', 'henderson-waves', SWAP.id)
    expect(session.status).toBe('confirmed')
    const after = (await api.getItinerary(id)).stops.find((s) => s.slotId === 'activity')
    expect(after.venue.id).toBe(SWAP.id)
    expect(after.duration).toBe(before.duration)
    expect(after.weather).toMatchObject({ state: 'showers', rainLikely: true })
    // The Vote page lists the indoor place and no longer the park.
    const plan = await api.getPlan(id)
    const options = plan.slots.find((s) => s.id === 'activity').options.map((o) => o.id)
    expect(options).toContain(SWAP.id)
    expect(options).not.toContain('henderson-waves')
  })

  it('swaps once: asking again changes nothing and asks the planner nothing', async () => {
    const { api, id } = await open()
    await api.swapOption(id, 'activity', 'henderson-waves', SWAP.id)
    planner.rankSlot.mockClear()
    const again = await api.swapOption(id, 'activity', 'henderson-waves', SWAP.id)
    expect(planner.rankSlot).not.toHaveBeenCalled()
    expect(again.plan.stops.find((s) => s.slotId === 'activity').venueId).toBe(SWAP.id)
  })

  it('refuses a swap from a place the stop no longer is', async () => {
    const { api, id } = await open()
    await expect(api.swapOption(id, 'activity', 'national-gallery', SWAP.id)).rejects.toThrow('has changed')
    expect((await api.getItinerary(id)).stops.find((s) => s.slotId === 'activity').venue.id).toBe('henderson-waves')
  })

  it('refuses a place that does not fit the stop, and changes nothing', async () => {
    const { api, id } = await open()
    const rank = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => ({ ...(await rank(args)), options: [], current: [] }))
    await expect(api.swapOption(id, 'activity', 'henderson-waves', SWAP.id)).rejects.toThrow('does not fit')
    expect((await api.getItinerary(id)).stops.find((s) => s.slotId === 'activity').venue.id).toBe('henderson-waves')
  })

  it('is for the host alone', async () => {
    const { api, id } = await open(hostedBy('jonathan'))
    await expect(api.swapOption(id, 'activity', 'henderson-waves', SWAP.id)).rejects.toThrow('Only the host')
    expect((await api.getItinerary(id)).stops.find((s) => s.slotId === 'activity').venue.id).toBe('henderson-waves')
  })

  it('still swaps an option while the group votes, as it always did', async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
    const api = await loadApi()
    await api.signUp(PROFILE)
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await api.useMeetingArea(id)
    const { slots } = await api.getPlan(id)
    const activity = slots.find((s) => s.category === 'activity')
    expect(activity.options[0].swap).toBeTruthy()
    await api.swapOption(id, activity.id, 'henderson-waves', SWAP.id)
    const options = (await api.getPlan(id)).slots.find((s) => s.category === 'activity').options.map((o) => o.id)
    expect(options).not.toContain('henderson-waves')
    expect(options).toContain(SWAP.id)
  })
})

describe('the host keeping a stop in the rain', () => {
  it('is saved with the state of the forecast and read back on the session', async () => {
    const { api, id } = await open()
    const session = await api.dismissRainWarning(id, 'activity', 'showers')
    expect(session.weatherDismissed).toEqual({ activity: 'showers' })
    expect((await api.getSession(id)).weatherDismissed).toEqual({ activity: 'showers' })
  })

  it('keeps only a state it knows', async () => {
    const { api, id } = await open()
    expect((await api.dismissRainWarning(id, 'activity', 'hail')).weatherDismissed).toEqual({ activity: 'unknown' })
  })

  it('is for the host alone, and for a stop in the plan', async () => {
    const guest = await open(hostedBy('jonathan'))
    await expect(guest.api.dismissRainWarning(guest.id, 'activity', 'showers')).rejects.toThrow('Only the host')
    const { api, id } = await open()
    await expect(api.dismissRainWarning(id, 'shop', 'showers')).rejects.toThrow('not in the plan')
  })

  it('is forgotten for a stop once it is swapped', async () => {
    const { api, id } = await open()
    await api.dismissRainWarning(id, 'activity', 'showers')
    await api.dismissRainWarning(id, 'eat', 'showers')
    const session = await api.swapOption(id, 'activity', 'henderson-waves', SWAP.id)
    expect(session.weatherDismissed).toEqual({ eat: 'showers' })
  })
})
