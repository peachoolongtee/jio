import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createSupabase } from '../src/db/supabase.js'
import { prefixPattern } from '../src/routes/people.js'

// GET /api/people/search?q= (find a person to invite by the start of their username), tested without the network.
// The login check is the real code (the test signs its own tokens). The database is a stand-in: one client acting as the user,
// which shows a person only the members of the sessions they are in, and one with the service key, which sees every profile.
// The stand-in reads LIKE patterns the way Postgres does (`%`, `_` and a backslash escape), so the escaping is really tested.
const URL_ = 'https://project.supabase.test'
const FRONTEND = 'http://localhost:5173'
const ME = '1111111a-1111-4111-8111-11111111111b'
const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'key-1', alg: 'ES256', use: 'sig', key_ops: ['verify'] }

// A login token for a person, signed the way Supabase Auth does. How to call: tokenFor(ME)
function tokenFor(sub) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', typ: 'JWT', kid: 'key-1' })
  const body = b64({ iss: `${URL_}/auth/v1`, aud: 'authenticated', role: 'authenticated', sub, email: 'x@example.test', iat: now, exp: now + 3600 })
  return `${head}.${body}.${sign('sha256', Buffer.from(`${head}.${body}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`
}

// A profile with columns a search must never hand out.
const profile = (n, username, extra = {}) => ({
  id: id(n),
  username,
  display_name: username[0].toUpperCase() + username.slice(1),
  avatar_url: null,
  dob: '2000-01-01',
  email: `${username}@example.test`,
  ...extra,
})

let world
const fresh = () => ({
  profiles: [
    { ...profile(0, 'ian_pong'), id: ME },
    profile(1, 'sam'),
    profile(2, 'sam_tan'),
    profile(3, 'samuel'),
    profile(4, 'samx'),
    profile(5, 'sammy', { display_name: '  ', avatar_url: 'https://cdn.example.test/a.png' }),
    profile(6, 'sam_lee'),
    profile(7, 'sam_woo'),
    profile(8, 'sam_yeo'),
    profile(9, 'sam_zed'),
    profile(10, 'kim_2'),
    profile(11, 'ian_poh'),
    profile(12, 'Zoe_Q'.toLowerCase()),
  ],
  // Who is in which session. ME shares session s1 with sam_zed (9) and kim_2 (10), and s2 with sam_woo (7).
  session_members: [
    { session_id: 's1', user_id: ME },
    { session_id: 's1', user_id: id(9) },
    { session_id: 's1', user_id: id(10) },
    { session_id: 's2', user_id: ME },
    { session_id: 's2', user_id: id(7) },
    { session_id: 's3', user_id: id(1) },
    { session_id: 's3', user_id: id(2) },
  ],
  calls: [],
  fail: null,
  memberCap: 1000,
})

// LIKE, as Postgres reads it with the default escape character: `\x` is the character x, `%` any run, `_` any one character.
// How to call: likeToRegExp('sam\\_%') -> /^sam_.*$/s
function likeToRegExp(pattern) {
  let out = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]
    if (c === '\\') out += `${(pattern[(i += 1)] ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`
    else if (c === '%') out += '.*'
    else if (c === '_') out += '.'
    else out += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  }
  return new RegExp(`^${out}$`, 's')
}

// A query builder over one array, keeping a record of every call. `visible` is the access rule; `who` is who is asking.
// How to call: query('profiles', () => true, null)
// `cap` is the most rows a read returns whatever it asks for, as the API's own row cap does (about 1000 on Supabase).
function query(name, visible, who, cap = Infinity) {
  const op = { columns: '*', filters: [], order: null, limit: cap, single: false }
  const run = () => {
    world.calls.push({ table: name, who, columns: op.columns, filters: op.filters.map(([kind, c, v]) => `${kind}:${c}=${v}`), limit: op.limit })
    if (world.fail === name) return { data: null, error: { code: 'XX000', message: 'boom' } }
    let rows = world[name].filter((r) => visible(r))
    for (const [kind, column, value] of op.filters) {
      if (kind === 'eq') rows = rows.filter((r) => r[column] === value)
      if (kind === 'neq') rows = rows.filter((r) => r[column] !== value)
      if (kind === 'in') rows = rows.filter((r) => value.includes(r[column]))
      if (kind === 'like') rows = rows.filter((r) => likeToRegExp(value).test(r[column]))
    }
    if (op.order) rows = [...rows].sort((a, b) => (a[op.order] < b[op.order] ? -1 : a[op.order] > b[op.order] ? 1 : 0))
    rows = rows.slice(0, Math.min(op.limit, cap))
    const project = (r) => (op.columns === '*' ? r : Object.fromEntries(op.columns.split(',').map((c) => c.trim()).map((c) => [c, r[c]])))
    rows = rows.map(project)
    return op.single ? { data: rows[0] ?? null, error: null } : { data: rows, error: null }
  }
  const builder = {
    select(columns = '*') {
      op.columns = columns
      return builder
    },
    eq: (c, v) => (op.filters.push(['eq', c, v]), builder),
    neq: (c, v) => (op.filters.push(['neq', c, v]), builder),
    in: (c, v) => (op.filters.push(['in', c, v]), builder),
    like: (c, v) => (op.filters.push(['like', c, v]), builder),
    order: (c) => ((op.order = c), builder),
    limit: (n) => ((op.limit = n), builder),
    maybeSingle: () => ((op.single = true), builder),
    then: (resolve, reject) => Promise.resolve().then(run).then(resolve, reject),
  }
  return builder
}

// A person's own client: the members of the sessions they are in, and no profiles at all (so a search that read profiles as the
// caller would find nobody).
function userClient(sub) {
  const mine = () => world.session_members.filter((m) => m.user_id === sub.toLowerCase()).map((m) => m.session_id)
  return {
    from(name) {
      if (name === 'session_members') return query(name, (r) => mine().includes(r.session_id), sub, world.memberCap)
      throw new Error(`the user's client was asked for ${name}`)
    },
  }
}
const serviceClient = { from: (name) => query(name, () => true, null) }

