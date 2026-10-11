// Meeting spots in the data layer: the app's spots, a member's suggestion, "works for me", the host confirming, and the
// known place. The planner is stubbed the way the new backend answers (candidates, the chosen area first), except where a
// test says it answers like an older one. Timers are real but Date is fixed, so a test that finds the whole meeting
// area (everyone has a start) takes about a second and a half.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, confirmedSave, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'
import { AREAS } from '../mock/places.js'
import { leadingSpot, nextStepFor, placeText, whereStands } from '../homeMeetups.js'
import { peopleTrips, pinName, tripsLine, unpricedSuggestion } from '../../components/spots/spotText.js'
import { meetingResultLine } from '../planner/index.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

// Each area's longest trip. The first member of a request travels that long; everyone else five minutes less, plus
// whatever `extra` says for them and whatever `skew` says for the area they start in. `fixed` sets a trip outright,
// before rounding ({ bugis: { ian: 29.6 } }). `ranked` is the app's order, fairest first. A test can also slow the
// planner (`delay`: ms, or (call, n) => ms), make it fail (`fail`: true, or (n) => true for the nth call) or have it say
// its times are estimates (`estimate`), and read the requests it got (`calls`).
const WORST = { bugis: 25, bishan: 30, orchard: 31, novena: 27, kovan: 33, 'toa-payoh': 29, clementi: 40, serangoon: 35, bedok: 38, punggol: 36, woodlands: 41, 'boon-lay': 45 }
let world
const area = (id) => AREAS.find((a) => a.id === id)

// The planner as the new backend answers: the chosen area and its runners-up ('ranked'), then each included area
// that is not one of them ('included'). With neither `alternatives` nor `include`, no candidates, as before.
async function answerLikeTheNewBackend({ members, alternatives, include = [] }) {
  const call = { ids: members.map((m) => m.id), include }
  world.calls.push(call)
  const n = world.calls.length
  const slow = typeof world.delay === 'function' ? world.delay(call, n) : world.delay
  if (slow) await new Promise((resolve) => setTimeout(resolve, slow))
  if (typeof world.fail === 'function' ? world.fail(n) : world.fail) throw new Error('Cannot reach the Jio planner right now. Check your connection and try again.')
  const startOf = (m) => AREAS.find((a) => a.lat === m.start.lat && a.lng === m.start.lng)?.id
  const price = (areaId, source) => {
    const travelByMember = Object.fromEntries(members.map((m, i) => [m.id, world.fixed[areaId]?.[m.id] ?? WORST[areaId] - (i === 0 ? 0 : 5) + (world.extra[m.id] || 0) + (world.skew[startOf(m)] || 0)]))
    const minutes = Object.values(travelByMember)
    return { area: area(areaId), worstMinutes: Math.max(...minutes), meanMinutes: minutes.reduce((a, b) => a + b, 0) / minutes.length, travelByMember, approximate: false, source }
  }
  const ranked = world.ranked.slice(0, 1 + (alternatives || 0))
  const candidates = [...ranked.map((a) => price(a, 'ranked')), ...include.filter((a) => !ranked.includes(a)).map((a) => price(a, 'included'))]
  const [first] = candidates
  const answer = { area: first.area, method: 'station', travelByMember: first.travelByMember, worstMinutes: first.worstMinutes, approximate: false, ...(world.estimate ? { travel: { source: 'estimate' } } : {}) }
  return alternatives === undefined && !include.length ? answer : { ...answer, candidates }
}

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  stubPlanner(planner)
  await confirmedSave()
})
beforeEach(() => {
  stubPlanner(planner)
  world = { ranked: ['bugis', 'bishan', 'orchard'], extra: {}, skew: {}, fixed: {}, delay: 0, fail: false, estimate: false, calls: [] }
  planner.meetingArea.mockImplementation(async (args) => answerLikeTheNewBackend(args))
})
afterEach(() => vi.unstubAllGlobals())

const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }
const START = { ian: 'tampines', jonathan: 'jurong-east' }
const storedSpots = (api) => JSON.parse(api.storage.store[STORAGE_KEY]).sessions[0].spots
const areaIds = (session) => session.spots.list.map((s) => s.areaId)

// A session in Locating with Ian, Jonathan and Faith. Ian and Jonathan have a start, Faith has not, so the app's three
// spots are listed and the meeting area waits (it needs everyone).
async function locating({ starts = START, started = true, friends = ['jonathan', 'faith'], pending = false } = {}) {
  const api = await loadApi()
  await api.signUp(PROFILE)
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, friends, { pending })
  if (started) await api.startSession(id)
  for (const [person, areaId] of Object.entries(starts)) await api.setLocation(id, person, 'start', { areaId })
  planner.meetingArea.mockClear()
  world.calls.length = 0
  return { api, id }
}

// The same stored session with another person as its host, so the signed-in person is only a member.
async function hostedBy(api, other) {
  const state = JSON.parse(api.storage.store[STORAGE_KEY])
  for (const session of state.sessions) {
    session.hostId = other
    session.members = session.members.map((m) => ({ ...m, role: m.id === other ? 'host' : 'guest' }))
  }
  return loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
}

describe('the spots the app lists', () => {
  it('lists the fairest three as soon as two people have shared a start, with everyone\'s minutes', async () => {
    const { api, id } = await locating()
    const session = await api.getSession(id)
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard'])
    expect(session.spots.list.every((s) => s.by === 'app' && s.here === false)).toBe(true)
    // Ian travels 25, Jonathan 20: the longest trip, the average and each person's minutes.
    expect(session.spots.list[0]).toMatchObject({ areaId: 'bugis', worstMinutes: 25, meanMinutes: 23, times: { ian: 25, jonathan: 20 }, approximate: false })
    // The meeting area still waits for everyone, as it always did.
    expect(session.meeting).toBeNull()
    expect(session.spots.preselectedAreaId).toBe('bugis')
  })

  it('asks the planner once for the app\'s three, and lists nothing until two starts are in', async () => {
    const api = await loadApi()
    await api.signUp(PROFILE)
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    expect(planner.meetingArea).not.toHaveBeenCalled()
    expect((await api.getSession(id)).spots.list).toEqual([])
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    expect(planner.meetingArea).toHaveBeenCalledTimes(1)
    expect(planner.meetingArea.mock.calls[0][0]).toMatchObject({ alternatives: 2 })
  })

  it('gives a one-spot list when the answer has no candidates (an older backend)', async () => {
    stubPlanner(planner)
    const { api, id } = await locating()
    const session = await api.getSession(id)
    expect(areaIds(session)).toEqual(['bishan'])
    expect(session.spots.list[0]).toMatchObject({ by: 'app', worstMinutes: 20, meanMinutes: 20, times: { ian: 20, jonathan: 20 } })
    // It cannot price a member's suggestion, so it says so and saves nothing.
    await expect(api.suggestSpot(id, 'faith', 'novena')).rejects.toThrow(/could not work out travel times to Novena/)
    expect((await api.getSession(id)).spots.suggestions).toEqual({})
  })
})

