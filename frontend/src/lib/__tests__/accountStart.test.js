// What a new account starts with. The demo tools' account (`demo: true`) starts with the sample history so the demo
// leaderboard has everyone ranked; a person who signs up through the form starts at zero. "Start over" and the
// one-click demo account must be able to sign up at all, and must not erase anything and then fail. The planner is stubbed.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, loadApi, stubPlanner } from './planFixture.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'
import { profileProblem } from '../signupRules.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => stubPlanner(planner))
afterEach(() => vi.unstubAllGlobals())

const FORM = { email: 'sam@example.com', name: 'Sam', username: 'sam', dob: '2001-05-06', homeAreaId: 'tampines', friends: ['darius', 'nicole'] }

// The host's numbers as every screen reads them: profile, graph, rewards balance and both leaderboards.
async function hostNumbers(api) {
  const person = await api.getPerson('ian')
  const board = (await api.getLeaderboard()).find((row) => row.isMe)
  const past = (await api.getSeasonStandings(1)).find((row) => row.isMe)
  return { meetups: person.meetups, points: person.points, graph: person.history.reduce((sum, d) => sum + d.count, 0), board, past }
}

describe('the demo account', () => {
  it('has a date of birth and none of the old permission flags', () => {
    expect(profileProblem(DEMO_ACCOUNT)).toBe('')
    expect(DEMO_ACCOUNT).not.toHaveProperty('locationAllowed')
    expect(DEMO_ACCOUNT).not.toHaveProperty('contactsAllowed')
    expect(DEMO_ACCOUNT.demo).toBe(true)
  })

  it('signs up through api.signUp and starts with the sample history, the same on every screen', async () => {
    const api = await loadApi()
    const user = await api.signUp(DEMO_ACCOUNT)
    expect(user.demo).toBe(true)
    const host = await hostNumbers(api)
    expect(host).toMatchObject({ meetups: 10, points: 1000, graph: 10 })
    // 4 meetups this season and 4 in the last one, so the demo leaderboard has him ranked in both.
    expect(host.board.seasonPoints).toBe(400)
    expect(host.board.rank).not.toBeNull()
    expect(host.past.seasonPoints).toBe(400)
    expect(host.past.rank).not.toBeNull()
  })

  it('keeps its sample history through "Reset demo data"', async () => {
    const api = await loadApi()
    await api.signUp(DEMO_ACCOUNT)
    await api.resetDemo()
    expect(await hostNumbers(api)).toMatchObject({ meetups: 10, points: 1000, graph: 10 })
  })
})

describe('an account made through the sign-up form', () => {
  it('starts with no meetups, no JioCoins and no rank, on every screen', async () => {
    const api = await loadApi()
    const user = await api.signUp(FORM)
    expect(user).not.toHaveProperty('demo')
    const host = await hostNumbers(api)
    expect(host).toMatchObject({ meetups: 0, points: 0, graph: 0 })
    expect(host.board).toMatchObject({ seasonPoints: 0, seasonMeetups: 0, rank: null })
    expect(host.past).toMatchObject({ seasonPoints: 0, rank: null })
  })

  it('still sees its friends ranked, so the leaderboard is not empty', async () => {
    const api = await loadApi()
    await api.signUp(FORM)
    const board = await api.getLeaderboard()
    expect(board.find((row) => row.id === 'darius').rank).toBe(1)
    expect(board.find((row) => row.isMe).rank).toBeNull()
  })

  it('earns from its first finished meetup only', async () => {
    const api = await loadApi()
    await api.signUp(FORM)
    await api.resetDemo()
    expect((await hostNumbers(api)).points).toBe(0)
  })

  it('does not take the sample history from an older demo account', async () => {
    const api = await loadApi()
    await api.signUp(DEMO_ACCOUNT)
    await api.signOut()
    await api.signUp(FORM)
    expect(await hostNumbers(api)).toMatchObject({ meetups: 0, points: 0, graph: 0 })
  })
})

