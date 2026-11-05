// What the independent review of stage 2 found, each as a test that failed before its fix:
//   1. live updates survive ordinary navigation (a screen left and the next drawn in one tick) and a sign-out and sign-in as the
//      same person, on a stand-in that has realtime-js's channels (dedupe by topic, asynchronous leaving);
//   2. a "resync" (the channel connected, or the tab came back) reads every session the store holds, so a cancel, a removal or a
//      new member missed in the meantime shows;
//   3. a delete of a member row in a session this account does not know does nothing, and marks nothing gone;
//   4. a read still running when the account changes never fills the next account's caches;
//   7. the invite functions do nothing for a demo account, a person who left is dropped from the people the account knows, long
//      lists are read in chunks, and the host hears about their own invitations.
// Several people each use their own copy of the app on ONE stand-in database. No network.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const server = vi.hoisted(() => ({ calls: [], effect: null }))
const planner = vi.hoisted(() => ({
  api: { defaults: {} },
  meetingArea: vi.fn(),
  rankSlot: vi.fn(),
  searchSlot: vi.fn(),
  removeSessionMember: vi.fn(async (...args) => {
    server.calls.push(args)
    await server.effect?.(...args)
    return { planVersion: 1 }
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
  server.effect = null
})
afterEach(() => vi.unstubAllGlobals())

const settle = (ms = 25) => new Promise((resolve) => setTimeout(resolve, ms))

// One database, and a way to open the app on it as someone. Every request is recorded in `ops`, and a request can be held open
// (`gate`) until a test lets it go: `gate.hold = (op) => op.table === 'sessions'`, then `gate.release()`.
// How to call: const w = world(); const sam = await w.open(PROFILE)
function world() {
  const database = createDatabase({ profiles: {} })
  const ops = []
  const gate = { hold: null, release: null, waiting: 0 }
  const watched = {
    ...database,
    run: async (op) => {
      ops.push(op)
      if (gate.hold?.(op)) {
        gate.waiting += 1
        await new Promise((resolve) => (gate.release = resolve))
      }
      return database.run(op)
    },
  }
  return {
    database,
    ops,
    gate,
    async open(profile, options = {}) {
      const fake = fakeSupabase({ database: watched, memoryOnly: true, ...options })
      const app = await boot(fake, {}, { shared: true })
      const user = profile ? await app.api.signUp({ ...profile }) : null
      return { ...app, fake, user }
    },
  }
}

// A host, a session and its link.
// How to call: const { sam, id, token } = await hosted(w)
async function hosted(w) {
  const sam = await w.open(PROFILE)
  const { id } = await sam.api.createSession({ ...SESSION })
  const { token } = await sam.api.makeInviteLink(id)
  return { sam, id, token }
}

// What a copy of the app tells its screens.
// How to call: const heard = listen(app)
function listen(app) {
  const heard = []
  app.api.subscribe((event) => heard.push(event))
  return heard
}
const sessionEvents = (heard, id) => heard.filter((e) => e.type === 'session' && e.sessionId === id)

async function storeFor() {
  setActivePinia(createPinia())
  return (await import('@/stores/events.js')).useEventsStore()
}

describe('1. live updates survive navigation and signing in again', () => {
  // With no grace time the channel is closed and opened again; with it, it simply stays.
  it.each([0, 800])('keeps hearing changes when one screen is left and the next is drawn in the same tick (grace %i ms)', async (graceMs) => {
    const w = world()
    const { sam, id, token } = await hosted(w)
    sam.api.sessionsWatch.graceMs = graceMs
    const kim = await w.open(OTHER)
    const heard = listen(sam)
    let stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    // The router unmounts the old screen and mounts the new one: the watchers go 1, 0, 1 within one tick.
    stop()
    stop = sam.api.watchSessions()
    await settle(100)
    heard.length = 0
    await kim.api.joinWithLink(token)
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    stop()
  })

  it('keeps hearing changes after many such navigations in a row, and leaves no channel behind at the end', async () => {
    const w = world()
    const { sam, id, token } = await hosted(w)
    sam.api.sessionsWatch.graceMs = 0
    const kim = await w.open(OTHER)
    const heard = listen(sam)
    let stop = sam.api.watchSessions()
    for (let i = 0; i < 6; i += 1) {
      stop()
      stop = sam.api.watchSessions()
    }
    await settle(100)
    heard.length = 0
    await kim.api.joinWithLink(token)
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    expect(sam.fake.state.dataClient.getChannels().length).toBeLessThanOrEqual(1)
    stop()
    await vi.waitFor(() => expect(sam.fake.state.dataClient.getChannels()).toEqual([]))
  })

  it('keeps hearing changes after the same person signs out and in again while a screen is still watching', async () => {
    const w = world()
    const sam = await w.open(PROFILE, { realtimeLeaveMs: 400 })
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    const kim = await w.open(OTHER)
    const heard = listen(sam)
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    await sam.api.signOut()
    await sam.api.signIn({ email: PROFILE.email, password: PROFILE.password })
    // Long enough for the old channel's leave to be acknowledged and the channel torn down.
    await settle(700)
    heard.length = 0
    await kim.api.joinWithLink(token)
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    stop()
  })
})

describe('2. a resync reads every session the store holds', () => {
  it('shows a rename and a new member that were missed while away, on a page opened by its address', async () => {
    const w = world()
    const { sam, id, token } = await hosted(w)
    const kim = await w.open(OTHER)
    await kim.api.joinWithLink(token)
    const lee = await w.open(THIRD)
    // Profiles cannot be read, so no "people" event loads the list behind this test's back: only the address's one session is held.
    kim.fake.state.options.readError = true
    const again = await boot(kim.fake, {}, { shared: true })
    await again.api.getUser()
    // The people in the session are known (and announced) before the store exists, so reading it makes no "people" event.
    await again.api.getSession(id)
    const events = await storeFor()
    // The page was opened by its address: only this one session was read, never the list (`loaded` stays false).
    await events.loadSession(id)
    expect(events.loaded).toBe(false)
    expect(events.byId[id].title).toBe(SESSION.title)
    // While the tab was hidden: the host renamed it and a third person joined.
    await sam.api.updateSession(id, { ...SESSION, title: 'Renamed while away' })
    await lee.api.joinWithLink(token)
    const stop = again.api.watchSessions()
    await vi.waitFor(() => expect(events.byId[id].title).toBe('Renamed while away'))
    await vi.waitFor(() => expect(events.byId[id].members).toHaveLength(3))
    stop()
  })

  it('tells a person who was removed while away that they are not in the session any more', async () => {
    const w = world()
    const { id, token } = await hosted(w)
    const kim = await w.open(OTHER)
    await kim.api.joinWithLink(token)
    kim.fake.state.options.readError = true
    await kim.api.getSession(id)
    const events = await storeFor()
    await events.loadSession(id)
    expect(events.loaded).toBe(false)
    await w.database.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'user_id', op: 'eq', value: kim.user.id }] })
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(events.gone[id]).toBe(true))
    expect(events.byId[id]).toBeUndefined()
    stop()
  })

  it('shows a cancel that was missed, with the list loaded as well', async () => {
    const w = world()
    const { sam, id, token } = await hosted(w)
    const kim = await w.open(OTHER)
    await kim.api.joinWithLink(token)
    const events = await storeFor()
    await events.loadSessions()
    await sam.api.cancelSession(id)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(events.byId[id].status).toBe('cancelled'))
    stop()
  })
})

