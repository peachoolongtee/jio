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
// The planner says the fairest area is now `id`.
const moveMeetingAreaTo = (id) =>
  planner.meetingArea.mockImplementation(async ({ members }) => ({ area: area(id), method: 'station', travelByMember: Object.fromEntries(members.map((m) => [m.id, 20])), approximate: false }))

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

describe('the meeting area moving during voting', () => {
  it('says so, and says the votes were cleared', async () => {
    const { api, id } = await votingSession()
    moveMeetingAreaTo('orchard')
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    expect(session.areaName).toBe('Orchard')
    expect(session.banner.votesCleared).toBe(true)
    expect(session.banner.text).toMatch(/Meeting area moved from .* to Orchard/)
    expect(session.banner.text).toMatch(/Votes for places were cleared\./)
    expect(votesClearedBanner(session)).toEqual(session.banner)
    // The data layer did clear them.
    const plan = await api.getPlan(id)
    expect(plan.slots.every((slot) => slot.totalVotes === 0)).toBe(true)
  })

  it('can be dismissed', async () => {
    const { api, id } = await votingSession()
    moveMeetingAreaTo('orchard')
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    const session = await api.dismissBanner(id)
    expect(session.banner).toBeNull()
  })

  it('keeps the votes, and the old silence, when the area stays', async () => {
    const { api, id } = await votingSession()
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    expect(session.banner?.votesCleared).toBeUndefined()
    expect(votesClearedBanner(session)).toBeNull()
    expect((await api.getPlan(id)).slots.some((slot) => slot.totalVotes > 0)).toBe(true)
  })

  it('does not claim votes were cleared when nobody had voted', async () => {
    const { api, id } = await waitingSession()
    await api.optOut(id, 'faith')
    await api.useMeetingArea(id)
    moveMeetingAreaTo('orchard')
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    expect(session.banner.text).toMatch(/moved/)
    expect(session.banner.votesCleared).toBeUndefined()
    expect(session.banner.text).not.toMatch(/cleared/)
  })

  it('also says so when a re-plan asked for by hand moves the area', async () => {
    const { api, id } = await votingSession()
    const { slots } = await api.getPlan(id)
    for (const slot of slots.filter((s) => s.category === 'eat')) expect(slot.totalVotes).toBeGreaterThan(0)
    await api.confirmPlan(id)
    moveMeetingAreaTo('orchard')
    const session = await api.replan(id)
    expect(session.status).toBe('voting')
    expect(session.banner.votesCleared).toBe(true)
    expect(session.banner.text).toMatch(/Votes for places were cleared\./)
  })
})
