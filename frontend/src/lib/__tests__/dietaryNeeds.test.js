// Dietary needs (ticket #107): the group's needs reach the planner without anyone's name, food is filtered strictly, the group
// can ask for the places we could not confirm, a need changed mid-vote re-ranks and says so without naming anyone, and the
// outing asks each person to confirm the group's needs once, when it reaches voting. The planner is stood in for, as in outingReview.test.js.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi, stubPlanner } from './planFixture.js'
import { VENUES } from '../mock/venues.js'
import { SAMPLE_DIETARY } from '../mock/people.js'
import { dietTags, fewLine, fitLine, needsText, unfitDietText } from '../dietText.js'
import { dietChips } from '../../components/event/DietaryConfirm.vue'
import { dietFit, standInConverge } from '../../components/dev/offlinePlanner.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// Each test runs an outing from sign-up to voting, which takes seconds when the machine is busy.
vi.setConfig({ testTimeout: 20000 })

// A planner that honours dietary needs: of a category's places, the even ones fit every need and the odd ones are unknown.
// Strict leaves the unknown ones out; lenient keeps them and says so. `fitting` caps how many places fit for sure.
function dietPlanner({ fitting = 3 } = {}) {
  planner.rankSlot.mockReset().mockImplementation(async ({ members, slot, currentOptionIds = [], unknownPolicy }) => {
    const needs = [...new Set(members.flatMap((m) => m.dietary || []))]
    const ofKind = VENUES.filter((v) => v.category === slot.category)
    const sure = ofKind.filter((_, i) => i % 2 === 0).slice(0, fitting)
    const unsure = ofKind.filter((_, i) => i % 2 === 1)
    const filtered = slot.category === 'eat' && needs.length
    const fits = filtered ? (unknownPolicy === 'lenient' ? [...sure, ...unsure] : sure) : ofKind
    const option = (venue, i) => ({
      venue, rank: i + 1, score: i, walk: 5, crowd: 'quiet', reasons: [], warnings: [], swap: null, explanation: '',
      dietUnknown: filtered && unsure.includes(venue) ? needs : [], verify: [], approximate: false,
    })
    return { options: fits.slice(0, 3).map(option), current: fits.filter((v) => currentOptionIds.includes(v.id)).map(option), widened: false, few: null, empty: null }
  })
}

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => {
  stubPlanner(planner)
  dietPlanner()
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Ian (signed in, with `dietary`) and the friends given, voting at Bishan.
async function voting(friends, dietary = []) {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines', dietary })
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, friends)
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  for (const f of friends) await api.setLocation(id, f, 'start', { areaId: 'jurong-east' })
  await api.useMeetingArea(id)
  return { api, id }
}
const callsFor = (category) => planner.rankSlot.mock.calls.map(([req]) => req).filter((req) => req.slot.category === category)

describe('the sample friends', () => {
  it('Faith is halal and Nicole is vegetarian, and nobody else has a need', () => {
    expect(SAMPLE_DIETARY).toEqual({ faith: ['halal'], nicole: ['vegetarian'] })
  })
})