describe('3. a delete in a session this account does not know is ignored', () => {
  it('makes no reads and marks nothing gone, but still follows a delete in a session it is in', async () => {
    const w = world()
    const { sam, id, token } = await hosted(w)
    const kim = await w.open(OTHER)
    await kim.api.joinWithLink(token)
    const lee = await w.open(THIRD)
    // A session of Sam's that Lee is in and Kim is not.
    const other = await sam.api.createSession({ ...SESSION, title: 'Not Kim\'s', date: '2026-10-11' })
    await lee.api.joinWithLink((await sam.api.makeInviteLink(other.id)).token)
    const again = await boot(kim.fake, {}, { shared: true })
    await again.api.getUser()
    const events = await storeFor()
    await events.loadSessions()
    const stop = again.api.watchSessions()
    await vi.waitFor(() => expect(w.ops.some((op) => op.kind === 'rpc' || op.table === 'sessions')).toBe(true))
    await settle(80)
    const mine = (op) => op.as === kim.user.id
    const before = w.ops.filter(mine).length
    await w.database.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: other.id }, { col: 'user_id', op: 'eq', value: lee.user.id }] })
    await settle(150)
    expect(w.ops.filter(mine).length).toBe(before)
    expect(events.gone[other.id]).toBeUndefined()
    expect(events.gone).toEqual({})
    // A delete in a session Kim is in is read again, as before.
    await w.database.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'user_id', op: 'eq', value: sam.user.id }] })
    await vi.waitFor(() => expect(w.ops.filter(mine).length).toBeGreaterThan(before))
    stop()
  })

  it('never marks a session it never knew as gone, even if told its member went', () => {
    return storeFor().then((events) => {
      events.dropSession('3b1f0000-0000-4000-8000-000000000000')
      expect(events.gone).toEqual({})
    })
  })
})

