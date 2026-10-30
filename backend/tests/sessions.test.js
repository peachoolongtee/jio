import { afterEach, describe, expect, it, vi } from 'vitest'
import { createWorld } from './helpers/fake-supabase.js'
import { addMember, addSession, GUEST, HOST, OTHER, SESSION, startSessionApp, STRANGER } from './helpers/session-app.js'

// DELETE /api/sessions/:id/members/:userId (leave a session, or the host removes a guest), and GET /api/sessions/:id/dietary (an
// outing's needs together), tested without the network.
// The login check is the real code: the test signs its own tokens. The database is the fake in helpers/fake-supabase.js: it shows a
// person only the sessions they are in, and a member row can be deleted only through apply_session_plan with the service key.
// The meeting-spot endpoints are tested in sessions-spots.test.js; this file keeps the leave and remove rules of stage 2 and
// the lifting of "inviting only" in stage 3.
const ENDED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STARTED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'
const VOTING = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'
const CONFIRMED = 'ffffffff-ffff-4fff-8fff-ffffffffffff'
const SMALL = '99999999-9999-4999-8999-999999999999' // a session the dietary tests make for themselves

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
  // Each person's private row, as profile_private holds it: dietary needs and the other private fields (GET .../dietary).
  world.profile_private = [
    { id: HOST, dietary: ['vegan'], home_area_id: 'tampines', budget_max_per_person: 20, needs_step_free: true },
    { id: GUEST, dietary: ['halal', 'durian-free'], home_area_id: 'bishan', budget_max_per_person: null, needs_step_free: false },
    { id: OTHER, dietary: null, home_area_id: 'bugis', budget_max_per_person: null, needs_step_free: false },
  ]
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
  // Asks for `session`'s dietary needs, as `as` (a person's id; none sends no token).
  const needs = (session, as) => t.call('GET', `/api/sessions/${session}/dietary`, undefined, as)
  return { ...t, remove, needs }
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

