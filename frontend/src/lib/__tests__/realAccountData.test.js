// A real account's data carries the account's own id, not the sample person's. The same walk is made by the demo account
// (the sample person Ian) and by a real account (a Supabase user id, here from a stand-in for Supabase): a session, a
// start, a suggested and approved spot, the host's confirmation, a vote, the plan, a proposed stop and a photo. The demo
// account's save is full of "ian" as before; the real account's has its own id and no "ian" in any session. The screens'
// "is this me" helpers and the stores' getters are then asked about both. Two real accounts and the demo account in one
// browser never see each other's sessions or people. No network; Supabase is the stand-in in components/dev/fakeSupabase.js.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { STORAGE_KEY, stubPlanner } from './planFixture.js'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { AREAS } from '../mock/places.js'
import { VENUES } from '../mock/venues.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

// Walking a session takes a few real seconds (the meeting point's loading bar); the screens' helpers need a long test.
vi.setConfig({ testTimeout: 60000 })

const area = (id) => AREAS.find((a) => a.id === id)

// The planner as the backend answers: the chosen area and its runners-up, then each area a member suggested.
async function answerLikeTheBackend({ members, alternatives, include = [] }) {
  const ranked = ['bugis', 'bishan', 'orchard'].slice(0, 1 + (alternatives || 0))
  const price = (id, source) => ({
    area: area(id),
    travelByMember: Object.fromEntries(members.map((m, i) => [m.id, 25 - (i === 0 ? 0 : 5)])),
    approximate: false,
    source,
  })
  const candidates = [...ranked.map((id) => price(id, 'ranked')), ...include.filter((id) => !ranked.includes(id)).map((id) => price(id, 'included'))]
  const [first] = candidates
  const answer = { area: first.area, method: 'station', travelByMember: first.travelByMember, approximate: false }
  return alternatives === undefined && !include.length ? answer : { ...answer, candidates }
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => {
  stubPlanner(planner)
  planner.meetingArea.mockImplementation(answerLikeTheBackend)
})
afterEach(() => vi.unstubAllGlobals())

const DEMO = { ...PROFILE, email: 'ian@jio.demo', name: 'Ian', username: 'ian', demo: true, friends: ['darius', 'jonathan', 'nicole', 'faith', 'darryl'] }
const FRIEND = 'jonathan'
const PHOTO = 'data:image/png;base64,AAAA'

// The same walk, made through the stores the screens use, by whoever is signed in. `friend` takes part through the data
// layer, as the demo tools make a friend act. Resolves with what to look at afterwards.
// How to call: const seen = await walk({ profile: DEMO, fake: null })
async function walk({ profile, fake }) {
  const { api, storage } = await boot(fake)
  const user = await api.signUp({ ...profile })
  setActivePinia(createPinia())
  const { useEventsStore } = await import('@/stores/events.js')
  const { usePlannerStore } = await import('@/stores/planner.js')
  const events = useEventsStore()
  const plan = usePlannerStore()
  const me = user.id

  const created = await events.create({ ...SESSION })
  const id = created.id
  await api.inviteFriends(id, [FRIEND])
  await events.start(id)
  await events.setMyLocation(id, 'start', { areaId: 'tampines' })
  const locatingAlone = await api.getSession(id)
  await api.setLocation(id, FRIEND, 'start', { areaId: 'jurong-east' })
  // A suggestion by me, a friend's approval, and mine.
  await events.suggestMySpot(id, 'kovan', { here: false })
  await api.approveSpot(id, FRIEND, 'kovan', true)
  await events.approveMySpot(id, 'bugis', true)
  const choosing = await api.getSession(id)
  await events.confirmSpot(id, 'bugis')

  await plan.setMyPreferences(id, { categories: ['eat', 'activity'], until: null })
  await api.setPreferences(id, FRIEND, { categories: ['eat', 'activity'], until: null })
  const open = await api.getPlan(id)
  const slots = open.slots.filter((s) => ['eat', 'activity'].includes(s.category))
  for (const slot of slots) {
    await plan.vote(id, slot.id, slot.options[0].id)
    await api.vote(id, slot.id, FRIEND, slot.options[0].id)
  }
  const voted = await api.getPlan(id)
  const voting = await api.getSession(id)
  await events.confirm(id)

  // The day of the outing: a place proposed from "What next?", the host adds it, and a photo.
  await api.setConditions({ sessionDay: true })
  const planned = new Set((await api.getItinerary(id)).stops.map((s) => s.venue.id))
  const extra = VENUES.find((v) => ['drink', 'shop'].includes(v.category) && !planned.has(v.id))
  await events.proposeMyStop(id, extra.id)
  const proposed = await api.getSession(id)
  await events.resolveProposal(id, proposed.proposals[0].id, true)
  await events.addPhoto(id, PHOTO)
  const confirmed = await api.getSession(id)
  const photos = await api.getPhotos(id)
  await events.endPlan(id)

  const key = user.authId ? `${STORAGE_KEY}:acct:${user.authId}` : STORAGE_KEY
  return {
    api, storage, fake, me, user, id, locatingAlone, choosing, voting, voted, confirmed, photos, extra,
    save: JSON.parse(storage.store[key]),
    saveText: storage.store[key],
    ended: await api.getSession(id),
    leaderboard: await api.getLeaderboard(),
    profile: await api.getPerson(me),
  }
}

