import { describe, expect, it } from 'vitest'
import { loadPlanData } from '../src/db/venues.js'
import {
  arrangeInput,
  basisOf,
  confirmedRows,
  isRoamStop,
  reorderedRows,
  suggestionFits,
  timedRows,
  votedStops,
  votersOf,
  winnerOf,
  withAddedStop,
  withMode,
  withoutStop,
  withPlace,
  withTravelMinutes,
} from '../src/services/session-itinerary.js'
import { historySince, visitsFrom } from '../src/services/session-history.js'
import { homeTripsRun, ledgerFor, ledgerPeople, minutesBetween } from '../src/services/session-ledger.js'

// The rules of a session's plan as pure functions (services/session-itinerary.js, session-ledger.js, session-history.js): which place wins
// a slot, what stops the votes make, the hash a suggestion is made for, the rows of a confirm and of every edit, the travel ledger and the
// group's past. No database, no planner, no clock.
const data = loadPlanData()
const venues = new Map(data.venues.map((v) => [v.id, v]))
const venueOf = (id) => venues.get(id)
const pick = (category, n) => data.venues.filter((v) => v.category === category && !String(v.id).startsWith('google')).slice(n, n + 1)[0]

const A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa1'
const B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb2'
const C = 'cccccccc-cccc-4ccc-8ccc-ccccccccccc3'

// A draft with an eat slot and a drink slot, each with two options, and the votes given.
function draftWith({ votes = [], members, slots, options } = {}) {
  return {
    session: { id: 'sss', date: '2026-10-25', start_time: '10:00:00', end_time: '20:00:00' },
    members: members ?? [
      { user_id: A, state: 'joined', stay_until: null },
      { user_id: B, state: 'joined', stay_until: null },
      { user_id: C, state: 'opted_out', stay_until: null },
    ],
    slots: slots ?? [
      { id: 'slot-eat', category: 'eat', deleted: false },
      { id: 'slot-drink', category: 'drink', deleted: false },
      { id: 'slot-shop', category: 'shop', deleted: false },
    ],
    options: options ?? [
      { category: 'eat', venue_id: 'e1', rank: 1, score: 5 },
      { category: 'eat', venue_id: 'e2', rank: 2, score: 3 },
      { category: 'drink', venue_id: 'd1', rank: 1, score: 4 },
      { category: 'drink', venue_id: 'd2', rank: 2, score: 6 },
    ],
    votes,
  }
}

describe('the winner of a slot', () => {
  it('is the place with the most votes of joined members', () => {
    const draft = draftWith({ votes: [{ category: 'eat', user_id: A, venue_id: 'e2' }, { category: 'eat', user_id: B, venue_id: 'e2' }, { category: 'eat', user_id: C, venue_id: 'e1' }] })
    expect(winnerOf(draft, 'eat')).toBe('e2')
  })

  it('goes to the better planner score on a tie (a lower penalty), then to the better rank', () => {
    const tie = draftWith({ votes: [{ category: 'eat', user_id: A, venue_id: 'e1' }, { category: 'eat', user_id: B, venue_id: 'e2' }] })
    expect(winnerOf(tie, 'eat')).toBe('e2') // score 3 beats 5
    const same = draftWith({
      options: [{ category: 'eat', venue_id: 'x', rank: 2, score: 4 }, { category: 'eat', venue_id: 'y', rank: 1, score: 4 }],
      votes: [{ category: 'eat', user_id: A, venue_id: 'x' }, { category: 'eat', user_id: B, venue_id: 'y' }],
    })
    expect(winnerOf(same, 'eat')).toBe('y') // equal scores: the better rank
  })

  it('does not count the votes of somebody who is not joined, and with no votes it is the first option', () => {
    const draft = draftWith({ votes: [{ category: 'eat', user_id: C, venue_id: 'e2' }] })
    expect(winnerOf(draft, 'eat')).toBe('e2') // by score, because the vote of an opted-out member is worth nothing
    expect(winnerOf(draftWith({ options: [] }), 'eat')).toBeNull()
  })

  it('counts the joined people who have voted in a slot that is still there', () => {
    const draft = draftWith({ votes: [{ category: 'eat', user_id: A, venue_id: 'e1' }, { category: 'drink', user_id: A, venue_id: 'd1' }, { category: 'eat', user_id: C, venue_id: 'e1' }] })
    expect(votersOf(draft)).toBe(1)
    draft.votes.push({ category: 'drink', user_id: B, venue_id: 'd1' })
    expect(votersOf(draft)).toBe(2)
    draft.slots.find((s) => s.category === 'drink').deleted = true
    draft.slots.find((s) => s.category === 'eat').deleted = true
    expect(votersOf(draft)).toBe(0)
  })
})

