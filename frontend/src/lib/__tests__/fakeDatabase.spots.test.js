// The stand-in database's stage 3 tables follow db/schema.sql and db/policies.sql: a member's own start areas and exact place, the
// spot list and suggestions (the server's), and "Works for me" (the member's own, while locating). The rules the app leans on are
// each a test here, so the stand-in cannot drift from the files without a test saying so. No network.
import { describe, expect, it } from 'vitest'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const D = '00000000-0000-4000-8000-00000000000d'
const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
const eq = (col, value) => ({ col, op: 'eq', value })

// A hosts a locating session with B in it; C is a stranger; D has opted out.
// How to call: const { db, sid, run } = seeded()
function seeded({ status = 'locating' } = {}) {
  const db = createDatabase({ profiles: { [A]: profile('a'), [B]: profile('b'), [C]: profile('c'), [D]: profile('d') } })
  const run = (op) => db.run(op)
  const sid = run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'T', date: '2026-10-10', start_time: '12:00', end_time: '20:00' }, returning: true, columns: 'id' }).data[0].id
  for (const user of [B, D]) {
    const { token } = run({ as: A, kind: 'insert', table: 'invites', values: { session_id: sid, created_by: A }, returning: true, columns: 'token' }).data[0]
    run({ as: user, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
    run({ as: A, kind: 'update', table: 'invites', values: { revoked: true }, filters: [eq('session_id', sid)] })
  }
  run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('user_id', D)] })
  if (status !== 'inviting') run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status }, filters: [eq('id', sid)] })
  return { db, sid, run }
}
const spot = (sid, area, extra = {}) => ({ session_id: sid, area_id: area, rank: 1, worst_minutes: 20, mean_minutes: 15, travel_minutes: { [A]: 20, [B]: 10 }, ...extra })

