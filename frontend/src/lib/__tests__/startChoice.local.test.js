// The Start choice on a demo or local account (lib/api.js on the browser's own storage): startSession saves the host's choice with the
// start, a known place records 'known', an unknown value is refused, a session started the old way has none, and a failed known place
// takes its mark back. The path of a real account is in startChoice.screen.test.js. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi, stubPlanner, tomorrow } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

let api
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
  stubPlanner(planner)
  api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// A session with Darius in it, still inviting.
// How to call: const id = await inviting()
async function inviting() {
  const { id } = await api.createSession({ title: 'Lunch', date: tomorrow(), start: '12:00', end: '15:00' })
  await api.inviteFriends(id, ['darius'])
  return id
}

describe('startSession with a choice', () => {
  it('saves the fairest spot with the start', async () => {
    const id = await inviting()
    const started = await api.startSession(id, { meetBy: 'fairest' })
    expect(started).toMatchObject({ status: 'locating', meetBy: 'fairest' })
    expect(await api.getSession(id)).toMatchObject({ meetBy: 'fairest' })
  })

  it('saves "we already know where" with the start', async () => {
    const id = await inviting()
    expect(await api.startSession(id, { meetBy: 'known' })).toMatchObject({ status: 'locating', meetBy: 'known' })
  })

  it('leaves it unset when the start names none (a session started before the choice existed), and refuses a value it does not know', async () => {
    const id = await inviting()
    await expect(api.startSession(id, { meetBy: 'sometimes' })).rejects.toThrow('Choose how to pick the meeting point.')
    expect((await api.getSession(id)).status).toBe('inviting')
    const started = await api.startSession(id)
    expect(started.status).toBe('locating')
    expect(started.meetBy ?? null).toBeNull()
  })

  it('still needs two people', async () => {
    const { id } = await api.createSession({ title: 'Solo', date: tomorrow(), start: '12:00', end: '15:00' })
    await expect(api.startSession(id, { meetBy: 'known' })).rejects.toThrow('A session needs at least 2 people.')
  })
})

describe('the known place after the choice', () => {
  it('names the area through the one known place, records the choice as known, and moves on to choosing places', async () => {
    const id = await inviting()
    await api.startSession(id, { meetBy: 'known' })
    const settled = await api.setKnownPlace(id, 'bugis')
    expect(settled).toMatchObject({ status: 'voting', meetBy: 'known', areaName: 'Bugis' })
    expect(settled.meeting).toMatchObject({ areaId: 'bugis', method: 'chosen' })
  })

  it('records "known" when the host switches from the fairest spot to a place they already have, while locating', async () => {
    const id = await inviting()
    await api.startSession(id, { meetBy: 'fairest' })
    expect((await api.setKnownPlace(id, 'orchard')).meetBy).toBe('known')
  })

  it('takes the mark back when the known place fails, so the record agrees with what happened', async () => {
    const id = await inviting()
    await api.startSession(id, { meetBy: 'fairest' })
    planner.meetingArea.mockRejectedValueOnce(new Error('The planner is not answering.'))
    planner.rankSlot.mockRejectedValue(new Error('The planner is not answering.'))
    await expect(api.setKnownPlace(id, 'orchard')).rejects.toThrow()
    const after = await api.getSession(id)
    expect(after.status).toBe('locating')
    expect(after.meetBy).toBe('fairest')
  })

  it('refuses an area that does not exist', async () => {
    const id = await inviting()
    await api.startSession(id, { meetBy: 'known' })
    await expect(api.setKnownPlace(id, 'not-an-area')).rejects.toThrow('This area does not exist.')
  })
})