describe('GET /api/sessions/:id/dietary (an outing’s needs, together)', () => {
  it('gives a member every need in the outing and the others’ needs, in the app’s order, and nothing else', async () => {
    const t = await start()
    const asGuest = await t.needs(SESSION, GUEST)
    expect(asGuest.status).toBe(200)
    expect(asGuest.body).toEqual({ dietary: ['halal', 'vegan'], others: ['vegan'], mine: ['halal'], checked: false, dropped: [] })
    expect((await t.needs(SESSION, HOST)).body).toEqual({ dietary: ['halal', 'vegan'], others: ['halal'], mine: ['vegan'], checked: false, dropped: [] })
    expect((await t.needs(SESSION, OTHER)).body).toEqual({ dietary: ['halal', 'vegan'], others: ['halal', 'vegan'], mine: [], checked: false, dropped: [] })
    // No ids, no counts, no other private field, and an unknown need is dropped.
    const text = JSON.stringify(asGuest.body)
    for (const leak of [HOST, GUEST, OTHER, 'tampines', 'bishan', 'durian', 'budget', 'step']) expect(text).not.toContain(leak)
    expect(asGuest.headers.get('cache-control')).toBe('no-store')
  })

  it('says nothing about the others when only two have joined: the caller would learn their partner\'s own list', async () => {
    const t = await start()
    // Two joined members, and a third who opted out and has a need of their own that must stay out of both lists.
    addSession(world, { id: SMALL, status: 'inviting', version: 1 })
    addMember(world, SMALL, HOST, { role: 'host' })
    addMember(world, SMALL, GUEST)
    addMember(world, SMALL, STRANGER, { state: 'opted_out' })
    world.profile_private.push({ id: STRANGER, dietary: ['vegetarian'], home_area_id: 'bugis', budget_max_per_person: null, needs_step_free: false })
    const asHost = await t.needs(SMALL, HOST)
    expect(asHost.status).toBe(200)
    // `dietary` is the caller's own list alone: a union would tell each of the two the other's.
    expect(asHost.body).toEqual({ dietary: ['vegan'], others: [], mine: ['vegan'], checked: false, dropped: [] })
    expect((await t.needs(SMALL, GUEST)).body).toEqual({ dietary: ['halal'], others: [], mine: ['halal'], checked: false, dropped: [] })
  })

  it('tells the others’ needs once three have joined, as a list of needs only: no ids, no counts', async () => {
    const t = await start()
    addSession(world, { id: SMALL, status: 'inviting', version: 1 })
    addMember(world, SMALL, HOST, { role: 'host' })
    addMember(world, SMALL, GUEST)
    addMember(world, SMALL, OTHER)
    // The third joined member has a need too, so the union of the others is told but not who has what.
    world.profile_private.find((p) => p.id === OTHER).dietary = ['halal', 'vegetarian']
    const asHost = await t.needs(SMALL, HOST)
    expect(asHost.body).toEqual({ dietary: ['halal', 'vegetarian', 'vegan'], others: ['halal', 'vegetarian'], mine: ['vegan'], checked: false, dropped: [] })
    expect(Object.keys(asHost.body).sort()).toEqual(['checked', 'dietary', 'dropped', 'mine', 'others'])
    const text = JSON.stringify(asHost.body)
    for (const leak of [HOST, GUEST, OTHER, '3', 'count']) expect(text).not.toContain(leak)
  })

  it('counts joined members only: an opted-out member neither adds a need nor makes up the three', async () => {
    const t = await start()
    addSession(world, { id: SMALL, status: 'inviting', version: 1 })
    addMember(world, SMALL, HOST, { role: 'host' })
    addMember(world, SMALL, GUEST)
    addMember(world, SMALL, STRANGER, { state: 'opted_out' })
    world.profile_private.push({ id: STRANGER, dietary: ['vegetarian'], home_area_id: 'bugis', budget_max_per_person: null, needs_step_free: false })
    // Three rows, two joined: the others’ list stays empty, and the opted-out person’s need is in neither list.
    expect((await t.needs(SMALL, HOST)).body).toEqual({ dietary: ['vegan'], others: [], mine: ['vegan'], checked: false, dropped: [] })
  })

  it('answers a member who opted out as it answers a stranger: the same 404, and no private read', async () => {
    const t = await start()
    addSession(world, { id: SMALL, status: 'inviting', version: 1 })
    addMember(world, SMALL, HOST, { role: 'host' })
    addMember(world, SMALL, GUEST)
    addMember(world, SMALL, OTHER, { state: 'opted_out' })
    const res = await t.needs(SMALL, OTHER)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('session_not_found')
    expect(world.calls.some((c) => c.kind === 'rpc')).toBe(false)
  })

  it('reads as the caller first, and the private rows only with the server’s key', async () => {
    const t = await start()
    await t.needs(SESSION, GUEST)
    expect(world.calls.map((c) => [c.table ?? c.rpc, c.kind, c.who])).toEqual([
      ['session_members', 'select', GUEST.toLowerCase()],
      ['session_member_needs', 'rpc', null],
      ['session_member_dietary', 'select', null],
      ['session_dietary_dropped', 'select', null],
    ])
  })

  it('tells a stranger nothing: the same 404 as for a session that does not exist, and no private read', async () => {
    const t = await start()
    const stranger = await t.needs(SESSION, STRANGER)
    expect(stranger.status).toBe(404)
    expect(stranger.body.error).toBe('session_not_found')
    expect((await t.needs('cccccccc-cccc-4ccc-8ccc-cccccccccccc', GUEST)).body.error).toBe('session_not_found')
    expect(world.calls.some((c) => c.kind === 'rpc')).toBe(false)
  })

  it('needs a login and a session id, and fails as a server error when the needs cannot be read', async () => {
    const t = await start()
    expect((await t.needs(SESSION, null)).status).toBe(401)
    const bad = await t.needs('not-a-uuid', GUEST)
    expect(bad.status).toBe(400)
    expect(bad.body.error).toBe('invalid_input')
    world.failNeeds = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await t.needs(SESSION, GUEST)
    expect(failed.status).toBe(500)
    expect(failed.body.error).toBe('server_error')
  })

  it('is limited per person on its own counter, apart from leaving', async () => {
    const t = await start({ sessionRateLimit: { windowMs: 60_000, max: 2 } })
    expect((await t.needs(SESSION, GUEST)).status).toBe(200)
    expect((await t.needs(SESSION, GUEST)).status).toBe(200)
    expect((await t.needs(SESSION, GUEST)).status).toBe(429)
    // Leaving still has its own two.
    expect((await t.remove(SESSION, 'me', GUEST)).status).toBe(200)
  })
})