describe('the group\'s needs reach the planner', () => {
  it('filters food strictly for every need in the group, on the first person sent only, and leaves drink to the planner\'s rule', async () => {
    const { api, id } = await voting(['faith', 'nicole'])
    planner.rankSlot.mockClear()
    const plan = await api.getPlan(id)
    expect(plan.dietary).toEqual(['halal', 'vegetarian'])
    const [eat] = callsFor('eat')
    expect(eat.unknownPolicy).toBe('strict')
    expect(eat.members[0].dietary).toEqual(['halal', 'vegetarian'])
    expect(eat.members.slice(1).every((m) => m.dietary === undefined)).toBe(true)
    // No name goes with a need.
    expect(eat.members.every((m) => m.name === undefined)).toBe(true)
    expect(callsFor('drink')[0].unknownPolicy).toBe('lenient')
    expect(callsFor('drink')[0].members[0].dietary).toEqual(['halal', 'vegetarian'])
  })

  it('sends no need and keeps lenient for a group with none; a friend outside the sample has none here', async () => {
    const { api, id } = await voting(['jonathan'])
    planner.rankSlot.mockClear()
    const plan = await api.getPlan(id)
    expect(plan.dietary).toEqual([])
    expect(callsFor('eat')[0].unknownPolicy).toBe('lenient')
    expect(callsFor('eat')[0].members.some((m) => m.dietary)).toBe(false)
    expect(plan.slots.find((s) => s.category === 'eat').dietFew).toBe(false)
  })

  it('counts the signed-in person\'s own need', async () => {
    const { api, id } = await voting(['jonathan'], ['vegan'])
    expect((await api.getPlan(id)).dietary).toEqual(['vegan'])
  })
})

describe('fewer than 3 food places fit', () => {
  it('says so, offers the places we could not confirm, labels them, and takes them and their votes back', async () => {
    dietPlanner({ fitting: 1 })
    const { api, id } = await voting(['faith'])
    let eat = (await api.getPlan(id)).slots.find((s) => s.category === 'eat')
    expect(eat.dietFew).toBe(true)
    expect(eat.options).toHaveLength(1)

    await api.setUnconfirmed(id, true)
    let plan = await api.getPlan(id)
    eat = plan.slots.find((s) => s.category === 'eat')
    expect(plan.unconfirmed).toBe(true)
    expect(eat.dietFew).toBe(false)
    expect(eat.options).toHaveLength(3)
    const unsure = eat.options.find((o) => o.dietUnknown.length)
    expect(dietTags(unsure).map((t) => t.text)).toEqual(['Halal not confirmed'])
    expect(callsFor('eat').at(-1).unknownPolicy).toBe('lenient')

    await api.vote(id, eat.id, 'ian', unsure.id)
    const back = await api.setUnconfirmed(id, false)
    expect(back.banner).toMatchObject({ text: 'Votes for places we could not confirm were cleared.', votesCleared: true, byDiet: true })
    plan = await api.getPlan(id)
    expect(plan.unconfirmed).toBe(false)
    expect(plan.slots.find((s) => s.category === 'eat').options.map((o) => o.id)).not.toContain(unsure.id)
    expect((await api.getSession(id)).votes[eat.id] || {}).toEqual({})
  })
})

describe('a need changed mid-vote', () => {
  it('re-ranks, drops the places that no longer fit with their votes, and says places were filtered without naming anyone', async () => {
    const { api, id } = await voting(['jonathan'])
    const eat = (await api.getPlan(id)).slots.find((s) => s.category === 'eat')
    expect(eat.options).toHaveLength(3)
    // With no need, the planner's first three are places 0, 1 and 2; place 1 is one it cannot confirm for any need.
    const dropped = eat.options.find((o) => o.id === VENUES.filter((v) => v.category === 'eat')[1].id)
    await api.vote(id, eat.id, 'jonathan', dropped.id)

    await api.updateUser({ dietary: ['halal'] })
    await api.whenRefiltered()
    const s = await api.getSession(id)
    expect(s.banner).toMatchObject({ text: 'Places were filtered for a dietary need. Votes for places that no longer fit were cleared.', byDiet: true, votesCleared: true })
    expect(s.banner.text).not.toMatch(/Ian|Jonathan|you/i)
    expect(s.options[eat.id]).not.toContain(dropped.id)
    expect(s.votes[eat.id] || {}).toEqual({})
  })

  it('leaves the outing alone when the places do not change', async () => {
    dietPlanner({ fitting: 3 })
    const { api, id } = await voting(['faith'])
    await api.updateUser({ dietary: ['halal'] })
    await api.whenRefiltered()
    expect((await api.getSession(id)).banner).toBeFalsy()
  })
})

