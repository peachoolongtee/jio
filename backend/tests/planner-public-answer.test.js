// What a planner answer looks like to a caller in production: no `diagnostics`, minutes rounded to one decimal place. The two
// are separate switches (includePlannerDiagnostics, roundPlannerMinutes). Also the build-spec aliases, which answer as the
// routes they stand for, share the planner's rate limit and name the query parameter the caller sent in a 400.
// Nothing here touches a network: the HTTP layer is the stub.
import { once } from 'node:events'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { createHttp } from '../src/services/http.js'

const FRONTEND = 'http://localhost:5173'
const WHEN = '2026-10-20T19:00'
const orchard = { lat: 1.30065, lng: 103.85585 }
const TRIO = [
  { id: 'ian', home: { lat: 1.3541, lng: 103.9446 } },
  { id: 'faith', home: { lat: 1.315, lng: 103.765 } },
]
const BODIES = {
  '/api/meeting-area': { members: TRIO, dateTime: WHEN },
  '/api/converge': {
    members: [{ id: 'ian', home: orchard }],
    occasion: 'casual_meal',
    dateTime: WHEN,
    durationMinutes: 60,
    categories: ['eat'],
    centre: orchard,
    unknownPolicy: 'lenient',
  },
  '/api/roam': { current: orchard, members: [{ id: 'ian' }], occasion: 'casual_meal', dateTime: WHEN, categories: ['eat'] },
  '/api/search': { query: 'chicken rice', centre: orchard, dateTime: WHEN },
}

const RANKING = ['/api/converge', '/api/roam']
const servers = []
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

// Starts an app on a free port and returns a way to call it.
// How to call: const call = await start({ includePlannerDiagnostics: false }); await call.post('/api/roam', body)
async function start(options = {}) {
  const server = createApp({ frontendOrigin: FRONTEND, http: createHttp({ stub: true }), ...options }).listen(0)
  servers.push(server)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  const read = async (response) => ({ status: response.status, body: await response.json() })
  return {
    post: async (path, body) =>
      read(await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })),
    get: async (path) => read(await fetch(`${base}${path}`)),
  }
}

// Every number the planner reports in minutes: a key ending in "minutes", or a value in a per-member time map.
// How to call: minutesIn({ results: [{ travelByMember: { ian: 12.34 }, worstMinutes: 12.3 }] }) -> [12.34, 12.3]
function minutesIn(value, parentKey = '') {
  if (Array.isArray(value)) return value.flatMap((item) => minutesIn(item))
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, item]) =>
      typeof item === 'number' && ['travelByMember', 'returnByMember', 'times'].includes(parentKey) ? [item] : minutesIn(item, key))
  }
  return typeof value === 'number' && /minutes$/i.test(parentKey) ? [value] : []
}
const oneDecimal = (n) => Math.abs(n * 10 - Math.round(n * 10)) < 1e-9
const hasKey = (value, key) =>
  Array.isArray(value) ? value.some((v) => hasKey(v, key))
    : value && typeof value === 'object' && (key in value || Object.values(value).some((v) => hasKey(v, key)))

describe('the public planner answer', () => {
  it.each(Object.keys(BODIES))('%s hides diagnostics and rounds minutes to one decimal', async (path) => {
    const production = await start({ includePlannerDiagnostics: false })
    const raw = await start({ includePlannerDiagnostics: true, roundPlannerMinutes: false })

    const shown = await production.post(path, BODIES[path])
    const unrounded = await raw.post(path, BODIES[path])
    expect(shown.status).toBe(200)
    expect(unrounded.status).toBe(200)
    // Assert the status before looping, so a failed ranking cannot make the loops below pass with nothing in them.
    if (RANKING.includes(path)) {
      expect(shown.body.status).toBe('ok')
      expect(shown.body.results.length).toBeGreaterThan(0)
    }

    expect(hasKey(shown.body, 'diagnostics')).toBe(false)
    const minutes = minutesIn(shown.body)
    for (const m of minutes) expect(oneDecimal(m)).toBe(true)

    // The unrounded answer is the control: it has the diagnostics, and a number that the public answer had to round, so the
    // checks above can fail. A search answer has neither: its only minutes are whole walking minutes, so both answers match.
    if (path === '/api/search') {
      expect(hasKey(unrounded.body, 'diagnostics')).toBe(false)
      expect(shown.body).toEqual(unrounded.body)
    } else {
      expect(hasKey(unrounded.body, 'diagnostics')).toBe(true)
      expect(minutes.length).toBeGreaterThan(0)
      expect(minutesIn(unrounded.body).some((m) => !oneDecimal(m))).toBe(true)
    }
  })

  it('rounds minutes whether or not diagnostics are shown, and shows diagnostics whether or not minutes are rounded', async () => {
    const both = await start({ includePlannerDiagnostics: true })
    const answer = await both.post('/api/converge', BODIES['/api/converge'])
    expect(hasKey(answer.body, 'diagnostics')).toBe(true)
    expect(minutesIn(answer.body).length).toBeGreaterThan(0)
    for (const m of minutesIn(answer.body)) expect(oneDecimal(m)).toBe(true)

    const rawOnly = await start({ includePlannerDiagnostics: false, roundPlannerMinutes: false })
    const unrounded = await rawOnly.post('/api/converge', BODIES['/api/converge'])
    expect(hasKey(unrounded.body, 'diagnostics')).toBe(false)
    expect(minutesIn(unrounded.body).some((m) => !oneDecimal(m))).toBe(true)
  })
})

