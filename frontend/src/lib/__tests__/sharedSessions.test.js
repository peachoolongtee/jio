// Stage 2 of moving sessions to the database: a real account's sessions are rows in Supabase, shared with the people it invites.
// Two or three people use their own copy of the app (a fresh api.js each, as three browsers would) on ONE stand-in database
// (components/dev/fakeDatabase.js), so what one does the others see. The demo account is shown to be unchanged. No network.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { createDatabase } from '../../components/dev/fakeDatabase.js'

// Leaving goes through the Jio server; here it is the server's route done in a few lines, with the server's key.
const server = vi.hoisted(() => ({ calls: [], answer: null }))
const planner = vi.hoisted(() => ({
  api: { defaults: {} },
  meetingArea: vi.fn(),
  rankSlot: vi.fn(),
  searchSlot: vi.fn(),
  searchPeopleByUsername: vi.fn(async () => []),
  removeSessionMember: vi.fn(async (...args) => {
    server.calls.push(args)
    if (server.answer) return server.answer(...args)
    return { planVersion: 1, left: true }
  }),
}))
vi.mock('../plannerApi.js', () => planner)

const THIRD = { email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] }
const DEMO = { ...PROFILE, email: 'ian@jio.demo', name: 'Ian', username: 'ian', demo: true, friends: ['darius'] }

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => {
  server.calls.length = 0
  server.answer = null
})
afterEach(() => vi.unstubAllGlobals())

// One database, and a way to open the app on it as someone. `ops` records every request that reached the database.
// How to call: const w = world(); const sam = await w.open(PROFILE)
function world() {
  const database = createDatabase({ profiles: {} })
  const ops = []
  const watched = { ...database, run: (op) => (ops.push(op), database.run(op)) }
  return {
    database,
    // The database as the apps reach it, recording each request.
    watched,
    ops,
    // A copy of the app signed up as `profile` on the shared database. `profile: null` is a visitor who is signed out.
    async open(profile) {
      const fake = fakeSupabase({ database: watched, memoryOnly: true })
      const app = await boot(fake, {}, { shared: true })
      const user = profile ? await app.api.signUp({ ...profile }) : null
      return { ...app, fake, user, id: user?.id }
    },
  }
}

describe('a real account\'s session is a row in the database', () => {
  it('creates it with the host as its only member, and keeps it out of the browser\'s own save', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const made = await sam.api.createSession({ ...SESSION, title: '  Saturday  ' })
    expect(made).toMatchObject({ title: 'Saturday', date: SESSION.date, start: '12:00', end: '20:00', status: 'inviting', hostId: sam.id, remote: true })
    expect(made.members).toEqual([{ id: sam.id, role: 'host', state: 'joined' }])
    expect(w.database.tables.sessions).toHaveLength(1)
    expect(w.database.tables.sessions[0]).toMatchObject({ host_id: sam.id, title: 'Saturday', start_time: '12:00:00' })
    // Nothing of it is in local storage.
    expect(Object.values(sam.storage.store).join('')).not.toContain('Saturday')
    expect(made.id).toMatch(/^[0-9a-f-]{36}$/)
    expect((await sam.api.getSession(made.id)).title).toBe('Saturday')
    expect((await sam.api.listSessions()).map((s) => s.id)).toEqual([made.id])
  })

  it('is the same shape the screens read for a local session', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const local = await (await boot(null)).api.signUp({ ...DEMO })
    expect(local.id).toBe('ian')
    const made = await sam.api.createSession({ ...SESSION })
    for (const key of ['locations', 'spots', 'activeIds', 'isToday', 'findingMeeting', 'photoCount', 'resultLine', 'hostName', 'slots', 'proposals', 'radius']) {
      expect(made).toHaveProperty(key)
    }
    expect(made.activeIds).toEqual([sam.id])
    expect(made.hostName).toBe('Sam')
  })

  it('checks the title, the day and the times before anything is sent', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    await expect(sam.api.createSession({ ...SESSION, title: '   ' })).rejects.toThrow('A session needs a title.')
    await expect(sam.api.createSession({ ...SESSION, date: '2026-10-01' })).rejects.toThrow('That day has passed.')
    await expect(sam.api.createSession({ ...SESSION, start: '20:00', end: '12:00' })).rejects.toThrow('End time must be after the start time.')
    expect(w.database.tables.sessions).toHaveLength(0)
  })

  it('lets only the host rename it, and says so', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    const link = await sam.api.makeInviteLink(id)
    await kim.api.joinWithLink(link.token)
    expect((await sam.api.updateSession(id, { ...SESSION, title: 'Renamed', start: '13:00' })).title).toBe('Renamed')
    expect((await kim.api.getSession(id)).start).toBe('13:00')
    await expect(kim.api.updateSession(id, { ...SESSION, title: 'Mine' })).rejects.toThrow('Only the host can change a session.')
    expect((await sam.api.getSession(id)).title).toBe('Renamed')
  })

  it('lets only the host cancel, and a cancelled session cannot be changed', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    await expect(kim.api.cancelSession(id)).rejects.toThrow('Only the host can cancel a session.')
    expect((await sam.api.cancelSession(id)).status).toBe('cancelled')
    expect((await kim.api.getSession(id)).status).toBe('cancelled')
    await expect(sam.api.updateSession(id, { ...SESSION, title: 'Back' })).rejects.toThrow('A cancelled session cannot be changed.')
  })

  it('lets only the host start it, with two people in, and then it is locating for everyone', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    // One person alone cannot start it: the database's own sentence says so.
    await expect(sam.api.startSession(id)).rejects.toThrow('A session needs at least two people before it can start.')
    expect(w.database.tables.sessions[0].status).toBe('inviting')
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    // A guest has no say in starting it.
    await expect(kim.api.startSession(id)).rejects.toThrow('Only the host can start a session.')
    expect(w.database.tables.sessions[0].status).toBe('inviting')
    const started = await sam.api.startSession(id)
    expect(started.status).toBe('locating')
    expect(w.database.tables.sessions[0].status).toBe('locating')
    expect((await kim.api.getSession(id)).status).toBe('locating')
  })

  it('never reads another member\'s exact place or touches a table outside this stage', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    await sam.api.getSession(id)
    await sam.api.listSessions()
    expect(new Set(w.ops.filter((op) => op.table).map((op) => op.table))).toEqual(new Set(['sessions', 'session_members', 'invites']))
  })
})