describe('a member\'s own start and exact place', () => {
  it('lets a joined member change their own areas while the session is open, and no one else\'s', () => {
    const { sid, run } = seeded()
    const mine = run({ as: B, kind: 'update', table: 'session_members', values: { start_area_id: 'bugis', end_area_id: 'orchard' }, filters: [eq('session_id', sid)], returning: true, columns: 'user_id, start_area_id, end_area_id' })
    expect(mine.data).toEqual([{ user_id: B, start_area_id: 'bugis', end_area_id: 'orchard' }])
    // Every row was asked for and only the person's own changed.
    const rows = run({ as: A, kind: 'select', table: 'session_members', columns: 'user_id, start_area_id', filters: [eq('session_id', sid)] }).data
    expect(Object.fromEntries(rows.map((r) => [r.user_id, r.start_area_id]))).toEqual({ [A]: null, [B]: 'bugis', [D]: null })
  })

  it('refuses the columns a member does not own, an opted-out member, a finished session and a stranger', () => {
    const { sid, run } = seeded()
    for (const values of [{ role: 'host' }, { state: 'opted_out' }, { travel_minutes: 5 }]) {
      expect(run({ as: B, kind: 'update', table: 'session_members', values, filters: [eq('session_id', sid)] }).error).toMatchObject({ code: '42501' })
    }
    const change = (as) => run({ as, kind: 'update', table: 'session_members', values: { start_area_id: 'bugis' }, filters: [eq('session_id', sid), eq('user_id', as)], returning: true, columns: 'user_id' }).data
    expect(change(D)).toEqual([])
    expect(change(C)).toEqual([])
    run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', sid)] })
    expect(change(B)).toEqual([])
  })

  it('checks the area text the way the schema does', () => {
    const { sid, run } = seeded()
    const answer = run({ as: B, kind: 'update', table: 'session_members', values: { start_area_id: 'x'.repeat(61) }, filters: [eq('session_id', sid)] })
    expect(answer.error).toMatchObject({ code: '23514' })
  })

  it('keeps the exact place readable by its owner alone, even from the host', () => {
    const { sid, run } = seeded()
    run({ as: B, kind: 'insert', table: 'session_member_places', values: { session_id: sid, user_id: B, start_label: 'Blk 1', start_lat: 1.35, start_lng: 103.85 } })
    const read = (as) => run({ as, kind: 'select', table: 'session_member_places', columns: '*', filters: [] }).data
    expect(read(B).map((r) => r.start_label)).toEqual(['Blk 1'])
    expect(read(A)).toEqual([])
    expect(read(C)).toEqual([])
    expect(run({ as: null, kind: 'select', table: 'session_member_places', columns: '*', filters: [] }).error).toMatchObject({ code: '42501' })
    // Nor can it be written in another person's name.
    expect(run({ as: A, kind: 'insert', table: 'session_member_places', values: { session_id: sid, user_id: B, start_label: 'x' } }).error).toMatchObject({ code: '42501' })
    expect(run({ as: A, kind: 'update', table: 'session_member_places', values: { start_label: 'x' }, filters: [eq('session_id', sid)], returning: true, columns: 'user_id' }).data).toEqual([])
  })

  it('checks the place the way the schema does: Singapore, a latitude with its longitude, a label of 120 at most, one row each', () => {
    const { sid, run } = seeded()
    const insert = (values) => run({ as: B, kind: 'insert', table: 'session_member_places', values: { session_id: sid, user_id: B, ...values } })
    expect(insert({ start_lat: 1.35 }).error).toMatchObject({ code: '23514' })
    expect(insert({ start_lat: 5, start_lng: 103.8 }).error).toMatchObject({ code: '23514' })
    expect(insert({ start_label: 'x'.repeat(121) }).error).toMatchObject({ code: '23514' })
    expect(insert({ start_label: 'ok' }).error).toBeNull()
    expect(insert({ start_label: 'again' }).error).toMatchObject({ code: '23505' })
  })

  it('lets a person delete their own place at any time, even after the session is over', () => {
    const { sid, run } = seeded()
    run({ as: B, kind: 'insert', table: 'session_member_places', values: { session_id: sid, user_id: B, start_label: 'Blk 1' } })
    run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'cancelled' }, filters: [eq('id', sid)] })
    expect(run({ as: B, kind: 'update', table: 'session_member_places', values: { start_label: 'y' }, filters: [eq('session_id', sid)], returning: true, columns: 'user_id' }).data).toEqual([])
    run({ as: B, kind: 'delete', table: 'session_member_places', filters: [eq('session_id', sid)] })
    expect(run({ as: B, kind: 'select', table: 'session_member_places', columns: '*', filters: [] }).data).toEqual([])
  })
})

