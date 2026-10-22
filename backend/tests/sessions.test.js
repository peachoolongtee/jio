import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorld } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// DELETE /api/sessions/:id/members/:userId (leave a session, or the host removes a guest), tested without the network.
// The login check is the real code: the test signs its own tokens. The database is the fake in helpers/fake-supabase.js: it shows a
// person only the sessions they are in, and a member row can be deleted only through apply_session_plan with the service key.
// The meeting-spot endpoints are tested in sessions-spots.test.js; this file keeps the leave and remove rules of stage 2 and
// the lifting of "inviting only" in stage 3.
const ENDED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STARTED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const VOTING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const CONFIRMED = 'ffffffff-ffff-4fff-8fff-ffffffffffff'

let world
const fresh = () => {
  world = createWorld()
  addSession(world, { id: SESSION, status: 'inviting', version: 4 })
  addSession(world, { id: ENDED, status: 'cancelled', version: 1 })
  addSession(world, { id: STARTED, status: 'locating', version: 2 })
  addSession(world, { id: VOTING, status: 'voting', version: 2 })
  addSession(world, { id: CONFIRMED, status: 'confirmed', version: 2 })
  for (const id of [SESSION]) {
    addMember(world, id, HOST, { role: 'host' })
    addMember(world, id, GUEST)
    addMember(world, id, OTHER)
  }
  for (const id of [ENDED, STARTED, VOTING, CONFIRMED]) {
    addMember(world, id, HOST, { role: 'host' })
    addMember(world, id, GUEST)
  }
  return world
}

const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((t) => t.stop()))
})

// Starts the app over a fresh world. `supabase: false` starts it with no Supabase at all.
// How to call: const t = await start(); await t.remove(SESSION, 'me', GUEST)
async function start(options = {}) {
  fresh()
  const t = await startSessionApp(world, options)
  started.push(t)
  // Asks to remove `person` ('me' or an id) from `session`, as `as` (a person's id; none sends no token).
  const remove = (session, person, as) => t.call('DELETE', `/api/sessions/${session}/members/${person}`, undefined, as)
  return { ...t, remove }
}

const memberIds = (session = SESSION) => world.session_members.filter((m) => m.session_id === session).map((m) => m.user_id)
const writes = () => world.calls.filter((c) => c.rpc === 'apply_session_plan')
const version = (session = SESSION) => world.sessions.find((s) => s.id === session).plan_version

describe('DELETE /api/sessions/:id/members/me (leaving)', () => {
  it('lets a guest leave: their row goes, with the server key, and the session version goes up by one', async () => {
    const t = await start()
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: 5, left: true })
    expect(memberIds()).toEqual([HOST, OTHER])
    expect(version()).toBe(5)
    // The caller was checked as themselves (reads only); the write is one call of the server's function, with the service key.
    expect(world.calls.filter((c) => c.who === GUEST).every((c) => c.kind === 'select')).toBe(true)
    expect(writes()).toHaveLength(1)
    expect(writes()[0].who).toBeNull()
  })

  it('accepts the caller\'s own id as well as "me"', async () => {
    const t = await start()
    expect((await t.remove(SESSION, GUEST, GUEST)).body).toEqual({ planVersion: 5, left: true })
    expect(memberIds()).toEqual([HOST, OTHER])
  })

  it('refuses the host: they cancel the session instead', async () => {
    const t = await start()
    const res = await t.remove(SESSION, 'me', HOST)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('host_cannot_leave')
    expect(memberIds()).toEqual([HOST, GUEST, OTHER])
    expect(writes()).toHaveLength(0)
  })

  it('answers 404 for a person who is not in the session, as for a session that does not exist', async () => {
    const t = await start()
    const stranger = await t.remove(SESSION, 'me', STRANGER)
    const missing = await t.remove('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'me', STRANGER)
    expect(stranger.status).toBe(404)
    expect(stranger.body.error).toBe('session_not_found')
    expect(missing.body).toEqual(stranger.body)
    expect(writes()).toHaveLength(0)
    // The service key is not touched for a stranger.
    expect(world.calls.filter((c) => c.who === null)).toHaveLength(0)
  })

  it('refuses a session that has ended', async () => {
    const t = await start()
    const res = await t.remove(ENDED, 'me', GUEST)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('session_closed')
    expect(memberIds(ENDED)).toEqual([HOST, GUEST])
  })
})

