// The stand-in database's tables for the dietary needs of one outing (db/migrations/20261030000000_jio_outing_dietary.sql): server only,
// removed with the member or the session, checked like the real tables, and session_member_needs() answering a member's list for the outing
// over their profile's. No network.
import { describe, expect, it } from 'vitest'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
const eq = (col, value) => ({ col, op: 'eq', value })

// A hosts and B joins; B's profile says halal, A's says nothing.
// How to call: const { db, sid } = outing()
function outing() {
  const db = createDatabase({
    profiles: { [A]: profile('a'), [B]: profile('b') },
    needs: { [A]: { dietary: [] }, [B]: { dietary: ['halal'] } },
  })
  const sid = db.run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'T', date: '2026-10-21', start_time: '12:00', end_time: '20:00' }, returning: true, columns: 'id' }).data[0].id
  const { token } = db.run({ as: A, kind: 'insert', table: 'invites', values: { session_id: sid, created_by: A }, returning: true, columns: 'token' }).data[0]
  db.run({ as: B, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
  const needs = () => db.run({ as: SERVICE, kind: 'rpc', fn: 'session_member_needs', args: { sid } }).data
  const upsert = (table, values) => db.run({ as: SERVICE, kind: 'insert', upsert: true, table, values })
  return { db, sid, needs, upsert }
}

describe('the two tables are the server’s alone', () => {
  it('refuses a person, a member of the outing and the host, for every kind of request, even on their own row', () => {
    const { db, sid } = outing()
    db.run({ as: SERVICE, kind: 'insert', upsert: true, table: 'session_member_dietary', values: { session_id: sid, user_id: B, dietary: ['vegan'] } })
    db.run({ as: SERVICE, kind: 'insert', upsert: true, table: 'session_dietary_dropped', values: { session_id: sid, need: 'halal' } })
    for (const as of [A, B, null]) {
      for (const table of ['session_member_dietary', 'session_dietary_dropped']) {
        expect(db.run({ as, kind: 'select', table, columns: '*', filters: [] }).error.code, `${as} select ${table}`).toBe('42501')
        expect(db.run({ as, kind: 'insert', table, values: { session_id: sid, user_id: as, need: 'vegan', dietary: [] } }).error.code).toBe('42501')
        expect(db.run({ as, kind: 'update', table, values: { dietary: [] }, filters: [] }).error.code).toBe('42501')
        expect(db.run({ as, kind: 'delete', table, filters: [] }).error.code).toBe('42501')
      }
    }
    expect(db.tables.session_member_dietary).toHaveLength(1)
    expect(db.tables.session_dietary_dropped).toHaveLength(1)
  })

  it('lets the server write, read and delete both', () => {
    const { db, sid, upsert } = outing()
    expect(upsert('session_member_dietary', { session_id: sid, user_id: B, dietary: ['vegan'] }).error).toBeNull()
    // A second upsert changes the row it finds, and a column left out keeps its value.
    expect(upsert('session_member_dietary', { session_id: sid, user_id: B, confirmed_at: '2026-10-30T08:00:00.000Z' }).error).toBeNull()
    expect(db.run({ as: SERVICE, kind: 'select', table: 'session_member_dietary', columns: 'user_id, dietary, confirmed_at', filters: [eq('session_id', sid)] }).data).toEqual([
      { user_id: B, dietary: ['vegan'], confirmed_at: '2026-10-30T08:00:00.000Z' },
    ])
    expect(upsert('session_dietary_dropped', { session_id: sid, need: 'halal' }).error).toBeNull()
    expect(upsert('session_dietary_dropped', { session_id: sid, need: 'halal' }).error).toBeNull()
    expect(db.tables.session_dietary_dropped).toHaveLength(1)
    expect(db.run({ as: SERVICE, kind: 'delete', table: 'session_dietary_dropped', filters: [eq('session_id', sid), { col: 'need', op: 'in', value: ['halal'] }] }).error).toBeNull()
    expect(db.tables.session_dietary_dropped).toEqual([])
  })

  it('applies the table’s checks: known needs, at most three, no repeats, a real member and session', () => {
    const { sid, upsert } = outing()
    for (const dietary of [['kosher'], ['halal', 'halal'], ['halal', 'vegan', 'vegetarian', 'halal'], 'halal']) {
      expect(upsert('session_member_dietary', { session_id: sid, user_id: B, dietary }).error.code, JSON.stringify(dietary)).toBe('23514')
    }
    expect(upsert('session_member_dietary', { session_id: sid, user_id: '00000000-0000-4000-8000-00000000000c', dietary: [] }).error.code).toBe('23503')
    expect(upsert('session_member_dietary', { session_id: '00000000-0000-4000-8000-0000000000ff', user_id: B, dietary: [] }).error.code).toBe('23503')
    expect(upsert('session_dietary_dropped', { session_id: sid, need: 'pork' }).error.code).toBe('23514')
  })
})

describe('what goes with what', () => {
  it('a member who leaves takes their needs for the outing, and a session that goes takes both tables’ rows', () => {
    const { db, sid, upsert } = outing()
    upsert('session_member_dietary', { session_id: sid, user_id: B, dietary: ['vegan'] })
    upsert('session_dietary_dropped', { session_id: sid, need: 'halal' })
    db.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [eq('session_id', sid), eq('user_id', B)] })
    expect(db.tables.session_member_dietary).toEqual([])
    expect(db.tables.session_dietary_dropped).toHaveLength(1)
    db.run({ as: SERVICE, kind: 'delete', table: 'sessions', filters: [eq('id', sid)] })
    expect(db.tables.session_dietary_dropped).toEqual([])
  })
})

describe('session_member_needs()', () => {
  it('answers a member’s list for the outing over their profile’s, an empty list included, and leaves the profile alone', () => {
    const { db, sid, needs, upsert } = outing()
    expect(needs().find((n) => n.user_id === B).dietary).toEqual(['halal'])
    upsert('session_member_dietary', { session_id: sid, user_id: B, dietary: ['vegan'] })
    expect(needs().find((n) => n.user_id === B).dietary).toEqual(['vegan'])
    upsert('session_member_dietary', { session_id: sid, user_id: B, dietary: [] })
    expect(needs().find((n) => n.user_id === B).dietary).toEqual([])
    expect(needs().find((n) => n.user_id === A).dietary).toEqual([])
    expect(db.run({ as: B, kind: 'rpc', fn: 'session_member_needs', args: { sid } }).error.code).toBe('42501')
  })
})
