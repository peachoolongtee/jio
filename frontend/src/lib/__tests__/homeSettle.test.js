// Home settles outings that ended while the person was on another page (ticket #120, review of pull request #152). The store is
// already loaded when Home opens, so nothing changes for a watcher to notice: Home itself must ask for the list again when it
// opens. Drawn for real (domless.js) on the stand-in planner (planFixture.js); the maps need a browser and are stood in for.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { STORAGE_KEY, confirmedSave, loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/home/MeetupPins.vue', () => ({ default: { name: 'MeetupPins', render: () => null } }))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const at = (iso) => vi.setSystemTime(new Date(iso))

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-09T10:00:00+08:00')
  stubPlanner(planner)
  await confirmedSave()
})
beforeEach(() => {
  stubPlanner(planner)
  at('2026-10-10T15:00:00+08:00')
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The confirmed Saturday outing (12:00 to 20:00, Ian and Jonathan), the store loaded while it was still going, Home drawn after.
// How to call: const t = await openHomeAt('2026-10-10T20:30:00+08:00')
async function openHomeAt(iso, { shared = false } = {}) {
  const { text } = await confirmedSave()
  const api = await loadApi({ data: { [STORAGE_KEY]: text } })
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { useEventsStore } = await import('@/stores/events.js')
  const events = useEventsStore()
  // The person was on another page: the store holds the outing as it was at 15:00.
  await events.loadSessions()
  expect(events.sessions[0].status).toBe('confirmed')
  // A shared outing (of the server): nothing finishes it by a clock.
  if (shared) events.sessions = events.sessions.map((s) => ({ ...s, remote: true }))
  at(iso)
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push('/')
  const { default: LandingView } = await import('@/views/LandingView.vue')
  const view = await mountScreen(LandingView, { plugins: [pinia, router] })
  return { api, events, view }
}

describe('Home, opened with the list already loaded', () => {
  it('does not finish a confirmed outing by a clock either: it stays confirmed, unpaid, and Home says it stays open until it is finished', async () => {
    const { api, events, view } = await openHomeAt('2026-10-10T20:30:00+08:00')
    await view.tick()
    await view.tick()
    expect(events.sessions[0].status).toBe('confirmed')
    expect(JSON.parse(api.storage.store[STORAGE_KEY]).sessions[0].status).toBe('confirmed')
    expect(view.text('[data-testid="home-overdue"]')).toContain('has passed its end time. It stays open until its host finishes it.')
    view.unmount()
  })

  it('does not finish a shared outing by a clock: it stays confirmed, and Home says it stays open until its host finishes it', async () => {
    const { events, view } = await openHomeAt('2026-10-10T20:30:00+08:00', { shared: true })
    await view.tick()
    await view.tick()
    expect(events.sessions[0].status).toBe('confirmed')
    expect(view.text('[data-testid="home-overdue"]')).toContain('has passed its end time. It stays open until its host finishes it.')
    view.unmount()
  })

  // Review of 1 November 2026: each outing past its end time had a banner of its own.
  it('says it once when several outings are past their end time, with the way to the list', async () => {
    const { events, view } = await openHomeAt('2026-10-10T20:30:00+08:00')
    const base = events.sessions[0]
    events.sessions = [base, { ...base, id: 's-b', title: 'Second' }, { ...base, id: 's-c', title: 'Third' }]
    await view.tick()
    await view.tick()
    expect(view.all('[data-testid="home-overdue"]')).toHaveLength(1)
    expect(view.text('[data-testid="home-overdue"]')).toContain('3 outings have passed their end time and are not finished')
    expect(view.text('[data-testid="home-overdue"]')).toContain('See all meetups')
    view.unmount()
  })

  it('leaves an outing that is still going as it is', async () => {
    const { events, view } = await openHomeAt('2026-10-10T19:00:00+08:00')
    await view.tick()
    await view.tick()
    expect(events.sessions[0].status).toBe('confirmed')
    view.unmount()
  })
})
