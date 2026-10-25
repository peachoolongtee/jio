// lib/sessionsRemote.js on its own, for stage 5 (the plan on the server): what it reads of the plan (the stops, how the group travels between
// them, when the plan starts, the sentence about the order, the question "Re-plan?", the proposals waiting, how the outing ended), the
// suggested order it accepts from the server, the calls it makes (the request each sends and the sentence each refusal gets), the
// person's own ledger row, and the live events a stop raises. The stand-in database is filled by the real app (two people, on the stand-in
// Jio server), and the module is then asked directly. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { WORDS, createSessionsRemote, problem } from '../sessionsRemote.js'
import { confirmed, voted, voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
})
afterEach(() => vi.unstubAllGlobals())

const asPerson = (person, backend = {}) => createSessionsRemote({ client: () => person.fake.client, me: () => person.id, backend })
const eq = (col, value) => ({ col, op: 'eq', value })
const rowsOf = (w, table) => w.database.tables[table]
const refused = (code, status = 409, message = 'nope') => Object.assign(new Error(message), { code, status })

describe('what it reads of the plan', () => {
  it('gives the stops in order, each with its row\'s id, and the plan in the shape the local layer keeps it in', async () => {
    const { w, sam, id } = await confirmed()
    const read = await asPerson(sam).get(id)
    const rows = [...rowsOf(w, 'stops')].sort((a, b) => a.seq - b.seq)
    expect(read.status).toBe('confirmed')
    expect(read.plan.stops.map((s) => s.stopId)).toEqual(rows.map((r) => r.id))
    expect(read.plan.stops[0]).toEqual({ stopId: rows[0].id, slotId: rows[0].slot_id, category: rows[0].category, venueId: rows[0].venue_id, plannedStart: rows[0].planned_start_minute, duration: rows[0].duration_minutes })
    // N stops have N - 1 legs, each the mode of the stop it leads to (none chosen yet).
    expect(read.plan.modes).toEqual(Array(rows.length - 1).fill(undefined))
    expect(read.plan.startAt).toBe(Math.min(...rows.map((r) => r.planned_start_minute)))
    expect(read.plan.aiNote).toBeNull()
    expect(read.replan).toBeNull()
    expect(read.proposals).toEqual([])
  })

  it('carries how the group travels to a stop as the mode of the leg into it, and a stop\'s earliest start', async () => {
    const { w, sam, id } = await confirmed()
    const rows = [...rowsOf(w, 'stops')].sort((a, b) => a.seq - b.seq)
    await w.database.run({ as: SERVICE, kind: 'update', table: 'stops', values: { travel_mode: 'car', not_before_minute: 800 }, filters: [eq('id', rows[2].id)] })
    const read = await asPerson(sam).get(id)
    expect(read.plan.modes[1]).toBe('car')
    expect(read.plan.modes[0]).toBeUndefined()
    expect(read.plan.stops[2].notBefore).toBe(800)
    expect(read.plan.stops[1]).not.toHaveProperty('notBefore')
  })

  it('reads the order\'s sentence and its source only as a pair, and the plan\'s start from the session', async () => {
    const { w, sam, id } = await confirmed()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { order_reason: 'Shops first.', order_source: 'rules', plan_start_minute: 705 }, filters: [eq('id', id)] })
    const read = await asPerson(sam).get(id)
    expect(read.plan.aiNote).toEqual({ reason: 'Shops first.', source: 'rules' })
    expect(read.plan.startAt).toBe(705)
  })

  it('names a stop with no slot (one made from a proposal) "roam-<id>", as the local layer names it', async () => {
    const { w, sam, id } = await confirmed()
    const made = await w.database.run({ as: SERVICE, kind: 'insert', table: 'stops', values: { session_id: id, seq: rowsOf(w, 'stops').length, slot_id: null, category: 'eat', venue_id: 'kovan-209-market', planned_start_minute: 1100, duration_minutes: 60, not_before_minute: 1100 }, returning: true, columns: 'id' })
    const read = await asPerson(sam).get(id)
    expect(read.plan.stops.at(-1)).toMatchObject({ stopId: made.data[0].id, slotId: `roam-${made.data[0].id}`, notBefore: 1100 })
  })

  it('has no plan while voting, or once confirmed with no stops', async () => {
    const { w, sam, id } = await voted()
    expect((await asPerson(sam).get(id)).plan).toBeNull()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    expect((await asPerson(sam).get(id)).plan).toBeNull()
  })

  it('reads the question "Re-plan?" only for a confirmed plan, with its sentence', async () => {
    const { w, sam, id } = await confirmed()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { replan: { reason: 'Kim opted out.', trigger: { kind: 'optout' }, at: 1760000000000 } }, filters: [eq('id', id)] })
    expect((await asPerson(sam).get(id)).replan).toEqual({ reason: 'Kim opted out.', trigger: { kind: 'optout' } })
    // Whatever it holds, a question with no sentence reads as a plain one.
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { replan: { trigger: 'x' } }, filters: [eq('id', id)] })
    expect((await asPerson(sam).get(id)).replan).toMatchObject({ reason: 'The group changed.' })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'completed' }, filters: [eq('id', id)] })
    expect((await asPerson(sam).get(id)).replan).toBeNull()
  })

  it('reads the places waiting to be added, oldest first, and not the ones already answered', async () => {
    const { w, sam, kim, id } = await confirmed()
    const put = (user, venue, at, extra = {}) => w.database.run({ as: SERVICE, kind: 'insert', table: 'stop_proposals', values: { session_id: id, venue_id: venue, proposed_by: user, created_at: at, ...extra } })
    put(kim.id, 'kovan-209-market', '2026-10-09T10:05:00.000Z')
    put(sam.id, 'serangoon-library', '2026-10-09T10:01:00.000Z')
    put(kim.id, 'lolas-cafe', '2026-10-09T10:09:00.000Z', { status: 'accepted', resolved_at: '2026-10-09T10:10:00.000Z', resolved_by: sam.id })
    const read = await asPerson(sam).get(id)
    expect(read.proposals.map((p) => [p.venueId, p.by])).toEqual([['serangoon-library', sam.id], ['kovan-209-market', kim.id]])
    expect(read.proposals[0]).toMatchObject({ id: expect.any(String), at: Date.parse('2026-10-09T10:01:00.000Z') })
  })

  it('says how a finished outing ended, and shows no proposals for it', async () => {
    const { w, sam, id } = await confirmed()
    await w.database.run({ as: SERVICE, kind: 'insert', table: 'stop_proposals', values: { session_id: id, venue_id: 'kovan-209-market', proposed_by: sam.id } })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'completed', completed_at: '2026-10-09T13:00:00.000Z' }, filters: [eq('id', id)] })
    const read = await asPerson(sam).get(id)
    expect(read).toMatchObject({ status: 'completed', endedBy: 'hand', completedAt: Date.parse('2026-10-09T13:00:00.000Z'), proposals: [] })
    expect(read.plan.stops.length).toBeGreaterThan(0)
  })

  it('reads the stops and the proposals only for sessions that are confirmed or finished, a hundred sessions at a time', async () => {
    const { w, sam, id } = await confirmed()
    for (let i = 0; i < 204; i += 1) {
      const made = w.database.run({ as: SERVICE, kind: 'insert', table: 'sessions', values: { host_id: sam.id, title: `S${i}`, date: '2026-10-20', start_time: '12:00', end_time: '14:00' }, returning: true, columns: 'id' })
      w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: i % 2 ? 'confirmed' : 'inviting' }, filters: [eq('id', made.data[0].id)] })
    }
    w.ops.length = 0
    const list = await asPerson(sam).list()
    const reads = w.ops.filter((op) => op.kind === 'select' && ['stops', 'stop_proposals'].includes(op.table))
    expect(reads.map((op) => op.table).sort()).toEqual(['stop_proposals', 'stop_proposals', 'stops', 'stops'])
    for (const op of reads) {
      expect(op.filters.find((f) => f.col === 'session_id').value.length).toBeLessThanOrEqual(100)
      const wanted = op.filters.find((f) => f.col === 'session_id').value
      for (const sid of wanted) expect(['confirmed', 'completed']).toContain(list.find((s) => s.id === sid).status)
    }
    expect(reads.filter((op) => op.table === 'stop_proposals').every((op) => op.filters.some((f) => f.col === 'status' && f.value === 'pending'))).toBe(true)
    expect(list.find((s) => s.id === id).plan.stops.length).toBeGreaterThan(0)
    expect(list.filter((s) => s.status === 'inviting').every((s) => s.plan === null)).toBe(true)
  })

  it('reads the stops of a session that is voting or locating not at all', async () => {
    const { w, sam, id } = await voted()
    w.ops.length = 0
    await asPerson(sam).get(id)
    expect(w.ops.some((op) => op.table === 'stops' || op.table === 'stop_proposals')).toBe(false)
  })

  it('reads the order columns and never the suggestion the server keeps for itself', async () => {
    const { w, sam, id } = await confirmed()
    w.ops.length = 0
    await asPerson(sam).get(id)
    const columns = w.ops.find((op) => op.table === 'sessions').columns
    for (const wanted of ['replan', 'completed_at', 'order_reason', 'order_source', 'plan_start_minute']) expect(columns).toContain(wanted)
    expect(columns).not.toContain('order_suggestion')
  })

  it('reads no one\'s exact place while it reads the plan', async () => {
    const { w, sam, id } = await confirmed()
    w.ops.length = 0
    await asPerson(sam).get(id)
    for (const op of w.ops.filter((o) => o.table === 'session_member_places')) {
      expect(op.columns).not.toMatch(/lat|lng/)
      expect(op.filters.find((f) => f.col === 'user_id')?.value).toBe(sam.id)
    }
  })
})

