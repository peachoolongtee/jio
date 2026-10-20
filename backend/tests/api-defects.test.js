import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createHttp } from '../src/services/http.js'

const FRONTEND = 'http://localhost:5173'
const orchard = { lat: 1.30065, lng: 103.85585 }
const member = { id: 'member-1', home: orchard }
const slot = {
  members: [member],
  occasion: 'casual_meal',
  dateTime: '2026-10-20T19:00',
  durationMinutes: 60,
  categories: ['eat'],
  centre: orchard,
  unknownPolicy: 'lenient',
}
let server, base

beforeAll(async () => {
  server = createApp({
    frontendOrigin: FRONTEND,
    http: createHttp({ stub: true }),
    includePlannerDiagnostics: false,
  }).listen(0)
  await once(server, 'listening')
  base = `http://127.0.0.1:${server.address().port}`
})
afterAll(() => new Promise((resolve) => server.close(resolve)))

async function post(path, body) {
  const response = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })
  return { status: response.status, body: await response.json() }
}

describe('reported backend defects', () => {
  it('rejects impossible calendar dates', async () => {
    const response = await post('/api/roam', {
      current: orchard,
      members: [{ id: member.id }],
      occasion: 'casual_meal',
      dateTime: '2026-02-31T19:00',
    })
    expect(response.status).toBe(400)
    expect(response.body.issues.map((issue) => issue.path)).toContain('dateTime')
  })

  it.each([
    ['Johor', { lat: 1.455, lng: 103.76 }],
    ['Batam', { lat: 1.15, lng: 104.05 }],
  ])('rejects coordinates in %s', async (_place, point) => {
    const response = await post('/api/roam', {
      current: point,
      members: [{ id: member.id }],
      occasion: 'casual_meal',
      dateTime: '2026-10-20T19:00',
    })
    expect(response.status).toBe(400)
  })

  it('accepts a Singapore land point and the build-spec ranking aliases', async () => {
    const roam = await post('/api/plan/roam', {
      current: orchard,
      members: [{ id: member.id }],
      occasion: 'casual_meal',
      dateTime: '2026-10-20T19:00',
      categories: ['eat'],
    })
    expect(roam.status).toBe(200)
    expect(roam.body.status).toBe('ok')

    const converge = await post('/api/plan/converge', slot)
    expect(converge.status).toBe(200)
    expect(converge.body.status).toBe('ok')
  })

  it('supports GET /api/venues/search and returns rounded travel times without diagnostics', async () => {
    const search = await fetch(`${base}/api/venues/search?q=Chicken%20Rice&lat=${orchard.lat}&lng=${orchard.lng}&dateTime=2026-10-20T12%3A00`)
    expect(search.status).toBe(200)
    expect(Array.isArray((await search.json()).results)).toBe(true)

    const response = await post('/api/converge', slot)
    expect(response.status).toBe(200)
    expect(response.body).not.toHaveProperty('diagnostics')
    expect(response.body.status).toBe('ok')
    expect(response.body.results.length).toBeGreaterThan(0)
    for (const result of response.body.results) {
      for (const minutes of [result.worstMinutes, result.meanMinutes, ...Object.values(result.travelByMember), ...Object.values(result.returnByMember)]) {
        expect(minutes).toBeCloseTo(Math.round(minutes * 10) / 10, 8)
      }
    }
  })
})
