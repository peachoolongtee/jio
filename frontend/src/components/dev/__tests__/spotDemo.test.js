// The demo tools' buttons for the meeting spots (components/dev/spotDemo.js), run on the real data layer with the stand-in
// planner (components/dev/offlinePlanner.js) answering, as the showcase does.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { loadApi } from '../../../lib/__tests__/planFixture.js'
import { DEMO_ACCOUNT } from '../demoAccount.js'
import { useOfflinePlanner } from '../offlinePlanner.js'
import { clearApprovals, friendSuggests, friendsApprove, hasSpots } from '../spotDemo.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-10T14:20:00'))
})
afterAll(() => vi.useRealTimers())
afterAll(() => vi.unstubAllGlobals())

// A session in Locating with Ian, Darius, Faith and Nicole, all four having shared a start, and the stand-in answering.
// How to call: const { api, id, offline } = await spotVote()
async function spotVote() {
  const api = await loadApi()
  await api.signUp(DEMO_ACCOUNT)
  api.api.defaults.baseURL = 'http://127.0.0.1:1'
  const offline = useOfflinePlanner(api.api)
  const { id } = await api.createSession({ title: 'Lunch', date: '2026-10-17', start: '12:00', end: '15:00' })
  await api.inviteFriends(id, ['darius', 'faith', 'nicole'])
  await api.startSession(id)
  for (const [who, areaId] of Object.entries({ ian: 'toa-payoh', darius: 'bishan', faith: 'novena', nicole: 'serangoon' })) await api.setLocation(id, who, 'start', { areaId })
  return { api, id, offline }
}

describe('the meeting-spot buttons of the demo tools', () => {
  it('open only while the group is choosing, with spots listed', async () => {
    const { api, id } = await spotVote()
    expect(hasSpots(await api.getSession(id))).toBe(true)
    await api.confirmSpot(id, (await api.getSession(id)).spots.list[0].areaId)
    expect(hasSpots(await api.getSession(id))).toBe(false)
  })

  it('has a friend suggest the area they start in when they are there already', async () => {
    const { api, id } = await spotVote()
    // Nicole starts in Serangoon, which is not one of the app's three here.
    const note = await friendSuggests(api, await api.getSession(id), ['nicole'], { here: true })
    expect(note).toBe('Nicole suggested Serangoon, and is there already.')
    const spots = (await api.getSession(id)).spots
    expect(spots.list.find((s) => s.areaId === 'serangoon')).toMatchObject({ by: 'nicole', here: true })
    // The same friend again replaces the suggestion, with an area that is not listed; another friend adds one.
    const second = await friendSuggests(api, await api.getSession(id), ['nicole', 'darius'], { here: false })
    expect(second).toMatch(/^Darius suggested /)
    expect(Object.keys((await api.getSession(id)).spots.suggestions).sort()).toEqual(['darius', 'nicole'])
  })

  it('has friends say which spots work, the second spot leading, and clears every approval', async () => {
    const { api, id } = await spotVote()
    await friendsApprove(api, await api.getSession(id), ['darius', 'faith', 'nicole'])
    const spots = (await api.getSession(id)).spots
    expect(spots.list.map((s) => s.approvalCount)).toEqual([1, 3, 1])
    expect(spots.preselectedAreaId).toBe(spots.list[1].areaId)
    await api.approveSpot(id, 'ian', spots.list[2].areaId, true)
    expect(await clearApprovals(api, await api.getSession(id))).toBe('Cleared 6 approvals.')
    expect((await api.getSession(id)).spots.approvals).toEqual({})
    expect(await clearApprovals(api, await api.getSession(id))).toBe('Nobody had said which spots work.')
  })

  it('answers when there is no friend to act', async () => {
    const { api, id } = await spotVote()
    expect(await friendSuggests(api, await api.getSession(id), [])).toBe('Invite a friend first.')
    expect(await friendsApprove(api, await api.getSession(id), [])).toBe('Invite a friend first.')
  })

  it('says the planner could not be reached when a suggestion is made with the stand-in gone', async () => {
    const { api, id, offline } = await spotVote()
    offline.restore()
    await expect(friendSuggests(api, await api.getSession(id), ['nicole'])).rejects.toThrow(/Cannot reach the Jio planner/)
    // Saying which spots work needs no planner, so it still works.
    await expect(friendsApprove(api, await api.getSession(id), ['darius'])).resolves.toBeTruthy()
  })
})