describe('"Confirm dietary needs" on an outing', () => {
  it('is asked once per person per outing, with the needs of the others locked on and no names', async () => {
    const { api, id } = await voting(['faith', 'nicole'], ['vegan'])
    let plan = await api.getPlan(id)
    expect(plan.dietChecked).toBe(false)
    expect(plan.myDietary).toEqual(['vegan'])
    expect(plan.othersDietary).toEqual(['halal', 'vegetarian'])
    expect(dietChips({ mine: plan.myDietary, others: plan.othersDietary })).toEqual([
      { value: 'halal', label: 'Halal', selected: true, locked: true },
      { value: 'vegetarian', label: 'Vegetarian', selected: true, locked: true },
      { value: 'vegan', label: 'Vegan', selected: true, locked: false },
    ])
    await api.confirmDiet(id, ['vegan'])
    plan = await api.getPlan(id)
    expect(plan.dietChecked).toBe(true)
    // Another outing still asks.
    const { id: other } = await api.createSession({ title: 'Sunday', date: '2026-10-11', start: '12:00', end: '20:00' })
    await api.inviteFriends(other, ['jonathan'])
    await api.startSession(other)
    await api.setLocation(other, 'ian', 'start', { areaId: 'tampines' })
    await api.setLocation(other, 'jonathan', 'start', { areaId: 'jurong-east' })
    await api.useMeetingArea(other)
    expect((await api.getPlan(other)).dietChecked).toBe(false)
  })

  it('saves a change of the person’s own needs on their profile and ranks the outing again', async () => {
    const { api, id } = await voting(['jonathan'])
    planner.rankSlot.mockClear()
    await api.confirmDiet(id, ['halal'])
    await api.whenRefiltered()
    expect((await api.getUser()).dietary).toEqual(['halal'])
    expect((await api.getPlan(id)).dietary).toEqual(['halal'])
    expect(callsFor('eat').at(-1).unknownPolicy).toBe('strict')
  })
})

describe('under stress', () => {
  it('stays consistent through dozens of overlapping need changes, switches, votes and confirms', async () => {
    dietPlanner({ fitting: 2 })
    const { api, id } = await voting(['faith', 'nicole', 'jonathan'])
    // A fixed sequence of mixed writes, all started at once, as several tabs or impatient taps would.
    const NEEDS = [['vegan'], [], ['halal'], ['vegetarian', 'vegan'], []]
    const writes = []
    for (let i = 0; i < 40; i++) {
      const plan = await api.getPlan(id)
      const eat = plan.slots.find((s) => s.category === 'eat')
      const kind = i % 5
      if (kind === 0) writes.push(api.setUnconfirmed(id, i % 2 === 0))
      if (kind === 1) writes.push(api.updateUser({ dietary: NEEDS[i % NEEDS.length] }))
      if (kind === 2 && eat?.options.length) writes.push(api.vote(id, eat.id, 'ian', eat.options[i % eat.options.length].id))
      if (kind === 3) writes.push(api.confirmDiet(id, NEEDS[(i + 2) % NEEDS.length]))
      if (kind === 4) writes.push(api.setUnconfirmed(id, i % 3 === 0))
    }
    const settled = await Promise.allSettled(writes)
    await api.whenRefiltered()
    // A refused write says why in words; nothing fails without a message.
    for (const r of settled) if (r.status === 'rejected') expect(r.reason.message).toMatch(/\w/)
    const s = await api.getSession(id)
    const plan = await api.getPlan(id)
    // Every vote is for a place that is still an option, and the plan says what the session holds.
    for (const [slotId, byPerson] of Object.entries(s.votes)) for (const venue of Object.values(byPerson)) expect(s.options[slotId]).toContain(venue)
    expect(plan.unconfirmed).toBe(!!s.unconfirmed)
    expect(plan.dietChecked).toBe(true)
    expect(plan.myDietary).toEqual((await api.getUser()).dietary)
    // The group's needs are the sample friends' and the signed-in person's own, and the others' are never the person's to drop.
    expect(plan.othersDietary).toEqual(['halal', 'vegetarian'])
    expect(plan.dietary).toEqual([...new Set(['halal', 'vegetarian', ...plan.myDietary])].sort((a, b) => ['halal', 'vegetarian', 'vegan'].indexOf(a) - ['halal', 'vegetarian', 'vegan'].indexOf(b)))
    // While strict, every food option fits for sure; once the unconfirmed are shown, they are labelled.
    const eat = plan.slots.find((x) => x.category === 'eat')
    if (!plan.unconfirmed) for (const o of eat.options) expect(o.dietUnknown).toEqual([])
  }, 120000)
})