describe('the build-spec aliases', () => {
  it.each([
    ['/api/plan/converge', '/api/converge'],
    ['/api/plan/roam', '/api/roam'],
  ])('POST %s answers as %s', async (alias, original) => {
    const call = await start({ includePlannerDiagnostics: false })
    const viaAlias = await call.post(alias, BODIES[original])
    const viaOriginal = await call.post(original, BODIES[original])
    expect(viaAlias.status).toBe(200)
    expect(viaAlias.body.status).toBe('ok')
    expect(viaAlias).toEqual(viaOriginal)
  })

  it.each(['/api/plan/converge', '/api/plan/roam'])('POST %s refuses a bad body as its original does', async (alias) => {
    const call = await start()
    const refused = await call.post(alias, { ...BODIES[alias.replace('/plan', '')], dateTime: '2026-02-31T19:00' })
    expect(refused.status).toBe(400)
    expect(refused.body.error).toBe('invalid_input')
    expect(refused.body.issues.map((i) => i.path)).toContain('dateTime')
  })

  it('GET /api/venues/search shares the planner rate limit with the POST routes', async () => {
    const call = await start({ planRateLimit: { windowMs: 60_000, max: 2 } })
    expect((await call.get('/api/venues/search?q=chicken')).status).toBe(200)
    expect((await call.post('/api/search', BODIES['/api/search'])).status).toBe(200)
    const refused = await call.get('/api/venues/search?q=chicken')
    expect(refused.status).toBe(429)
    expect(refused.body.error).toBe('rate_limited')
    expect((await call.post('/api/plan/roam', BODIES['/api/roam'])).status).toBe(429)
  })

  it('GET /api/venues/search finds the places POST /api/search finds', async () => {
    const call = await start()
    const viaGet = await call.get(`/api/venues/search?q=chicken%20rice&lat=${orchard.lat}&lng=${orchard.lng}&dateTime=${encodeURIComponent(WHEN)}`)
    const viaPost = await call.post('/api/search', BODIES['/api/search'])
    expect(viaGet.status).toBe(200)
    expect(viaGet.body).toEqual(viaPost.body)
  })

  describe('GET /api/venues/search names the query parameter the caller sent in a 400', () => {
    const paths = async (query) => {
      const call = await start()
      const answer = await call.get(`/api/venues/search?${query}`)
      expect(answer.status).toBe(400)
      expect(answer.body.error).toBe('invalid_input')
      return answer.body.issues.map((i) => i.path)
    }

    it('q', async () => {
      expect(await paths('q=')).toEqual(['q'])
      expect(await paths('lat=1.3&lng=103.8')).toEqual(['q'])
    })

    it('lat and lng, whether outside Singapore, unpaired or not a number', async () => {
      expect(await paths('q=cafe&lat=1.452&lng=103.76')).toEqual(['lat'])
      expect(await paths('q=cafe&lat=0&lng=0')).toEqual(expect.arrayContaining(['lat', 'lng']))
      expect(await paths('q=cafe&lat=1.3')).toEqual(['lat'])
      expect(await paths('q=cafe&lat=north&lng=103.8')).toEqual(['lat'])
      expect(await paths('q=cafe&lat=1.3&lng=east')).toEqual(['lng'])
    })

    it('dateTime, category, durationMinutes and limit', async () => {
      expect(await paths('q=cafe&dateTime=2026-02-31T19:00')).toEqual(['dateTime'])
      expect(await paths('q=cafe&category=spa')).toEqual(['category'])
      expect(await paths('q=cafe&durationMinutes=-5')).toEqual(['durationMinutes'])
      expect(await paths('q=cafe&limit=500')).toEqual(['limit'])
    })

    it('never reports a body field the caller did not send', async () => {
      for (const query of ['q=', 'q=cafe&lat=1.452&lng=103.76', 'q=cafe&category=spa', 'q=cafe&lat=0&lng=0']) {
        for (const path of await paths(query)) expect(path).not.toMatch(/^(centre|query|categories)/)
      }
    })
  })
})
