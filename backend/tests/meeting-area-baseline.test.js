// A frozen record of what POST /api/meeting-area answered before runners-up and named areas were added.
//
// tests/fixtures/meeting-area-baseline.json holds a list of requests and, for each, the status and the exact body
// text the route gave. This test sends every request again and compares the body text character for character
// (the text is compared as a string stored inside the JSON file, never as the file's own bytes, so line endings in
// the file do not matter). A request that does not use `alternatives` or `include` must keep its answer.
//
// What the answers depend on, and what was done about it: the stub OneMap builds a route from distance alone and
// returns no clock time inside the duration, and the planner has no timestamp in this answer, so nothing varies
// from run to run and nothing is normalised. Every case builds its own app, so the route cache of one case cannot
// change another's `travel` counts. A case that sends no `dateTime` makes the server use the time now; the stub's
// trip duration does not depend on it (only the clock times inside the stub's route do, and the route's clock
// times never reach the answer), so that case also replays the same on any day. Every case was replayed
// repeatedly when it was recorded; if one ever differs between runs, find out why before touching anything.
//
// The fixture is recorded ONCE, from unchanged source. Never regenerate it to make a failing case pass: a failing
// case here is a real change in what the route answers. The recorder below refuses to overwrite a fixture.
//
// How to run:
//   node node_modules/vitest/vitest.mjs run tests/meeting-area-baseline.test.js
//
// How the fixture was recorded (only on source that has not changed, only when the file does not exist):
//   JIO_RECORD_MEETING_AREA_BASELINE=1 node node_modules/vitest/vitest.mjs run tests/meeting-area-baseline.test.js
import { once } from 'node:events'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { OneMapUnavailableError } from '../src/services/budget.js'
import { createHttp, ExternalApiError } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'
import { SCENARIO_HEADER } from '../src/services/scenario.js'

const FRONTEND = 'http://localhost:5173'
const FIXTURE = fileURLToPath(new URL('./fixtures/meeting-area-baseline.json', import.meta.url))
const planData = loadPlanData()

// ---------------------------------------------------------------- how each case's app is built
// off        no OneMap service: the engine's own estimate, routing off
// stub       the stub OneMap (routes built from distance), routing on
// failing    the stub scenario routing-fail: every OneMap route call fails
// no-route   a OneMap that answers "no route" for every trip
// down       a OneMap that fails every call with a server error
// used-up    a OneMap whose call budget for the minute is already used up
// tiny-budget the stub OneMap with a budget of 3 calls a minute
// hung       a OneMap that never answers, with a 30 millisecond deadline
//
// How to call:
//   const app = buildApp('stub')
function buildApp(mode) {
  const base = { frontendOrigin: FRONTEND, planData }
  const http = createHttp({ stub: true })
  switch (mode) {
    case 'off':
      return createApp({ ...base, http })
    case 'stub':
    case 'failing':
      return createApp({ ...base, stub: true })
    case 'tiny-budget':
      return createApp({ ...base, http, onemap: createOneMap({ http, stub: true, callsPerMinute: 3 }) })
    case 'no-route':
      return createApp({ ...base, http, onemap: { routingEnabled: true, routeMinutes: async () => null } })
    case 'down':
      return createApp({
        ...base,
        http,
        onemap: {
          routingEnabled: true,
          routeMinutes: async () => {
            throw new ExternalApiError('onemap answered 503', { service: 'onemap', status: 503, url: 'x' })
          },
        },
      })
    case 'used-up':
      return createApp({
        ...base,
        http,
        onemap: {
          routingEnabled: true,
          routeMinutes: async () => {
            throw new OneMapUnavailableError('budget_empty', 'used up')
          },
        },
      })
    case 'hung':
      return createApp({
        ...base,
        http,
        onemap: { routingEnabled: true, routeMinutes: () => new Promise(() => {}) },
        routingDeadlineMs: 30,
      })
    default:
      throw new Error(`unknown mode ${mode}`)
  }
}

// Sends one recorded request to a fresh app and returns the status and the body text.
//
// How to call:
//   const { status, body } = await ask({ mode: 'stub', headers: {}, request: { members } })
async function ask({ mode, headers = {}, request, raw }) {
  const server = buildApp(mode).listen(0, '127.0.0.1')
  await once(server, 'listening')
  try {
    const res = await fetch(`http://127.0.0.1:${server.address().port}/api/meeting-area`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: raw !== undefined ? raw : JSON.stringify(request),
    })
    return { status: res.status, body: await res.text() }
  } finally {
    await new Promise((resolve) => server.close(resolve))
  }
}

