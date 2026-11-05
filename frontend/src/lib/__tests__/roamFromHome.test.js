// Roam from Home (ticket #98): "Already out? Find something nearby" starts a light meetup for today around one area, with no
// location step, and its Roam list opens at once. The group sees the area's name only, never an exact place. Inviting
// friends is optional, so a light meetup of one is not paused. The planner is stood in for, as in roam.test.js.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, loadApi, stubPlanner } from './planFixture.js'
import { VENUES } from '../mock/venues.js'
import { inviteAccess, isPaused, roamOpen } from '../session.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

const card = (venue) => ({ id: venue.id, venue, rank: 1, score: 10, walk: 3, reasons: [], warnings: [], swap: null, travelMinutes: 4, distanceKm: 0.3, distanceM: 300, approximate: false })

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
beforeEach(() => {
  vi.setSystemTime(new Date('2026-10-17T14:20:00+08:00'))
  stubPlanner(planner)
  planner.roamNearby.mockReset().mockResolvedValue({ places: VENUES.slice(0, 3).map(card), empty: null, widened: false, weather: null })
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

async function signedIn() {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  return api
}

describe('a light meetup from Home', () => {
  it('is under way today around the area, with no location step and no stops yet', async () => {
    const api = await signedIn()
    const s = await api.startRoam({ areaId: 'bugis' })
    expect(s).toMatchObject({ status: 'confirmed', light: true, date: '2026-10-17', start: '14:20', end: '17:20', title: 'Out in Bugis', areaName: 'Bugis', isToday: true })
    expect(s.activeIds).toEqual([s.hostId])
    expect(s.locations).toEqual({})
    expect(s.plan.stops).toEqual([])
    expect(roamOpen(s)).toBe(true)
  })

  it('keeps the area only: nothing of an exact place is saved', async () => {
    const api = await signedIn()
    const { id } = await api.startRoam({ areaId: 'bugis', title: 'After work' })
    const saved = JSON.parse(api.storage.store[STORAGE_KEY]).sessions.find((x) => x.id === id)
    expect(saved.meeting.areaId).toBe('bugis')
    expect(JSON.stringify(saved)).not.toMatch(/"lat"|"lng"|"label"/)
  })

  it('opens its Roam list at once, centred on the area', async () => {
    const api = await signedIn()
    const { id } = await api.startRoam({ areaId: 'bugis' })
    const list = await api.roamNearby(id)
    expect(list.centre).toEqual({ areaId: 'bugis', areaName: 'Bugis' })
    expect(list.places).toHaveLength(3)
    expect(list.blocked).toBe('')
  })

  it('makes a proposed place its first stop, starting now', async () => {
    const api = await signedIn()
    const { id } = await api.startRoam({ areaId: 'bugis' })
    const { places } = await api.roamNearby(id)
    const proposed = await api.proposeStop(id, 'ian', places[0].id)
    const done = await api.resolveProposal(id, proposed.proposals[0].id, true)
    expect(done.plan.stops).toHaveLength(1)
    const itinerary = await api.getItinerary(id)
    expect(itinerary.stops[0]).toMatchObject({ start: 14 * 60 + 20, end: 15 * 60 + 20 })
  })

  // Singapore's clock, not the browser's: at 16:30 UTC on the 17th it is 00:30 on the 18th in Singapore, so the meetup is for the 18th,
  // the list is ranked for 00:30 that day, and a place accepted from it starts at 00:30, in any time zone the tests run in.
  it('reads the day and the time on Singapore\'s clock: the date, the list\'s time and the first stop', async () => {
    vi.setSystemTime(new Date('2026-10-17T16:30:00Z'))
    const api = await signedIn()
    const s = await api.startRoam({ areaId: 'bugis' })
    expect(s).toMatchObject({ date: '2026-10-18', start: '00:30', end: '03:30', isToday: true })
    const { places } = await api.roamNearby(s.id)
    expect(planner.roamNearby.mock.calls[0][0]).toMatchObject({ date: '2026-10-18', time: '00:30' })
    const proposed = await api.proposeStop(s.id, 'ian', places[0].id)
    await api.resolveProposal(s.id, proposed.proposals[0].id, true)
    expect((await api.getItinerary(s.id)).stops[0]).toMatchObject({ start: 30, end: 90 })
  })

  it('is not paused with one person, and the host may invite friends to it', async () => {
    const api = await signedIn()
    const s = await api.startRoam({ areaId: 'bugis' })
    expect(isPaused(s)).toBe(false)
    expect(inviteAccess(s, true)).toEqual({ open: true, text: '' })
    const after = await api.inviteFriends(s.id, ['faith'])
    expect(after.activeIds).toContain('faith')
    // A confirmed plan that is not light still closes invites.
    expect(inviteAccess({ ...s, light: false, activeIds: ['ian', 'faith'] }, true).open).toBe(false)
  })

  it('ends by 23:59 late at night, and stays open past that end until it is finished', async () => {
    vi.setSystemTime(new Date('2026-10-17T22:30:00+08:00'))
    const api = await signedIn()
    const s = await api.startRoam({ areaId: 'bugis' })
    expect([s.start, s.end]).toEqual(['22:30', '23:59'])
    vi.setSystemTime(new Date('2026-10-18T00:01:00+08:00'))
    const [after] = await api.listSessions()
    expect(after).toMatchObject({ id: s.id, status: 'confirmed' })
  })

  it('needs a known area', async () => {
    const api = await signedIn()
    await expect(api.startRoam({ areaId: 'atlantis' })).rejects.toThrow('Pick an area first.')
    await expect(api.startRoam({})).rejects.toThrow('Pick an area first.')
  })
})