let demo
let real
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  stubPlanner(planner)
  planner.meetingArea.mockImplementation(answerLikeTheBackend)
  demo = await walk({ profile: DEMO, fake: fakeSupabase() })
  real = await walk({ profile: PROFILE, fake: fakeSupabase() })
})

describe('the demo account walks the same flow as before', () => {
  it('is the sample person, whose id every row carries', () => {
    expect(demo.me).toBe('ian')
    expect(demo.user).toMatchObject({ id: 'ian', authId: null, local: true })
    const [session] = demo.save.sessions
    expect(session.hostId).toBe('ian')
    expect(session.members[0]).toMatchObject({ id: 'ian', role: 'host', state: 'joined' })
    expect(session.locations.ian.start.areaId).toBe('tampines')
    expect(session.spots.suggestions.ian).toMatchObject({ areaId: 'kovan' })
    expect(session.spots.approvals.ian).toEqual(['bugis'])
    expect(Object.values(session.votes).filter((byPerson) => Object.keys(byPerson).length).every((byPerson) => 'ian' in byPerson)).toBe(true)
    expect(session.prefs.ian.categories).toEqual(['eat', 'activity'])
    expect(session.photos[0].personId).toBe('ian')
    expect(demo.save.user.id).toBe('ian')
  })

  it('keeps the sample friends, the sample leaderboard and the sample past season', async () => {
    expect((await demo.api.listPeople()).map((p) => p.id)).toEqual(expect.arrayContaining(['darius', 'jonathan', 'nicole', 'faith', 'darryl', 'meiling']))
    expect(demo.save.friends).toEqual(['darius', 'jonathan', 'nicole', 'faith', 'darryl'])
    expect(demo.leaderboard.length).toBeGreaterThan(5)
    expect(demo.leaderboard.find((r) => r.isMe)).toMatchObject({ id: 'ian', name: 'Ian' })
    expect((await demo.api.getSeason()).past).toHaveLength(1)
  })
})

