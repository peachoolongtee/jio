// Dietary needs (ticket #107): the group's needs reach the planner without anyone's name, food is filtered strictly, the group
// can ask for the places we could not confirm, a need changed mid-vote re-ranks and says so without naming anyone, and the
// outing asks each person to confirm the group's needs once, when it reaches voting. The planner is stood in for, as in outingReview.test.js.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, loadApi, stubPlanner } from './planFixture.js'
import { VENUES } from '../mock/venues.js'
import { SAMPLE_DIETARY } from '../mock/people.js'
import { CHECK_NEEDS_TEXT, dietCaveats, dietTags, fewLine, fitLine, needsText, unfitDietText, unfitGroupNeedsText } from '../dietText.js'
import { dietChips } from '../../components/event/DietaryChips.vue'
import { dietFit, standInConverge } from '../../components/dev/offlinePlanner.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// Each test runs an outing from sign-up to voting, which takes seconds when the machine is busy.
vi.setConfig({ testTimeout: 20000 })

// A planner that honours dietary needs: of a category's places, the even ones fit every need and the odd ones are unknown.
// Strict leaves the unknown ones out; lenient keeps them and says so. `fitting` caps how many places fit for sure.
function dietPlanner({ fitting = 3 } = {}) {
  planner.rankSlot.mockReset().mockImplementation(async ({ members, slot, currentOptionIds = [], dietPolicy }) => {
    const needs = [...new Set(members.flatMap((m) => m.dietary || []))]
    const ofKind = VENUES.filter((v) => v.category === slot.category)
    const sure = ofKind.filter((_, i) => i % 2 === 0).slice(0, fitting)
    const unsure = ofKind.filter((_, i) => i % 2 === 1)
    const filtered = slot.category === 'eat' && needs.length
    const fits = filtered ? (dietPolicy === 'lenient' ? [...sure, ...unsure] : sure) : ofKind
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
    expect(eat.dietPolicy).toBe('strict')
    // Only the dietary needs are strict: the walk to the MRT, step-free access and sockets keep the planner client's own policy.
    expect(eat.unknownPolicy).toBeUndefined()
    expect(eat.members[0].dietary).toEqual(['halal', 'vegetarian'])
    expect(eat.members.slice(1).every((m) => m.dietary === undefined)).toBe(true)
    // No name goes with a need.
    expect(eat.members.every((m) => m.name === undefined)).toBe(true)
    expect(callsFor('drink')[0].dietPolicy).toBe('lenient')
    expect(callsFor('drink')[0].members[0].dietary).toEqual(['halal', 'vegetarian'])
  })

  it('sends no need and keeps lenient for a group with none; a friend outside the sample has none here', async () => {
    const { api, id } = await voting(['jonathan'])
    planner.rankSlot.mockClear()
    const plan = await api.getPlan(id)
    expect(plan.dietary).toEqual([])
    expect(callsFor('eat')[0].dietPolicy).toBe('lenient')
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
    expect(callsFor('eat').at(-1).dietPolicy).toBe('lenient')

    await api.vote(id, eat.id, 'ian', unsure.id)
    const back = await api.setUnconfirmed(id, false)
    expect(back.banner).toMatchObject({ text: 'Votes for places we could not confirm were cleared.', votesCleared: true, byDiet: true })
    plan = await api.getPlan(id)
    expect(plan.unconfirmed).toBe(false)
    expect(plan.slots.find((s) => s.category === 'eat').options.map((o) => o.id)).not.toContain(unsure.id)
    expect((await api.getSession(id)).votes[eat.id] || {}).toEqual({})
  })
})

