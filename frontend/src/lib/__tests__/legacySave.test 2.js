// A real account's save from the build when every real account was the sample person (`ian`). Signing in again must neither
// lose it nor read it as the new account's: it is copied aside byte for byte, then moved to the account's own id table by table
// (lib/legacySave.js). The save under test is not hand-made: it is what the data layer itself writes for a local account,
// which carries the sample id in every table that holds a person, after a walk that reaches each one. If a table is ever added
// that holds a person's id and the move forgets it, the "no `ian` is left" test fails.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, stubPlanner } from './planFixture.js'
import { PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { isLegacyRealSave, remapLegacySave } from '../legacySave.js'
import { PEOPLE } from '../mock/people.js'
import { AREAS } from '../mock/places.js'
import { VENUES } from '../mock/venues.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.setConfig({ testTimeout: 60000 })

const area = (id) => AREAS.find((a) => a.id === id)
async function answerLikeTheBackend({ members, alternatives, include = [] }) {
  const ranked = ['bugis', 'bishan', 'orchard'].slice(0, 1 + (alternatives || 0))
  const price = (id, source) => ({ area: area(id), travelByMember: Object.fromEntries(members.map((m, i) => [m.id, 25 - (i === 0 ? 0 : 5)])), approximate: false, source })
  const candidates = [...ranked.map((id) => price(id, 'ranked')), ...include.filter((id) => !ranked.includes(id)).map((id) => price(id, 'included'))]
  const [first] = candidates
  const answer = { area: first.area, method: 'station', travelByMember: first.travelByMember, approximate: false }
  return alternatives === undefined && !include.length ? answer : { ...answer, candidates }
}

const NEW_ID = '7f3c2a10-5b6d-4e8f-9a1b-0c2d3e4f5a6b'
const isSample = (id) => PEOPLE.some((p) => p.id === id)

// The local account's save after a walk that touches every table: a host, members, two starts, a suggestion and approvals, the
// confirmed spot, preferences, votes, the confirmed plan, a place proposed and left waiting, a photo, and the meeting times.
let text
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  stubPlanner(planner)
  planner.meetingArea.mockImplementation(answerLikeTheBackend)
  const { api, storage } = await boot(null)
  await api.signUp({ ...PROFILE, name: 'Ian', username: 'ian', demo: true, friends: ['darius', 'jonathan'] })
  const { id } = await api.createSession({ ...SESSION, title: 'ian' })
  await api.inviteFriends(id, ['jonathan', 'faith'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  await api.suggestSpot(id, 'ian', 'kovan', { here: false })
  await api.suggestSpot(id, 'jonathan', 'novena', { here: true })
  await api.approveSpot(id, 'ian', 'bugis', true)
  await api.approveSpot(id, 'jonathan', 'kovan', true)
  await api.confirmSpot(id, 'bugis')
  for (const person of ['ian', 'jonathan']) await api.setPreferences(id, person, { categories: ['eat', 'activity'], until: null })
  const { slots } = await api.getPlan(id)
  for (const slot of slots.filter((s) => ['eat', 'activity'].includes(s.category))) {
    for (const person of ['ian', 'jonathan']) await api.vote(id, slot.id, person, slot.options[0].id)
  }
  await api.confirmPlan(id)
  await api.setConditions({ sessionDay: true })
  const planned = new Set((await api.getItinerary(id)).stops.map((s) => s.venue.id))
  const extra = VENUES.find((v) => ['drink', 'shop'].includes(v.category) && !planned.has(v.id))
  await api.proposeStop(id, 'ian', extra.id)
  await api.proposeStop(id, 'jonathan', VENUES.find((v) => v.category === 'drink' && v.id !== extra.id && !planned.has(v.id)).id)
  await api.addPhoto(id, 'ian', 'data:image/png;base64,AAAA')
  await api.addPhoto(id, 'faith', 'data:image/png;base64,BBBB')
  text = storage.store[STORAGE_KEY]
})
beforeEach(() => {
  stubPlanner(planner)
  planner.meetingArea.mockImplementation(answerLikeTheBackend)
})
afterEach(() => vi.unstubAllGlobals())

// What the old build stored for a real account: the same save, with the Supabase id as `authId`.
const legacyOf = (authId = 'uid-1') => {
  const saved = JSON.parse(text)
  return { ...saved, user: { ...saved.user, authId, name: 'Sam', username: 'sam' } }
}

describe('moving a save from the sample person to the account', () => {
  it('starts from a save that holds the sample id in every table that holds a person', () => {
    const [session] = JSON.parse(text).sessions
    expect(session.hostId).toBe('ian')
    expect(session.members.map((m) => m.id)).toEqual(['ian', 'jonathan', 'faith'])
    expect(Object.keys(session.locations)).toContain('ian')
    expect(session.spots.list.some((s) => s.by === 'ian' && 'ian' in s.times)).toBe(true)
    expect(Object.keys(session.spots.approvals)).toContain('ian')
    expect(Object.keys(session.spots.suggestions)).toContain('ian')
    expect(Object.keys(session.prefs)).toContain('ian')
    expect(Object.values(session.votes).every((byPerson) => !Object.keys(byPerson).length || 'ian' in byPerson)).toBe(true)
    expect(Object.keys(session.meeting.times)).toContain('ian')
    expect(session.proposals.map((p) => p.by)).toEqual(['ian', 'jonathan'])
    expect(session.photos.map((p) => p.personId)).toEqual(['ian', 'faith'])
    expect(Object.keys(JSON.parse(text).stats)).toContain('ian')
    expect(JSON.parse(text).friends).toContain('darius')
  })

  it('gives the account\'s id to every table, and leaves no `ian` behind as a value or a key', () => {
    const moved = remapLegacySave(legacyOf(), 'ian', NEW_ID, { isSample })
    // The session's title is the word on purpose: a title is text, not a person, and the walk must not touch it.
    expect(JSON.stringify(moved).replace('"title":"ian"', '"title":"kept"')).not.toMatch(/"ian"/)
    const [session] = moved.sessions
    expect(session.hostId).toBe(NEW_ID)
    expect(session.members).toEqual([
      { id: NEW_ID, role: 'host', state: 'joined' },
      expect.objectContaining({ id: 'jonathan' }),
      expect.objectContaining({ id: 'faith' }),
    ])
    expect(Object.keys(session.locations).sort()).toEqual([NEW_ID, 'jonathan'].sort())
    expect(session.spots.list.find((s) => s.by === NEW_ID)).toMatchObject({ areaId: 'kovan' })
    expect(Object.keys(session.spots.list.find((s) => s.by === NEW_ID).times)).toContain(NEW_ID)
    expect(session.spots.approvals[NEW_ID]).toEqual(['bugis'])
    expect(session.spots.suggestions[NEW_ID]).toMatchObject({ areaId: 'kovan' })
    expect(session.prefs[NEW_ID].categories).toEqual(['eat', 'activity'])
    expect(Object.values(session.votes).filter((byPerson) => Object.keys(byPerson).length).every((byPerson) => NEW_ID in byPerson && 'jonathan' in byPerson)).toBe(true)
    expect(Object.keys(session.meeting.times)).toContain(NEW_ID)
    expect(session.proposals.map((p) => p.by)).toEqual([NEW_ID, 'jonathan'])
    expect(session.photos.map((p) => p.personId)).toEqual([NEW_ID, 'faith'])
    expect(moved.user.id).toBe(NEW_ID)
    expect(Object.keys(moved.stats)).toEqual([NEW_ID])
    expect(moved.friends).toEqual([])
  })

  it('keeps the sample friends as sample ids, and everything else in the save as it was', () => {
    const before = legacyOf()
    const moved = remapLegacySave(before, 'ian', NEW_ID, { isSample })
    const [after] = moved.sessions
    expect(after.members.map((m) => m.id)).toContain('jonathan')
    expect(Object.keys(after.spots.approvals)).toContain('jonathan')
    expect(after.title).toBe('ian')
    for (const key of ['title', 'date', 'start', 'end', 'status', 'plan', 'options', 'deletedSlots', 'radius', 'createdAt']) expect(after[key]).toEqual(before.sessions[0][key])
    // The input is left alone.
    expect(before.sessions[0].hostId).toBe('ian')
  })

  it('keeps only the account\'s own result of a past season', () => {
    const saved = legacyOf()
    saved.pastSeasons = [{ number: 1, startsAt: 1, endsAt: 2, prize: 500, winners: [{ id: 'ian', seasonPoints: 400 }], standings: [{ id: 'ian', seasonPoints: 400 }, { id: 'darius', seasonPoints: 300 }] }]
    const [past] = remapLegacySave(saved, 'ian', NEW_ID, { isSample }).pastSeasons
    expect(past.winners).toEqual([{ id: NEW_ID, seasonPoints: 400 }])
    expect(past.standings).toEqual([{ id: NEW_ID, seasonPoints: 400 }])
  })

  it('refuses a table that is not the shape the data layer writes, so the caller keeps the copy and starts fresh', () => {
    const bad = legacyOf()
    bad.sessions[0].votes = { slot: 5 }
    expect(() => remapLegacySave(bad, 'ian', NEW_ID)).toThrow(TypeError)
  })

  it('knows a save of that kind', () => {
    expect(isLegacyRealSave(legacyOf('uid-1'), 'ian', 'uid-1')).toBe(true)
    expect(isLegacyRealSave(legacyOf('uid-1'), 'ian', 'uid-2')).toBe(false)
    expect(isLegacyRealSave(JSON.parse(text), 'ian', 'uid-1')).toBe(false)
    expect(isLegacyRealSave(null, 'ian', 'uid-1')).toBe(false)
  })
})

describe('signing in with such a save', () => {
  const key = `${STORAGE_KEY}:acct:uid-1`
  async function signInWith(data, tweak) {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    const { api, storage } = await boot(fake, { data })
    tweak?.(storage)
    const user = await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    return { api, storage, user }
  }

  it('copies the old save aside byte for byte before it writes anything, and the person keeps their sessions', async () => {
    const old = JSON.stringify(legacyOf())
    const writes = []
    const { api, storage, user } = await signInWith({ [key]: old }, (s) => {
      const set = s.setItem.bind(s)
      s.setItem = (k, v) => (writes.push(k), set(k, v))
    })
    expect(user).toMatchObject({ id: 'uid-1', authId: 'uid-1', name: 'Sam' })
    // The copy was written before the account's own key was.
    expect(writes.indexOf(`${key}:legacy`)).toBeGreaterThanOrEqual(0)
    expect(writes.indexOf(`${key}:legacy`)).toBeLessThan(writes.indexOf(key))
    expect(storage.store[`${key}:legacy`]).toBe(old)
    const [session] = await api.listSessions()
    expect(session).toMatchObject({ title: 'ian', hostId: 'uid-1', status: 'confirmed' })
    expect(session.activeIds).toEqual(['uid-1', 'jonathan', 'faith'])
    expect(JSON.stringify(JSON.parse(storage.store[key]).sessions).replace('"title":"ian"', '"title":"kept"')).not.toMatch(/"ian"/)
    // And the account works on it: its own start and votes are the account's.
    const mine = await api.getPlan(session.id)
    expect(mine.slots.filter((s) => s.myVote).length).toBe(2)
  })

  it('does not overwrite a copy it already holds', async () => {
    const old = JSON.stringify(legacyOf())
    const { storage } = await signInWith({ [key]: old, [`${key}:legacy`]: 'an earlier copy' })
    expect(storage.store[`${key}:legacy`]).toBe('an earlier copy')
    const copies = Object.entries(storage.store).filter(([k]) => k.startsWith(`${key}:legacy`))
    expect(copies.map(([, v]) => v)).toContain(old)
  })

  it('starts fresh, with the copy kept, when the save cannot be moved', async () => {
    const bad = legacyOf()
    bad.sessions[0].votes = { slot: 5 }
    const old = JSON.stringify(bad)
    const { api, storage, user } = await signInWith({ [key]: old })
    expect(user).toMatchObject({ id: 'uid-1', name: 'Sam' })
    expect(await api.listSessions()).toEqual([])
    expect(storage.store[`${key}:legacy`]).toBe(old)
  })

  it('writes nothing over the old save when the copy cannot be stored', async () => {
    const old = JSON.stringify(legacyOf())
    const { api, storage, user } = await signInWith({ [key]: old }, (s) => {
      const set = s.setItem.bind(s)
      s.setItem = (k, v) => {
        if (k.includes(':legacy')) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
        return set(k, v)
      }
    })
    expect(user).toMatchObject({ id: 'uid-1' })
    expect(storage.store[key]).toBe(old)
    // The account works for this visit, in memory.
    expect((await api.listSessions()).map((s) => s.title)).toEqual(['ian'])
    await api.createSession({ ...SESSION, title: 'Today' })
    expect(storage.store[key]).toBe(old)
  })

  it('also keeps a save of an older version, which is not read, instead of writing over it', async () => {
    const older = JSON.stringify({ ...legacyOf(), version: 8 })
    const { api, storage } = await signInWith({ [key]: older })
    expect(await api.listSessions()).toEqual([])
    expect(storage.store[`${key}:legacy`]).toBe(older)
  })

  it('leaves a current save of the account alone: no copy, no move', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    await first.api.createSession({ ...SESSION, title: 'Mine' })
    const current = first.storage.store[key]
    const { api, storage } = await boot(fake, { data: { [key]: current } })
    await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect((await api.listSessions()).map((s) => [s.title, s.hostId])).toEqual([['Mine', 'uid-1']])
    expect(Object.keys(storage.store).filter((k) => k.includes(':legacy'))).toEqual([])
  })
})