describe('a real account walks the flow with its own id', () => {
  it('is signed in as its Supabase id, in a save of its own', () => {
    expect(real.me).toBe('uid-1')
    expect(real.user).toMatchObject({ id: 'uid-1', authId: 'uid-1', local: false })
    expect(real.save.user).toMatchObject({ id: 'uid-1', authId: 'uid-1' })
    expect(Object.keys(real.storage.store).filter((k) => k.startsWith(STORAGE_KEY))).toContain(`${STORAGE_KEY}:acct:uid-1`)
  })

  it('stores the account as host and first member of a session it creates', () => {
    const [session] = real.save.sessions
    expect(session.hostId).toBe('uid-1')
    expect(session.members[0]).toEqual({ id: 'uid-1', role: 'host', state: 'joined' })
    expect(session.members.map((m) => m.id)).toEqual(['uid-1', FRIEND])
  })

  it('stores its start, its suggestion, its approval, its votes, its preferences, its proposal and its photo under its id', () => {
    const [session] = real.save.sessions
    expect(session.locations['uid-1'].start.areaId).toBe('tampines')
    expect(session.spots.suggestions['uid-1']).toMatchObject({ areaId: 'kovan' })
    expect(session.spots.approvals['uid-1']).toEqual(['bugis'])
    const voted = Object.values(session.votes).filter((byPerson) => Object.keys(byPerson).length)
    expect(voted).toHaveLength(2)
    expect(voted.every((byPerson) => 'uid-1' in byPerson && FRIEND in byPerson)).toBe(true)
    expect(session.prefs['uid-1'].categories).toEqual(['eat', 'activity'])
    // The host added the proposed place, so the proposal is gone and the stop is in the plan; the proposer was the account.
    expect(session.plan.stops.map((s) => s.venueId)).toContain(real.extra.id)
    expect(session.photos[0]).toMatchObject({ personId: 'uid-1', src: PHOTO })
  })

  it('stores the proposal under its id until the host decides', async () => {
    const { api, storage } = await boot(fakeSupabase())
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    await api.inviteFriends(id, [FRIEND])
    await api.startSession(id)
    await api.setLocation(id, 'uid-1', 'start', { areaId: 'tampines' })
    await api.setLocation(id, FRIEND, 'start', { areaId: 'jurong-east' })
    await api.useMeetingArea(id)
    for (const person of ['uid-1', FRIEND]) await api.setPreferences(id, person, { categories: ['eat'], until: null })
    const [slot] = (await api.getPlan(id)).slots.filter((s) => s.category === 'eat')
    for (const person of ['uid-1', FRIEND]) await api.vote(id, slot.id, person, slot.options[0].id)
    await api.confirmPlan(id)
    await api.setConditions({ sessionDay: true })
    const extra = VENUES.find((v) => v.category === 'drink')
    await api.proposeStop(id, 'uid-1', extra.id)
    const session = JSON.parse(storage.store[`${STORAGE_KEY}:acct:uid-1`]).sessions[0]
    expect(session.proposals).toMatchObject([{ venueId: extra.id, by: 'uid-1' }])
    // Taking it back is the proposer's, and the host's, to do.
    expect((await api.getSession(id)).proposals[0]).toMatchObject({ by: 'uid-1', byName: 'Sam' })
  })

  it('writes the string "ian" nowhere in the session or the account', () => {
    const { sessions, user, friends, stats } = real.save
    expect(JSON.stringify({ sessions, user, friends })).not.toMatch(/"ian"/)
    expect(Object.keys(stats)).not.toContain('ian')
    expect(real.saveText).not.toMatch(/"ian"/)
  })

  it('sees itself, by name, as host, member, voter and proposer, with "Someone" for no one it knows', () => {
    expect(real.confirmed.hostId).toBe('uid-1')
    expect(real.confirmed.hostName).toBe('Sam')
    expect(real.confirmed.activeIds).toEqual(['uid-1', FRIEND])
    expect(real.voting.locations['uid-1'].start).toMatchObject({ areaId: 'tampines', label: 'Tampines' })
    // Another person's exact place is never in the answer, only the area.
    expect(real.voting.locations[FRIEND].start).not.toHaveProperty('label')
    const votedSlots = real.voted.slots.filter((s) => s.totalVotes > 0)
    expect(votedSlots).toHaveLength(2)
    expect(votedSlots.every((s) => s.myVote === s.options[0].id)).toBe(true)
    expect(votedSlots.map((s) => s.options[0].voters.map((v) => v.name))).toEqual(votedSlots.map(() => ['Sam', 'Jonathan']))
    expect(real.photos[0]).toMatchObject({ personId: 'uid-1', name: 'Sam' })
  })

  it('gives the same answers as the demo account, except for the id and the name', () => {
    const swap = (x, who) => JSON.stringify(x).replaceAll(`"${who.me}"`, '"ME"').replaceAll(who.user.name, 'NAME')
    const parts = ['locatingAlone', 'choosing', 'voting', 'voted']
    expect(JSON.stringify(real.choosing).match(/"uid-1"/g).length).toBeGreaterThan(5)
    for (const part of parts) {
      const strip = (s) => s.replace(/"(createdAt|updatedAt|at|id)":("[^"]*"|\d+)/g, '"$1":0')
      expect(strip(swap(real[part], real)), part).toBe(strip(swap(demo[part], demo)))
    }
  })

  it('earns JioCoins on the leaderboard under its own id, and nothing else is on it', async () => {
    expect(real.leaderboard).toHaveLength(1)
    expect(real.leaderboard[0]).toMatchObject({ id: 'uid-1', name: 'Sam', isMe: true, seasonPoints: 100, seasonMeetups: 1, rank: 1, points: 100, meetups: 1 })
    expect(real.profile).toMatchObject({ id: 'uid-1', name: 'Sam', username: 'sam', meetups: 1, points: 100, sample: false })
    expect(real.save.stats['uid-1']).toEqual({ meetups: 1, points: 100, seasonPoints: 100 })
    // The friend who took part gets a row of their own, and the sample people's numbers are not kept at all.
    expect(Object.keys(real.save.stats).sort()).toEqual([FRIEND, 'uid-1'].sort())
  })

  it('asks Supabase for no one it already knows: itself and the sample friend are answered from memory', () => {
    expect(real.fake.state.reads).toEqual([])
  })
})

describe('what a real account sees of friends, the leaderboard and rewards', () => {
  async function fresh() {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    return { api, storage, fake }
  }

  it('has no friends, though the sign-up draft held sample ones', async () => {
    const { api, storage } = await fresh()
    expect(PROFILE.friends).toEqual(['darius'])
    expect(await api.listPeople()).toEqual([])
    expect(JSON.parse(storage.store[`${STORAGE_KEY}:acct:uid-1`]).friends).toEqual([])
  })

  it('is alone on the leaderboard, unranked until it earns something, in a first season with no past one', async () => {
    const { api } = await fresh()
    expect(await api.getLeaderboard()).toEqual([expect.objectContaining({ id: 'uid-1', name: 'Sam', isMe: true, rank: null, seasonPoints: 0, points: 0, meetups: 0, isFriend: false })])
    const season = await api.getSeason()
    expect(season.number).toBe(1)
    expect(season.past).toEqual([])
    expect(season.winners).toEqual([])
  })

  it('ends a season without a winner, and the next one counts from the account\'s own row', async () => {
    const { api } = await fresh()
    const ended = await api.endSeason()
    expect(ended.winners).toEqual([])
    expect((await api.getSeason()).number).toBe(2)
    expect((await api.getLeaderboard())[0]).toMatchObject({ id: 'uid-1', isMe: true })
  })

  it('has no voucher to redeem with no JioCoins, and says how many more it needs', async () => {
    const { api } = await fresh()
    const [reward] = await api.listRewards()
    await expect(api.redeemReward(reward.id)).rejects.toThrow(/You need .* more for this voucher/)
  })

  it('cannot add a sample person as a friend, which would make a sample friend look real', async () => {
    const { api } = await fresh()
    await expect(api.setFriend('darius', true)).rejects.toThrow('Friends are the people you share a session with.')
    expect(await api.listPeople()).toEqual([])
  })

  it('still reads a sample reviewer\'s profile, marked as a sample, and nobody it has no session with', async () => {
    const { api } = await fresh()
    expect(await api.getPerson('meiling')).toMatchObject({ id: 'meiling', name: 'Mei Ling', sample: true, isFriend: false })
    await expect(api.getPerson('uid-stranger')).rejects.toThrow('This person does not exist.')
  })

  it('lists the sample people, not the sample person himself, on the sign-up screen where nobody is signed in', async () => {
    const { api } = await boot(null)
    const ids = (await api.listPeople()).map((p) => p.id)
    expect(ids).not.toContain('ian')
    expect(ids).toEqual(expect.arrayContaining(['darius', 'faith', 'meiling']))
  })

  it('creates nothing without a person signed in', async () => {
    const { api } = await boot(fakeSupabase())
    await expect(api.createSession({ ...SESSION })).rejects.toThrow('Log in to create a session.')
  })

  it('turns the people in its sessions into its friends, read from their profiles in one request', async () => {
    const fake = fakeSupabase()
    fake.state.profiles['uid-9'] = { username: 'kim', display_name: 'Kim Tan', avatar_url: null }
    fake.state.profiles['uid-8'] = { username: 'lee', display_name: 'Lee', avatar_url: null }
    const { api } = await boot(fake)
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    const events = []
    api.subscribe((event) => events.push(event.type))
    await api.inviteFriends(id, ['uid-9', 'uid-8'])
    // Until their profiles arrive they read as "Someone"; the screens are told when they have.
    await vi.waitFor(() => expect(events).toContain('people'))
    expect(fake.state.reads).toEqual([{ table: 'profiles', columns: 'id, username, display_name, avatar_url', ids: ['uid-9', 'uid-8'] }])
    const people = await api.listPeople()
    expect(people).toMatchObject([
      { id: 'uid-9', name: 'Kim Tan', username: 'kim', isFriend: true, sample: false },
      { id: 'uid-8', name: 'Lee', username: 'lee', isFriend: true, sample: false },
    ])
    expect((await api.getPerson('uid-9')).name).toBe('Kim Tan')
    expect(fake.state.reads).toHaveLength(1)
  })

  it('tells the screens when the people in its sessions change, and only then', async () => {
    const { api } = await boot(fakeSupabase())
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    const events = []
    api.subscribe((event) => events.push(event.type))
    await api.inviteFriends(id, ['darius'])
    expect(events.filter((type) => type === 'people')).toHaveLength(1)
    // A write that brings nobody new says nothing about people.
    await api.updateSession(id, { ...SESSION, title: 'Renamed' })
    await api.inviteFriends(id, ['darius'])
    expect(events.filter((type) => type === 'people')).toHaveLength(1)
    await api.inviteFriends(id, ['faith'])
    expect(events.filter((type) => type === 'people')).toHaveLength(2)
    expect((await api.listPeople()).map((p) => p.id)).toEqual(['darius', 'faith'])
  })

  it('shows a person whose profile cannot be read as "Someone", and still lists them', async () => {
    const fake = fakeSupabase({ readError: true })
    const { api } = await boot(fake)
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession({ ...SESSION })
    await api.inviteFriends(id, ['uid-9'])
    expect((await api.getSession(id)).members.map((m) => m.id)).toEqual(['uid-1', 'uid-9'])
    const people = await api.listPeople()
    expect(people).toMatchObject([{ id: 'uid-9', name: 'Someone', username: '' }])
    expect((await api.getSession(id)).hostName).toBe('Sam')
  })
})

describe('two real accounts and the demo account in one browser', () => {
  it('each sees only its own sessions, and the people cache is not shared', async () => {
    const fake = fakeSupabase()
    fake.state.profiles['uid-9'] = { username: 'kim', display_name: 'Kim Tan', avatar_url: null }
    const { api, storage } = await boot(fake)

    await api.signUp({ ...PROFILE })
    const first = await api.createSession({ ...SESSION, title: 'Sam only' })
    await api.inviteFriends(first.id, ['uid-9'])
    await vi.waitFor(() => expect(fake.state.reads).toHaveLength(1))
    await vi.waitFor(async () => expect((await api.listPeople()).map((p) => p.name)).toEqual(['Kim Tan']))
    await api.signOut()

    // A second account: nothing of the first, and the first's cached person is not known to it.
    await api.signUp({ ...OTHER, username: 'kim_two', email: 'kim2@example.com' })
    expect(await api.listSessions()).toEqual([])
    expect(await api.listPeople()).toEqual([])
    await expect(api.getPerson('uid-9')).rejects.toThrow('This person does not exist.')
    const second = await api.createSession({ ...SESSION, title: 'Kim only' })
    expect((await api.listSessions()).map((s) => [s.title, s.hostId])).toEqual([['Kim only', 'uid-2']])
    await api.signOut()

    // The demo account, local, with the sample world.
    await api.signUp({ ...DEMO })
    expect(await api.listSessions()).toEqual([])
    const demoSession = await api.createSession({ ...SESSION, title: 'Ian only' })
    expect(demoSession.hostId).toBe('ian')
    await expect(api.getPerson('uid-9')).rejects.toThrow('This person does not exist.')
    expect(storage.store[STORAGE_KEY]).toContain('Ian only')
    expect(storage.store[STORAGE_KEY]).not.toContain('Sam only')
    // Signing out of a local account erases it, as before; the real accounts' saves are left where they are.
    await api.signOut()
    expect(storage.store[STORAGE_KEY]).not.toContain('Ian only')

    // Back to the first: its own session, its own people, read again because the cache was emptied on the way.
    await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect((await api.listSessions()).map((s) => [s.title, s.hostId])).toEqual([['Sam only', 'uid-1']])
    expect((await api.listPeople()).map((p) => p.name)).toEqual(['Kim Tan'])
    expect(fake.state.reads.length).toBeGreaterThanOrEqual(2)
    await api.signOut()
    await api.signIn({ email: OTHER.email.replace('kim@', 'kim2@'), password: OTHER.password })
    expect((await api.listSessions()).map((s) => s.id)).toEqual([second.id])
    expect(await api.listPeople()).toEqual([])

    // What is on disk: one save per account, each holding only its own people.
    const mine = storage.store[`${STORAGE_KEY}:acct:uid-1`]
    const theirs = storage.store[`${STORAGE_KEY}:acct:uid-2`]
    expect(mine).toContain('Sam only')
    expect(mine).not.toContain('Kim only')
    expect(mine).not.toContain('Ian only')
    expect(theirs).toContain('Kim only')
    expect(theirs).not.toContain('uid-1')
    expect(theirs).not.toContain('uid-9')
  })

  it('does not show the demo account\'s points, friends or sessions to a real account on the same browser', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    await api.signUp({ ...DEMO })
    await api.createSession({ ...SESSION, title: 'Ian only' })
    expect((await api.getLeaderboard()).find((r) => r.id === 'ian').points).toBeGreaterThan(0)
    await api.signUp({ ...PROFILE })
    expect(await api.listSessions()).toEqual([])
    expect((await api.getLeaderboard()).map((r) => r.id)).toEqual(['uid-1'])
    expect(await api.listPeople()).toEqual([])
  })
})