describe('the invite link', () => {
  it('is made once, handed back until it is turned off, and a new one replaces it', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    expect(await sam.api.getInviteLink(id)).toBeNull()
    const first = await sam.api.makeInviteLink(id)
    expect(first.path).toBe(`/join/${first.token}`)
    expect(first.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
    expect(first.expired).toBe(false)
    expect((await sam.api.makeInviteLink(id)).token).toBe(first.token)
    expect((await sam.api.getInviteLink(id)).token).toBe(first.token)
    await sam.api.revokeInviteLink(id)
    expect(await sam.api.getInviteLink(id)).toBeNull()
    const second = await sam.api.makeInviteLink(id)
    expect(second.token).not.toBe(first.token)
    expect(w.database.tables.invites.map((i) => i.revoked)).toEqual([true, false])
  })

  it('replaces a link that ran out, turning the old one off first', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const first = await sam.api.makeInviteLink(id)
    w.database.tables.invites[0].expires_at = '2026-10-01T00:00:00.000Z'
    expect((await sam.api.getInviteLink(id)).expired).toBe(true)
    const second = await sam.api.makeInviteLink(id)
    expect(second.token).not.toBe(first.token)
    expect(second.expired).toBe(false)
  })

  it('is never shown to a guest', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    expect(await kim.api.getInviteLink(id)).toBeNull()
    await expect(kim.api.makeInviteLink(id)).rejects.toThrow("You can't do that in this session.")
  })
})