describe('DELETE /api/sessions/:id/members/:userId (the host removes a guest)', () => {
  it('lets the host remove a guest', async () => {
    const t = await start()
    const res = await t.remove(SESSION, GUEST, HOST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: 5, removed: true })
    expect(memberIds()).toEqual([HOST, OTHER])
  })

  it('refuses a guest who tries to remove someone else', async () => {
    const t = await start()
    const res = await t.remove(SESSION, OTHER, GUEST)
    expect(res.status).toBe(403)
    expect(res.body.error).toBe('host_only')
    expect(memberIds()).toEqual([HOST, GUEST, OTHER])
  })

  it('refuses to remove the host, whoever asks', async () => {
    const t = await start()
    expect((await t.remove(SESSION, HOST, GUEST)).body.error).toBe('host_only')
    expect(memberIds()).toContain(HOST)
  })

  it('says so when the person is not in the session', async () => {
    const t = await start()
    const res = await t.remove(SESSION, STRANGER, HOST)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('member_not_found')
  })

  it('refuses a session that has ended', async () => {
    const t = await start()
    expect((await t.remove(ENDED, GUEST, HOST)).body.error).toBe('session_closed')
    expect(memberIds(ENDED)).toEqual([HOST, GUEST])
  })

  it('does not let a person outside the session remove anyone', async () => {
    const t = await start()
    const res = await t.remove(SESSION, GUEST, STRANGER)
    expect(res.status).toBe(404)
    expect(memberIds()).toEqual([HOST, GUEST, OTHER])
  })
})