describe('the stops the votes make', () => {
  it('has a stop for each kind somebody voted in, laid back to back, each holding its winner', () => {
    const draft = draftWith({ votes: [{ category: 'eat', user_id: A, venue_id: 'e1' }, { category: 'drink', user_id: B, venue_id: 'd2' }] })
    const stops = votedStops(draft)
    expect(stops).toHaveLength(2)
    const byCategory = Object.fromEntries(stops.map((s) => [s.category, s]))
    expect(byCategory.eat).toMatchObject({ venueId: 'e1', slotId: 'slot-eat' })
    expect(byCategory.drink).toMatchObject({ venueId: 'd2', slotId: 'slot-drink' })
    const [first, second] = stops
    expect(second.plannedStart).toBe(first.plannedStart + first.duration)
    // The kind nobody voted in has none, and a removed slot has none.
    expect(stops.some((s) => s.category === 'shop')).toBe(false)
  })

  it('has none when nobody voted, or the day is too short to lay anything out', () => {
    expect(votedStops(draftWith())).toEqual([])
    const short = draftWith({ votes: [{ category: 'eat', user_id: A, venue_id: 'e1' }] })
    short.session.end_time = '10:20:00'
    expect(votedStops(short)).toEqual([])
  })
})

describe('the hash a suggested order is made for', () => {
  const stops = [{ slotId: 's1', venueId: 'a', plannedStart: 600, duration: 60 }, { slotId: 's2', venueId: 'b', plannedStart: 660, duration: 90 }]
  const session = { date: '2026-10-25', start_time: '10:00:00', end_time: '20:00:00' }

  it('is 64 hex characters and the same for the same stops, however the times are written', () => {
    const basis = basisOf(session, stops)
    expect(basis).toMatch(/^[0-9a-f]{64}$/)
    expect(basisOf({ ...session, start_time: '10:00', end_time: '20:00' }, stops)).toBe(basis)
  })

  it('changes with a winner, a start, a length, the date or the times', () => {
    const basis = basisOf(session, stops)
    expect(basisOf(session, [stops[0], { ...stops[1], venueId: 'c' }])).not.toBe(basis)
    expect(basisOf(session, [stops[0], { ...stops[1], plannedStart: 665 }])).not.toBe(basis)
    expect(basisOf(session, [stops[0], { ...stops[1], duration: 60 }])).not.toBe(basis)
    expect(basisOf({ ...session, date: '2026-10-26' }, stops)).not.toBe(basis)
    expect(basisOf({ ...session, end_time: '21:00:00' }, stops)).not.toBe(basis)
  })

  it('does not hold anything about a person', () => {
    expect(basisOf({ ...session, host_id: A }, stops)).toBe(basisOf(session, stops))
  })
})

describe('a stored suggestion fits the stops only when it is for exactly them', () => {
  const stops = [
    { slotId: 's1', category: 'eat', venueId: 'a', plannedStart: 720, duration: 90 },
    { slotId: 's2', category: 'drink', venueId: 'b', plannedStart: 810, duration: 60 },
  ]
  it('accepts the voted order and a swap with times that do not overlap', () => {
    expect(suggestionFits(stops, { order: ['s1', 's2'], starts: { s1: 720, s2: 810 } })).toBe(true)
    expect(suggestionFits(stops, { order: ['s2', 's1'], starts: { s2: 600, s1: 720 } })).toBe(true)
  })

  it('refuses a missing, repeated or extra slot, overlapping times, a time outside the day and a meal earlier than its time', () => {
    expect(suggestionFits(stops, { order: ['s1'], starts: { s1: 720 } })).toBe(false)
    expect(suggestionFits(stops, { order: ['s1', 's1'], starts: { s1: 720 } })).toBe(false)
    expect(suggestionFits(stops, { order: ['s1', 's3'], starts: { s1: 720, s3: 900 } })).toBe(false)
    expect(suggestionFits(stops, { order: ['s1', 's2'], starts: { s1: 720, s2: 780 } })).toBe(false)
    expect(suggestionFits(stops, { order: ['s2', 's1'], starts: { s2: 900, s1: 3000 } })).toBe(false)
    expect(suggestionFits(stops, { order: ['s2', 's1'], starts: { s2: 600, s1: 700 } })).toBe(false) // the meal is before its 12:00
    expect(suggestionFits(stops, { order: ['s1', 's2'], starts: { s1: 720.5, s2: 900 } })).toBe(false)
    expect(suggestionFits(stops, null)).toBe(false)
    expect(suggestionFits([], { order: [], starts: {} })).toBe(false)
  })
})

