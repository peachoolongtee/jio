// The stand-in database's slots, places and votes (stage 4): who reads them, who may vote and when, what goes with what (a removed place
// takes its votes, a removed slot takes its places), the slot sections of the apply_session_plan port (marked ASSUMED in fakeDatabase.js:
// the server's own migration is written by the backend half), and the live events a vote raises. No network.
import { describe, expect, it } from 'vitest'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
const eq = (col, value) => ({ col, op: 'eq', value })
const MEETING = { area_id: 'bugis', method: 'chosen', max_minutes: 20, total_minutes: 30, count: 2, approximate: false, travel: { [A]: 20, [B]: 10 } }
const option = (venue, rank, extra = {}) => ({ venue_id: venue, rank, score: rank * 10, details: { walkMinutes: 3, reasons: [] }, ...extra })

// A hosts, B joins, C is outside. The session is voting with one slot (eat) offering v1 and v2.
// How to call: const { db, sid, slotId, plan, vote } = voting()
function voting() {
  const db = createDatabase({ profiles: { [A]: profile('a'), [B]: profile('b'), [C]: profile('c') } })
  const sid = db.run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'T', date: '2026-10-21', start_time: '12:00', end_time: '20:00' }, returning: true, columns: 'id' }).data[0].id
  const { token } = db.run({ as: A, kind: 'insert', table: 'invites', values: { session_id: sid, created_by: A }, returning: true, columns: 'token' }).data[0]
  db.run({ as: B, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
  const row = () => db.tables.sessions.find((s) => s.id === sid)
  const plan = (patch) => db.run({ as: SERVICE, kind: 'rpc', fn: 'apply_session_plan', args: { sid, expected_version: row().plan_version, expected_status: row().status, patch } })
  db.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'locating' }, filters: [eq('id', sid)] })
  plan({
    session: { status: 'voting', meeting: MEETING },
    slots: [{ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, is_last: true, details: { moreAvailable: true }, options: [option('v1', 1), option('v2', 2)] }],
  })
  const slotId = db.tables.slots[0].id
  const vote = (as, venue, user = as) => db.run({ as, kind: 'insert', table: 'votes', values: { slot_id: slotId, user_id: user, venue_id: venue } })
  return { db, sid, row, plan, slotId, vote }
}

describe('who reads the slots, places and votes', () => {
  it('lets a member read them and keeps an outsider out, whatever is asked', () => {
    const { db, slotId, vote } = voting()
    vote(B, 'v1')
    for (const table of ['slots', 'slot_options', 'votes']) {
      expect(db.run({ as: B, kind: 'select', table, columns: '*', filters: [] }).data.length).toBeGreaterThan(0)
      expect(db.run({ as: C, kind: 'select', table, columns: '*', filters: [] }).data).toEqual([])
      expect(db.run({ as: null, kind: 'select', table, columns: '*', filters: [] }).error.code).toBe('42501')
    }
    expect(db.run({ as: A, kind: 'select', table: 'votes', columns: 'user_id', filters: [eq('slot_id', slotId)] }).data).toEqual([{ user_id: B }])
  })

  it('still lets a member who opted out read the votes, as the policy does (my_slot_ids ignores the state)', () => {
    const { db, vote } = voting()
    vote(A, 'v1')
    db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('user_id', B)] })
    expect(db.run({ as: B, kind: 'select', table: 'votes', columns: '*', filters: [] }).data).toHaveLength(1)
  })
})