describe('works for me', () => {
  it('lets a member approve any number of spots', async () => {
    const { api, id } = await locating()
    for (const spot of ['bugis', 'bishan', 'orchard']) await api.approveSpot(id, 'ian', spot, true)
    await api.approveSpot(id, 'faith', 'bishan', true)
    const session = await api.getSession(id)
    expect(session.spots.approvals.ian).toEqual(['bugis', 'bishan', 'orchard'])
    expect(session.spots.list.map((s) => s.approvalCount)).toEqual([1, 2, 1])
    expect(session.spots.list[1].approvedBy.map((p) => p.id)).toEqual(['ian', 'faith'])
  })

  it('counts approving twice as one approval, and on: false takes it back', async () => {
    const { api, id } = await locating()
    await api.approveSpot(id, 'ian', 'bugis', true)
    await api.approveSpot(id, 'ian', 'bugis', true)
    expect((await api.getSession(id)).spots.approvals.ian).toEqual(['bugis'])
    await api.approveSpot(id, 'ian', 'bugis', false)
    const session = await api.getSession(id)
    expect(session.spots.approvals).toEqual({})
    // Taking back what was never given changes nothing.
    await api.approveSpot(id, 'ian', 'bugis', false)
    expect((await api.getSession(id)).spots.approvals).toEqual({})
  })

  it('works with the backend off, because it needs no planner', async () => {
    const { api, id } = await locating()
    planner.meetingArea.mockRejectedValue(new Error('Cannot reach the Jio planner right now.'))
    await api.approveSpot(id, 'faith', 'orchard', true)
    await api.withdrawSpot(id, 'faith')
    expect((await api.getSession(id)).spots.approvals).toEqual({ faith: ['orchard'] })
    expect(planner.meetingArea).not.toHaveBeenCalled()
  })
})

describe('a member\'s suggestion', () => {
  it('prices the suggested area exactly like the app\'s, in one planner request', async () => {
    const { api, id } = await locating()
    const session = await api.suggestSpot(id, 'faith', 'novena', { here: true })
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard', 'novena'])
    expect(session.spots.list[3]).toMatchObject({ areaId: 'novena', by: 'faith', byName: 'Faith', here: true, worstMinutes: 27, meanMinutes: 25, times: { ian: 27, jonathan: 22 }, approximate: false })
    expect(session.spots.suggestions).toEqual({ faith: { areaId: 'novena', here: true } })
    expect(planner.meetingArea).toHaveBeenCalledTimes(1)
    expect(planner.meetingArea.mock.calls[0][0]).toMatchObject({ alternatives: 2, include: ['novena'] })
  })

  it('keeps one suggestion per member: a second replaces the first and drops the first\'s approvals', async () => {
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'novena')
    await api.approveSpot(id, 'ian', 'novena', true)
    await api.approveSpot(id, 'ian', 'bugis', true)
    planner.meetingArea.mockClear()
    const session = await api.suggestSpot(id, 'faith', 'kovan')
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard', 'kovan'])
    expect(session.spots.suggestions).toEqual({ faith: { areaId: 'kovan', here: false } })
    expect(session.spots.approvals).toEqual({ ian: ['bugis'] })
    expect(session.banner.text).toMatch(/Novena is no longer on the list, so approvals for it were removed\./)
    // Every suggestion is one planner request, and it carries every member's suggestion, not one request per spot.
    expect(planner.meetingArea).toHaveBeenCalledTimes(1)
    expect(planner.meetingArea.mock.calls[0][0].include).toEqual(['kovan'])
  })

  it('does not list an area twice when the suggestion equals one of the app\'s spots', async () => {
    const { api, id } = await locating()
    const session = await api.suggestSpot(id, 'faith', 'bishan', { here: true })
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard'])
    // The area stays the app's, with the label, and needs no planner call.
    expect(session.spots.list[1]).toMatchObject({ areaId: 'bishan', by: 'app', here: true })
    expect(session.spots.suggestions.faith.areaId).toBe('bishan')
    expect(planner.meetingArea).not.toHaveBeenCalled()
    // Taking the suggestion back leaves the app's spot where it was.
    expect(areaIds(await api.withdrawSpot(id, 'faith'))).toEqual(['bugis', 'bishan', 'orchard'])
  })

  it('lets two members suggest the same area, and keeps it until both have taken theirs back', async () => {
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'novena')
    const session = await api.suggestSpot(id, 'jonathan', 'novena')
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard', 'novena'])
    expect(session.spots.list[3].by).toBe('faith')
    expect((await api.withdrawSpot(id, 'faith')).spots.list[3]).toMatchObject({ areaId: 'novena', by: 'jonathan' })
    expect(areaIds(await api.withdrawSpot(id, 'jonathan'))).toEqual(['bugis', 'bishan', 'orchard'])
  })

  it('takes a suggestion back with its approvals', async () => {
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'novena')
    await api.approveSpot(id, 'jonathan', 'novena', true)
    const session = await api.withdrawSpot(id, 'faith')
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard'])
    expect(session.spots.approvals).toEqual({})
    expect(session.spots.suggestions).toEqual({})
  })

  it('says the spots are being worked out while the planner answers', async () => {
    const { api, id } = await locating()
    let open
    const gate = new Promise((resolve) => (open = resolve))
    const real = planner.meetingArea.getMockImplementation()
    planner.meetingArea.mockImplementationOnce(async (args) => {
      await gate
      return real(args)
    })
    const suggesting = api.suggestSpot(id, 'faith', 'novena')
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect((await api.getSession(id)).findingSpots).toBe(true)
    open()
    await suggesting
    expect((await api.getSession(id)).findingSpots).toBe(false)
  })
})

describe('the spot the host is offered', () => {
  it('is the most approved, and a tie goes to the shortest longest trip', async () => {
    const { api, id } = await locating()
    expect((await api.getSession(id)).spots.preselectedAreaId).toBe('bugis')
    // Novena (27) is Faith's; Bishan (30) is the app's second. Two approvals each: the shorter longest trip wins,
    // although Bishan comes first in the list.
    await api.suggestSpot(id, 'faith', 'novena')
    for (const person of ['ian', 'jonathan']) for (const spot of ['bishan', 'novena']) await api.approveSpot(id, person, spot, true)
    expect(areaIds(await api.getSession(id)).indexOf('bishan')).toBeLessThan(areaIds(await api.getSession(id)).indexOf('novena'))
    expect((await api.getSession(id)).spots.preselectedAreaId).toBe('novena')
    // One more approval for Bishan: the most approved wins, however long its longest trip.
    expect((await api.approveSpot(id, 'faith', 'bishan', true)).spots.preselectedAreaId).toBe('bishan')
  })

  it('is confirmed by useMeetingArea', async () => {
    const { api, id } = await locating()
    await api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    for (const person of ['ian', 'jonathan']) await api.approveSpot(id, person, 'orchard', true)
    const session = await api.useMeetingArea(id)
    expect(session).toMatchObject({ status: 'voting', areaName: 'Orchard' })
    expect(session.meeting.method).toBe('voted')
  })
})

