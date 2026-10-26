// The stand-in database's sessions.meet_by follows db/schema.sql, db/policies.sql and db/tests/session_meet_by_access.sql: the host
// writes it in the update that starts the session or while the session is locating, never clears it, and no one else touches it.
// The steps below are the SQL test's, one for one, so the stand-in cannot drift from the files without a test saying so. No network.
import { describe, expect, it } from 'vitest'
import { SERVICE, createDatabase } from '../../components/dev/fakeDatabase.js'

const A = '00000000-0000-4000-8000-00000000000a'
const B = '00000000-0000-4000-8000-00000000000b'
const C = '00000000-0000-4000-8000-00000000000c'
const profile = (name) => ({ username: name, display_name: name, avatar_url: null })
const eq = (col, value) => ({ col, op: 'eq', value })

// A hosts a session with B in it (two joined, so it can start), in the given status; C is a stranger.
// How to call: const { sid, run } = seeded({ status: 'locating' })
function seeded({ status = 'inviting', alone = false } = {}) {
  const db = createDatabase({ profiles: { [A]: profile('a'), [B]: profile('b'), [C]: profile('c') } })
  const run = (op) => db.run(op)
  const sid = run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'T', date: '2026-10-10', start_time: '12:00', end_time: '20:00' }, returning: true, columns: 'id' }).data[0].id
  if (!alone) {
    const { token } = run({ as: A, kind: 'insert', table: 'invites', values: { session_id: sid, created_by: A }, returning: true, columns: 'token' }).data[0]
    run({ as: B, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
  }
  if (status !== 'inviting') run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status }, filters: [eq('id', sid)] })
  const set = (as, values) => run({ as, kind: 'update', table: 'sessions', values, filters: [eq('id', sid)], returning: true, columns: 'id, status, meet_by' })
  const read = () => run({ as: SERVICE, kind: 'select', table: 'sessions', columns: 'meet_by, status', filters: [eq('id', sid)] }).data[0]
  return { db, sid, run, set, read }
}

describe('sessions.meet_by', () => {
  it('is null on a new session, and a host cannot make one with it set', () => {
    const { run, read } = seeded()
    expect(read().meet_by).toBeNull()
    const made = run({ as: A, kind: 'insert', table: 'sessions', values: { host_id: A, title: 'X', date: '2026-10-10', start_time: '12:00', end_time: '13:00', meet_by: 'known' } })
    expect(made.error).toMatchObject({ code: '42501' })
  })

  it('is set by the host in the update that starts the session, and a guest reads it', () => {
    const { run, set, read, sid } = seeded()
    expect(set(A, { status: 'locating', meet_by: 'known' }).data).toEqual([{ id: sid, status: 'locating', meet_by: 'known' }])
    expect(read()).toEqual({ meet_by: 'known', status: 'locating' })
    const seen = run({ as: B, kind: 'select', table: 'sessions', columns: 'meet_by', filters: [eq('id', sid)] })
    expect(seen.data).toEqual([{ meet_by: 'known' }])
  })

  it('refuses a value other than fairest or known', () => {
    const { set } = seeded()
    expect(set(A, { status: 'locating', meet_by: 'sometimes' }).error).toMatchObject({ code: '23514' })
  })

  it('is refused while the session is only inviting, and a start with a choice still needs two joined people', () => {
    const { set, read } = seeded()
    expect(set(A, { meet_by: 'known' }).error).toMatchObject({ code: '42501' })
    const alone = seeded({ alone: true })
    expect(alone.set(A, { status: 'locating', meet_by: 'fairest' }).error).toMatchObject({ code: '42501' })
    expect(alone.read()).toEqual({ meet_by: null, status: 'inviting' })
    expect(read().meet_by).toBeNull()
  })

  it('touches no row for a guest or a stranger, and a logged-out visitor has no grant', () => {
    const { set, read, run, sid } = seeded()
    expect(set(B, { status: 'locating', meet_by: 'known' }).data).toEqual([])
    expect(set(C, { meet_by: 'known' }).data).toEqual([])
    expect(read()).toEqual({ meet_by: null, status: 'inviting' })
    const anon = run({ as: null, kind: 'update', table: 'sessions', values: { meet_by: 'known' }, filters: [eq('id', sid)] })
    expect(anon.error).toMatchObject({ code: '42501' })
  })

  it('stays null when an older client starts the session without it', () => {
    const { set, read } = seeded()
    expect(set(A, { status: 'locating' }).data).toHaveLength(1)
    expect(read().meet_by).toBeNull()
  })

  it('can change while the session is locating (fairest to known is "We already have a place"), but never be cleared', () => {
    const { set, read } = seeded({ status: 'locating' })
    expect(set(A, { meet_by: 'known' }).data).toHaveLength(1)
    expect(set(A, { meet_by: 'fairest' }).data).toHaveLength(1)
    expect(set(A, { meet_by: 'fairest' }).data).toHaveLength(1)
    expect(set(A, { meet_by: null }).error).toMatchObject({ code: '42501' })
    expect(set(A, { status: 'cancelled', meet_by: 'known' }).error).toMatchObject({ code: '42501' })
    expect(set(B, { meet_by: 'known' }).data).toEqual([])
    expect(read().meet_by).toBe('fairest')
  })

  it('is closed to a browser once the session is voting or finished, while the server can still write it', () => {
    const voting = seeded({ status: 'voting' })
    expect(voting.set(A, { meet_by: 'known' }).error).toMatchObject({ code: '42501' })
    expect(voting.set(A, { title: 'Renamed' }).data).toHaveLength(1)
    expect(voting.set(A, { status: 'voting', meeting_method: 'chosen' }).error).toMatchObject({ code: '42501' })
    expect(voting.set(SERVICE, { meet_by: 'known' }).data).toHaveLength(1)
    expect(voting.read().meet_by).toBe('known')
    const done = seeded({ status: 'cancelled' })
    expect(done.set(A, { meet_by: 'known' }).error).toMatchObject({ code: '42501' })
  })
})
