// The small pieces of the shared-session code: the sentences a refusal becomes, the checks on a username and a link's token,
// what the data layer does with no client or nobody signed in, and the events store's part (invitations, a session the person is
// no longer in, forgetting everything when the account changes). No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { createSessionsRemote, looksLikeToken, plain, WORDS } from '../sessionsRemote.js'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { createDatabase } from '../../components/dev/fakeDatabase.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), removeSessionMember: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

describe('plain: a refusal as a sentence', () => {
  it('says each known case in words and keeps the code', () => {
    expect(plain({ code: 'P0002', message: 'This invite link is no longer valid.' }).message).toBe(WORDS.linkDead)
    expect(plain({ code: 'P0001', hint: 'session_full', message: 'This session is full.' }).message).toBe('This session is full.')
    expect(plain({ code: '28000', message: 'Sign in to join a session.' }).message).toBe('Log in to do that.')
    expect(plain({ code: '23505', message: 'duplicate key value violates unique constraint "invites_one_live_link_idx"' }).message).toBe('This session already has a link. Reload to see it.')
    expect(plain({ code: '23505', message: 'duplicate key value violates unique constraint "invites_one_per_invitee_idx"' }).message).toBe("You have already invited that person. Send them the session's link instead.")
    expect(plain({ code: '23514', message: 'new row for relation "sessions" violates check constraint' }).message).toBe('That is not allowed. Check the title, day and times.')
    // The database's own sentences for a day or start that has passed are shown as they are.
    expect(plain({ code: '23514', message: 'That day has passed.' }).message).toBe('That day has passed.')
    expect(plain({ code: '23514', message: 'That start time has already passed today.' }).message).toBe('That start time has already passed today.')
    expect(plain({ code: 'P0002', message: 'x' }).code).toBe('P0002')
  })

  it('shows a trigger\'s own sentence, but never the generic words of a refusal', () => {
    expect(plain({ code: '42501', message: 'The date and times can only change before the session starts.' }).message).toBe('The date and times can only change before the session starts.')
    expect(plain({ code: '42501', message: 'new row violates row-level security policy for table "invites"' }).message).toBe("You can't do that in this session.")
    expect(plain({ code: '42501', message: 'permission denied for table session_members' }).message).toBe("You can't do that in this session.")
  })

  it('says Jio could not be reached for a lost connection, and uses the fallback for anything else', () => {
    expect(plain({ status: 0, message: 'TypeError: Failed to fetch' }).message).toBe(WORDS.offline)
    expect(plain({ message: 'Failed to fetch' }).message).toBe(WORDS.offline)
    expect(plain({ code: 'XX000', message: 'boom: select * from secrets' }, 'That could not be saved. Try again.').message).toBe('That could not be saved. Try again.')
    expect(plain(null).message).toBe(WORDS.notSaved)
  })

  it('never lets database wording through', () => {
    for (const raw of ['duplicate key value violates', 'relation "public.sessions" does not exist', 'JWT expired', 'column x does not exist']) {
      expect(plain({ code: 'XX000', message: raw }).message).not.toContain(raw)
    }
  })
})

describe('the checks on what a person types or opens', () => {
  it('takes a link\'s token only in the shape the database makes', () => {
    expect(looksLikeToken('q'.repeat(43))).toBe(true)
    expect(looksLikeToken('abc_-DEF'.repeat(5))).toBe(true)
    for (const bad of ['', 'short', 'q'.repeat(65), `${'q'.repeat(42)}/`, `${'q'.repeat(42)} `, '../etc/passwd'.padEnd(43, 'x'), null, 7]) expect(looksLikeToken(bad)).toBe(false)
  })
})

