import { generateKeyPairSync, sign } from 'node:crypto'
import { once } from 'node:events'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { AuthUnavailableError, createSupabase } from '../src/db/supabase.js'

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

// The columns the live profiles table really has. home_area_id lives in profile_private, not here.
const PROFILE_ROW = { id: USER, username: 'ian', display_name: 'Ian', avatar_url: null, created_at: '2026-10-09T00:00:00Z' }

const realKey = makeKey('key-1')
const otherKey = makeKey('key-1') // Same key id, different key: a forger's.
const calls = [] // Every request the server made to "Supabase".
const newKey = makeKey('key-2') // Served only after a rotation.

// What the fake does next. Tests change it to simulate an outage, a hang or a key rotation.
//   jwks: 'ok' | 'throw' | '503' | 'hang'     the key list
//   user: 'forbidden' | 'ok' | 'throw'        the "who is this token" check
//   keys: the public keys served;  delayMs: how long the key list takes to answer
const fresh = () => ({ jwks: 'ok', user: 'forbidden', keys: [realKey.jwk], delayMs: 0 })
let behaviour = fresh()

// A stand-in for Supabase: the public keys, the "who is this token" check, and one profiles query.
async function fakeSupabase(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers))
  calls.push({ path: url.pathname, search: url.search, authorization: headers.get('authorization'), apikey: headers.get('apikey') })
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })

  if (url.pathname === '/auth/v1/.well-known/jwks.json') {
    if (behaviour.jwks === 'throw') throw new TypeError('fetch failed')
    if (behaviour.jwks === 'hang') return new Promise(() => {}) // Never answers, and ignores the abort signal.
    if (behaviour.jwks === '503') return json({ message: 'unavailable' }, 503)
    if (behaviour.delayMs) await new Promise((resolve) => setTimeout(resolve, behaviour.delayMs))
    return json({ keys: behaviour.keys })
  }
  // Tokens the server cannot check locally are sent here. This fake says no to all of them.
  if (url.pathname === '/auth/v1/user') {
    if (behaviour.user === 'throw') throw new TypeError('fetch failed')
    if (behaviour.user === 'ok') return json({ id: USER, aud: 'authenticated', role: 'authenticated', email: 'ian@example.test' })
    return json({ code: 403, error_code: 'bad_jwt', msg: 'invalid JWT' }, 403)
  }
  if (url.pathname === '/rest/v1/profiles') {
    // Answers as PostgREST does: asking for a column the table lacks is an error, not a null.
    const wanted = (url.searchParams.get('select') ?? '*').split(',').map((c) => c.trim())
    const unknown = wanted.find((c) => c !== '*' && !(c in PROFILE_ROW))
    if (unknown) return json({ code: '42703', message: `column profiles.${unknown} does not exist` }, 400)
    const columns = wanted.includes('*') ? Object.keys(PROFILE_ROW) : wanted
    return json([Object.fromEntries(columns.map((c) => [c, PROFILE_ROW[c]]))])
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
  behaviour = fresh()
})

// Servers started by a test for itself, closed afterwards. Each has its own createSupabase, so its key cache
// starts empty and its clock is the test's own.
const started = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

// Starts a fresh app with a cold key cache and a clock the test controls.
//   const t = await start({ allowLegacyTokens: true })
//   await me(`Bearer ${token}`, t.base)
//   t.clock.ms += 61_000       // Move time forward.
async function start(options = {}) {
  const clock = { ms: Date.now() }
  const supabase = createSupabase({
    url: URL_,
    anonKey: ANON,
    serviceKey: SERVICE,
    fetchImpl: fakeSupabase,
    now: () => clock.ms,
    ...options,
  })
  const own = createApp({ frontendOrigin: FRONTEND, supabase }).listen(0)
  await once(own, 'listening')
  started.push(own)
  return { clock, base: `http://127.0.0.1:${own.address().port}` }
}
const jwksCalls = () => calls.filter((c) => c.path === '/auth/v1/.well-known/jwks.json').length
const userCalls = () => calls.filter((c) => c.path === '/auth/v1/user').length

const me = async (authorization, target = base) => {
  const res = await fetch(`${target}/api/me`, { headers: authorization ? { Authorization: authorization } : {} })
  return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after') }
}
const refused = (r) => {
  expect(r.status).toBe(401)
  expect(r.body.error).toBe('unauthenticated')
  expect(typeof r.body.message).toBe('string')
}