describe('opening a link', () => {
  it('shows the preview to a visitor who is not signed in, and nothing more', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const visitor = await w.open(null)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    expect(await visitor.api.previewInvite(token)).toEqual({ title: SESSION.title, date: SESSION.date, start: '12:00', end: '20:00', hostName: 'Sam' })
    expect(await visitor.api.previewInvite('not-a-token')).toBeNull()
    expect(await visitor.api.previewInvite('z'.repeat(43))).toBeNull()
  })

  it('previews nothing for a revoked link, an expired one, or one whose session was cancelled', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const visitor = await w.open(null)
    const a = await sam.api.createSession({ ...SESSION, title: 'A' })
    const revoked = (await sam.api.makeInviteLink(a.id)).token
    await sam.api.revokeInviteLink(a.id)
    const b = await sam.api.createSession({ ...SESSION, title: 'B' })
    const expired = (await sam.api.makeInviteLink(b.id)).token
    w.database.tables.invites.find((i) => i.token === expired).expires_at = '2026-10-01T00:00:00.000Z'
    const c = await sam.api.createSession({ ...SESSION, title: 'C' })
    const cancelled = (await sam.api.makeInviteLink(c.id)).token
    await sam.api.cancelSession(c.id)
    for (const token of [revoked, expired, cancelled]) expect(await visitor.api.previewInvite(token)).toBeNull()
  })

  it('joins, and both people then see each other by name', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    const joined = await kim.api.joinWithLink(token)
    expect(joined).toEqual({ sessionId: id, already: false })
    for (const app of [sam, kim]) {
      const seen = await app.api.getSession(id)
      expect(seen.members.map((m) => [m.id, m.role, m.state])).toEqual([[sam.id, 'host', 'joined'], [kim.id, 'guest', 'joined']])
      expect(seen.activeIds).toEqual([sam.id, kim.id])
      await vi.waitFor(async () => {
        const people = await app.api.listPeople()
        expect(people.map((p) => p.name)).toEqual([app === sam ? 'Kim' : 'Sam'])
      })
    }
    expect((await kim.api.listSessions()).map((s) => s.id)).toEqual([id])
    expect((await kim.api.getSession(id)).hostName).toBe('Sam')
  })

  it('tells a person who is already in the session, the host included, and does not join twice', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    expect((await sam.api.joinWithLink(token)).already).toBe(true)
    await kim.api.joinWithLink(token)
    expect(await kim.api.joinWithLink(token)).toEqual({ sessionId: id, already: true })
    expect(w.database.tables.session_members).toHaveLength(2)
  })

  it('says why a link failed, in words: revoked, expired, a cancelled session, a full session, a bad token', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const dead = 'This link no longer works. It may have expired, the host may have replaced or turned it off, or the session may already be under way.'
    const a = await sam.api.createSession({ ...SESSION, title: 'A' })
    const revoked = (await sam.api.makeInviteLink(a.id)).token
    await sam.api.revokeInviteLink(a.id)
    await expect(kim.api.joinWithLink(revoked)).rejects.toThrow(dead)
    const b = await sam.api.createSession({ ...SESSION, title: 'B' })
    const expired = (await sam.api.makeInviteLink(b.id)).token
    w.database.tables.invites.find((i) => i.token === expired).expires_at = '2026-10-01T00:00:00.000Z'
    await expect(kim.api.joinWithLink(expired)).rejects.toThrow(dead)
    const c = await sam.api.createSession({ ...SESSION, title: 'C' })
    const cancelled = (await sam.api.makeInviteLink(c.id)).token
    await sam.api.cancelSession(c.id)
    await expect(kim.api.joinWithLink(cancelled)).rejects.toThrow(dead)
    await expect(kim.api.joinWithLink('short')).rejects.toThrow(dead)
    await expect(kim.api.joinWithLink('z'.repeat(43))).rejects.toThrow(dead)
    const d = await sam.api.createSession({ ...SESSION, title: 'D' })
    const open = (await sam.api.makeInviteLink(d.id)).token
    for (let i = 0; i < 29; i += 1) {
      const user = `00000000-0000-4000-8000-0000000002${String(i).padStart(2, '0')}`
      w.database.setProfile(user, { username: `f${i}`, display_name: `F${i}`, avatar_url: null })
      await w.database.run({ as: user, kind: 'rpc', fn: 'join_session', args: { invite_token: open } })
    }
    await expect(kim.api.joinWithLink(open)).rejects.toThrow('This session is full.')
    expect(w.database.tables.session_members.filter((m) => m.user_id === kim.id)).toHaveLength(0)
  })

  it('needs a real account, and says so for a demo account', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    const demo = await boot(fakeSupabase({ database: w.watched }), {}, { shared: true })
    await demo.api.signUp({ ...DEMO })
    await expect(demo.api.joinWithLink(token)).rejects.toThrow('Log in with a Jio account to join.')
    expect(w.database.tables.session_members).toHaveLength(1)
  })
})