describe('4. a read still running when the account changes writes nothing for the next account', () => {
  it('drops a session list that was read for the account before, and does not fill the friends of the next', async () => {
    const w = world()
    const { sam, id, token } = await hosted(w)
    const kim = await w.open(OTHER)
    await kim.api.joinWithLink(token)
    // Sam's app again; the first read of the list is held open.
    const again = await boot(sam.fake, {}, { shared: true })
    await again.api.getUser()
    w.gate.hold = (op) => op.kind === 'select' && op.table === 'sessions'
    const held = again.api.listSessions()
    await vi.waitFor(() => expect(w.gate.waiting).toBe(1))
    w.gate.hold = null
    // The account changes while the read is out.
    await again.api.signOut()
    await again.api.signUp({ ...THIRD })
    w.gate.release()
    expect(await held).toEqual([])
    // Nothing of Sam's session reached what the new account knows: no friends from it.
    expect(await again.api.listPeople()).toEqual([])
    expect(id).toBeTruthy()
  })

  it('drops one session read for the account before', async () => {
    const w = world()
    const { sam, id } = await hosted(w)
    const again = await boot(sam.fake, {}, { shared: true })
    await again.api.getUser()
    w.gate.hold = (op) => op.kind === 'select' && op.table === 'sessions'
    const held = again.api.getSession(id).catch((e) => e)
    await vi.waitFor(() => expect(w.gate.waiting).toBe(1))
    w.gate.hold = null
    await again.api.signOut()
    await again.api.signUp({ ...THIRD })
    w.gate.release()
    expect(await held).toBeInstanceOf(Error)
    expect(await again.api.listPeople()).toEqual([])
    // A session that does not exist for this account is not the same error as one read for another account.
    await expect(again.api.getSession(id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('keeps the events store from showing the list, or the invitations, of the account before', async () => {
    const w = world()
    const kim = await w.open(OTHER)
    const { sam, id } = await hosted(w)
    await sam.api.inviteByUsername(id, kim.user.id)
    const mine = await boot(kim.fake, {}, { shared: true })
    await mine.api.getUser()
    const events = await storeFor()
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'sessions') || (op.kind === 'rpc' && op.fn === 'my_invitations')
    const list = events.loadSessions()
    const invitations = events.loadInvitations()
    await vi.waitFor(() => expect(w.gate.waiting).toBeGreaterThan(0))
    w.gate.hold = null
    await mine.api.signOut()
    await mine.api.signUp({ ...THIRD })
    w.gate.release()
    await Promise.allSettled([list, invitations])
    await settle(60)
    expect(events.invitations).toEqual([])
    expect(events.sessions).toEqual([])
    expect(events.invitationsLoaded).toBe(false)
  })
})

describe('7. the invite functions, the people, long lists and the host\'s own invitations', () => {
  it('does nothing for a demo account: no request leaves, and each says what to do', async () => {
    const w = world()
    const demo = await boot(fakeSupabase({ database: { ...w.database, run: (op) => (w.ops.push(op), w.database.run(op)) }, memoryOnly: true }), {}, { shared: true })
    await demo.api.signUp({ ...DEMO })
    const calls = [
      () => demo.api.getInviteLink('s1'),
      () => demo.api.makeInviteLink('s1'),
      () => demo.api.revokeInviteLink('s1'),
      () => demo.api.inviteByUsername('s1', 'darius'),
      () => demo.api.declineInvitation('q'.repeat(43)),
      () => demo.api.leaveSession('s1'),
      () => demo.api.removeFromSession('s1', 'darius'),
    ]
    for (const call of calls) await expect(call()).rejects.toThrow('Shared sessions need a Jio account. Log in with one.')
    expect(w.ops).toEqual([])
    expect(planner.removeSessionMember).not.toHaveBeenCalled()
  })

  it('drops a person from the people the account knows when they leave or are removed, and the account\'s own session when it leaves', async () => {
    const w = world()
    const { sam, id, token } = await hosted(w)
    const kim = await w.open(OTHER)
    await kim.api.joinWithLink(token)
    server.effect = async (sessionId, who) => {
      const person = who === 'me' ? kim.user.id : who
      await w.database.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: sessionId }, { col: 'user_id', op: 'eq', value: person }] })
    }
    await sam.api.getSession(id)
    await kim.api.getSession(id)
    await vi.waitFor(async () => expect((await sam.api.listPeople()).map((p) => p.name)).toEqual(['Kim']))
    await vi.waitFor(async () => expect((await kim.api.listPeople()).map((p) => p.name)).toEqual(['Sam']))
    // The host removes Kim: Kim is no longer someone Sam shares a session with.
    await sam.api.removeFromSession(id, kim.user.id)
    expect(await sam.api.listPeople()).toEqual([])
    // Kim, who had joined, rejoins and leaves: Sam is no longer someone Kim shares a session with.
    await kim.api.joinWithLink(token)
    await kim.api.getSession(id)
    expect((await kim.api.listPeople()).map((p) => p.name)).toEqual(['Sam'])
    await kim.api.leaveSession(id)
    expect(await kim.api.listPeople()).toEqual([])
  })

  // One person cannot be in two meetups at once, so 250 sessions of one host are 250 one-minute slots from midnight.
  const minuteOfDay = (n) => `${String(Math.floor(n / 60)).padStart(2, '0')}:${String(n % 60).padStart(2, '0')}`
  it('reads the members and invitations of a long list in chunks of at most 100 sessions', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    for (let i = 0; i < 250; i += 1) {
      const made = await w.database.run({ as: sam.user.id, kind: 'insert', table: 'sessions', values: { host_id: sam.user.id, title: `S${i}`, date: SESSION.date, start_time: minuteOfDay(i), end_time: minuteOfDay(i + 1) }, returning: false })
      expect(made.error).toBeNull()
    }
    w.ops.length = 0
    const list = await sam.api.listSessions()
    expect(list).toHaveLength(250)
    expect(list.every((s) => s.members.length === 1)).toBe(true)
    for (const table of ['session_members', 'invites']) {
      const reads = w.ops.filter((op) => op.kind === 'select' && op.table === table)
      expect(reads).toHaveLength(3)
      for (const read of reads) expect(read.filters[0].value.length).toBeLessThanOrEqual(100)
      expect(reads.flatMap((r) => r.filters[0].value).sort()).toEqual(list.map((s) => s.id).sort())
    }
  })

  it('tells the host when an invitation they made is declined, or the link is turned off on another device', async () => {
    const w = world()
    const { sam, id } = await hosted(w)
    const kim = await w.open(OTHER)
    await sam.api.inviteByUsername(id, kim.user.id)
    const heard = listen(sam)
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    await settle(60)
    heard.length = 0
    const [invitation] = await kim.api.listInvitations()
    await kim.api.declineInvitation(invitation.token)
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    heard.length = 0
    // Another device of the host turns the link off.
    await w.database.run({ as: sam.user.id, kind: 'update', table: 'invites', values: { revoked: true }, filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'invitee_id', op: 'is', value: null }], returning: false })
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    stop()
  })
})