describe('the words', () => {
  it('say the needs, never whose they are', () => {
    expect(needsText(['vegetarian', 'halal'])).toBe('halal and vegetarian')
    expect(needsText(['vegan', 'halal', 'vegetarian'])).toBe('halal, vegetarian and vegan')
    expect(fitLine(['halal', 'vegetarian'])).toBe('Showing places that fit halal and vegetarian')
    expect(fitLine([])).toBe('')
    expect(fewLine(1)).toBe('Only 1 place fits.')
    expect(fewLine(2)).toBe('Only 2 places fit.')
    expect(dietTags({ dietUnknown: [], verify: ['vegetarian'] })).toEqual([{ key: 'likely-vegetarian', text: 'Vegetarian likely', tone: 'veg', icon: '', title: 'Vegetarian likely, check before you go' }])
    expect(dietTags({ dietUnknown: ['vegan', 'halal'], verify: ['halal'] }).map((t) => [t.text, t.tone, t.icon])).toEqual([
      ['Halal not confirmed', 'halal', 'warning'],
      ['Vegan not confirmed', 'veg', 'warning'],
      ['Halal likely', 'halal', ''],
    ])
    expect(dietTags({})).toEqual([])
    expect(unfitDietText('halal')).toBe('Halal not confirmed')
  })
})

describe('the demo tools\' planner', () => {
  const hawker = VENUES.find((v) => v.kind === 'hawker' && /food centre/i.test(v.name))
  const restaurant = VENUES.find((v) => v.category === 'eat' && v.kind === 'restaurant')
  const bar = VENUES.find((v) => v.kind === 'bar')
  const cafe = VENUES.find((v) => v.category === 'drink' && v.kind === 'cafe')

  it('treats a food centre as likely halal and vegetarian, other food as unknown, and keeps bars from a halal group', () => {
    expect(dietFit(hawker, ['halal'], 'strict')).toEqual({ fits: true, verify: ['halal'], dietUnknown: [] })
    expect(dietFit(hawker, ['vegan'], 'strict').fits).toBe(false)
    expect(dietFit(restaurant, ['halal'], 'strict').fits).toBe(false)
    expect(dietFit(restaurant, ['halal'], 'lenient')).toEqual({ fits: true, verify: [], dietUnknown: ['halal'] })
    expect(dietFit(bar, ['halal'], 'lenient').fits).toBe(false)
    expect(dietFit(bar, ['vegetarian'], 'strict').fits).toBe(true)
    expect(dietFit(cafe, ['halal'], 'strict')).toEqual({ fits: true, verify: [], dietUnknown: [] })
  })

  it('ranks only the food that fits in strict mode', () => {
    const centre = { lat: hawker.lat, lng: hawker.lng }
    const { results } = standInConverge({ categories: ['eat'], centre, dateTime: '2026-10-17T12:00', durationMinutes: 60, topN: 30, members: [{ id: 'a', dietary: ['halal'] }], unknownPolicy: 'strict' })
    expect(results.length).toBeGreaterThan(0)
    expect(results.every((r) => r.verify.includes('halal'))).toBe(true)
  })
})