describe('"Start over" in the auth store', () => {
  // The store on top of a fresh copy of the data layer and its own Pinia.
  async function storeOn(options) {
    const api = await loadApi(options)
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    return { api, auth: useAuthStore() }
  }

  it('replaces a form account with the demo account, and clears the sessions', async () => {
    const { api, auth } = await storeOn()
    await auth.signUpAs(FORM)
    await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    const user = await auth.startOver(DEMO_ACCOUNT)
    expect(user).toMatchObject({ username: 'ian', demo: true })
    expect(auth.signedIn).toBe(true)
    expect(await api.listSessions()).toEqual([])
    expect(await hostNumbers(api)).toMatchObject({ meetups: 10, points: 1000 })
  })

  it('rejects a profile sign-up would refuse before it erases anything', async () => {
    const { api, auth } = await storeOn()
    await auth.signUpAs(FORM)
    await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    // The old demo account had no date of birth.
    const { dob: _dob, ...noDob } = DEMO_ACCOUNT
    await expect(auth.startOver(noDob)).rejects.toThrow(/date of birth/i)
    expect(auth.signedIn).toBe(true)
    expect(auth.user.username).toBe('sam')
    expect(await api.listSessions()).toHaveLength(1)
  })

  it('leaves the person signed out, with the reason kept, when sign-up fails after the wipe', async () => {
    const { api, auth } = await storeOn()
    const { storage } = api
    await auth.signUpAs(FORM)
    // The size of a signed-out save; the demo account's save is bigger, so it is the write that does not fit.
    await api.signOut()
    const signedOut = storage.store[STORAGE_KEY].length
    await auth.signUpAs(FORM)
    storage.limit = signedOut + 5
    await expect(auth.startOver(DEMO_ACCOUNT)).rejects.toThrow(/storage is full/)
    expect(auth.signedIn).toBe(false)
    expect(auth.startOverError).toMatch(/storage is full/)
  })
})

describe('the profile graph and what is listed under it (Faith, 31 October 2026)', () => {
  it('gives the demo account a card for every meetup of its sample history, the same each time, opening nothing', async () => {
    const api = await loadApi()
    const user = await api.signUp(DEMO_ACCOUNT)
    const me = await api.getPerson(user.id)
    const drawn = me.history.reduce((sum, d) => sum + d.count, 0)
    expect(me.pastSamples.length).toBe(drawn)
    for (const { date, count } of me.history) expect(me.pastSamples.filter((s) => s.date === date).length).toBe(count)
    expect(me.pastSamples.every((s) => s.sample && s.status === 'completed' && s.areaName && s.activeIds.includes(user.id))).toBe(true)
    expect((await api.getPerson(user.id)).pastSamples).toEqual(me.pastSamples)
  })

  it('gives a new account none of its own, and lists none on a stranger\'s profile', async () => {
    const api = await loadApi()
    const user = await api.signUp(FORM)
    expect((await api.getPerson(user.id)).pastSamples).toEqual([])
    expect((await api.getPerson('kai')).pastSamples).toEqual([])
  })

  it('gives a friend\'s sample outings to a friend and never to a stranger, and takes them away with the friendship (Faith, 4 November 2026)', async () => {
    const api = await loadApi()
    await api.signUp(DEMO_ACCOUNT)
    // Darius is one of the demo account's friends: a card for every sample meetup, with Darius in it once.
    const friend = await api.getPerson('darius')
    expect(friend.isFriend).toBe(true)
    expect(friend.pastSamples.length).toBeGreaterThan(0)
    expect(friend.pastSamples.every((s) => s.sample && s.members.filter((m) => m.id === 'darius').length === 1)).toBe(true)
    // Kai is someone the demo account does not know.
    const stranger = await api.getPerson('kai')
    expect(stranger.isFriend).toBe(false)
    expect(stranger.pastSamples).toEqual([])
    // Darius stops being a friend, and is then a stranger with a history that is not listed; adding them brings it back.
    const cards = friend.pastSamples.length
    await api.setFriend('darius', false)
    const dropped = await api.getPerson('darius')
    expect(dropped.history.length).toBeGreaterThan(0)
    expect(dropped.pastSamples).toEqual([])
    await api.setFriend('darius', true)
    expect((await api.getPerson('darius')).pastSamples.length).toBe(cards)
  })
})
