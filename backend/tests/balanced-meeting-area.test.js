// The balanced way to choose where a group meets (planner/balance.js): the weights from past travel, the gap between people,
// the cap on the longest trip, the labelled choices, and that a request without the new fields is answered exactly as before.
// Travel times are crafted by hand, so each rule is checked on numbers a person can read. Nothing touches the network.
import { once } from 'node:events'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createApp } from '../src/app.js'
import { loadPlanData } from '../src/db/venues.js'
import { BALANCE, balanceWeights, choicesOf, measure, pickBalanced, rankBalanced } from '../src/planner/balance.js'
import { converge, meetingArea } from '../src/planner/engine.js'
import { isOpenAt } from '../src/planner/filters.js'

// ---------------------------------------------------------------- the pure rule
describe('balanceWeights and measure', () => {
  it('weighs a person by their past travel, at most 3, and everyone 1 without any', () => {
    expect(balanceWeights([{}, { travelDebtMinutes: 0 }])).toEqual([1, 1])
    expect(balanceWeights([{ travelDebtMinutes: 60 }, { travelDebtMinutes: 600 }, { travelDebtMinutes: -50 }])).toEqual([2, BALANCE.maxWeight, 1])
    expect(balanceWeights([{ travelDebtMinutes: 30 }], 30)).toEqual([2])
  })

  it('measures the longest, the gap and the average of weighted trips', () => {
    expect(measure([18, 41, 41], [1, 1, 1])).toMatchObject({ longest: 41, gap: 23, realLongest: 41 })
    expect(measure([18, 41, 41], [1, 1, 1]).mean).toBeCloseTo(33.33, 1)
    expect(measure([20, 30], [3, 1])).toMatchObject({ burdens: [60, 30], longest: 60, gap: 30, realLongest: 30 })
  })
})

const entry = (id, travel, extra = {}) => ({ a: { id, name: id }, j: { travel, worst: Math.max(...travel), fairMean: travel.reduce((a, b) => a + b, 0) / travel.length, approximate: false, ...extra } })
const ones = (n) => Array(n).fill(1)

describe('pickBalanced', () => {
  it("keeps today's pick when another place has a smaller gap but a worse average", () => {
    // 42/32 (gap 10, average 37) against 41/42 (gap 1, average 41.5): the second costs the group 4.5 minutes on average.
    expect(pickBalanced([entry('caldecott', [42, 32]), entry('novena', [41, 42])], ones(2)).a.id).toBe('caldecott')
  })

  it('takes a more even place when it is as good for the longest trip and the average', () => {
    // Both 42 at the longest; 30/42 averages 36 against 33, which is inside the 10% (3.3 minutes) allowed; its gap is 12, not 18.
    expect(pickBalanced([entry('p', [24, 42]), entry('q', [30, 42])], ones(2)).a.id).toBe('q')
  })

  it('never trades a longer longest trip or a worse average for a smaller gap', () => {
    // 60/60 has gap 0 but is far over the cap; 24/25 has a smaller gap than 20/22 but its longest trip (25) is over 22 + 2.
    expect(pickBalanced([entry('short', [20, 22]), entry('even', [60, 60]), entry('mid', [24, 25])], ones(2)).a.id).toBe('short')
  })

  it('keeps places inside the slack on both: 5% or 2 minutes on the longest trip, 10% or 3 minutes on the average', () => {
    const base = entry('p', [20, 40]) // longest 40, average 30, gap 20: allowed up to a longest of 42 and an average of 33
    expect(pickBalanced([base, entry('q', [24, 42])], ones(2)).a.id).toBe('q') // 42 and 33: both on the edge, gap 18
    expect(pickBalanced([base, entry('r', [23, 43])], ones(2)).a.id).toBe('p') // longest 43: over
    expect(pickBalanced([base, entry('s', [30, 42])], ones(2)).a.id).toBe('p') // average 36: over
  })

  it('picks the place near the people it was worth reaching: your Tanah Merah, Lakeside and Simei group, real minutes', () => {
    // Real OneMap times for Aiyu and Ben (Tanah Merah), Chen (Lakeside) and Dina (Simei), 24 October 2026, 12:30.
    const seen = [entry('Somerset', [29, 35, 39, 34]), entry('Caldecott', [36, 42, 35, 40]), entry('Newton', [34, 40, 44, 38]), entry('Novena', [35, 41, 45, 40])]
    const w = ones(4)
    expect(pickBalanced(seen, w).a.id).toBe('Somerset') // not Caldecott: three people lose 7 minutes each to save Chen 4
    const wider = [...seen, entry('Dhoby Ghaut', [28, 34, 38, 32]), entry('Orchard', [31, 37, 41, 35])]
    expect(pickBalanced(wider, w).a.id).toBe('Dhoby Ghaut')
    const withBugis = [...wider, entry('Bugis', [22, 28, 36, 27]), entry('Paya Lebar', [11, 18, 42, 16])]
    expect(pickBalanced(withBugis, w).a.id).toBe('Bugis') // best on the longest trip and the average
  })

  it("moves toward the person who travelled more last time, and is today's rule when nobody did", () => {
    const places = [entry('x', [20, 30]), entry('y', [25, 25]), entry('z', [30, 20])]
    expect(pickBalanced(places, ones(2)).a.id).toBe('y') // nobody owed: the even place
    const owed = balanceWeights([{ travelDebtMinutes: 120 }, {}]) // person 1 owed 120 minutes: weight 3
    expect(pickBalanced(places, owed).a.id).toBe('x') // the place nearest person 1
  })

  it('answers with one place, with no place, and with a single person', () => {
    expect(pickBalanced([], ones(2))).toBeNull()
    expect(pickBalanced([entry('only', [10, 10])], ones(2)).a.id).toBe('only')
    expect(pickBalanced([entry('p', [10]), entry('q', [8])], ones(1)).a.id).toBe('q') // one person: the shorter trip
  })

  it('ranks the places inside the slack by gap, then the others by their longest trip', () => {
    const places = [entry('x', [20, 30]), entry('y', [25, 25]), entry('z', [30, 20]), entry('far', [90, 90]), entry('farther', [95, 70])]
    expect(rankBalanced(places, ones(2)).map((e) => e.a.id)).toEqual(['y', 'x', 'z', 'far', 'farther'])
    expect(rankBalanced([], ones(2))).toEqual([])
  })
})