describe('the spot list and the suggestions', () => {
  it('are read by the members of the session and by no one else, and written by the server only', () => {
    const { db, sid, run } = seeded()
    expect(run({ as: SERVICE, kind: 'insert', table: 'session_spots', values: spot(sid, 'bugis') }).error).toBeNull()
    expect(run({ as: SERVICE, kind: 'insert', table: 'spot_suggestions', values: { session_id: sid, user_id: B, area_id: 'orchard', here: true } }).error).toBeNull()
    for (const table of ['session_spots', 'spot_suggestions']) {
      expect(run({ as: B, kind: 'select', table, columns: '*', filters: [] }).data).toHaveLength(1)
      expect(run({ as: C, kind: 'select', table, columns: '*', filters: [] }).data).toEqual([])
      expect(run({ as: null, kind: 'select', table, columns: '*', filters: [] }).error).toMatchObject({ code: '42501' })
      expect(run({ as: B, kind: 'insert', table, values: table === 'session_spots' ? spot(sid, 'x') : { session_id: sid, user_id: B, area_id: 'x' } }).error).toMatchObject({ code: '42501' })
      expect(run({ as: A, kind: 'update', table, values: { area_id: 'x' }, filters: [] }).error).toMatchObject({ code: '42501' })
      expect(run({ as: A, kind: 'delete', table, filters: [] }).error).toMatchObject({ code: '42501' })
    }
    expect(db.tables.session_spots).toHaveLength(1)
  })

  it('check what the schema checks: the minutes, the rank, a rank given once, one suggestion each', () => {
    const { sid, run } = seeded()
    const insert = (values) => run({ as: SERVICE, kind: 'insert', table: 'session_spots', values }).error
    expect(insert(spot(sid, 'a', { mean_minutes: 25 }))).toMatchObject({ code: '23514' })
    expect(insert(spot(sid, 'a', { worst_minutes: 2000 }))).toMatchObject({ code: '23514' })
    expect(insert(spot(sid, 'a', { rank: 4 }))).toMatchObject({ code: '23514' })
    expect(insert(spot(sid, 'a', { travel_minutes: { 'not-a-uuid': 5 } }))).toMatchObject({ code: '23514' })
    expect(insert(spot(sid, 'a'))).toBeNull()
    expect(insert(spot(sid, 'b'))).toMatchObject({ code: '23505' })
    expect(insert(spot(sid, 'b', { rank: null }))).toBeNull()
    const suggest = (user, area) => run({ as: SERVICE, kind: 'insert', table: 'spot_suggestions', values: { session_id: sid, user_id: user, area_id: area } }).error
    expect(suggest(B, 'a')).toBeNull()
    expect(suggest(B, 'b')).toMatchObject({ code: '23505' })
    expect(suggest(C, 'a')).toMatchObject({ code: '23503' })
  })
})

describe('"Works for me"', () => {
  function withSpots(status) {
    const world = seeded({ status })
    world.run({ as: SERVICE, kind: 'insert', table: 'session_spots', values: spot(world.sid, 'bugis') })
    world.run({ as: SERVICE, kind: 'insert', table: 'session_spots', values: spot(world.sid, 'orchard', { rank: 2 }) })
    return world
  }
  const mark = (run, as, sid, area, user = as) => run({ as, kind: 'insert', table: 'spot_approvals', values: { session_id: sid, area_id: area, user_id: user } }).error

  it('is the member\'s own row, on a listed spot, once, while joined and locating', () => {
    const { sid, run } = withSpots('locating')
    expect(mark(run, B, sid, 'bugis')).toBeNull()
    expect(mark(run, B, sid, 'orchard')).toBeNull()
    expect(mark(run, B, sid, 'bugis')).toMatchObject({ code: '23505' })
    expect(mark(run, B, sid, 'nowhere')).toMatchObject({ code: '23503' })
    expect(mark(run, B, sid, 'bugis', A)).toMatchObject({ code: '42501' })
    expect(mark(run, D, sid, 'bugis')).toMatchObject({ code: '42501' })
    expect(mark(run, C, sid, 'bugis')).toMatchObject({ code: '42501' })
  })

  it('is refused once the group has moved past choosing where to meet, and in a session still inviting', () => {
    for (const status of ['voting', 'confirmed', 'cancelled', 'inviting']) {
      const { sid, run } = withSpots(status)
      expect(mark(run, B, sid, 'bugis')).toMatchObject({ code: '42501' })
    }
  })

  it('can be taken back by its owner only, and only while locating', () => {
    const { db, sid, run } = withSpots('locating')
    mark(run, B, sid, 'bugis')
    mark(run, A, sid, 'bugis')
    run({ as: B, kind: 'delete', table: 'spot_approvals', filters: [eq('session_id', sid), eq('user_id', A)] })
    expect(db.tables.spot_approvals).toHaveLength(2)
    run({ as: B, kind: 'delete', table: 'spot_approvals', filters: [eq('session_id', sid)] })
    expect(db.tables.spot_approvals.map((r) => r.user_id)).toEqual([A])
    run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'voting' }, filters: [eq('id', sid)] })
    run({ as: A, kind: 'delete', table: 'spot_approvals', filters: [] })
    expect(db.tables.spot_approvals).toHaveLength(1)
  })

  it('is read by the members, goes with its spot, and goes with its member', () => {
    const { db, sid, run } = withSpots('locating')
    mark(run, B, sid, 'bugis')
    mark(run, A, sid, 'orchard')
    expect(run({ as: A, kind: 'select', table: 'spot_approvals', columns: 'user_id', filters: [] }).data).toHaveLength(2)
    expect(run({ as: C, kind: 'select', table: 'spot_approvals', columns: 'user_id', filters: [] }).data).toEqual([])
    run({ as: SERVICE, kind: 'delete', table: 'session_spots', filters: [eq('area_id', 'bugis')] })
    expect(db.tables.spot_approvals.map((r) => r.area_id)).toEqual(['orchard'])
    run({ as: SERVICE, kind: 'insert', table: 'session_member_places', values: { session_id: sid, user_id: A, start_label: 'x' } })
    run({ as: SERVICE, kind: 'insert', table: 'spot_suggestions', values: { session_id: sid, user_id: A, area_id: 'orchard' } })
    run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [eq('user_id', A)] })
    expect(db.tables.spot_approvals).toEqual([])
    expect(db.tables.session_member_places).toEqual([])
    expect(db.tables.spot_suggestions).toEqual([])
  })
})

