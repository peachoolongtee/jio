import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createSupabase } from '../src/db/supabase.js'

// DELETE /api/sessions/:id/members/:userId (leave a session, or the host removes a guest), tested without the network.
// The login check is the real code: the test makes its own signing key, serves the public half the way Supabase does and signs
// its own tokens. The database is a stand-in: two small clients over arrays, one acting as the user (it shows a person only
// the sessions they are in, as the access rules do) and one with the service key (it sees everything and is the only one
// that may delete a member row).
const URL_ = 'https://project.supabase.test'
const FRONTEND = 'http://localhost:5173'
const HOST = '1111111a-1111-4111-8111-11111111111b'
const GUEST = '2222222c-2222-4222-8222-22222222222d'
const OTHER = '3333333e-3333-4333-8333-33333333333f'
const STRANGER = '44444444-4444-4444-8444-444444444444'
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const ENDED = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const STARTED = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd'

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig', key_ops: ['verify'] }

// A login token for a person, signed the way Supabase Auth does.
// How to call: tokenFor(HOST)
function tokenFor(id) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', typ: 'JWT', kid: 'key-1' })
  const body = b64({ iss: `${URL_}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub: id, email: 'x@example.test', iat: now, exp: now + 3600 })
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

// The stand-in database. `world` is reset for each test.
let world
const fresh = () => ({
  sessions: [
    { id: SESSION, host_id: HOST, status: 'inviting', plan_version: 4 },
    { id: ENDED, host_id: HOST, status: 'cancelled', plan_version: 1 },
    { id: STARTED, host_id: HOST, status: 'locating', plan_version: 2 },
  ],
  session_members: [
    { session_id: SESSION, user_id: HOST, role: 'host' },
    { session_id: SESSION, user_id: GUEST, role: 'guest' },
    { session_id: SESSION, user_id: OTHER, role: 'guest' },
    { session_id: ENDED, user_id: HOST, role: 'host' },
    { session_id: ENDED, user_id: GUEST, role: 'guest' },
    { session_id: STARTED, user_id: HOST, role: 'host' },
    { session_id: STARTED, user_id: GUEST, role: 'guest' },
  ],
  calls: [],
  failBump: false,
  failDelete: false,
  // Run just before the server's update of a table, to play another writer that got there first: (tableName, op) => void.
  beforeUpdate: null,
})

// A query builder over one array. `visible(row)` is the access rule for reads; `owner` is who is asking (null: the server).
// How to call: query(world.sessions, 'sessions', (row) => true, null)
function query(rows, name, visible, who) {
  const op = { kind: 'select', filters: [], patch: null, returning: false, single: false }
  const matching = () => rows.filter((r) => visible(r) && op.filters.every(([c, v]) => r[c] === v))
  const run = () => {
    world.calls.push({ table: name, kind: op.kind, who, filters: op.filters.map(([c, v]) => `${c}=${v}`) })
    if (op.kind === 'select') {
      const found = matching()
      if (op.single) return { data: found[0] ?? null, error: null }
      return { data: found, error: null }
    }
    if (who !== null) return { data: null, error: { code: '42501', message: 'permission denied' } }
    if (op.kind === 'delete') {
      if (world.failDelete) return { data: null, error: { code: 'XX000', message: 'boom' } }
      const found = matching()
      for (const row of found) rows.splice(rows.indexOf(row), 1)
      return { data: op.returning ? found : null, error: null }
    }
    if (op.kind === 'update') {
      if (world.failBump && name === 'sessions') return { data: null, error: { code: 'XX000', message: 'boom' } }
      world.beforeUpdate?.(name, op)
      const found = matching()
      for (const row of found) Object.assign(row, op.patch)
      return { data: op.returning ? found : null, error: null }
    }
    return { data: null, error: { message: 'unsupported' } }
  }
  const builder = {
    select() {
      if (op.kind !== 'select') op.returning = true
      return builder
    },
    delete() {
      op.kind = 'delete'
      return builder
    },
    update(patch) {
      op.kind = 'update'
      op.patch = patch
      return builder
    },
    eq(column, value) {
      op.filters.push([column, value])
      return builder
    },
    maybeSingle() {
      op.single = true
      return builder
    },
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  }
  return builder
}

// A client as a person: sees the sessions they host or are in, and the members of those sessions.
// How to call: userClient(GUEST)
function userClient(id) {
  // Postgres compares uuids without regard to case.
  id = id.toLowerCase()
  const inSession = (sessionId) => world.session_members.some((m) => m.session_id === sessionId && m.user_id === id)
  return {
    from(name) {
      if (name === 'sessions') return query(world.sessions, name, (r) => r.host_id === id || inSession(r.id), id)
      if (name === 'session_members') return query(world.session_members, name, (r) => inSession(r.session_id), id)
      throw new Error(`no table ${name}`)
    },
  }
}
const serviceClient = {
  from: (name) => query(world[name], name, () => true, null),
}

const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

// Starts the app with the real login check and the stand-in database. `supabase: false` starts it with no Supabase at all.
// How to call: const t = await start(); await t.remove(SESSION, 'me', GUEST)
async function start({ supabase = true, ...options } = {}) {
  world = fresh()
  const jwks = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/auth/v1/.well-known/jwks.json') return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 404 })
  }
  const real = createSupabase({ url: URL_, anonKey: 'anon-key', serviceKey: 'service-key', fetchImpl: jwks })
  const db = supabase ? { ...real, forUser: (token) => userClient(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub), service: serviceClient } : null
  const server = createApp({ frontendOrigin: FRONTEND, supabase: db, ...options }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  started.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  // Asks to remove `person` ('me' or an id) from `session`, as `as` (a person's id; none sends no token).
  const remove = async (session, person, as) => {
    const res = await fetch(`${base}/api/sessions/${session}/members/${person}`, { method: 'DELETE', headers: as ? { authorization: `Bearer ${tokenFor(as)}` } : {} })
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { base, remove }
}

const memberIds = (session = SESSION) => world.session_members.filter((m) => m.session_id === session).map((m) => m.user_id)
const deletes = () => world.calls.filter((c) => c.kind === 'delete')

describe('DELETE /api/sessions/:id/members/me (leaving)', () => {
  it('lets a guest leave: their row goes, with the server key, and the session version goes up by one', async () => {
    const t = await start()
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ planVersion: 5, left: true })
    expect(memberIds()).toEqual([HOST, OTHER])
    expect(world.sessions.find((s) => s.id === SESSION).plan_version).toBe(5)
    // The reads were made as the guest; only the delete and the version went through the service key.
    expect(world.calls.filter((c) => c.who === GUEST).every((c) => c.kind === 'select')).toBe(true)
    expect(deletes()).toHaveLength(1)
    expect(deletes()[0].who).toBeNull()
    expect(deletes()[0].filters).toEqual([`session_id=${SESSION}`, `user_id=${GUEST}`])
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
    expect(deletes()).toHaveLength(0)
  })

  it('answers 404 for a person who is not in the session, as for a session that does not exist', async () => {
    const t = await start()
    const stranger = await t.remove(SESSION, 'me', STRANGER)
    const missing = await t.remove('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 'me', STRANGER)
    expect(stranger.status).toBe(404)
    expect(stranger.body.error).toBe('session_not_found')
    expect(missing.body).toEqual(stranger.body)
    expect(deletes()).toHaveLength(0)
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

describe('review fixes: the version, the status, and uuid case', () => {
  it('raises the version from what it is when the update lands, so a writer that got there first is never moved backwards', async () => {
    const t = await start()
    // Another server write raises the version between this route's read and its update.
    let played = false
    world.beforeUpdate = (name) => {
      if (name === 'sessions' && !played) {
        played = true
        world.sessions.find((s) => s.id === SESSION).plan_version = 5
      }
    }
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(200)
    expect(world.sessions.find((s) => s.id === SESSION).plan_version).toBe(6)
    expect(res.body.planVersion).toBe(6)
  })

  it('counts two removals at once as two raises', async () => {
    const t = await start()
    const [a, b] = await Promise.all([t.remove(SESSION, 'me', GUEST), t.remove(SESSION, 'me', OTHER)])
    expect([a.status, b.status]).toEqual([200, 200])
    expect(world.sessions.find((s) => s.id === SESSION).plan_version).toBe(6)
  })

  it('gives up after a few tries without failing the request, and says so only in the log', async () => {
    const t = await start()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    world.beforeUpdate = (name) => {
      if (name === 'sessions') world.sessions.find((s) => s.id === SESSION).plan_version += 1
    }
    const res = await t.remove(SESSION, 'me', GUEST)
    expect(res.status).toBe(200)
    expect(res.body.left).toBe(true)
    expect(memberIds()).toEqual([HOST, OTHER])
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('version')
    expect(JSON.stringify(res.body)).not.toContain('boom')
  })

  it('refuses a session that has started, for now: nobody leaves it and nobody is removed, so no vote is left counted', async () => {
    const t = await start()
    const leave = await t.remove(STARTED, 'me', GUEST)
    expect(leave.status).toBe(409)
    expect(leave.body.error).toBe('session_started')
    const remove = await t.remove(STARTED, GUEST, HOST)
    expect(remove.status).toBe(409)
    expect(remove.body.error).toBe('session_started')
    expect(memberIds(STARTED)).toEqual([HOST, GUEST])
    expect(deletes()).toHaveLength(0)
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

  it('still answers success when raising the version fails, and does not hide a failed delete', async () => {
    const t = await start()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    world.failBump = true
    const ok = await t.remove(SESSION, 'me', GUEST)
    expect(ok.status).toBe(200)
    expect(memberIds()).toEqual([HOST, OTHER])
    world.failDelete = true
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const failed = await t.remove(SESSION, 'me', OTHER)
    expect(failed.status).toBe(500)
    expect(failed.body.error).toBe('server_error')
    expect(memberIds()).toEqual([HOST, OTHER])
  })
})
