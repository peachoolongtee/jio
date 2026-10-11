// Roam in the data layer: the list of places near the group (roamNearby), proposing a place as the next stop (proposeStop)
// and the host deciding (resolveProposal). The planner is stood in for: roamNearby answers what the backend's /api/roam
// would, so the tests read the request it was given and the cards it returns. The signed-in person is Ian; a session he
// does not host is made by changing its host in the save.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, confirmedSave, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'
import { AREAS } from '../mock/places.js'
import { VENUES } from '../mock/venues.js'
import { nextStepFor } from '../homeMeetups.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

// One Roam result as plannerApi.js maps it: a voting-page card plus id, travelMinutes and distanceM.
const card = (venue, extra = {}) => ({
  id: venue.id,
  venue,
  rank: 1,
  score: 10,
  walk: 3,
  reasons: ['Near MRT'],
  warnings: [],
  swap: null,
  travelMinutes: 4.4,
  distanceKm: 0.3,
  distanceM: 300,
  approximate: false,
  ...extra,
})
// The places the planner sends, in order. A test can change it.
let answered
const listOf = (...venues) => ({ places: venues.map((v) => card(v)), empty: null, widened: false, weather: null })

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  stubPlanner(planner)
  await confirmedSave()
})
beforeEach(() => {
  stubPlanner(planner)
  answered = null
  planner.roamNearby.mockReset().mockImplementation(async () => answered ?? listOf(...VENUES.slice(0, 3)))
})
afterEach(() => vi.unstubAllGlobals())

const FULL = /storage is full/

