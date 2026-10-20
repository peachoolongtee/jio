// lib/sessionsRemote.js on its own, for stage 3: what it reads of a session's start places and meeting spots and how it shapes them,
// the writes it makes straight to the database, and the sentences it gives the server's refusals. The stand-in database is filled by
// the real app (two people, on a stand-in Jio server), and the module is then asked directly. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { WORDS, createSessionsRemote, problem } from '../sessionsRemote.js'
import { KIM_PLACE, SAM_PLACE, locating } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// The module as `person` (a copy of the app from sessionsWorld) would use it.
// How to call: const remote = asPerson(sam)
const asPerson = (person, backend = {}) => createSessionsRemote({ client: () => person.fake.client, me: () => person.id, backend })
const eq = (col, value) => ({ col, op: 'eq', value })

describe('what it reads of a session', () => {
  it('gives each member\'s areas as locations, and the exact label only to its owner', async () => {
    const { sam, kim, id } = await locating({ places: true })
    const mine = await asPerson(sam).get(id)
    expect(mine.locations).toEqual({
      [sam.id]: { start: { areaId: 'tampines', label: SAM_PLACE.label }, end: null },
      [kim.id]: { start: { areaId: 'bishan', label: '' }, end: null },
    })
    const hers = await asPerson(kim).get(id)
    expect(hers.locations[kim.id].start.label).toBe(KIM_PLACE.label)
    expect(hers.locations[sam.id].start.label).toBe('')
    expect(JSON.stringify(mine)).not.toContain('Blk 123')
  })

  it('lists the app\'s spots by rank and then the suggestions, the oldest first, each with who suggested it and who approved it', async () => {
    const { w, sam, kim, id } = await locating({ places: true, third: true })
    await asPerson(sam).get(id)
    const lee = w.database.tables.session_members.find((m) => m.role === 'guest' && m.user_id !== kim.id).user_id
    vi.setSystemTime(new Date('2026-10-09T10:01:00'))
    await kim.api.suggestSpot(id, kim.id, 'orchard', { here: true })
    vi.setSystemTime(new Date('2026-10-09T10:02:00'))
    await w.database.run({ as: SERVICE, kind: 'insert', table: 'spot_suggestions', values: { session_id: id, user_id: lee, area_id: 'punggol' } })
    await sam.api.approveSpot(id, sam.id, 'orchard', true)
    await kim.api.approveSpot(id, kim.id, 'orchard', true)
    // The server prices the new suggestion with the next change to the list.
    await sam.api.setLocation(id, sam.id, 'end', { areaId: 'tampines', label: 'Home' })
    const read = await asPerson(sam).get(id)
    const areas = read.spots.list.map((s) => s.areaId)
    expect(areas.slice(3)).toEqual(['orchard', 'punggol'])
    expect(read.spots.list.slice(0, 3).map((s) => s.by)).toEqual(['app', 'app', 'app'])
    expect(read.spots.list[3]).toMatchObject({ by: kim.id, here: true })
    expect(read.spots.list[4]).toMatchObject({ by: lee, here: false })
    expect(read.spots.suggestions).toEqual({ [kim.id]: { areaId: 'orchard', here: true }, [lee]: { areaId: 'punggol', here: false } })
    expect(read.spots.approvals).toEqual({ [sam.id]: ['orchard'], [kim.id]: ['orchard'] })
  })

  it('keeps the longest trip unrounded for the tie-break, and rounds what is shown', async () => {
    const { w, sam, id } = await locating({ places: true })
    const [first] = (await asPerson(sam).get(id)).spots.list
    await w.database.run({ as: SERVICE, kind: 'update', table: 'session_spots', values: { worst_minutes: 20.4, mean_minutes: 15.2, travel_minutes: { [sam.id]: 20.4, [w.database.tables.session_members[1].user_id]: 10 } }, filters: [eq('session_id', id), eq('area_id', first.areaId)] })
    const [after] = (await asPerson(sam).get(id)).spots.list
    expect(after).toMatchObject({ worstMinutes: 20, exactWorst: 20.4, meanMinutes: 15 })
  })

  it('says "same" when everyone starts in one area, and "fairest" otherwise, and nothing with no list', async () => {
    const { sam, kim, id } = await locating({ places: true })
    expect((await asPerson(sam).get(id)).spots.appMethod).toBe('fairest')
    await kim.api.setLocation(id, kim.id, 'start', { areaId: 'tampines', label: 'Next door' })
    expect((await asPerson(sam).get(id)).spots.appMethod).toBe('same')
    const alone = await locating()
    expect((await asPerson(alone.sam).get(alone.id)).spots).toEqual({ list: [], approvals: {}, suggestions: {}, appMethod: null })
  })

  it('gives the confirmed meeting area with each trip to it, from the spot kept as the record', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const [spot] = (await asPerson(sam).get(id)).spots.list
    await sam.api.confirmSpot(id, spot.areaId)
    const read = await asPerson(kim).get(id)
    expect(read).toMatchObject({ status: 'voting', planVersion: expect.any(Number) })
    expect(read.meeting).toEqual({ areaId: spot.areaId, method: 'chosen', times: spot.times, maxMinutes: spot.worstMinutes, totalMinutes: Object.values(spot.times).reduce((a, b) => a + b, 0), count: 2, approximate: false })
    // With the spot row gone, the minutes on the members' rows are the trips.
    await w.database.run({ as: SERVICE, kind: 'delete', table: 'session_spots', filters: [eq('session_id', id)] })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { travel_minutes: 17 }, filters: [eq('session_id', id)] })
    const bare = await asPerson(kim).get(id)
    expect(bare.meeting.times).toEqual({ [sam.id]: 17, [kim.id]: 17 })
    expect(bare.spots.list).toEqual([])
  })

  it('leaves the meeting empty while locating, and reads no spot table for a session still inviting', async () => {
    const { w, sam, id } = await locating({ places: true })
    expect((await asPerson(sam).get(id)).meeting).toBeNull()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'inviting' }, filters: [eq('id', id)] })
    w.ops.length = 0
    await asPerson(sam).get(id)
    expect(new Set(w.ops.map((op) => op.table))).toEqual(new Set(['sessions', 'session_members', 'invites']))
  })

  it('names the gap when a start changed and the spots were never priced again, and not otherwise', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    expect((await asPerson(sam).get(id)).spotsStale).toBe('')
    vi.setSystemTime(new Date('2026-10-09T10:05:00'))
    await w.database.run({ as: kim.id, kind: 'update', table: 'session_members', values: { start_area_id: 'woodlands' }, filters: [eq('session_id', id), eq('user_id', kim.id)] })
    const gap = (await asPerson(sam).get(id)).spotsStale
    expect(gap).toBe(String(Date.parse('2026-10-09T10:05:00')))
    await sam.api.setLocation(id, sam.id, 'end', { areaId: 'tampines', label: 'Home' })
    expect((await asPerson(sam).get(id)).spotsStale).toBe('')
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  })

  it('shows people invited by name only while the session is inviting', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    w.database.setProfile('00000000-0000-4000-8000-000000000999', { username: 'zed', display_name: 'Zed', avatar_url: null })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'inviting' }, filters: [eq('id', id)] })
    await asPerson(sam).invitePerson(id, '00000000-0000-4000-8000-000000000999')
    expect((await asPerson(sam).get(id)).members.map((m) => m.state)).toEqual(['joined', 'joined', 'invited'])
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'locating' }, filters: [eq('id', id)] })
    expect((await asPerson(kim).get(id)).members.map((m) => m.state)).toEqual(['joined', 'joined'])
  })
})