describe('a save made when every real account was the sample person', () => {
  it('is not read as this account\'s data: the profile is kept, the sessions start fresh', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    const key = `${STORAGE_KEY}:acct:uid-1`
    const save = JSON.parse(first.storage.store[key])
    // What the old build wrote: the account was "ian", with a session of his.
    const old = {
      ...save,
      user: { ...save.user, id: 'ian' },
      friends: ['darius'],
      stats: { ian: { meetups: 0, points: 0, seasonPoints: 0 } },
      sessions: [
        {
          id: 's1', title: 'Old', date: '2026-10-10', start: '12:00', end: '20:00', hostId: 'ian', status: 'inviting', createdAt: 1, updatedAt: 1,
          members: [{ id: 'ian', role: 'host', state: 'joined' }], locations: {}, meeting: null, spots: { list: [], approvals: {}, suggestions: {}, appMethod: null },
          prefs: {}, deletedSlots: [], options: {}, votes: {}, plan: null, banner: null, replan: null, photos: [], radius: null,
        },
      ],
    }
    const { api, storage } = await boot(fake, { data: { [key]: JSON.stringify(old) } })
    const user = await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect(user).toMatchObject({ id: 'uid-1', authId: 'uid-1', name: 'Sam', homeAreaId: 'tampines' })
    expect(await api.listSessions()).toEqual([])
    expect(await api.listPeople()).toEqual([])
    expect(JSON.parse(storage.store[key]).user.id).toBe('uid-1')
  })
})

