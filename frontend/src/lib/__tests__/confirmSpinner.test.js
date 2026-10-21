// The app-wide spinner is for confirming the meeting spot, and nothing else: confirming (the meeting area, a spot or a known
// place) shows it once it has taken 600 ms and takes it away when it ends, however it ends; a slow load of anything else
// never shows it. Runs the real data layer and events store on a stand-in planner that is made slow on purpose.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi, stubPlanner } from './planFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

vi.setConfig({ testTimeout: 20000 })

beforeEach(() => stubPlanner(planner))
afterEach(() => vi.unstubAllGlobals())

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }
// A week from today, so the outing is never closed for being two days past its end with no plan (#120). The clock is real here:
// the spinner times itself with Date.now.
const NEXT_WEEK = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)

// A session in Locating where both people have a start, so the meeting area is worked out; then the events store and the
// spinner, from the same fresh copy of the code.
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
  return { api, events, spinner, id }
}

// Make every ranking of places take `ms` longer.
// How to call: slowRanking(1500)
function slowRanking(ms) {
  const answer = planner.rankSlot.getMockImplementation()
  planner.rankSlot.mockImplementation(async (args) => {
    await wait(ms)
    return answer(args)
  })
}

describe('the spinner while the meeting spot is confirmed', () => {
  it('shows once confirming has taken 600 ms, and goes when it is done', async () => {
    const { events, spinner, id } = await locating()
    slowRanking(1500)
    const confirming = events.useArea(id)
    await wait(300)
    expect(spinner.pageSlow.value).toBe(false)
    await wait(500)
    expect(spinner.pageSlow.value).toBe(true)
    expect(spinner.pageBlocking.value).toBe(true)
    await confirming
    await wait(spinner.MIN_SHOWN_MS + 50)
    expect(spinner.pageSlow.value).toBe(false)
    expect(spinner.pageBlocking.value).toBe(false)
    expect(events.byId[id].status).toBe('voting')
  })

  it('never shows for a quick confirm', async () => {
    const { events, spinner, id } = await locating()
    let seen = false
    const watch = setInterval(() => { seen ||= spinner.pageSlow.value }, 20)
    await events.useArea(id)
    await wait(800)
    clearInterval(watch)
    expect(seen).toBe(false)
  })

  it('goes when confirming fails, and the page can be used again', async () => {
    const { events, spinner, id } = await locating()
    // A known place the planner cannot price, after a slow answer: the confirm fails.
    planner.meetingArea.mockImplementation(async () => {
      await wait(1200)
      throw new Error('Cannot reach the Jio planner right now. Check your connection and try again.')
    })
    const confirming = events.setKnownPlace(id, 'bugis').catch((e) => e.message)
    await wait(800)
    expect(spinner.pageSlow.value).toBe(true)
    expect(await confirming).toContain('Cannot reach the Jio planner')
    await wait(spinner.MIN_SHOWN_MS + 50)
    expect([spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([false, false])
    expect(events.byId[id].status).toBe('locating')
  })
})

describe('everything else', () => {
  it('never shows the spinner for a slow load of the places to vote on', async () => {
    const { api, events, spinner, id } = await locating()
    await events.useArea(id)
    slowRanking(1500)
    let seen = false
    const watch = setInterval(() => { seen ||= spinner.pageSlow.value }, 20)
    await api.getPlan(id)
    await events.loadSession(id)
    clearInterval(watch)
    expect(seen).toBe(false)
  })
})

describe('confirming, under stress', () => {
  it('stays up until the last of overlapping confirms ends, then goes', async () => {
    const { events, spinner, id } = await locating()
    planner.meetingArea.mockImplementation(async () => {
      await wait(900)
      throw new Error('Cannot reach the Jio planner right now. Check your connection and try again.')
    })
    // The host presses twice in two places: two confirms overlap.
    const first = events.setKnownPlace(id, 'bugis').catch(() => 'failed')
    await wait(300)
    const second = events.setKnownPlace(id, 'novena').catch(() => 'failed')
    await first
    expect(spinner.pageSlow.value).toBe(true)
    await second
    await wait(spinner.MIN_SHOWN_MS + 50)
    expect([spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([false, false])
  })

  it('leaves nothing counted after many confirms at once that succeed and fail', async () => {
    const { events, spinner, id } = await locating()
    let n = 0
    planner.meetingArea.mockImplementation(async () => {
      n += 1
      await wait(50 + (n % 7) * 120)
      throw new Error('Cannot reach the Jio planner right now. Check your connection and try again.')
    })
    slowRanking(200)
    const all = [
      ...Array.from({ length: 15 }, (_, i) => events.setKnownPlace(id, ['bugis', 'novena', 'kovan'][i % 3]).catch(() => 'failed')),
      events.useArea(id).catch(() => 'failed'),
    ]
    await Promise.all(all)
    await wait(spinner.MIN_SHOWN_MS + 50)
    expect([spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([false, false])
    // And it still works afterwards: a new slow confirm shows it again.
    slowRanking(1200)
    const again = events.confirmSpot(id, 'nowhere').catch(() => 'failed')
    await again
    await wait(spinner.MIN_SHOWN_MS + 50)
    expect(spinner.pageSlow.value).toBe(false)
  })
})