describe('choicesOf', () => {
  const members = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
  const describe_ = (a, j) => ({ area: { id: a.id, name: a.name }, approximate: j.approximate })

  it('labels the shortest longest trip, the most balanced and the lowest average, with every person\'s trip', () => {
    const places = [entry('tampines', [6, 11, 89]), entry('bishan', [45, 50, 44]), entry('kovan', [30, 36, 65]), entry('toa', [33, 38, 52])]
    const out = choicesOf(places, members, ones(3), describe_)
    const by = Object.fromEntries(out.flatMap((c) => c.labels.map((l) => [l, c])))
    expect(by.shortest_longest_trip.area.id).toBe('bishan')
    expect(by.lowest_average.area.id).toBe('tampines')
    expect(by.most_balanced.area.id).toBe('bishan') // 45/50/44: gap 6; 33/38/52 (gap 19) is inside the slack but has the larger gap
    expect(by.shortest_longest_trip).toMatchObject({ worstMinutes: 50, gapMinutes: 6, travelByMember: { a: 45, b: 50, c: 44 } })
    expect(by.shortest_longest_trip.meanMinutes).toBeCloseTo(46.33, 1)
  })

  it('gives a place that wins several labels once, with all of them, and nothing for no places', () => {
    const out = choicesOf([entry('only', [10, 20, 30])], members, ones(3), describe_)
    expect(out).toHaveLength(1)
    expect(out[0].labels).toEqual(['shortest_longest_trip', 'most_balanced', 'lowest_average'])
    expect(choicesOf([], members, ones(3), describe_)).toEqual([])
  })
})

