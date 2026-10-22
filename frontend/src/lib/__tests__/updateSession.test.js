// Changing a session's title, day and times (updateSession): only the host, only while inviting, with the checks
// the create form makes, and nothing else on the session moves.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, loadApi } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

const FIELDS = { title: 'Dinner catch-up', date: '2026-10-17', start: '18:00', end: '21:00' }

let api
let id
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
  api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
  ;({ id } = await api.createSession({ title: 'Saturday hangout', date: '2026-10-10', start: '12:00', end: '20:00' }))
  // Something on the session besides its fields, so "nothing else changes" has something to hold on to.
  await api.inviteFriends(id, ['jonathan'])
  await api.inviteFriends(id, ['faith'], { pending: true })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The session as stored, without the fields updateSession may change.
const stored = async () => {
  const { title, date, start, end, updatedAt, ...rest } = JSON.parse(api.storage.store[STORAGE_KEY]).sessions.find((s) => s.id === id)
  return rest
}
const fieldsOf = async () => {
  const { title, date, start, end } = await api.getSession(id)
  return { title, date, start, end }
}

describe('updateSession', () => {
  it('changes the title, day and times, and returns the session as the screens read it', async () => {
    vi.setSystemTime(new Date('2026-10-09T10:05:00+08:00'))
    const session = await api.updateSession(id, FIELDS)
    expect(session).toMatchObject(FIELDS)
    expect(await fieldsOf()).toEqual(FIELDS)
    expect(session.updatedAt).toBe(new Date('2026-10-09T10:05:00+08:00').getTime())
  })

  it('is saved, so a reload keeps it', async () => {
    await api.updateSession(id, FIELDS)
    const saved = JSON.parse(api.storage.store[STORAGE_KEY]).sessions.find((s) => s.id === id)
    expect(saved).toMatchObject(FIELDS)
  })

  it('tells subscribers once, as a change to the session', async () => {
    const seen = vi.fn()
    api.subscribe(seen)
    await api.updateSession(id, FIELDS)
    expect(seen).toHaveBeenCalledTimes(1)
    expect(seen).toHaveBeenCalledWith({ type: 'session', sessionId: id })
  })

  it('keeps the title trimmed, as create does', async () => {
    await api.updateSession(id, { ...FIELDS, title: '  Dinner catch-up  ' })
    expect((await api.getSession(id)).title).toBe('Dinner catch-up')
  })

  it('changes nothing else on the session: people, invites, status, host, locations, plan', async () => {
    const before = await stored()
    await api.updateSession(id, FIELDS)
    expect(await stored()).toEqual(before)
    const session = await api.getSession(id)
    expect(session.status).toBe('inviting')
    expect(session.members.map((m) => [m.id, m.state])).toEqual([['ian', 'joined'], ['jonathan', 'joined'], ['faith', 'invited']])
  })

  it('accepts the same values again, and today as the day', async () => {
    await api.updateSession(id, FIELDS)
    await expect(api.updateSession(id, FIELDS)).resolves.toMatchObject(FIELDS)
    await expect(api.updateSession(id, { ...FIELDS, date: '2026-10-09' })).resolves.toMatchObject({ date: '2026-10-09' })
  })
})

describe('who and when', () => {
  it('is for the host only', async () => {
    // The same save, with the session hosted by someone else.
    const saved = JSON.parse(api.storage.store[STORAGE_KEY])
    saved.sessions.find((s) => s.id === id).hostId = 'faith'
    const other = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
    await expect(other.updateSession(id, FIELDS)).rejects.toThrow(/only the host/i)
    expect(await other.getSession(id)).toMatchObject({ title: 'Saturday hangout', date: '2026-10-10', start: '12:00', end: '20:00' })
  })

  it('is for a session that is still inviting, not one that has started, been cancelled or finished', async () => {
    await api.startSession(id)
    await expect(api.updateSession(id, FIELDS)).rejects.toThrow(/before the session starts/i)
    expect((await api.getSession(id)).status).toBe('locating')
    expect(await fieldsOf()).toEqual({ title: 'Saturday hangout', date: '2026-10-10', start: '12:00', end: '20:00' })

    const second = await api.createSession({ title: 'Brunch', date: '2026-10-12', start: '10:00', end: '12:00' })
    await api.cancelSession(second.id)
    await expect(api.updateSession(second.id, FIELDS)).rejects.toThrow(/before the session starts/i)
    expect(await api.getSession(second.id)).toMatchObject({ title: 'Brunch', status: 'cancelled' })
  })

  it('says so for a session that does not exist', async () => {
    await expect(api.updateSession('s999', FIELDS)).rejects.toThrow(/does not exist/i)
  })
})

describe('bad values', () => {
  const BEFORE = { title: 'Saturday hangout', date: '2026-10-10', start: '12:00', end: '20:00' }
  const cases = [
    ['a blank title', { title: '   ' }, /title/i],
    ['a missing title', { title: undefined }, /title/i],
    ['a title over 60 characters', { title: 'x'.repeat(61) }, /60 characters/i],
    ['no day', { date: '' }, /day/i],
    ['a day that is not a date', { date: 'next saturday' }, /day/i],
    ['a day that does not exist', { date: '2026-02-30' }, /day/i],
    ['a day that has passed', { date: '2026-10-08' }, /passed/i],
    ['a day more than three months ahead', { date: '2027-02-01' }, /3 months/i],
    ['a start that is not a time', { start: '9:00' }, /start/i],
    ['an hour past 23', { start: '24:00' }, /start/i],
    ['minutes past 59', { end: '20:60' }, /end/i],
    ['no end', { end: '' }, /end/i],
    ['an end at the start', { start: '18:00', end: '18:00' }, /after the start/i],
    ['an end before the start', { start: '18:00', end: '09:30' }, /after the start/i],
  ]
  it.each(cases)('refuses %s and leaves the session as it was', async (_name, change, message) => {
    await expect(api.updateSession(id, { ...FIELDS, ...change })).rejects.toThrow(message)
    expect(await fieldsOf()).toEqual(BEFORE)
  })

  it('does not tell subscribers about a refused change', async () => {
    const seen = vi.fn()
    api.subscribe(seen)
    await expect(api.updateSession(id, { ...FIELDS, title: '' })).rejects.toThrow()
    expect(seen).not.toHaveBeenCalled()
  })
})
