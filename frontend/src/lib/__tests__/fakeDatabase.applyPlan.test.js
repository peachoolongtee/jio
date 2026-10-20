// The stand-in database's port of apply_session_plan (db/migrations/20261020000000_jio_apply_session_plan.sql) keeps the rules of the
// reviewed SQL: a `session` section is a change only where a value differs from the stored row, the two-people check runs after the
// operations, a pin needs a confirm, the host stays, and `loaded_at` stamps the spots. Each is a test here so the port cannot drift
// from the file without a test saying so. No network.
import { describe, expect, it } from 'vitest'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
const eq = (col, value) => ({ col, op: 'eq', value })
const T0 = Date.parse('2026-10-20T10:00:00.000Z')

// A hosts a session with B joined. The clock is the test's.
// How to call: const { db, sid, plan, row, member, tick } = seeded({ status: 'locating' })
function seeded({ status = 'locating' } = {}) {
  let clock = T0
  const db = createDatabase({ profiles: { [A]: profile('a'), [B]: profile('b') }, now: () => clock })
  const sid = db.run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'T', date: '2026-10-21', start_time: '12:00', end_time: '20:00' }, returning: true, columns: 'id' }).data[0].id
  const { token } = db.run({ as: A, kind: 'insert', table: 'invites', values: { session_id: sid, created_by: A }, returning: true, columns: 'token' }).data[0]
  db.run({ as: B, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
  if (status !== 'inviting') db.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status }, filters: [eq('id', sid)] })
  const row = () => db.tables.sessions.find((s) => s.id === sid)
  // Apply a patch to the session as it stands now.
  const plan = (patch) => db.run({ as: SERVICE, kind: 'rpc', fn: 'apply_session_plan', args: { sid, expected_version: row().plan_version, expected_status: row().status, patch } })
  return { db, sid, row, plan, tick: (ms) => { clock += ms }, member: (user) => db.tables.session_members.find((m) => m.session_id === sid && m.user_id === user) }
}

const MEETING = { area_id: 'bugis', method: 'chosen', max_minutes: 20, total_minutes: 30, count: 2, approximate: false, travel: { [A]: 20, [B]: 10 } }
const spot = (area, extra = {}) => ({ area_id: area, rank: 1, worst_minutes: 20, mean_minutes: 15, travel_minutes: { [A]: 20, [B]: 10 }, approximate: false, ...extra })

describe('a session section changes only what differs from the stored row', () => {
  it('writes nothing, and keeps the version, when the same pinned meeting is sent again (after rounding)', () => {
    const { row, plan, tick } = seeded()
    expect(plan({ session: { status: 'voting', meeting: MEETING } }).data).toBe(1)
    const stored = structuredClone(row())
    tick(60_000)
    expect(plan({ session: { meeting: { ...MEETING, max_minutes: 20.4, total_minutes: 29.6 } } }).data).toBe(1)
    expect(plan({ session: { status: 'voting', meeting: MEETING } }).data).toBe(1)
    expect(row()).toEqual(stored)
  })

  it('writes the meeting again, and raises the version, when one value differs', () => {
    const { row, plan, tick } = seeded()
    plan({ session: { status: 'voting', meeting: MEETING } })
    tick(60_000)
    expect(plan({ session: { meeting: { ...MEETING, max_minutes: 25 } } }).data).toBe(2)
    expect(row().meeting_max_minutes).toBe(25)
    expect(row().meeting_computed_at).toBe(new Date(T0 + 60_000).toISOString())
  })

  it('writes nothing for the same banner in another key order, and a different banner is a change', () => {
    const { row, plan } = seeded()
    expect(plan({ session: { banner: { text: 'x', at: 5, approvalsRemoved: true } } }).data).toBe(1)
    expect(plan({ session: { banner: { approvalsRemoved: true, at: 5, text: 'x' } } }).data).toBe(1)
    expect(plan({ session: { banner: { text: 'x', at: 6, approvalsRemoved: true } } }).data).toBe(2)
    expect(plan({ session: { banner: null } }).data).toBe(3)
    expect(row().banner).toBeNull()
    expect(plan({ session: { banner: null } }).data).toBe(3)
  })

  it('does not count a same status or an empty section as a change', () => {
    const { plan } = seeded()
    expect(plan({ session: { status: 'locating' } }).data).toBe(0)
    expect(plan({ session: {} }).data).toBe(0)
  })

  it('compares a spot\'s travel minutes by value, not by the order of their keys', () => {
    const { plan, db } = seeded()
    expect(plan({ spots: [spot('bugis')] }).data).toBe(1)
    expect(plan({ spots: [spot('bugis', { travel_minutes: { [B]: 10, [A]: 20 } })] }).data).toBe(1)
    expect(plan({ spots: [spot('bugis', { travel_minutes: { [B]: 10, [A]: 21 } })] }).data).toBe(2)
    expect(db.tables.session_spots[0].travel_minutes).toEqual({ [A]: 21, [B]: 10 })
  })
})

