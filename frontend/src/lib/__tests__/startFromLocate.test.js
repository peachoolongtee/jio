// The Start choice's area step for a session still choosing where to meet (/sessions/:id/change-place?where=1): naming an area there
// sets the known place. Locate no longer links to it (Faith's walkthrough, 30 October 2026: how to meet is settled on the Start choice),
// but the address still works. The screen is drawn on the in-memory page (domless.js) for a local account.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner, tomorrow } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const mounted = []
beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }))
beforeEach(() => {
  stubPlanner(planner)
  vi.setSystemTime(new Date('2026-10-09T10:00:00+08:00'))
})
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})
afterAll(() => vi.useRealTimers())

// Ian hosts a session with Darius, started on "Find the fairest spot", so it is locating; the area step is drawn at `path`.
// How to call: const { api, id, router, view } = await openStep()
async function openStep(path = (id) => `/sessions/${id}/change-place?where=1`) {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2004-03-18', homeAreaId: 'bishan' })
  const { id } = await api.createSession({ title: 'Lunch', date: tomorrow(), start: '12:00', end: '15:00' })
  await api.inviteFriends(id, ['darius'])
  await api.startSession(id, { meetBy: 'fairest' })
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await router.push(path(id))
  const { default: StartView } = await import('@/views/StartView.vue')
  const view = await mountScreen(StartView, { plugins: [pinia, router], props: { id, change: true } })
  mounted.push(view)
  return { api, id, router, view }
}
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))

describe('the area step, from Locate', () => {
  it('asks for the meeting area and goes back to Locate', async () => {
    const { id, view } = await openStep()
    await until(() => view.has('[data-testid=start-view]'))
    expect(view.text()).toContain('Pick the meeting area')
    expect(view.all('a').some((a) => a.attrs.href === `/sessions/${id}`)).toBe(true)
    expect(view.errors).toEqual([])
  })

  it('sets the known place for the area picked, and goes on to choosing places', async () => {
    const { api, id, router, view } = await openStep()
    await until(() => !!view.all('[role=radio]').find((b) => view.text(b) === 'Bugis'))
    await view.click(view.all('[role=radio]').find((b) => view.text(b) === 'Bugis'))
    await view.click(press(view, 'Meet at Bugis'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    expect(await api.getSession(id)).toMatchObject({ status: 'voting', meetBy: 'known', areaName: 'Bugis' })
  })

  it('does not offer the first step of "Change meeting place" while the group is still choosing', async () => {
    const { id, router } = await openStep((id) => `/sessions/${id}/change-place`)
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
  })
})
