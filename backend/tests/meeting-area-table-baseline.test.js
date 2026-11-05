// The twin of meeting-area-baseline.test.js for table mode. That test builds its apps without the table of area times, so it pins the path a
// server without the table takes; a real server has the table. This one replays the same 84 requests (tests/fixtures/meeting-area-baseline.json)
// on apps that have it, with a OneMap stand-in that has what the real one has: a route cache, `peekRoute`, a walk under 400 m and a latency
// (tests/helpers/cached-onemap.js, deterministic), and with the same ways of failing.
//
// Two kinds of check. For every request: the status the old path gave, the same fields in the answer (plus the labels), the counts in `travel`
// adding up, no OneMap call when the mode has none, the same answer when asked again on a fresh app, and the labels telling the truth. And
// tests/fixtures/meeting-area-table-baseline.json holds a digest of each answer (the area, the worst trip, the labels and the counts), recorded
// once from this code; a change in it is a real change in what table mode answers, so do not regenerate it to make a case pass. The recorder
// refuses to overwrite a fixture.
//
// How to run:
//   node node_modules/vitest/vitest.mjs run tests/meeting-area-table-baseline.test.js
// How the fixture was recorded (only when the file does not exist):
//   JIO_RECORD_TABLE_BASELINE=1 node node_modules/vitest/vitest.mjs run tests/meeting-area-table-baseline.test.js
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadAreaTimes } from '../src/db/area-times.js'
import { recordedPlanData } from './helpers/recorded-areas.js'
import { OneMapUnavailableError } from '../src/services/budget.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { cachedOneMap } from './helpers/cached-onemap.js'

const FRONTEND = 'http://localhost:5173'
const BASELINE = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/meeting-area-baseline.json', import.meta.url)), 'utf8'))
const FIXTURE = fileURLToPath(new URL('./fixtures/meeting-area-table-baseline.json', import.meta.url))
const planData = recordedPlanData() // the 37 areas the fixture was recorded on
const areaTimes = loadAreaTimes()

// The OneMap each of the old modes becomes in table mode. Returns { onemap, options, calls } for a fresh app.
//
// How to call:
//   const { onemap, options } = onemapFor('tiny-budget')
function onemapFor(mode) {
  const down = (status) => new ExternalApiError(`onemap answered ${status}`, { service: 'onemap', status, url: 'x' })
  switch (mode) {
    case 'off':
      return { onemap: null, options: {} }
    case 'stub':
      return { onemap: cachedOneMap({ areas: planData.areas }), options: {} }
    case 'failing':
      return { onemap: { ...cachedOneMap({ areas: planData.areas }), routeMinutes: async () => { throw down(503) } }, options: {} }
    case 'no-route':
      return { onemap: { ...cachedOneMap({ areas: planData.areas }), routeMinutes: async () => null }, options: {} }
    case 'down':
      return { onemap: { ...cachedOneMap({ areas: planData.areas }), routeMinutes: async () => { throw down(503) } }, options: {} }
    case 'used-up':
      return { onemap: { ...cachedOneMap({ areas: planData.areas }), routeMinutes: async () => { throw new OneMapUnavailableError('budget_empty', 'used up') } }, options: {} }
    case 'tiny-budget': {
      const inner = cachedOneMap({ areas: planData.areas })
      let left = 3
      return {
        onemap: { ...inner, routeMinutes: async (...args) => { if (left-- <= 0) throw new OneMapUnavailableError('budget_empty', 'used up'); return inner.routeMinutes(...args) } },
        options: {},
      }
    }
    case 'hung':
      return { onemap: { ...cachedOneMap({ areas: planData.areas }), routeMinutes: () => new Promise(() => {}) }, options: { routingDeadlineMs: 30 } }
    default:
      throw new Error(`unknown mode ${mode}`)
  }
}

