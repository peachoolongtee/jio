// Two things the ranking requests do for speed (plannerApi.js): sample data asks for estimated travel (so the backend never
// routes it), and identical requests in flight together are sent once. Neither caches an answer, and neither shares one between
// different people or different questions.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { bindCurrentUser } from '../currentUser.js'
import { api, meetingArea, postShared, rankSlot, roamNearby, searchSlot, withEstimatedTravel } from '../plannerApi.js'

const HUB = { lat: 1.35, lng: 103.85 }
const SLOT = { start: 900, time: '15:00', duration: 90, category: 'eat' }
const ASK = { members: [{ id: 'a' }], centre: HUB, date: '2026-10-10', slot: SLOT, lastStop: false }
const ROAM = { members: [{ id: 'a' }], current: HUB, date: '2026-10-10', time: '15:00', minutes: 60 }
const MEET = { members: [{ id: 'a', start: HUB }], routing: true, alternatives: 2 }
const ok = (data = { status: 'ok', results: [], current: [], weather: null }) => ({ data, status: 200 })

// A planner that answers every request after `delay` ms, remembering what it was sent.
// How to call: const post = slowPlanner(20)
function slowPlanner(delay = 20, data) {
  return vi.spyOn(api, 'post').mockImplementation(() => new Promise((resolve) => setTimeout(() => resolve(ok(data)), delay)))
}

afterEach(() => {
  vi.restoreAllMocks()
  bindCurrentUser(() => '')
})

describe('sample data asks for estimated travel', () => {
  it('adds travel: estimate to the meeting area, the ranking and Roam while a build runs, and to nothing else', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok())
    await withEstimatedTravel(async () => {
      await meetingArea(MEET)
      await rankSlot(ASK)
      await roamNearby(ROAM)
    })
    expect(post.mock.calls.map(([url, body]) => [url, body.travel])).toEqual([
      ['/api/meeting-area', 'estimate'],
      ['/api/converge', 'estimate'],
      ['/api/roam', 'estimate'],
    ])
  })

  it('sends no travel field for a person\'s own planning, before or after a build', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok())
    await meetingArea(MEET)
    await withEstimatedTravel(async () => {})
    await rankSlot(ASK)
    await roamNearby(ROAM)
    await searchSlot({ query: 'market', members: [], centre: HUB, date: '2026-10-10', slot: SLOT, lastStop: false }).catch(() => {})
    for (const [, body] of post.mock.calls) expect(body).not.toHaveProperty('travel')
  })

  it('switches back when the build throws, and returns what the build returns', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok())
    await expect(withEstimatedTravel(async () => { throw new Error('boom') })).rejects.toThrow('boom')
    await expect(withEstimatedTravel(async () => 42)).resolves.toBe(42)
    await rankSlot(ASK)
    expect(post.mock.calls[0][1]).not.toHaveProperty('travel')
  })

  it('stays on until the last of several overlapping builds is done', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok())
    let finishFirst
    const first = withEstimatedTravel(() => new Promise((resolve) => { finishFirst = resolve }))
    await withEstimatedTravel(async () => {})
    await rankSlot(ASK)
    finishFirst()
    await first
    await rankSlot({ ...ASK, date: '2026-10-11' })
    expect(post.mock.calls[0][1].travel).toBe('estimate')
    expect(post.mock.calls[1][1]).not.toHaveProperty('travel')
  })

  it('an estimated request and a live one are different questions, so they are never shared', async () => {
    const post = slowPlanner()
    const live = rankSlot(ASK) // asked before the build starts, so it is the person's own
    const sample = withEstimatedTravel(() => rankSlot(ASK))
    await Promise.all([live, sample])
    expect(post).toHaveBeenCalledTimes(2)
    expect(post.mock.calls.map(([, body]) => body.travel)).toEqual([undefined, 'estimate'])
  })
})