// ---------------------------------------------------------------- the requests (used only to record)
// A small seeded random generator, so a recorded group can be made again the same way.
function rng(seed) {
  return () => {
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const groupOf = (n, seed = 7) => {
  const rand = rng(seed)
  const spot = () => ({ lat: 1.28 + rand() * 0.16, lng: 103.7 + rand() * 0.26 })
  return Array.from({ length: n }, (_, i) => ({ id: `m${i}`, name: `M${i}`, home: spot() }))
}

const TAMPINES = { lat: 1.3541, lng: 103.9446 }
const CLEMENTI = { lat: 1.315, lng: 103.765 }
const WOODLANDS = { lat: 1.437, lng: 103.7865 }
const BISHAN = { lat: 1.35092, lng: 103.84822 }
const TRIO = [
  { id: 'ian', name: 'Ian', home: TAMPINES },
  { id: 'faith', name: 'Faith', home: CLEMENTI, dietary: ['Halal'] },
  { id: 'jonathan', name: 'Jonathan', home: WOODLANDS },
]
const PAIR = [TRIO[0], TRIO[1]]
const WHEN = '2026-10-10T19:00'

const def = (name, mode, request, extra = {}) => ({ name, mode, request, ...extra })
const FAIL_HEADER = { [SCENARIO_HEADER]: 'routing-fail' }
const bad = (name, request, mode = 'off') => def(name, mode, request)

const DEFINITIONS = [
  // ---- routing off: the engine's estimate
  def('off: station, three members', 'off', { members: TRIO }),
  def('off: station, two members', 'off', { members: PAIR }),
  def('off: weighted_centroid', 'off', { members: TRIO, method: 'weighted_centroid' }),
  def('off: centroid', 'off', { members: TRIO, method: 'centroid' }),
  def('off: minimax', 'off', { members: TRIO, method: 'minimax' }),
  def('off: station with maxCandidates 16', 'off', { members: TRIO, maxCandidates: 16 }),
  def('off: station with maxCandidates 1', 'off', { members: TRIO, maxCandidates: 1 }),
  def('off: one member opted out', 'off', { members: TRIO, optedOut: ['jonathan'] }),
  def('off: an opted-out id nobody has', 'off', { members: TRIO, optedOut: ['ghost'] }),
  def('off: override of a start point', 'off', { members: TRIO, overrides: { faith: { start: { lat: 1.3, lng: 103.85 } } } }),
  def('off: override that sets only an end point', 'off', { members: TRIO, overrides: { faith: { end: { lat: 1.3, lng: 103.85 } } } }),
  def('off: override for an id nobody has', 'off', { members: TRIO, overrides: { ghost: { start: { lat: 1.3, lng: 103.85 } } } }),
  def('off: a member with a start different from home', 'off', {
    members: [{ id: 'a', home: TAMPINES, start: BISHAN }, { id: 'b', home: CLEMENTI }],
  }),
  def('off: travel debt pulls weighted_centroid', 'off', {
    members: [{ ...TRIO[0], travelDebtMinutes: 40 }, { ...TRIO[1], travelDebtMinutes: -40 }, TRIO[2]],
    method: 'weighted_centroid',
  }),
  def('off: travel debt breaks a station tie', 'off', {
    members: [{ ...TRIO[0], travelDebtMinutes: 60 }, { ...TRIO[1], travelDebtMinutes: -60 }],
  }),
  def('off: one member', 'off', { members: [TRIO[0]] }),
  def('off: one member, centroid', 'off', { members: [TRIO[0]], method: 'centroid' }),
  def('off: everyone at the same point', 'off', {
    members: [{ id: 'a', home: BISHAN }, { id: 'b', home: BISHAN }, { id: 'c', home: BISHAN }],
  }),
  def('off: members with no names', 'off', { members: [{ id: 'a', home: TAMPINES }, { id: 'b', home: CLEMENTI }] }),
  def('off: a field the route does not know is ignored', 'off', { members: TRIO, colour: 'blue', alternatives_please: 3 }),
  def('off: fairnessScaleMinutes is not a request field', 'off', { members: TRIO, fairnessScaleMinutes: 10 }),
  def('off: 12 members, minimax', 'off', { members: groupOf(12, 3), method: 'minimax' }),
  def('off: 30 members, station', 'off', { members: groupOf(30) }),
  def('off: 30 members, centroid', 'off', { members: groupOf(30), method: 'centroid' }),
  def('off: 30 members, weighted_centroid', 'off', { members: groupOf(30, 11), method: 'weighted_centroid' }),
  def('off: dateTime sent', 'off', { members: TRIO, dateTime: WHEN }),

  // ---- routing on, through the stub OneMap
  def('on: station, three members, dateTime sent', 'stub', { members: TRIO, dateTime: WHEN }),
  def('on: station, three members, no dateTime', 'stub', { members: TRIO }),
  def('on: station, two members', 'stub', { members: PAIR, dateTime: WHEN }),
  def('on: weighted_centroid', 'stub', { members: TRIO, method: 'weighted_centroid', dateTime: WHEN }),
  def('on: centroid', 'stub', { members: TRIO, method: 'centroid', dateTime: WHEN }),
  def('on: minimax', 'stub', { members: TRIO, method: 'minimax', dateTime: WHEN }),
  def('on: station with maxCandidates 5', 'stub', { members: TRIO, maxCandidates: 5, dateTime: WHEN }),
  def('on: station with maxCandidates 37', 'stub', { members: TRIO, maxCandidates: 37, dateTime: WHEN }),
  def('on: station with maxCandidates 1', 'stub', { members: TRIO, maxCandidates: 1, dateTime: WHEN }),
  def('on: one member opted out', 'stub', { members: TRIO, optedOut: ['faith'], dateTime: WHEN }),
  def('on: override of a start point', 'stub', {
    members: TRIO,
    overrides: { faith: { start: { lat: 1.3, lng: 103.85 } } },
    dateTime: WHEN,
  }),
  def('on: override and opt-out together', 'stub', {
    members: TRIO,
    optedOut: ['ian'],
    overrides: { jonathan: { start: { lat: 1.33, lng: 103.9 } } },
    dateTime: WHEN,
  }),
  def('on: one member', 'stub', { members: [TRIO[0]], dateTime: WHEN }),
  def('on: members close enough to walk', 'stub', {
    members: [{ id: 'a', home: { lat: 1.3509, lng: 103.8482 } }, { id: 'b', home: { lat: 1.3512, lng: 103.8485 } }],
    dateTime: WHEN,
  }),
  def('on: 12 members, minimax', 'stub', { members: groupOf(12, 3), method: 'minimax', dateTime: WHEN }),
  def('on: 20 members, station (three areas fit the cap)', 'stub', { members: groupOf(20, 5), dateTime: WHEN }),
  def('on: 30 members, station (two areas fit the cap of 60 trips)', 'stub', { members: groupOf(30), dateTime: WHEN }),
  def('on: 30 members, maxCandidates 37', 'stub', { members: groupOf(30), maxCandidates: 37, dateTime: WHEN }),
  def('on: 30 members, centroid', 'stub', { members: groupOf(30), method: 'centroid', dateTime: WHEN }),
  def('on: 30 members, weighted_centroid', 'stub', { members: groupOf(30, 11), method: 'weighted_centroid', dateTime: WHEN }),
  def('on: 30 members, 5 opted out', 'stub', {
    members: groupOf(30),
    optedOut: ['m0', 'm1', 'm2', 'm3', 'm4'],
    dateTime: WHEN,
  }),

  // ---- routing fails or runs out
  def('failing: station', 'failing', { members: TRIO, dateTime: WHEN }, { headers: FAIL_HEADER }),
  def('failing: centroid', 'failing', { members: TRIO, method: 'centroid', dateTime: WHEN }, { headers: FAIL_HEADER }),
  def('failing: 30 members', 'failing', { members: groupOf(30), dateTime: WHEN }, { headers: FAIL_HEADER }),
  def('failing: header sent to a server that is not in stub mode is ignored', 'off', { members: TRIO }, { headers: FAIL_HEADER }),
  def('no route: station', 'no-route', { members: TRIO, dateTime: WHEN }),
  def('no route: minimax', 'no-route', { members: TRIO, method: 'minimax', dateTime: WHEN }),
  def('down: station', 'down', { members: TRIO, dateTime: WHEN }),
  def('used up: station', 'used-up', { members: TRIO, dateTime: WHEN }),
  def('used up: weighted_centroid', 'used-up', { members: TRIO, method: 'weighted_centroid', dateTime: WHEN }),
  def('tiny budget: station, three members', 'tiny-budget', { members: TRIO, dateTime: WHEN }),
  def('hung: station, answered at the deadline on estimates', 'hung', { members: TRIO, dateTime: WHEN }),

  // ---- 400 answers
  bad('400: no body fields at all', {}),
  bad('400: no members', { members: [] }),
  bad('400: members is not a list', { members: 'ian' }),
  bad('400: a member with no location', { members: [{ id: 'x' }] }),
  bad('400: a member with no id', { members: [{ home: TAMPINES }] }),
  bad('400: a member id of 81 characters', { members: [{ id: 'x'.repeat(81), home: TAMPINES }] }),
  bad('400: everyone opted out', { members: TRIO, optedOut: ['ian', 'faith', 'jonathan'] }),
  bad('400: 31 members', { members: groupOf(31) }),
  bad('400: two members with one id', { members: [TRIO[0], { ...TRIO[1], id: 'ian' }] }),
  bad('400: minimax with 13 members', { members: groupOf(13), method: 'minimax' }),
  bad('400: an unknown method', { members: TRIO, method: 'middle' }),
  bad('400: maxCandidates 0', { members: TRIO, maxCandidates: 0 }),
  bad('400: maxCandidates 51', { members: TRIO, maxCandidates: 51 }),
  bad('400: maxCandidates 2.5', { members: TRIO, maxCandidates: 2.5 }),
  bad('400: maxCandidates as text', { members: TRIO, maxCandidates: '16' }),
  bad('400: a point outside Singapore', { members: [{ id: 'x', home: { lat: 51.5, lng: -0.12 } }] }),
  bad('400: latitude and longitude swapped', { members: [{ id: 'x', home: { lat: 103.8, lng: 1.35 } }] }),
  bad('400: a bad dateTime', { members: TRIO, dateTime: '2026-10-10 19:00' }),
  bad('400: dietary needs it does not know', { members: [{ id: 'x', home: TAMPINES, dietary: ['carnivore'] }] }),
  bad('400: a negative budget', { members: [{ id: 'x', home: TAMPINES, budgetMaxPerPerson: -5 }] }),
  bad('400: 31 opted-out ids', { members: TRIO, optedOut: Array.from({ length: 31 }, (_, i) => `o${i}`) }),
  bad('400: several bad fields are all listed', { members: [{ id: 'x' }], method: 'middle', maxCandidates: 0 }),
  bad('400: the same checks apply with routing on', { members: [{ id: 'x' }] }, 'stub'),
  bad('400: minimax with 13 members, routing on', { members: groupOf(13), method: 'minimax' }, 'stub'),
  def('400: a body that is not JSON', 'off', null, { raw: '{"members": [' }),
  def('400: a body that is a list', 'off', [1, 2, 3]),
]

// ---------------------------------------------------------------- recording (once) and replaying
const recording = process.env.JIO_RECORD_MEETING_AREA_BASELINE === '1'

describe.runIf(recording)('recording the meeting-area baseline', () => {
  it('writes the fixture from the code as it is, and never overwrites one', async () => {
    expect(existsSync(FIXTURE), 'the baseline is recorded once; do not regenerate it').toBe(false)
    const cases = []
    for (const d of DEFINITIONS) {
      const { status, body } = await ask(d)
      cases.push({
        name: d.name,
        mode: d.mode,
        ...(d.headers && { headers: d.headers }),
        ...(d.raw !== undefined ? { raw: d.raw } : { request: d.request }),
        status,
        body,
      })
    }
    const names = cases.map((c) => c.name)
    expect(new Set(names).size).toBe(names.length)
    writeFileSync(FIXTURE, `${JSON.stringify({ recordedFrom: 'POST /api/meeting-area before alternatives, include and candidates', cases }, null, 1)}\n`)
  })
})

describe.skipIf(recording)('POST /api/meeting-area answers what it answered before runners-up and named areas', () => {
  // Read at collection time even when this block is skipped, so recording (no file yet) reads nothing.
  const fixture = recording ? { cases: [] } : JSON.parse(readFileSync(FIXTURE, 'utf8'))

  it('the fixture covers every part of the route', () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(40)
    const has = (re) => fixture.cases.some((c) => re.test(c.name))
    for (const re of [/^off:/, /^on:/, /station/, /weighted_centroid/, /centroid/, /minimax/, /opted out/, /override/, /30 members/, /^failing:/, /^400:/]) {
      expect(has(re), String(re)).toBe(true)
    }
    expect(fixture.cases.filter((c) => c.status === 200).length).toBeGreaterThan(30)
    expect(fixture.cases.filter((c) => c.status === 400).length).toBeGreaterThan(15)
    expect(new Set(fixture.cases.map((c) => c.name)).size).toBe(fixture.cases.length)
  })

  for (const c of fixture.cases) {
    it(c.name, async () => {
      const { status, body } = await ask({ mode: c.mode, headers: c.headers, request: c.request, raw: c.raw })
      expect(status).toBe(c.status)
      // The body text itself, not a parsed copy: key order and number formatting count.
      expect(body).toBe(c.body)
      // The answer must not carry anything from the new feature.
      expect(JSON.parse(body)).not.toHaveProperty('candidates')
    })
  }
})