describe('the two-people check runs after the operations', () => {
  it('refuses to start when the operations leave fewer than two', () => {
    const { plan, row, member } = seeded({ status: 'inviting' })
    const answer = plan({ ops: [{ op: 'remove_member', user_id: B }], session: { status: 'voting', meeting: MEETING } })
    expect(answer.error).toMatchObject({ code: 'P0001', hint: 'needs_two_people' })
    expect(row().status).toBe('inviting')
    expect(member(B)).toBeTruthy()
  })

  it('allows it when the operations bring the count to two', () => {
    const { db, sid, plan, row } = seeded({ status: 'inviting' })
    db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('session_id', sid), eq('user_id', B)] })
    expect(plan({ session: { status: 'voting', meeting: MEETING } }).error).toMatchObject({ hint: 'needs_two_people' })
    expect(plan({ ops: [{ op: 'rejoin', user_id: B }], session: { status: 'voting', meeting: MEETING } }).data).toBe(1)
    expect(row().status).toBe('voting')
  })
})

describe('a pin needs the host\'s confirm', () => {
  it('refuses a voted or chosen meeting without the move to voting', () => {
    const { plan, row } = seeded()
    for (const method of ['voted', 'chosen']) {
      expect(plan({ session: { meeting: { ...MEETING, method } } }).error).toMatchObject({ code: 'P0001', hint: 'pin_without_confirm' })
    }
    expect(row().meeting_area_id).toBeNull()
    expect(row().plan_version).toBe(0)
  })

  it('accepts one with the move to voting, and the same pin again once stored; a method that is not a pin needs no confirm', () => {
    const { plan, row } = seeded()
    expect(plan({ session: { meeting: { ...MEETING, method: 'fairest' } } }).data).toBe(1)
    const other = seeded()
    expect(other.plan({ session: { status: 'voting', meeting: { ...MEETING, method: 'voted' } } }).data).toBe(1)
    expect(other.plan({ session: { meeting: { ...MEETING, method: 'voted' } } }).data).toBe(1)
    // A different area under the same pin is the pinned-area rule, not this one.
    expect(other.plan({ session: { meeting: { ...MEETING, method: 'voted', area_id: 'orchard' } } }).error).toMatchObject({ hint: 'area_pinned' })
    expect(row().meeting_method).toBe('fairest')
  })
})

describe('the host stays', () => {
  it('refuses to opt the host out or remove them, and writes nothing', () => {
    const { plan, row, member } = seeded()
    for (const op of ['opt_out', 'remove_member']) {
      expect(plan({ ops: [{ op, user_id: A }] }).error).toMatchObject({ code: 'P0001', hint: 'host_member' })
    }
    expect(member(A).state).toBe('joined')
    expect(row().plan_version).toBe(0)
    // A guest can still be removed.
    expect(plan({ ops: [{ op: 'remove_member', user_id: B }] }).data).toBe(1)
    expect(member(B)).toBeUndefined()
  })
})

describe('loaded_at stamps the spots', () => {
  const LOADED = new Date(T0 - 30_000).toISOString()

  it('gives a written spot computed_at = loaded_at, and now when it is absent', () => {
    const { db, plan, tick } = seeded()
    plan({ loaded_at: LOADED, spots: [spot('bugis')] })
    expect(db.tables.session_spots[0].computed_at).toBe(LOADED)
    tick(60_000)
    plan({ spots: [spot('orchard', { rank: 2 })] })
    expect(db.tables.session_spots.find((x) => x.area_id === 'orchard').computed_at).toBe(new Date(T0 + 60_000).toISOString())
  })

  it('brings only the older spots forward to loaded_at when recomputed, and leaves the version alone', () => {
    const { db, plan, row } = seeded()
    const old = new Date(T0 - 3_600_000).toISOString()
    plan({ loaded_at: old, spots: [spot('bugis'), spot('orchard', { rank: 2 })] })
    // One spot is stamped later than loaded_at (a newer run priced it): it is not moved back.
    db.tables.session_spots.find((x) => x.area_id === 'orchard').computed_at = new Date(T0).toISOString()
    const version = row().plan_version
    expect(plan({ recomputed: true, loaded_at: LOADED, spots: [spot('bugis'), spot('orchard', { rank: 2 })] }).data).toBe(version)
    const at = Object.fromEntries(db.tables.session_spots.map((x) => [x.area_id, x.computed_at]))
    expect(at).toEqual({ bugis: LOADED, orchard: new Date(T0).toISOString() })
  })

  it('refuses a loaded_at that is not a time', () => {
    const { plan } = seeded()
    expect(plan({ loaded_at: 'yesterday-ish', spots: [] }).error).toMatchObject({ code: '22007' })
  })
})