describe('a change of the group’s needs picks the list again', () => {
  it('shows the planner’s best for the new needs, keeping only the places someone voted for', async () => {
    // Every place fits both needs, but the planner ranks them differently for each, as it does for real food centres.
    const eat = VENUES.filter((v) => v.category === 'eat').slice(0, 6)
    const [a, b, c, d, e, f] = eat.map((v) => v.id)
    const orderFor = (needs) => (needs.includes('vegetarian') ? [d, e, b, c, a, f] : [a, b, c, d, e, f])
    planner.rankSlot.mockReset().mockImplementation(async ({ members, slot, currentOptionIds = [] }) => {
      const needs = [...new Set(members.flatMap((m) => m.dietary || []))]
      const pool = slot.category === 'eat' ? orderFor(needs).map((id) => eat.find((v) => v.id === id)) : VENUES.filter((v) => v.category === slot.category).slice(0, 3)
      const option = (venue, i) => ({ venue, rank: i + 1, score: i, walk: 5, crowd: 'quiet', reasons: [], warnings: [], swap: null, explanation: '', dietUnknown: [], verify: [], approximate: false })
      return { options: pool.slice(0, 6).map(option), current: pool.filter((v) => currentOptionIds.includes(v.id)).map(option), widened: false, few: null, empty: null }
    })
    const { api, id } = await voting(['faith'])
    let s = await api.getSession(id)
    expect(s.options.eat).toEqual([a, b, c])
    await api.vote(id, 'eat', 'faith', c)
    await api.confirmDiet(id, ['vegetarian'])
    await api.whenRefiltered()
    s = await api.getSession(id)
    // The voted place stays; the rest are the best for halal and vegetarian.
    expect(s.options.eat).toEqual([c, d, e])
    expect(s.votes.eat).toEqual({ faith: c })
  })
})

describe('a need someone else has, dropped for the outing', () => {
  it('stops filtering for it, says so without a name, and brings it back when selected again', async () => {
    const { api, id } = await voting(['faith', 'nicole'])
    await api.confirmDiet(id, [], ['halal'])
    let plan = await api.getPlan(id)
    expect(plan.dietDropped).toEqual(['halal'])
    expect(plan.dietary).toEqual(['vegetarian'])
    expect(plan.othersDietary).toEqual(['halal', 'vegetarian'])
    const s = await api.getSession(id)
    expect(s.banner).toMatchObject({ byDiet: true })
    expect(s.banner.text).not.toMatch(/Faith|Nicole|halal/i)
    expect(callsFor('eat').at(-1).members[0].dietary).toEqual(['vegetarian'])
    // A need nobody else has is not "dropped": taking off one's own is a change of profile.
    await api.confirmDiet(id, [], ['halal', 'vegan'])
    expect((await api.getPlan(id)).dietDropped).toEqual(['halal'])
    // Left out, the outing keeps what it had; an empty list brings the filter back.
    await api.confirmDiet(id, [])
    expect((await api.getPlan(id)).dietDropped).toEqual(['halal'])
    await api.confirmDiet(id, [], [])
    plan = await api.getPlan(id)
    expect(plan.dietDropped).toEqual([])
    expect(plan.dietary).toEqual(['halal', 'vegetarian'])
  })
})