// The confirmed save, with the session's day switched to today so the plan is under way. `more` are friends who also join.
async function underway({ friends = [], aiNote = false, limit } = {}) {
  const { text, id } = await confirmedSave()
  let data = text
  if (aiNote) {
    const state = JSON.parse(text)
    state.sessions[0].plan.aiNote = { reason: 'Shops first.', source: 'ai' }
    data = JSON.stringify(state)
  }
  const api = await loadApi({ data: { [STORAGE_KEY]: data }, ...(limit ? { limit } : {}) })
  if (friends.length) await api.inviteFriends(id, friends)
  await api.setConditions({ sessionDay: true })
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

// Venues the plan does not hold, so they can be proposed. The first few are of a category the plan has not used up.
const planVenues = async (api, id) => (await api.getItinerary(id)).stops.map((s) => s.venue.id)
async function freeVenues(api, id, n = 12) {
  const held = await planVenues(api, id)
  return VENUES.filter((v) => !held.includes(v.id)).slice(0, n)
}

describe('the list of places near the group', () => {
  it('is centred on the meeting area, and asks the planner for the people in the meetup, an hour, at the time the next stop would start', async () => {
    const { api, id } = await underway()
    const bishan = AREAS.find((a) => a.id === 'bishan')
    const list = await api.roamNearby(id)
    expect(planner.roamNearby).toHaveBeenCalledTimes(1)
    const request = planner.roamNearby.mock.calls[0][0]
    expect(request.current).toEqual({ lat: bishan.lat, lng: bishan.lng })
    // The planner needs only an id: a name is not sent (a long one could be over its limit and refuse the request).
    expect(request.members).toEqual([{ id: 'ian' }, { id: 'jonathan' }])
    expect(request.minutes).toBe(60)
    expect(request.date).toBe('2026-10-09')
    // The time is when the last stop ends (the plan's two stops end after 10:00, the fake clock), as HH:MM.
    expect(request.time).toMatch(/^\d\d:\d\d$/)
    const itinerary = await api.getItinerary(id)
    const lastEnd = itinerary.stops.at(-1).end
    expect(request.time).toBe(`${String(Math.floor(lastEnd / 60)).padStart(2, '0')}:${String(lastEnd % 60).padStart(2, '0')}`)
    expect(list.centre).toEqual({ areaId: 'bishan', areaName: 'Bishan' })
    expect(list.places).toHaveLength(3)
    expect(list.places[0]).toMatchObject({ id: VENUES[0].id, travelMinutes: 4.4, distanceM: 300, state: 'free', proposal: null })
  })

  it('passes the categories on, and leaves them out for the planner to choose when none are given', async () => {
    const { api, id } = await underway()
    await api.roamNearby(id, { categories: ['drink'] })
    expect(planner.roamNearby.mock.calls[0][0].categories).toEqual(['drink'])
    await api.roamNearby(id)
    expect(planner.roamNearby.mock.calls[1][0].categories).toBeUndefined()
  })

  it('uses a given point for that request only: it is not stored, not returned and not remembered for the next', async () => {
    const { api, id } = await underway()
    const point = { lat: 1.33217, lng: 103.84779 }
    const list = await api.roamNearby(id, { point })
    expect(planner.roamNearby.mock.calls[0][0].current).toEqual(point)
    // The group sees the area's name at most: the nearest area, not the position.
    expect(list.centre.areaName).toBe('Toa Payoh')
    expect(JSON.stringify(list)).not.toContain('1.33217')
    expect(JSON.stringify(list)).not.toContain('103.84779')
    // Nothing was written: no save holds it, and the session reads as before.
    expect(api.storage.store[STORAGE_KEY]).not.toContain('1.33217')
    expect(api.storage.store[STORAGE_KEY]).not.toContain('103.84779')
    expect(JSON.stringify(await api.getSession(id))).not.toContain('1.33217')
    // The next request, with no point, is about the meeting area again.
    await api.roamNearby(id)
    const bishan = AREAS.find((a) => a.id === 'bishan')
    expect(planner.roamNearby.mock.calls[1][0].current).toEqual({ lat: bishan.lat, lng: bishan.lng })
  })

  it('refuses a point outside Singapore, and one that is not a point, without asking the planner', async () => {
    const { api, id } = await underway()
    await expect(api.roamNearby(id, { point: { lat: 51.5, lng: -0.12 } })).rejects.toThrow(/outside Singapore/)
    await expect(api.roamNearby(id, { point: { lat: 'x', lng: 103.8 } })).rejects.toThrow(/outside Singapore/)
    expect(planner.roamNearby).not.toHaveBeenCalled()
  })

  it('marks a place already in the plan as a stop, and a proposed place with who proposed it', async () => {
    const { api, id } = await underway()
    const [free, other] = await freeVenues(api, id)
    const held = (await api.getItinerary(id)).stops[0].venue
    await api.proposeStop(id, 'jonathan', free.id)
    answered = listOf(held, free, other)
    const { places } = await api.roamNearby(id)
    expect(places.map((p) => p.state)).toEqual(['stop', 'proposed', 'free'])
    expect(places[1].proposal).toMatchObject({ by: 'jonathan', byName: 'Jonathan' })
    expect(places[0].proposal).toBeNull()
  })

  it('says why the signed-in person cannot propose (a full plan), and nothing otherwise', async () => {
    const { api, id } = await underway()
    expect((await api.roamNearby(id)).blocked).toBe('')
    const venues = await freeVenues(api, id)
    for (const v of venues.slice(0, 3)) await api.proposeStop(id, 'ian', v.id)
    expect((await api.roamNearby(id)).blocked).toMatch(/You have 3 places waiting/)
  })

  it('is only for a plan that is under way', async () => {
    const { api, id } = await underway()
    await api.setConditions({ sessionDay: false })
    await expect(api.roamNearby(id)).rejects.toThrow(/day of the outing/)
    expect(planner.roamNearby).not.toHaveBeenCalled()
  })

  it('leaves nothing half-written when the planner cannot be reached', async () => {
    const { api, id } = await underway()
    const before = api.storage.store[STORAGE_KEY]
    const session = await api.getSession(id)
    planner.roamNearby.mockRejectedValue(new Error('Cannot reach the Jio planner right now. Check your connection and try again.'))
    await expect(api.roamNearby(id)).rejects.toThrow(/Cannot reach the Jio planner/)
    expect(api.storage.store[STORAGE_KEY]).toBe(before)
    expect(await api.getSession(id)).toEqual(session)
    // A place that came back earlier can still be proposed after a failed list, and the list works again once the planner does.
    planner.roamNearby.mockImplementation(async () => listOf(...VENUES.slice(0, 3)))
    expect((await api.roamNearby(id)).places).toHaveLength(3)
  })
})

describe('who may propose a place, and when', () => {
  it('lets a member on the day, and saves who proposed it and the place', async () => {
    const { api, id } = await underway()
    const [venue] = await freeVenues(api, id)
    const session = await api.proposeStop(id, 'jonathan', venue.id)
    expect(session.proposals).toHaveLength(1)
    expect(session.proposals[0]).toMatchObject({ venueId: venue.id, by: 'jonathan', byName: 'Jonathan' })
    expect(session.proposals[0].venue.name).toBe(venue.name)
    expect(JSON.parse(api.storage.store[STORAGE_KEY]).sessions[0].proposals).toEqual([expect.objectContaining({ venueId: venue.id, by: 'jonathan', at: expect.any(Number) })])
  })

  it('knows a place the planner sent in this visit that the app has no record of', async () => {
    const { api, id } = await underway()
    const stranger = { id: 'google-xyz', name: 'Corner Bowling', category: 'activity', area: 'Bishan', price: 20, lat: 1.35, lng: 103.85 }
    answered = listOf(stranger)
    await api.roamNearby(id)
    const session = await api.proposeStop(id, 'ian', 'google-xyz')
    expect(session.proposals[0].venue.name).toBe('Corner Bowling')
    // The venue is saved with the proposal, so it survives a reload.
    expect(JSON.parse(api.storage.store[STORAGE_KEY]).venues['google-xyz'].name).toBe('Corner Bowling')
    // A place that was never sent is not a place.
    await expect(api.proposeStop(id, 'ian', 'never-heard-of')).rejects.toThrow(/does not exist/)
  })

  it('refuses before the day of the outing', async () => {
    const { api, id } = await underway()
    const [venue] = await freeVenues(api, id)
    await api.setConditions({ sessionDay: false })
    await expect(api.proposeStop(id, 'jonathan', venue.id)).rejects.toThrow(/on the day of the outing/)
    expect((await api.getSession(id)).proposals).toEqual([])
  })

  it('refuses while the group is still voting, and says the plan is not confirmed', async () => {
    const api = await loadApi()
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    await api.setConditions({ sessionDay: true })
    await expect(api.proposeStop(id, 'jonathan', VENUES[0].id)).rejects.toThrow(/once the plan is confirmed/)
  })

  it('refuses once the outing is finished or called off', async () => {
    const done = await underway()
    const [venue] = await freeVenues(done.api, done.id)
    await done.api.endPlan(done.id)
    await expect(done.api.proposeStop(done.id, 'jonathan', venue.id)).rejects.toThrow(/has ended/)
    const off = await underway()
    await off.api.cancelSession(off.id)
    await expect(off.api.proposeStop(off.id, 'jonathan', venue.id)).rejects.toThrow(/has ended/)
  })

  it('refuses a member who has opted out, and someone who was never in the session', async () => {
    const { api, id } = await underway({ friends: ['faith'] })
    const [venue] = await freeVenues(api, id)
    await api.optOut(id, 'faith')
    await expect(api.proposeStop(id, 'faith', venue.id)).rejects.toThrow(/Only people in this session/)
    await expect(api.proposeStop(id, 'nicole', venue.id)).rejects.toThrow(/Only people in this session/)
    expect((await api.getSession(id)).proposals).toEqual([])
  })

  it('refuses a place that is already in the plan', async () => {
    const { api, id } = await underway()
    const held = (await api.getItinerary(id)).stops[0].venue
    await expect(api.proposeStop(id, 'jonathan', held.id)).rejects.toThrow(/already in the plan/)
  })
})

describe('proposals that repeat, and their limits', () => {
  it('makes the same place proposed twice one proposal, and keeps the first person', async () => {
    const { api, id } = await underway()
    const [venue] = await freeVenues(api, id)
    await api.proposeStop(id, 'jonathan', venue.id)
    const again = await api.proposeStop(id, 'ian', venue.id)
    const twice = await api.proposeStop(id, 'jonathan', venue.id)
    expect(again.proposals).toHaveLength(1)
    expect(twice.proposals).toHaveLength(1)
    expect(twice.proposals[0].by).toBe('jonathan')
  })

  it('lets a member have 3 waiting and refuses a 4th, until they take one back', async () => {
    const { api, id } = await underway()
    const venues = await freeVenues(api, id)
    for (const v of venues.slice(0, 3)) await api.proposeStop(id, 'jonathan', v.id)
    await expect(api.proposeStop(id, 'jonathan', venues[3].id)).rejects.toThrow(/Jonathan has 3 places waiting/)
    // Another member is not held back by it.
    await api.proposeStop(id, 'ian', venues[3].id)
    const mine = (await api.getSession(id)).proposals.find((p) => p.by === 'jonathan')
    // Jonathan is not the host, and Ian is signed in: only the host may dismiss for him.
    await api.resolveProposal(id, mine.id, false)
    await api.proposeStop(id, 'jonathan', venues[4].id)
    expect((await api.getSession(id)).proposals.filter((p) => p.by === 'jonathan')).toHaveLength(3)
  })

  it('holds 10 waiting for the whole session and refuses an 11th', async () => {
    const { api, id } = await underway({ friends: ['faith', 'darius', 'nicole'] })
    const venues = await freeVenues(api, id, 14)
    const people = ['ian', 'jonathan', 'faith', 'darius', 'nicole']
    for (let i = 0; i < 10; i++) await api.proposeStop(id, people[i % people.length], venues[i].id)
    expect((await api.getSession(id)).proposals).toHaveLength(10)
    await expect(api.proposeStop(id, 'ian', venues[10].id)).rejects.toThrow(/10 places are already waiting/)
    expect((await api.getSession(id)).proposals).toHaveLength(10)
  })

  it('takes no more once the plan has 8 stops, and cannot add a ninth by accepting', async () => {
    const { api, id } = await underway({ friends: ['faith', 'darius'] })
    const venues = await freeVenues(api, id, 12)
    // The plan has 2 stops. Add 6 through proposals: 8.
    let session
    for (const [i, v] of venues.slice(0, 6).entries()) {
      session = await api.proposeStop(id, ['ian', 'jonathan', 'faith'][i % 3], v.id)
      await api.resolveProposal(id, session.proposals.at(-1).id, true)
    }
    expect((await api.getItinerary(id)).stops).toHaveLength(8)
    await expect(api.proposeStop(id, 'jonathan', venues[6].id)).rejects.toThrow(/8 stops, the most it can hold/)
    expect((await api.getSession(id)).proposals).toEqual([])
  })

  it('keeps a waiting proposal when the plan is full and adding it is refused', async () => {
    const { api, id } = await underway({ friends: ['faith', 'darius'] })
    const venues = await freeVenues(api, id, 12)
    // Three waiting, then fill the plan with others (accepted one by one) until 8 stops.
    const waiting = []
    for (const v of venues.slice(0, 3)) waiting.push((await api.proposeStop(id, 'faith', v.id)).proposals.at(-1).id)
    for (const [i, v] of venues.slice(3, 9).entries()) {
      const s = await api.proposeStop(id, ['ian', 'jonathan', 'darius'][i % 3], v.id)
      await api.resolveProposal(id, s.proposals.at(-1).id, true)
    }
    expect((await api.getItinerary(id)).stops).toHaveLength(8)
    await expect(api.resolveProposal(id, waiting[0], true)).rejects.toThrow(/8 stops/)
    expect((await api.getSession(id)).proposals).toHaveLength(3)
    await api.resolveProposal(id, waiting[0], false)
    expect((await api.getSession(id)).proposals).toHaveLength(2)
  })
})

describe('the host deciding', () => {
  it('adds an accepted place at the end: starting when the last stop ends, an hour long, in its own category', async () => {
    const { api, id } = await underway()
    const before = await api.getItinerary(id)
    const venue = VENUES.find((v) => v.category === 'shop' && !before.stops.some((s) => s.venue.id === v.id))
    const proposed = await api.proposeStop(id, 'jonathan', venue.id)
    const after = await api.resolveProposal(id, proposed.proposals[0].id, true)
    expect(after.proposals).toEqual([])
    const itinerary = await api.getItinerary(id)
    expect(itinerary.stops).toHaveLength(before.stops.length + 1)
    const added = itinerary.stops.at(-1)
    const last = before.stops.at(-1)
    expect(added).toMatchObject({ category: 'shop', duration: 60 })
    expect(added.venue.id).toBe(venue.id)
    // It follows the last stop like any other: when that ends, plus the leg between them.
    expect(added.start).toBe(last.end + itinerary.legs.at(-1).minutes)
    expect(added.end).toBe(added.start + 60)
    // The stops before it are as they were.
    expect(itinerary.stops.slice(0, -1).map((s) => [s.venue.id, s.start, s.end])).toEqual(before.stops.map((s) => [s.venue.id, s.start, s.end]))
    const stored = JSON.parse(api.storage.store[STORAGE_KEY]).sessions[0].plan.stops.at(-1)
    expect(stored).toMatchObject({ venueId: venue.id, category: 'shop', duration: 60, plannedStart: last.end })
  })

  it('clears the note about the suggested order when a stop is added, as moving or deleting a stop does', async () => {
    const { api, id } = await underway({ aiNote: true })
    expect((await api.getItinerary(id)).aiNote).toEqual({ reason: 'Shops first.', source: 'ai' })
    const [venue] = await freeVenues(api, id)
    const proposed = await api.proposeStop(id, 'jonathan', venue.id)
    await api.resolveProposal(id, proposed.proposals[0].id, true)
    expect((await api.getItinerary(id)).aiNote).toBeNull()
  })

  it('leaves a dismissed place out, and changes nothing else', async () => {
    const { api, id } = await underway()
    const before = await api.getItinerary(id)
    const [venue] = await freeVenues(api, id)
    const proposed = await api.proposeStop(id, 'jonathan', venue.id)
    const after = await api.resolveProposal(id, proposed.proposals[0].id, false)
    expect(after.proposals).toEqual([])
    expect(await api.getItinerary(id)).toEqual(before)
  })

  it('lets the proposer take back their own proposal when they are not the host, and nothing more', async () => {
    const { api, id } = await underway()
    const venues = await freeVenues(api, id)
    await api.proposeStop(id, 'ian', venues[0].id)
    await api.proposeStop(id, 'jonathan', venues[1].id)
    const guest = await hostedBy(api, 'jonathan')
    const mine = (await guest.getSession(id)).proposals.find((p) => p.by === 'ian')
    const theirs = (await guest.getSession(id)).proposals.find((p) => p.by === 'jonathan')
    // Ian, signed in, took his own back.
    expect((await guest.resolveProposal(id, mine.id, false)).proposals.map((p) => p.by)).toEqual(['jonathan'])
    // He cannot dismiss the host's, nor add anything to a plan he does not host.
    await expect(guest.resolveProposal(id, theirs.id, false)).rejects.toThrow(/Only the host, or the person who proposed it/)
    await expect(guest.resolveProposal(id, theirs.id, true)).rejects.toThrow(/Only the host can add/)
  })

  it('does not let a guest add even their own proposal to the plan', async () => {
    const { api, id } = await underway()
    const [venue] = await freeVenues(api, id)
    await api.proposeStop(id, 'ian', venue.id)
    const guest = await hostedBy(api, 'jonathan')
    const mine = (await guest.getSession(id)).proposals[0]
    await expect(guest.resolveProposal(id, mine.id, true)).rejects.toThrow(/Only the host can add/)
    expect((await guest.getItinerary(id)).stops).toHaveLength(2)
    expect((await guest.getSession(id)).proposals).toHaveLength(1)
  })

  it('does nothing the second time the same proposal is resolved', async () => {
    const { api, id } = await underway()
    const [venue] = await freeVenues(api, id)
    const proposed = await api.proposeStop(id, 'jonathan', venue.id)
    const proposalId = proposed.proposals[0].id
    await api.resolveProposal(id, proposalId, true)
    const stops = (await api.getItinerary(id)).stops.length
    await api.resolveProposal(id, proposalId, true)
    await api.resolveProposal(id, proposalId, false)
    expect((await api.getItinerary(id)).stops).toHaveLength(stops)
    // Nor does a proposal that never existed.
    await expect(api.resolveProposal(id, 'pp-none', true)).resolves.toBeTruthy()
    expect((await api.getItinerary(id)).stops).toHaveLength(stops)
  })
})

describe('proposals when the plan changes', () => {
  async function withProposals(options) {
    const ctx = await underway(options)
    const venues = await freeVenues(ctx.api, ctx.id)
    await ctx.api.proposeStop(ctx.id, 'ian', venues[0].id)
    await ctx.api.proposeStop(ctx.id, 'jonathan', venues[1].id)
    return ctx
  }

  it('are dismissed when the host re-plans', async () => {
    const { api, id } = await withProposals()
    await api.replan(id)
    expect((await api.getSession(id)).proposals).toEqual([])
    expect(JSON.parse(api.storage.store[STORAGE_KEY]).sessions[0].proposals).toEqual([])
  })

  it('stay when a re-plan fails, because it took back its own change', async () => {
    const { api, id } = await withProposals()
    planner.meetingArea.mockRejectedValue(new Error('Cannot reach the Jio planner right now. Check your connection and try again.'))
    await expect(api.replan(id)).rejects.toThrow(/Cannot reach the Jio planner/)
    expect((await api.getSession(id)).proposals).toHaveLength(2)
    expect((await api.getSession(id)).status).toBe('confirmed')
  })

  it('are dismissed when the outing is finished', async () => {
    const { api, id } = await withProposals()
    await api.endPlan(id)
    expect((await api.getSession(id)).proposals).toEqual([])
  })

  it('are dismissed when the outing is cancelled', async () => {
    const { api, id } = await withProposals()
    await api.cancelSession(id)
    expect((await api.getSession(id)).proposals).toEqual([])
  })

  it('go only for the person who opts out', async () => {
    const { api, id } = await withProposals({ friends: ['faith'] })
    await api.optOut(id, 'jonathan')
    expect((await api.getSession(id)).proposals.map((p) => p.by)).toEqual(['ian'])
  })
})

describe('a save from before Roam', () => {
  it('loads, shows no proposals, and still gives its itinerary; the version did not change', async () => {
    const { text, id } = await confirmedSave()
    const state = JSON.parse(text)
    expect(state.version).toBe(9)
    expect('proposals' in state.sessions[0]).toBe(false)
    const api = await loadApi({ data: { [STORAGE_KEY]: text } })
    const session = await api.getSession(id)
    expect(session.proposals).toEqual([])
    expect(session.status).toBe('confirmed')
    expect((await api.getItinerary(id)).stops).toHaveLength(2)
    expect(nextStepFor({ ...session, hostId: 'ian' }, 'ian').label).not.toBe('Review a proposal')
  })

  it('reads a damaged list as the proposals in it that are whole, and does not crash', async () => {
    const { text, id } = await confirmedSave()
    const venue = VENUES[5]
    const state = JSON.parse(text)
    state.sessions[0].proposals = [{ id: 'pp1', venueId: venue.id, by: 'jonathan', at: 1 }, null, 7, { id: 3 }]
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    expect((await api.getSession(id)).proposals.map((p) => p.id)).toEqual(['pp1'])
    state.sessions[0].proposals = 'nonsense'
    const other = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } })
    expect((await other.getSession(id)).proposals).toEqual([])
  })

  it('stays an empty list in the save for a session that never had one, through a re-plan or a finish', async () => {
    const { api, id } = await underway()
    await api.endPlan(id)
    expect('proposals' in JSON.parse(api.storage.store[STORAGE_KEY]).sessions[0]).toBe(false)
  })
})

describe('a write that cannot be saved', () => {
  it('takes back only itself when storage is full: the proposal, and the place it would have saved', async () => {
    const { api, id } = await underway()
    const [first, second] = await freeVenues(api, id)
    await api.proposeStop(id, 'jonathan', first.id)
    const before = api.storage.store[STORAGE_KEY]
    api.storage.limit = before.length
    // A new venue in the save makes it bigger than the room there is.
    const stranger = { id: 'google-big', name: 'X'.repeat(400), category: 'activity', area: 'Bishan', price: 20, lat: 1.35, lng: 103.85 }
    answered = listOf(stranger)
    await api.roamNearby(id)
    await expect(api.proposeStop(id, 'ian', 'google-big')).rejects.toThrow(FULL)
    expect((await api.getSession(id)).proposals.map((p) => p.venueId)).toEqual([first.id])
    expect(api.storage.store[STORAGE_KEY]).toBe(before)
    // The proposal made before it is still there to decide on, and the write works again once there is room.
    api.storage.limit = Infinity
    await api.proposeStop(id, 'ian', second.id)
    expect((await api.getSession(id)).proposals).toHaveLength(2)
  })
})