describe('the version, the status, and uuid case', () => {
  it('writes only when the session is still as it was loaded: a writer that got there first is never moved backwards', async () => {
    const t = await start()
    // Another server write raises the version between this request's read and its write.
    let played = false
    world.hooks.beforeApply = () => {
      if (played) return
      played = true
      world.sessions.find((s) => s.id === SESSION).plan_version = 5
    }
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(200)
    expect(version()).toBe(6)
    expect(res.body.planVersion).toBe(6)
    expect(memberIds()).toEqual([HOST, OTHER])
  })

  it('does two removals at once, in one write or two, and leaves the version above where it was', async () => {
    const t = await start()
    const [a, b] = await Promise.all([t.remove(SESSION, 'me', GUEST), t.remove(SESSION, 'me', OTHER)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(memberIds()).toEqual([HOST])
    expect(version()).toBeGreaterThan(4)
    expect(version()).toBeLessThanOrEqual(6)
  })

  it('counts two removals one after the other as two raises', async () => {
    const t = await start()
    expect((await t.remove(SESSION, 'me', GUEST)).body.planVersion).toBe(5)
    expect((await t.remove(SESSION, 'me', OTHER)).body.planVersion).toBe(6)
  })

  it('gives up after a few tries with 409 plan_busy and Retry-After, having written nothing', async () => {
    const t = await start()
    world.staleApply = 10
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('plan_busy')
    expect(res.headers.get('retry-after')).toBe('1')
    expect(memberIds()).toEqual([HOST, GUEST, OTHER])
    expect(writes()).toHaveLength(3)
  })

  it('stops a leave that lands after the session was cancelled: the status the request loaded is compared in the write', async () => {
    const t = await start()
    world.hooks.beforeApply = () => {
      world.hooks.beforeApply = null
      const s = world.sessions.find((x) => x.id === SESSION)
      s.status = 'cancelled'
      s.plan_version += 1
    }
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(409)
    expect(res.body.error).toBe('session_closed')
    expect(memberIds()).toEqual([HOST, GUEST, OTHER])
  })

  it('lets a member leave or be removed while the group is locating or voting, and refuses once the plan is confirmed (for now)', async () => {
    const t = await start()
    const leave = await t.remove(STARTED, 'me', GUEST)
    expect(leave.status).toBe(200)
    expect(leave.body).toEqual({ planVersion: 3, left: true })
    expect(memberIds(STARTED)).toEqual([HOST])
    // Voting (stage 4): a guest leaves, and the host can remove one.
    const leftVoting = await t.remove(VOTING, 'me', GUEST)
    expect(leftVoting.status).toBe(200)
    expect(leftVoting.body.left).toBe(true)
    expect(memberIds(VOTING)).toEqual([HOST])
    // Confirmed is the plan stage's.
    const left = await t.remove(CONFIRMED, 'me', GUEST)
    expect(left.status).toBe(409)
    expect(left.body.error).toBe('session_started')
    const removed = await t.remove(CONFIRMED, GUEST, HOST)
    expect(removed.status).toBe(409)
    expect(removed.body.error).toBe('session_started')
    expect(memberIds(CONFIRMED)).toEqual([HOST, GUEST])
  })

  it('compares ids without regard to the case of the letters, in the path and in the token', async () => {
    const t = await start()
    // The guest's own id in capitals is still "me": they leave, they are not refused as a guest removing someone.
    const own = await t.remove(SESSION, GUEST.toUpperCase(), GUEST)
    expect(own.status).toBe(200)
    expect(own.body.left).toBe(true)
    // A token whose subject is in capitals is still the host.
    const host = await t.remove(SESSION, OTHER.toUpperCase(), HOST.toUpperCase())
    expect(host.status).toBe(200)
    expect(host.body.removed).toBe(true)
    expect(memberIds()).toEqual([HOST])
  })

  it('tells the host who asks to remove themselves that they cannot leave', async () => {
    const t = await start()
    expect((await t.remove(SESSION, HOST, HOST)).body.error).toBe('host_cannot_leave')
    expect((await t.remove(SESSION, HOST.toUpperCase(), HOST)).body.error).toBe('host_cannot_leave')
  })
})

describe('the route\'s edges', () => {
  it('needs a login: no token, a bad token', async () => {
    const t = await start()
    const none = await t.remove(SESSION, 'me', null)
    expect(none.status).toBe(401)
    expect(none.body.error).toBe('unauthenticated')
    const bad = await fetch(`${t.base}/api/sessions/${SESSION}/members/me`, { method: 'DELETE', headers: { authorization: 'Bearer not.a.token' } })
    expect(bad.status).toBe(401)
    expect(memberIds()).toEqual([HOST, GUEST, OTHER])
  })

  it('refuses ids that are not uuids with the flat error shape', async () => {
    const t = await start()
    const badSession = await t.remove('not-a-uuid', 'me', GUEST)
    expect(badSession.status).toBe(400)
    expect(badSession.body.error).toBe('invalid_input')
    expect(typeof badSession.body.message).toBe('string')
    expect((await t.remove(SESSION, 'someone', GUEST)).body.error).toBe('invalid_input')
  })

  it('is not there without Supabase', async () => {
    const t = await start({ supabase: false })
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })

  it('limits each signed-in person, not the address, and says when to try again', async () => {
    const t = await start({ sessionRateLimit: { windowMs: 60_000, max: 2 } })
    expect((await t.remove(SESSION, STRANGER, GUEST)).status).toBe(403)
    expect((await t.remove(SESSION, STRANGER, GUEST)).status).toBe(403)
    const limited = await t.remove(SESSION, STRANGER, GUEST)
    expect(limited.status).toBe(429)
    expect(limited.body.error).toBe('rate_limited')
    expect(Number(limited.headers.get('retry-after'))).toBeGreaterThan(0)
    // Another person, from the same address, is not held by it.
    expect((await t.remove(SESSION, 'me', OTHER)).status).toBe(200)
  })

  it('answers 500 through the error handler when the write fails, without the database\'s words, and keeps the member', async () => {
    const t = await start()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    world.failApply = true
    const failed = await t.remove(SESSION, 'me', OTHER)
    expect(failed.status).toBe(500)
    expect(failed.body.error).toBe('server_error')
    expect(JSON.stringify(failed.body)).not.toContain('boom')
    expect(memberIds()).toEqual([HOST, GUEST, OTHER])
  })
})
