// What must hold when the signed-in person changes, and what must not be written when nobody is signed in:
//  - the stores keep nothing per session from the last account when another logs in with no sign-out between (another tab);
//  - one read for the real people of every session, "Someone" and never a blank, and no name sent to the planner;
//  - no write under an empty id; "You" chosen by id; the made-up account and the client swap kept out of a real session.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { STORAGE_KEY, stubPlanner } from './planFixture.js'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { AREAS } from '../mock/places.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.setConfig({ testTimeout: 60000 })

const UID9 = '00000000-0000-4000-8000-000000000009'
const UID8 = '00000000-0000-4000-8000-000000000008'
const UID7 = '00000000-0000-4000-8000-000000000007'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => stubPlanner(planner))
afterEach(() => vi.unstubAllGlobals())

// What a store holds for a session id.
const holds = (object, id) => Object.prototype.hasOwnProperty.call(object, id)

describe('another account logs in with no sign-out between (another tab)', () => {
  // Every account's first session is `s1`. Account X has loaded the itinerary, the photos, the plan and the suggested order of
  // its `s1`; then account Y logs in from another tab, so this tab sees a change of person and never a sign-out.
  async function setUp() {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    const { useEventsStore } = await import('@/stores/events.js')
    const { usePlannerStore } = await import('@/stores/planner.js')
    const { useGroupsStore } = await import('@/stores/groups.js')
    const auth = useAuthStore()
    const events = useEventsStore()
    const plans = usePlannerStore()
    const groups = useGroupsStore()

    // Y exists, with a session of its own that is also `s1`.
    await auth.signUpAs({ ...OTHER, username: 'kim_two' })
    const y = auth.myId
    await events.create({ ...SESSION, title: 'Kim only' })
    await auth.signOut()

    // X signs in and fills its caches.
    await auth.signUpAs({ ...PROFILE })
    const x = auth.myId
    await events.create({ ...SESSION, title: 'Sam only' })
    await events.loadSessions()
    await events.loadItinerary('s1')
    await events.loadPhotos('s1')
    await plans.loadPlan('s1')
    await events.suggestOrder('s1', 'k')
    await groups.loadLeaderboard()
    await groups.loadProfile(x)
    return { fake, api, auth, events, plans, groups, x, y }
  }

  it('starts with X holding something for s1 in every cache', async () => {
    const { events, plans, groups, x } = await setUp()
    expect(events.byId.s1.title).toBe('Sam only')
    expect(holds(events.itineraries, 's1')).toBe(true)
    expect(holds(events.photos, 's1')).toBe(true)
    expect(holds(events.orders, 's1')).toBe(true)
    expect(holds(plans.plans, 's1')).toBe(true)
    expect(holds(groups.profiles, x)).toBe(true)
    expect(groups.leaderboard.length).toBe(1)
  })

  it('shows Y\'s s1, and nothing X kept for its s1, in every store', async () => {
    const { fake, auth, events, plans, groups, x, y } = await setUp()
    // Tab B: Y logs in. The stand-in announces it the way the real client does; this tab never signs out.
    await fake.client.auth.signInWithPassword({ email: OTHER.email, password: OTHER.password })
    await vi.waitFor(() => expect(auth.myId).toBe(y))
    await vi.waitFor(() => expect(events.sessions.map((s) => s.title)).toEqual(['Kim only']))

    expect(events.byId.s1.title).toBe('Kim only')
    expect(holds(events.itineraries, 's1')).toBe(false)
    expect(holds(events.photos, 's1')).toBe(false)
    expect(holds(events.orders, 's1')).toBe(false)
    expect(holds(plans.plans, 's1')).toBe(false)
    expect(holds(plans.errors, 's1') && plans.errors.s1).toBeFalsy()
    expect(holds(groups.profiles, x)).toBe(false)
    // What a screen had asked for is asked for again, for Y: the leaderboard is Y's.
    await vi.waitFor(() => expect(groups.leaderboard.map((r) => r.id)).toEqual([y]))
  })

  it('does not let a load that was still running for X put its answer into Y\'s stores', async () => {
    const { fake, auth, events, y } = await setUp()
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const { default: moduleApi } = { default: await import('../api.js') }
    const real = moduleApi.getItinerary
    // An itinerary read that is slow for X: it answers after Y is signed in.
    const slow = vi.spyOn(moduleApi, 'getItinerary').mockImplementation(async (id) => (await gate, real(id)))
    const pending = events.loadItinerary('s1').catch(() => null)
    await fake.client.auth.signInWithPassword({ email: OTHER.email, password: OTHER.password })
    await vi.waitFor(() => expect(auth.myId).toBe(y))
    release()
    await pending
    slow.mockRestore()
    expect(holds(events.itineraries, 's1')).toBe(false)
  })
})

