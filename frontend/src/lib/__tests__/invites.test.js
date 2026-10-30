// Invites from the app are pending until each friend accepts; in the demo they accept on their own, one after
// another. Starting the session lets any invite nobody accepted lapse.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../api.js'

const stateOf = (session, id) => session.members.find((m) => m.id === id)?.state

describe('pending invites', () => {
  let id
  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
    ;({ id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' }))
  })
  afterEach(() => vi.useRealTimers())

  it('shows friends as Invited until they accept, then Joined, one after another', async () => {
    await api.inviteFriends(id, ['jonathan', 'faith'], { pending: true })
    let session = await api.getSession(id)
    expect([stateOf(session, 'jonathan'), stateOf(session, 'faith')]).toEqual(['invited', 'invited'])
    expect(session.activeIds).toEqual(['ian'])

    // The first accepts 8 s after being invited and the next 3 s after that: time enough to take an invite back.
    vi.setSystemTime(new Date('2026-10-09T10:00:08.500'))
    session = await api.getSession(id)
    expect([stateOf(session, 'jonathan'), stateOf(session, 'faith')]).toEqual(['joined', 'invited'])

    vi.setSystemTime(new Date('2026-10-09T10:00:12'))
    session = await api.getSession(id)
    expect(session.activeIds).toEqual(['ian', 'jonathan', 'faith'])
  })

  it('lets invites nobody accepted lapse when the session starts', async () => {
    await api.inviteFriends(id, ['jonathan'])
    await api.inviteFriends(id, ['faith'], { pending: true })
    await api.startSession(id)
    const session = await api.getSession(id)
    expect(session.members.map((m) => m.id)).toEqual(['ian', 'jonathan'])
  })
})