describe('what is sent to the AI', () => {
  it('is the places\' names, kinds, hours and settings, times and lengths: no person, no id of a session, no area', () => {
    const eat = pick('eat', 0)
    const drink = pick('drink', 0)
    const stops = [
      { slotId: 'slot-1', category: 'eat', venueId: eat.id, plannedStart: 720, duration: 90 },
      { slotId: 'slot-2', category: 'drink', venueId: drink.id, plannedStart: 810, duration: 60 },
    ]
    const input = arrangeInput(stops, venueOf, { start_time: '10:00:00', end_time: '20:00:00', host_id: A })
    expect(input.startAt).toBe(720)
    expect(input.endAt).toBe(1200)
    expect(input.stops[0]).toMatchObject({ id: 'slot-1', category: 'eat', name: String(eat.name).slice(0, 80), lat: eat.lat, lng: eat.lng, duration: 90, start: 720 })
    const allowed = new Set(['id', 'name', 'category', 'kind', 'lat', 'lng', 'duration', 'start', 'hours', 'indoor', 'mrtWalk'])
    for (const stop of input.stops) for (const key of Object.keys(stop)) expect(allowed.has(key), key).toBe(true)
    expect(JSON.stringify(input)).not.toContain(A)
    for (const s of input.stops) expect(s.hours.every((h) => /^\d\d:\d\d-\d\d:\d\d$/.test(h))).toBe(true)
  })

  it('lets a session that ends past midnight end the next day', () => {
    const input = arrangeInput([{ slotId: 's', category: 'eat', venueId: pick('eat', 0).id, plannedStart: 600, duration: 60 }], venueOf, { start_time: '20:00:00', end_time: '02:00:00' })
    expect(input.endAt).toBe(120 + 1440)
  })
})

describe('the stop rows of a confirm', () => {
  const eat = pick('eat', 0)
  const drink = pick('drink', 0)
  const shop = pick('shop', 0)
  const stops = [
    { slotId: 's1', category: 'drink', venueId: drink.id, plannedStart: 600, duration: 60 },
    { slotId: 's2', category: 'eat', venueId: eat.id, plannedStart: 660, duration: 90 },
    { slotId: 's3', category: 'shop', venueId: shop.id, plannedStart: 750, duration: 60 },
  ]

  it('the voted order: numbered from 0, each with its slot and place, no earliest start, the minutes of the leg into it', () => {
    const { rows, planStart } = confirmedRows(stops, venueOf)
    expect(planStart).toBe(600)
    expect(rows.map((r) => [r.seq, r.slot_id, r.category, r.venue_id, r.planned_start_minute, r.duration_minutes, r.travel_mode, r.not_before_minute])).toEqual(
      stops.map((s, i) => [i, s.slotId, s.category, s.venueId, s.plannedStart, s.duration, null, null]),
    )
    expect(rows[0].travel_minutes).toBeNull()
    expect(rows.slice(1).every((r) => Number.isInteger(r.travel_minutes) && r.travel_minutes >= 0)).toBe(true)
  })

  it('a suggested order: the stops in that order with its starts as their earliest starts, the plan still starting with the voted first stop', () => {
    const { rows, planStart } = confirmedRows(stops, venueOf, { order: ['s3', 's1', 's2'], starts: { s3: 600, s1: 700, s2: 780 } })
    expect(planStart).toBe(600)
    expect(rows.map((r) => [r.seq, r.slot_id, r.not_before_minute])).toEqual([[0, 's3', 600], [1, 's1', 700], [2, 's2', 780]])
    // The planned start of each stop stays its slot's, so the earliest start is the only thing that moved it.
    expect(rows.map((r) => r.planned_start_minute)).toEqual([750, 600, 660])
  })
})

