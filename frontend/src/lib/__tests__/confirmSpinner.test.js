// The busy state of confirming the meeting spot, and of nothing else: confirming (the meeting area, a spot or a known place) raises
// the events store's `confirming` flag at once and the map's spinner once it has taken 600 ms, and takes both away when it ends,
// however it ends; a slow load of anything else never shows them. This file is the local data layer (a demo account's sessions); the
// server path of a real account is in confirmSpinner.server.test.js. It runs the real data layer and events store on a stand-in
// planner made slow on purpose, on a fake clock, so the 600 ms threshold is exact and no test waits in real time.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { watch } from 'vue'
import { loadApi, stubPlanner } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeEach(() => stubPlanner(planner))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }
// A week from today, so the outing is never closed for being two days past its end with no plan (#120).
const NEXT_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
const FAILURE = 'Cannot reach the Jio planner right now. Check your connection and try again.'

// Move the fake clock on, letting every promise that waits on it run.
// How to call: await tick(599)
const tick = (ms) => vi.advanceTimersByTimeAsync(ms)

// Move the fake clock on in small steps until a promise settles, and say how it ended.
// How to call: const outcome = await settled(events.useArea(id)) -> { ok: true, value } or { ok: false, error }
async function settled(promise, stepMs = 50) {
  let outcome = null
  promise.then((value) => (outcome = { ok: true, value }), (error) => (outcome = { ok: false, error }))
  for (let steps = 0; !outcome && steps < 2000; steps += 1) await tick(stepMs)
  if (!outcome) throw new Error('Still running after 100 seconds of fake time')
  return outcome
}

// A session in Locating where both people have a start, so the meeting area is worked out; then the events store and the
// spinner, from the same fresh copy of the code. The fake clock starts once the session is built.
// How to call: const { events, spinner, id } = await locating()
async function locating() {
  const api = await loadApi()
  await api.signUp(PROFILE)
  const { id } = await api.createSession({ title: 'Saturday', date: NEXT_WEEK, start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useEventsStore } = await import('@/stores/events.js')
  const spinner = await import('../pageLoading.js')
  const events = useEventsStore()
  await events.loadSession(id)
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
  return { api, events, spinner, id }
}

// Remember whether the spinner was ever up.
// How to call: const seen = watchSpinner(spinner); ...; expect(seen()).toBe(false)
function watchSpinner(spinner) {
  let up = false
  watch(spinner.pageSlow, (value) => { up ||= value }, { flush: 'sync' })
  return () => up
}

// Make every ranking of places take `ms` longer.
// How to call: slowRanking(1500)
function slowRanking(ms) {
  const answer = planner.rankSlot.getMockImplementation()
  planner.rankSlot.mockImplementation(async (args) => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    return answer(args)
  })
}

// Make the planner's meeting area slow and then fail, as when the connection drops.
// How to call: slowFailure(900)
function slowFailure(ms) {
  planner.meetingArea.mockImplementation(async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    throw new Error(FAILURE)
  })
}