describe('only the host drops a need someone else has', () => {
  it('refuses a guest, whose own needs still change, and leaves the outing as it was', async () => {
    const { api: hosted, id } = await voting(['faith', 'nicole'])
    // The same outing, hosted by Faith: the signed-in person is a guest.
    const saved = JSON.parse(hosted.storage.store[STORAGE_KEY])
    saved.sessions.find((s) => s.id === id).hostId = 'faith'
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
    expect((await api.getSession(id)).hostId).toBe('faith')
    await expect(api.confirmDiet(id, [], ['halal'])).rejects.toThrow("Only the host can change someone else's need.")
    expect((await api.getPlan(id)).dietDropped).toEqual([])
    // Their own needs are theirs, and sending the list the outing already has is not a drop.
    await expect(api.confirmDiet(id, ['vegan'], [])).resolves.toBeTruthy()
    const plan = await api.getPlan(id)
    expect(plan.myDietary).toEqual(['vegan'])
    expect(plan.dietDropped).toEqual([])
    expect(plan.dietChecked).toBe(true)
  })

  it("lets a guest bring back their own need the host dropped, by selecting it again; confirming without it keeps the drop", async () => {
    // Ian has vegan for the outing and the host (Faith) dropped it; Faith and Nicole make the outing three.
    const { api: hosted, id } = await voting(['faith', 'nicole'])
    const saved = JSON.parse(hosted.storage.store[STORAGE_KEY])
    const row = saved.sessions.find((s) => s.id === id)
    row.hostId = 'faith'
    row.dietMine = { ...(row.dietMine || {}), ian: ['vegan'] }
    row.dietDropped = ['vegan']
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
    let plan = await api.getPlan(id)
    expect(plan.dietDropped).toEqual(['vegan'])
    expect(plan.dietary).not.toContain('vegan')
    // Confirming as shown keeps it dropped.
    await api.confirmDiet(id, ['vegan'], ['vegan'])
    expect((await api.getPlan(id)).dietDropped).toEqual(['vegan'])
    // Someone else's need is still not theirs to lift or drop.
    await expect(api.confirmDiet(id, ['vegan'], ['vegan', 'halal'])).rejects.toThrow("Only the host can change someone else's need.")
    // Selecting it again: the group is filtered for it again.
    await api.confirmDiet(id, ['vegan'], [])
    plan = await api.getPlan(id)
    expect(plan.dietDropped).toEqual([])
    expect(plan.dietary).toContain('vegan')
  })

  it('lets the host drop it and bring it back', async () => {
    const { api, id } = await voting(['faith', 'nicole'])
    expect((await api.getSession(id)).hostId).toBe('ian')
    await api.confirmDiet(id, [], ['halal'])
    expect((await api.getPlan(id)).dietDropped).toEqual(['halal'])
    await api.confirmDiet(id, [], [])
    expect((await api.getPlan(id)).dietDropped).toEqual([])
  })
})

