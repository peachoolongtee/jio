// POST /api/meeting-area: naming areas in `include` must never change the planner's own answer.
// The top-level answer and the ranked candidates are the same with and without `include`; `include` only adds
// entries with source 'included'. An included area still gets real routes when the cap has room, for its own entry.
// Nothing here touches the network: OneMap is a test double that answers from a function.
import { once } from 'node:events'
import { afterAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { meetingArea } from '../src/planner/engine.js'
import { mockTravelMinutes } from '../src/planner/geo.js'
import { createHttp } from '../src/services/http.js'
import { MAX_ROUTED_TRIPS_PER_REQUEST } from '../src/services/travel-times.js'

const FRONTEND = 'http://localhost:5173'
const WHEN = '2026-10-10T19:00'
const planData = loadPlanData()
const AREAS = planData.areas
const METHODS = ['station', 'weighted_centroid', 'centroid', 'minimax']
const FAST_MINUTES = 3 // far below any estimate, so an area that got these times would win a ranking

// ---------------------------------------------------------------- helpers
const servers = []
afterAll(() => Promise.all(servers.map((s) => new Promise((resolve) => s.close(resolve)))))

// Starts an app and returns a function that posts to its meeting-area route.
//
// How to call:
//   const ask = await serve(createApp({ frontendOrigin: FRONTEND, planData, http, onemap }))
//   const { status, body } = await ask({ members, alternatives: 2 })
async function serve(app) {
  const server = app.listen(0, '127.0.0.1')
  servers.push(server)
  await once(server, 'listening')
  const base = `http://127.0.0.1:${server.address().port}`
  return async (body) => {
    const res = await fetch(`${base}/api/meeting-area`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    return { status: res.status, body: await res.json() }
  }
}

// An app with no OneMap service: every time is the engine's estimate.
const routingOff = () => serve(createApp({ frontendOrigin: FRONTEND, planData, http: createHttp({ stub: true }) }))

// An app whose OneMap is a double. `minutesFor(areaId, from, to)` is the time it answers for a trip to or from
// that area. `log` has one area id per route call, in call order. The double has no cache and walks nobody.
//
// How to call:
//   const { ask, log } = await routingOnWith((id, a, b) => (id === 'bishan' ? 3 : 40))
async function routingOnWith(minutesFor) {
  const log = []
  const onemap = {
    routingEnabled: true,
    routeMinutes: async (a, b) => {
      const id = a.id ?? b.id
      log.push(id)
      return minutesFor(id, a, b)
    },
  }
  const ask = await serve(createApp({ frontendOrigin: FRONTEND, planData, http: createHttp({ stub: true }), onemap }))
  return { ask, log }
}

// Real times that are 1.4 times the estimate everywhere, except one area, where they are very fast.
const slowExceptFast = (fastId) => (id, a, b) => (id === fastId ? FAST_MINUTES : mockTravelMinutes(a, b) * 1.4)

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

// Every area, best first by the engine's estimate: shortest longest trip, then the lower mean.
const estimateRanking = (members) =>
  AREAS.map((a) => {
    const t = members.map((m) => mockTravelMinutes(m.home, a))
    return { id: a.id, worst: Math.max(...t), mean: t.reduce((x, y) => x + y, 0) / t.length }
  }).sort((x, y) => x.worst - y.worst || x.mean - y.mean)

// What must not depend on `include`: the top-level answer, the engine's own counts, and the ranked candidates.
// Compared as whole objects. `travel` and `diagnostics.extraRoutingCalls` are left out on purpose: they count the
// extra areas' trips, as documented.
const planners = (body) => {
  const { candidates, diagnostics, travel, ...top } = body
  return {
    top,
    routingCalls: diagnostics.routingCalls,
    approximateLegs: diagnostics.approximateLegs,
    ranked: (candidates ?? []).filter((c) => c.source === 'ranked'),
  }
}

// ---------------------------------------------------------------- a fast included area
describe('an included area with fast real times does not change the answer', () => {
  const state = { fastId: '' }
  const FAST_AREA_RANKS = Array.from({ length: 11 }, (_, i) => i + 5) // the 6th to the 16th by estimate

  for (const size of [2, 5, 12]) {
    it(`${size} members: every method, the area at every rank from 6th to 16th`, async () => {
      const members = groupOf(size, 40 + size)
      const ranking = estimateRanking(members).map((r) => r.id)
      const { ask, log } = await routingOnWith((id, a, b) => slowExceptFast(state.fastId)(id, a, b))
      for (const method of METHODS) {
        for (const rank of FAST_AREA_RANKS) {
          state.fastId = ranking[rank]
          const where = `${size} members, ${method}, area ranked ${rank + 1}th (${state.fastId})`
          const request = { members, method, alternatives: 3, dateTime: WHEN }

          log.length = 0
          const without = (await ask(request)).body
          const routedWithout = new Set(log)
          const withInclude = (await ask({ ...request, include: [state.fastId] })).body

          expect(planners(withInclude), where).toEqual(planners(without))

          const entry = withInclude.candidates.find((c) => c.area.id === state.fastId)
          const asRanked = without.candidates.some((c) => c.area.id === state.fastId)
          if (asRanked) {
            // It was one of the ranked areas without `include` too: one entry, as ranked, with the figures the ranking used.
            expect(entry.source, where).toBe('ranked')
            expect(entry, where).toEqual(without.candidates.find((c) => c.area.id === state.fastId))
            continue
          }
          expect(entry.source, where).toBe('included')
          if (size < 12 || routedWithout.has(state.fastId)) {
            // There was room under the cap (or the ranking routed it anyway): its own entry carries the real minutes.
            expect(entry.approximate, where).toBe(false)
            expect(entry.worstMinutes, where).toBe(FAST_MINUTES)
            expect(entry.meanMinutes, where).toBe(FAST_MINUTES)
            expect(Object.values(entry.travelByMember), where).toEqual(members.map(() => FAST_MINUTES))
          } else {
            // 12 members: five areas already use all 60 trips, so this one is estimated for every member and says so.
            expect(entry.approximate, where).toBe(true)
            const area = AREAS.find((a) => a.id === state.fastId)
            expect(entry.travelByMember, where).toEqual(
              Object.fromEntries(members.map((m) => [m.id, mockTravelMinutes(m.home, area)])),
            )
          }
        }
      }
    })
  }

  it('the premise holds: given to the ranking, those times would make the area the chosen one', () => {
    // Without this the tests above could pass for the wrong reason.
    const members = groupOf(5, 45)
    const fast = estimateRanking(members)[8].id
    const travelMinutes = (a, b) => slowExceptFast(fast)(a.id ?? b.id, a, b)
    const answer = meetingArea({ members, maxCandidates: 16 }, planData, { travelMinutes })
    expect(answer.area.id).toBe(fast)
    expect(answer.worstMinutes).toBe(FAST_MINUTES)
  })
})

// ---------------------------------------------------------------- a property over many groups
describe('include never changes the answer: random groups', () => {
  const SEEDS = Array.from({ length: 220 }, (_, i) => i + 1)

  // Real times between 0.3 and 1.6 times the estimate, fixed per area, so some areas are faster than their estimate.
  const factorOf = (id) => {
    let h = 7
    // A trip to the meeting point of another method has no area id.
    for (const ch of id ?? 'centre') h = (Math.imul(h, 31) + ch.charCodeAt(0)) | 0
    return 0.3 + (((h >>> 0) % 1300) / 1000)
  }

  for (const routing of ['off', 'on']) {
    it(`${SEEDS.length} seeds, routing ${routing}: top level and ranked candidates are the same with and without include`, async () => {
      const { ask, log } = routing === 'on' ? await routingOnWith((id, a, b) => mockTravelMinutes(a, b) * factorOf(id)) : { ask: await routingOff(), log: [] }
      let checked = 0
      let withIncludedEntries = 0
      for (const seed of SEEDS) {
        const rand = rng(seed * 7919)
        const size = 2 + Math.floor(rand() * 11)
        const members = groupOf(size, seed)
        const method = METHODS[Math.floor(rand() * METHODS.length)]
        const alternatives = Math.floor(rand() * 4)
        const pool = AREAS.map((a) => a.id)
        const include = []
        for (let n = 1 + Math.floor(rand() * 8); n > 0; n--) include.push(pool.splice(Math.floor(rand() * pool.length), 1)[0])
        const where = `seed ${seed}, ${size} members, ${method}, alternatives ${alternatives}, include ${include.join(',')}`
        const request = { members, method, alternatives, dateTime: WHEN }

        const without = await ask(request)
        const before = log.length
        const withInclude = await ask({ ...request, include })
        expect(without.status, where).toBe(200)
        expect(withInclude.status, where).toBe(200)
        expect(planners(withInclude.body), where).toEqual(planners(without.body))
        expect(log.length - before, where).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)

        // Ranked first, in the same order; then only included areas, each once, in the order sent.
        const rankedIds = without.body.candidates.map((c) => c.area.id)
        const rest = withInclude.body.candidates.slice(rankedIds.length)
        expect(withInclude.body.candidates.slice(0, rankedIds.length), where).toEqual(without.body.candidates)
        expect(rest.every((c) => c.source === 'included'), where).toBe(true)
        expect(rest.map((c) => c.area.id), where).toEqual(include.filter((id) => !rankedIds.includes(id)))
        checked += 1
        withIncludedEntries += rest.length
      }
      expect(checked).toBe(SEEDS.length)
      expect(withIncludedEntries).toBeGreaterThan(SEEDS.length) // the property really did see included entries
    })
  }
})

// ---------------------------------------------------------------- ranked and included
describe('an area that is both ranked and included', () => {
  it('appears once, as ranked, with the figures the ranking used', async () => {
    const members = groupOf(4, 11)
    const ranking = estimateRanking(members).map((r) => r.id)
    const { ask } = await routingOnWith(slowExceptFast(ranking[9]))
    const request = { members, alternatives: 2, dateTime: WHEN }
    const without = (await ask(request)).body
    const ids = without.candidates.map((c) => c.area.id)
    expect(ids).toHaveLength(3)
    // The chosen area, a runner-up, and one more area, each named in a different order from the ranking.
    const { body } = await ask({ ...request, include: [ids[2], ranking[9], ids[0], ids[1]] })
    expect(body.candidates.map((c) => c.area.id).filter((id) => ids.includes(id))).toEqual(ids)
    expect(new Set(body.candidates.map((c) => c.area.id)).size).toBe(body.candidates.length)
    expect(body.candidates.slice(0, 3)).toEqual(without.candidates)
    expect(body.candidates.slice(0, 3).map((c) => c.source)).toEqual(['ranked', 'ranked', 'ranked'])
    expect(body.candidates.slice(3).map((c) => [c.area.id, c.source])).toEqual([[ranking[9], 'included']])
  })

  it('a routed area the ranking compared but did not return is included with the same real figures', async () => {
    const members = groupOf(3, 12)
    const { ask } = await routingOnWith((id, a, b) => mockTravelMinutes(a, b) * 1.4)
    const request = { members, alternatives: 1, dateTime: WHEN }
    const without = (await ask(request)).body
    // The best areas by estimate are routed (a shortlist of five), so the third ranked is routed too.
    const third = estimateRanking(members)[2].id
    const { body } = await ask({ ...request, include: [third] })
    const entry = body.candidates.find((c) => c.area.id === third)
    expect(planners(body)).toEqual(planners(without))
    expect(entry.source).toBe('included')
    expect(entry.approximate).toBe(false)
  })
})

// ---------------------------------------------------------------- the cap
describe('the cap and the order, with the widest request', () => {
  it('30 members, 3 alternatives and 8 included areas: at most 60 route calls, ranked areas routed first', async () => {
    const members = groupOf(30)
    const ranking = estimateRanking(members).map((r) => r.id)
    const include = ranking.slice(-8)
    for (const method of ['station', 'centroid', 'weighted_centroid']) { // minimax takes up to 12 members
      const { ask, log } = await routingOnWith((id, a, b) => mockTravelMinutes(a, b) * 1.2)
      const request = { members, method, alternatives: 3, dateTime: WHEN }
      const without = await ask(request)
      const routedWithout = log.length
      const firstRoutedWithout = [...new Set(log)]
      log.length = 0
      const { status, body } = await ask({ ...request, include })
      expect(status, method).toBe(200)
      expect(log.length, method).toBeGreaterThan(0)
      expect(log.length, method).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
      expect(body.travel.routed, method).toBe(log.length)
      // Ranked before included: the areas routed are the ones the same request routed without `include`, in that order.
      expect([...new Set(log)], method).toEqual(firstRoutedWithout)
      expect(log.length, method).toBe(routedWithout)
      expect(planners(body), method).toEqual(planners(without.body))
      console.info(`route calls, 30 members, ${method}, alternatives 3, 8 included: ${log.length}`)
    }
  })

  it('with room, ranked areas are routed before any included one and included ones follow in the order sent', async () => {
    const members = groupOf(10, 3) // 6 areas of 10 trips fit the 60
    const ranking = estimateRanking(members).map((r) => r.id)
    const [x, y] = ranking.slice(-2)
    const { ask, log } = await routingOnWith((id, a, b) => mockTravelMinutes(a, b) * 1.2)
    await ask({ members, alternatives: 3, dateTime: WHEN })
    const shortlist = [...new Set(log)]
    expect(shortlist).toHaveLength(5)
    log.length = 0
    await ask({ members, alternatives: 3, include: [y, x], dateTime: WHEN })
    const order = [...new Set(log)]
    expect(order.slice(0, 5).sort()).toEqual([...shortlist].sort())
    expect(order[5]).toBe(y)
    expect(order).toHaveLength(6) // the cap leaves room for one more area only
    expect(log.length).toBeLessThanOrEqual(MAX_ROUTED_TRIPS_PER_REQUEST)
  })
})