describe('the host confirms', () => {
  it('at any time, with no approvals, and the group moves on to choosing places', async () => {
    const { api, id } = await locating()
    // Faith has not shared a start and nobody approved anything.
    const session = await api.confirmSpot(id, 'orchard')
    expect(session).toMatchObject({ status: 'voting', areaName: 'Orchard', banner: null })
    expect(session.meeting).toMatchObject({ areaId: 'orchard', method: 'chosen', times: { ian: 31, jonathan: 26 }, maxMinutes: 31, count: 2 })
    // Places are ranked for the people who have a start.
    const { members, centre } = planner.rankSlot.mock.calls[0][0]
    expect(members.map((m) => m.id)).toEqual(['ian', 'jonathan'])
    expect(centre.id).toBe('orchard')
  })

  it('gives the planner\'s own method to the app\'s first spot nobody approved, "voted" to an approved one, "chosen" to the rest', async () => {
    const first = await locating()
    expect((await first.api.confirmSpot(first.id, 'bugis')).meeting.method).toBe('fairest')
    const approved = await locating()
    await approved.api.approveSpot(approved.id, 'faith', 'bishan', true)
    expect((await approved.api.confirmSpot(approved.id, 'bishan')).meeting.method).toBe('voted')
    const other = await locating()
    expect((await other.api.confirmSpot(other.id, 'bishan')).meeting.method).toBe('chosen')
  })

  it('is only the host: a member can neither confirm a spot nor set a known place', async () => {
    const { api } = await locating()
    const member = await hostedBy(api, 'jonathan')
    const [session] = await member.listSessions()
    await expect(member.confirmSpot(session.id, 'bugis')).rejects.toThrow(/Only the host can confirm a spot/)
    await expect(member.setKnownPlace(session.id, 'bugis')).rejects.toThrow(/Only the host can set a known place/)
    expect((await member.getSession(session.id)).status).toBe('locating')
  })

  it('refuses a spot that is not on the list', async () => {
    const { api, id } = await locating()
    await expect(api.confirmSpot(id, 'kovan')).rejects.toThrow(/not on the list/)
    await expect(api.confirmSpot(id, 'atlantis')).rejects.toThrow(/not on the list/)
    expect((await api.getSession(id)).status).toBe('locating')
  })

  it('keeps a confirmed area when someone adds where they start, and only adds the travel time', async () => {
    const { api, id } = await locating()
    await api.approveSpot(id, 'ian', 'orchard', true)
    await api.confirmSpot(id, 'orchard')
    // The planner would now rank Bugis first; the group chose Orchard.
    const session = await api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    expect(session.areaName).toBe('Orchard')
    expect(session.meeting).toMatchObject({ method: 'voted', count: 3 })
    expect(Object.keys(session.meeting.times).sort()).toEqual(['faith', 'ian', 'jonathan'])
    expect(session.spots.list.find((s) => s.areaId === 'orchard').times.faith).toBe(26)
  })
})

describe('a changed start', () => {
  it('works the spots out again, keeps approvals for spots still listed, removes the rest and says so', async () => {
    const { api, id } = await locating()
    await api.approveSpot(id, 'ian', 'bugis', true)
    await api.approveSpot(id, 'ian', 'orchard', true)
    await api.approveSpot(id, 'jonathan', 'orchard', true)
    await api.approveSpot(id, 'jonathan', 'bishan', true)
    // Jonathan moves: Novena comes into the app's three, Orchard drops out, and his trips are longer.
    world.ranked = ['bugis', 'bishan', 'novena']
    world.extra.jonathan = 6
    planner.meetingArea.mockClear()
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'novena'])
    expect(session.spots.list[0].times).toEqual({ ian: 25, jonathan: 26 })
    expect(session.spots.approvals).toEqual({ ian: ['bugis'], jonathan: ['bishan'] })
    expect(session.banner.text).toMatch(/Orchard is no longer on the list, so approvals for it were removed\./)
    expect(session.banner.approvalsRemoved).toBe(true)
    expect(planner.meetingArea).toHaveBeenCalledTimes(1)
  })

  it('says nothing about approvals when every approved spot is still listed', async () => {
    const { api, id } = await locating()
    await api.approveSpot(id, 'ian', 'bugis', true)
    world.extra.jonathan = 2
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    expect(session.spots.approvals).toEqual({ ian: ['bugis'] })
    expect(session.banner?.approvalsRemoved).toBeUndefined()
  })

  it('keeps a member\'s suggestion listed, and priced again, when the app\'s list changes', async () => {
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'novena')
    world.ranked = ['bugis', 'bishan', 'novena']
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    // Novena is now one of the app's, and still Faith's suggestion.
    expect(session.spots.list.find((s) => s.areaId === 'novena').by).toBe('app')
    expect(session.spots.suggestions.faith.areaId).toBe('novena')
    world.ranked = ['bugis', 'bishan', 'orchard']
    expect((await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })).spots.list.find((s) => s.areaId === 'novena')).toMatchObject({ by: 'faith' })
  })

  it('leaves the status in Locating until the host confirms', async () => {
    const { api, id } = await locating()
    const session = await api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    expect(session.status).toBe('locating')
    expect(session.meeting).toMatchObject({ areaId: 'bugis', method: 'fairest', count: 3 })
    expect(session.spots.list[0].times).toEqual({ ian: 25, jonathan: 20, faith: 20 })
  })
})

describe('opting out', () => {
  it('removes that person\'s suggestion and approvals, and the approvals for a spot that goes with it', async () => {
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'novena')
    await api.approveSpot(id, 'faith', 'bugis', true)
    await api.approveSpot(id, 'ian', 'novena', true)
    await api.approveSpot(id, 'ian', 'bishan', true)
    const session = await api.optOut(id, 'faith')
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard'])
    expect(session.spots.suggestions).toEqual({})
    expect(session.spots.approvals).toEqual({ ian: ['bishan'] })
    expect(session.banner.text).toMatch(/Novena is no longer on the list, so approvals for it were removed\./)
  })
})

describe('the known place', () => {
  it('goes from inviting straight to voting with a one-spot list, ranking places for people who have shared nothing', async () => {
    const { api, id } = await locating({ starts: {}, started: false, friends: ['jonathan'] })
    const session = await api.setKnownPlace(id, 'novena')
    expect(session).toMatchObject({ status: 'voting', areaName: 'Novena' })
    expect(session.meeting).toMatchObject({ areaId: 'novena', method: 'chosen', times: {}, count: 0 })
    expect(session.spots.list).toEqual([
      expect.objectContaining({ areaId: 'novena', by: 'ian', here: false, worstMinutes: null, meanMinutes: null, times: {}, approximate: false }),
    ])
    expect(session.spots.preselectedAreaId).toBe('novena')
    // Nobody has a start, so there is no trip to price. The planner still needs people to rank places for: everyone is
    // sent starting at the meeting area.
    expect(planner.meetingArea).not.toHaveBeenCalled()
    const { members } = planner.rankSlot.mock.calls[0][0]
    expect(members.map((m) => m.id)).toEqual(['ian', 'jonathan'])
    for (const m of members) expect(m).toMatchObject({ start: { lat: area('novena').lat, lng: area('novena').lng }, end: { lat: area('novena').lat, lng: area('novena').lng } })
    expect(resultLine(session)).toBe('Chosen by the host: Novena.')
  })

  it('lets members add where they start afterwards, which only adds travel times', async () => {
    const { api, id } = await locating({ starts: {}, started: false, friends: ['jonathan'] })
    await api.setKnownPlace(id, 'novena')
    // The planner would put Bugis first; the known place stays.
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    expect(session.areaName).toBe('Novena')
    expect(session.meeting).toMatchObject({ areaId: 'novena', method: 'chosen', times: { jonathan: 27 }, maxMinutes: 27, count: 1 })
    expect(session.spots.list[0]).toMatchObject({ areaId: 'novena', times: { jonathan: 27 }, worstMinutes: 27 })
    expect(resultLine(session)).toBe('Chosen by the host: Novena. The longest trip is about 27 minutes.')
    expect(planner.rankSlot.mock.calls.at(-1)[0].members.map((m) => m.id)).toEqual(['jonathan'])
  })

  it('works from locating too: it replaces the whole list and clears the approvals', async () => {
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'kovan')
    await api.approveSpot(id, 'ian', 'bugis', true)
    planner.meetingArea.mockClear()
    const session = await api.setKnownPlace(id, 'novena')
    expect(session.status).toBe('voting')
    expect(areaIds(session)).toEqual(['novena'])
    expect(session.spots.approvals).toEqual({})
    expect(session.spots.suggestions).toEqual({})
    expect(session.spots.list[0]).toMatchObject({ by: 'ian', times: { ian: 27, jonathan: 22 }, worstMinutes: 27 })
    expect(session.meeting).toMatchObject({ areaId: 'novena', method: 'chosen', times: { ian: 27, jonathan: 22 } })
    // One request prices the known place for the people who have a start.
    expect(planner.meetingArea).toHaveBeenCalledTimes(1)
    expect(planner.meetingArea.mock.calls[0][0]).toMatchObject({ include: ['novena'] })
    expect(planner.meetingArea.mock.calls[0][0]).not.toHaveProperty('alternatives')
  })

  it('lets pending invites lapse and needs two people, as starting a session does', async () => {
    const { api, id } = await locating({ starts: {}, started: false, friends: ['jonathan', 'faith'], pending: true })
    const alone = await api.getSession(id)
    expect(alone.activeIds).toEqual(['ian'])
    await expect(api.setKnownPlace(id, 'novena')).rejects.toThrow(/at least 2 people/)
    expect((await api.getSession(id)).status).toBe('inviting')
    await api.inviteFriends(id, ['jonathan'])
    const session = await api.setKnownPlace(id, 'novena')
    expect(session.members.map((m) => m.id)).toEqual(['ian', 'jonathan'])
  })

  it('is refused for an unknown area, or once the group is voting', async () => {
    const { api, id } = await locating()
    await expect(api.setKnownPlace(id, 'atlantis')).rejects.toThrow(/does not exist/)
    await api.setKnownPlace(id, 'novena')
    await expect(api.setKnownPlace(id, 'bugis')).rejects.toThrow(/before the group votes/)
  })
})