describe('the suggested order it accepts', () => {
  const BASIS = 'ab12'.repeat(16)
  const answer = (over = {}) => ({ status: 'ok', basis: BASIS, order: ['s1', 's2'], stops: [{ slotId: 's1', venueId: 'v1', start: 600 }, { slotId: 's2', venueId: 'v2', start: 700 }], reason: 'Shops first.', source: 'ai', ...over })
  const suggest = (given) => createSessionsRemote({ client: () => ({}), me: () => 'u1', backend: { suggestOrder: async () => given } }).suggestOrder('s')

  it('takes a whole answer as it is, and trims it to the fields the dialog reads', async () => {
    expect(await suggest({ ...answer(), extra: 1, stops: answer().stops.map((s) => ({ ...s, name: 'sent by mistake' })) })).toEqual({ basis: BASIS, order: ['s1', 's2'], stops: [{ slotId: 's1', venueId: 'v1', start: 600 }, { slotId: 's2', venueId: 'v2', start: 700 }], reason: 'Shops first.', source: 'ai' })
  })

  it('has none when the server has none to offer', async () => {
    expect(await suggest({ status: 'none', why: 'nothing_to_arrange' })).toBeNull()
  })

  it.each([
    ['no basis', { basis: undefined }],
    ['a basis that is not 64 hex characters', { basis: 'abc' }],
    ['an upper-case basis', { basis: BASIS.toUpperCase() }],
    ['an order and stops of different lengths', { order: ['s1'] }],
    ['an order that names a slot the stops do not', { order: ['s1', 'sX'] }],
    ['an order that repeats a slot', { order: ['s1', 's1'], stops: [{ slotId: 's1', venueId: 'v1', start: 600 }, { slotId: 's1', venueId: 'v2', start: 700 }] }],
    ['no stops', { order: [], stops: [] }],
    ['more than eight stops', { order: Array.from({ length: 9 }, (_, i) => `s${i}`), stops: Array.from({ length: 9 }, (_, i) => ({ slotId: `s${i}`, venueId: 'v', start: 600 })) }],
    ['a stop with no place', { stops: [{ slotId: 's1', start: 600 }, { slotId: 's2', venueId: 'v2', start: 700 }] }],
    ['a start that is not a time', { stops: [{ slotId: 's1', venueId: 'v1', start: 'noon' }, { slotId: 's2', venueId: 'v2', start: 700 }] }],
    ['a start past the second midnight', { stops: [{ slotId: 's1', venueId: 'v1', start: 2880 }, { slotId: 's2', venueId: 'v2', start: 700 }] }],
  ])('has none for an answer with %s: the voted order stays, nothing is guessed', async (_name, over) => {
    expect(await suggest(answer(over))).toBeNull()
  })

  it('reads any source but "ai" as the planner\'s rules, and a missing sentence as empty', async () => {
    expect(await suggest(answer({ source: 'something' }))).toMatchObject({ source: 'rules' })
    expect(await suggest(answer({ reason: undefined }))).toMatchObject({ reason: '' })
  })
})