describe('editing the stops of a confirmed plan', () => {
  const eat = pick('eat', 0)
  const drink = pick('drink', 0)
  const shop = pick('shop', 0)
  const other = pick('drink', 1)
  const stops = [
    { slotId: 's1', category: 'drink', venueId: drink.id, plannedStart: 600, duration: 60 },
    { slotId: 's2', category: 'eat', venueId: eat.id, plannedStart: 660, duration: 90 },
    { slotId: 's3', category: 'shop', venueId: shop.id, plannedStart: 750, duration: 60 },
  ]
  const session = { plan_start_minute: 600 }
  // A plan as stored: the rows with ids, the second leg by car.
  const stored = () => {
    const { rows } = confirmedRows(stops, venueOf, { order: ['s1', 's2', 's3'], starts: { s1: 600, s2: 700, s3: 800 } })
    return withTravelMinutes(rows.map((r, i) => ({ ...r, id: `id${i}`, travel_mode: i === 2 ? 'car' : null })), venueOf, 600)
  }

  it('reordering keeps the plan\'s start, resets the modes, drops the order\'s earliest starts and renumbers', () => {
    const result = reorderedRows(stored(), ['id2', 'id0', 'id1'], session, venueOf)
    expect(result.planStart).toBe(600)
    expect(result.rows.map((r) => [r.id, r.seq, r.travel_mode, r.not_before_minute])).toEqual([['id2', 0, null, null], ['id0', 1, null, null], ['id1', 2, null, null]])
    expect(result.rows[0].travel_minutes).toBeNull()
  })

  it('reordering refuses ids that are not exactly the plan\'s stops', () => {
    expect(reorderedRows(stored(), ['id0', 'id1'], session, venueOf)).toBeNull()
    expect(reorderedRows(stored(), ['id0', 'id1', 'id1'], session, venueOf)).toBeNull()
    expect(reorderedRows(stored(), ['id0', 'id1', 'nope'], session, venueOf)).toBeNull()
  })

  it('a stop added from a proposal keeps its earliest start when the order changes', () => {
    const rows = [...stored(), { id: 'roam', seq: 3, slot_id: null, category: 'eat', venue_id: eat.id === drink.id ? shop.id : other.id, planned_start_minute: 900, duration_minutes: 60, travel_mode: null, travel_minutes: null, not_before_minute: 1000 }]
    expect(isRoamStop(rows[3])).toBe(true)
    const result = reorderedRows(rows, ['roam', 'id0', 'id1', 'id2'], session, venueOf)
    expect(result.rows[0].not_before_minute).toBe(1000)
    expect(result.rows.slice(1).every((r) => r.not_before_minute === null)).toBe(true)
  })

  it('deleting a stop closes the gap, gives the stop that follows a default leg, and drops the earliest starts from the order', () => {
    const result = withoutStop(stored(), 'id1', session, venueOf)
    expect(result.rows.map((r) => [r.id, r.seq, r.travel_mode, r.not_before_minute])).toEqual([['id0', 0, null, null], ['id2', 1, null, null]])
    expect(result.planStart).toBe(600)
    expect(result.rows[1].travel_minutes).toBe(withTravelMinutes(result.rows.map((r) => ({ ...r, travel_minutes: null })), venueOf, 600)[1].travel_minutes)
  })

  it('deleting the first stop makes the plan start when the next one does', () => {
    expect(withoutStop(stored(), 'id0', session, venueOf).planStart).toBe(660)
  })

  it('deleting the first stop when the next one came from a proposal starts the plan at its earliest start', () => {
    const rows = [stored()[0], { ...stored()[1], slot_id: null, not_before_minute: 1010, planned_start_minute: 905 }]
    expect(withoutStop(rows, 'id0', session, venueOf).planStart).toBe(1010)
  })

  it('refuses a stop that is not there and the only stop', () => {
    expect(withoutStop(stored(), 'nope', session, venueOf)).toBeNull()
    expect(withoutStop([stored()[0]], 'id0', session, venueOf)).toBeNull()
  })

  it('a travel mode sets the leg into that stop and the minutes with it; the first stop has no leg', () => {
    const rows = stored()
    const walkMinutes = withMode(rows, 'id1', 'walk', session, venueOf).rows[1].travel_minutes
    const carMinutes = withMode(rows, 'id1', 'car', session, venueOf).rows[1].travel_minutes
    expect(walkMinutes).not.toBe(carMinutes)
    expect(withMode(rows, 'id1', 'car', session, venueOf).rows[1].travel_mode).toBe('car')
    expect(withMode(rows, 'id0', 'car', session, venueOf)).toBeNull()
    expect(withMode(rows, 'id1', 'bike', session, venueOf)).toBeNull()
    expect(withMode(withMode(rows, 'id1', 'car', session, venueOf).rows, 'id1', null, session, venueOf).rows[1].travel_mode).toBeNull()
  })

  it('another place keeps the stop\'s length, never starts earlier than it was checked for, resets the legs either side and keeps the others', () => {
    const rows = stored()
    const result = withPlace(rows, 'id1', { venueId: other.id, category: 'drink', startedAt: 712 }, session, venueOf)
    expect(result.rows[1]).toMatchObject({ id: 'id1', venue_id: other.id, category: 'drink', duration_minutes: 90, planned_start_minute: 660, not_before_minute: 712, travel_mode: null })
    expect(result.rows[2].travel_mode).toBeNull() // the leg out of the stop was by car and is the default now
    expect(result.rows[0]).toEqual(rows[0] && { ...rows[0], travel_minutes: null })
    // An earlier check never pulls an earliest start forward.
    const later = withPlace(result.rows, 'id1', { venueId: drink.id, category: 'drink', startedAt: 650 }, session, venueOf)
    expect(later.rows[1].not_before_minute).toBe(712)
    expect(withPlace(rows, 'nope', { venueId: other.id, category: 'drink', startedAt: 700 }, session, venueOf)).toBeNull()
  })

  it('a proposal becomes the last stop: no slot, 60 minutes, not before the time given, and the plan\'s start stays', () => {
    const rows = stored()
    const result = withAddedStop(rows, { venueId: other.id, category: 'drink', notBefore: 1100, duration: 60, endedAt: 1000 }, session, venueOf)
    expect(result.planStart).toBe(600)
    expect(result.rows.at(-1)).toMatchObject({ seq: 3, slot_id: null, category: 'drink', venue_id: other.id, planned_start_minute: 1000, duration_minutes: 60, not_before_minute: 1100 })
    expect(Number.isInteger(result.rows.at(-1).travel_minutes)).toBe(true)
  })

  it('times the stops as the itinerary does, never before their earliest starts', () => {
    const { timed } = timedRows(stored(), venueOf, 600)
    expect(timed[0].start).toBe(600)
    expect(timed[1].start).toBeGreaterThanOrEqual(700)
    expect(timed[2].start).toBeGreaterThanOrEqual(timed[1].end)
  })
})