describe('when the planner cannot answer', () => {
  it('rolls the whole write back', async () => {
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'novena')
    await api.approveSpot(id, 'ian', 'novena', true)
    const before = await api.getSession(id)
    const storedBefore = storedSpots(api)
    planner.meetingArea.mockRejectedValue(new Error('Cannot reach the Jio planner right now.'))
    await expect(api.suggestSpot(id, 'jonathan', 'kovan')).rejects.toThrow(/Cannot reach the Jio planner/)
    await expect(api.setKnownPlace(id, 'bugis')).rejects.toThrow(/Cannot reach the Jio planner/)
    await expect(api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })).rejects.toThrow(/Cannot reach the Jio planner/)
    const after = await api.getSession(id)
    expect(after.spots).toEqual(before.spots)
    expect(after).toMatchObject({ status: 'locating', locations: before.locations })
    expect(storedSpots(api)).toEqual(storedBefore)
    // And the same session works again once the planner is back.
    planner.meetingArea.mockImplementation(async (args) => answerLikeTheNewBackend(args))
    expect(areaIds(await api.suggestSpot(id, 'jonathan', 'kovan'))).toContain('kovan')
  })

  it('also undoes a confirmed spot when ranking the places fails', async () => {
    const { api, id } = await locating()
    planner.rankSlot.mockRejectedValue(new Error('The planner had a problem. Try again.'))
    await expect(api.confirmSpot(id, 'bishan')).rejects.toThrow(/had a problem/)
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'locating', meeting: null })
    expect(session.spots.preselectedAreaId).toBe('bugis')
  })
})

describe('a session that is over, or not choosing where to meet', () => {
  const writes = async (api, id) => {
    await expect(api.suggestSpot(id, 'faith', 'novena')).rejects.toThrow(/has ended/)
    await expect(api.withdrawSpot(id, 'faith')).rejects.toThrow(/has ended/)
    await expect(api.approveSpot(id, 'ian', 'bugis', true)).rejects.toThrow(/has ended/)
    await expect(api.confirmSpot(id, 'bugis')).rejects.toThrow(/has ended/)
    await expect(api.setKnownPlace(id, 'bugis')).rejects.toThrow(/has ended/)
  }

  it('writes nothing once it is cancelled', async () => {
    const { api, id } = await locating()
    await api.cancelSession(id)
    const saved = api.storage.writes
    await writes(api, id)
    expect(api.storage.writes).toBe(saved)
    expect(planner.meetingArea).not.toHaveBeenCalled()
  })

  it('writes nothing once it is completed', async () => {
    const { api, id } = await loadConfirmed()
    await api.endPlan(id)
    const saved = api.storage.writes
    planner.meetingArea.mockClear()
    await writes(api, id)
    expect(api.storage.writes).toBe(saved)
    expect(planner.meetingArea).not.toHaveBeenCalled()
  })

  it('refuses approvals and suggestions while inviting and once the group is voting', async () => {
    const inviting = await locating({ starts: {}, started: false, friends: ['jonathan'] })
    const other = /choosing where to meet/
    await expect(inviting.api.approveSpot(inviting.id, 'ian', 'bugis', true)).rejects.toThrow(other)
    await expect(inviting.api.suggestSpot(inviting.id, 'ian', 'bugis')).rejects.toThrow(other)
    await expect(inviting.api.withdrawSpot(inviting.id, 'ian')).rejects.toThrow(other)
    await expect(inviting.api.confirmSpot(inviting.id, 'bugis')).rejects.toThrow(other)

    const { api, id } = await locating()
    await api.confirmSpot(id, 'bugis')
    await expect(api.approveSpot(id, 'ian', 'bishan', true)).rejects.toThrow(other)
    await expect(api.suggestSpot(id, 'faith', 'novena')).rejects.toThrow(other)
    await expect(api.withdrawSpot(id, 'faith')).rejects.toThrow(other)
    await expect(api.confirmSpot(id, 'bishan')).rejects.toThrow(other)
  })

  it('refuses a person who is not in the session', async () => {
    const { api, id } = await locating()
    await expect(api.approveSpot(id, 'darius', 'bugis', true)).rejects.toThrow(/Only people in this session/)
    await api.optOut(id, 'faith')
    await expect(api.suggestSpot(id, 'faith', 'novena')).rejects.toThrow(/Only people in this session/)
  })
})

describe('an area that is not one the app knows', () => {
  it('is refused', async () => {
    const { api, id } = await locating()
    await expect(api.suggestSpot(id, 'faith', 'atlantis')).rejects.toThrow(/This area does not exist/)
    await expect(api.approveSpot(id, 'ian', 'atlantis', true)).rejects.toThrow(/not on the list/)
    // A real area that is not listed is not something to approve either.
    await expect(api.approveSpot(id, 'ian', 'kovan', true)).rejects.toThrow(/not on the list/)
    expect(planner.meetingArea).not.toHaveBeenCalled()
    expect((await api.getSession(id)).spots.approvals).toEqual({})
  })

  it('is refused when more different spots are suggested than the planner prices at once', async () => {
    const others = ['darius', 'nicole', 'faith', 'darryl', 'meiling', 'arjun', 'siti', 'weijie', 'priya']
    const { api, id } = await locating({ friends: ['jonathan', ...others] })
    const spots = ['novena', 'kovan', 'toa-payoh', 'clementi', 'serangoon', 'bedok', 'punggol', 'woodlands', 'boon-lay']
    for (const [i, person] of others.slice(0, 8).entries()) await api.suggestSpot(id, person, spots[i])
    await expect(api.suggestSpot(id, 'priya', spots[8])).rejects.toThrow(/up to 8 different spots/)
    // Replacing one of the eight is still fine.
    expect(areaIds(await api.suggestSpot(id, 'darius', 'boon-lay'))).toContain('boon-lay')
  })
})

