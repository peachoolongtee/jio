// The stand-in database's port of the op `release_meeting` of apply_session_plan (db/migrations/20261027000000_jio_change_meeting_place.sql, with the
// cases of db/tests/apply_session_plan.sql steps 301 onwards): the only way a voting or confirmed session goes back to locating, and the only way a
// chosen meeting area is let go. No network.
import { describe, expect, it } from 'vitest'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
const eq = (col, value) => ({ col, op: 'eq', value })
const MEETING = { area_id: 'bugis', method: 'chosen', max_minutes: 20, total_minutes: 30, count: 2, approximate: false, travel: { [A]: 20, [B]: 10 } }
const RELEASE = (extra = {}) => ({ ops: [{ op: 'release_meeting', meet_by: 'fairest' }], session: { status: 'locating', ...(extra.session ?? {}) }, ...extra.rest })

// A hosts, B joins; the session is voting at Bugis (chosen) with one slot, a vote each and a spot, and both have a start.
// How to call: const { db, sid, row, plan } = voting()
function voting() {
  const db = createDatabase({ profiles: { [A]: profile('a'), [B]: profile('b') } })
  const sid = db.run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'T', date: '2026-10-21', start_time: '12:00', end_time: '20:00' }, returning: true, columns: 'id' }).data[0].id
  const { token } = db.run({ as: A, kind: 'insert', table: 'invites', values: { session_id: sid, created_by: A }, returning: true, columns: 'token' }).data[0]
  db.run({ as: B, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
  const row = () => db.tables.sessions.find((s) => s.id === sid)
  const apply = (patch, status = row().status, version = row().plan_version) => db.run({ as: SERVICE, kind: 'rpc', fn: 'apply_session_plan', args: { sid, expected_version: version, expected_status: status, patch } })
  db.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'locating', meet_by: 'known' }, filters: [eq('id', sid)] })
  db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { start_area_id: 'tampines' }, filters: [eq('user_id', A)] })
  db.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { start_area_id: 'bishan' }, filters: [eq('user_id', B)] })
  expect(apply({ spots: [{ area_id: 'bugis', rank: 1, worst_minutes: 20, mean_minutes: 15 }], session: { status: 'voting', meeting: MEETING }, slots: [{ category: 'eat', start_minute: 720, duration_minutes: 90, picks: 2, is_last: true, options: [{ venue_id: 'v1', rank: 1, score: 1 }] }] }).error).toBeNull()
  const slotId = db.tables.slots[0].id
  for (const who of [A, B]) expect(db.run({ as: who, kind: 'insert', table: 'votes', values: { slot_id: slotId, user_id: who, venue_id: 'v1' } }).error).toBeNull()
  return { db, sid, row, apply }
}

describe('refused', () => {
  it('a move back to locating without the op, and the op on any other move', () => {
    const { row, apply } = voting()
    const hint = (patch, status) => apply(patch, status).error?.hint
    expect(hint({ session: { status: 'locating' } })).toBe('status_transition')
    expect(hint({ ops: [{ op: 'release_meeting', meet_by: 'fairest' }] })).toBe('release_status')
    expect(hint({ ops: [{ op: 'release_meeting', meet_by: 'fairest' }], session: { status: 'confirmed' } })).toBe('release_status')
    expect(row().status).toBe('voting')
  })

  it('a missing or unknown meet_by, and a meeting of its own', () => {
    const { row, apply } = voting()
    expect(apply({ ops: [{ op: 'release_meeting' }], session: { status: 'locating' } }).error.code).toBe('22023')
    expect(apply({ ops: [{ op: 'release_meeting', meet_by: 'x' }], session: { status: 'locating' } }).error.code).toBe('22023')
    expect(apply({ ops: [{ op: 'release_meeting', meet_by: 'known' }], session: { status: 'locating', meeting: MEETING } }).error.hint).toBe('release_meeting')
    expect(row().status).toBe('voting')
  })

  it('area_pinned still holds on every other path', () => {
    const { apply } = voting()
    expect(apply({ session: { meeting: { ...MEETING, area_id: 'orchard' } } }).error.hint).toBe('area_pinned')
    expect(apply({ session: { meeting: null } }).error.hint).toBe('area_pinned')
  })

  it('a browser cannot move the status back, and cannot call the function', () => {
    const { db, sid } = voting()
    expect(db.run({ as: A, kind: 'update', table: 'sessions', values: { status: 'locating' }, filters: [eq('id', sid)] }).error.code).toBe('42501')
    expect(db.run({ as: A, kind: 'rpc', fn: 'apply_session_plan', args: { sid, expected_version: 1, expected_status: 'voting', patch: RELEASE() } }).error.code).toBe('42501')
  })
})

describe('the release', () => {
  it('lets the meeting area go in one write, clears what belonged to it, keeps the starts, stores the choice and brings the notice', () => {
    const { db, sid, row, apply } = voting()
    const before = row().plan_version
    const answer = apply(RELEASE({ session: { banner: { text: 'Sam changed the meeting place, so the votes were cleared.', released: true } } }))
    expect(answer.error).toBeNull()
    expect(answer.data).toBe(before + 1)
    expect(row()).toMatchObject({ status: 'locating', meeting_area_id: null, meeting_method: null, meeting_max_minutes: null, meeting_total_minutes: null, meeting_count: null, meet_by: 'fairest' })
    expect(row().banner).toMatchObject({ text: 'Sam changed the meeting place, so the votes were cleared.', released: true, at: expect.any(Number) })
    for (const table of ['slots', 'slot_options', 'votes', 'stops', 'session_spots']) expect(db.tables[table].filter((r) => r.session_id === sid || !r.session_id)).toEqual([])
    const members = db.tables.session_members.filter((m) => m.session_id === sid)
    expect(members.map((m) => m.start_area_id).sort()).toEqual(['bishan', 'tampines'])
    expect(members.every((m) => m.travel_minutes === null)).toBe(true)
  })

  it('clears the old notice when it brings none, and a late release answers null', () => {
    const { row, apply } = voting()
    apply({ session: { banner: { text: 'Old.' } } })
    expect(row().banner).toMatchObject({ text: 'Old.' })
    const version = row().plan_version
    expect(apply(RELEASE(), 'voting', version - 1).data).toBeNull()
    expect(apply(RELEASE()).error).toBeNull()
    expect(row().banner).toBeNull()
  })

  it('from confirmed it clears the plan\'s columns and dismisses the proposals waiting', () => {
    const { db, sid, row, apply } = voting()
    const slot = db.tables.slots[0]
    db.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed', order_reason: 'Because.', order_source: 'rules', plan_start_minute: 700, replan: { reason: 'x' }, weather_kept: { s: 'showers' } }, filters: [eq('id', sid)] })
    db.run({ as: SERVICE, kind: 'insert', table: 'stops', values: { session_id: sid, seq: 0, slot_id: slot.id, category: 'eat', venue_id: 'v1', planned_start_minute: 720, duration_minutes: 90 } })
    db.run({ as: SERVICE, kind: 'insert', table: 'stop_proposals', values: { session_id: sid, venue_id: 'p1', proposed_by: B } })
    expect(apply(RELEASE()).error).toBeNull()
    expect(row()).toMatchObject({ status: 'locating', order_reason: null, order_source: null, plan_start_minute: null, replan: null, weather_kept: null })
    expect(db.tables.stops).toEqual([])
    expect(db.tables.stop_proposals.map((p) => p.status)).toEqual(['dismissed'])
  })
})