describe('the places we could not confirm, in order', () => {
  it('puts the places that likely meet more of the group’s needs first, whatever their score', async () => {
    // Three food places: one likely meets halal and vegetarian, one only halal, one neither. The planner scores the worst
    // fit best, so only the order by needs met can put them right.
    const eat = VENUES.filter((v) => v.category === 'eat').slice(0, 3)
    const unknownFor = [['vegan'], ['vegetarian', 'vegan'], ['halal', 'vegetarian', 'vegan']]
    planner.rankSlot.mockReset().mockImplementation(async ({ slot, currentOptionIds = [], dietPolicy }) => {
      const pool = slot.category === 'eat' ? eat : VENUES.filter((v) => v.category === slot.category).slice(0, 3)
      const option = (venue, i) => ({
        venue, rank: i + 1, score: slot.category === 'eat' ? 10 - i : i, walk: 5, crowd: 'quiet', reasons: [], warnings: [], swap: null, explanation: '',
        dietUnknown: slot.category === 'eat' && dietPolicy === 'lenient' ? unknownFor[i] : [], verify: [], approximate: false,
      })
      return { options: pool.map(option), current: pool.filter((v) => currentOptionIds.includes(v.id)).map(option), widened: false, few: null, empty: null }
    })
    const { api, id } = await voting(['faith', 'nicole'], ['vegan'])
    await api.setUnconfirmed(id, true)
    const options = (await api.getPlan(id)).slots.find((s) => s.category === 'eat').options
    expect(options.map((o) => o.dietUnknown.length)).toEqual([1, 2, 3])
    expect(options.map((o) => o.id)).toEqual(eat.map((v) => v.id))
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
    // The host (the person here) may take a shared need off; a guest could not (the default of canDrop is false).
    expect(dietChips({ mine: plan.myDietary, others: plan.othersDietary, dropped: plan.dietDropped, canDrop: true })).toEqual([
      { value: 'halal', label: 'Halal', selected: true, shared: true, locked: false, droppedMine: false },
      { value: 'vegetarian', label: 'Vegetarian', selected: true, shared: true, locked: false, droppedMine: false },
      { value: 'vegan', label: 'Vegan', selected: true, shared: false, locked: false, droppedMine: false },
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

  it('lists nobody else\'s needs in an outing of two, so there is no "Unselect" to offer, and lists them once three have joined', async () => {
    // Two people: the other's list would be their own, so it is empty; the places still fit it.
    const pair = await voting(['faith'])
    const twoPlan = await pair.api.getPlan(pair.id)
    expect(twoPlan.dietary).toEqual(['halal'])
    expect(twoPlan.othersDietary).toEqual([])
    expect(dietChips({ mine: twoPlan.myDietary, others: twoPlan.othersDietary, dropped: twoPlan.dietDropped }).some((c) => c.shared)).toBe(false)
    expect(await pair.api.outingDietary(pair.id)).toMatchObject({ dietary: ['halal'], others: [] })
    // Three people: the others' needs together, no names and no counts.
    const trio = await voting(['faith', 'nicole'])
    expect(await trio.api.outingDietary(trio.id)).toMatchObject({ dietary: ['halal', 'vegetarian'], others: ['halal', 'vegetarian'] })
  })

  it('keeps a change of the person’s own needs to this outing, leaves the profile, and ranks the outing again', async () => {
    const { api, id } = await voting(['jonathan'])
    planner.rankSlot.mockClear()
    await api.confirmDiet(id, ['halal'])
    expect((await api.getUser()).dietary).toEqual([])
    expect((await api.getPlan(id)).dietary).toEqual(['halal'])
    expect((await api.getPlan(id)).myDietary).toEqual(['halal'])
    expect(callsFor('eat').at(-1).dietPolicy).toBe('strict')
    // A later change of profile does not undo what the person picked for this outing.
    await api.updateUser({ dietary: ['vegan'] })
    await api.whenRefiltered()
    expect((await api.getPlan(id)).dietary).toEqual(['halal'])
  })
})

describe('the Vote page after "Confirm dietary needs"', () => {
  it('shows a need added beside someone else’s, even when no place drops out', async () => {
    // Every place the planner gives fits every need, so adding one changes no option and no session event follows it.
    planner.rankSlot.mockReset().mockImplementation(async ({ slot, currentOptionIds = [] }) => {
      const option = (venue, i) => ({ venue, rank: i + 1, score: i, walk: 5, crowd: 'quiet', reasons: [], warnings: [], swap: null, explanation: '', dietUnknown: [], verify: [], approximate: false })
      const fits = VENUES.filter((v) => v.category === slot.category)
      return { options: fits.slice(0, 3).map(option), current: fits.filter((v) => currentOptionIds.includes(v.id)).map(option), widened: false, few: null, empty: null }
    })
    const { api, id } = await voting(['faith'])
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { usePlannerStore } = await import('../../stores/planner.js')
    const store = usePlannerStore()
    await store.loadPlan(id)
    expect(store.plans[id].dietary).toEqual(['halal'])
    await store.confirmDiet(id, ['vegetarian'])
    await api.whenRefiltered()
    // The store reloads on its own; wait for the plan it shows to catch up.
    for (let i = 0; i < 100 && store.plans[id].dietary.join() !== 'halal,vegetarian'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(store.plans[id].dietary).toEqual(['halal', 'vegetarian'])
    expect(store.plans[id].myDietary).toEqual(['vegetarian'])
    expect(store.plans[id].dietChecked).toBe(true)
  })

  it('follows a need changed on the profile page, even when no place drops out', async () => {
    planner.rankSlot.mockReset().mockImplementation(async ({ slot, currentOptionIds = [] }) => {
      const option = (venue, i) => ({ venue, rank: i + 1, score: i, walk: 5, crowd: 'quiet', reasons: [], warnings: [], swap: null, explanation: '', dietUnknown: [], verify: [], approximate: false })
      const fits = VENUES.filter((v) => v.category === slot.category)
      return { options: fits.slice(0, 3).map(option), current: fits.filter((v) => currentOptionIds.includes(v.id)).map(option), widened: false, few: null, empty: null }
    })
    const { api, id } = await voting(['faith'])
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { usePlannerStore } = await import('../../stores/planner.js')
    const store = usePlannerStore()
    await store.loadPlan(id)
    await api.updateUser({ dietary: ['vegan'] })
    await api.whenRefiltered()
    for (let i = 0; i < 100 && store.plans[id].dietary.join() !== 'halal,vegan'; i++) await new Promise((r) => setTimeout(r, 50))
    expect(store.plans[id].dietary).toEqual(['halal', 'vegan'])
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
      // Confirming also drops and brings back a need someone else has, as the chips on the Vote page do.
      if (kind === 3) writes.push(api.confirmDiet(id, NEEDS[(i + 2) % NEEDS.length], i % 3 === 0 ? ['halal'] : []))
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
    // The person's picks for this outing, once made, else their profile's.
    expect(plan.myDietary).toEqual(s.dietMine?.ian ?? (await api.getUser()).dietary)
    // The group's needs are the sample friends' and the signed-in person's own, less what the group dropped; a dropped need is
    // always one someone else has, and the chips the page draws say the same as the needs the places are filtered for.
    expect(plan.othersDietary).toEqual(['halal', 'vegetarian'])
    for (const need of plan.dietDropped) expect(plan.othersDietary).toContain(need)
    const ORDER = ['halal', 'vegetarian', 'vegan']
    const expected = [...new Set(['halal', 'vegetarian', ...plan.myDietary])].filter((n) => !plan.dietDropped.includes(n)).sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b))
    expect(plan.dietary).toEqual(expected)
    expect(dietChips({ mine: plan.myDietary, others: plan.othersDietary, dropped: plan.dietDropped }).filter((c) => c.selected).map((c) => c.value)).toEqual(expected)
    // The food places shown were ranked for those needs: the last ranking of Eat asked for exactly them.
    const lastEat = planner.rankSlot.mock.calls.map(([req]) => req).filter((req) => req.slot.category === 'eat').at(-1)
    expect(lastEat.members[0].dietary ?? []).toEqual(expected)
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
    // A centre with MUIS-certified stalls says so first, with the count in the tag itself and the day on hover; its halal tag
    // says to check the stall, because one stall's certificate is not the centre's.
    const muis = { dataQuality: { halalSource: 'muis', halalScope: 'stalls', muisStalls: 9, halalCheckedAt: '2026-10-18' } }
    expect(dietTags({ venue: muis, dietUnknown: [], verify: ['halal', 'vegetarian'] }).map((t) => [t.text, t.tone, t.title])).toEqual([
      ['9 MUIS halal stalls', 'halal', '9 stalls certified halal by MUIS, checked 18 Oct 2026'],
      ['Halal likely', 'halal', 'Halal likely, check the stall'],
      ['Vegetarian likely', 'veg', 'Vegetarian likely, check before you go'],
    ])
    const one = dietTags({ venue: { dataQuality: { halalSource: 'muis', halalScope: 'stalls', muisStalls: 1, halalCheckedAt: '2026-10-18' } } })[0]
    expect([one.text, one.title]).toEqual(['1 MUIS halal stall', '1 stall certified halal by MUIS, checked 18 Oct 2026'])
    // A single certified restaurant is "MUIS halal", with no stall count and no caveat of its own.
    const shop = { dataQuality: { halalSource: 'muis', halalScope: 'venue', muisStalls: 1, halalCheckedAt: '2026-10-18' } }
    expect(dietTags({ venue: shop, dietUnknown: [], verify: [] }).map((t) => [t.text, t.title])).toEqual([['MUIS halal', 'Certified halal by MUIS, checked 18 Oct 2026']])
    // Without a count the tag does not claim one.
    expect(dietTags({ venue: { dataQuality: { halalSource: 'muis', halalScope: 'stalls', muisStalls: 0 } } })).toEqual([])
    expect(dietTags({ venue: {} })).toEqual([])
  })
})

describe('the caveats of a shared session\'s cards, worked out in the browser from the place', () => {
  const eat = { category: 'eat', diet: { halal: 'likely', vegetarian: 'unknown', vegan: 'full' } }

  it('names a need the place only likely meets or has no data on, for the needs given and no others', () => {
    expect(dietCaveats(eat, ['halal', 'vegetarian', 'vegan'])).toEqual({ verify: ['halal'], dietUnknown: ['vegetarian'] })
    expect(dietCaveats(eat, ['vegan'])).toEqual({ verify: [], dietUnknown: [] })
    expect(dietCaveats(eat, [])).toEqual({ verify: [], dietUnknown: [] })
    // Anything that is not a need is left out, and the app's order is kept.
    expect(dietCaveats(eat, ['vegetarian', 'nonsense', 'halal'])).toEqual({ verify: ['halal'], dietUnknown: ['vegetarian'] })
  })

  it('names nothing for a drink, a shop, an activity or a place with no diet levels', () => {
    expect(dietCaveats({ category: 'drink', diet: { halal: 'unknown' } }, ['halal'])).toEqual({ verify: [], dietUnknown: [] })
    expect(dietCaveats({ category: 'activity', diet: null }, ['halal'])).toEqual({ verify: [], dietUnknown: [] })
    expect(dietCaveats(undefined, ['halal'])).toEqual({ verify: [], dietUnknown: [] })
  })

  it('adds one neutral tag, last, when the option is flagged, and none when it is not', () => {
    const flagged = dietTags({ checkNeeds: true, verify: ['halal'], dietUnknown: [] })
    expect(flagged.map((t) => [t.key, t.text, t.tone])).toEqual([['likely-halal', 'Halal likely', 'halal'], ['check-needs', CHECK_NEEDS_TEXT, 'neutral']])
    expect(dietTags({ checkNeeds: true }).map((t) => t.text)).toEqual(["Check it fits everyone's needs"])
    expect(dietTags({ checkNeeds: false, verify: [], dietUnknown: [] })).toEqual([])
    // The line names no need.
    expect(`${CHECK_NEEDS_TEXT} ${unfitGroupNeedsText}`).not.toMatch(/halal|vegan|vegetarian/i)
  })
})

describe('the demo tools\' planner', () => {
  const hawker = VENUES.find((v) => v.kind === 'hawker' && /food centre/i.test(v.name) && !v.halal)
  const certified = VENUES.find((v) => v.id === 'newton-food-centre')
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
    // A centre with MUIS-certified stalls is likely halal, not verified: the group is asked to check the stall.
    expect(dietFit(certified, ['halal', 'vegetarian'], 'strict')).toEqual({ fits: true, verify: ['halal', 'vegetarian'], dietUnknown: [] })
  })

  it('ranks only the food that fits in strict mode', () => {
    const centre = { lat: hawker.lat, lng: hawker.lng }
    const rank = (extra) => standInConverge({ categories: ['eat'], centre, dateTime: '2026-10-17T12:00', durationMinutes: 60, topN: 60, members: [{ id: 'a', dietary: ['halal'] }], ...extra })
    const { results } = rank({ dietPolicy: 'strict', unknownPolicy: 'lenient' })
    expect(results.length).toBeGreaterThan(0)
    // Each is likely halal, and a check is asked for: a centre with MUIS-certified stalls is among them, with the check too.
    expect(results.every((r) => r.verify.includes('halal'))).toBe(true)
    expect(results.some((r) => r.venue.dataQuality?.halalSource === 'muis' && r.venue.dataQuality.halalScope === 'stalls')).toBe(true)
    // The request's own policy words are kept apart: dietPolicy decides the diet; unknownPolicy decides it only when dietPolicy is left out.
    expect(rank({ dietPolicy: 'lenient', unknownPolicy: 'strict' }).results.length).toBeGreaterThan(results.length)
    expect(rank({ unknownPolicy: 'strict' }).results.length).toBe(results.length)
  })
})