describe('what the group sees of a member', () => {
  // Every key path in a value, so a test can say where a name or a coordinate appears.
  const paths = (value, path = []) =>
    value !== null && typeof value === 'object'
      ? Object.entries(value).flatMap(([key, child]) => [...(Array.isArray(value) ? [] : [[...path, key].join('.')]), ...paths(child, [...path, Array.isArray(value) ? '[]' : key])])
      : []

  it('is only their area: no label and no coordinates in the spots or in the session', async () => {
    const api = await loadApi()
    await api.signUp(PROFILE)
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan', 'faith'])
    await api.startSession(id)
    await api.setLocation(id, 'ian', 'start', { areaId: 'tampines', label: 'Blk 12 Tampines St 11' })
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east', label: 'Secret Condo 7 Jurong' })
    await api.suggestSpot(id, 'jonathan', 'novena', { here: true })
    await api.approveSpot(id, 'faith', 'novena', true)
    const session = await api.getSession(id)
    const text = JSON.stringify(session.spots)
    expect(text).not.toMatch(/Blk 12|Secret Condo/)
    // In what is stored, a spot has no label or coordinates at all.
    const stored = JSON.parse(api.storage.store[STORAGE_KEY]).sessions[0].spots
    expect(paths(stored).filter((p) => /(^|\.)(label|lat|lng|start|end|name)$/.test(p))).toEqual([])
    // In what the screens read, coordinates are only ever an area's own (under `area`).
    const loose = paths(session.spots).filter((p) => /(^|\.)(label|lat|lng)$/.test(p) && !/(^|\.)area\.(lat|lng)$/.test(p))
    expect(loose).toEqual([])
    for (const spot of session.spots.list) expect(spot.area).toEqual(area(spot.areaId))
    // Nobody else's label is anywhere in the session either.
    expect(JSON.stringify(session)).not.toMatch(/Secret Condo/)
  })
})

describe('a saved state', () => {
  const saved = async () => {
    const { api } = await locating()
    return JSON.parse(api.storage.store[STORAGE_KEY])
  }

  it('from version 8 loads, and keeps the account and the friends', async () => {
    const state = await saved()
    state.version = 8
    state.friends = ['darius']
    for (const session of state.sessions) delete session.spots
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    expect(await api.listSessions()).toEqual([])
    expect((await api.getUser()).name).toBe('Ian')
    expect((await api.listPeople()).find((p) => p.id === 'darius').isFriend).toBe(true)
    // And it works: a new session has spots.
    const { id } = await api.createSession({ title: 'Again', date: '2026-10-10', start: '12:00', end: '20:00' })
    expect((await api.getSession(id)).spots).toMatchObject({ list: [], approvals: {}, suggestions: {}, preselectedAreaId: null })
  })

  it('of this version keeps its spots and approvals', async () => {
    const { api, id } = await locating()
    await api.approveSpot(id, 'ian', 'bugis', true)
    await api.suggestSpot(id, 'faith', 'novena')
    const again = await loadApi({ data: { [STORAGE_KEY]: api.storage.store[STORAGE_KEY] } })
    const session = await again.getSession(id)
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard', 'novena'])
    expect(session.spots.approvals).toEqual({ ian: ['bugis'] })
  })

  it.each([
    ['spots gone', (s) => delete s.sessions[0].spots],
    ['spots without a list', (s) => delete s.sessions[0].spots.list],
    ['approvals that are not lists', (s) => (s.sessions[0].spots.approvals = { ian: 'bugis' })],
    ['suggestions gone', (s) => delete s.sessions[0].spots.suggestions],
  ])('is replaced by a fresh one when %s, keeping the account', async (_name, damage) => {
    const state = await saved()
    damage(state)
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    expect(await api.listSessions()).toEqual([])
    expect((await api.getUser()).name).toBe('Ian')
  })
})

describe('the words and the next step', () => {
  it('says something true about a spot the group voted for, one the host chose, and one chosen with no start shared', () => {
    expect(meetingResultLine({ method: 'voted', maxMinutes: 31, count: 3 }, 'Orchard')).toBe('Confirmed by the host: Orchard, which members said works for them. The longest trip is about 31 minutes.')
    expect(meetingResultLine({ method: 'chosen', maxMinutes: 27, count: 2 }, 'Novena')).toBe('Chosen by the host: Novena. The longest trip is about 27 minutes.')
    expect(meetingResultLine({ method: 'chosen', maxMinutes: 0, count: 0 }, 'Novena')).toBe('Chosen by the host: Novena.')
    expect(meetingResultLine({ method: 'fairest', maxMinutes: 20, count: 2 }, 'Bishan')).toBe('Fairest for 2 people: nobody travels more than about 20 minutes.')
  })

  it('asks the host to confirm a spot, a member who approved nothing to say which work, and keeps the old answers', () => {
    const start = (id) => ({ areaId: id, name: id, lat: 1, lng: 103 })
    const session = {
      id: 's1',
      hostId: 'ian',
      status: 'locating',
      activeIds: ['ian', 'jonathan', 'faith'],
      members: [],
      locations: { ian: { start: start('tampines') }, jonathan: { start: start('jurong-east') }, faith: { start: start('woodlands') } },
      votes: {},
      meeting: null,
      findingMeeting: false,
      spots: { list: [{ areaId: 'bugis' }], approvals: { jonathan: ['bugis'] } },
    }
    expect(nextStepFor(session, 'ian')).toMatchObject({ label: 'Confirm the spot', tone: 'action', to: '/sessions/s1' })
    expect(nextStepFor(session, 'faith')).toMatchObject({ label: 'Pick your spots', tone: 'action' })
    expect(nextStepFor(session, 'jonathan')).toMatchObject({ label: 'Waiting for the host', tone: 'wait' })
    // Still first: share your start, and wait while the planner works.
    expect(nextStepFor({ ...session, locations: {} }, 'faith').label).toBe('Share your start')
    expect(nextStepFor({ ...session, findingMeeting: true }, 'ian').label).toBe('Finding the midpoint')
    // No spots listed: the old answers.
    expect(nextStepFor({ ...session, spots: { list: [], approvals: {} }, meeting: { areaId: 'bugis' } }, 'ian').label).toBe('Confirm the meeting point')
    expect(nextStepFor({ ...session, spots: undefined, meeting: null }, 'ian').label).toBe('Waiting for others')
  })
})

// What the planner gets, and when it answers: the host can confirm while a request is out, and a request can fail.
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const message = async (promise) => {
  try {
    await promise
    return null
  } catch (err) {
    return err.message
  }
}
const COULD_NOT = /Cannot reach the Jio planner/

// These wait for the planner twice (the first answer, then the confirmed area again), each with the "finding the meeting point" bar.
describe('an answer that arrives after the host confirmed', { timeout: 20_000 }, () => {
  it('leaves the confirmed spot, and the votes for places, alone when a new start is added meanwhile', async () => {
    const { api, id } = await locating()
    world.delay = (call, n) => (n === 1 ? 300 : 0)
    // Faith's start would make Bugis the meeting area and move it off Orchard.
    const adding = api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    await sleep(100)
    await api.confirmSpot(id, 'orchard')
    const { slots } = await api.getPlan(id)
    await api.vote(id, slots[0].id, 'ian', slots[0].options[0].id)
    await adding
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', areaName: 'Orchard' })
    expect(session.meeting).toMatchObject({ areaId: 'orchard', method: 'chosen', count: 3 })
    // The confirmed area now also has Faith's trip, as for any start that comes in after a confirm.
    expect(Object.keys(session.meeting.times).sort()).toEqual(['faith', 'ian', 'jonathan'])
    expect(session.banner?.text ?? '').not.toMatch(/moved|Bugis/)
    expect(session.votes[slots[0].id]).toEqual({ ian: slots[0].options[0].id })
    expect(Object.keys(session.options).length).toBeGreaterThan(0)
  })

  it('does not leave Voting with no meeting area when a start changes while one person still has none', async () => {
    const { api, id } = await locating()
    world.delay = (call, n) => (n === 1 ? 300 : 0)
    const changing = api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    await sleep(100)
    await api.confirmSpot(id, 'bishan')
    await changing
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', areaName: 'Bishan' })
    expect(session.meeting.areaId).toBe('bishan')
    expect(Object.keys(session.options).length).toBeGreaterThan(0)
  })

  it('asks again for the confirmed area instead of putting the old answer in', async () => {
    const { api, id } = await locating()
    world.delay = (call, n) => (n === 1 ? 300 : 0)
    const changing = api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    await sleep(100)
    await api.confirmSpot(id, 'bishan')
    await changing
    // The second request prices the area that was confirmed, for the starts there are now.
    expect(world.calls).toHaveLength(2)
    expect(world.calls[1].include).toContain('bishan')
  })

  for (const approved of [false, true]) {
    it(`keeps a spot the host ${approved ? 'confirmed with approvals as voted' : 'chose as chosen'}, whichever answer comes last`, async () => {
      const { api, id } = await locating()
      if (approved) await api.approveSpot(id, 'ian', 'orchard', true)
      world.delay = (call, n) => (n === 1 ? 200 : 0)
      const adding = api.setLocation(id, 'faith', 'start', { areaId: 'bedok' })
      await sleep(80)
      await api.confirmSpot(id, 'orchard')
      await adding
      expect((await api.getSession(id)).meeting).toMatchObject({ areaId: 'orchard', method: approved ? 'voted' : 'chosen' })
    })
  }

  it('also holds for the demo\'s routing switch', async () => {
    const { api, id } = await locating()
    world.delay = (call, n) => (n === 1 ? 300 : 0)
    const switching = api.setConditions({ routing: false })
    await sleep(100)
    await api.confirmSpot(id, 'orchard')
    await switching
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', areaName: 'Orchard' })
    expect(session.meeting.areaId).toBe('orchard')
  })
})