// ---------------------------------------------------------------- meetingArea with crafted travel times
describe('meetingArea', () => {
  const homes = { m1: { lat: 1.3, lng: 103.7 }, m2: { lat: 1.4, lng: 103.95 } }
  const members = [{ id: 'm1', name: 'M1', home: homes.m1 }, { id: 'm2', name: 'M2', home: homes.m2 }]
  const AREAS = { caldecott: [42, 32], novena: [41, 42], far: [60, 60] }
  const data = { areas: Object.keys(AREAS).map((id, i) => ({ id, name: id, lat: 1.3 + i * 0.01, lng: 103.8 + i * 0.01 })) }
  // The trip of a person to an area, from the table above.
  const travelMinutes = (from, to) => {
    const id = data.areas.find((a) => a.lat === to.lat && a.lng === to.lng)?.id
    return AREAS[id][from.lat === homes.m1.lat ? 0 : 1]
  }
  const ask = (extra) => meetingArea({ members, ...extra }, data, { travelMinutes })

  it("answers as it always did without a rule: the same areas, no `rule`, no `choices`", () => {
    const out = ask({})
    expect(out.area.id).toBe('caldecott') // the same longest trip as novena, and the lower average
    expect('rule' in out).toBe(false)
    expect('choices' in out).toBe(false)
    expect(ask({ rule: 'longest' })).toEqual(out)
  })

  it("the balanced rule says so, and here keeps today's pick: the even place would cost the group 4.5 minutes on average", () => {
    const out = ask({ rule: 'balanced' })
    expect(out).toMatchObject({ rule: 'balanced', area: { id: 'caldecott' }, worstMinutes: 42, travelByMember: { m1: 42, m2: 32 } })
  })

  it('past travel moves the balanced choice toward the person who travelled more, and not the default one', () => {
    // Person 1 owed 120 minutes (weight 3): their trips count triple. 'x' is nearest person 1.
    const table = { x: [20, 34], y: [26, 28], z: [30, 24] }
    const areas = Object.keys(table).map((id, i) => ({ id, name: id, lat: 1.3 + i * 0.01, lng: 103.8 + i * 0.01 }))
    const tm = (from, to) => table[areas.find((a) => a.lat === to.lat && a.lng === to.lng).id][from.lat === homes.m1.lat ? 0 : 1]
    const owed = members.map((m) => ({ ...m, travelDebtMinutes: m.id === 'm1' ? 120 : 0 }))
    const plain = meetingArea({ members: owed }, { areas }, { travelMinutes: tm })
    const balanced = meetingArea({ members: owed, rule: 'balanced' }, { areas }, { travelMinutes: tm })
    expect(plain.area.id).toBe('y') // the default rule ignores the balance: the shortest longest trip is 28
    expect(balanced.area.id).toBe('x') // weighted, person 1's trips are 60, 78, 90: x has the shortest longest trip, and is inside the cap
    expect(balanced.travelByMember.m1).toBeLessThan(plain.travelByMember.m1)
    expect(balanced.worstMinutes).toBeLessThanOrEqual(Math.max(28 * BALANCE.capFactor, 28 + BALANCE.capMinutes)) // and the cap held
  })

  it('adds the labelled choices only when asked, with each person\'s trip', () => {
    const out = ask({ rule: 'balanced', choices: true })
    // One place wins every label here, so it comes once with all three.
    expect(out.choices).toHaveLength(1)
    expect(out.choices[0]).toMatchObject({ labels: ['shortest_longest_trip', 'most_balanced', 'lowest_average'], area: { id: 'caldecott' }, gapMinutes: 10, worstMinutes: 42, travelByMember: { m1: 42, m2: 32 } })
    expect(ask({ choices: true }).choices.length).toBeGreaterThan(0) // the choices also work with today's rule
    expect('choices' in ask({})).toBe(false)
  })

  it("lists the chosen place first and the rest by how close they are to it, whichever rule", () => {
    expect(ask({ rule: 'balanced', alternatives: 2 }).candidates.map((c) => c.area.id)).toEqual(['caldecott', 'novena', 'far'])
    expect(ask({ alternatives: 2 }).candidates.map((c) => c.area.id)).toEqual(['caldecott', 'novena', 'far'])
  })
})

// ---------------------------------------------------------------- converge: venues
describe('converge with the balanced rule', () => {
  const planData = loadPlanData()
  const dateTime = '2026-10-14T12:30'
  const centre = { lat: 1.3504, lng: 103.8428 }
  const base = planData.venues.find((v) => v.category === 'eat' && isOpenAt(v, dateTime))
  const venue = (id, lat) => ({ ...base, id, name: id, lat, lng: centre.lng, area: id, postalCode: undefined, address: undefined, rating: null, ratingCount: null, source: 'curated' })
  // Two alike venues: one with trips 20/40 (longest 40, average 30), one with 38/40 (longest 40, gap 2). By the table below.
  const venues = [venue('uneven', centre.lat), venue('even', centre.lat + 0.0004)]
  const TRIPS = { uneven: [20, 40], even: [38, 40] }
  const members = [{ id: 'a', home: { lat: 1.36, lng: 103.85 } }, { id: 'b', home: { lat: 1.33, lng: 103.84 } }]
  const travelMinutes = (from, to) => {
    const v = venues.find((x) => x.lat === to.lat)
    return v ? TRIPS[v.id][from.lat === members[0].home.lat ? 0 : 1] : 30
  }
  const input = { members, occasion: 'casual_meal', dateTime, durationMinutes: 60, categories: ['eat'], centre, unknownPolicy: 'lenient', topN: 5 }
  const run = (extra) => converge({ ...input, ...extra }, { ...planData, venues }, { travelMinutes })

  it('is unchanged without a rule, and ranks the venue with the lower average first when the longest trip ties', () => {
    const out = run({})
    expect(out.results.map((r) => r.venueId)).toEqual(['uneven', 'even'])
    expect(out.results.every((r) => !('gapMinutes' in r))).toBe(true)
  })

  it('prefers the venue with the smaller gap when the rule is balanced, and reports the gap', () => {
    const out = run({ rule: 'balanced' })
    expect(out.results.map((r) => r.venueId)).toEqual(['even', 'uneven'])
    expect(out.results[0].gapMinutes).toBe(2)
    expect(out.results[1].gapMinutes).toBe(20)
    expect(out.results[0].breakdown.gap).toBeDefined()
  })
})

