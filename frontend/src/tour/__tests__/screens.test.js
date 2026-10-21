// Screens of the app drawn for real (lib/__tests__/domless.js) on top of the demo tour's data: the invite page's Jio streaks, which
// must come only from the saves the tour shows (lib/sessionFilter.js), and Home, which settles outings that ended while the
// person was on another page. The planner backend is not there (a closed port); the maps need a browser and are stood in for.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { loadApi } from '../../lib/__tests__/planFixture.js'
import { mountScreen, until } from '../../lib/__tests__/domless.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'

vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/home/MeetupPins.vue', () => ({ default: { name: 'MeetupPins', render: () => null } }))
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 })

const NOW = new Date('2026-10-10T14:20:00')
const DEAD_BACKEND = 'http://127.0.0.1:1'
const stubPhotos = async (kinds, count) => Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,AAAA${i}`)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The data layer on a fake storage, signed in as the demo account, the tour loaded and attached.
// How to call: const t = await boot()
async function boot() {
  const api = await loadApi()
  await api.signUp(DEMO_ACCOUNT)
  api.api.defaults.baseURL = DEAD_BACKEND
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useTourStore } = await import('../store.js')
  const tour = useTourStore()
  await tour.attach()
  await tour.settled()
  await tour.start({ now: NOW, makePhotos: stubPhotos })
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { useEventsStore } = await import('@/stores/events.js')
  return { api, tour, pinia, events: useEventsStore() }
}

// A screen of the app at a path.
// How to call: const view = await draw(t, () => import('@/views/InviteView.vue'), '/sessions/s1/invite', { id: 's1' })
async function draw(t, load, path, props = {}) {
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(path)
  const { default: View } = await load()
  return mountScreen(View, { plugins: [t.pinia, router], props })
}

describe('the invite page at a tour checkpoint', () => {
  let t
  beforeAll(async () => {
    t = await boot()
  })

  async function invitePage(selected, id) {
    t.tour.select(selected)
    t.events.sessions = []
    t.events.loaded = false
    const view = await draw(t, () => import('@/views/InviteView.vue'), `/sessions/${id}/invite`, { id })
    await until(() => view.text().includes('Friends') || view.text().includes('Frequent hangouts'))
    await until(() => t.events.loaded)
    await view.tick()
    return view
  }

  it('shows no Jio streak at checkpoint 1, where the friends are still to be invited, though the story\'s last save is completed', async () => {
    const [id] = t.tour.manifest.story
    const view = await invitePage(0, id)
    expect(view.errors).toEqual([])
    // The three friends of the story are listed, with no history: one plain list.
    expect(view.text()).toContain('Darius')
    expect(view.text()).not.toContain('Frequent hangouts')
    expect(view.all('[data-testid="jio-streak"]')).toHaveLength(0)
  })

  it('shows none at checkpoint 2 either', async () => {
    const [, id] = t.tour.manifest.story
    const view = await invitePage(1, id)
    expect(view.errors).toEqual([])
    expect(view.text()).not.toContain('Frequent hangouts')
    expect(view.all('[data-testid="jio-streak"]')).toHaveLength(0)
  })

  it('shows them when the finished save is the one the tour shows', async () => {
    // The first save's invite page, with the last checkpoint selected: that one finished, with Darius, Nicole and Faith in it.
    const [id] = t.tour.manifest.story
    const view = await invitePage(7, id)
    expect(view.text()).toContain('Frequent hangouts')
    expect(view.all('[data-testid="jio-streak"]').length).toBeGreaterThanOrEqual(3)
  })
})
