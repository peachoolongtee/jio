import { once } from 'node:events'
import express from 'express'
import { afterEach, describe, expect, it } from 'vitest'
import { rateLimit } from '../src/middleware/rate-limit.js'

// The rate limiter, tested on a tiny app of its own with a clock the test moves. Nothing here touches app.js.
const WINDOW = 60_000
const BODY = { error: 'rate_limited', message: 'Too many requests. Try again shortly.' }

// Servers started by a test, closed afterwards.
const started = []
afterEach(async () => {
  await Promise.all(started.splice(0).map((s) => new Promise((resolve) => s.close(resolve))))
})

// Starts an app with the limiter mounted, and returns a way to call it and the clock.
//   const t = await start({ max: 3 })
//   await t.get('/ping')           // { status, body, retryAfter }
//   t.clock.ms += 61_000           // Move time forward.
//
// "before" runs ahead of the limiter, like the login check does. A request with the header x-user gets req.user.
async function start({ windowMs = WINDOW, max = 3, keyOf, before } = {}) {
  const clock = { ms: 1_000_000 }
  const limiter = rateLimit({ windowMs, max, now: () => clock.ms, ...(keyOf ? { keyOf } : {}) })
  const app = express()
  if (before) app.use(before)
  app.use(limiter)
  app.get('/ping', (_req, res) => res.json({ ok: true }))
  const server = app.listen(0, '127.0.0.1')
  await once(server, 'listening')
  started.push(server)
  const base = `http://127.0.0.1:${server.address().port}`

  const get = async (path = '/ping', headers = {}) => {
    const res = await fetch(`${base}${path}`, { headers })
    return { status: res.status, body: await res.json(), retryAfter: res.headers.get('retry-after') }
  }
  return { clock, limiter, get }
}

// Makes n requests in a row and returns the statuses.
const statuses = async (t, n, headers) => {
  const out = []
  for (let i = 0; i < n; i++) out.push((await t.get('/ping', headers)).status)
  return out
}

describe('rateLimit', () => {
  it('lets max requests through, then answers 429 with the body and a Retry-After', async () => {
    const t = await start({ max: 3 })
    expect(await statuses(t, 3)).toEqual([200, 200, 200])

    t.clock.ms += 20_000 // 40 seconds of the window are left.
    const refused = await t.get()
    expect(refused.status).toBe(429)
    expect(refused.body).toEqual(BODY)
    expect(refused.retryAfter).toBe('40')
  })

  it('rounds Retry-After up to whole seconds and never answers less than 1', async () => {
    const t = await start({ max: 1 })
    await t.get()

    t.clock.ms += 1_500 // 58.5 seconds left.
    expect((await t.get()).retryAfter).toBe('59')

    t.clock.ms = 1_000_000 + WINDOW - 1 // 1 ms left.
    const last = await t.get()
    expect(last.status).toBe(429)
    expect(last.retryAfter).toBe('1')
  })

  it('does not count refused requests, so knocking does not extend the wait', async () => {
    const t = await start({ max: 1 })
    await t.get()
    for (let i = 0; i < 5; i++) expect((await t.get()).status).toBe(429)
    t.clock.ms += WINDOW
    expect((await t.get()).status).toBe(200)
  })

  it('lets requests through again once the window has passed', async () => {
    const t = await start({ max: 2 })
    expect(await statuses(t, 3)).toEqual([200, 200, 429])

    t.clock.ms += WINDOW - 1
    expect((await t.get()).status).toBe(429) // One millisecond short.

    t.clock.ms += 1
    expect(await statuses(t, 3)).toEqual([200, 200, 429])
  })

  it('counts different keys separately', async () => {
    const t = await start({ max: 2, keyOf: (req) => req.get('x-key') })
    expect(await statuses(t, 3, { 'x-key': 'a' })).toEqual([200, 200, 429])
    expect(await statuses(t, 3, { 'x-key': 'b' })).toEqual([200, 200, 429])
    expect(t.limiter.size()).toBe(2)
  })

  it('counts by address when nobody is signed in', async () => {
    const t = await start({ max: 2 })
    // Both requests come from 127.0.0.1, so they share one count.
    expect(await statuses(t, 3, { 'x-user': 'ignored without a login check' })).toEqual([200, 200, 429])
    expect(t.limiter.size()).toBe(1)
  })

  it('counts by user id when req.user is set, not by address', async () => {
    const before = (req, _res, next) => {
      const id = req.get('x-user')
      if (id) req.user = { id }
      next()
    }
    const t = await start({ max: 2, before })

    // Every request comes from the same address, yet each user has an allowance of their own.
    expect(await statuses(t, 3, { 'x-user': 'ian' })).toEqual([200, 200, 429])
    expect(await statuses(t, 3, { 'x-user': 'faith' })).toEqual([200, 200, 429])
    expect(t.limiter.size()).toBe(2)

    // An address with no login is counted on its own, apart from the users.
    expect(await statuses(t, 3)).toEqual([200, 200, 429])
    expect(t.limiter.size()).toBe(3)
  })

  it('answers 429 in the same body for every key', async () => {
    const t = await start({ max: 1, keyOf: (req) => req.get('x-key') })
    await t.get('/ping', { 'x-key': 'a' })
    await t.get('/ping', { 'x-key': 'b' })
    for (const key of ['a', 'b']) {
      const r = await t.get('/ping', { 'x-key': key })
      expect(r.status).toBe(429)
      expect(r.body).toEqual(BODY)
    }
  })
})