describe('the travel ledger', () => {
  const people = [
    { userId: 'a', minutesIn: 20, minutesBetween: 10, minutesHome: 30 },
    { userId: 'b', minutesIn: 50, minutesBetween: 10, minutesHome: 30 },
    { userId: 'c', minutesIn: 30, minutesBetween: 10, minutesHome: 20 },
  ]

  it('is each person\'s own minutes and their total minus the group\'s mean, summing to zero', () => {
    const rows = ledgerFor(people)
    expect(rows).toEqual([
      { user_id: 'a', minutes_in: 20, minutes_between: 10, minutes_home: 30, delta_from_mean: -10 },
      { user_id: 'b', minutes_in: 50, minutes_between: 10, minutes_home: 30, delta_from_mean: 20 },
      { user_id: 'c', minutes_in: 30, minutes_between: 10, minutes_home: 20, delta_from_mean: -10 },
    ])
  })

  it('sums to exactly zero when the mean does not divide evenly (the rounding goes to the person who travelled most)', () => {
    for (const totals of [[61, 62, 64], [10, 10, 11], [1, 2, 4, 8, 16, 33, 34], [7, 7, 7, 8]]) {
      const rows = ledgerFor(totals.map((t, i) => ({ userId: `u${i}`, minutesIn: t, minutesBetween: 0, minutesHome: 0 })))
      const cents = rows.reduce((sum, r) => sum + Math.round(r.delta_from_mean * 100), 0)
      expect(cents).toBe(0)
      for (const r of rows) expect(Math.abs(r.delta_from_mean * 100 - Math.round(r.delta_from_mean * 100))).toBeLessThan(1e-9)
    }
  })

  it('gives one person a delta of zero, and nobody no rows', () => {
    expect(ledgerFor([{ userId: 'a', minutesIn: 20, minutesBetween: 5, minutesHome: 9 }])[0].delta_from_mean).toBe(0)
    expect(ledgerFor([])).toEqual([])
  })

  it('keeps minutes whole and not negative whatever it is given', () => {
    const [row] = ledgerFor([{ userId: 'a', minutesIn: 20.6, minutesBetween: -5, minutesHome: Number.NaN }])
    expect(row).toMatchObject({ minutes_in: 21, minutes_between: 0, minutes_home: 0 })
  })

  it('counts only joined members who have stored minutes in', () => {
    const members = [
      { user_id: 'a', state: 'joined', travel_minutes: 20 },
      { user_id: 'b', state: 'joined', travel_minutes: null },
      { user_id: 'c', state: 'opted_out', travel_minutes: 15 },
      { user_id: 'd', state: 'joined', travel_minutes: 0 },
    ]
    expect(ledgerPeople(members).map((m) => m.user_id)).toEqual(['a', 'd'])
  })

  it('adds up the minutes stored on the stops (the first has none)', () => {
    expect(minutesBetween([{ travel_minutes: null }, { travel_minutes: 12 }, { travel_minutes: 9 }])).toBe(21)
    expect(minutesBetween([])).toBe(0)
  })

  it('works out the trips home from the engine\'s travel function, falling back to the estimate where it has no time', () => {
    const input = { from: { id: 'v', lat: 1.3, lng: 103.85 }, people: [{ id: 'a', end: { lat: 1.35, lng: 103.9 } }, { id: 'b', end: { lat: 1.4, lng: 103.8 } }] }
    const real = homeTripsRun(input, null, { travelMinutes: (a, b) => (b.lat === 1.35 ? 17 : null), estimateMinutes: () => 40 })
    expect(real.minutes).toEqual({ a: 17, b: 40 })
    const guessed = homeTripsRun(input, null, {})
    expect(Object.keys(guessed.minutes)).toEqual(['a', 'b'])
    expect(guessed.minutes.a).toBeGreaterThan(0)
  })
})