describe('identical requests in flight are sent once', () => {
  it('two identical rankings started together make one request, and both get the answer', async () => {
    const post = slowPlanner(20, { status: 'ok', results: [], current: [], weather: { source: 'live' } })
    const [a, b] = await Promise.all([rankSlot(ASK), rankSlot(ASK)])
    expect(post).toHaveBeenCalledTimes(1)
    expect(a.weather).toEqual({ source: 'live' })
    expect(b.weather).toEqual({ source: 'live' })
  })

  it('shares the meeting area, Roam and search the same way', async () => {
    const post = slowPlanner(20, { status: 'ok', results: [], current: [], area: { id: 'bugis' } })
    const search = { query: 'market', members: [], centre: HUB, date: '2026-10-10', slot: SLOT, lastStop: false }
    await Promise.all([meetingArea(MEET), meetingArea(MEET), roamNearby(ROAM), roamNearby(ROAM), searchSlot(search), searchSlot(search)])
    expect(post.mock.calls.map(([url]) => url).sort()).toEqual(['/api/meeting-area', '/api/roam', '/api/search'])
  })

  it('never caches: a request after the first has answered goes to the server again', async () => {
    const post = slowPlanner(5)
    await rankSlot(ASK)
    await rankSlot(ASK)
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('different bodies, or the same body with another timeout, are different requests', async () => {
    const post = slowPlanner()
    await Promise.all([rankSlot(ASK), rankSlot({ ...ASK, date: '2026-10-11' }), rankSlot({ ...ASK, lastStop: true })])
    expect(post).toHaveBeenCalledTimes(3)
    post.mockClear()
    await Promise.all([postShared('/api/x', { a: 1 }, { timeout: 1000 }), postShared('/api/x', { a: 1 }, { timeout: 2000 }), postShared('/api/y', { a: 1 }, { timeout: 1000 })])
    expect(post).toHaveBeenCalledTimes(3)
  })

  it('never shares an answer between two signed-in people', async () => {
    const post = slowPlanner(20)
    let who = 'user-a'
    bindCurrentUser(() => who)
    const forA = rankSlot(ASK)
    who = 'user-b'
    const forB = rankSlot(ASK)
    await Promise.all([forA, forB])
    expect(post).toHaveBeenCalledTimes(2)
    // The same person asking twice still shares.
    post.mockClear()
    await Promise.all([rankSlot(ASK), rankSlot(ASK)])
    expect(post).toHaveBeenCalledTimes(1)
  })

  it('gives each caller its own copy of the answer, so one screen cannot change what another reads', async () => {
    slowPlanner(5, { rows: [{ n: 1 }] })
    const [first, second, third] = await Promise.all([postShared('/api/x', { q: 1 }), postShared('/api/x', { q: 1 }), postShared('/api/x', { q: 1 })])
    first.data.rows[0].n = 99
    first.data.rows.push({ n: 2 })
    expect(second.data).toEqual({ rows: [{ n: 1 }] })
    expect(third.data).toEqual({ rows: [{ n: 1 }] })
    expect(second.data).not.toBe(third.data)
  })

  it('a failure reaches every caller, and the next request tries again', async () => {
    const post = vi.spyOn(api, 'post').mockImplementationOnce(() => new Promise((_, reject) => setTimeout(() => reject(new Error('down')), 10))).mockResolvedValue(ok())
    const results = await Promise.allSettled([rankSlot(ASK), rankSlot(ASK)])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'rejected'])
    expect(post).toHaveBeenCalledTimes(1)
    await expect(rankSlot(ASK)).resolves.toBeTruthy()
    expect(post).toHaveBeenCalledTimes(2)
  })

  it('writes are not shared: only the ranking reads use it', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(ok())
    const { confirmSessionSpot } = await import('../plannerApi.js')
    await Promise.all([confirmSessionSpot('s1', 'bugis'), confirmSessionSpot('s1', 'bugis')])
    expect(post).toHaveBeenCalledTimes(2)
  })
})