describe('the busy state while the meeting spot is confirmed', () => {
  it('raises the confirming flag at once, shows the spinner at 600 ms exactly, and drops both when it is done', async () => {
    const { events, spinner, id } = await locating()
    slowRanking(1500)
    expect(events.confirming).toBe(false)
    const confirming = events.useArea(id)
    expect(events.confirming).toBe(true)
    await tick(spinner.SLOW_MS - 1)
    expect(spinner.pageSlow.value).toBe(false)
    expect(events.confirming).toBe(true)
    await tick(1)
    expect(spinner.pageSlow.value).toBe(true)
    expect(spinner.pageBlocking.value).toBe(true)
    expect((await settled(confirming)).ok).toBe(true)
    expect(events.confirming).toBe(false)
    await tick(spinner.MIN_SHOWN_MS)
    expect(spinner.pageSlow.value).toBe(false)
    expect(spinner.pageBlocking.value).toBe(false)
    expect(events.byId[id].status).toBe('voting')
  })

  it('never shows the spinner for a quick confirm', async () => {
    const { events, spinner, id } = await locating()
    const seen = watchSpinner(spinner)
    expect((await settled(events.useArea(id))).ok).toBe(true)
    await tick(spinner.SLOW_MS + spinner.MIN_SHOWN_MS)
    expect(seen()).toBe(false)
    expect(events.confirming).toBe(false)
  })

  it('goes when confirming fails, and the page can be used again', async () => {
    const { events, spinner, id } = await locating()
    // A known place the planner cannot price, after a slow answer: the confirm fails.
    slowFailure(1200)
    const confirming = events.setKnownPlace(id, 'bugis')
    await tick(800)
    expect(spinner.pageSlow.value).toBe(true)
    const outcome = await settled(confirming)
    expect(outcome.ok).toBe(false)
    expect(outcome.error.message).toContain('Cannot reach the Jio planner')
    expect(events.confirming).toBe(false)
    await tick(spinner.MIN_SHOWN_MS)
    expect([spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([false, false])
    expect(events.byId[id].status).toBe('locating')
  })

  it('counts a confirm of a known place and of a spot the same way', async () => {
    const { events, id } = await locating()
    slowFailure(100)
    const place = events.setKnownPlace(id, 'bugis')
    expect(events.confirming).toBe(true)
    await settled(place)
    expect(events.confirming).toBe(false)
    const spot = events.confirmSpot(id, 'nowhere')
    expect(events.confirming).toBe(true)
    await settled(spot)
    expect(events.confirming).toBe(false)
  })
})

describe('everything else', () => {
  it('never shows the spinner or the flag for a slow load of the places to vote on', async () => {
    const { api, events, spinner, id } = await locating()
    expect((await settled(events.useArea(id))).ok).toBe(true)
    await tick(spinner.MIN_SHOWN_MS)
    slowRanking(1500)
    const seen = watchSpinner(spinner)
    const flag = vi.fn()
    watch(() => events.confirming, flag, { flush: 'sync' })
    await settled(api.getPlan(id))
    await settled(events.loadSession(id))
    expect(seen()).toBe(false)
    expect(flag).not.toHaveBeenCalled()
  })
})

describe('confirming, under stress', () => {
  it('stays up until the last of overlapping confirms ends, then goes', async () => {
    const { events, spinner, id } = await locating()
    slowFailure(900)
    // The host presses twice in two places: two confirms overlap.
    const first = events.setKnownPlace(id, 'bugis')
    await tick(300)
    const second = events.setKnownPlace(id, 'novena')
    await settled(first)
    expect(spinner.pageSlow.value).toBe(true)
    expect(events.confirming).toBe(true)
    await settled(second)
    expect(events.confirming).toBe(false)
    await tick(spinner.MIN_SHOWN_MS)
    expect([spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([false, false])
  })

  it('leaves nothing counted after many confirms at once that fail, and still works afterwards', async () => {
    const { events, spinner, id } = await locating()
    let n = 0
    planner.meetingArea.mockImplementation(async () => {
      n += 1
      await new Promise((resolve) => setTimeout(resolve, 50 + (n % 7) * 120))
      throw new Error(FAILURE)
    })
    const all = Array.from({ length: 15 }, (_, i) => events.setKnownPlace(id, ['bugis', 'novena', 'kovan'][i % 3]))
    await settled(Promise.allSettled(all))
    expect(events.confirming).toBe(false)
    await tick(spinner.MIN_SHOWN_MS)
    expect([spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([false, false])
    // A new slow confirm shows both again.
    slowFailure(1200)
    const again = events.setKnownPlace(id, 'bugis')
    await tick(spinner.SLOW_MS)
    expect([events.confirming, spinner.pageSlow.value]).toEqual([true, true])
    await settled(again)
    await tick(spinner.MIN_SHOWN_MS)
    expect([events.confirming, spinner.pageSlow.value]).toEqual([false, false])
    // And a confirm that works ends the same way.
    slowRanking(700)
    expect((await settled(events.useArea(id))).ok).toBe(true)
    await tick(spinner.MIN_SHOWN_MS)
    expect([events.confirming, spinner.pageSlow.value, events.byId[id].status]).toEqual([false, false, 'voting'])
  })
})
