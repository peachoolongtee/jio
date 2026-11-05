// lib/sessionsRemote.js on its own, for stage 4: what it reads of the slots, places and votes and how it shapes them, the vote writes it
// makes straight to the database, the calls it makes to the Jio server (the request each sends and the sentence each refusal gets), and
// the picks it writes to the person's own member row. The stand-in database is filled by the real app (two people, on a stand-in Jio
// server), and the module is then asked directly. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { WORDS, createSessionsRemote, problem } from '../sessionsRemote.js'
import { voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const asPerson = (person, backend = {}) => createSessionsRemote({ client: () => person.fake.client, me: () => person.id, backend })
const eq = (col, value) => ({ col, op: 'eq', value })
const A_OPTION = (slot) => slot.options[0].id

describe('what it reads of the plan', () => {
  it('gives the slots in the order they happen, the places best first, and the votes by slot', async () => {
    const { w, sam, kim, id, slot } = await voting()
    // A place a member added has no rank yet: it comes after the ranked ones.
    const [first, second] = slot.options
    await w.database.run({ as: SERVICE, kind: 'update', table: 'slot_options', values: { rank: null, score: null }, filters: [eq('slot_id', slot.id), eq('venue_id', first.id)] })
    await kim.api.vote(id, slot.id, kim.id, second.id)
    const read = await asPerson(sam).readPlan(id)
    expect(read).toMatchObject({ status: 'voting', hostId: sam.id, start: '12:00', end: '20:00', radius: null })
    expect(read.version).toBeGreaterThan(0)
    expect(read.slotRows.map((s) => s.start)).toEqual([...read.slotRows.map((s) => s.start)].sort((a, b) => a - b))
    expect(read.slotRows[0]).toMatchObject({ id: expect.any(String), time: expect.stringMatching(/^\d\d:\d\d$/), deleted: false })
    expect(read.optionRows[slot.id].at(-1).venueId).toBe(first.id)
    expect(read.options[slot.id]).toEqual(read.optionRows[slot.id].map((o) => o.venueId))
    expect(read.votes).toEqual({ [slot.id]: { [kim.id]: second.id } })
    expect(read.joined.sort()).toEqual([sam.id, kim.id].sort())
  })

  it('is "does not exist" for a session that is not there, is not the person\'s or is not an id', async () => {
    const { sam, id } = await voting()
    await expect(asPerson(sam).readPlan('11111111-1111-4111-8111-111111111111')).rejects.toMatchObject({ code: 'not_found' })
    await expect(asPerson(sam).readPlan('s1')).rejects.toMatchObject({ code: 'not_found' })
    const stranger = await (await import('./sessionsWorld.js')).world().open({ email: 'x@example.com', password: 'Str4nger-secret!', name: 'Xan', username: 'xan', dob: '2000-01-01', homeAreaId: 'bishan', friends: [] })
    await expect(asPerson(stranger).readPlan(id)).rejects.toMatchObject({ code: 'not_found' })
  })

  it('reads the plan rows only for sessions that are voting or past it, and none while locating', async () => {
    const { w, sam, id } = await voting()
    w.ops.length = 0
    await asPerson(sam).get(id)
    expect(w.ops.map((op) => op.table)).toEqual(expect.arrayContaining(['slots', 'slot_options', 'votes']))
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'locating' }, filters: [eq('id', id)] })
    w.ops.length = 0
    const locating = await asPerson(sam).get(id)
    expect(new Set(w.ops.map((op) => op.table)).has('slots')).toBe(false)
    expect(locating).toMatchObject({ options: {}, votes: {}, radius: null })
  })

  it('reads the slots of a long list a hundred sessions at a time, and the places and votes by slot', async () => {
    const { w, sam, id } = await voting()
    for (let i = 0; i < 102; i += 1) {
      const made = w.database.run({ as: SERVICE, kind: 'insert', table: 'sessions', values: { host_id: sam.id, title: `S${i}`, date: '2026-10-20', start_time: '12:00', end_time: '14:00' }, returning: true, columns: 'id' })
      const sid = made.data[0].id
      w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'voting', meeting_area_id: 'bugis', meeting_method: 'chosen' }, filters: [eq('id', sid)] })
      w.database.run({ as: SERVICE, kind: 'insert', table: 'slots', values: { session_id: sid, category: 'eat', start_minute: 720, duration_minutes: 60 } })
    }
    w.ops.length = 0
    const list = await asPerson(sam).list()
    expect(list).toHaveLength(103)
    expect(list.find((s) => s.id === id).options).not.toEqual({})
    const reads = w.ops.filter((op) => op.table === 'slots')
    expect(reads.length).toBe(2)
    for (const op of reads) expect(op.filters[0].value.length).toBeLessThanOrEqual(100)
    expect(list.filter((s) => s.status === 'voting').every((s) => Object.keys(s.options).length === (s.id === id ? 4 : 1))).toBe(true)
  })

  it('leaves what the planner said of each slot and place (details) out of the reads Home and the session screens use, and has it for the Vote page', async () => {
    const { w, sam, id } = await voting()
    const columnsOf = (table) => w.ops.filter((op) => op.kind === 'select' && op.table === table).map((op) => op.columns)
    w.ops.length = 0
    await asPerson(sam).list()
    await asPerson(sam).get(id)
    for (const columns of [...columnsOf('slots'), ...columnsOf('slot_options')]) expect(columns).not.toMatch(/details/)
    expect(columnsOf('slots')).toHaveLength(2)
    expect(columnsOf('slot_options')).toHaveLength(2)
    w.ops.length = 0
    const read = await asPerson(sam).readPlan(id)
    for (const columns of [...columnsOf('slots'), ...columnsOf('slot_options')]) expect(columns).toMatch(/details/)
    expect(read.slotRows[0].details).toMatchObject({ widened: expect.any(Boolean) })
    expect(Object.values(read.optionRows)[0][0].details).toMatchObject({ walkMinutes: expect.any(Number) })
    // A session read without them still has its slots and its places, with empty details.
    const listed = await asPerson(sam).get(id)
    expect(listed.slotRows).toHaveLength(4)
    expect(listed.slotRows.every((slot) => Object.keys(slot.details).length === 0)).toBe(true)
    expect(Object.values(listed.options).every((ids) => ids.length > 0)).toBe(true)
  })

  it('never loses a vote to the 1,000 rows one answer can hold: a read that comes back full is split and read again', async () => {
    // A client that answers a votes read as the project's API does: at most 1,000 rows, with no word that it cut the rest.
    const slotIds = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`)
    const perSlot = 45
    const rows = slotIds.flatMap((slot, s) => Array.from({ length: perSlot }, (_, u) => ({ slot_id: slot, user_id: `u${u}`, venue_id: `v${s}`, updated_at: '2026-10-09T10:00:00Z' })))
    const asked = []
    const client = {
      from: (table) => ({
        select: () => ({
          in: async (column, ids) => {
            asked.push({ table, column, count: ids.length })
            return { data: rows.filter((r) => ids.includes(r.slot_id)).slice(0, 1000), error: null }
          },
        }),
      }),
    }
    const remote = createSessionsRemote({ client: () => client, me: () => 'sam' })
    const votes = await remote.readSlotVotes(slotIds, Array.from({ length: perSlot }, (_, u) => `u${u}`))
    expect(Object.keys(votes)).toHaveLength(60)
    expect(Object.values(votes).every((byPerson) => Object.keys(byPerson).length === perSlot)).toBe(true)
    // It started with groups of 25 slots, and halved the ones that came back full.
    expect(asked[0].count).toBe(25)
    expect(asked.some((a) => a.count < 25)).toBe(true)
  })

  it('reads the votes of 25 slots at a time, which a full session of 30 people cannot fill', async () => {
    const slotIds = Array.from({ length: 60 }, (_, i) => `00000000-0000-4000-8000-${i.toString(16).padStart(12, '0')}`)
    const rows = slotIds.flatMap((slot) => Array.from({ length: 30 }, (_, u) => ({ slot_id: slot, user_id: `u${u}`, venue_id: 'v', updated_at: 'x' })))
    const asked = []
    const client = { from: () => ({ select: () => ({ in: async (column, ids) => (asked.push(ids.length), { data: rows.filter((r) => ids.includes(r.slot_id)).slice(0, 1000), error: null }) }) }) }
    const votes = await createSessionsRemote({ client: () => client, me: () => 'sam' }).readSlotVotes(slotIds, Array.from({ length: 30 }, (_, u) => `u${u}`))
    expect(Object.values(votes).every((byPerson) => Object.keys(byPerson).length === 30)).toBe(true)
    expect(asked).toEqual([25, 25, 10])
  })

  it('reads a person\'s picks and the radius, and nothing of where anyone is', async () => {
    const { w, sam, kim, id } = await voting()
    await w.database.run({ as: kim.id, kind: 'update', table: 'session_members', values: { categories: ['eat', 'shop'], stay_until: '17:30:00' }, filters: [eq('session_id', id), eq('user_id', kim.id)] })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { radius_meters: 500 }, filters: [eq('id', id)] })
    const read = await asPerson(sam).get(id)
    expect(read.prefs).toEqual({ [kim.id]: { categories: ['eat', 'shop'], until: 1050 } })
    expect(read.radius).toBe(500)
    expect(JSON.stringify(read.prefs)).not.toContain('label')
  })
})

describe('casting a vote', () => {
  it('casts, moves and takes back, reading the person\'s own vote first', async () => {
    const { w, sam, id, slot } = await voting()
    const remote = asPerson(sam)
    const [a, b] = slot.options.map((o) => o.id)
    w.ops.length = 0
    expect(await remote.castVote(id, slot.id, a)).toBe(a)
    expect(w.ops.map((op) => [op.kind, op.table])).toEqual([['select', 'votes'], ['insert', 'votes']])
    expect(await remote.castVote(id, slot.id, b)).toBe(b)
    expect(w.ops.at(-1)).toMatchObject({ kind: 'update', table: 'votes', values: { venue_id: b } })
    expect(await remote.castVote(id, slot.id, b)).toBeNull()
    expect(w.ops.at(-1)).toMatchObject({ kind: 'delete', table: 'votes' })
    expect(w.ops.at(-1).filters).toContainEqual({ col: 'venue_id', op: 'eq', value: b })
    expect(w.database.tables.votes).toEqual([])
  })

  it('leaves a vote another device moved meanwhile when asked to take back the old one', async () => {
    const { w, sam, id, slot } = await voting()
    const [a, b] = slot.options.map((o) => o.id)
    await asPerson(sam).castVote(id, slot.id, a)
    // Between the read and the delete the other device moves the vote to b.
    const original = w.database.run
    w.database.run = (op) => {
      if (op.kind === 'delete' && op.table === 'votes') original({ as: sam.id, kind: 'update', table: 'votes', values: { venue_id: b }, filters: [eq('slot_id', slot.id), eq('user_id', sam.id)] })
      return original(op)
    }
    const after = await asPerson(sam).castVote(id, slot.id, a)
    w.database.run = original
    // The vote for a went when it was asked to; the one moved to b is not touched, and what is there now is reported.
    expect(after).toBe(b)
    expect(w.database.tables.votes).toMatchObject([{ venue_id: b }])
  })

  it('words each refusal: the place is gone, the session is over or not voting, the person is out, the category is gone, a bad id', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const a = A_OPTION(slot)
    await expect(asPerson(sam).castVote(id, slot.id, 'nowhere')).rejects.toMatchObject({ code: 'option_not_found', message: WORDS.optionGone })
    await expect(asPerson(sam).castVote(id, 'not-an-id', a)).rejects.toMatchObject({ code: 'slot_not_found', message: WORDS.slotGone })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('user_id', kim.id)] })
    await expect(asPerson(kim).castVote(id, slot.id, a)).rejects.toMatchObject({ code: 'not_joined', message: WORDS.notIn })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'slots', values: { deleted: true }, filters: [eq('id', slot.id)] })
    await expect(asPerson(sam).castVote(id, slot.id, a)).rejects.toMatchObject({ code: 'slot_not_found' })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    await expect(asPerson(sam).castVote(id, slot.id, a)).rejects.toMatchObject({ code: 'wrong_status', message: WORDS.votesClosed })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'cancelled' }, filters: [eq('id', id)] })
    await expect(asPerson(sam).castVote(id, slot.id, a)).rejects.toMatchObject({ code: 'wrong_status', message: WORDS.closed })
    expect(w.database.tables.votes).toEqual([])
  })

  it('needs a signed-in person and a client', async () => {
    const { sam, id, slot } = await voting()
    await expect(createSessionsRemote({ client: () => sam.fake.client, me: () => null }).castVote(id, slot.id, 'x')).rejects.toMatchObject({ message: WORDS.signedOut })
    await expect(createSessionsRemote({ client: () => null, me: () => sam.id }).castVote(id, slot.id, 'x')).rejects.toMatchObject({ code: 'offline' })
  })
})

describe('the calls to the Jio server', () => {
  const calls = () => {
    const sent = []
    const backend = Object.fromEntries(
      ['syncPlan', 'setRadius', 'deleteSlot', 'restoreSlots', 'addOption', 'moreOptions', 'swapOption', 'searchSlot', 'venues'].map((name) => [name, async (...args) => (sent.push([name, ...args]), { added: true, swapped: true })]),
    )
    return { sent, backend }
  }

  it('passes each request on and resolves what the screens need of the answer', async () => {
    const { sam } = await voting()
    const { sent, backend } = calls()
    backend.moreOptions = async () => ({ added: ['v1', 'v2'] })
    backend.addOption = async () => ({ added: false })
    backend.swapOption = async () => ({ swapped: false })
    backend.searchSlot = async () => [{ id: 'v1' }]
    const remote = asPerson(sam, backend)
    await remote.setRadius('s', 500)
    await remote.removeSlot('s', 'l')
    await remote.restoreSlots('s')
    await remote.syncPlan('s')
    expect(await remote.addOption('s', 'l', 'v1')).toBe(false)
    expect(await remote.moreOptions('s', 'l', 3)).toEqual(['v1', 'v2'])
    expect(await remote.swapOption('s', 'l', 'a', 'b')).toBe(false)
    expect(await remote.searchSlot('s', 'l', 'x')).toEqual([{ id: 'v1' }])
    expect(sent.map((c) => c[0])).toEqual(['setRadius', 'deleteSlot', 'restoreSlots', 'syncPlan'])
  })

  it('words the server\'s refusals by code, and a call can word a code its own way', async () => {
    const { sam } = await voting()
    const refuse = (code, status = 409) => async () => { throw Object.assign(new Error('server words'), { code, status }) }
    const remote = asPerson(sam, { setRadius: refuse('host_only', 403), deleteSlot: refuse('slot_not_found', 404), addOption: refuse('slot_full'), moreOptions: refuse('wrong_status'), swapOption: refuse('option_not_found', 404), venues: refuse('venue_not_found', 404), syncPlan: refuse('plan_busy') })
    await expect(remote.setRadius('s', 100)).rejects.toMatchObject({ message: WORDS.hostRadius, code: 'host_only', status: 403 })
    await expect(remote.removeSlot('s', 'l')).rejects.toMatchObject({ message: WORDS.slotGone })
    await expect(remote.addOption('s', 'l', 'v')).rejects.toMatchObject({ message: WORDS.slotFull })
    await expect(remote.moreOptions('s', 'l', 1)).rejects.toMatchObject({ message: WORDS.placesClosed })
    await expect(remote.swapOption('s', 'l', 'a', 'b')).rejects.toMatchObject({ message: WORDS.optionGone })
    await expect(remote.venues(['v'])).rejects.toMatchObject({ message: WORDS.noVenue })
    await expect(remote.syncPlan('s')).rejects.toMatchObject({ message: WORDS.busy })
    expect(problem({ code: 'venue_does_not_fit' }).message).toBe(WORDS.doesNotFit)
    expect(problem({ code: 'host_only' }, { host_only: 'Mine.' }).message).toBe('Mine.')
  })

  it('keeps a failure that is not the server\'s words (no answer) as it is, so the caller can tell a refusal from silence', async () => {
    const { sam } = await voting()
    const remote = asPerson(sam, { setRadius: async () => { throw new Error('Cannot reach the Jio planner right now.') } })
    const err = await remote.setRadius('s', 100).catch((e) => e)
    expect(err.message).toBe('Cannot reach the Jio planner right now.')
    expect(err.code).toBeUndefined()
    expect(err.status).toBeUndefined()
  })
})

describe('the person\'s own picks', () => {
  it('writes categories and a stay, answers what it replaced, and puts it back only if the row is as this write left it', async () => {
    const { w, kim, id } = await voting()
    const remote = asPerson(kim)
    const row = () => w.database.tables.session_members.find((m) => m.user_id === kim.id)
    const first = await remote.setPrefs(id, { categories: ['eat'], until: 18 * 60 })
    expect(first).toMatchObject({ categories: [], stayUntil: null })
    expect(row()).toMatchObject({ categories: ['eat'], stay_until: '18:00:00' })
    // Put back: the row is as the write left it.
    vi.setSystemTime(new Date('2026-10-09T10:01:00'))
    await remote.restorePrefs(id, first)
    expect(row()).toMatchObject({ categories: [], stay_until: null })
    // Not put back: another device changed it after.
    const second = await remote.setPrefs(id, { categories: ['drink'], until: null })
    vi.setSystemTime(new Date('2026-10-09T10:02:00'))
    await w.database.run({ as: kim.id, kind: 'update', table: 'session_members', values: { categories: ['shop'] }, filters: [eq('user_id', kim.id)] })
    await remote.restorePrefs(id, second)
    expect(row().categories).toEqual(['shop'])
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  })

  it('refuses a person who is not in the session, and restore never throws', async () => {
    const { w, kim, id } = await voting()
    await w.database.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [eq('user_id', kim.id)] })
    await expect(asPerson(kim).setPrefs(id, { categories: ['eat'], until: null })).rejects.toMatchObject({ code: 'not_joined' })
    await expect(createSessionsRemote({ client: () => null, me: () => kim.id }).restorePrefs(id, { categories: [], stayUntil: null, wroteAt: 'x' })).resolves.toBeUndefined()
  })
})