describe('the screens\' helpers and the stores\' getters, asked about a real id', () => {
  // Each helper takes the signed-in person's id. The same call with the demo account's id and the real account's gives the
  // same answer in the same situation, so none of them is tied to the sample person.
  const both = (make) => [make(demo, 'ian'), make(real, 'uid-1')]

  it('canSuggest, canApprove, byLine, peopleTrips, pinName, myTripLine and unpricedSuggestion', async () => {
    const { canApprove, canSuggest, byLine, peopleTrips, pinName, unpricedSuggestion } = await import('../../components/spots/spotText.js')
    const [d, r] = both((w, me) => {
      const session = w.choosing
      const spot = session.spots.list.find((s) => s.areaId === 'kovan')
      const names = (id) => (id === me ? 'ME' : 'Jonathan')
      return {
        suggest: canSuggest(session, me),
        approve: canApprove(session, me),
        by: byLine(spot, me),
        trips: peopleTrips(spot, names, me).map((t) => ({ ...t, id: t.id === me ? 'ME' : t.id })),
        pin: pinName(spot, 2, me),
        unpriced: unpricedSuggestion(session, me),
        // Not the account itself: a stranger is not allowed.
        stranger: canApprove(session, 'someone-else'),
      }
    })
    expect(r).toEqual(d)
    expect(r).toMatchObject({ suggest: true, approve: true, by: 'Suggested by you', stranger: false })
    expect(r.trips[0]).toMatchObject({ id: 'ME', name: 'You' })
  })

  it('whereStands and nextStepFor at each step', async () => {
    const { nextStepFor, whereStands } = await import('../homeMeetups.js')
    for (const part of ['locatingAlone', 'choosing', 'voting', 'confirmed']) {
      const [d, r] = both((w, me) => ({ next: nextStepFor(w[part], me), where: whereStands(w[part], me) }))
      expect(r.next, part).toEqual(d.next)
      expect(r.where, part).toEqual(d.where)
    }
    expect(nextStepFor(real.choosing, 'uid-1').label).toBe('Confirm the spot')
    expect(nextStepFor(real.voting, 'uid-1').label).toBe('Waiting for others')
    expect(nextStepFor(real.locatingAlone, 'uid-1').label).toBe('Waiting for others')
    // The sample person is not the host of a real account's session.
    expect(nextStepFor(real.choosing, 'ian').label).not.toBe('Confirm the spot')
  })

  it('placeAction, proposedRows and votersText', async () => {
    const { placeAction, proposedRows } = await import('../roam.js')
    const { votersText } = await import('../cardText.js')
    const mine = { state: 'proposed', proposal: { by: 'uid-1', byName: 'Sam' }, venue: { name: 'Green Kitchen' } }
    expect(placeAction(mine, { myId: 'uid-1' })).toMatchObject({ kind: 'mine', tag: 'Proposed by you', button: 'Take back' })
    expect(placeAction({ ...mine, proposal: { by: 'jonathan', byName: 'Jonathan' } }, { myId: 'uid-1' })).toMatchObject({ kind: 'theirs', tag: 'Proposed by Jonathan' })
    const session = { hostId: 'uid-1', hostName: 'Sam', proposals: [{ id: 'pp1', venue: { name: 'X' }, by: 'uid-1', byName: 'Sam' }, { id: 'pp2', venue: { name: 'Y' }, by: 'jonathan', byName: 'Jonathan' }] }
    expect(proposedRows(session, 'uid-1').map((row) => [row.tag, row.canDecide, row.canTakeBack])).toEqual([['Proposed by you', true, false], ['Proposed by Jonathan', true, false]])
    expect(proposedRows({ ...session, hostId: 'jonathan', hostName: 'Jonathan' }, 'uid-1').map((row) => [row.canDecide, row.canTakeBack])).toEqual([[false, true], [false, false]])
    const slot = real.voted.slots.find((s) => s.totalVotes > 0)
    const option = slot.options[0]
    expect(votersText({ voters: option.voters, votes: option.votes, groupSize: 3, me: 'uid-1' })).toBe('You and Jonathan voted')
  })

  it('inviteAccess and the review the card quotes', async () => {
    const { inviteAccess } = await import('../session.js')
    expect(inviteAccess(real.choosing, real.choosing.hostId === 'uid-1', 'Sam')).toEqual({ open: true, text: '' })
    expect(inviteAccess(real.choosing, real.choosing.hostId === 'ian', 'Sam').open).toBe(false)
    const { bindCurrentUser } = await import('../currentUser.js')
    const { pickReview } = await import('../reviewPick.js')
    bindCurrentUser(() => 'uid-1')
    const reviews = [{ id: 'a', personId: 'uid-1', name: 'Sam' }, { id: 'b', personId: 'nicole', name: 'Nicole' }]
    expect(pickReview(reviews, { outing: ['uid-1', 'nicole'], friends: [] }).personId).toBe('nicole')
    bindCurrentUser(null)
  })

  it('the account store: myId, sampleWorld, and the events and groups stores', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    const { useEventsStore } = await import('@/stores/events.js')
    const { useGroupsStore } = await import('@/stores/groups.js')
    const { currentUserId } = await import('../currentUser.js')
    const auth = useAuthStore()
    const events = useEventsStore()
    const groups = useGroupsStore()
    expect(auth.myId).toBe('')
    expect(auth.sampleWorld).toBe(false)
    expect(currentUserId()).toBe('')

    await auth.signUpAs({ ...PROFILE })
    expect(auth.myId).toBe('uid-1')
    expect(auth.user.id).toBe('uid-1')
    expect(auth.sampleWorld).toBe(false)
    expect(currentUserId()).toBe('uid-1')

    await events.create({ ...SESSION })
    expect(events.current).toMatchObject({ hostId: 'uid-1' })
    await groups.loadLeaderboard()
    await groups.loadPeople()
    expect(groups.me).toMatchObject({ id: 'uid-1', isMe: true })
    expect(groups.friends).toEqual([])
    expect(groups.suggested).toEqual([])
    expect(groups.nameOf('uid-1')).toBe('')

    // The list was empty, and is made again when someone joins a session of this account.
    await api.inviteFriends(events.current.id, ['darius'])
    await vi.waitFor(() => expect(groups.people.map((p) => p.id)).toEqual(['darius']))
    expect(groups.friends.map((p) => p.id)).toEqual(['darius'])
    expect(groups.nameOf('darius')).toBe('Darius')

    await auth.signOut()
    expect(auth.myId).toBe('')
    expect(currentUserId()).toBe('')
    // The demo account is the sample person, in the sample world.
    await auth.signUpAs({ ...DEMO })
    expect(auth.myId).toBe('ian')
    expect(auth.sampleWorld).toBe(true)
    expect(currentUserId()).toBe('ian')
    await groups.loadPeople()
    expect(groups.friends.map((p) => p.id)).toEqual(['darius', 'jonathan', 'nicole', 'faith', 'darryl'])
    expect(api.realAccountsOn()).toBe(true)
  })
})