describe('the api\'s per-session state across a switch', () => {
  it('forgets that the meeting point was being worked out for a session id when another account is adopted', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    stubPlanner(planner)
    // The planner never answers for the first account's s1, so that session stays "finding the meeting point".
    planner.meetingArea.mockImplementation(() => new Promise(() => {}))
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setLocation(id, 'uid-1', 'start', { areaId: 'tampines' })
    void api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await vi.waitFor(async () => expect((await api.getSession(id)).findingMeeting).toBe(true))
    await api.signOut()
    // The second account's s1 is its own: it is not being worked out because the first account's was.
    await api.signUp({ ...OTHER, username: 'kim_two', email: 'kim2@example.com' })
    const mine = await api.createSession({ ...SESSION, title: 'Kim only' })
    expect(mine.id).toBe(id)
    expect(mine.findingMeeting).toBe(false)
    expect((await api.getSession(id)).findingMeeting).toBe(false)
  })
})

describe('real people in many sessions', () => {
  it('are read in one request for every session in the list, not one request per session', async () => {
    const fake = fakeSupabase()
    for (const [id, name] of [[UID9, 'Kim'], [UID8, 'Lee'], [UID7, 'Mo']]) fake.state.profiles[id] = { username: name.toLowerCase(), display_name: name, avatar_url: null }
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    for (const [i, title] of ['One', 'Two', 'Three'].entries()) await first.api.createSession({ ...SESSION, title, date: `2026-10-${11 + i}` })
    const key = `${STORAGE_KEY}:acct:uid-1`
    const saved = JSON.parse(first.storage.store[key])
    saved.sessions.forEach((s, i) => s.members.push({ id: [UID9, UID8, UID7][i], role: 'guest', state: 'joined' }))
    const { api } = await boot(fake, { data: { [key]: JSON.stringify(saved) } })
    await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    fake.state.reads.length = 0
    const list = await api.listSessions()
    await vi.waitFor(() => expect(fake.state.reads).toHaveLength(1))
    expect([...fake.state.reads[0].ids].sort()).toEqual([UID9, UID8, UID7].sort())
    await vi.waitFor(async () => expect((await api.listPeople()).map((p) => p.name).sort()).toEqual(['Kim', 'Lee', 'Mo']))
    expect(list).toHaveLength(3)
    expect(fake.state.reads).toHaveLength(1)
  })

  it('include someone who opted out of a session: they are named, never blank', async () => {
    const fake = fakeSupabase()
    fake.state.profiles[UID9] = { username: 'kim', display_name: 'Kim Tan', avatar_url: null }
    const { api } = await boot(fake)
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    const { useGroupsStore } = await import('@/stores/groups.js')
    const auth = useAuthStore()
    const groups = useGroupsStore()
    await auth.signUpAs({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    await api.inviteFriends(id, [UID9, UID8])
    await api.startSession(id).catch(() => null)
    // Someone leaves the session by opting out; they stay in it as a member in that state.
    const key = `${STORAGE_KEY}:acct:uid-1`
    expect(JSON.parse(localStorage.getItem(key)).sessions[0].members.map((m) => m.id)).toEqual(['uid-1', UID9, UID8])
    await api.setLocation(id, 'uid-1', 'start', { areaId: 'tampines' }).catch(() => null)
    const session = await api.getSession(id)
    expect(session.members.map((m) => m.id)).toContain(UID9)
    await api.optOut(id, UID9).catch(() => null)
    await groups.loadPeople()
    await vi.waitFor(async () => {
      await groups.loadPeople()
      expect(groups.nameOf(UID9)).toBe('Kim Tan')
    })
    // A person whose profile cannot be read is "Someone", not ''.
    expect(groups.nameOf(UID8)).toBe('Someone')
    expect(groups.nameOf('never-heard-of')).toBe('Someone')
    expect(groups.people.map((p) => p.id)).toContain(UID9)
  })
})

describe('what is sent to the planner', () => {
  it('holds an id and where each person starts, and no name: a long one cannot refuse a whole session', async () => {
    const fake = fakeSupabase()
    // 50 emoji is within the database's 50 characters and is 100 UTF-16 units, over the planner's 80.
    fake.state.profiles[UID9] = { username: 'long', display_name: '\u{1F600}'.repeat(50), avatar_url: null }
    planner.meetingArea.mockReset().mockImplementation(async ({ members }) => {
      if (members.some((m) => (m.name ?? '').length > 80)) throw new Error('planner: name is too long')
      return { area: AREAS.find((a) => a.id === 'bishan'), method: 'station', travelByMember: Object.fromEntries(members.map((m) => [m.id, 20])), approximate: false }
    })
    const { api } = await boot(fake)
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    await api.inviteFriends(id, [UID9])
    await vi.waitFor(() => expect(fake.state.reads.length).toBeGreaterThan(0))
    await api.startSession(id)
    await api.setLocation(id, 'uid-1', 'start', { areaId: 'tampines' })
    await api.setLocation(id, UID9, 'start', { areaId: 'bishan' })
    expect(planner.meetingArea).toHaveBeenCalled()
    for (const [args] of planner.meetingArea.mock.calls) for (const member of args.members) expect(Object.keys(member).sort()).toEqual(['end', 'id', 'start'])
    // Both locations stayed: nothing was rolled back.
    const locations = (await api.getSession(id)).locations
    expect(Object.keys(locations).sort()).toEqual(['uid-1', UID9].sort())
  })
})

describe('a write with nobody signed in', () => {
  it('is refused in a plain sentence, and writes nothing under an empty id', async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    const key = `${STORAGE_KEY}:acct:uid-1`
    const before = storage.store[key]
    // Signed in, a call that names no one is refused too.
    for (const call of [
      () => api.setLocation(id, '', 'start', { areaId: 'tampines' }),
      () => api.setPreferences(id, '', { categories: ['eat'], until: null }),
      () => api.addPhoto(id, '', 'data:image/png;base64,AAAA'),
      () => api.vote(id, 'eat', '', 'v1'),
    ]) await expect(call()).rejects.toThrow('Log in to do that.')
    expect(storage.store[key]).toBe(before)

    await api.signOut()
    const rest = [
      () => api.createSession({ ...SESSION }),
      () => api.updateSession(id, { ...SESSION }),
      () => api.setLocation(id, 'uid-1', 'start', { areaId: 'tampines' }),
      () => api.suggestSpot(id, 'uid-1', 'bugis'),
      () => api.withdrawSpot(id, 'uid-1'),
      () => api.approveSpot(id, 'uid-1', 'bugis', true),
      () => api.confirmSpot(id, 'bugis'),
      () => api.setKnownPlace(id, 'bugis'),
      () => api.optOut(id, 'jonathan'),
      () => api.setPreferences(id, 'uid-1', { categories: ['eat'], until: null }),
      () => api.vote(id, 'eat', 'uid-1', 'v1'),
      () => api.proposeStop(id, 'uid-1', 'v1'),
      () => api.resolveProposal(id, 'pp1', true),
      () => api.addPhoto(id, 'uid-1', 'data:image/png;base64,AAAA'),
      () => api.redeemReward('r1'),
    ]
    for (const call of rest) await expect(call()).rejects.toThrow(/^Log in to (do that|create a session)\.$/)
    expect(storage.store[key]).toBe(before)
    // The only key the account has is its own; nothing was made for "".
    expect(Object.keys(storage.store).some((k) => k.endsWith(':acct:'))).toBe(false)
  })
})

describe('"You" in who voted', () => {
  it('is the signed-in person by id, and a person named You is shown by the name they wrote, apart', async () => {
    const { votersText } = await import('../cardText.js')
    const voters = [{ id: 'me-id', name: 'Sam' }, { id: 'other-id', name: 'You' }]
    expect(votersText({ voters, votes: 2, groupSize: 3, me: 'me-id' })).toBe('You and “You” voted')
    // The person named You is not taken for the signed-in person, and does not take their place.
    expect(votersText({ voters, votes: 2, groupSize: 3, me: 'other-id' })).toBe('You and Sam voted')
    expect(votersText({ voters: [{ id: 'x', name: ' you ' }], votes: 1, groupSize: 3, me: 'me-id' })).toBe('“you” voted')
    // Nothing else changed.
    expect(votersText({ voters: [{ id: 'me-id', name: 'Sam' }, { id: 'o', name: 'Darius' }], votes: 2, groupSize: 4, me: 'me-id' })).toBe('You and Darius voted')
  })
})

describe('the made-up account and the client swap', () => {
  it('keeps the made-up account out of local storage, so a real session kept there is never replaced or removed', async () => {
    const { api, storage } = await boot(null)
    storage.store['jio-auth'] = 'a real developer session'
    const { installStandIn, MADE_UP_ACCOUNT } = await import('../../components/dev/madeUpAccount.js')
    const auth = await import('../auth.js')
    const stand = installStandIn()
    expect(auth.configured()).toBe(true)
    const user = await api.signUp({ ...MADE_UP_ACCOUNT })
    // A uuid-shaped id, like the real project's.
    expect(user.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
    expect(user.authId).toBe(user.id)
    expect(storage.store['jio-auth']).toBe('a real developer session')
    expect(auth.savedUser()).toBeNull()
    await api.signOut()
    expect(storage.store['jio-auth']).toBe('a real developer session')
    expect(Object.keys(storage.store).filter((k) => k !== 'jio-auth')).toEqual([`${STORAGE_KEY}:acct:${user.id}`])
    expect(stand.state.session).toBeNull()
  })

  it('still lets the account tests swap the client, and does nothing at all outside development and tests', async () => {
    const { auth } = await boot(null)
    const fake = fakeSupabase()
    auth.useClient(fake.client)
    expect(auth.dataClient()).toBe(fake.client)
    auth.useClient(null)

    // As in a production build: neither development nor the test runner.
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITEST', '')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    auth.useClient(fake.client)
    expect(auth.dataClient()).toBeNull()
    expect(auth.configured()).toBe(false)
    expect(warn).toHaveBeenCalledTimes(1)
    warn.mockRestore()
    vi.unstubAllEnvs()
  })
})
