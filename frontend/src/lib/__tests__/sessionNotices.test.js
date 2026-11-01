// A session that is waiting for someone, and votes the meeting area takes away. The planner is stubbed; the host
// carries on without a member who has not set a start (through the events store), and a move of the meeting area
// during voting leaves a banner that says the votes were cleared. Timers are real (the planner call waits for the
// "finding the meeting point" bar), so each location change takes about a second.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi, stubPlanner } from './planFixture.js'
import { AREAS } from '../mock/places.js'
import { votesClearedBanner } from '../../components/event/SessionNotices.vue'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => stubPlanner(planner))
afterEach(() => vi.unstubAllGlobals())

const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }
const area = (id) => AREAS.find((a) => a.id === id)

// A session in Locating with Ian, Jonathan and Faith; Ian and Jonathan have set a start, Faith has not.
async function waitingSession() {
  const api = await loadApi()
  await api.signUp(PROFILE)
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan', 'faith'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  return { api, id }
}

// The same session after the meeting area was used: Voting, with Ian and Jonathan each voting in Eat.
async function votingSession() {
  const { api, id } = await waitingSession()
  const { waitingFor } = await import('@/stores/events.js')
  const waiting = waitingFor(await api.getSession(id))
  expect(waiting).toEqual(['faith'])
  await api.optOut(id, 'faith')
  await api.useMeetingArea(id)
  const { slots } = await api.getPlan(id)
  const eat = slots.find((s) => s.category === 'eat')
  await api.vote(id, eat.id, 'ian', eat.options[0].id)
  await api.vote(id, eat.id, 'jonathan', eat.options[0].id)
  return { api, id }
}

describe('a session waiting for someone to set a start', () => {
  it('has no meeting area until everyone has, and says who is missing', async () => {
    const { api, id } = await waitingSession()
    const { waitingFor } = await import('@/stores/events.js')
    const session = await api.getSession(id)
    expect(session.meeting).toBeNull()
    expect(waitingFor(session)).toEqual(['faith'])
  })

  it('finds the meeting area once the host continues without them (the store opts them out)', async () => {
    const { api, id } = await waitingSession()
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useEventsStore, waitingFor } = await import('@/stores/events.js')
    const events = useEventsStore()
    const session = await events.optOut(id, 'faith')
    expect(session.meeting).not.toBeNull()
    expect(session.activeIds).toEqual(['ian', 'jonathan'])
    expect(session.members.find((m) => m.id === 'faith').state).toBe('opted_out')
    expect(waitingFor(session)).toEqual([])
  })

  it('waits for nobody once the session is past Locating, or has its area', async () => {
    const { waitingFor } = await import('@/stores/events.js')
    expect(waitingFor({ status: 'voting', activeIds: ['ian'], locations: {} })).toEqual([])
    expect(waitingFor({ status: 'locating', meeting: { areaId: 'bishan' }, activeIds: ['ian'], locations: {} })).toEqual([])
  })

  it('never lets the host opt out', async () => {
    const { api, id } = await waitingSession()
    await expect(api.optOut(id, 'ian')).rejects.toThrow(/host cannot opt out/)
  })
})

describe('a start that changes during voting', () => {
  // A confirmed meeting area never moves by itself (Faith's walkthrough, 30 October 2026, as on the server): the host chooses it again,
  // which clears the votes and says so.
  it('keeps the meeting area, the votes and the silence', async () => {
    const { api, id } = await votingSession()
    const before = await api.getSession(id)
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    expect(session.areaName).toBe(before.areaName)
    expect(session.banner?.votesCleared).toBeUndefined()
    expect(votesClearedBanner(session)).toBeNull()
    expect((await api.getPlan(id)).slots.some((slot) => slot.totalVotes > 0)).toBe(true)
  })

  it('is followed, when the host chooses the meeting place again, by a notice that the votes were cleared, which can be dismissed', async () => {
    const { api, id } = await votingSession()
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    const session = await api.changeMeetingPlace(id, { meetBy: 'fairest' })
    expect(session.status).toBe('locating')
    expect(session.banner.text).toMatch(/changed the meeting place, so the votes were cleared\./)
    expect((await api.dismissBanner(id)).banner).toBeNull()
  })

  it('does not claim votes were cleared when nobody had voted', async () => {
    const { api, id } = await waitingSession()
    await api.optOut(id, 'faith')
    await api.useMeetingArea(id)
    const session = await api.changeMeetingPlace(id, { meetBy: 'fairest' })
    expect(session.banner.text).toMatch(/changed the meeting place/)
    expect(session.banner.text).not.toMatch(/votes were cleared/)
  })

  it('keeps the area and the votes when a re-plan is asked for by hand', async () => {
    const { api, id } = await votingSession()
    const before = await api.getSession(id)
    await api.confirmPlan(id)
    const session = await api.replan(id)
    expect(session.status).toBe('voting')
    expect(session.areaName).toBe(before.areaName)
    expect(session.banner?.votesCleared).toBeUndefined()
  })
})