describe('casting, moving and taking back a vote', () => {
  it('lets a joined member vote once per slot, for one of its places, as themselves', () => {
    const { db, vote } = voting()
    expect(vote(B, 'v1').error).toBeNull()
    expect(vote(B, 'v2').error.code).toBe('23505')
    expect(vote(A, 'nowhere').error.code).toBe('23503')
    // Not as someone else, and not by a stranger.
    expect(vote(B, 'v1', A).error.code).toBe('42501')
    expect(vote(C, 'v1').error.code).toBe('42501')
    expect(db.tables.votes).toHaveLength(1)
  })

  it('moves a vote by changing its place only, and refuses a place that is not offered', () => {
    const { db, slotId, vote } = voting()
    vote(B, 'v1')
    const filters = [eq('slot_id', slotId), eq('user_id', B)]
    expect(db.run({ as: B, kind: 'update', table: 'votes', values: { venue_id: 'v2' }, filters, returning: true, columns: 'venue_id' }).data).toEqual([{ venue_id: 'v2' }])
    expect(db.run({ as: B, kind: 'update', table: 'votes', values: { venue_id: 'v9' }, filters }).error.code).toBe('23503')
    expect(db.run({ as: B, kind: 'update', table: 'votes', values: { user_id: A }, filters }).error.code).toBe('42501')
    // Someone else's vote is not theirs to change: no row is reached.
    vote(A, 'v1')
    expect(db.run({ as: B, kind: 'update', table: 'votes', values: { venue_id: 'v2' }, filters: [eq('user_id', A)], returning: true, columns: 'user_id' }).data).toEqual([])
    expect(db.tables.votes.find((v) => v.user_id === A).venue_id).toBe('v1')
  })

  it('lets a member take back their own vote and no one else\'s', () => {
    const { db, slotId, vote } = voting()
    vote(B, 'v1')
    vote(A, 'v2')
    const gone = db.run({ as: B, kind: 'delete', table: 'votes', filters: [eq('slot_id', slotId)], returning: true, columns: 'user_id' })
    expect(gone.data).toEqual([{ user_id: B }])
    expect(db.tables.votes.map((v) => v.user_id)).toEqual([A])
  })

  it('refuses every vote write unless the session is voting, the person has joined and the slot is not removed', () => {
    const { db, sid, slotId, vote, plan } = voting()
    vote(B, 'v1')
    // Opted out.
    db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('user_id', B)] })
    expect(db.run({ as: B, kind: 'delete', table: 'votes', filters: [eq('slot_id', slotId)], returning: true, columns: 'user_id' }).data).toEqual([])
    expect(db.run({ as: B, kind: 'update', table: 'votes', values: { venue_id: 'v2' }, filters: [eq('slot_id', slotId)], returning: true, columns: 'user_id' }).data).toEqual([])
    db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'joined' }, filters: [eq('user_id', B)] })
    // The slot removed (its places go with it, so the vote does too).
    plan({ slot_flags: [{ id: slotId, deleted: true }] })
    expect(db.tables.votes).toHaveLength(0)
    expect(vote(A, 'v1').error.code).toBe('42501')
    plan({ slot_flags: [{ id: slotId, deleted: false }], slots: [{ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, is_last: true, options: [option('v1', 1)] }] })
    expect(vote(A, 'v1').error).toBeNull()
    // Confirmed: read-only.
    db.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', sid)] })
    expect(db.run({ as: A, kind: 'delete', table: 'votes', filters: [eq('slot_id', slotId)], returning: true, columns: 'user_id' }).data).toEqual([])
    expect(vote(B, 'v1').error.code).toBe('42501')
  })

  it('gives the browser no insert or update on slots and places, and no other column of a vote', () => {
    const { db, sid, slotId } = voting()
    expect(db.run({ as: A, kind: 'insert', table: 'slots', values: { session_id: sid, category: 'drink', start_minute: 0, duration_minutes: 30 } }).error.code).toBe('42501')
    expect(db.run({ as: A, kind: 'insert', table: 'slot_options', values: { slot_id: slotId, venue_id: 'v3' } }).error.code).toBe('42501')
    expect(db.run({ as: A, kind: 'update', table: 'slots', values: { deleted: true }, filters: [eq('id', slotId)] }).error.code).toBe('42501')
    expect(db.run({ as: A, kind: 'insert', table: 'votes', values: { slot_id: slotId, user_id: A, venue_id: 'v1', created_at: 'x' } }).error.code).toBe('42501')
  })
})

describe('what goes with what', () => {
  it('takes the votes for a place when the place goes, and the places and votes when a slot goes', () => {
    const { db, slotId, vote, plan } = voting()
    vote(A, 'v1')
    vote(B, 'v2')
    plan({ slots: [{ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, is_last: true, options: [option('v2', 1)] }] })
    expect(db.tables.slot_options.map((o) => o.venue_id)).toEqual(['v2'])
    expect(db.tables.votes.map((v) => [v.user_id, v.venue_id])).toEqual([[B, 'v2']])
    plan({ slots: [] })
    expect(db.tables.slots).toHaveLength(0)
    expect(db.tables.slot_options).toHaveLength(0)
    expect(db.tables.votes).toHaveLength(0)
    expect(slotId).toBeTruthy()
  })

  it('keeps a vote with its place when the place is swapped in place', () => {
    const { db, slotId, vote, plan } = voting()
    vote(A, 'v1')
    expect(plan({ swap: { slot_id: slotId, from: 'v1', to: 'v9', rank: 1, score: 5, details: { walkMinutes: 1 } } }).data).toBeGreaterThan(1)
    expect(db.tables.votes[0].venue_id).toBe('v9')
    expect(db.tables.slot_options.find((o) => o.venue_id === 'v9')).toMatchObject({ rank: 1, score: 5 })
  })

  it('takes a person\'s votes when they opt out, and with the session when it goes', () => {
    const { db, vote, plan, sid } = voting()
    vote(A, 'v1')
    vote(B, 'v1')
    plan({ ops: [{ op: 'opt_out', user_id: B }] })
    expect(db.tables.votes.map((v) => v.user_id)).toEqual([A])
    db.run({ as: SERVICE, kind: 'delete', table: 'sessions', filters: [eq('id', sid)] })
    expect(db.tables.slots).toHaveLength(0)
    expect(db.tables.slot_options).toHaveLength(0)
    expect(db.tables.votes).toHaveLength(0)
  })
})