describe('rateLimit memory', () => {
  // Calls the middleware directly, which is much faster than 10,000 HTTP requests.
  // Returns true if the request was let through, false if it was refused.
  const call = (limiter, req) => {
    let passed = false
    const res = { set: () => res, status: () => res, json: () => res }
    limiter(req, res, () => {
      passed = true
    })
    return passed
  }

  it('drops 10,000 keys once their window has passed and the next request arrives', () => {
    const clock = { ms: 5_000 }
    const limiter = rateLimit({ windowMs: WINDOW, max: 5, now: () => clock.ms })
    for (let i = 0; i < 10_000; i++) expect(call(limiter, { ip: `ip-${i}` })).toBe(true)
    expect(limiter.size()).toBe(10_000)

    clock.ms += WINDOW
    expect(call(limiter, { ip: 'newcomer' })).toBe(true)
    expect(limiter.size()).toBe(1) // Only the newcomer is left.
  })

  it('does not sweep before the window has passed', () => {
    const clock = { ms: 5_000 }
    const limiter = rateLimit({ windowMs: WINDOW, max: 5, now: () => clock.ms })
    for (let i = 0; i < 100; i++) call(limiter, { ip: `ip-${i}` })
    clock.ms += WINDOW - 1
    call(limiter, { ip: 'newcomer' })
    expect(limiter.size()).toBe(101)
  })

  it('keeps live keys when it sweeps', () => {
    const clock = { ms: 5_000 }
    const limiter = rateLimit({ windowMs: WINDOW, max: 1, now: () => clock.ms })
    call(limiter, { ip: 'early' })
    clock.ms += WINDOW / 2
    call(limiter, { ip: 'late' })
    clock.ms += WINDOW / 2 // "early" has expired, "late" has half a window left.
    expect(call(limiter, { ip: 'late' })).toBe(false) // Still counted, and this request sweeps "early".
    expect(limiter.size()).toBe(1)
  })
})

describe('rateLimit options', () => {
  it.each([
    ['windowMs missing', { max: 5 }],
    ['windowMs zero', { windowMs: 0, max: 5 }],
    ['windowMs negative', { windowMs: -1, max: 5 }],
    ['windowMs a fraction', { windowMs: 1.5, max: 5 }],
    ['windowMs a string', { windowMs: '1000', max: 5 }],
    ['windowMs NaN', { windowMs: Number.NaN, max: 5 }],
    ['windowMs infinite', { windowMs: Infinity, max: 5 }],
    ['max missing', { windowMs: 1000 }],
    ['max zero', { windowMs: 1000, max: 0 }],
    ['max negative', { windowMs: 1000, max: -3 }],
    ['max a fraction', { windowMs: 1000, max: 2.5 }],
    ['max a string', { windowMs: 1000, max: '5' }],
    ['keyOf not a function', { windowMs: 1000, max: 5, keyOf: 'ip' }],
    ['now not a function', { windowMs: 1000, max: 5, now: 123 }],
  ])('throws for %s', (_label, options) => {
    expect(() => rateLimit(options)).toThrow(/rateLimit:/)
  })

  it('throws when called with no options at all', () => {
    expect(() => rateLimit()).toThrow(/windowMs/)
  })

  it('names the bad option in the message', () => {
    expect(() => rateLimit({ windowMs: 0, max: 5 })).toThrow(/windowMs must be a positive integer/)
    expect(() => rateLimit({ windowMs: 1000, max: 0 })).toThrow(/max must be a positive integer/)
  })

  it('accepts good options and returns a middleware with size()', () => {
    const limiter = rateLimit({ windowMs: 1000, max: 1 })
    expect(typeof limiter).toBe('function')
    expect(limiter.size()).toBe(0)
  })
})

describe('the limiter mounted on the planner routes', () => {
  // Starts the real app with a limit of 2 planner requests a minute, on stub HTTP so nothing leaves the machine.
  //
  // How to call:
  //   const { base, close } = await startApp()
  async function startApp(options = {}) {
    const { createApp } = await import('../src/app.js')
    const { createHttp } = await import('../src/services/http.js')
    const server = createApp({
      frontendOrigin: 'http://localhost:5173',
      http: createHttp({ stub: true }),
      ...options,
    }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    return { base: `http://localhost:${server.address().port}`, close: () => new Promise((r) => server.close(r)) }
  }

  const search = (base) =>
    fetch(`${base}/api/search`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query: 'cafe' }),
    })

  it('answers 429 on the planner routes after the limit, and leaves the health check alone', async () => {
    const { base, close } = await startApp({ planRateLimit: { windowMs: 60_000, max: 2 } })
    try {
      const first = await search(base)
      const second = await search(base)
      const third = await search(base)
      expect(first.status).not.toBe(429)
      expect(second.status).not.toBe(429)
      expect(third.status).toBe(429)
      expect(await third.json()).toEqual({ error: 'rate_limited', message: 'Too many requests. Try again shortly.' })
      expect(Number(third.headers.get('retry-after'))).toBeGreaterThanOrEqual(1)

      // Other planner routes share the caller's count. Routes outside the planner do not.
      const converge = await fetch(`${base}/api/converge`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      expect(converge.status).toBe(429)
      for (let i = 0; i < 5; i += 1) expect((await fetch(`${base}/healthz`)).status).toBe(200)
      expect((await fetch(`${base}/api/nope`)).status).toBe(404)
    } finally {
      await close()
    }
  })

  it('has no limit when none is configured', async () => {
    const { base, close } = await startApp()
    try {
      for (let i = 0; i < 10; i += 1) expect((await search(base)).status).not.toBe(429)
    } finally {
      await close()
    }
  })
})