describe('the calls it makes and the sentences for their refusals', () => {
  // A backend that records what it is asked and answers (or refuses) as told.
  function recorder(refuse = null) {
    const calls = []
    const call = (name) => async (...args) => {
      calls.push([name, ...args])
      if (refuse) throw refuse
      return { planVersion: 3, status: 'x' }
    }
    const names = ['confirmPlan', 'replan', 'complete', 'patchStop', 'deleteStop', 'reorderStops', 'stopSwap', 'stopChoices', 'changeStopPlace', 'roam', 'propose', 'resolve', 'suggestOrder']
    return { calls, backend: Object.fromEntries(names.map((n) => [n, call(n)])) }
  }
  const remote = (backend) => createSessionsRemote({ client: () => ({}), me: () => 'u1', backend })

  it('sends each request with its arguments and nothing the server must not be told', async () => {
    const { calls, backend } = recorder()
    const r = remote(backend)
    await r.confirmPlan('s', { order: 'suggested', basis: 'b' })
    await r.confirmPlan('s')
    await r.replan('s', false)
    await r.replan('s')
    await r.complete('s')
    await r.setTravelMode('s', 'p', 'mrt')
    await r.deleteStop('s', 'p')
    await r.reorderStops('s', ['p', 'q'])
    await r.stopSwap('s', 'p')
    await r.stopChoices('s', 'p', { category: 'drink' })
    await r.changeStopPlace('s', 'p', { venueId: 'v2', seenVenueId: 'v1', category: 'drink' })
    await r.roam('s', { categories: ['eat'] })
    await r.propose('s', 'v2')
    await r.resolve('s', 'c', true)
    expect(calls).toEqual([
      ['confirmPlan', 's', { order: 'suggested', basis: 'b' }],
      ['confirmPlan', 's', { order: 'voted', basis: undefined }],
      ['replan', 's', false],
      ['replan', 's', true],
      ['complete', 's'],
      ['patchStop', 's', 'p', { travelMode: 'mrt' }],
      ['deleteStop', 's', 'p'],
      ['reorderStops', 's', ['p', 'q']],
      ['stopSwap', 's', 'p'],
      ['stopChoices', 's', 'p', { category: 'drink' }],
      ['changeStopPlace', 's', 'p', { venueId: 'v2', seenVenueId: 'v1', category: 'drink' }],
      ['roam', 's', { categories: ['eat'] }],
      ['propose', 's', 'v2'],
      ['resolve', 's', 'c', true],
    ])
  })

  it.each([
    ['confirmPlan', ['s'], 'order_stale', WORDS.orderStale],
    ['confirmPlan', ['s'], 'not_enough_votes', 'At least 2 people need to vote first.'],
    ['confirmPlan', ['s'], 'nothing_to_confirm', 'Vote for at least one place first.'],
    ['confirmPlan', ['s'], 'host_only', 'Only the host can confirm the plan.'],
    ['confirmPlan', ['s'], 'wrong_status', WORDS.planClosed],
    ['replan', ['s'], 'host_only', 'Only the host can re-plan.'],
    ['replan', ['s'], 'wrong_status', WORDS.needConfirmed],
    ['complete', ['s'], 'host_only', 'Only the host can finish the outing.'],
    ['complete', ['s'], 'wrong_status', WORDS.completeClosed],
    ['setTravelMode', ['s', 'p', 'walk'], 'host_only', 'Only the host can change how the group travels.'],
    ['setTravelMode', ['s', 'p', 'walk'], 'stop_not_found', WORDS.stopGone],
    ['deleteStop', ['s', 'p'], 'last_stop', WORDS.lastStop],
    ['deleteStop', ['s', 'p'], 'host_only', 'Only the host can delete a stop.'],
    ['reorderStops', ['s', ['p']], 'stops_changed', WORDS.planChanged],
    ['reorderStops', ['s', ['p']], 'host_only', 'Only the host can rearrange the stops.'],
    ['changeStopPlace', ['s', 'p', {}], 'venue_does_not_fit', WORDS.doesNotFit],
    ['changeStopPlace', ['s', 'p', {}], 'stop_changed', WORDS.planChanged],
    ['changeStopPlace', ['s', 'p', {}], 'already_a_stop', WORDS.alreadyStop],
    ['propose', ['s', 'v'], 'plan_full', WORDS.planFull],
    ['propose', ['s', 'v'], 'too_many_proposals', WORDS.tooManyProposals],
    ['propose', ['s', 'v'], 'already_a_stop', WORDS.alreadyStop],
    ['propose', ['s', 'v'], 'wrong_status', WORDS.roamClosed],
    ['resolve', ['s', 'c', true], 'host_only', 'Only the host can add a place to the plan.'],
    ['resolve', ['s', 'c', true], 'proposal_not_found', WORDS.proposalGone],
    ['resolve', ['s', 'c', true], 'plan_full', WORDS.planFull],
  ])('%s: a refusal with the code "%s" says it in plain words and keeps the code and the status', async (name, args, code, words) => {
    const { backend } = recorder(refused(code))
    await expect(remote(backend)[name](...args)).rejects.toMatchObject({ message: words, code, status: 409 })
  })

  it.each([
    ['stopSwap', ['s', 'p']],
    ['stopChoices', ['s', 'p', {}]],
    ['changeStopPlace', ['s', 'p', {}]],
    ['roam', ['s', {}]],
    ['propose', ['s', 'v']],
    ['resolve', ['s', 'c', true]],
  ])('%s: a route the server does not have yet says so in words, not as a problem with the planner', async (name, args) => {
    const { backend } = recorder(refused('not_found', 404, 'No such route.'))
    await expect(remote(backend)[name](...args)).rejects.toMatchObject({ message: WORDS.notBuilt, code: 'not_found', status: 404 })
  })

  it('says "plan_busy" and "session_not_found" in the words the other stages use', async () => {
    await expect(remote(recorder(refused('plan_busy')).backend).replan('s')).rejects.toMatchObject({ message: WORDS.busy })
    await expect(remote(recorder(refused('session_not_found', 404)).backend).complete('s')).rejects.toMatchObject({ message: WORDS.noSession, status: 404 })
  })

  it('keeps the words of a failure that has no code (no connection, a timeout), and no status: it proves nothing', async () => {
    const down = Object.assign(new Error('Cannot reach the Jio planner right now. Check your connection and try again.'), {})
    const { backend } = recorder(down)
    const failure = await remote(backend).complete('s').catch((e) => e)
    expect(failure.message).toBe('Cannot reach the Jio planner right now. Check your connection and try again.')
    expect(failure.code).toBeUndefined()
    expect(failure.status).toBeUndefined()
    expect(problem(new Error('')).message).toBe(WORDS.notSaved)
  })

  it('needs someone signed in', async () => {
    const nobody = createSessionsRemote({ client: () => ({}), me: () => null, backend: recorder().backend })
    await expect(nobody.complete('s')).rejects.toMatchObject({ message: WORDS.signedOut })
    await expect(nobody.myLedger('s')).rejects.toMatchObject({ message: WORDS.signedOut })
    await expect(nobody.stopIds('s')).rejects.toMatchObject({ message: WORDS.signedOut })
  })
})