describe('what live updates carry', () => {
  const settle = () => new Promise((resolve) => setTimeout(resolve, 5))

  it('carries a mark to the members, never to a stranger, and the taking back as a key only', async () => {
    const { db, sid, run } = seeded()
    run({ as: SERVICE, kind: 'insert', table: 'session_spots', values: spot(sid, 'bugis') })
    const heard = { a: [], c: [] }
    db.subscribe({ as: A, table: 'spot_approvals' }, (p) => heard.a.push(p))
    db.subscribe({ as: C, table: 'spot_approvals' }, (p) => heard.c.push(p))
    run({ as: B, kind: 'insert', table: 'spot_approvals', values: { session_id: sid, area_id: 'bugis', user_id: B } })
    await settle()
    expect(heard.a.map((p) => p.eventType)).toEqual(['INSERT'])
    expect(heard.c).toEqual([])
    run({ as: B, kind: 'delete', table: 'spot_approvals', filters: [eq('session_id', sid)] })
    await settle()
    expect(heard.a.at(-1)).toMatchObject({ eventType: 'DELETE', new: {}, old: { session_id: sid, area_id: 'bugis', user_id: B } })
    // A delete is not filtered by access rules (keys only), so even a stranger hears it.
    expect(heard.c.map((p) => p.eventType)).toEqual(['DELETE'])
  })

  it('carries nothing for the exact places, the spot list or the suggestions: they are not in the publication', async () => {
    const { db, sid, run } = seeded()
    const heard = []
    for (const table of ['session_member_places', 'session_spots', 'spot_suggestions']) db.subscribe({ as: B, table }, (p) => heard.push(p))
    run({ as: B, kind: 'insert', table: 'session_member_places', values: { session_id: sid, user_id: B, start_label: 'x' } })
    run({ as: SERVICE, kind: 'insert', table: 'session_spots', values: spot(sid, 'bugis') })
    run({ as: SERVICE, kind: 'insert', table: 'spot_suggestions', values: { session_id: sid, user_id: B, area_id: 'bugis' } })
    run({ as: SERVICE, kind: 'delete', table: 'session_spots', filters: [] })
    await settle()
    expect(heard).toEqual([])
  })

  it('carries a member\'s change of start to the others as a session_members update', async () => {
    const { db, sid, run } = seeded()
    const heard = []
    db.subscribe({ as: A, table: 'session_members', event: 'UPDATE' }, (p) => heard.push(p))
    run({ as: B, kind: 'update', table: 'session_members', values: { start_area_id: 'bugis' }, filters: [eq('session_id', sid), eq('user_id', B)] })
    await settle()
    expect(heard).toHaveLength(1)
    expect(heard[0].new).toMatchObject({ user_id: B, start_area_id: 'bugis' })
  })
})