const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

// Starts the app with the real login check and the stand-in database. `supabase: false` starts it with no Supabase at all.
// How to call: const t = await start(); const res = await t.search('sam', ME)
async function start({ supabase = true, ...options } = {}) {
  world = fresh()
  const jwks = async (input) => {
    const url = new URL(typeof input === 'string' ? input : input.url)
    if (url.pathname === '/auth/v1/.well-known/jwks.json') return new Response(JSON.stringify({ keys: [jwk] }), { status: 200, headers: { 'content-type': 'application/json' } })
    return new Response('{}', { status: 404 })
  }
  const real = createSupabase({ url: URL_, anonKey: 'anon-key', serviceKey: 'service-key', fetchImpl: jwks })
  const db = supabase ? { ...real, forUser: (token) => userClient(JSON.parse(Buffer.from(token.split('.')[1], 'base64url')).sub), service: serviceClient } : null
  const server = createApp({ frontendOrigin: FRONTEND, supabase: db, ...options }).listen(0)
  await once(server, 'listening')
  started.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  // Asks for `q` (as sent, so it is encoded here), as `as` (a person's id; none sends no token).
  const search = async (q, as, { raw = null } = {}) => {
    const url = raw ?? `${base}/api/people/search?q=${encodeURIComponent(q)}`
    const res = await fetch(url, { headers: as ? { authorization: `Bearer ${tokenFor(as)}` } : {} })
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { base, search }
}

const usernames = (res) => res.body.people.map((p) => p.username)

describe('GET /api/people/search', () => {
  it('matches the start of a username, not the middle and not a display name', async () => {
    const t = await start()
    expect(usernames(await t.search('sam_t', ME))).toEqual(['sam_tan'])
    expect(usernames(await t.search('tan', ME))).toEqual([])
    expect(usernames(await t.search('poh', ME))).toEqual([])
    // A person whose display name differs from the username is not found by the name.
    world.profiles.push(profile(20, 'qwerty', { display_name: 'Marigold' }))
    expect(usernames(await t.search('mar', ME))).toEqual([])
    expect(usernames(await t.search('qwe', ME))).toEqual(['qwerty'])
  })

  it('ignores the case of what was typed and trims it', async () => {
    const t = await start()
    expect(usernames(await t.search('  KIM  ', ME))).toEqual(['kim_2'])
    expect(usernames(await t.search('Zoe_', ME))).toEqual(['zoe_q'])
  })

  it('treats an underscore as a plain character: "sam_" does not match "samx" or "samuel"', async () => {
    const t = await start()
    const found = usernames(await t.search('sam_', ME))
    expect(found).not.toContain('samx')
    expect(found).not.toContain('samuel')
    expect(found).not.toContain('sammy')
    expect(found.every((name) => name.startsWith('sam_'))).toBe(true)
    // The pattern the database was given has the underscore escaped.
    const asked = world.calls.filter((c) => c.table === 'profiles').flatMap((c) => c.filters).filter((f) => f.startsWith('like:'))
    expect(asked.length).toBeGreaterThan(0)
    expect(asked.every((f) => f === 'like:username=sam\\_%')).toBe(true)
    expect(world.calls.some((c) => c.filters.some((f) => f.startsWith('ilike:')))).toBe(false)
  })

  it('escapes %, _ and a backslash in the pattern', () => {
    expect(prefixPattern('sam_')).toBe('sam\\_%')
    expect(prefixPattern('a%b')).toBe('a\\%b%')
    expect(prefixPattern('a\\b')).toBe('a\\\\b%')
    expect(prefixPattern('abc')).toBe('abc%')
  })

  it('needs 3 characters, at most 20, from the username alphabet; anything else is 400 invalid_input', async () => {
    const t = await start()
    for (const q of ['', 'sa', ' s ', 'a'.repeat(21), 'sam%', 'sam tan', 'sam.tan', '%%%', 'sam\\', '@sam', 'sàm']) {
      const res = await t.search(q, ME)
      expect(res.status, JSON.stringify(q)).toBe(400)
      expect(res.body.error).toBe('invalid_input')
      expect(typeof res.body.message).toBe('string')
    }
    expect((await t.search('a'.repeat(20), ME)).status).toBe(200)
    expect((await t.search('sam', ME)).status).toBe(200)
    // No q at all, and q twice.
    expect((await t.search('', ME, { raw: `${t.base}/api/people/search` })).status).toBe(400)
    expect((await t.search('', ME, { raw: `${t.base}/api/people/search?q=sam&q=kim` })).status).toBe(400)
    // A refused search never reaches the database.
    world.calls.length = 0
    await t.search('sa', ME)
    expect(world.calls).toEqual([])
  })

  it('answers at most 5 people, and asks the database for no more than 50 matches', async () => {
    const t = await start()
    const res = await t.search('sam', ME)
    expect(res.body.people).toHaveLength(5)
    const lists = world.calls.filter((c) => c.table === 'profiles' && c.filters.some((f) => f.startsWith('like:')))
    expect(lists.length).toBeGreaterThan(0)
    expect(lists.every((c) => c.limit <= 50)).toBe(true)
  })

  it('puts the exact match first, then people met before, then the rest by username', async () => {
    const t = await start()
    // "sam" is a username, and also the start of many. sam_woo and sam_zed share a session with the caller.
    expect(usernames(await t.search('sam', ME))).toEqual(['sam', 'sam_woo', 'sam_zed', 'sam_lee', 'sam_tan'])
    // Without an exact match: met before, then alphabetical.
    expect(usernames(await t.search('sam_', ME))).toEqual(['sam_woo', 'sam_zed', 'sam_lee', 'sam_tan', 'sam_yeo'])
  })

  it('finds a person met before even when five others come first by name', async () => {
    const t = await start()
    world.session_members.push({ session_id: 's2', user_id: id(21) })
    world.profiles.push(profile(21, 'samzzz'))
    const res = await t.search('sam', ME)
    expect(usernames(res).slice(0, 4)).toEqual(['sam', 'sam_woo', 'sam_zed', 'samzzz'])
    expect(res.body.people.find((p) => p.username === 'samzzz').metBefore).toBe(true)
  })

  it('marks who the caller has met, and nobody else', async () => {
    const t = await start()
    const res = await t.search('sam', ME)
    const met = Object.fromEntries(res.body.people.map((p) => [p.username, p.metBefore]))
    expect(met).toEqual({ sam: false, sam_woo: true, sam_zed: true, sam_lee: false, sam_tan: false })
    // Sam and Sam Tan share a session with each other (s3), but not with the caller.
    expect(met.sam_tan).toBe(false)
  })

  it('reads who has been met as the caller, so the database\'s rules decide', async () => {
    const t = await start()
    await t.search('sam', ME)
    const asUser = world.calls.filter((c) => c.who === ME)
    expect(asUser).toHaveLength(1)
    expect(asUser.every((c) => c.table === 'session_members' && c.columns === 'user_id')).toBe(true)
    // Only about the people the matches found, never the caller's whole list of co-members.
    expect(asUser[0].filters).toHaveLength(1)
    expect(asUser[0].filters[0]).toMatch(/^in:user_id=/)
    expect(asUser[0].filters[0]).toContain(id(9))
    expect(world.calls.filter((c) => c.table === 'profiles').every((c) => c.who === null)).toBe(true)
  })

  it('never lists the caller, even by their exact username or as met before', async () => {
    const t = await start()
    expect(usernames(await t.search('ian_pong', ME))).toEqual([])
    expect(usernames(await t.search('ian_', ME))).toEqual(['ian_poh'])
    expect(usernames(await t.search('ian_', id(11)))).toEqual(['ian_pong'])
  })

  it('compares ids without regard to the case of their letters', async () => {
    const t = await start()
    const res = await t.search('ian_p', ME.toUpperCase())
    expect(res.status).toBe(200)
    expect(usernames(res)).not.toContain('ian_pong')
  })

  it('answers only the public columns, with nothing private in the answer or in the request', async () => {
    const t = await start()
    const res = await t.search('sam', ME)
    for (const person of res.body.people) {
      expect(Object.keys(person).sort()).toEqual(['avatarUrl', 'id', 'metBefore', 'name', 'username'])
    }
    expect(JSON.stringify(res.body)).not.toMatch(/dob|email|example\.test\/?$|2000-01-01|@example/)
    const columns = world.calls.filter((c) => c.table === 'profiles').map((c) => c.columns)
    expect(columns.length).toBeGreaterThan(0)
    expect(columns.every((c) => c === 'id, username, display_name, avatar_url')).toBe(true)
  })

  it('shows the username when there is no display name, and the photo address when there is one', async () => {
    const t = await start()
    const res = await t.search('sammy', ME)
    expect(res.body.people).toEqual([{ id: id(5), name: 'sammy', username: 'sammy', avatarUrl: 'https://cdn.example.test/a.png', metBefore: false }])
    const named = await t.search('kim', ME)
    expect(named.body.people).toEqual([{ id: id(10), name: 'Kim_2', username: 'kim_2', avatarUrl: '', metBefore: true }])
  })

  it('answers an empty list when nobody matches', async () => {
    const t = await start()
    const res = await t.search('nobody', ME)
    expect(res.status).toBe(200)
    expect(res.body).toEqual({ people: [] })
  })

  it('answers 401 without a token, and with one that is not valid', async () => {
    const t = await start()
    const none = await t.search('sam')
    expect(none.status).toBe(401)
    expect(none.body.error).toBe('unauthenticated')
    expect(world.calls).toEqual([])
    const bad = await fetch(`${t.base}/api/people/search?q=sam`, { headers: { authorization: 'Bearer not.a.token' } })
    expect(bad.status).toBe(401)
    expect((await bad.json()).error).toBe('unauthenticated')
    expect(world.calls).toEqual([])
  })

  it('answers 500 in the flat shape when the database fails, without its words', async () => {
    const t = await start()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    world.fail = 'profiles'
    const res = await t.search('sam', ME)
    expect(res.status).toBe(500)
    expect(res.body.error).toBe('server_error')
    expect(JSON.stringify(res.body)).not.toContain('boom')
  })

  it('still answers when the read of who has been met fails: in username order, nobody marked, and it says so in the log', async () => {
    const t = await start()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    world.fail = 'session_members'
    const res = await t.search('sam', ME)
    expect(res.status).toBe(200)
    expect(usernames(res)).toEqual(['sam', 'sam_lee', 'sam_tan', 'sam_woo', 'sam_yeo'])
    expect(res.body.people.every((p) => p.metBefore === false)).toBe(true)
    expect(warn).toHaveBeenCalledTimes(1)
    expect(String(warn.mock.calls[0][0])).toContain('XX000')
    expect(String(warn.mock.calls[0][0])).not.toContain('boom')
  })

  it('still ranks a person met before first when the caller shares sessions with more people than a read returns', async () => {
    const t = await start()
    // 1,200 co-members come first in the table; the caller's read returns 1,000 rows at most, whatever it asks for.
    const crowd = Array.from({ length: 1200 }, (_, n) => ({ session_id: 's9', user_id: id(1000 + n) }))
    world.session_members.unshift({ session_id: 's9', user_id: ME }, ...crowd)
    const res = await t.search('sam_', ME)
    expect(usernames(res).slice(0, 2)).toEqual(['sam_woo', 'sam_zed'])
    expect(res.body.people.slice(0, 2).every((p) => p.metBefore)).toBe(true)
  })

  it('marks every answer no-store: the list, a bad q, no token and over the limit', async () => {
    const t = await start({ peopleSearchRateLimit: { windowMs: 60_000, max: 2 } })
    const ok = await t.search('sam', ME)
    const bad = await t.search('sa', ME)
    const none = await t.search('sam')
    const over = await t.search('sam', ME)
    expect([ok.status, bad.status, none.status, over.status]).toEqual([200, 400, 401, 429])
    for (const res of [ok, bad, none, over]) expect(res.headers.get('cache-control')).toBe('no-store')
  })

  it('limits each caller, with the flat 429 and Retry-After', async () => {
    const t = await start({ peopleSearchRateLimit: { windowMs: 60_000, max: 2 } })
    expect((await t.search('sam', ME)).status).toBe(200)
    expect((await t.search('sam', ME)).status).toBe(200)
    const third = await t.search('sam', ME)
    expect(third.status).toBe(429)
    expect(third.body.error).toBe('rate_limited')
    expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)
    // Another person has their own count.
    expect((await t.search('sam', id(11))).status).toBe(200)
  })

  it('does not exist without Supabase: an unknown address', async () => {
    const t = await start({ supabase: false })
    const res = await t.search('sam', ME)
    expect(res.status).toBe(404)
    expect(res.body.error).toBe('not_found')
  })
})
