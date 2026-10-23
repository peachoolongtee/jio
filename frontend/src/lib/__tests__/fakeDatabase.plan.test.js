// The stand-in database's tables of stage 5 (the plan on the server): `stops`, `commute_ledger` and `stop_proposals`, and the order columns
// of `sessions`. Who reads them, that a browser writes none of them, the checks the schema makes, the deferred key on a stop's place in
// the order, what goes with what, and which of them are published to live updates. The stage 5 patch parts of `apply_session_plan` are
// NOT in this stand-in (ASSUMED: the server writes these tables directly here; see the head of fakeDatabase.js). No network.
import { describe, expect, it } from 'vitest'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
const eq = (col, value) => ({ col, op: 'eq', value })
const MEETING = { area_id: 'bugis', method: 'chosen', max_minutes: 20, total_minutes: 30, count: 2, approximate: false, travel: { [A]: 20, [B]: 10 } }

// A hosts, B joins, C is outside. The session is voting with one slot, then the helpers write a plan as the server would.
// How to call: const { db, sid, slotId, stop, ledger, propose, status } = world()
function world() {
  const db = createDatabase({ profiles: { [A]: profile('a'), [B]: profile('b'), [C]: profile('c') } })
  const sid = db.run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'T', date: '2026-10-21', start_time: '12:00', end_time: '20:00' }, returning: true, columns: 'id' }).data[0].id
  const { token } = db.run({ as: A, kind: 'insert', table: 'invites', values: { session_id: sid, created_by: A }, returning: true, columns: 'token' }).data[0]
  db.run({ as: B, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
  const row = () => db.tables.sessions.find((s) => s.id === sid)
  db.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'locating' }, filters: [eq('id', sid)] })
  db.run({
    as: SERVICE,
    kind: 'rpc',
    fn: 'apply_session_plan',
    args: { sid, expected_version: row().plan_version, expected_status: 'locating', patch: { session: { status: 'voting', meeting: MEETING }, slots: [{ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, is_last: true, details: {}, options: [{ venue_id: 'v1', rank: 1, score: 1, details: {} }] }] } },
  })
  const slotId = db.tables.slots[0].id
  const stop = (values = {}) => db.run({ as: SERVICE, kind: 'insert', table: 'stops', values: { session_id: sid, seq: db.tables.stops.length, slot_id: slotId, category: 'eat', venue_id: 'v1', planned_start_minute: 720, duration_minutes: 90, ...values }, returning: true, columns: '*' })
  const ledger = (user, values = {}) => db.run({ as: SERVICE, kind: 'insert', table: 'commute_ledger', values: { session_id: sid, user_id: user, minutes_in: 20, minutes_between: 5, minutes_home: 15, delta_from_mean: 1.5, ...values }, returning: true, columns: '*' })
  const propose = (user, venue, values = {}) => db.run({ as: SERVICE, kind: 'insert', table: 'stop_proposals', values: { session_id: sid, venue_id: venue, proposed_by: user, ...values }, returning: true, columns: '*' })
  const status = (value) => db.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: value }, filters: [eq('id', sid)] })
  return { db, sid, row, slotId, stop, ledger, propose, status }
}
const read = (db, as, table) => db.run({ as, kind: 'select', table, columns: '*', filters: [] })

describe('who reads the stops, the ledger and the proposals', () => {
  it('lets a member read them all and keeps an outsider and a signed-out visitor out', () => {
    const { db, stop, ledger, propose } = world()
    stop()
    ledger(A)
    propose(B, 'v2')
    for (const table of ['stops', 'commute_ledger', 'stop_proposals']) {
      expect(read(db, B, table).data.length).toBeGreaterThan(0)
      expect(read(db, C, table).data).toEqual([])
      expect(read(db, null, table).error.code).toBe('42501')
    }
  })

  it('lets a member read every row of the ledger of their session (the policy), and a person their own row wherever it is', () => {
    const { db, ledger } = world()
    ledger(A)
    ledger(B, { minutes_in: 40 })
    expect(read(db, A, 'commute_ledger').data.map((r) => r.user_id).sort()).toEqual([A, B].sort())
    // The browser asks for its own row by id (lib/sessionsRemote.js myLedger): the filter is the person's, whatever the rules let through.
    expect(db.run({ as: B, kind: 'select', table: 'commute_ledger', columns: '*', filters: [eq('user_id', B)] }).data).toEqual([expect.objectContaining({ user_id: B, minutes_in: 40 })])
  })

  it('writes the ledger total itself (in, between and home) and shows it as a column', () => {
    const { db, ledger } = world()
    ledger(A)
    expect(db.tables.commute_ledger[0]).toMatchObject({ minutes_in: 20, minutes_between: 5, minutes_home: 15, total_minutes: 40, delta_from_mean: 1.5 })
  })
})