// ---------------------------------------------------------------- over HTTP
describe('POST /api/meeting-area with the new fields', () => {
  let server
  let base
  beforeAll(async () => {
    server = createApp({ frontendOrigin: 'http://localhost:5173', stub: true }).listen(0, '127.0.0.1')
    await once(server, 'listening')
    base = `http://127.0.0.1:${server.address().port}/api`
  })
  afterAll(() => new Promise((resolve) => server.close(resolve)))
  const post = async (body) => {
    const res = await fetch(`${base}/meeting-area`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { status: res.status, body: await res.json() }
  }
  const group = [
    { id: 'a', name: 'A', home: { lat: 1.3541, lng: 103.9446 }, travelDebtMinutes: 0 },
    { id: 'b', name: 'B', home: { lat: 1.3331, lng: 103.7425 } },
    { id: 'c', name: 'C', home: { lat: 1.351, lng: 103.848 } },
  ]

  it('answers the same without the fields, and adds `rule` and `choices` with them', async () => {
    const plain = await post({ members: group })
    expect(plain.status).toBe(200)
    expect('rule' in plain.body).toBe(false)
    expect('choices' in plain.body).toBe(false)
    const balanced = await post({ members: group, rule: 'balanced', choices: true })
    expect(balanced.status).toBe(200)
    expect(balanced.body.rule).toBe('balanced')
    for (const c of balanced.body.choices) {
      expect(c.labels.length).toBeGreaterThan(0)
      expect(Object.keys(c.travelByMember).sort()).toEqual(['a', 'b', 'c'])
      expect(c.gapMinutes).toBeGreaterThanOrEqual(0)
    }
  })

  it('refuses an unknown rule, and the balanced rule with another method', async () => {
    expect((await post({ members: group, rule: 'fair-ish' })).status).toBe(400)
    const other = await post({ members: group, rule: 'balanced', method: 'centroid' })
    expect(other.status).toBe(400)
    expect(other.body.issues[0].path).toBe('rule')
  })

  it('takes a past-travel balance per member and still answers', async () => {
    const owed = group.map((m) => ({ ...m, travelDebtMinutes: m.id === 'b' ? 180 : 0 }))
    const out = await post({ members: owed, rule: 'balanced' })
    expect(out.status).toBe(200)
    expect(out.body.travelByMember.b).toBeLessThanOrEqual((await post({ members: group, rule: 'balanced' })).body.travelByMember.b)
  })
})

// ---------------------------------------------------------------- the cap is a hard limit
describe('the cap on the longest trip', () => {
  const places = [entry('even-ish', [49, 40]), entry('near-owed', [81, 18]), entry('mid', [58, 30])]

  it('is never broken to favour someone who travelled more last time', () => {
    // Person 2 is owed a lot: weights [1, 3]. The place nearest them has a longest trip of 81, far over 1.35 x the best (49).
    const weights = balanceWeights([{}, { travelDebtMinutes: 600 }])
    const first = pickBalanced(places, weights)
    expect(first.j.worst).toBeLessThanOrEqual(Math.max(49 * BALANCE.capFactor, 49 + BALANCE.capMinutes) + 1e-9)
    expect(rankBalanced(places, weights).map((e) => e.a.id).at(-1)).toBe('near-owed') // outside the cap: last
  })

  it('holds over many random groups and debts', () => {
    let seed = 7
    const rnd = () => ((seed = (seed * 1664525 + 1013904223) % 4294967296) / 4294967296)
    for (let g = 0; g < 400; g++) {
      const people = 2 + Math.floor(rnd() * 5)
      const options = Array.from({ length: 3 + Math.floor(rnd() * 12) }, (_, i) => entry(`a${i}`, Array.from({ length: people }, () => 5 + Math.floor(rnd() * 80))))
      const weights = balanceWeights(Array.from({ length: people }, () => ({ travelDebtMinutes: rnd() < 0.5 ? 0 : Math.floor(rnd() * 400) })))
      const bestReal = Math.min(...options.map((e) => e.j.worst))
      const cap = Math.max(bestReal * BALANCE.capFactor, bestReal + BALANCE.capMinutes)
      const first = pickBalanced(options, weights)
      expect(first.j.worst, `group ${g}`).toBeLessThanOrEqual(cap + 1e-9)
      expect(rankBalanced(options, weights)).toHaveLength(options.length)
    }
  })
})