describe('what a person is not shown', () => {
  it('sees only the sessions they are in, and "does not exist" for another\'s', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    expect(await kim.api.listSessions()).toEqual([])
    await expect(kim.api.getSession(id)).rejects.toMatchObject({ message: 'This session does not exist.', code: 'not_found' })
  })

  it('does not see the session of the account that was signed in before', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    await sam.api.createSession({ ...SESSION })
    expect(await sam.api.listSessions()).toHaveLength(1)
    await sam.api.signOut()
    const kim = await sam.api.signUp({ ...OTHER })
    expect(kim.id).not.toBe(sam.id)
    expect(await sam.api.listSessions()).toEqual([])
  })

  it('leaves the demo account on the local data layer, writing nothing to the database', async () => {
    const w = world()
    const demo = await boot(fakeSupabase({ database: w.watched, memoryOnly: true }), {}, { shared: true })
    await demo.api.signUp({ ...DEMO })
    const made = await demo.api.createSession({ ...SESSION })
    expect(made.id).toBe('s1')
    expect(made.remote).toBeUndefined()
    expect(made.hostId).toBe('ian')
    await demo.api.inviteFriends(made.id, ['darius'])
    expect((await demo.api.startSession(made.id)).status).toBe('locating')
    expect(w.database.tables.sessions).toHaveLength(0)
    expect(w.ops.filter((op) => op.table)).toEqual([])
  })
})

describe('leaving and removing go through the Jio server', () => {
  it('asks the server to let the signed-in person leave, and sends the guest\'s id to remove a guest', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    // The server's work: delete the row with the service key.
    server.answer = async (sessionId, who) => {
      const person = who === 'me' ? kim.id : who
      await w.database.run({ as: 'service', kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: sessionId }, { col: 'user_id', op: 'eq', value: person }] })
      return { planVersion: 1 }
    }
    await kim.api.leaveSession(id)
    expect(server.calls).toEqual([[id, 'me']])
    expect((await sam.api.getSession(id)).members.map((m) => m.id)).toEqual([sam.id])
    await expect(kim.api.getSession(id)).rejects.toMatchObject({ code: 'not_found' })
    // Back in, then taken out by the host.
    await kim.api.joinWithLink((await sam.api.getInviteLink(id)).token)
    server.calls.length = 0
    const after = await sam.api.removeFromSession(id, kim.id)
    expect(server.calls).toEqual([[id, kim.id]])
    expect(after.members.map((m) => m.id)).toEqual([sam.id])
  })

  it('turns the server\'s refusals into sentences', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const refuse = (code, message = 'raw text') => {
      server.answer = async () => {
        throw Object.assign(new Error(message), { code })
      }
    }
    refuse('host_cannot_leave')
    await expect(sam.api.leaveSession(id)).rejects.toThrow('The host cannot leave. Cancel the session instead.')
    refuse('host_only')
    await expect(sam.api.removeFromSession(id, 'someone')).rejects.toThrow('Only the host can remove someone.')
    refuse('session_not_found')
    await expect(sam.api.leaveSession(id)).rejects.toThrow('This session does not exist, or you are not in it.')
    refuse('session_closed')
    await expect(sam.api.leaveSession(id)).rejects.toThrow('This session has ended.')
    refuse('member_not_found')
    await expect(sam.api.removeFromSession(id, 'someone')).rejects.toThrow('That person is not in this session any more.')
    refuse('session_started')
    await expect(sam.api.leaveSession(id)).rejects.toThrow("You can't leave once voting has started; ask the host to cancel.")
    await expect(sam.api.removeFromSession(id, 'someone')).rejects.toThrow("You can't remove someone once voting has started; cancel the session instead.")
    refuse('not_yet')
    await expect(sam.api.leaveSession(id)).rejects.toThrow("That isn't possible once voting has started.")
    // Anything else keeps the server's own sentence (no connection, over the limit).
    refuse(undefined, 'Too many requests. Wait a few seconds and try again.')
    await expect(sam.api.leaveSession(id)).rejects.toThrow('Too many requests. Wait a few seconds and try again.')
  })
})