describe('the slot sections of apply_session_plan (ASSUMED shape)', () => {
  it('writes slots and places as a difference and counts only real changes', () => {
    const { db, slotId, plan, row } = voting()
    const same = { slots: [{ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, is_last: true, details: { moreAvailable: true }, options: [option('v1', 1), option('v2', 2)] }] }
    const version = row().plan_version
    expect(plan(same).data).toBe(version)
    expect(db.tables.slots[0].id).toBe(slotId)
    expect(plan({ slots: [{ ...same.slots[0], options: [option('v1', 1), option('v2', 3)] }] }).data).toBe(version + 1)
    expect(db.tables.slot_options.find((o) => o.venue_id === 'v2').rank).toBe(3)
  })

  it('removes a slot and its places and brings it back, and clears every place at once', () => {
    const { db, slotId, plan, vote } = voting()
    vote(A, 'v1')
    plan({ slot_flags: [{ id: slotId, deleted: true }] })
    expect(db.tables.slots[0].deleted).toBe(true)
    expect(db.tables.slot_options).toHaveLength(0)
    plan({ slot_flags: [{ id: slotId, deleted: false }] })
    expect(db.tables.slots[0].deleted).toBe(false)
    plan({ slots: [{ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, is_last: true, options: [option('v1', 1)] }] })
    plan({ clear_options: true })
    expect(db.tables.slot_options).toHaveLength(0)
    expect(db.tables.slots).toHaveLength(1)
  })

  it('writes the radius, refuses one outside 100 to 3000, and does not count the same radius as a change', () => {
    const { plan, row } = voting()
    const version = row().plan_version
    expect(plan({ session: { radius_meters: 1000 } }).data).toBe(version + 1)
    expect(row().radius_meters).toBe(1000)
    expect(plan({ session: { radius_meters: 1000 } }).data).toBe(version + 1)
    expect(plan({ session: { radius_meters: 50 } }).error.code).toBe('23514')
    expect(plan({ session: { radius_meters: null } }).data).toBe(version + 2)
  })

  it('checks the slot: a category from the four, one slot per category, a day-long start, and a details object', () => {
    const { plan } = voting()
    expect(plan({ slots: [{ category: 'sleep', start_minute: 0, duration_minutes: 10 }] }).error.code).toBe('23514')
    expect(plan({ slots: [{ category: 'drink', start_minute: 2000, duration_minutes: 10 }] }).error.code).toBe('23514')
    expect(plan({ slots: [{ category: 'drink', start_minute: 0, duration_minutes: 0 }] }).error.code).toBe('23514')
  })
})

describe('live events', () => {
  it('delivers a vote to the members of the session and no one else, and a delete without a filter with keys only', async () => {
    const { db, slotId, vote } = voting()
    const heard = { a: [], c: [] }
    db.subscribe({ as: A, table: 'votes', event: '*' }, (p) => heard.a.push(p))
    db.subscribe({ as: C, table: 'votes', event: '*' }, (p) => heard.c.push(p))
    vote(B, 'v1')
    db.run({ as: B, kind: 'update', table: 'votes', values: { venue_id: 'v2' }, filters: [eq('slot_id', slotId)] })
    db.run({ as: B, kind: 'delete', table: 'votes', filters: [eq('slot_id', slotId)] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(heard.a.map((p) => p.eventType)).toEqual(['INSERT', 'UPDATE', 'DELETE'])
    expect(heard.a[1].new).toMatchObject({ slot_id: slotId, user_id: B, venue_id: 'v2' })
    // A delete carries only the keys, and reaches a subscriber who is not in the session (the accepted stance for votes).
    expect(heard.a[2]).toMatchObject({ new: {}, old: { slot_id: slotId, user_id: B } })
    expect(heard.c.map((p) => p.eventType)).toEqual(['DELETE'])
  })

  it('does not deliver a delete to a subscriber who gave a filter, and tells nobody of a vote that failed', async () => {
    const { db, slotId, vote } = voting()
    const heard = []
    db.subscribe({ as: A, table: 'votes', event: '*', filter: `slot_id=eq.${slotId}` }, (p) => heard.push(p.eventType))
    expect(vote(B, 'nowhere').error.code).toBe('23503')
    vote(B, 'v1')
    db.run({ as: B, kind: 'delete', table: 'votes', filters: [eq('slot_id', slotId)] })
    await new Promise((resolve) => setTimeout(resolve, 5))
    expect(heard).toEqual(['INSERT'])
  })
})
