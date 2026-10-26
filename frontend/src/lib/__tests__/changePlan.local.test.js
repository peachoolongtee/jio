// The host changes the meeting place after it was set ("Change plan" > "Change meeting place"), on a demo or local account (lib/api.js on the
// browser's own storage): changeMeetingPlace lets the meeting area go, clears the votes, the places to vote on and the plan, keeps everyone's
// starts, tells the group in a banner that names the host, and either works the spots out again ('fairest') or names the area ('known', through
// the one known place). The path of a real account is in changePlan.remote.test.js. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { confirmedSave, loadApi, STORAGE_KEY, stubPlanner, tomorrow } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
  stubPlanner(planner)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// A voting session with Ian (the host) and Jonathan, both with a start, and a vote each. How to call: const { api, id } = await voting()
async function voting({ votes = true } = {}) {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan'])
  await api.startSession(id, { meetBy: 'fairest' })
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  await api.useMeetingArea(id)
  const { slots } = await api.getPlan(id)
  if (votes) for (const person of ['ian', 'jonathan']) await api.vote(id, slots[0].id, person, slots[0].options[0].id)
  return { api, id }
}

// The confirmed session of the shared fixture, on a fresh copy of the data layer. How to call: const { api, id } = await confirmed()
async function confirmed() {
  const { text, id } = await confirmedSave()
  const api = await loadApi({ data: { [STORAGE_KEY]: text } })
  return { api, id }
}

describe('"fairest": back to locating, the spots worked out again', () => {
  it('from voting: the meeting area, the votes and the places to vote on go; starts stay; the banner names the host', async () => {
    const { api, id } = await voting()
    const before = await api.getSession(id)
    expect(before.status).toBe('voting')
    const after = await api.changeMeetingPlace(id, { meetBy: 'fairest' })
    expect(after).toMatchObject({ status: 'locating', meetBy: 'fairest' })
    const session = await api.getSession(id)
    expect(session.banner).toMatchObject({ text: 'Ian changed the meeting place, so the votes were cleared.', released: true })
    expect(session.votes).toEqual({})
    expect(session.locations.ian.start.areaId).toBe('tampines')
    expect(session.locations.jonathan.start.areaId).toBe('jurong-east')
    expect(session.spots.approvals).toEqual({})
    expect(session.spots.suggestions).toEqual({})
    // The planner was asked again for the spots from the kept starts.
    expect(planner.meetingArea.mock.calls.length).toBeGreaterThan(0)
  })

  it('from a confirmed plan: the plan and the proposals go too, and the banner says the plan was cleared', async () => {
    const { api, id } = await confirmed()
    expect((await api.getSession(id)).status).toBe('confirmed')
    await api.changeMeetingPlace(id, { meetBy: 'fairest' })
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'locating', plan: null })
    expect(session.banner.text).toBe('Ian changed the meeting place, so the votes and the plan were cleared.')
    expect(session.replan ?? null).toBeNull()
  })

  it('says the places were chosen again when nobody had voted', async () => {
    const { api, id } = await voting({ votes: false })
    await api.changeMeetingPlace(id, { meetBy: 'fairest' })
    expect((await api.getSession(id)).banner.text).toBe('Ian changed the meeting place, so the places to vote on were cleared.')
  })

  it('takes everything back when the planner cannot answer', async () => {
    const { api, id } = await voting()
    const before = await api.getSession(id)
    planner.meetingArea.mockRejectedValue(new Error('The planner is down.'))
    await expect(api.changeMeetingPlace(id, { meetBy: 'fairest' })).rejects.toThrow('The planner is down.')
    const after = await api.getSession(id)
    expect(after.status).toBe('voting')
    expect(after.votes).toEqual(before.votes)
    expect(after.meeting).toEqual(before.meeting)
    expect(after.banner).toEqual(before.banner)
  })

  it('then the usual flow works: the host confirms a spot and the group is voting again with new places', async () => {
    const { api, id } = await voting()
    await api.changeMeetingPlace(id, { meetBy: 'fairest' })
    const session = await api.getSession(id)
    expect(session.status).toBe('locating')
    await api.useMeetingArea(id)
    expect((await api.getSession(id)).status).toBe('voting')
    expect((await api.getPlan(id)).slots.length).toBeGreaterThan(0)
  })
})