describe('invitations by username', () => {
  it('searches the server for people by the start of a username, and invites the person who is found', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    // Text that cannot start a username asks nobody.
    for (const text of ['', 'ki', ' @k ', 'kim tan', 'kim.tan', 'k'.repeat(21)]) expect(await sam.api.searchPeople(text)).toEqual([])
    expect(planner.searchPeopleByUsername).not.toHaveBeenCalled()
    // The server is asked with the cleaned term, and its answer is the screen's person: a photo from elsewhere is not shown.
    planner.searchPeopleByUsername.mockResolvedValueOnce([
      { id: kim.id, name: 'Kim', username: 'kim', avatarUrl: 'https://tracker.example.test/p.png', metBefore: true },
      { id: 'other', name: 'Kimberly', username: 'kimberly', avatarUrl: '', metBefore: false },
    ])
    const controller = new AbortController()
    const found = await sam.api.searchPeople(' @Kim ', { signal: controller.signal })
    expect(planner.searchPeopleByUsername).toHaveBeenCalledWith('kim', { signal: controller.signal })
    expect(found).toEqual([
      { id: kim.id, name: 'Kim', username: 'kim', avatarUrl: '', metBefore: true },
      { id: 'other', name: 'Kimberly', username: 'kimberly', avatarUrl: '', metBefore: false },
    ])
    // No read of the profiles table from the browser.
    expect(w.ops.filter((op) => op.table === 'profiles' && op.filters?.some((f) => f.col === 'username'))).toEqual([])
    const invited = await sam.api.inviteByUsername(id, found[0].id)
    expect(invited.members.map((m) => [m.id, m.state])).toEqual([[sam.id, 'joined'], [kim.id, 'invited']])
    expect(invited.activeIds).toEqual([sam.id])
    await expect(sam.api.inviteByUsername(id, found[0].id)).rejects.toThrow('You have already invited that person.')
  })

  it('passes the server\'s failure on as its sentence', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    planner.searchPeopleByUsername.mockRejectedValueOnce(new Error('Too many requests. Wait a few seconds and try again.'))
    await expect(sam.api.searchPeople('kim')).rejects.toThrow('Too many requests. Wait a few seconds and try again.')
  })

  it('shows the invitation to the person invited, who can accept it or decline it, and sees nothing of the session before', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const lee = await w.open(THIRD)
    const { id } = await sam.api.createSession({ ...SESSION })
    await sam.api.inviteByUsername(id, kim.id)
    await sam.api.inviteByUsername(id, lee.id)
    expect(await kim.api.listSessions()).toEqual([])
    await expect(kim.api.getSession(id)).rejects.toMatchObject({ code: 'not_found' })
    const [mine] = await kim.api.listInvitations()
    expect(mine).toMatchObject({ title: SESSION.title, start: '12:00', end: '20:00', hostName: 'Sam' })
    expect(Object.keys(mine).sort()).toEqual(['end', 'hostName', 'invitedAt', 'start', 'date', 'title', 'token'].sort())
    expect(await sam.api.listInvitations()).toEqual([])
    const { sessionId } = await kim.api.joinWithLink(mine.token)
    expect(sessionId).toBe(id)
    expect(await kim.api.listInvitations()).toEqual([])
    expect((await sam.api.getSession(id)).members.map((m) => [m.id, m.state])).toEqual([[sam.id, 'joined'], [kim.id, 'joined'], [lee.id, 'invited']])
    // Lee says no: gone from their list, and from the host's list of invited people.
    const [theirs] = await lee.api.listInvitations()
    await lee.api.declineInvitation(theirs.token)
    expect(await lee.api.listInvitations()).toEqual([])
    expect((await sam.api.getSession(id)).members.map((m) => m.id)).toEqual([sam.id, kim.id])
  })

  it('does not offer another person\'s invitation to anyone else', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const lee = await w.open(THIRD)
    const { id } = await sam.api.createSession({ ...SESSION })
    await sam.api.inviteByUsername(id, kim.id)
    const [mine] = await kim.api.listInvitations()
    await expect(lee.api.joinWithLink(mine.token)).rejects.toThrow('This link no longer works.')
    expect(await lee.api.previewInvite(mine.token)).toBeNull()
  })
})

