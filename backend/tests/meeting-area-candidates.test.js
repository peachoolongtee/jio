// POST /api/meeting-area with `alternatives` and `include`: runners-up and named areas, in `candidates`.
// Nothing here touches the network: the stub OneMap builds routes from distance, and doubles answer for the rest.
// tests/meeting-area-baseline.test.js proves that a request without these fields answers as it always did.
import { once } from 'node:events'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { meetingArea } from '../src/planner/engine.js'
import { mockTravelMinutes } from '../src/planner/geo.js'
import { createHttp } from '../src/services/http.js'
import { createOneMap } from '../src/services/onemap.js'
import { SCENARIO_HEADER } from '../src/services/scenario.js'
import { MAX_ROUTED_TRIPS_PER_REQUEST } from '../src/services/travel-times.js'

const FRONTEND = 'http://localhost:5173'
const WHEN = '2026-10-10T19:00'
const planData = loadPlanData()
const AREAS = planData.areas

// ---------------------------------------------------------------- helpers
const servers = []
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

// Starts an app and returns a function that posts to its meeting-area route.
//
// How to call:
//   const ask = await serve(createApp({ frontendOrigin: FRONTEND, stub: true }))
//   const { status, body } = await ask({ members, alternatives: 2 })
async function serve(app) {
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return async (body, headers = {}) => {
    const res = await fetch(`${base}/api/meeting-area`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
}

// Routing off: no OneMap service, so every time is the engine's estimate.
const routingOff = () => serve(createApp({ frontendOrigin: FRONTEND, roundPlannerMinutes: false, planData, http: createHttp({ stub: true }) }))

// Routing on through the stub OneMap, counting the route calls that reach the HTTP layer.
//
// How to call:
//   const { ask, calls } = await routingOn() // calls.route is the number of OneMap route calls so far
async function routingOn() {
  const real = createHttp({ stub: true })
  const calls = { route: 0 }
  const http = {
    getJson: (url, options) => {
      if (url.includes('/routingsvc/route')) calls.route += 1
      return real.getJson(url, options)
    },
    postJson: (url, body, options) => real.postJson(url, body, options),
  }
  const onemap = createOneMap({ http, email: 'a@example.org', password: 'not-a-real-password', stub: true })
  const ask = await serve(createApp({ frontendOrigin: FRONTEND, roundPlannerMinutes: false, planData, stub: true, http, onemap }))
  return { ask, calls }
}

// A OneMap double that answers 20 minutes for every trip and says which areas it was asked to route.
//
// How to call:
//   const { ask, routedAreas } = await routingOnRecording()
async function routingOnRecording() {
  const routed = []
  const onemap = {
    routingEnabled: true,
    routeMinutes: async (a, b) => {
      routed.push(a.id ?? b.id)
      return 20
    },
  }
  const ask = await serve(createApp({ frontendOrigin: FRONTEND, roundPlannerMinutes: false, planData, http: createHttp({ stub: true }), onemap }))
  return { ask, routedAreas: () => [...new Set(routed)], tripCount: () => routed.length }
}

// A small seeded random generator, so the groups below are the same on every run.
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
const TRIO = [
  { id: 'ian', name: 'Ian', home: { lat: 1.3541, lng: 103.9446 } },
  { id: 'faith', name: 'Faith', home: { lat: 1.315, lng: 103.765 } },
  { id: 'jonathan', name: 'Jonathan', home: { lat: 1.437, lng: 103.7865 } },
]

// What the station rule gives with the engine's estimate and no routing, worked out here from the formula:
// every area, best first (shortest longest trip, then the lower mean). A member's travel debt is 0 in these groups,
// so the fairness-weighted mean is the plain mean.
//
// How to call:
//   const ids = estimateRanking(TRIO).map((r) => r.id) // ['ang-mo-kio', 'bishan', ...]
const estimateRanking = (members) =>
  AREAS.map((a) => {
    const t = members.map((m) => mockTravelMinutes(m.home, a))
    return { id: a.id, worst: Math.max(...t), mean: t.reduce((x, y) => x + y, 0) / t.length }
  }).sort((x, y) => x.worst - y.worst || x.mean - y.mean)

// The n areas that rank last for a group with the engine's estimate: far outside the 16 nearest its ranking compares.
const farthest = (members, n) => estimateRanking(members).slice(-n).map((r) => r.id)

// The answer without candidates, diagnostics and travel: what must not depend on the new fields.
const topLevel = ({ candidates, diagnostics, travel, ...rest }) => rest

// ---------------------------------------------------------------- the request fields
describe('alternatives and include: what the request may send', () => {
  it('accepts 0 to 3 alternatives and up to 8 distinct known areas', async () => {
    const ask = await routingOff()
    for (const alternatives of [0, 1, 2, 3]) expect((await ask({ members: TRIO, alternatives })).status).toBe(200)
    const eight = AREAS.slice(0, 8).map((a) => a.id)
    expect((await ask({ members: TRIO, include: eight })).status).toBe(200)
    expect((await ask({ members: TRIO, include: [] })).status).toBe(200)
  })

  it('refuses alternatives that are negative, above 3, not whole, text, null or a list, naming the field', async () => {
    const ask = await routingOff()
    for (const alternatives of [-1, 4, 1.5, '2', null, [1], { n: 1 }, true]) {
      const { status, body } = await ask({ members: TRIO, alternatives })
      expect(status, JSON.stringify(alternatives)).toBe(400)
      expect(body.error).toBe('invalid_input')
      expect(body.issues.map((i) => i.path)).toEqual(['alternatives'])
    }
  })

  it('refuses nine areas, naming the field', async () => {
    const ask = await routingOff()
    const nine = AREAS.slice(0, 9).map((a) => a.id)
    const { status, body } = await ask({ members: TRIO, include: nine })
    expect(status).toBe(400)
    expect(body.error).toBe('invalid_input')
    expect(body.issues.map((i) => i.path)).toEqual(['include'])
  })

  it('refuses a repeated area id, and says which entry is the repeat', async () => {
    const ask = await routingOff()
    const { status, body } = await ask({ members: TRIO, include: ['bishan', 'tampines', 'bishan'] })
    expect(status).toBe(400)
    expect(body).toEqual({
      error: 'invalid_input',
      message: 'Some fields in the request are missing or not valid. See issues.',
      issues: [{ path: 'include.2', message: 'each area can be included once' }],
    })
  })

  it('refuses an unknown area id with the same body shape as every other validation error', async () => {
    const ask = await routingOff()
    const { status, body } = await ask({ members: TRIO, include: ['bishan', 'atlantis'] })
    expect(status).toBe(400)
    expect(body).toEqual({
      error: 'invalid_input',
      message: 'Some fields in the request are missing or not valid. See issues.',
      issues: [{ path: 'include.1', message: 'not an area id the planner knows' }],
    })
    // The same shape as an error on another field of this route.
    const other = await ask({ members: [] })
    expect(Object.keys(other.body).sort()).toEqual(Object.keys(body).sort())
  })

  it('refuses ids that are not strings, are empty, or are too long, and an include that is not a list', async () => {
    const ask = await routingOff()
    for (const include of [[5], [null], [{}], [['bishan']], [''], ['x'.repeat(81)], 'bishan', 5, { 0: 'bishan' }]) {
      const { status, body } = await ask({ members: TRIO, include })
      expect(status, JSON.stringify(include)).toBe(400)
      expect(body.error).toBe('invalid_input')
      expect(body.issues.every((i) => i.path === 'include' || i.path.startsWith('include.'))).toBe(true)
    }
  })

  it('lists every bad field together', async () => {
    const ask = await routingOff()
    const { body } = await ask({ members: TRIO, alternatives: 9, include: ['atlantis'] })
    expect(body.issues.map((i) => i.path).sort()).toEqual(['alternatives', 'include.0'])
  })

  it('an area id is matched exactly: not by name, not by letter case', async () => {
    const ask = await routingOff()
    for (const id of ['Bishan', 'BISHAN', ' bishan', 'Ang Mo Kio']) {
      expect((await ask({ members: TRIO, include: [id] })).status, id).toBe(400)
    }
  })

  it('both bounds are enforced: 3 alternatives and 8 areas pass, one more of either is refused', async () => {
    const ask = await routingOff()
    const ids = AREAS.map((a) => a.id)
    expect((await ask({ members: TRIO, alternatives: 3, include: ids.slice(0, 8) })).status).toBe(200)
    const tooMany = await ask({ members: TRIO, alternatives: 4, include: ids.slice(0, 9) })
    expect(tooMany.status).toBe(400)
    expect(tooMany.body.issues.map((i) => i.path).sort()).toEqual(['alternatives', 'include'])
  })
})

// ---------------------------------------------------------------- what the answer holds
describe('candidates: when they appear', () => {
  it('is absent when neither field is sent, with routing off and on', async () => {
    const off = await routingOff()
    const { ask: on } = await routingOn()
    for (const ask of [off, on]) {
      for (const method of ['station', 'centroid', 'weighted_centroid', 'minimax']) {
        const { status, body } = await ask({ members: TRIO, method, dateTime: WHEN })
        expect(status).toBe(200)
        expect(body).not.toHaveProperty('candidates')
        expect(body.diagnostics).not.toHaveProperty('extraRoutingCalls')
      }
    }
  })

  it('is there when either field is sent, even as alternatives 0 or an empty include: just the chosen area', async () => {
    const ask = await routingOff()
    for (const extra of [{ alternatives: 0 }, { include: [] }, { alternatives: 0, include: [] }]) {
      const { body } = await ask({ members: TRIO, ...extra })
      expect(body.candidates).toHaveLength(1)
      expect(body.candidates[0].area.id).toBe(body.area.id)
      expect(body.candidates[0].source).toBe('ranked')
    }
  })

  it('each candidate has exactly the documented fields, in order', async () => {
    const ask = await routingOff()
    const { body } = await ask({ members: TRIO, alternatives: 1, include: ['tampines'] })
    for (const c of body.candidates) {
      expect(Object.keys(c)).toEqual(['area', 'worstMinutes', 'meanMinutes', 'travelByMember', 'approximate', 'source'])
      expect(Object.keys(c.area)).toEqual(['id', 'name', 'lat', 'lng'])
      expect(Object.keys(c.travelByMember)).toEqual(['ian', 'faith', 'jonathan'])
    }
  })
})

describe('candidates: the chosen area comes first and is the top-level answer', () => {
  const METHODS = ['station', 'weighted_centroid', 'centroid', 'minimax']

  it('candidates[0] equals the top-level area, worstMinutes, meanMinutes and travelByMember, for every method', async () => {
    const off = await routingOff()
    const { ask: on } = await routingOn()
    for (const [label, ask] of [['off', off], ['on', on]]) {
      for (const method of METHODS) {
        const { body } = await ask({ members: TRIO, method, alternatives: 3, include: ['jurong-east'], dateTime: WHEN })
        const first = body.candidates[0]
        const where = `${label} ${method}`
        expect(first.area, where).toEqual(body.area)
        expect(first.worstMinutes, where).toBe(body.worstMinutes)
        expect(first.meanMinutes, where).toBe(body.meanMinutes)
        expect(first.travelByMember, where).toEqual(body.travelByMember)
        expect(first.source, where).toBe('ranked')
        // The flags are not the same thing (documented in planner-api.md). The top-level one is true when ANY trip
        // the ranking asked about used the estimate, so it is true whenever the chosen area's own flag is. The
        // chosen area's flag is about its own trips only. For a method other than station the top level measures
        // the centre, which is the chosen area's journey, so there the two are equal.
        if (first.approximate) expect(body.approximate, where).toBe(true)
        if (method !== 'station') expect(first.approximate, where).toBe(body.approximate)
        if (label === 'off') expect([first.approximate, body.approximate], where).toEqual([false, false])
        // Routing on, station: the chosen area was routed for every member and areas outside the shortlist were not.
        if (label === 'on' && method === 'station') expect([first.approximate, body.approximate], where).toEqual([false, true])
      }
    }
  })

  it('asking for candidates never changes the top-level answer (area, centre, times, approximate), with routing off and on', async () => {
    const off = await routingOff()
    const members = TRIO
    const withFields = { alternatives: 3, include: ['jurong-east', 'tampines', 'woodlands'] }
    for (const method of METHODS) {
      for (const getAsk of [() => off, async () => (await routingOn()).ask]) {
        // A fresh app for each request, so the route cache of one cannot change the other.
        const [plain, rich] = [await getAsk(), await getAsk()]
        const base = (await plain({ members, method, dateTime: WHEN })).body
        const asked = (await rich({ members, method, dateTime: WHEN, ...withFields })).body
        expect(topLevel(asked), method).toEqual(topLevel(base))
        expect(asked.diagnostics.routingCalls, method).toBe(base.diagnostics.routingCalls)
        expect(asked.diagnostics.approximateLegs, method).toBe(base.diagnostics.approximateLegs)
      }
    }
  })

  it('the top-level answer is unchanged for a bigger group squeezed by the cap', async () => {
    const members = groupOf(20, 5)
    const [plain, rich] = [(await routingOn()).ask, (await routingOn()).ask]
    const base = (await plain({ members, dateTime: WHEN })).body
    const asked = (await rich({ members, dateTime: WHEN, alternatives: 3, include: farthest(members, 3) })).body
    expect(topLevel(asked)).toEqual(topLevel(base))
  })

  it('candidates[0].approximate is about the chosen area alone: it can be false when the top-level flag is true', async () => {
    // The top-level flag is true when ANY area the ranking compared used an estimate. The chosen area's own trips
    // were all routed here, so its candidate says false. Documented in planner-api.md.
    const { ask } = await routingOn()
    const { body } = await ask({ members: TRIO, alternatives: 1, dateTime: WHEN })
    expect(body.approximate).toBe(true)
    expect(body.candidates[0].approximate).toBe(false)
  })
})

describe('candidates: runners-up', () => {
  it('with routing off they are the station rule\'s next best areas, in order, never repeating the chosen one', async () => {
    const ask = await routingOff()
    const expected = estimateRanking(TRIO).map((r) => r.id)
    for (const alternatives of [0, 1, 2, 3]) {
      const { body } = await ask({ members: TRIO, alternatives })
      const ids = body.candidates.map((c) => c.area.id)
      expect(ids, `alternatives ${alternatives}`).toEqual(expected.slice(0, alternatives + 1))
      expect(new Set(ids).size).toBe(ids.length)
      expect(ids[0]).toBe(body.area.id)
      body.candidates.forEach((c) => expect(c.source).toBe('ranked'))
    }
  })

  it('their numbers are worked out the same way as the chosen area\'s', async () => {
    const ask = await routingOff()
    const { body } = await ask({ members: TRIO, alternatives: 3 })
    for (const c of body.candidates) {
      const area = AREAS.find((a) => a.id === c.area.id)
      const times = TRIO.map((m) => mockTravelMinutes(m.home, area))
      expect(c.travelByMember).toEqual(Object.fromEntries(TRIO.map((m, i) => [m.id, times[i]])))
      expect(c.worstMinutes).toBe(Math.max(...times))
      expect(c.meanMinutes).toBeCloseTo(times.reduce((x, y) => x + y, 0) / times.length, 9)
      expect(c.approximate).toBe(false)
    }
  })

  it('with routing on the list is still best first by longest trip, and has the chosen area first', async () => {
    const { ask } = await routingOn()
    const { body } = await ask({ members: TRIO, alternatives: 3, dateTime: WHEN })
    const worst = body.candidates.map((c) => c.worstMinutes)
    expect(worst).toEqual([...worst].sort((x, y) => x - y))
    expect(body.candidates).toHaveLength(4)
    expect(new Set(body.candidates.map((c) => c.area.id)).size).toBe(4)
  })

  it('there are fewer when the ranking compares fewer areas (maxCandidates 2 gives the chosen area and one more)', async () => {
    const ask = await routingOff()
    const { body } = await ask({ members: TRIO, alternatives: 3, maxCandidates: 2 })
    expect(body.candidates).toHaveLength(2)
  })

  it('opted-out members and overrides count in every candidate, as they do for the chosen area', async () => {
    const ask = await routingOff()
    const { body } = await ask({
      members: TRIO,
      optedOut: ['faith'],
      overrides: { jonathan: { start: { lat: 1.3, lng: 103.85 } } },
      alternatives: 2,
      include: ['jurong-east'],
    })
    for (const c of body.candidates) expect(Object.keys(c.travelByMember).sort()).toEqual(['ian', 'jonathan'])
    const jonathan = { lat: 1.3, lng: 103.85 }
    const area = AREAS.find((a) => a.id === body.candidates[1].area.id)
    expect(body.candidates[1].travelByMember.jonathan).toBe(mockTravelMinutes(jonathan, area))
  })
})

describe('candidates: included areas', () => {
  it('an included area appears even when it ranks last, with source included, after the ranked ones', async () => {
    const ask = await routingOff()
    const ranking = estimateRanking(TRIO)
    const last = ranking[ranking.length - 1].id
    const { body } = await ask({ members: TRIO, alternatives: 2, include: [last] })
    expect(body.candidates.map((c) => [c.area.id, c.source])).toEqual([
      [ranking[0].id, 'ranked'],
      [ranking[1].id, 'ranked'],
      [ranking[2].id, 'ranked'],
      [last, 'included'],
    ])
    const area = AREAS.find((a) => a.id === last)
    expect(body.candidates[3].worstMinutes).toBe(Math.max(...TRIO.map((m) => mockTravelMinutes(m.home, area))))
  })

  it('included areas follow the ranked ones in the order sent', async () => {
    const ask = await routingOff()
    const ranking = estimateRanking(TRIO)
    const [a, b, c] = [ranking[30].id, ranking[10].id, ranking[20].id]
    const { body } = await ask({ members: TRIO, include: [a, b, c] })
    expect(body.candidates.map((x) => x.area.id)).toEqual([ranking[0].id, a, b, c])
    expect(body.candidates.slice(1).map((x) => x.source)).toEqual(['included', 'included', 'included'])
  })

  it('an included area that is the chosen area or a returned runner-up appears once, as ranked, in its ranked place', async () => {
    const ask = await routingOff()
    const ranking = estimateRanking(TRIO).map((r) => r.id)
    const { body } = await ask({ members: TRIO, alternatives: 2, include: [ranking[2], ranking[0], ranking[9]] })
    expect(body.candidates.map((c) => [c.area.id, c.source])).toEqual([
      [ranking[0], 'ranked'],
      [ranking[1], 'ranked'],
      [ranking[2], 'ranked'],
      [ranking[9], 'included'],
    ])
  })

  it('an included area that ranks just below the returned runners-up is still included, as included', async () => {
    const ask = await routingOff()
    const ranking = estimateRanking(TRIO).map((r) => r.id)
    const { body } = await ask({ members: TRIO, alternatives: 1, include: [ranking[2]] })
    expect(body.candidates.map((c) => [c.area.id, c.source])).toEqual([
      [ranking[0], 'ranked'],
      [ranking[1], 'ranked'],
      [ranking[2], 'included'],
    ])
  })

  it('an included area outside the 16 nearest that routing tries is still evaluated, and gets real routes when there is room', async () => {
    const { ask, calls } = await routingOn()
    const farthest = estimateRanking(TRIO)
      .slice(-3)
      .map((r) => r.id)
    const base = await (await routingOn()).ask({ members: TRIO, dateTime: WHEN })
    const { body } = await ask({ members: TRIO, include: farthest, dateTime: WHEN })
    expect(body.candidates.map((c) => c.area.id)).toEqual([body.area.id, ...farthest])
    // They are outside the areas the ranking compares: measured aside, 3 members each.
    expect(body.diagnostics.extraRoutingCalls).toBe(3 * TRIO.length)
    expect(body.candidates.slice(1).every((c) => c.source === 'included')).toBe(true)
    // There was room under the cap, so they were routed for real and are not approximate.
    expect(body.candidates.slice(1).map((c) => c.approximate)).toEqual([false, false, false])
    expect(body.travel.routed).toBe(base.body.travel.routed + 3 * TRIO.length)
    expect(calls.route).toBe(body.travel.routed)
    // Estimates would have been these; real times are not.
    for (const c of body.candidates.slice(1)) {
      const area = AREAS.find((a) => a.id === c.area.id)
      for (const m of TRIO) expect(c.travelByMember[m.id]).not.toBeCloseTo(mockTravelMinutes(m.home, area), 6)
    }
  })

  it('an included area inside the areas tried but not in the routed few also gets real routes when there is room', async () => {
    const base = await routingOnRecording()
    await base.ask({ members: TRIO, dateTime: WHEN })
    const shortlist = base.routedAreas()
    expect(shortlist).toHaveLength(5)
    // The best area by estimate that the shortlist left out: inside the areas tried, so not measured aside.
    const left = estimateRanking(TRIO).map((r) => r.id).find((id) => !shortlist.includes(id))
    const named = await routingOnRecording()
    const { body } = await named.ask({ members: TRIO, include: [left], dateTime: WHEN })
    expect(body.diagnostics.extraRoutingCalls).toBe(0) // premise: it was among the areas tried
    expect(named.routedAreas().sort()).toEqual([...shortlist, left].sort())
    const included = body.candidates.find((c) => c.area.id === left)
    expect(included.source).toBe('included')
    expect(included.approximate).toBe(false)
  })
})

describe('candidates: methods other than station', () => {
  for (const method of ['centroid', 'weighted_centroid', 'minimax']) {
    it(`${method}: candidates[0] is the area named after the centre; runners-up are the station rule's, without it`, async () => {
      const ask = await routingOff()
      const { body } = await ask({ members: TRIO, method, alternatives: 3 })
      expect(body.method).toBe(method)
      expect(body.candidates).toHaveLength(4)
      expect(body.candidates[0].area).toEqual(body.area)
      expect(body.candidates[0].worstMinutes).toBe(body.worstMinutes) // measured to the centre, as the top level is
      const expected = estimateRanking(TRIO)
        .map((r) => r.id)
        .filter((id) => id !== body.area.id)
        .slice(0, 3)
      expect(body.candidates.slice(1).map((c) => c.area.id)).toEqual(expected)
      expect(body.candidates.slice(1).every((c) => c.source === 'ranked')).toBe(true)
    })
  }

  it('without alternatives only the included areas are measured: no ranking is done', async () => {
    const ask = await routingOff()
    const { body } = await ask({ members: TRIO, method: 'centroid', include: ['tampines'] })
    expect(body.candidates.map((c) => [c.area.id, c.source])).toEqual([[body.area.id, 'ranked'], ['tampines', 'included']])
    expect(body.diagnostics.extraRoutingCalls).toBe(TRIO.length)
  })

  it('with routing on, a method other than station tries 16 areas for its runners-up, not 37', async () => {
    const { ask } = await routingOn()
    const { body } = await ask({ members: TRIO, method: 'centroid', alternatives: 3, dateTime: WHEN })
    expect(body.diagnostics.extraRoutingCalls).toBe(16 * TRIO.length)
  })

  it('an included area that is the centre\'s own area is listed once, as ranked', async () => {
    const ask = await routingOff()
    const { body: first } = await ask({ members: TRIO, method: 'centroid' })
    const { body } = await ask({ members: TRIO, method: 'centroid', include: [first.area.id] })
    expect(body.candidates).toHaveLength(1)
    expect(body.candidates[0].source).toBe('ranked')
  })
})

// ---------------------------------------------------------------- the cap on OneMap trips
describe('OneMap trips for one request stay at or under the cap, whole areas only', () => {
  it('30 members, alternatives 3 and 8 included areas: at most 60 route calls', async () => {
    const members = groupOf(30)
    const widest = { members, alternatives: 3, include: farthest(members, 8), dateTime: WHEN }
    for (const method of ['station', 'centroid', 'weighted_centroid']) {
      const { ask, calls } = await routingOn()
      const { status, body } = await ask({ ...widest, method })
      expect(status).toBe(200)
      expect(calls.route, method).toBeGreaterThan(0)
      expect(calls.route, method).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
      expect(body.travel.routed, method).toBe(calls.route)
      expect(body.travel.asked, method).toBeGreaterThan(MAX_ROUTED_TRIPS_PER_REQUEST) // the cap really did bite
      expect(body.travel.routed + body.travel.cached + body.travel.walked + body.travel.failed + body.travel.estimated).toBe(body.travel.asked)
      expect(body.candidates.length).toBeGreaterThanOrEqual(1 + 8)
      console.info(`route calls, 30 members, ${method}, alternatives 3, 8 included: ${calls.route} (asked ${body.travel.asked})`)
    }
  })

  it('30 members, widest settings including maxCandidates 37: still at most 60', async () => {
    const members = groupOf(30)
    const { ask, calls } = await routingOn()
    const { body } = await ask({ members, maxCandidates: 37, alternatives: 3, include: farthest(members, 8), dateTime: WHEN })
    expect(calls.route).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    expect(body.travel.routed).toBe(calls.route)
  })

  it('other group sizes stay under it too', async () => {
    for (const size of [3, 10, 12, 20, 25]) {
      const members = groupOf(size, size)
      const { ask, calls } = await routingOn()
      const { status } = await ask({ members, alternatives: 3, include: farthest(members, 8), dateTime: WHEN })
      expect(status).toBe(200)
      expect(calls.route, `${size} members`).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    }
  })

  it('a repeat request is cheaper, not dearer: cached trips are free, and its own calls still stay under the cap', async () => {
    const members = groupOf(10)
    const { ask, calls } = await routingOn()
    const body = { members, alternatives: 3, include: farthest(members, 4), dateTime: WHEN }
    const first = await ask(body)
    const afterFirst = calls.route
    const again = await ask(body)
    // Trips already answered cost nothing, so room under the cap goes to areas the first request had to estimate.
    expect(again.body.travel.cached).toBeGreaterThanOrEqual(first.body.travel.routed)
    expect(calls.route - afterFirst).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    expect(again.body.travel.routed).toBe(calls.route - afterFirst)
    const approximate = (r) => r.body.candidates.filter((c) => c.approximate).length
    expect(approximate(again)).toBeLessThanOrEqual(approximate(first))
  })

  it('30 members: an area that did not fit is estimated for every member and flagged, a routed one is real for every member and is not', async () => {
    const members = groupOf(30)
    const { ask } = await routingOn()
    const { body } = await ask({ members, alternatives: 3, include: farthest(members, 8), dateTime: WHEN })
    const seen = new Set()
    for (const c of body.candidates) {
      const area = AREAS.find((a) => a.id === c.area.id)
      const kinds = new Set(
        members.map((m) => (Math.abs(c.travelByMember[m.id] - mockTravelMinutes(m.home, area)) < 1e-9 ? 'estimate' : 'real')),
      )
      expect(kinds.size, c.area.id).toBe(1) // never half and half
      seen.add([...kinds][0])
      expect(c.approximate, c.area.id).toBe(kinds.has('estimate'))
    }
    expect(seen).toEqual(new Set(['estimate', 'real'])) // the request showed both kinds
    // 30 members cost 30 trips an area, so two areas fit.
    expect(body.candidates.filter((c) => !c.approximate)).toHaveLength(2)
  })

  it('with room for everything, no candidate is approximate', async () => {
    const { ask } = await routingOn()
    const { body } = await ask({ members: TRIO, alternatives: 3, include: ['tampines', 'jurong-east'], dateTime: WHEN })
    expect(body.candidates).toHaveLength(6)
    expect(body.candidates.map((c) => c.approximate)).toEqual([false, false, false, false, false, false])
  })
})

describe('the order areas are routed in', () => {
  it('the shortlist of five comes first, as without the new fields; included areas follow, in the order sent, while there is room', async () => {
    // 10 members: 6 areas fit the 60 trips. Five are the shortlist, so only the first included area is routed.
    const members = groupOf(10)
    const [x, y] = farthest(members, 2)
    const base = await routingOnRecording()
    await base.ask({ members, dateTime: WHEN })
    const shortlist = base.routedAreas()
    expect(shortlist).toHaveLength(5)

    const named = await routingOnRecording()
    const { body } = await named.ask({ members, alternatives: 2, include: [x, y], dateTime: WHEN })
    expect(named.routedAreas().sort()).toEqual([...shortlist, x].sort())
    expect(named.tripCount()).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    const byId = Object.fromEntries(body.candidates.map((c) => [c.area.id, c]))
    expect(byId[x].approximate).toBe(false)
    expect(byId[y].approximate).toBe(true)
  })

  it('a full cap routes the shortlist and nothing named: the chosen area and the runners-up come first', async () => {
    // 12 members: 5 areas are exactly 60 trips.
    const members = groupOf(12, 3)
    const [x] = farthest(members, 1)
    const base = await routingOnRecording()
    const baseAnswer = await base.ask({ members, dateTime: WHEN })
    const named = await routingOnRecording()
    const { body } = await named.ask({ members, alternatives: 3, include: [x], dateTime: WHEN })
    expect(named.routedAreas().sort()).toEqual(base.routedAreas().sort())
    expect(named.tripCount()).toBe(60)
    expect(body.candidates.find((c) => c.area.id === x).approximate).toBe(true)
    expect(topLevel(body)).toEqual(topLevel(baseAnswer.body))
  })

  it('a method other than station routes its own meeting point first, then the shortlist, then the named areas', async () => {
    // 20 members: 3 routes fit. The meeting point is the answer itself, so it is routed whatever else is asked.
    const members = groupOf(20, 5)
    const base = await routingOnRecording()
    const baseAnswer = await base.ask({ members, method: 'centroid', dateTime: WHEN })
    expect(baseAnswer.body.approximate).toBe(false)
    const named = await routingOnRecording()
    const { body } = await named.ask({ members, method: 'centroid', alternatives: 3, include: farthest(members, 2), dateTime: WHEN })
    expect(topLevel(body)).toEqual(topLevel(baseAnswer.body))
    expect(body.candidates[0].approximate).toBe(false)
    expect(named.tripCount()).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
    expect(named.tripCount()).toBe(60)
  })
})

// ---------------------------------------------------------------- failure
describe('when routing fails', () => {
  it('every candidate is flagged approximate and the answer is still given (stub scenario routing-fail)', async () => {
    const ask = await serve(createApp({ frontendOrigin: FRONTEND, roundPlannerMinutes: false, planData, stub: true }))
    const { status, body } = await ask(
      { members: TRIO, alternatives: 2, include: ['tampines'], dateTime: WHEN },
      { [SCENARIO_HEADER]: 'routing-fail' },
    )
    expect(status).toBe(200)
    expect(body.travel.source).toBe('estimate')
    expect(body.candidates).toHaveLength(4)
    body.candidates.forEach((c) => expect(c.approximate).toBe(true))
  })
})

// ---------------------------------------------------------------- the engine on its own
describe('meetingArea() directly', () => {
  const input = { members: TRIO }

  it('adds candidates only when asked, and the rest of the answer does not change', () => {
    const base = meetingArea(input, planData)
    const asked = meetingArea({ ...input, alternatives: 2, include: ['tampines'] }, planData)
    expect(base).not.toHaveProperty('candidates')
    expect(topLevel(asked)).toEqual(topLevel(base))
    expect(asked.candidates).toHaveLength(4)
  })

  it('throws on an area id that is not in the data, which the route has already refused', () => {
    expect(() => meetingArea({ ...input, include: ['atlantis'] }, planData)).toThrow(/unknown area "atlantis"/)
  })

  it('a tie between two areas keeps the order they were tried in', () => {
    const twin = { id: 'twin', name: 'Twin', lat: planData.areas[0].lat, lng: planData.areas[0].lng }
    const data = { ...planData, areas: [planData.areas[0], twin] }
    const { candidates } = meetingArea({ members: TRIO, alternatives: 1 }, data)
    expect(candidates.map((c) => c.area.id)).toEqual([data.areas[0].id, 'twin'])
  })
})