describe('what a browser may not write', () => {
  it('refuses every insert, update and delete of the three tables, for a member and for the host', () => {
    const { db, sid, stop, ledger, propose } = world()
    stop()
    ledger(A)
    propose(B, 'v2')
    for (const as of [A, B]) {
      for (const [table, values] of [
        ['stops', { session_id: sid, seq: 9, category: 'eat', venue_id: 'v1', planned_start_minute: 600, duration_minutes: 60 }],
        ['commute_ledger', { session_id: sid, user_id: as }],
        ['stop_proposals', { session_id: sid, venue_id: 'v9', proposed_by: as }],
      ]) {
        expect(db.run({ as, kind: 'insert', table, values }).error.code).toBe('42501')
        expect(db.run({ as, kind: 'update', table, values: { venue_id: 'x' } }).error.code).toBe('42501')
        expect(db.run({ as, kind: 'delete', table }).error.code).toBe('42501')
      }
    }
    expect(db.tables.stops).toHaveLength(1)
  })

  it('keeps the order columns of a session out of a browser\'s update, the host\'s included', () => {
    const { db, sid } = world()
    for (const column of ['order_reason', 'order_source', 'order_suggestion', 'plan_start_minute', 'replan', 'completed_at']) {
      expect(db.run({ as: A, kind: 'update', table: 'sessions', values: { [column]: null }, filters: [eq('id', sid)] }).error.code).toBe('42501')
    }
  })

  it('does not let a browser move a session to confirmed or completed (only the server does)', () => {
    const { db, sid, status } = world()
    expect(db.run({ as: A, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', sid)] }).error.message).toMatch(/cannot go from voting to confirmed/)
    expect(status('confirmed').error).toBeNull()
    expect(status('completed').error).toBeNull()
    // A finished session is frozen for everyone but the server's key.
    expect(db.run({ as: A, kind: 'update', table: 'sessions', values: { title: 'New' }, filters: [eq('id', sid)] }).error.message).toMatch(/completed session cannot be changed/)
  })
})

describe('the checks of a stop', () => {
  it('accepts a whole stop, with its optional columns empty, and gives it an id', () => {
    const { db, stop } = world()
    const made = stop()
    expect(made.error).toBeNull()
    expect(made.data[0]).toMatchObject({ seq: 0, category: 'eat', venue_id: 'v1', travel_mode: null, travel_minutes: null, not_before_minute: null, arrived_at: null })
    expect(made.data[0].id).toMatch(/^[0-9a-f-]{36}$/)
    expect(db.tables.stops).toHaveLength(1)
  })

  it.each([
    ['a category outside the four', { category: 'sleep' }, 'stops_category_check'],
    ['a start after the end of the day', { planned_start_minute: 1440 }, 'stops_planned_start_minute_check'],
    ['a length of nothing', { duration_minutes: 0 }, 'stops_duration_minutes_check'],
    ['a length over twelve hours', { duration_minutes: 721 }, 'stops_duration_minutes_check'],
    ['a way of travelling that is not offered', { travel_mode: 'grab' }, 'stops_travel_mode_check'],
    ['an earliest start outside the day', { not_before_minute: 1440 }, 'not_before_minute_range'],
    ['a negative place in the order', { seq: -1 }, 'stops_seq_check'],
    ['a place id over 160 characters', { venue_id: 'x'.repeat(161) }, 'stops_venue_id_check'],
  ])('refuses %s', (_name, values, constraint) => {
    const { db, stop } = world()
    const made = stop(values)
    expect(made.error).toMatchObject({ code: '23514' })
    expect(made.error.message).toContain(constraint)
    expect(db.tables.stops).toEqual([])
  })

  it('accepts a place id of 160 characters (the saved hawker centres have long ones), a stop with no slot, and a stop of the roam kind', () => {
    const { db, stop } = world()
    expect(stop({ venue_id: 'x'.repeat(160), slot_id: null }).error).toBeNull()
    expect(db.tables.stops[0].slot_id).toBeNull()
  })

  it('refuses a slot that does not exist and a session that does not exist', () => {
    const { stop } = world()
    expect(stop({ slot_id: '00000000-0000-4000-8000-0000000000ff' }).error.code).toBe('23503')
    expect(stop({ session_id: '00000000-0000-4000-8000-0000000000ff' }).error.code).toBe('23503')
  })

  it('checks the key on a stop\'s place in the order at the end of the statement: a clash is refused and nothing is left behind', () => {
    const { db, sid, stop } = world()
    stop({ seq: 0 })
    stop({ seq: 1, venue_id: 'v2', slot_id: null })
    const clash = stop({ seq: 1, venue_id: 'v3', slot_id: null })
    expect(clash.error).toMatchObject({ code: '23505' })
    expect(db.tables.stops).toHaveLength(2)
    // Two rows in one statement that clash with each other are refused too.
    const both = db.run({ as: SERVICE, kind: 'insert', table: 'stops', values: [{ session_id: sid, seq: 5, category: 'eat', venue_id: 'a', planned_start_minute: 1, duration_minutes: 1 }, { session_id: sid, seq: 5, category: 'eat', venue_id: 'b', planned_start_minute: 1, duration_minutes: 1 }] })
    expect(both.error.code).toBe('23505')
    expect(db.tables.stops).toHaveLength(2)
    // An update that would make two stops share a place is refused and undone.
    const moved = db.run({ as: SERVICE, kind: 'update', table: 'stops', values: { seq: 0 }, filters: [eq('venue_id', 'v2')] })
    expect(moved.error.code).toBe('23505')
    expect(db.tables.stops.map((s) => s.seq).sort()).toEqual([0, 1])
  })
})

describe('the checks of the ledger and the proposals', () => {
  it('refuses a ledger row with a negative time, a person with no profile, and a second row for one person', () => {
    const { db, ledger } = world()
    expect(ledger(A, { minutes_in: -1 }).error.code).toBe('23514')
    expect(ledger('00000000-0000-4000-8000-0000000000ee').error.code).toBe('23503')
    expect(ledger(A).error).toBeNull()
    expect(ledger(A).error.code).toBe('23505')
    expect(db.tables.commute_ledger).toHaveLength(1)
  })

  it('lets a place wait once at a time, and again after it has been answered', () => {
    const { db, propose } = world()
    const first = propose(B, 'v2')
    expect(first.error).toBeNull()
    expect(first.data[0]).toMatchObject({ status: 'pending', resolved_at: null, resolved_by: null })
    expect(propose(A, 'v2').error.code).toBe('23505')
    expect(db.run({ as: SERVICE, kind: 'update', table: 'stop_proposals', values: { status: 'dismissed', resolved_at: '2026-10-21T10:00:00Z', resolved_by: A }, filters: [eq('id', first.data[0].id)] }).error).toBeNull()
    expect(propose(A, 'v2').error).toBeNull()
  })

  it('keeps pending and answered apart: a pending one has no answer time, an answered one has', () => {
    const { propose } = world()
    expect(propose(B, 'v2', { status: 'accepted' }).error.code).toBe('23514')
    expect(propose(B, 'v3', { status: 'pending', resolved_at: '2026-10-21T10:00:00Z' }).error.code).toBe('23514')
    expect(propose(B, 'v4', { status: 'accepted', resolved_at: '2026-10-21T10:00:00Z', resolved_by: A }).error).toBeNull()
    expect(propose(B, 'v5', { status: 'nope' }).error.code).toBe('23514')
  })

  it('takes a proposal only from a member of the session', () => {
    const { propose } = world()
    expect(propose(C, 'v2').error.code).toBe('23503')
  })
})

describe('the order columns of a session', () => {
  const write = (db, sid, values) => db.run({ as: SERVICE, kind: 'update', table: 'sessions', values, filters: [eq('id', sid)] })
  const BASIS = 'a'.repeat(64)

  it('keeps the sentence about the order and who chose it together: both set, or both empty', () => {
    const { db, sid } = world()
    expect(write(db, sid, { order_reason: 'Shops first.' }).error.message).toContain('order_note_pair')
    expect(write(db, sid, { order_source: 'ai' }).error.message).toContain('order_note_pair')
    expect(write(db, sid, { order_reason: 'Shops first.', order_source: 'ai' }).error).toBeNull()
    expect(write(db, sid, { order_reason: null, order_source: null }).error).toBeNull()
  })

  it('knows two sources, a sentence of 1 to 200 characters, and a start in the day', () => {
    const { db, sid } = world()
    expect(write(db, sid, { order_reason: 'x', order_source: 'human' }).error.message).toContain('order_source_values')
    expect(write(db, sid, { order_reason: '', order_source: 'ai' }).error.message).toContain('order_reason_length')
    expect(write(db, sid, { order_reason: 'x'.repeat(201), order_source: 'ai' }).error.message).toContain('order_reason_length')
    expect(write(db, sid, { plan_start_minute: 1440 }).error.message).toContain('plan_start_minute_range')
    expect(write(db, sid, { plan_start_minute: 600 }).error).toBeNull()
  })

  it('keeps a suggestion to an object with a 64-character hex basis and at most 8 slots in its order', () => {
    const { db, sid } = world()
    const ok = { basis: BASIS, order: ['a', 'b'], starts: { a: 600, b: 700 }, reason: 'r', source: 'ai', at: '2026-10-21T10:00:00Z' }
    expect(write(db, sid, { order_suggestion: ok }).error).toBeNull()
    expect(write(db, sid, { order_suggestion: { ...ok, basis: 'xyz' } }).error.message).toContain('order_suggestion_shape')
    expect(write(db, sid, { order_suggestion: { ...ok, order: Array.from({ length: 9 }, (_, i) => String(i)) } }).error.message).toContain('order_suggestion_shape')
    expect(write(db, sid, { order_suggestion: { ...ok, order: 'no' } }).error.message).toContain('order_suggestion_shape')
    expect(db.tables.sessions[0].order_suggestion.basis).toBe(BASIS)
  })

  it('starts with all of them empty', () => {
    const { row } = world()
    expect(row()).toMatchObject({ order_reason: null, order_source: null, order_suggestion: null, plan_start_minute: null, replan: null, completed_at: null })
  })
})

describe('what goes with what', () => {
  it('leaves a stop standing, without its slot, when the slot is removed', () => {
    const { db, slotId, stop } = world()
    stop()
    db.run({ as: SERVICE, kind: 'delete', table: 'slots', filters: [eq('id', slotId)] })
    expect(db.tables.stops).toHaveLength(1)
    expect(db.tables.stops[0].slot_id).toBeNull()
  })

  it('takes a member\'s proposals with them, and leaves their stops and ledger row', () => {
    const { db, sid, stop, ledger, propose } = world()
    stop()
    ledger(B)
    propose(B, 'v2')
    propose(A, 'v3')
    db.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [eq('session_id', sid), eq('user_id', B)] })
    expect(db.tables.stop_proposals.map((p) => p.proposed_by)).toEqual([A])
    expect(db.tables.stops).toHaveLength(1)
    expect(db.tables.commute_ledger).toHaveLength(1)
  })

  it('takes everything of a session with it when the session goes', () => {
    const { db, sid, stop, ledger, propose } = world()
    stop()
    ledger(A)
    propose(B, 'v2')
    db.run({ as: SERVICE, kind: 'delete', table: 'sessions', filters: [eq('id', sid)] })
    expect([db.tables.stops, db.tables.commute_ledger, db.tables.stop_proposals].map((t) => t.length)).toEqual([0, 0, 0])
  })
})

describe('live updates', () => {
  // Delivery is a moment later, as a network is.
  const later = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('publishes the stops to the members of their session, never to an outsider, and a delete only by its key', async () => {
    const { db, stop } = world()
    const heard = { member: [], outsider: [], everyone: [] }
    db.subscribe({ as: B, table: 'stops', event: '*' }, (p) => heard.member.push(p))
    db.subscribe({ as: C, table: 'stops', event: '*' }, (p) => heard.outsider.push(p))
    db.subscribe({ as: C, table: 'stops', event: 'DELETE' }, (p) => heard.everyone.push(p))
    const made = stop()
    db.run({ as: SERVICE, kind: 'update', table: 'stops', values: { travel_mode: 'mrt' }, filters: [eq('id', made.data[0].id)] })
    db.run({ as: SERVICE, kind: 'delete', table: 'stops', filters: [eq('id', made.data[0].id)] })
    await later()
    expect(heard.member.map((p) => p.eventType)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
    expect(heard.member[1].new).toMatchObject({ session_id: expect.any(String), travel_mode: 'mrt' })
    // An outsider hears no insert or update; a delete carries only the stop's key and reaches anyone who listens without a filter.
    expect(heard.outsider.map((p) => p.eventType)).toEqual(['DELETE'])
    expect(heard.everyone[0].old).toEqual({ id: made.data[0].id })
    expect(heard.everyone[0].new).toEqual({})
  })

  it('does not publish the ledger or the proposals (the session\'s version tells the others)', async () => {
    const { db, ledger, propose } = world()
    const heard = []
    db.subscribe({ as: B, table: 'commute_ledger', event: '*' }, (p) => heard.push(p))
    db.subscribe({ as: B, table: 'stop_proposals', event: '*' }, (p) => heard.push(p))
    ledger(A)
    propose(B, 'v2')
    await later()
    expect(heard).toEqual([])
  })

  it('tells nobody of a stop write that fails', async () => {
    const { db, stop } = world()
    const heard = []
    db.subscribe({ as: B, table: 'stops', event: '*' }, (p) => heard.push(p))
    stop({ seq: 0 })
    stop({ seq: 0, venue_id: 'v2' })
    await later()
    expect(heard).toHaveLength(1)
  })
})