describe('live updates', () => {
  // Collect the events a copy of the app tells its screens.
  // How to call: const heard = listen(app)
  function listen(app) {
    const heard = []
    const stop = app.api.subscribe((event) => heard.push(event))
    return { heard, stop }
  }
  const types = (heard) => heard.map((e) => e.type)

  it('tells the host when someone joins, then when they go, and the guest when the host renames or cancels', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    const link = await sam.api.makeInviteLink(id)
    const host = listen(sam)
    const stopHost = sam.api.watchSessions()
    await vi.waitFor(() => expect(types(host.heard)).toContain('resync'))
    host.heard.length = 0

    await kim.api.joinWithLink(link.token)
    await vi.waitFor(() => expect(host.heard.filter((e) => e.type === 'session' && e.sessionId === id).length).toBeGreaterThan(0))
    // Both rows that changed (the member and the link's use count) are one read of the session.
    expect((await sam.api.getSession(id)).members.map((m) => m.id)).toEqual([sam.id, kim.id])

    const stopGuest = kim.api.watchSessions()
    const guest = listen(kim)
    await vi.waitFor(() => expect(types(guest.heard)).toContain('resync'))
    guest.heard.length = 0
    await sam.api.updateSession(id, { ...SESSION, title: 'Renamed' })
    await vi.waitFor(() => expect(guest.heard.some((e) => e.type === 'session' && e.sessionId === id)).toBe(true))
    expect((await kim.api.getSession(id)).title).toBe('Renamed')

    guest.heard.length = 0
    await sam.api.cancelSession(id)
    await vi.waitFor(() => expect(guest.heard.some((e) => e.type === 'session' && e.sessionId === id)).toBe(true))
    expect((await kim.api.getSession(id)).status).toBe('cancelled')
    stopHost()
    stopGuest()
  })

  it('tells the guest, and the host, when the guest\'s row is deleted', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    // Both have read the session, so it is one they know: a delete in a session an account does not know is ignored.
    await sam.api.getSession(id)
    await kim.api.getSession(id)
    const host = listen(sam)
    const guest = listen(kim)
    const stops = [sam.api.watchSessions(), kim.api.watchSessions()]
    await vi.waitFor(() => expect(types(host.heard)).toContain('resync'))
    await vi.waitFor(() => expect(types(guest.heard)).toContain('resync'))
    host.heard.length = 0
    guest.heard.length = 0
    await w.database.run({ as: 'service', kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'user_id', op: 'eq', value: kim.id }] })
    await vi.waitFor(() => expect(guest.heard).toContainEqual({ type: 'session-gone', sessionId: id }))
    await vi.waitFor(() => expect(host.heard).toContainEqual({ type: 'session', sessionId: id }))
    stops.forEach((stop) => stop())
  })

  it('tells an invitee about a new invitation', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    const guest = listen(kim)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(types(guest.heard)).toContain('resync'))
    guest.heard.length = 0
    await sam.api.inviteByUsername(id, kim.id)
    await vi.waitFor(() => expect(types(guest.heard)).toContain('invitations'))
    stop()
  })

  it('keeps one channel for all the screens that watch, and closes it when the last has gone', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    sam.api.sessionsWatch.graceMs = 0
    const channels = () => sam.fake.state.dataClient.getChannels().length
    expect(channels()).toBe(0)
    const stopHome = sam.api.watchSessions()
    const stopLobby = sam.api.watchSessions()
    expect(channels()).toBe(1)
    stopHome()
    stopHome()
    expect(channels()).toBe(1)
    stopLobby()
    // A channel leaves asynchronously (the server acknowledges), then is torn down.
    await vi.waitFor(() => expect(channels()).toBe(0))
    // Visiting again and again leaves nothing behind.
    for (let i = 0; i < 5; i += 1) sam.api.watchSessions()()
    await vi.waitFor(() => expect(channels()).toBe(0))
  })

  it('holds the channel open for a moment after the last screen has gone, so moving between screens keeps it', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    sam.api.sessionsWatch.graceMs = 60
    const channels = () => sam.fake.state.dataClient.getChannels()
    const stop = sam.api.watchSessions()
    const [first] = channels()
    stop()
    const stopNext = sam.api.watchSessions()
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(channels()).toEqual([first])
    stopNext()
    await vi.waitFor(() => expect(channels()).toEqual([]))
  })

  it('closes the channel when the account changes, and opens one for the next account if a screen is still watching', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    sam.api.sessionsWatch.graceMs = 0
    const channels = () => sam.fake.state.dataClient.getChannels().length
    const stop = sam.api.watchSessions()
    expect(channels()).toBe(1)
    await sam.api.signOut()
    await vi.waitFor(() => expect(channels()).toBe(0))
    await sam.api.signUp({ ...OTHER })
    expect(channels()).toBe(1)
    stop()
    await vi.waitFor(() => expect(channels()).toBe(0))
  })

  it('watches nothing for the demo account', async () => {
    const w = world()
    const demo = await boot(fakeSupabase({ database: w.watched, memoryOnly: true }), {}, { shared: true })
    await demo.api.signUp({ ...DEMO })
    const stop = demo.api.watchSessions()
    expect(w.database.tables.sessions).toHaveLength(0)
    stop()
  })
})