describe('"known": the area is named and the group goes straight to voting there', () => {
  it('releases, then sets the known place with a banner that names the host and the new area', async () => {
    const { api, id } = await voting()
    const after = await api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'bishan' })
    expect(after).toMatchObject({ status: 'voting', meetBy: 'known' })
    const session = await api.getSession(id)
    expect(session.meeting).toMatchObject({ areaId: 'bishan', method: 'chosen' })
    expect(session.banner).toMatchObject({ text: 'Ian changed the meeting place to Bishan, so the votes were cleared.', released: true, votesCleared: true })
    // New slots with no vote in any of them.
    expect(Object.values(session.votes).every((votes) => Object.keys(votes).length === 0)).toBe(true)
    expect(session.locations.ian.start.areaId).toBe('tampines')
  })

  it('from a confirmed plan the plan is gone and the banner says so', async () => {
    const { api, id } = await confirmed()
    await api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'bishan' })
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', plan: null })
    expect(session.meeting.areaId).toBe('bishan')
    expect(session.banner.text).toBe('Ian changed the meeting place to Bishan, so the votes and the plan were cleared.')
  })

  it('if naming the area fails, the session stays on Locate with the choice recorded, and the existing known place finishes it', async () => {
    const { api, id } = await voting()
    planner.meetingArea.mockImplementation(async () => {
      throw new Error('The planner is down.')
    })
    await expect(api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'bishan' })).rejects.toThrow('The planner is down.')
    const stuck = await api.getSession(id)
    expect(stuck).toMatchObject({ status: 'locating', meetBy: 'known' })
    expect(stuck.banner.text).toBe('Ian changed the meeting place, so the votes were cleared.')
    stubPlanner(planner)
    expect(await api.setKnownPlace(id, 'bishan')).toMatchObject({ status: 'voting' })
  })
})

describe('a repeat', () => {
  it('"known" for the area the session is already voting at, with no vote cast, is a no-op', async () => {
    const { api, id } = await voting({ votes: false })
    await api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'bishan' })
    const before = JSON.stringify(await api.getSession(id))
    const calls = planner.meetingArea.mock.calls.length
    expect(await api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'bishan' })).toMatchObject({ status: 'voting', meetBy: 'known' })
    expect(JSON.stringify(await api.getSession(id))).toBe(before)
    expect(planner.meetingArea.mock.calls.length).toBe(calls)
  })

  it('a second failure of the known place after the release marks the error as released', async () => {
    const { api, id } = await voting()
    planner.meetingArea.mockImplementation(async () => {
      throw new Error('The planner is down.')
    })
    await expect(api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'bishan' })).rejects.toMatchObject({ released: true })
  })
})

describe('who may, when, and what is asked', () => {
  it('is refused for a guest, and says who may', async () => {
    const api = await loadApi()
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
    const { id } = await api.createSession({ title: 'Theirs', date: tomorrow(), start: '12:00', end: '15:00', hostId: 'jonathan' })
    await expect(api.changeMeetingPlace(id, { meetBy: 'fairest' })).rejects.toThrow('Only the host can change the meeting place.')
  })

  it.each(['inviting', 'locating'])('is refused while the session is %s', async (status) => {
    const api = await loadApi()
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
    const { id } = await api.createSession({ title: 'Lunch', date: tomorrow(), start: '12:00', end: '15:00' })
    await api.inviteFriends(id, ['darius'])
    if (status === 'locating') await api.startSession(id, { meetBy: 'fairest' })
    await expect(api.changeMeetingPlace(id, { meetBy: 'fairest' })).rejects.toThrow('The meeting place can only be changed while the group is voting on places or has a plan.')
    expect((await api.getSession(id)).status).toBe(status)
  })

  it('is refused for a session that has ended', async () => {
    const { api, id } = await confirmed()
    await api.endPlan(id)
    await expect(api.changeMeetingPlace(id, { meetBy: 'fairest' })).rejects.toThrow('This session has ended.')
    expect((await api.getSession(id)).status).toBe('completed')
  })

  it('refuses a way it does not know and an area it does not know, changing nothing', async () => {
    const { api, id } = await voting()
    await expect(api.changeMeetingPlace(id, { meetBy: 'sometimes' })).rejects.toThrow('Choose how to pick the meeting point.')
    await expect(api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'atlantis' })).rejects.toThrow()
    await expect(api.changeMeetingPlace(id, { meetBy: 'known' })).rejects.toThrow()
    expect((await api.getSession(id)).status).toBe('voting')
  })
})