describe('a write that fails after the host confirmed', () => {
  it('takes back a start, but not the confirmation', async () => {
    const { api, id } = await locating()
    world.delay = 300
    world.fail = (n) => n === 1
    const changing = message(api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' }))
    await sleep(100)
    world.delay = 0
    await api.confirmSpot(id, 'orchard')
    expect(await changing).toMatch(COULD_NOT)
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', areaName: 'Orchard' })
    expect(session.meeting.method).toBe('chosen')
    expect(session.locations.jonathan.start.areaId).toBe('jurong-east')
    expect(Object.keys(session.options).length).toBeGreaterThan(0)
  })

  it('takes back a suggestion, but not the confirmation', async () => {
    const { api, id } = await locating()
    world.delay = 300
    world.fail = (n) => n === 1
    const suggesting = message(api.suggestSpot(id, 'faith', 'bedok'))
    await sleep(100)
    world.delay = 0
    await api.confirmSpot(id, 'bishan')
    expect(await suggesting).toMatch(COULD_NOT)
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', areaName: 'Bishan' })
    expect(session.spots.suggestions).toEqual({})
  })

  it('tells a suggestion that arrives after the confirm that the spots are closed, and does not keep it', async () => {
    const { api, id } = await locating()
    world.delay = (call, n) => (n === 1 ? 300 : 0)
    const suggesting = message(api.suggestSpot(id, 'faith', 'bedok'))
    await sleep(100)
    await api.confirmSpot(id, 'bishan')
    expect(await suggesting).toMatch(/choosing where to meet/)
    const session = await api.getSession(id)
    expect(session).toMatchObject({ status: 'voting', areaName: 'Bishan' })
    expect(session.spots.suggestions).toEqual({})
  })

  it('keeps an approval tapped during someone else\'s failing write', async () => {
    const { api, id } = await locating()
    world.delay = 300
    world.fail = (n) => n === 1
    const changing = message(api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' }))
    await sleep(100)
    await api.approveSpot(id, 'faith', 'orchard', true)
    expect(await changing).toMatch(COULD_NOT)
    const session = await api.getSession(id)
    expect(session.spots.approvals).toEqual({ faith: ['orchard'] })
    expect(session).toMatchObject({ status: 'locating' })
    expect(session.locations.jonathan.start.areaId).toBe('jurong-east')
  })

  it('does not take back another write\'s start while it waits', async () => {
    const { api, id } = await locating()
    world.delay = (call, n) => (n === 1 ? 100 : 400)
    world.fail = (n) => n === 1
    const failing = message(api.suggestSpot(id, 'jonathan', 'bedok'))
    await sleep(60)
    const adding = api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    expect(await failing).toMatch(COULD_NOT)
    await adding
    const session = await api.getSession(id)
    expect(session.locations.faith.start.areaId).toBe('woodlands')
    expect(session.spots.suggestions).toEqual({})
    expect(session.meeting).not.toBeNull()
  })
})

describe('suggestions that overlap', () => {
  for (const [name, delay] of [['the first answer slower', (call, n) => (n === 1 ? 400 : 50)], ['the first answer faster', (call, n) => (n === 1 ? 50 : 400)]]) {
    it(`both keep their suggestions when two members suggest within the planner's latency (${name})`, async () => {
      const { api, id } = await locating()
      world.delay = delay
      await Promise.all([api.suggestSpot(id, 'faith', 'novena'), api.suggestSpot(id, 'jonathan', 'kovan')])
      const session = await api.getSession(id)
      expect(session.spots.suggestions).toEqual({ faith: { areaId: 'novena', here: false }, jonathan: { areaId: 'kovan', here: false } })
      expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard', 'novena', 'kovan'])
      expect(session.banner).toBeNull()
    })
  }

  it('does not lose a suggestion with its approvals to the answer to an earlier request', async () => {
    const { api, id } = await locating({ friends: ['jonathan', 'faith', 'darryl'] })
    await api.suggestSpot(id, 'faith', 'novena')
    await api.approveSpot(id, 'ian', 'novena', true)
    world.delay = (call, n) => (n === 1 ? 400 : 50)
    await Promise.all([api.suggestSpot(id, 'jonathan', 'kovan'), api.suggestSpot(id, 'darryl', 'bedok')])
    const session = await api.getSession(id)
    expect(areaIds(session)).toEqual(['bugis', 'bishan', 'orchard', 'novena', 'kovan', 'bedok'])
    expect(session.spots.approvals).toEqual({ ian: ['novena'] })
  })

  it('prices a suggestion for the starts there are when a start changes while it is out', async () => {
    const { api, id } = await locating()
    world.skew = { woodlands: 15 }
    world.delay = (call, n) => (n === 1 ? 400 : 0)
    const suggesting = api.suggestSpot(id, 'faith', 'bedok')
    await sleep(100)
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    await suggesting
    const bedok = (await api.getSession(id)).spots.list.find((s) => s.areaId === 'bedok')
    // Ian travels 38; Jonathan 38 - 5 + 15 from Woodlands, not the 33 from where he started.
    expect(bedok).toMatchObject({ worstMinutes: 48, times: { ian: 38, jonathan: 48 } })
  })

  it('asks again when the request that took over fails', async () => {
    const { api, id } = await locating()
    world.skew = { woodlands: 15 }
    world.delay = (call, n) => (n === 1 ? 300 : 80)
    world.fail = (n) => n === 2
    const moving = api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    await sleep(100)
    expect(await message(api.suggestSpot(id, 'faith', 'bedok'))).toMatch(COULD_NOT)
    await moving
    const session = await api.getSession(id)
    // The start change is in, priced for the new start, and the suggestion that failed is gone.
    expect(session.locations.jonathan.start.areaId).toBe('woodlands')
    expect(session.spots.list[0].times.jonathan).toBe(WORST.bugis - 5 + 15)
    expect(session.spots.suggestions).toEqual({})
    expect(world.calls).toHaveLength(3)
  })

  it('does not leave the spots marked as being worked out', async () => {
    const { api, id } = await locating()
    world.delay = (call, n) => (n === 1 ? 300 : 50)
    await Promise.all([api.suggestSpot(id, 'faith', 'novena'), api.suggestSpot(id, 'jonathan', 'kovan')])
    expect((await api.getSession(id)).findingSpots).toBe(false)
  })
})

describe('a suggestion saved before it was priced', () => {
  it('is on the stored session after a reload, with no row, and can be priced again or withdrawn', async () => {
    const { api, id } = await locating()
    world.delay = 600
    const suggesting = api.suggestSpot(id, 'ian', 'bedok', { here: true })
    await sleep(150)
    // A reload now: the stored session has the suggestion and no row for it.
    const reloaded = await loadApi({ data: { [STORAGE_KEY]: api.storage.store[STORAGE_KEY] } })
    const stuck = await reloaded.getSession(id)
    expect(stuck.spots.suggestions).toEqual({ ian: { areaId: 'bedok', here: true } })
    expect(areaIds(stuck)).not.toContain('bedok')
    expect(unpricedSuggestion(stuck, 'ian')).toEqual({ areaId: 'bedok', name: 'Bedok', here: true })
    await suggesting
    // Priced again, it has its row; withdrawn, it is gone and so is the offer.
    world.delay = 0
    expect(areaIds(await reloaded.suggestSpot(id, 'ian', 'bedok', { here: true }))).toContain('bedok')
    expect(unpricedSuggestion(await reloaded.getSession(id), 'ian')).toBeNull()
    expect(unpricedSuggestion(stuck, 'ian')).not.toBeNull()
    const gone = await reloaded.withdrawSpot(id, 'ian')
    expect(gone.spots.suggestions).toEqual({})
    expect(areaIds(gone)).not.toContain('bedok')
  })

  it('is offered only for your own suggestion, while the group is choosing and the planner is not working on it', () => {
    const base = { status: 'locating', findingSpots: false, spots: { list: [{ areaId: 'bugis' }], suggestions: { ian: { areaId: 'bedok', here: false } } } }
    expect(unpricedSuggestion(base, 'ian')).toMatchObject({ areaId: 'bedok', name: 'Bedok' })
    expect(unpricedSuggestion(base, 'faith')).toBeNull()
    expect(unpricedSuggestion({ ...base, findingSpots: true }, 'ian')).toBeNull()
    expect(unpricedSuggestion({ ...base, status: 'voting' }, 'ian')).toBeNull()
    expect(unpricedSuggestion({ ...base, spots: { ...base.spots, list: [{ areaId: 'bedok' }] } }, 'ian')).toBeNull()
    expect(unpricedSuggestion({ status: 'locating' }, 'ian')).toBeNull()
  })
})

describe('travel times that are estimates', () => {
  it('are approximate for every spot and the meeting area when the planner says its times are estimates', async () => {
    const { api, id } = await locating()
    world.estimate = true
    const session = await api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    expect(session.meeting.approximate).toBe(true)
    expect(session.spots.list.every((s) => s.approximate)).toBe(true)
    // A suggestion is priced from the same answer.
    const suggested = await api.suggestSpot(id, 'faith', 'novena')
    expect(suggested.spots.list.find((s) => s.areaId === 'novena').approximate).toBe(true)
    // Every place the minutes are written says "about".
    const spot = suggested.spots.list[0]
    expect(tripsLine(spot)).toMatch(/^Longest trip about \d+ min · Average about \d+ min$/)
    expect(peopleTrips(spot, (person) => person, 'ian').every((trip) => trip.text.startsWith('about '))).toBe(true)
    expect(pinName(spot, 1, 'ian')).toContain('Longest trip about')
    expect(whereStands({ ...suggested, status: 'voting', spots: { list: [] } }, 'ian').text).toContain('about')
    expect(session.resultLine).toContain('about')
  })

  it('are approximate for a confirmed area that is priced again for a new start', async () => {
    const { api, id } = await locating()
    world.estimate = true
    await api.confirmSpot(id, 'orchard')
    const session = await api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    expect(session.meeting).toMatchObject({ areaId: 'orchard', approximate: true })
    expect(session.spots.list.find((s) => s.areaId === 'orchard').approximate).toBe(true)
  })

  it('are approximate for a known place priced from the starts there are', async () => {
    const { api, id } = await locating()
    world.estimate = true
    const session = await api.setKnownPlace(id, 'novena')
    expect(session.meeting.approximate).toBe(true)
    expect(session.spots.list[0].approximate).toBe(true)
  })

  it('are not approximate when the routes are real, and say so with no "about"', async () => {
    const { api, id } = await locating()
    const session = await api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    expect(session.meeting.approximate).toBe(false)
    expect(session.spots.list.every((s) => !s.approximate)).toBe(true)
    expect(tripsLine(session.spots.list[0])).toBe('Longest trip 25 min · Average 22 min')
    expect(peopleTrips(session.spots.list[0], (person) => person, 'ian').some((trip) => trip.text.includes('about'))).toBe(false)
  })

  it('stay approximate for the areas whose own routes failed, even when the others are real', async () => {
    const { api, id } = await locating()
    planner.meetingArea.mockImplementation(async (args) => {
      const answer = await answerLikeTheNewBackend(args)
      return { ...answer, travel: { source: 'onemap' }, candidates: answer.candidates?.map((c, i) => ({ ...c, approximate: i === 1 })) }
    })
    const session = await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    expect(session.spots.list.map((s) => s.approximate)).toEqual([false, true, false])
  })
})

describe('the spot the host is offered, to the minute', () => {
  // Bugis: 29.6 and 25.6 before rounding. Bishan: 30.4 and 22.8. The planner puts Bugis first (29.6 is less than 30.4), but
  // both longest trips round to 30 and Bishan's average rounds lower (27 against 28; with Faith's trips too, 24 against 28).
  const closeCall = () => {
    world.fixed = { bugis: { ian: 29.6, jonathan: 25.6, faith: 28 }, bishan: { ian: 30.4, jonathan: 22.8, faith: 20 } }
  }

  it('is the planner\'s pick when nobody has approved, not the runner-up with the lower rounded average', async () => {
    closeCall()
    const { api, id } = await locating()
    const session = await api.getSession(id)
    expect(session.spots.list.slice(0, 2).map((s) => [s.areaId, s.worstMinutes, s.meanMinutes])).toEqual([['bugis', 30, 28], ['bishan', 30, 27]])
    expect(session.spots.preselectedAreaId).toBe('bugis')
  })

  it('is confirmed by the host as the planner\'s choice, not as a pick against it', async () => {
    closeCall()
    const { api, id } = await locating()
    const confirmed = await api.confirmSpot(id, (await api.getSession(id)).spots.preselectedAreaId)
    expect(confirmed.meeting).toMatchObject({ areaId: 'bugis', method: 'fairest' })
  })

  it('is what useMeetingArea confirms', async () => {
    closeCall()
    const { api, id } = await locating()
    await api.setLocation(id, 'faith', 'start', { areaId: 'woodlands' })
    const confirmed = await api.useMeetingArea(id)
    expect(confirmed.meeting).toMatchObject({ areaId: 'bugis', method: 'fairest' })
  })

  it('goes, among equally approved spots under a minute apart, to the shorter longest trip before rounding', async () => {
    world.fixed = { bishan: { ian: 30.4, jonathan: 22.8 }, novena: { ian: 30.2, jonathan: 22.8 } }
    const { api, id } = await locating()
    await api.suggestSpot(id, 'faith', 'novena')
    for (const spot of ['bishan', 'novena']) await api.approveSpot(id, 'ian', spot, true)
    const session = await api.getSession(id)
    // Both read 30 minutes; Bishan is first in the list, Novena has the shorter trip.
    expect(session.spots.list.filter((s) => ['bishan', 'novena'].includes(s.areaId)).map((s) => s.worstMinutes)).toEqual([30, 30])
    expect(session.spots.preselectedAreaId).toBe('novena')
  })

  it('goes to the shorter longest trip among approved spots, and to the list\'s order when those are equal too', async () => {
    const { api, id } = await locating()
    for (const spot of ['bishan', 'orchard']) await api.approveSpot(id, 'ian', spot, true)
    // Bishan 30 before Orchard 31.
    expect((await api.getSession(id)).spots.preselectedAreaId).toBe('bishan')
    // The same trips to the decimal: the earlier row.
    world.fixed = { bishan: { ian: 31, jonathan: 20 }, orchard: { ian: 31, jonathan: 20 } }
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'woodlands' })
    const tied = await api.getSession(id)
    expect(tied.spots.list.find((s) => s.areaId === 'bishan').worstMinutes).toBe(tied.spots.list.find((s) => s.areaId === 'orchard').worstMinutes)
    expect(tied.spots.preselectedAreaId).toBe('bishan')
  })

  it('reads an older save, which has no unrounded minutes, by its rounded ones', async () => {
    const { api, id } = await locating()
    for (const spot of ['bishan', 'orchard']) await api.approveSpot(id, 'ian', spot, true)
    const state = JSON.parse(api.storage.store[STORAGE_KEY])
    for (const spot of state.sessions[0].spots.list) delete spot.exactWorst
    const old = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    expect((await old.getSession(id)).spots.preselectedAreaId).toBe('bishan')
  })
})

