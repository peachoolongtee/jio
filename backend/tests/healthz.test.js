import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'

const FRONTEND = 'http://localhost:5173'
let server
let base

beforeAll(async () => {
  server = createApp({ frontendOrigin: FRONTEND }).listen(0)
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})

afterAll(() => new Promise((resolve) => server.close(resolve)))

describe('GET /healthz', () => {
  it('returns 200', async () => {
    const res = await fetch(`${base}/healthz`)
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ ok: true })
  })
})

describe('CORS', () => {
  it('allows only the configured frontend origin, never "*"', async () => {
    const res = await fetch(`${base}/healthz`, { headers: { Origin: 'https://evil.example' } })
    expect(res.headers.get('access-control-allow-origin')).toBe(FRONTEND)
  })

  it('refuses to start with a wildcard or missing origin', () => {
    expect(() => createApp({ frontendOrigin: '*' })).toThrow()
    expect(() => createApp({})).toThrow()
  })
})
