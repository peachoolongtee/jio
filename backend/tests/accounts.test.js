import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { createSupabase } from '../src/db/supabase.js'

// POST /api/accounts/email-check, tested without the network: a stand-in for Supabase answers the one database function
// the route calls, and records what it was asked and with which key.
const URL_ = 'https://project.supabase.test'
const ANON = 'anon-key-for-tests'
const SERVICE = 'service-key-for-tests'
const FRONTEND = 'http://localhost:5173'
const REGISTERED = 'sam@example.com'

// What the stand-in does next. 'ok' answers from `registered`; the others break in the ways a database does.
//   mode: 'ok' | 'error' | 'not-boolean' | 'hang' | 'throw'
const calls = []
let mode = 'ok'

async function fakeSupabase(input, init = {}) {
  const url = new URL(typeof input === 'string' ? input : input.url)
  const headers = new Headers(init.headers ?? (typeof input === 'string' ? undefined : input.headers))
  const json = (body, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
  if (url.pathname !== '/rest/v1/rpc/email_registered') return json({ message: `fake Supabase has no ${url.pathname}` }, 404)
  const body = JSON.parse(init.body)
  calls.push({ body, apikey: headers.get('apikey'), authorization: headers.get('authorization') })
  if (mode === 'throw') throw new TypeError('fetch failed')
  if (mode === 'hang') return new Promise(() => {})
  if (mode === 'error') return json({ code: '42883', message: `function public.email_registered(${body.p_email}) does not exist` }, 404)
  if (mode === 'not-boolean') return json({ weird: true })
  return json(body.p_email === REGISTERED)
}

const started = []
afterEach(async () => {
  mode = 'ok'
  calls.length = 0
  vi.restoreAllMocks()
  await Promise.all(started.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

// Starts an app and returns a way to ask it. `supabase: false` starts one with no Supabase at all.
//   const t = await start({ accountCheckRateLimit: { windowMs: 60_000, max: 2 } })
//   await t.check({ email: 'sam@example.com' })   // { status, body, headers }
async function start({ supabase = true, ...options } = {}) {
  const db = supabase ? createSupabase({ url: URL_, anonKey: ANON, serviceKey: SERVICE, fetchImpl: fakeSupabase }) : null
  const server = createApp({ frontendOrigin: FRONTEND, supabase: db, ...options }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  started.push(server)
  const base = `http://127.0.0.1:${server.address().port}`
  const send = async (path, body, init = {}) => {
    const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: typeof body === 'string' ? body : JSON.stringify(body), ...init })
    return { status: res.status, body: await res.json(), headers: res.headers }
  }
  return { base, send, check: (body, init) => send('/api/accounts/email-check', body, init) }
}

describe('POST /api/accounts/email-check', () => {
  it('answers true for an email with an account and false for one without, asking with the service key', async () => {
    const t = await start()
    const yes = await t.check({ email: REGISTERED })
    expect(yes.status).toBe(200)
    expect(yes.body).toEqual({ registered: true })
    expect(yes.headers.get('cache-control')).toBe('no-store')
    expect((await t.check({ email: 'nobody@example.com' })).body).toEqual({ registered: false })
    expect(calls).toHaveLength(2)
    for (const call of calls) {
      expect(call.apikey).toBe(SERVICE)
      expect(call.authorization).toBe(`Bearer ${SERVICE}`)
    }
  })

  it('trims the address before asking, and needs no login', async () => {
    const t = await start()
    expect((await t.check({ email: `  ${REGISTERED}  ` })).body).toEqual({ registered: true })
    expect(calls[0].body).toEqual({ p_email: REGISTERED })
  })

  it.each([
    ['no body', {}],
    ['no email', { mail: REGISTERED }],
    ['a number', { email: 5 }],
    ['a list', { email: [REGISTERED] }],
    ['an empty string', { email: '' }],
    ['spaces only', { email: '   ' }],
    ['something that is not an address', { email: 'sam' }],
    ['an address over 254 characters', { email: `${'a'.repeat(250)}@example.com` }],
    ['a body that is not an object', ['x']],
  ])('refuses %s with 400 in the flat shape, without asking the database', async (_name, body) => {
    const t = await start()
    const res = await t.check(body)
    expect(res.status).toBe(400)
    expect(Object.keys(res.body).sort()).toEqual(['error', 'message'])
    expect(res.body.error).toBe('invalid_input')
    expect(calls).toHaveLength(0)
  })

  it('answers 400 in the same shape for a body that is not JSON', async () => {
    const t = await start()
    const res = await t.check('{not json')
    expect(res.status).toBe(400)
    expect(res.body.error).toBe('invalid_json')
  })

  it('answers 429 over 10 a minute for one caller, in the flat shape with Retry-After, and the database is not asked again', async () => {
    const t = await start()
    for (let i = 0; i < 10; i += 1) expect((await t.check({ email: `person${i}@example.com` })).status).toBe(200)
    const refused = await t.check({ email: 'person11@example.com' })
    expect(refused.status).toBe(429)
    expect(refused.body).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' })
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
    expect(calls).toHaveLength(10)
  })

  it('counts a request that is refused as invalid too, so bad guesses cannot be sent for free', async () => {
    const t = await start({ accountCheckRateLimit: { windowMs: 60_000, max: 2 } })
    expect((await t.check({ email: 'nope' })).status).toBe(400)
    expect((await t.check({ email: 'nope' })).status).toBe(400)
    expect((await t.check({ email: REGISTERED })).status).toBe(429)
  })

  it('has its own limit: the planner limit does not count it, and it does not count the planner', async () => {
    const t = await start({ planRateLimit: { windowMs: 60_000, max: 1 }, accountCheckRateLimit: { windowMs: 60_000, max: 2 } })
    expect((await t.check({ email: REGISTERED })).status).toBe(200)
    expect((await t.check({ email: REGISTERED })).status).toBe(200)
    expect((await t.check({ email: REGISTERED })).status).toBe(429)
    // The planner's own limit of 1 is untouched by those three: its first request still gets through to its validation.
    const planner = await t.send('/api/search', {})
    expect(planner.status).not.toBe(429)
  })

  it.each([
    ['the database answers an error', 'error'],
    ['the database answers something other than true or false', 'not-boolean'],
    ['the request fails', 'throw'],
  ])('answers 503 in the flat shape, never a guess, when %s', async (_name, failure) => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mode = failure
    const t = await start()
    const res = await t.check({ email: REGISTERED })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('accounts_unavailable')
    expect(Object.keys(res.body).sort()).toEqual(['error', 'message'])
    expect(res.body).not.toHaveProperty('registered')
  })

  it('answers 503 when the database does not answer in time', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {})
    mode = 'hang'
    // The route waits 5 seconds by default; a stand-in app with a short wait keeps the test quick.
    const { createAccountsRouter } = await import('../src/routes/accounts.js')
    const express = (await import('express')).default
    const app = express()
    app.use(express.json())
    app.use('/api', createAccountsRouter({ supabase: createSupabase({ url: URL_, anonKey: ANON, serviceKey: SERVICE, fetchImpl: fakeSupabase }), timeoutMs: 50 }))
    const server = app.listen(0, '127.0.0.1')
    await once(server, 'listening')
    started.push(server)
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/accounts/email-check`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: REGISTERED }),
    })
    expect(res.status).toBe(503)
    expect((await res.json()).error).toBe('accounts_unavailable')
  })

  it('answers 503, not a guess, when the server has no Supabase', async () => {
    const t = await start({ supabase: false })
    const res = await t.check({ email: REGISTERED })
    expect(res.status).toBe(503)
    expect(res.body.error).toBe('accounts_unavailable')
    expect(calls).toHaveLength(0)
  })

  it('never writes the email to a log, on success or on any failure', async () => {
    const spies = ['log', 'info', 'warn', 'error'].map((name) => vi.spyOn(console, name).mockImplementation(() => {}))
    const secret = 'secret.person@example.com'
    const t = await start()
    await t.check({ email: secret })
    for (const failure of ['error', 'not-boolean', 'throw']) {
      mode = failure
      await t.check({ email: secret })
    }
    const start2 = await start({ supabase: false })
    await start2.check({ email: secret })
    const written = spies.flatMap((spy) => spy.mock.calls).flat().map(String).join('\n')
    expect(spies.flatMap((spy) => spy.mock.calls).length).toBeGreaterThan(0)
    expect(written).not.toContain(secret)
    expect(written).not.toContain('secret.person')
  })
})

describe('the database files', () => {
  const read = (name) => readFileSync(new URL(`../../db/${name}`, import.meta.url), 'utf8')

  it('grant email_registered to the service role only, in the fresh build and the migration', () => {
    const migration = readFileSync(new URL('../../db/migrations/20261013000000_jio_email_check.sql', import.meta.url), 'utf8')
    for (const sql of [read('policies.sql'), migration]) {
      expect(sql).toMatch(/revoke execute on function public\.email_registered\(text\) from public, anon, authenticated;/)
      expect(sql).toMatch(/grant execute on function public\.email_registered\(text\) to service_role;/)
      expect(sql).not.toMatch(/grant execute on function public\.email_registered\(text\) to[^;]*\b(anon|authenticated|public)\b/)
    }
  })

  it('compare the email without wrapping the column in a function, and leave out deleted accounts', () => {
    const migration = readFileSync(new URL('../../db/migrations/20261013000000_jio_email_check.sql', import.meta.url), 'utf8')
    for (const sql of [read('schema.sql'), migration]) {
      expect(sql).toMatch(/where email = lower\(trim\(p_email\)\)\s+and deleted_at is null/)
      expect(sql).not.toMatch(/lower\(email\)/)
      expect(sql).toMatch(/security definer set search_path = ''/)
    }
  })
})