describe('what Home says while the group is choosing', () => {
  const spots = (leading) => ({
    list: [
      { areaId: 'bugis', area: { name: 'Bugis' }, approvalCount: leading === 'bugis' ? 2 : 0, times: { ian: 25 } },
      { areaId: 'novena', area: { name: 'Novena' }, approvalCount: leading === 'novena' ? 3 : 0, times: { ian: 27 } },
    ],
    approvals: {},
    preselectedAreaId: leading || 'bugis',
  })
  const session = (leading, over = {}) => ({ id: 's1', hostId: 'ian', status: 'locating', activeIds: ['ian', 'jonathan', 'faith'], locations: { ian: { start: {} }, jonathan: { start: {} } }, spots: spots(leading), meeting: null, area: null, ...over })

  it('does not say there is no meeting point when the host is asked to confirm a spot', () => {
    const early = session(null)
    expect(nextStepFor(early, 'ian').label).toBe('Confirm the spot')
    expect(whereStands(early, 'ian')).toMatchObject({ kind: 'spots', text: '2 spots to choose from', areaName: '' })
    expect(placeText(early)).toBe('choosing a spot')
  })

  it('names the spot that leads, not the planner\'s fairest area, with the minutes for you', () => {
    // Everyone has a start, so the planner's fairest area (Bugis) is the meeting area while Novena leads.
    const all = session('novena', { meeting: { areaId: 'bugis', times: { ian: 25 } }, area: { id: 'bugis', name: 'Bugis' } })
    expect(leadingSpot(all).areaId).toBe('novena')
    expect(whereStands(all, 'ian')).toMatchObject({ kind: 'spots', areaName: 'Novena', minutes: 27, text: 'Novena is leading · about 27 min for you', note: 'is leading · about 27 min for you' })
    expect(placeText(all)).toBe('Novena')
    expect(whereStands(session('novena'), 'faith').text).toBe('Novena is leading')
  })

  it('says the fairest area is only one of the spots until something leads', () => {
    const all = session(null, { meeting: { areaId: 'bugis', times: { ian: 25 } }, area: { id: 'bugis', name: 'Bugis' } })
    expect(whereStands(all, 'ian').text).toBe('2 spots to choose from')
    expect(placeText(all)).toBe('choosing a spot')
  })

  it('keeps the old words once the group has moved on, or when no spots are listed', () => {
    const done = session('novena', { status: 'voting', meeting: { areaId: 'novena', times: { ian: 27 } }, area: { id: 'novena', name: 'Novena' } })
    expect(leadingSpot(done)).toBeNull()
    expect(whereStands(done, 'ian')).toMatchObject({ kind: 'area', text: 'Novena · about 27 min for you', areaName: 'Novena', note: 'about 27 min for you' })
    expect(placeText(done)).toBe('Novena')
    const none = session(null, { spots: { list: [], approvals: {} } })
    expect(whereStands(none, 'ian').kind).toBe('waiting')
    expect(placeText(none)).toBe('no meeting point yet')
    expect(whereStands(session(null, { spots: { list: [{ areaId: 'bugis', area: { name: 'Bugis' }, approvalCount: 0 }], approvals: {} } }), 'ian').text).toBe('1 spot to choose from')
  })

  it('keeps every next-step label short enough to stay a pill', () => {
    const start = { areaId: 'x' }
    const base = { id: 's1', hostId: 'ian', status: 'locating', activeIds: ['ian', 'faith'], members: [], locations: { ian: { start }, faith: { start } }, votes: {}, meeting: null, findingMeeting: false, spots: { list: [{ areaId: 'bugis' }], approvals: {} } }
    const labels = [nextStepFor(base, 'ian').label, nextStepFor(base, 'faith').label, nextStepFor({ ...base, spots: { list: [{ areaId: 'bugis' }], approvals: { faith: ['bugis'] } } }, 'faith').label]
    expect(labels).toEqual(['Confirm the spot', 'Pick your spots', 'Waiting for the host'])
    for (const label of labels) expect(label.length).toBeLessThanOrEqual(20)
  })
})

