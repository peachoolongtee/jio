// A profile's friends (walkthrough, 30 October 2026: a Friends number on every profile opens the list, as Instagram's followers do),
// for the demo and local accounts: your own are the ones you added; a sample person's are sample data, the rest of the sample circle,
// plus you once you are friends. A real account's path is in friendsReal.server.test.js. No network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi, stubPlanner } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

let api
let meId
beforeEach(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00'))
  stubPlanner(planner)
  api = await loadApi()
  const user = await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  meId = user.id
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})
const ids = (profile) => profile.friends.map((p) => p.id)

describe('the friends on a profile', () => {
  it('are your own friends on your own profile, by name', async () => {
    await api.setFriend('faith', true)
    await api.setFriend('darius', true)
    const me = (await api.listPeople()).filter((p) => p.isFriend).map((p) => p.id).sort()
    const mine = await api.getPerson(meId)
    expect(mine.friendsInCommon).toBe(false)
    expect([...ids(mine)].sort()).toEqual(me)
    expect(mine.friends.map((p) => p.name)).toEqual([...mine.friends.map((p) => p.name)].sort((a, b) => a.localeCompare(b)))
  })

  it("are the rest of the sample circle on a sample friend's profile, and you once you are friends", async () => {
    const darius = await api.getPerson('darius')
    expect(darius.friendsInCommon).toBe(false)
    expect(ids(darius)).not.toContain('darius')
    expect(ids(darius)).toEqual(expect.arrayContaining(['faith', 'jonathan', 'nicole', 'darryl']))
    expect(ids(darius)).not.toContain(meId)
    await api.setFriend('darius', true)
    expect(ids(await api.getPerson('darius'))).toContain(meId)
    await api.setFriend('darius', false)
    expect(ids(await api.getPerson('darius'))).not.toContain(meId)
  })

  it('are none for someone from the wider community you have not added', async () => {
    expect(ids(await api.getPerson('meiling'))).toEqual([])
    await api.setFriend('meiling', true)
    expect(ids(await api.getPerson('meiling'))).toHaveLength(1)
  })
})
