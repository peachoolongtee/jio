import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createSupabase } from '../src/db/supabase.js'

// Login checks, tested without the network. The test makes its own signing key pair, serves the public
// half the way Supabase does, and signs its own tokens. Nothing here talks to the real project.
const URL_ = 'https://project.supabase.test'
const ANON = 'anon-key-for-tests'
const SERVICE = 'service-key-for-tests'
const FRONTEND = 'http://localhost:5173'
const USER = '6f1c2f0e-1111-4222-8333-444455556666'

const b64 = (value) => Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)).toString('base64url')

// A key pair in the format Supabase publishes (ES256), with the key id tokens point at.
function makeKey(kid) {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' })
  return { kid, privateKey, jwk: { ...publicKey.export({ format: 'jwk' }), kid, alg: 'ES256', use: 'sig', key_ops: ['verify'] } }
}

// Signs a login token the way Supabase Auth does.
//   signToken(key, { sub: USER })              a normal user token, valid for an hour
//   signToken(key, { sub: USER, exp: past })   an expired one
function signToken(key, claims = {}, header = {}) {
  const now = Math.floor(Date.now() / 1000)
  const head = b64({ alg: 'ES256', typ: 'JWT', kid: key.kid, ...header })
  const body = b64({ iss: `${URL_}/auth/v1`, aud: 'authenticated', role: 'authenticated', email: 'ian@example.test', iat: now, exp: now + 3600, ...claims })
  const signature = sign('sha256', Buffer.from(`${head}.${body}`), { key: key.privateKey, dsaEncoding: 'ieee-p1363' })
  return `${head}.${body}.${signature.toString('base64url')}`
}

const realKey = makeKey('key-1')
const otherKey = makeKey('key-1') // Same key id, different key: a forger's.
const calls = [] // Every request the server made to "Supabase".

// A stand-in for Supabase: the public keys, the "who is this token" check, and one profiles query.
async function fakeSupabase(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers))
  calls.push({ path: url.pathname, authorization: headers.get('authorization'), apikey: headers.get('apikey') })
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  if (url.pathname === '/auth/v1/.well-known/jwks.json') return json({ keys: [realKey.jwk] })
  // Tokens the server cannot check locally are sent here. This fake says no to all of them.
  if (url.pathname === '/auth/v1/user') return json({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }, 403)
  if (url.pathname === '/rest/v1/profiles') {
    return json([{ id: USER, username: 'ian', display_name: 'Ian', avatar_url: null, home_area_id: 'woodlands' }])
  }
  return json({ message: `fake Supabase has no ${url.pathname}` }, 404)
}

let server, base
beforeAll(async () => {
  const supabase = createSupabase({ url: URL_, anonKey: ANON, serviceKey: SERVICE, fetchImpl: fakeSupabase })
  server = createApp({ frontendOrigin: FRONTEND, supabase }).listen(0)
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))
beforeEach(() => {
  calls.length = 0
})

const me = async (authorization) => {
  const res = await fetch(`${base}/api/me`, { headers: authorization ? { Authorization: authorization } : {} })
  return { status: res.status, body: await res.json() }
}
const refused = (r) => {
  expect(r.status).toBe(401)
  expect(r.body.error.code).toBe('unauthenticated')
  expect(typeof r.body.error.message).toBe('string')
}