describe('the stops now, and the person\'s own ledger row', () => {
  it('reads the ids of a session\'s stops in their order, afresh', async () => {
    const { w, sam, id } = await confirmed()
    const rows = [...rowsOf(w, 'stops')].sort((a, b) => a.seq - b.seq)
    expect(await asPerson(sam).stopIds(id)).toEqual(rows.map((r) => r.id))
    // Another device moves one; the next read has the new order.
    await w.database.run({ as: SERVICE, kind: 'update', table: 'stops', values: { seq: 90 }, filters: [eq('id', rows[0].id)] })
    expect((await asPerson(sam).stopIds(id)).at(-1)).toBe(rows[0].id)
  })

  it('reads the person\'s own ledger row, and only that, though the rules let a member read the others\'', async () => {
    const { w, sam, kim, id } = await confirmed()
    await sam.api.endPlan(id)
    expect(rowsOf(w, 'commute_ledger')).toHaveLength(2)
    w.ops.length = 0
    const mine = await asPerson(kim).myLedger(id)
    expect(mine).toMatchObject({ minutesIn: expect.any(Number), minutesBetween: 0, minutesHome: expect.any(Number), total: expect.any(Number), delta: expect.any(Number) })
    const own = rowsOf(w, 'commute_ledger').find((r) => r.user_id === kim.id)
    expect(mine).toEqual({ minutesIn: own.minutes_in, minutesBetween: own.minutes_between, minutesHome: own.minutes_home, total: own.total_minutes, delta: own.delta_from_mean })
    const read = w.ops.find((op) => op.table === 'commute_ledger')
    expect(read.filters).toEqual(expect.arrayContaining([eq('session_id', id), eq('user_id', kim.id)]))
    // The other person's row is Sam's.
    expect(await asPerson(sam).myLedger(id)).toEqual(expect.objectContaining({ delta: rowsOf(w, 'commute_ledger').find((r) => r.user_id === sam.id).delta_from_mean }))
  })

  it('has none while the outing is not finished, and says so with null', async () => {
    const { sam, id } = await confirmed()
    expect(await asPerson(sam).myLedger(id)).toBeNull()
  })

  it('fails with a sentence when the ledger cannot be read', async () => {
    const client = { from: () => ({ select: () => ({ eq: () => ({ eq: () => ({ maybeSingle: async () => ({ data: null, error: { code: 'XX000', message: 'boom' } }) }) }) }) }) }
    await expect(createSessionsRemote({ client: () => client, me: () => 'u1' }).myLedger('s')).rejects.toMatchObject({ message: WORDS.notLoaded })
  })
})