// Sends one request to a fresh table-mode app. Resolves { status, body (text), onemap }.
async function ask({ mode, request, headers = {} }) {
  const { onemap, options } = onemapFor(mode)
  const server = createApp({ frontendOrigin: FRONTEND, roundPlannerMinutes: false, planData, http: createHttp({ stub: true }), onemap, areaTimes, ...options }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/meeting-area`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: request == null ? '{"members": [' : JSON.stringify(request) }) // the one request of the baseline that is not JSON is recorded without a request
    return { status: res.status, body: await res.text(), onemap }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

const round1 = (x) => Math.round(x * 10) / 10
const digestOf = ({ status, body }) => {
  if (status !== 200) return { status, body }
  const a = JSON.parse(body)
  return {
    status, method: a.method, area: a.area.id, worst: round1(a.worstMinutes), approximate: a.approximate, travelSource: a.travelSource ?? null,
    travel: a.travel, candidates: a.candidates?.length ?? 0,
  }
}
const sum = (t) => t.routed + t.cached + t.walked + t.table + t.failed + t.estimated

describe('POST /api/meeting-area in table mode, on the requests of the baseline', () => {
  const recording = process.env.JIO_RECORD_TABLE_BASELINE === '1'
  const recorded = existsSync(FIXTURE) ? JSON.parse(readFileSync(FIXTURE, 'utf8')) : null
  if (!recorded && !recording) it('has its fixture', () => { throw new Error('tests/fixtures/meeting-area-table-baseline.json is missing: record it once (see the top of this file)') })

  it.each(BASELINE.cases.map((c) => [c.name, c]))('%s', async (_name, c) => {
    const first = await ask(c)
    if (recording && !recorded) (globalThis.__digests ??= {})[c.name] = digestOf(first)
    // The status is the old path's, and a refusal reads the same word for word.
    expect(first.status).toBe(c.status)
    if (c.status !== 200) {
      expect(first.body).toBe(c.body)
    } else {
      const was = JSON.parse(c.body)
      const now = JSON.parse(first.body)
      // The same fields, plus where the times came from. A request that sends none of alternatives or include still has no `candidates`.
      const extra = ['travelSource']
      expect(Object.keys(now).sort()).toEqual([...Object.keys(was), ...extra.filter((k) => !(k in was))].sort())
      expect(now.travel.table).toBeGreaterThanOrEqual(0)
      expect(sum(now.travel)).toBe(now.travel.asked)
      // The labels tell the truth: `approximate` is about the straight line, and `travelSource` is its weakest trip.
      expect(['routed', 'table', 'estimate']).toContain(now.travelSource)
      expect(now.approximate).toBe(now.travelSource === 'estimate')
      if (now.travel.source === 'table') expect(now.travelSource).not.toBe('routed')
      if (now.travelSource === 'routed') expect(now.travel.routed + now.travel.cached + now.travel.walked).toBeGreaterThan(0)
      if (c.mode === 'off' || c.mode === 'failing' || c.mode === 'down' || c.mode === 'used-up' || c.mode === 'hung' || c.mode === 'no-route') {
        expect(now.travel.routed).toBe(0) // nothing was routed, so nothing says it was
        expect(now.travelSource).not.toBe('routed')
      }
      if (c.mode === 'off') expect(first.onemap).toBeNull()
      // Few areas are routed, not the best 5 of the old path: at most the 60-trip cap whatever the group, and a small group's two areas and a second round.
      if (c.mode === 'stub') expect(first.onemap.calls.length).toBeLessThanOrEqual(c.request.members.length > 6 ? 60 : 4 * c.request.members.length)
      if (c.mode === 'stub') expect(now.travel.routed).toBeLessThanOrEqual(first.onemap.calls.length)
    }
    // Asked again on a fresh app, the same answer.
    const again = await ask(c)
    expect(again.body).toBe(first.body)
    // And the digest is what was recorded.
    const digest = digestOf(first)
    if (recorded) {
      expect(digest).toEqual(recorded.cases[c.name])
    }
  })

  if (recording && !recorded) {
    it('writes the fixture', () => {
      expect(existsSync(FIXTURE)).toBe(false)
      writeFileSync(FIXTURE, `${JSON.stringify({ recordedFrom: 'POST /api/meeting-area in table mode, the requests of meeting-area-baseline.json', cases: globalThis.__digests }, null, 1)}\n`)
    })
  }
})