describe('GET /api/me', () => {
  it('answers a valid token with the user and their profile', async () => {
    const r = await me(`Bearer ${signToken(realKey, { sub: USER })}`)
    expect(r.status).toBe(200)
    expect(r.body.user).toEqual({ id: USER, email: 'ian@example.test' })
    expect(r.body.profile.username).toBe('ian')
  })

  it('reads the database as the user, not with the service key', async () => {
    const token = signToken(realKey, { sub: USER })
    await me(`Bearer ${token}`)
    const query = calls.find((c) => c.path === '/rest/v1/profiles')
    expect(query.authorization).toBe(`Bearer ${token}`)
    expect(query.apikey).toBe(ANON)
    expect(calls.some((c) => c.apikey === SERVICE || c.authorization === `Bearer ${SERVICE}`)).toBe(false)
  })

  it('fetches the signing keys once, then checks tokens without the network', async () => {
    for (let i = 0; i < 5; i++) await me(`Bearer ${signToken(realKey, { sub: USER })}`)
    expect(calls.filter((c) => c.path === '/auth/v1/.well-known/jwks.json').length).toBeLessThanOrEqual(1)
    expect(calls.filter((c) => c.path === '/auth/v1/user')).toHaveLength(0)
  })

  it('refuses a request with no token', async () => {
    refused(await me())
    expect(calls).toHaveLength(0)
  })

  it('refuses a header that is not "Bearer <token>"', async () => {
    refused(await me(signToken(realKey, { sub: USER })))
    refused(await me('Basic aWFuOnBhc3N3b3Jk'))
  })

  it('refuses text that is not a token', async () => {
    refused(await me('Bearer not-a-token'))
  })

  it('refuses malformed tokens with a 401, never a 500, and without asking Supabase', async () => {
    // "abc.def.ghi" has the three-part shape but is not base64 JSON. It used to crash the decoder.
    const malformed = [
      'abc.def.ghi',
      `${b64('not json')}.${b64({ sub: USER })}.sig`,
      `${b64({ alg: 'ES256' })}.${b64('[1,2,3]')}.sig`,
      `${b64({ alg: 'ES256' })}.${Buffer.from([0xff, 0xfe, 0xfd]).toString('base64url')}.sig`,
      'a.b.c.d',
      `${'x'.repeat(9000)}.y.z`,
    ]
    for (const token of malformed) refused(await me(`Bearer ${token}`))
    expect(calls).toHaveLength(0)
  })

  it('refuses an expired token', async () => {
    const past = Math.floor(Date.now() / 1000) - 60
    refused(await me(`Bearer ${signToken(realKey, { sub: USER, exp: past })}`))
  })

  it('refuses a token signed with someone else’s key', async () => {
    refused(await me(`Bearer ${signToken(otherKey, { sub: USER })}`))
  })

  it('refuses a token whose contents were changed after signing', async () => {
    const [head, , signature] = signToken(realKey, { sub: USER }).split('.')
    const now = Math.floor(Date.now() / 1000)
    const forged = b64({ sub: 'someone-else', role: 'authenticated', aud: 'authenticated', exp: now + 3600 })
    refused(await me(`Bearer ${head}.${forged}.${signature}`))
  })

  it('refuses a token that names no signing key or uses a shared-secret algorithm', async () => {
    // These cannot be checked locally, so the server asks Supabase, which says no.
    refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { kid: undefined })}`))
    refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { alg: 'HS256' })}`))
    expect(calls.some((c) => c.path === '/auth/v1/user')).toBe(true)
  })

  it('refuses a correctly signed token that is not a person’s', async () => {
    refused(await me(`Bearer ${signToken(realKey, { sub: undefined, role: 'anon' })}`))
    refused(await me(`Bearer ${signToken(realKey, { sub: USER, role: 'service_role' })}`))
  })
})

describe('createSupabase', () => {
  it('needs all three values', () => {
    expect(() => createSupabase({ url: URL_, anonKey: ANON })).toThrow(/SUPABASE_SERVICE_ROLE_KEY/)
    expect(() => createSupabase()).toThrow()
  })
})

describe('without Supabase configured', () => {
  it('does not mount the routes that need a login', async () => {
    const plain = createApp({ frontendOrigin: FRONTEND }).listen(0)
    await once(plain, 'listening')
    const res = await fetch(`http://127.0.0.1:${plain.address().port}/api/me`)
    expect(res.status).toBe(404)
    await new Promise((resolve) => plain.close(resolve))
  })
})