describe('live', () => {
  const listen = (person) => {
    const heard = []
    const stop = asPerson(person).watch((change) => heard.push(change))
    return { heard, stop }
  }

  it('hears a stop added, changed or removed as a change to its session, and a removal by the stop\'s key', async () => {
    const { w, kim, id } = await confirmed()
    const { heard, stop } = listen(kim)
    await vi.waitFor(() => expect(heard.some((c) => c.kind === 'resync')).toBe(true))
    heard.length = 0
    const rows = [...rowsOf(w, 'stops')].sort((a, b) => a.seq - b.seq)
    await w.database.run({ as: SERVICE, kind: 'update', table: 'stops', values: { travel_mode: 'mrt' }, filters: [eq('id', rows[1].id)] })
    await vi.waitFor(() => expect(heard).toContainEqual({ kind: 'session', sessionId: id }))
    heard.length = 0
    await w.database.run({ as: SERVICE, kind: 'delete', table: 'stops', filters: [eq('id', rows[0].id)] })
    await vi.waitFor(() => expect(heard).toContainEqual({ kind: 'stop-deleted', stopId: rows[0].id }))
    stop()
  })

  it('does not hear the stops of a session it is not in', async () => {
    const { w, id } = await confirmed()
    const outsider = await w.open({ email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] })
    const { heard, stop } = listen(outsider)
    await vi.waitFor(() => expect(heard.some((c) => c.kind === 'resync')).toBe(true))
    heard.length = 0
    const [first] = rowsOf(w, 'stops')
    await w.database.run({ as: SERVICE, kind: 'update', table: 'stops', values: { travel_mode: 'car' }, filters: [eq('id', first.id)] })
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(heard.filter((c) => c.sessionId === id)).toEqual([])
    stop()
  })
})

describe('a session that is still voting (for the record)', () => {
  it('reads as it did in stage 4: the same slots and no plan', async () => {
    const { sam, id } = await voting()
    const read = await asPerson(sam).get(id)
    expect(read).toMatchObject({ status: 'voting', plan: null, proposals: [], replan: null })
    expect(read.slotRows.length).toBeGreaterThan(0)
  })
})
