// "Jio remembers" on a demo or local account (lib/api.js travelLean on the browser's own storage): the debt comes from the outings this browser
// has finished, the same rules as the server's apply, and the planner is sent the debt, so the line is true. The path of a real account is in
// travelLean.server.test.js. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, loadApi, stubPlanner } from './planFixture.js'
import { AREAS } from '../mock/places.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// Choosing the meeting area keeps its "finding" bar up for a moment, so a test that makes a finished outing takes a few seconds.
vi.setConfig({ testTimeout: 40000 })

const DAY = 24 * 3600 * 1000
const NOW = '2026-10-09T10:00:00+08:00'
let api

// The planner's answer for a meeting area: Bishan, with these minutes for each person.
const trips = (minutes) => planner.meetingArea.mockImplementation(async ({ members }) => ({
  area: AREAS.find((a) => a.id === 'bishan'),
  method: 'station',
  travelByMember: Object.fromEntries(members.map((m) => [m.id, minutes[m.id] ?? 20])),
  candidates: [{ area: AREAS.find((a) => a.id === 'bishan'), worstMinutes: 40, meanMinutes: 30, travelByMember: Object.fromEntries(members.map((m) => [m.id, minutes[m.id] ?? 20])), approximate: false, source: 'ranked' }],
  approximate: false,
}))

// A finished outing of Ian and Darius in which Ian travelled 40 minutes and Darius 20, as the save would hold it; the browser is then reloaded on it.
// `finishedAt` is how long ago it finished, in days.
// How to call: await withFinishedOuting({ finishedAt: 3 })
async function withFinishedOuting({ finishedAt = 3 } = {}) {
  trips({ ian: 40, darius: 20 })
  const { id } = await api.createSession({ title: 'Last time', date: '2026-10-10', start: '12:00', end: '15:00' })
  await api.inviteFriends(id, ['darius'])
  await api.startSession(id, { meetBy: 'fairest' })
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'darius', 'start', { areaId: 'jurong-east' })
  await api.useMeetingArea(id)
  const saved = JSON.parse(api.storage.store[STORAGE_KEY])
  const session = saved.sessions.find((s) => s.id === id)
  expect(session.meeting.times).toEqual({ ian: 40, darius: 20 })
  Object.assign(session, { status: 'completed', completedAt: Date.now() - finishedAt * DAY })
  api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(saved) } })
}

// A session on a later day that is choosing where to meet. `starts` are who has shared a start.
// How to call: const id = await locating({ starts: ['ian', 'darius'] })
async function locating({ starts = ['ian', 'darius'], meetBy = 'fairest', date = '2026-10-17' } = {}) {
  const { id } = await api.createSession({ title: 'Next time', date, start: '12:00', end: '15:00' })
  await api.inviteFriends(id, ['darius'])
  await api.startSession(id, { meetBy })
  const areas = { ian: 'tampines', darius: 'jurong-east' }
  for (const who of starts) await api.setLocation(id, who, 'start', { areaId: areas[who] })
  return id
}

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date(NOW))
  stubPlanner(planner)
  api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('travelLean on a local account', () => {
  it('is owed for the person who travelled more than their share in the outing this browser finished, with the rule the planner uses', async () => {
    await withFinishedOuting()
    stubPlanner(planner)
    const id = await locating()
    expect(await api.travelLean(id)).toEqual({ owed: true, rule: 'longest' })
  })

  it('sends the planner the debt of the person it applies to, so that the line is true, and no field for a person with none', async () => {
    await withFinishedOuting()
    stubPlanner(planner)
    const id = await locating()
    const calls = planner.meetingArea.mock.calls.map(([request]) => request.members)
    expect(calls.length).toBeGreaterThan(0)
    const last = calls.at(-1)
    expect(last.find((m) => m.id === 'ian').travelDebtMinutes).toBe(10)
    expect('travelDebtMinutes' in last.find((m) => m.id === 'darius')).toBe(false)
    expect(await api.travelLean(id)).toMatchObject({ owed: true })
  })

  it('sends the debt on the meeting-area request only, and never on a ranking of places or a search', async () => {
    await withFinishedOuting()
    stubPlanner(planner)
    const id = await locating()
    expect(planner.meetingArea.mock.calls.at(-1)[0].members.find((m) => m.id === 'ian').travelDebtMinutes).toBe(10)
    planner.meetingArea.mockClear()
    await api.useMeetingArea(id)
    // Pricing the chosen area is a meeting-area request too, but it is not the pick of the spots: it carries no debt.
    for (const [request] of planner.meetingArea.mock.calls) expect(JSON.stringify(request.members)).not.toContain('travelDebtMinutes')
    await api.setPreferences(id, 'ian', { categories: ['eat'], until: null })
    await api.setPreferences(id, 'darius', { categories: ['eat'], until: null })
    const [slot] = (await api.getPlan(id)).slots
    await api.searchVenuesForSlot(id, slot.id, 'cafe')
    expect(planner.searchSlot).toHaveBeenCalled()
    expect(planner.rankSlot.mock.calls.length).toBeGreaterThan(0)
    for (const [request] of [...planner.rankSlot.mock.calls, ...planner.searchSlot.mock.calls]) {
      expect(JSON.stringify(request.members)).not.toContain('travelDebtMinutes')
    }
  })

  it('answers a bare flag and the rule, nothing about the other member', async () => {
    await withFinishedOuting()
    const id = await locating()
    const answer = await api.travelLean(id)
    expect(Object.keys(answer).sort()).toEqual(['owed', 'rule'])
    expect(JSON.stringify(answer)).not.toMatch(/darius|10|20|40/)
  })

  it('is not owed with no finished outing, with one finished longer than 90 days ago, or when this one is shorter than the average', async () => {
    const none = await locating()
    expect(await api.travelLean(none)).toEqual({ owed: false, rule: 'longest' })
    await withFinishedOuting({ finishedAt: 91 })
    stubPlanner(planner)
    expect(await api.travelLean(await locating({ date: '2026-10-18' }))).toEqual({ owed: false, rule: 'longest' })
  })

  it('is not owed before two starts are in, when the signed-in person has not shared theirs, or when the host named the place', async () => {
    await withFinishedOuting()
    stubPlanner(planner)
    expect((await api.travelLean(await locating({ starts: ['ian'], date: '2026-10-17' }))).owed).toBe(false)
    expect((await api.travelLean(await locating({ starts: ['darius'], date: '2026-10-18' }))).owed).toBe(false)
    expect((await api.travelLean(await locating({ meetBy: 'known', date: '2026-10-19' }))).owed).toBe(false)
  })

  it('is not owed when the group has moved on to voting', async () => {
    await withFinishedOuting()
    stubPlanner(planner)
    const id = await locating()
    expect((await api.travelLean(id)).owed).toBe(true)
    await api.useMeetingArea(id)
    expect((await api.travelLean(id)).owed).toBe(false)
  })

  it('is not owed when routing is off, because the planner then takes the centre and counts nobody\'s past travel', async () => {
    await withFinishedOuting()
    stubPlanner(planner)
    const id = await locating()
    await api.setConditions({ routing: false })
    expect((await api.travelLean(id)).owed).toBe(false)
  })

  it('rejects for a session that does not exist, so the screen shows nothing', async () => {
    await expect(api.travelLean('s99')).rejects.toThrow()
  })
})