describe('GET /api/me', () => {
  it('answers a valid token with the user and their profile', async () => {
    const r = await me(`Bearer ${signToken(realKey, { sub: USER })}`)
    expect(r.status).toBe(200)
    expect(r.body.user).toEqual({ id: USER, email: 'ian@example.test' })
    expect(r.body.profile.username).toBe('ian')
  })

  it('asks the profiles table only for columns it has', async () => {
    const r = await me(`Bearer ${signToken(realKey, { sub: USER })}`)
    expect(r.status).toBe(200)
    expect(r.body.profile).toEqual({ id: USER, username: 'ian', display_name: 'Ian', avatar_url: null })
    const query = calls.find((c) => c.path === '/rest/v1/profiles')
    const asked = new URLSearchParams(query.search).get('select').split(',').map((c) => c.trim())
    for (const column of asked) expect(Object.keys(PROFILE_ROW)).toContain(column)
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

  it('refuses a token that names no signing key or uses a shared-secret algorithm, without asking Supabase', async () => {
    // These cannot be checked with the held keys. Legacy tokens are off by default, so nobody is asked.
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { kid: undefined })}`))
    refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { alg: 'HS256' })}`))
    expect(userCalls()).toBe(0)
  })

  it('refuses a correctly signed token that is not a person’s', async () => {
    refused(await me(`Bearer ${signToken(realKey, { sub: undefined, role: 'anon' })}`))
    refused(await me(`Bearer ${signToken(realKey, { sub: USER, role: 'service_role' })}`))
  })
})

describe('bad algorithms', () => {
  it.each([
    ['none', 'none'],
    ['a number', 123],
    ['RS256 on an ES256 key', 'RS256'],
  ])('answers 401, not 500, for alg %s, and logs nothing as an error', async (_label, alg) => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const t = await start()
    const r = await me(`Bearer ${signToken(realKey, { sub: USER }, { alg })}`, t.base)
    refused(r)
    expect(errorLog).not.toHaveBeenCalled()
    if (alg !== 'RS256') expect(calls).toHaveLength(0)
    else expect(userCalls()).toBe(0)
  })
})