describe('a session that has ended', () => {
  it('cannot be left by a member: opting out writes nothing', async () => {
    const cancelled = await locating()
    await cancelled.api.cancelSession(cancelled.id)
    const saved = cancelled.api.storage.writes
    planner.meetingArea.mockClear()
    await expect(cancelled.api.optOut(cancelled.id, 'faith')).rejects.toThrow(/has ended/)
    expect(cancelled.api.storage.writes).toBe(saved)
    expect(planner.meetingArea).not.toHaveBeenCalled()
    expect((await cancelled.api.getSession(cancelled.id)).activeIds).toContain('faith')

    const { api, id } = await loadConfirmed()
    await api.endPlan(id)
    const writes = api.storage.writes
    planner.meetingArea.mockClear()
    await expect(api.optOut(id, 'jonathan')).rejects.toThrow(/has ended/)
    expect(api.storage.writes).toBe(writes)
    expect(planner.meetingArea).not.toHaveBeenCalled()
  })
})

describe('the events store', () => {
  it('acts as the signed-in person and keeps the session it gets back', async () => {
    const { api, id } = await locating()
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useEventsStore } = await import('@/stores/events.js')
    const events = useEventsStore()
    expect((await events.suggestMySpot(id, 'novena', { here: true })).spots.suggestions).toEqual({ ian: { areaId: 'novena', here: true } })
    expect((await events.approveMySpot(id, 'bishan', true)).spots.approvals).toEqual({ ian: ['bishan'] })
    expect(events.byId[id].spots.approvals.ian).toEqual(['bishan'])
    expect(areaIds(await events.withdrawMySpot(id))).toEqual(['bugis', 'bishan', 'orchard'])
    expect((await events.confirmSpot(id, 'bishan')).status).toBe('voting')
    expect(api).toBeTruthy()
  })

  it('sets a known place', async () => {
    const { id } = await locating()
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useEventsStore } = await import('@/stores/events.js')
    const session = await useEventsStore().setKnownPlace(id, 'novena')
    expect(session).toMatchObject({ status: 'voting', areaName: 'Novena' })
  })
})

// The result line a screen shows for a session summary. How to call: resultLine(session) -> 'Chosen by the host: Novena.'
const resultLine = (session) => session.resultLine
