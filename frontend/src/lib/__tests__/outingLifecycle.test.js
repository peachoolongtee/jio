// An outing finishes by itself (ticket #120): a confirmed plan is completed once its end time has passed, with the coins it
// earns; one with no confirmed plan stays open, with a reminder on Home, and closes two days after its end with no coins.
// "Finish outing" still ends one early, and nothing completes a cancelled outing. Every rule runs on a fixed clock.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, confirmedSave, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'
import { CLOSE_AFTER_MS, dueEnding, overdueOuting, sessionEnd, sessionPath } from '../session.js'
import { POINTS_PER_MEETUP } from '../mock/people.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

const at = (iso) => vi.setSystemTime(new Date(iso))
const stored = (api) => JSON.parse(api.storage.store[STORAGE_KEY])
const pointsOf = (api, id) => stored(api).stats[id]?.points ?? 0

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-09T10:00:00+08:00')
  stubPlanner(planner)
  // The confirmed save is Saturday 10 October 2026, 12:00 to 20:00, for Ian and Jonathan.
  await confirmedSave()
})
beforeEach(() => {
  stubPlanner(planner)
  at('2026-10-09T10:00:00+08:00')
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the rules, on their own', () => {
  const session = (status, more = {}) => ({ id: 's1', status, date: '2026-10-10', start: '12:00', end: '20:00', ...more })
  const now = (iso) => new Date(iso)

  it('reads the end from the session\'s own date and end time', () => {
    expect(sessionEnd(session('voting'))).toEqual(new Date('2026-10-10T20:00:00+08:00'))
    expect(sessionEnd({ date: '', end: '20:00' })).toBeNull()
    expect(sessionEnd({ date: '2026-10-10', end: 'late' })).toBeNull()
  })

  it('never finishes a confirmed plan by the clock: the person finishes it (Faith\'s walkthrough, 30 October 2026)', () => {
    expect(dueEnding(session('confirmed'), now('2026-10-10T19:59:59+08:00'))).toBeNull()
    expect(dueEnding(session('confirmed'), now('2026-10-10T20:00:00+08:00'))).toBeNull()
    expect(dueEnding(session('confirmed'), now('2026-10-13T20:00:00+08:00'))).toBeNull()
  })

  it('leaves an outing with no confirmed plan open for two days after its end, then closes it', () => {
    for (const status of ['inviting', 'locating', 'voting']) {
      expect(dueEnding(session(status), now('2026-10-10T20:00:00+08:00'))).toBeNull()
      expect(dueEnding(session(status), now('2026-10-12T19:59:59+08:00'))).toBeNull()
      expect(dueEnding(session(status), now('2026-10-12T20:00:00+08:00'))).toBe('close')
    }
    expect(CLOSE_AFTER_MS).toBe(2 * 24 * 60 * 60 * 1000)
  })

  it('never touches a cancelled or completed outing', () => {
    for (const status of ['cancelled', 'completed']) {
      expect(dueEnding(session(status), now('2027-01-01T00:00:00+08:00'))).toBeNull()
      expect(overdueOuting(session(status), now('2027-01-01T00:00:00+08:00'))).toBeNull()
    }
  })

  it('does not let the demo\'s session-day switch move the end', () => {
    expect(dueEnding(session('confirmed', { isToday: true }), now('2026-10-01T23:00:00+08:00'))).toBeNull()
  })

  it('reminds Home of an outing past its end, and says when it closes', () => {
    expect(overdueOuting(session('voting'), now('2026-10-10T19:00:00+08:00'))).toBeNull()
    expect(overdueOuting(session('voting'), now('2026-10-11T09:00:00+08:00'))).toEqual({ closesAt: new Date('2026-10-12T20:00:00+08:00') })
  })

  it('opens a closed outing\'s own page, which has no itinerary', () => {
    expect(sessionPath(session('completed', { plan: { stops: [] } }))).toBe('/sessions/s1/itinerary')
    expect(sessionPath(session('completed', { plan: null }))).toBe('/sessions/s1')
  })
})

describe('the data layer finishes outings when the list is read', () => {
  it('keeps a confirmed plan going until its end time', async () => {
    const { api, id } = await loadConfirmed()
    at('2026-10-10T19:59:00+08:00')
    const [s] = await api.listSessions()
    expect(s.id).toBe(id)
    expect(s.status).toBe('confirmed')
  })

  it('leaves a confirmed plan open after its end time, unpaid, until someone finishes it', async () => {
    const { api, id } = await loadConfirmed()
    const before = { ian: pointsOf(api, 'ian'), jonathan: pointsOf(api, 'jonathan') }
    at('2026-10-10T20:01:00+08:00')
    const [s] = await api.listSessions()
    expect(s).toMatchObject({ id, status: 'confirmed' })
    expect(pointsOf(api, 'ian')).toBe(before.ian)
    const done = await api.endPlan(id)
    expect(done).toMatchObject({ status: 'completed', endedBy: 'hand' })
    expect(pointsOf(api, 'ian')).toBe(before.ian + POINTS_PER_MEETUP)
    expect(pointsOf(api, 'jonathan')).toBe(before.jonathan + POINTS_PER_MEETUP)
  })

  it('still lets "Finish outing" end a plan early, by hand', async () => {
    const { api, id } = await loadConfirmed()
    at('2026-10-10T15:00:00+08:00')
    const done = await api.endPlan(id)
    expect(done).toMatchObject({ status: 'completed', endedBy: 'hand' })
  })

  it('never completes a cancelled outing', async () => {
    const { api, id } = await loadConfirmed()
    await api.cancelSession(id)
    const before = pointsOf(api, 'ian')
    at('2026-12-31T23:00:00+08:00')
    const [s] = await api.listSessions()
    expect(s.status).toBe('cancelled')
    expect(pointsOf(api, 'ian')).toBe(before)
  })

  it('closes an outing with no confirmed plan two days after its end, with no coins', async () => {
    const api = await loadApi()
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
    const { id } = await api.createSession({ title: 'Never planned', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    const before = pointsOf(api, 'ian')
    at('2026-10-12T19:59:00+08:00')
    expect((await api.listSessions())[0].status).toBe('locating')
    at('2026-10-12T20:00:00+08:00')
    const [s] = await api.listSessions()
    expect(s).toMatchObject({ status: 'completed', endedBy: 'closed' })
    expect(pointsOf(api, 'ian')).toBe(before)
  })
})
