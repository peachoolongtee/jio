// Seasons and the leaderboard through the data layer: an ended plan closes an expired season first, the demo's
// "End the season now" lands the next season on the quarter boundary, a tie has one winner, and nobody is
// ranked at zero. The planner is stubbed; the clock is set, with timers left real.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY, confirmedSave, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'
import { PEOPLE, isCommunity } from '../mock/people.js'
import { seasonRange } from '../season.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-12-30T10:00:00'))
  stubPlanner(planner)
  await confirmedSave()
})
beforeEach(() => stubPlanner(planner))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.setSystemTime(new Date('2026-12-30T10:00:00'))
})

// The confirmed save with every person's season points and meetups set, and the clock where the test wants it.
async function withStats(stats, now = '2026-12-30T10:00:00') {
  const state = JSON.parse((await confirmedSave()).text)
  for (const p of PEOPLE) state.stats[p.id] = { meetups: 0, points: 0, seasonPoints: 0, ...stats[p.id] }
  vi.setSystemTime(new Date(now))
  return { api: await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(state) } }), id: state.sessions[0].id }
}

describe('ending a plan after the season ran out', () => {
  it('closes the old season first, so the points count for the new one', async () => {
    const { api, id } = await withStats({ darius: { seasonPoints: 300, meetups: 3 } })
    vi.setSystemTime(new Date('2027-01-02T10:00:00'))
    await api.endPlan(id)
    const season = await api.getSeason()
    expect(season.number).toBe(2)
    expect(season.past[0].number).toBe(1)
    expect(season.past[0].winners.map((w) => w.id)).toEqual(['darius'])
    const me = (await api.getLeaderboard()).find((row) => row.isMe)
    // Without the catch-up, these 100 points land in season 1 and are wiped when it closes.
    expect(me.seasonPoints).toBe(100)
    expect(me.rank).toBe(1)
  })

  it('leaves a season that has not run out alone', async () => {
    const { api, id } = await loadConfirmed()
    await api.endPlan(id)
    expect((await api.getSeason()).number).toBe(1)
  })
})

describe('End the season now', () => {
  it('starts the next season on the quarter boundary and names its real last day', async () => {
    const { api } = await withStats({ darius: { seasonPoints: 200, meetups: 2 } }, '2026-11-15T09:30:00')
    const ended = await api.endSeason()
    expect(ended.winners.map((w) => w.id)).toEqual(['darius'])
    expect(seasonRange(ended)).toBe('1 Oct to 15 Nov')
    const season = await api.getSeason()
    expect(season.number).toBe(2)
    expect(new Date(season.startsAt)).toEqual(new Date('2026-11-15T09:30:00'))
    expect(new Date(season.endsAt)).toEqual(new Date('2027-01-01T00:00:00'))
    expect(seasonRange(season)).toBe('15 Nov to 31 Dec')
  })

  it('closes an expired season at its own end first', async () => {
    const { api } = await withStats({ darius: { seasonPoints: 200, meetups: 2 } }, '2027-02-10T09:00:00')
    await api.endSeason()
    const { past, number } = await api.getSeason()
    expect(number).toBe(3)
    expect(past.map((x) => x.number)).toEqual([2, 1])
    expect(new Date(past[0].endsAt)).toEqual(new Date('2027-02-10T09:00:00'))
  })
})

describe('a tie for first place', () => {
  it('has one winner: the person with more all-time points', async () => {
    const { api } = await withStats({ ian: { seasonPoints: 500, meetups: 3 }, darius: { seasonPoints: 500, meetups: 8 }, faith: { seasonPoints: 100 } })
    const ended = await api.endSeason()
    expect(ended.winners.map((w) => w.id)).toEqual(['darius'])
    // Only the winner got the prize; spendable points started at 0 for everyone.
    expect((await api.getPerson('darius')).points).toBe(500)
    expect((await api.getPerson('faith')).points).toBe(0)
    expect((await api.getPerson('ian')).points).toBe(0)
  })

  it('goes to the name that comes first when all-time points are level', async () => {
    const { api } = await withStats({ nicole: { seasonPoints: 400, meetups: 4 }, faith: { seasonPoints: 400, meetups: 4 } })
    expect((await api.endSeason()).winners.map((w) => w.id)).toEqual(['faith'])
  })

  it('is listed with the winner first and both sharing rank 1', async () => {
    const { api } = await withStats({ ian: { seasonPoints: 500, meetups: 3 }, darius: { seasonPoints: 500, meetups: 8 } })
    const rows = await api.getLeaderboard()
    expect(rows.slice(0, 2).map((r) => [r.id, r.rank])).toEqual([['darius', 1], ['ian', 1]])
  })
})

describe('the leaderboard rank', () => {
  it('is null for everyone at zero points', async () => {
    const { api } = await withStats({})
    const rows = await api.getLeaderboard()
    // Other people on Jio join the leaderboard only once they are a friend, so everyone else is on it.
    expect(rows).toHaveLength(PEOPLE.filter((p) => !isCommunity(p.id)).length)
    expect(rows.every((r) => r.rank === null)).toBe(true)
  })

  it('ranks people with points, ties sharing a rank, and leaves the rest without one', async () => {
    const { api } = await withStats({ ian: { seasonPoints: 200 }, darius: { seasonPoints: 300 }, faith: { seasonPoints: 200 }, nicole: { seasonPoints: 100 } })
    const rows = await api.getLeaderboard()
    expect(rows.map((r) => [r.id, r.rank])).toEqual([
      ['darius', 1],
      ['faith', 2],
      ['ian', 2],
      ['nicole', 4],
      ['darryl', null],
      ['jonathan', null],
    ])
    expect(rows.find((r) => r.isMe).id).toBe('ian')
  })
})