describe('with no client, or nobody signed in', () => {
  it('says Jio could not be reached when there is no client, and asks to log in when nobody is signed in', async () => {
    const none = createSessionsRemote({ client: () => null, me: () => 'u1' })
    await expect(none.list()).rejects.toMatchObject({ message: WORDS.offline })
    await expect(none.preview('q'.repeat(43))).rejects.toMatchObject({ message: WORDS.offline })
    const nobody = createSessionsRemote({ client: () => ({}), me: () => '' })
    await expect(nobody.list()).rejects.toMatchObject({ message: WORDS.signedOut })
    await expect(nobody.makeLink('s')).rejects.toMatchObject({ message: WORDS.signedOut })
    await expect(nobody.join('q'.repeat(43))).rejects.toMatchObject({ message: WORDS.signedOut })
  })

  it('sends nothing for a token that cannot be a link, and has nothing to listen to on a client with no channels', async () => {
    const calls = []
    const client = { rpc: async (...a) => (calls.push(a), { data: [], error: null }), from: () => ({}) }
    const remote = createSessionsRemote({ client: () => client, me: () => 'u1' })
    expect(await remote.preview('not a token')).toBeNull()
    await expect(remote.join('nope')).rejects.toMatchObject({ code: 'P0002' })
    expect(calls).toEqual([])
    expect(remote.watch(() => {})).toBeTypeOf('function')
  })

  it('wraps a failed read in a sentence and keeps the database\'s words out of it', async () => {
    const client = { from: () => ({ select: () => ({ order: async () => ({ data: null, error: { code: 'XX000', message: 'relation "public.sessions" does not exist' } }) }) }) }
    const remote = createSessionsRemote({ client: () => client, me: () => 'u1' })
    await expect(remote.list()).rejects.toMatchObject({ message: WORDS.notLoaded })
  })
})

describe('the events store', () => {
  async function store(app) {
    setActivePinia(createPinia())
    return (await import('@/stores/events.js')).useEventsStore()
  }
  async function open(database, profile) {
    const fake = fakeSupabase({ database, memoryOnly: true })
    const app = await boot(fake, {}, { shared: true })
    const user = await app.api.signUp({ ...profile })
    return { ...app, fake, user }
  }

  it('drops a session the person is no longer in, marks it gone, and brings it back when they join again', async () => {
    const database = createDatabase({ profiles: {} })
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    const kim = await open(database, OTHER)
    const events = await store(kim)
    await kim.api.joinWithLink(token)
    await events.loadSessions()
    expect(events.byId[id]).toBeTruthy()
    events.dropSession(id)
    expect(events.byId[id]).toBeUndefined()
    expect(events.sessions).toEqual([])
    expect(events.gone[id]).toBe(true)
    await events.loadSession(id)
    expect(events.gone[id]).toBeUndefined()
    expect(events.byId[id].title).toBe(SESSION.title)
  })

  it('reads invitations, takes one out when it is declined or accepted, and joins the session on accepting', async () => {
    const database = createDatabase({ profiles: {} })
    const kim = await open(database, OTHER)
    const sam = await open(database, PROFILE)
    const a = await sam.api.createSession({ ...SESSION, title: 'A' })
    const b = await sam.api.createSession({ ...SESSION, title: 'B', date: '2026-10-11' })
    await sam.api.inviteByUsername(a.id, kim.user.id)
    await sam.api.inviteByUsername(b.id, kim.user.id)
    const again = await boot(kim.fake, {}, { shared: true })
    const events = await store()
    await again.api.getUser()
    await events.loadInvitations()
    expect(events.invitations.map((i) => i.title)).toEqual(['B', 'A'])
    await events.declineInvitation(events.invitations[0])
    expect(events.invitations.map((i) => i.title)).toEqual(['A'])
    const joined = await events.acceptInvitation(events.invitations[0])
    expect(joined.title).toBe('A')
    expect(events.invitations).toEqual([])
    expect(events.byId[a.id].members.map((m) => m.state)).toEqual(['joined', 'joined'])
  })

  it('forgets the invitations, the list and what is gone when the account changes', async () => {
    const database = createDatabase({ profiles: {} })
    const kim = await open(database, OTHER)
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    await sam.api.inviteByUsername(id, kim.user.id)
    const again = await boot(kim.fake, {}, { shared: true })
    const events = await store()
    await again.api.getUser()
    await events.loadInvitations()
    events.dropSession('somewhere')
    expect(events.invitations).toHaveLength(1)
    await again.api.signOut()
    await vi.waitFor(() => expect(events.invitations).toEqual([]))
    expect(events.gone).toEqual({})
    expect(events.sessions).toEqual([])
    expect(events.invitationsLoaded).toBe(false)
  })
})