describe('what it writes straight to the database', () => {
  it('keeps one end of the route: the label first, then the area, and answers with what it replaced', async () => {
    const { w, sam, id } = await locating()
    const remote = asPerson(sam)
    expect(await remote.setPlace(id, 'start', { areaId: 'bugis', label: 'Bugis Junction' })).toEqual({ which: 'start', areaId: null, label: null, hadStart: false })
    expect(await remote.setPlace(id, 'start', { areaId: 'orchard', label: 'x'.repeat(300) })).toEqual({ which: 'start', areaId: 'bugis', label: 'Bugis Junction', hadStart: true })
    // A label over the database's 120 characters is cut, not refused.
    expect(w.database.tables.session_member_places[0].start_label).toHaveLength(120)
    await remote.setPlace(id, 'start', null)
    expect(w.database.tables.session_members.find((m) => m.user_id === sam.id).start_area_id).toBeNull()
    expect(w.database.tables.session_member_places[0].start_label).toBeNull()
  })

  it('puts a refused write back, and never fails while doing so', async () => {
    const { w, sam, id } = await locating({ places: true })
    const remote = asPerson(sam)
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'cancelled' }, filters: [eq('id', id)] })
    await expect(remote.setPlace(id, 'start', { areaId: 'bugis', label: 'Bugis Junction' })).rejects.toMatchObject({ code: '42501' })
    await expect(remote.restorePlace(id, { which: 'start', areaId: 'tampines', label: SAM_PLACE.label })).resolves.toBeUndefined()
    // Nothing of the refused write got in.
    expect(w.database.tables.session_members.find((m) => m.user_id === sam.id).start_area_id).toBe('tampines')
    expect(w.database.tables.session_member_places.find((p) => p.user_id === sam.id).start_label).toBe(SAM_PLACE.label)
  })

  it('says someone who is not in the session is not in it', async () => {
    const { w, sam, id } = await locating({ places: true })
    const outsider = await w.open({ email: 'zed@example.com', password: 'Z3d-secret!!', name: 'Zed', username: 'zed_out', dob: '1997-01-01', homeAreaId: 'bishan', friends: [] })
    await expect(asPerson(outsider).setPlace(id, 'start', { areaId: 'bugis', label: 'x' })).rejects.toMatchObject({ code: 'not_joined', message: WORDS.notIn })
    expect(sam.id).toBeTruthy()
  })

  it('words the database\'s refusal of a mark', async () => {
    const { sam, kim, id } = await locating({ places: true })
    const remote = asPerson(kim)
    await expect(remote.approve(id, 'woodlands', true)).rejects.toMatchObject({ code: 'spot_not_found', message: WORDS.spotGone })
    const [spot] = (await asPerson(sam).get(id)).spots.list
    await sam.api.confirmSpot(id, spot.areaId)
    await expect(remote.approve(id, spot.areaId, true)).rejects.toMatchObject({ code: 'wrong_status', message: WORDS.spotsClosed })
  })

  it('asks the server through the backend it is given, and words what the server refused', async () => {
    const { sam, id } = await locating({ places: true })
    const calls = []
    const refuse = (code) => Object.assign(new Error('raw'), { code })
    const backend = {
      refreshSpots: async (...a) => (calls.push(['refresh', ...a]), { planVersion: 1 }),
      putSpot: async (...a) => (calls.push(['put', ...a]), { planVersion: 1 }),
      deleteSpot: async (...a) => (calls.push(['delete', ...a]), { planVersion: 1 }),
      confirmSpot: async (...a) => (calls.push(['confirm', ...a]), { planVersion: 1 }),
      knownPlace: async (...a) => (calls.push(['known', ...a]), { planVersion: 1 }),
      optOut: async (...a) => (calls.push(['out', ...a]), { planVersion: 1 }),
      rejoin: async (...a) => (calls.push(['rejoin', ...a]), { planVersion: 1 }),
    }
    const remote = asPerson(sam, backend)
    await remote.refreshSpots(id, 'start')
    await remote.suggest(id, 'bugis', { here: true })
    await remote.suggest(id, 'orchard')
    await remote.withdraw(id)
    await remote.confirm(id, 'bugis')
    await remote.confirm(id)
    await remote.knownPlace(id, 'bugis')
    await remote.optOut(id)
    await remote.rejoin(id)
    expect(calls).toEqual([
      ['refresh', id, 'start'], ['put', id, 'bugis', true], ['put', id, 'orchard', false], ['delete', id], ['confirm', id, 'bugis'], ['confirm', id, undefined],
      ['known', id, 'bugis'], ['out', id], ['rejoin', id],
    ])
    const refused = asPerson(sam, { confirmSpot: async () => { throw refuse('host_only') }, knownPlace: async () => { throw refuse('wrong_status') } })
    await expect(refused.confirm(id)).rejects.toMatchObject({ message: 'Only the host can confirm a spot.', code: 'host_only' })
    await expect(refused.knownPlace(id, 'bugis')).rejects.toMatchObject({ message: 'A known place can only be set before the group votes on places.' })
  })
})