describe('when Supabase cannot be reached', () => {
  const expectUnavailable = (r) => {
    expect(r.status).toBe(503)
    expect(r.body).toEqual({
      error: 'auth_unavailable',
      message: 'Login cannot be checked right now. Try again shortly.',
    })
    expect(r.retryAfter).toBe('5')
  }

  it('answers 503 when the key list request throws and no keys are held', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    behaviour.jwks = 'throw'
    const t = await start()
    expectUnavailable(await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base))
    expect(jwksCalls()).toBe(1)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('answers 503 when Supabase answers 503 to the key list and no keys are held', async () => {
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    behaviour.jwks = '503'
    const t = await start()
    expectUnavailable(await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base))
    expect(jwksCalls()).toBe(1)
    expect(errorLog).not.toHaveBeenCalled()
  })

  it('gives up on a key list request that never answers, within the timeout', async () => {
    behaviour.jwks = 'hang'
    const t = await start({ timeoutMs: 50 })
    const started = performance.now()
    expectUnavailable(await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base))
    expect(performance.now() - started).toBeLessThan(2000)
    expect(jwksCalls()).toBe(1)
  })

  it('keeps using the held keys when a refresh fails', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await start()
    expect((await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)).status).toBe(200)
    expect(jwksCalls()).toBe(1)

    behaviour.jwks = 'throw'
    t.clock.ms += 11 * 60 * 1000
    const r = await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)
    expect(r.status).toBe(200)
    expect(r.body.user.id).toBe(USER)
    expect(jwksCalls()).toBe(2) // The failed refresh.
  })

  it('refreshes the keys after 10 minutes when Supabase is fine', async () => {
    const t = await start()
    await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)
    t.clock.ms += 9 * 60 * 1000
    await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)
    expect(jwksCalls()).toBe(1)
    t.clock.ms += 2 * 60 * 1000
    expect((await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)).status).toBe(200)
    expect(jwksCalls()).toBe(2)
  })

  describe('key refresh during an outage', () => {
    const MINUTE = 60 * 1000
    const token = () => `Bearer ${signToken(realKey, { sub: USER })}`
    // A server that holds keys fetched at the start, with the clock already past the 10-minute mark.
    const holdingStaleKeys = async (options) => {
      const t = await start(options)
      expect((await me(token(), t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(1)
      t.clock.ms += 11 * MINUTE
      return t
    }

    it('tries once, then leaves a failing Supabase alone for a minute while the held keys keep working', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = await holdingStaleKeys()
      behaviour.jwks = 'throw'
      expect((await me(token(), t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(2)

      t.clock.ms += 59 * 1000
      expect((await me(token(), t.base)).status).toBe(200)
      expect((await me(token(), t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(2)
    })

    it('refreshes again after the minute, and then accepts tokens signed with a new key id', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = await holdingStaleKeys()
      behaviour.jwks = 'throw'
      await me(token(), t.base)
      expect(jwksCalls()).toBe(2)

      behaviour.jwks = 'ok'
      behaviour.keys = [realKey.jwk, newKey.jwk]
      t.clock.ms += 61 * 1000
      expect((await me(`Bearer ${signToken(newKey, { sub: USER })}`, t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(3)
      expect((await me(`Bearer ${signToken(newKey, { sub: USER })}`, t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(3)
    })

    it.each([
      ['a non-OK answer', () => { behaviour.jwks = '503' }],
      ['an empty key list', () => { behaviour.keys = [] }],
    ])('keeps the held keys when the refresh gets %s', async (_label, breakJwks) => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = await holdingStaleKeys()
      breakJwks()
      expect((await me(token(), t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(2)
      expect((await me(token(), t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(2)
    })

    it('answers 503 on a cold cache, then answers at once for 5 seconds without asking again', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      behaviour.jwks = 'throw'
      const t = await start()
      expectUnavailable(await me(token(), t.base))
      expect(jwksCalls()).toBe(1)

      t.clock.ms += 4 * 1000
      expectUnavailable(await me(token(), t.base))
      expect(jwksCalls()).toBe(1)

      behaviour.jwks = 'ok'
      t.clock.ms += 2 * 1000
      expect((await me(token(), t.base)).status).toBe(200)
      expect(jwksCalls()).toBe(2)
    })

    it('stops trusting keys that are more than 24 hours old when Supabase keeps failing', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = await holdingStaleKeys()
      behaviour.jwks = 'throw'
      t.clock.ms += 23 * 60 * MINUTE
      expect((await me(token(), t.base)).status).toBe(200) // 23 h 11 min old: still trusted.

      t.clock.ms += 2 * 60 * MINUTE
      expectUnavailable(await me(token(), t.base))
    })

    it('warns once per outage without the token, and again only after a refresh has worked', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = await holdingStaleKeys()
      const bearer = token()
      behaviour.jwks = 'throw'
      for (let i = 0; i < 3; i++) {
        await me(bearer, t.base)
        t.clock.ms += 61 * 1000
      }
      expect(jwksCalls()).toBe(4)
      expect(warn).toHaveBeenCalledTimes(1)
      expect(String(warn.mock.calls[0][0])).not.toContain(bearer.split('.')[1])

      behaviour.jwks = 'ok'
      await me(bearer, t.base)
      expect(warn).toHaveBeenCalledTimes(1)

      behaviour.jwks = 'throw'
      t.clock.ms += 11 * MINUTE
      await me(bearer, t.base)
      expect(warn).toHaveBeenCalledTimes(2)
    })

    it('still shares one refresh between concurrent requests', async () => {
      vi.spyOn(console, 'warn').mockImplementation(() => {})
      const t = await holdingStaleKeys()
      behaviour.jwks = 'ok'
      behaviour.delayMs = 100
      const results = await Promise.all(Array.from({ length: 8 }, () => me(token(), t.base)))
      expect(results.map((r) => r.status)).toEqual(Array(8).fill(200))
      expect(jwksCalls()).toBe(2)
    })
  })

  it('answers 200 for a legacy token that Supabase accepts, when legacy tokens are allowed', async () => {
    behaviour.user = 'ok'
    const t = await start({ allowLegacyTokens: true })
    const r = await me(`Bearer ${signToken(realKey, { sub: USER }, { alg: 'HS256' })}`, t.base)
    expect(r.status).toBe(200)
    expect(r.body.user).toEqual({ id: USER, email: 'ian@example.test' })
    expect(userCalls()).toBe(1)
    expect(jwksCalls()).toBe(0)
  })

  it('answers 503 when a legacy token cannot be checked because Supabase is down', async () => {
    behaviour.user = 'throw'
    const t = await start({ allowLegacyTokens: true })
    expectUnavailable(await me(`Bearer ${signToken(realKey, { sub: USER }, { alg: 'HS256' })}`, t.base))
    expect(userCalls()).toBe(1)
  })

  it('exports an error class with a stable name', () => {
    const err = new AuthUnavailableError()
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('AuthUnavailableError')
  })
})

describe('tokens that must not cost an outbound request each', () => {
  it('asks at most once for 20 tokens naming different unknown key ids, then once more a minute later', async () => {
    const t = await start()
    for (let i = 0; i < 20; i++) {
      refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { kid: `unknown-${i}` })}`, t.base))
    }
    expect(calls.length).toBeLessThanOrEqual(1)
    expect(userCalls()).toBe(0)

    calls.length = 0
    t.clock.ms += 61 * 1000
    refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { kid: 'unknown-later' })}`, t.base))
    expect(calls).toHaveLength(1)
    expect(jwksCalls()).toBe(1)
  })

  it('makes no request for 20 tokens with no key id', async () => {
    const t = await start()
    for (let i = 0; i < 20; i++) refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { kid: undefined })}`, t.base))
    expect(calls).toHaveLength(0)
  })

  it('makes no request for 20 HS256 tokens, and warns once without the token', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await start()
    let token
    for (let i = 0; i < 20; i++) {
      token = signToken(realKey, { sub: USER }, { alg: 'HS256' })
      refused(await me(`Bearer ${token}`, t.base))
    }
    expect(calls).toHaveLength(0)
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain('SUPABASE_ALLOW_LEGACY_TOKENS=1')
    expect(message).not.toContain(token.split('.')[0])
  })

  it('asks Supabase about an HS256 token when legacy tokens are allowed, and takes its refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await start({ allowLegacyTokens: true })
    refused(await me(`Bearer ${signToken(realKey, { sub: USER }, { alg: 'HS256' })}`, t.base))
    expect(userCalls()).toBe(1)
    expect(jwksCalls()).toBe(0)
    expect(warn).not.toHaveBeenCalled()
  })
})

describe('signing key changes', () => {
  it('refuses a token signed with a new key until the minute is up, then accepts it', async () => {
    const t = await start()
    expect((await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)).status).toBe(200)
    expect(jwksCalls()).toBe(1)

    behaviour.keys = [realKey.jwk, newKey.jwk]
    const rotated = `Bearer ${signToken(newKey, { sub: USER })}`
    refused(await me(rotated, t.base))
    expect(jwksCalls()).toBe(1)

    t.clock.ms += 61 * 1000
    expect((await me(rotated, t.base)).status).toBe(200)
    expect(jwksCalls()).toBe(2)
  })
})

describe('what the claims must say', () => {
  it('refuses a validly signed token issued for a different project', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await start()
    refused(await me(`Bearer ${signToken(realKey, { sub: USER, iss: 'https://other.supabase.test/auth/v1' })}`, t.base))
    refused(await me(`Bearer ${signToken(realKey, { sub: USER, iss: undefined })}`, t.base))
  })

  it('warns once, naming both issuers and no token, when the issuer is not the expected one', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const t = await start()
    const token = signToken(realKey, { sub: USER, iss: 'https://other.supabase.test/auth/v1' })
    refused(await me(`Bearer ${token}`, t.base))
    refused(await me(`Bearer ${signToken(realKey, { sub: USER, iss: 'https://third.supabase.test/auth/v1' })}`, t.base))
    expect(warn).toHaveBeenCalledTimes(1)
    const message = String(warn.mock.calls[0][0])
    expect(message).toContain(`${URL_}/auth/v1`)
    expect(message).toContain('https://other.supabase.test/auth/v1')
    for (const part of token.split('.')) expect(message).not.toContain(part)
  })

  it('accepts an issuer when the configured URL ends in a slash', async () => {
    const t = await start({ url: `${URL_}/` })
    expect((await me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)).status).toBe(200)
  })

  it('refuses an anonymous sign-in, unless anonymous users are allowed', async () => {
    const token = `Bearer ${signToken(realKey, { sub: USER, is_anonymous: true })}`
    const strict = await start()
    refused(await me(token, strict.base))
    const open = await start({ allowAnonymous: true })
    expect((await me(token, open.base)).status).toBe(200)
  })

  it('refuses a token whose subject is not a non-empty string', async () => {
    const t = await start()
    refused(await me(`Bearer ${signToken(realKey, { sub: '' })}`, t.base))
    refused(await me(`Bearer ${signToken(realKey, { sub: 42 })}`, t.base))
  })
})

describe('concurrent requests', () => {
  it('share one key list request on a cold cache', async () => {
    behaviour.delayMs = 100
    const t = await start()
    const results = await Promise.all(
      Array.from({ length: 10 }, () => me(`Bearer ${signToken(realKey, { sub: USER })}`, t.base)),
    )
    expect(results.map((r) => r.status)).toEqual(Array(10).fill(200))
    expect(jwksCalls()).toBe(1)
  })

  it('keep two users apart', async () => {
    const other = '9a8b7c6d-1111-4222-8333-999988887777'
    const tokenA = signToken(realKey, { sub: USER, email: 'a@example.test' })
    const tokenB = signToken(realKey, { sub: other, email: 'b@example.test' })
    const t = await start()
    const [a, b] = await Promise.all([me(`Bearer ${tokenA}`, t.base), me(`Bearer ${tokenB}`, t.base)])
    expect(a.body.user).toEqual({ id: USER, email: 'a@example.test' })
    expect(b.body.user).toEqual({ id: other, email: 'b@example.test' })

    const queries = calls.filter((c) => c.path === '/rest/v1/profiles')
    expect(queries).toHaveLength(2)
    expect(queries.find((q) => q.authorization === `Bearer ${tokenA}`).search).toContain(`id=eq.${USER}`)
    expect(queries.find((q) => q.authorization === `Bearer ${tokenB}`).search).toContain(`id=eq.${other}`)
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
