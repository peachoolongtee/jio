// Two options the demo's showcase needs from the data layer: a session a friend hosts (createSession's hostId), and invites
// that stay pending for a long time (inviteFriends' acceptAfter). The app itself uses neither, so its behaviour is unchanged.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

const FIELDS = { title: 'Board game night', date: '2026-10-17', start: '19:00', end: '23:00' }
const stateOf = (session, id) => session.members.find((m) => m.id === id)?.state

let api
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('a session a friend hosts', () => {
  it('makes the signed-in person the host when no host is given, as before', async () => {
    const session = await api.createSession(FIELDS)
    expect(session.hostId).toBe('ian')
    expect(session.members).toEqual([{ id: 'ian', role: 'host', state: 'joined' }])
  })

  it('is hosted by the friend, with the signed-in person a guest who has joined', async () => {
    const session = await api.createSession({ ...FIELDS, hostId: 'darius' })
    expect(session.hostId).toBe('darius')
    expect(session.members).toEqual([
      { id: 'darius', role: 'host', state: 'joined' },
      { id: 'ian', role: 'guest', state: 'joined' },
    ])
    expect(session.activeIds).toEqual(['darius', 'ian'])
  })

  it('cannot be edited by the guest, because only the host can', async () => {
    const { id } = await api.createSession({ ...FIELDS, hostId: 'darius' })
    await expect(api.updateSession(id, FIELDS)).rejects.toThrow('Only the host can change a session.')
  })

  it('refuses a host who is not a person on Jio', async () => {
    await expect(api.createSession({ ...FIELDS, hostId: 'nobody' })).rejects.toThrow('This person does not exist.')
  })
})

describe('an invite held for a long time', () => {
  it('stays pending through reads until the time has passed, then is accepted by the next read', async () => {
    const { id } = await api.createSession(FIELDS)
    await api.inviteFriends(id, ['faith'], { pending: true, acceptAfter: 7 * 24 * 60 * 60 * 1000 })
    vi.setSystemTime(new Date('2026-10-09T10:05:00'))
    expect(stateOf(await api.getSession(id), 'faith')).toBe('invited')
    vi.setSystemTime(new Date('2026-10-15T10:00:00'))
    expect(stateOf(await api.getSession(id), 'faith')).toBe('invited')
    vi.setSystemTime(new Date('2026-10-16T10:00:01'))
    expect(stateOf(await api.getSession(id), 'faith')).toBe('joined')
  })

  it('starts no timer for a long hold, and still starts one for the usual wait', async () => {
    const timers = vi.spyOn(globalThis, 'setTimeout')
    const { id } = await api.createSession(FIELDS)
    const before = timers.mock.calls.length
    await api.inviteFriends(id, ['faith'], { pending: true, acceptAfter: 7 * 24 * 60 * 60 * 1000 })
    // Only the data layer's own short wait for the write; no timer for the invite.
    expect(timers.mock.calls.slice(before).filter(([, ms]) => ms > 60_000)).toEqual([])
    const usual = timers.mock.calls.length
    await api.inviteFriends(id, ['jonathan'], { pending: true })
    expect(timers.mock.calls.slice(usual).some(([, ms]) => ms > 5000 && ms < 60_000)).toBe(true)
    timers.mockRestore()
  })
})
