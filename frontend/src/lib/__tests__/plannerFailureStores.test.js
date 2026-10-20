// The people, planner and events stores when the planner fails (ticket #57): a failed load clears its busy flag and still throws,
// and a refresh nobody awaits (a live update) keeps what is shown without becoming an unhandled rejection (Vitest fails the run
// on one). Against a stand-in for api.js. No network.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const listeners = vi.hoisted(() => [])
vi.mock('@/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribe: vi.fn((fn) => {
    listeners.push(fn)
    return () => {}
  }),
  listPeople: vi.fn(),
  getLeaderboard: vi.fn(),
  getSeason: vi.fn(),
  listRewards: vi.fn(),
  listRedemptions: vi.fn(),
  getConditions: vi.fn(),
  listSessions: vi.fn(),
}))
import * as api from '@/lib/api.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { usePlannerStore } from '@/stores/planner.js'

const emit = (event) => listeners.forEach((fn) => fn(event))
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const SLOW = new Error('The Jio planner is taking too long to answer. Try again in a moment.')

beforeEach(() => {
  listeners.length = 0
  vi.clearAllMocks()
  setActivePinia(createPinia())
})

describe('the people store when a load fails', () => {
  it.each([
    ['people', 'loadPeople', () => api.listPeople.mockRejectedValue(SLOW)],
    ['leaderboard', 'loadLeaderboard', () => api.getLeaderboard.mockRejectedValue(SLOW)],
    ['rewards', 'loadRewards', () => (api.listRewards.mockRejectedValue(SLOW), api.listRedemptions.mockResolvedValue([]))],
  ])('clears the %s flag and still throws', async (flag, load, fail) => {
    const groups = useGroupsStore()
    fail()
    const pending = groups[load]()
    expect(groups.loading[flag]).toBe(true)
    await expect(pending).rejects.toBe(SLOW)
    expect(groups.loading[flag]).toBe(false)
  })

  it('keeps the list it had when a later load fails, and works again afterwards', async () => {
    const groups = useGroupsStore()
    api.listPeople.mockResolvedValueOnce([{ id: 'p1', name: 'Faith' }])
    await groups.loadPeople()
    api.listPeople.mockRejectedValueOnce(SLOW)
    await expect(groups.loadPeople()).rejects.toBe(SLOW)
    expect(groups.people).toHaveLength(1)
    api.listPeople.mockResolvedValueOnce([{ id: 'p1', name: 'Faith' }, { id: 'p2', name: 'Lee' }])
    await groups.loadPeople()
    expect(groups.people).toHaveLength(2)
    expect(groups.loading.people).toBe(false)
  })

  it('does not leave a live refresh that fails as an unhandled rejection', async () => {
    const groups = useGroupsStore()
    api.listPeople.mockResolvedValue([{ id: 'p1', name: 'Faith' }])
    api.getLeaderboard.mockResolvedValue([{ id: 'p1', isMe: true }])
    api.getSeason.mockResolvedValue({ number: 1 })
    api.listRewards.mockResolvedValue([{ id: 'r1' }])
    api.listRedemptions.mockResolvedValue([])
    await Promise.all([groups.loadPeople(), groups.loadLeaderboard(), groups.loadSeason(), groups.loadRewards()])
    for (const fn of [api.listPeople, api.getLeaderboard, api.getSeason, api.listRewards]) fn.mockRejectedValue(SLOW)
    emit({ type: 'stats' })
    await flush()
    expect(groups.people).toHaveLength(1)
    expect(groups.leaderboard).toHaveLength(1)
    expect(Object.values(groups.loading)).toEqual([false, false, false])
  })
})

describe('the planner and events stores on live updates', () => {
  it('does not leave a failed conditions refresh as an unhandled rejection', async () => {
    usePlannerStore()
    api.getConditions.mockRejectedValue(SLOW)
    emit({ type: 'conditions' })
    emit({ type: 'reset' })
    await flush()
    expect(api.getConditions).toHaveBeenCalledTimes(2)
  })

  it('does not leave a failed list refresh as an unhandled rejection', async () => {
    useEventsStore()
    api.listSessions.mockRejectedValue(SLOW)
    emit({ type: 'user' })
    emit({ type: 'reset' })
    await flush()
    expect(api.listSessions).toHaveBeenCalled()
  })
})