describe('the sentences for what the server refuses', () => {
  it('has a plain sentence for every code of the contract, and keeps the code', () => {
    const codes = ['session_not_found', 'not_joined', 'host_only', 'wrong_status', 'no_spots', 'too_many_spots', 'spot_not_found', 'needs_two_people', 'unknown_area', 'area_not_priced', 'plan_busy', 'group_too_large', 'host_cannot_opt_out', 'host_cannot_leave', 'session_closed', 'member_not_found']
    for (const code of codes) {
      const err = problem(Object.assign(new Error('The planner had a problem. Try again.'), { code }))
      expect(err.code).toBe(code)
      expect(err.message).not.toBe('The planner had a problem. Try again.')
      expect(err.message).toMatch(/^[A-Z].*\.$/)
    }
  })

  it('keeps the message of an error with no code of its own (no connection, too many requests), and falls back to a plain sentence', () => {
    expect(problem(new Error('Cannot reach the Jio planner right now. Check your connection and try again.')).message).toBe('Cannot reach the Jio planner right now. Check your connection and try again.')
    expect(problem({}).message).toBe(WORDS.notSaved)
    expect(problem(undefined).message).toBe(WORDS.notSaved)
    expect(problem(Object.assign(new Error('x'), { code: 'something_new' })).message).toBe('x')
  })

  it('lets a caller word a code its own way', () => {
    expect(problem(Object.assign(new Error('x'), { code: 'host_only' }), { host_only: 'Only the host can remove someone.' }).message).toBe('Only the host can remove someone.')
  })
})