describe('the group\'s past', () => {
  const outings = {
    sessions: [{ id: 's1', date: '2026-10-03' }, { id: 's2', date: '2026-09-20' }, { id: 's3', date: '2026-10-10' }, { id: 'now', date: '2026-10-25' }],
    members: [
      { session_id: 's1', user_id: 'a', state: 'joined' }, { session_id: 's1', user_id: 'b', state: 'joined' },
      { session_id: 's2', user_id: 'a', state: 'joined' }, { session_id: 's2', user_id: 'z', state: 'joined' },
      { session_id: 's3', user_id: 'a', state: 'joined' }, { session_id: 's3', user_id: 'b', state: 'opted_out' },
      { session_id: 'now', user_id: 'a', state: 'joined' }, { session_id: 'now', user_id: 'b', state: 'joined' },
    ],
    stops: [
      { session_id: 's1', venue_id: 'x' }, { session_id: 's1', venue_id: 'y' }, { session_id: 's2', venue_id: 'q' },
      { session_id: 's3', venue_id: 'r' }, { session_id: 'now', venue_id: 'self' },
    ],
  }

  it('counts the places of an outing that shared at least two joined people with this session, under this session\'s id', () => {
    const visits = visitsFrom({ outings, sessionId: 'now', joined: new Set(['a', 'b']) })
    expect(visits).toEqual([
      { groupId: 'now', venueId: 'x', date: '2026-10-03' },
      { groupId: 'now', venueId: 'y', date: '2026-10-03' },
    ])
  })

  it('needs both people of a group of two, and one person is enough for a group of one', () => {
    expect(visitsFrom({ outings, sessionId: 'now', joined: new Set(['a']) }).map((v) => v.venueId).sort()).toEqual(['q', 'r', 'x', 'y'])
    expect(visitsFrom({ outings, sessionId: 'now', joined: new Set() })).toEqual([])
  })

  it('never counts this session itself, nor a place twice in a day, nor an outing with no date', () => {
    const twice = { ...outings, stops: [...outings.stops, { session_id: 's1', venue_id: 'x' }], sessions: [...outings.sessions, { id: 's9', date: null }] }
    const visits = visitsFrom({ outings: twice, sessionId: 'now', joined: new Set(['a', 'b']) })
    expect(visits.filter((v) => v.venueId === 'x')).toHaveLength(1)
    expect(visits.some((v) => v.venueId === 'self')).toBe(false)
  })

  it('reads the last 60 days', () => {
    expect(historySince(Date.parse('2026-10-23T00:00:00Z'))).toBe('2026-08-24T00:00:00.000Z')
  })
})
