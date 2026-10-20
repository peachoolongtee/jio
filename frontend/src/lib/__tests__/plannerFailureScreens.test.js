// What the plan, map and session screens show when the planner is slow, failing or unreachable (ticket #57): a session that does not
// exist is "Page not found" with no retry; any other failure is "Could not load ..." in plain words with a Retry that tries again;
// the people store clears its busy flags when a load fails. The screens are drawn for real (domless.js) on the stand-in planner
// (planFixture.js); the failure is put into the store's own loader. No network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const mounted = []

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-17T14:20:00'))
})
beforeEach(() => stubPlanner(planner))
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})
afterAll(() => vi.useRealTimers())

const SLOW = 'The Jio planner is taking too long to answer. Try again in a moment.'
const DOWN = 'Cannot reach the Jio planner right now. Check your connection and try again.'

// The app's stores and router (stand-in screens), signed in as a new local account, with one light meetup to open.
// How to call: const t = await setUp()
async function setUp() {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  const { id } = await api.startRoam({ areaId: 'bugis' })
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  return { api, pinia, router, id }
}

// Draw a screen. `patch` runs on the stores first, to make a loader fail.
// How to call: const view = await draw(t, `/sessions/${t.id}/itinerary`, 'EventView', t.id, ({ events }) => { ... })
async function draw(t, path, name, id, patch = () => {}) {
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await t.router.push(path)
  const { useEventsStore } = await import('@/stores/events.js')
  const { useGroupsStore } = await import('@/stores/groups.js')
  patch({ events: useEventsStore(t.pinia), groups: useGroupsStore(t.pinia) })
  const { default: screen } = await import(`@/views/${name}.vue`)
  const view = await mountScreen(screen, { plugins: [t.pinia, t.router], props: { id } })
  mounted.push(view)
  return view
}
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))

// Make a loader reject until `heal()` is called, then work as it did.
// How to call: const heal = failing(events, 'loadItinerary', new Error(SLOW))
function failing(store, name, error) {
  const real = store[name]
  let broken = true
  store[name] = vi.fn((...args) => (broken ? Promise.reject(error) : real(...args)))
  return () => (broken = false)
}

const SCREENS = [
  { name: 'EventView', path: (id) => `/sessions/${id}/itinerary`, error: 'plan-load-error', ok: 'event-view', title: 'Could not load this plan' },
  { name: 'SessionMapView', path: (id) => `/sessions/${id}/map`, error: 'map-load-error', ok: null, title: 'Could not load the map' },
]

describe.each(SCREENS)('$name when the planner does not answer', ({ name, path, error, ok, title }) => {
  const shown = (view, testid) => view.has(`[data-testid="${testid}"]`)

  it.each([
    ['slow', SLOW],
    ['unreachable', DOWN],
  ])('says it could not load, with the %s sentence and a Retry, and does not say "not found"', async (_kind, sentence) => {
    const t = await setUp()
    const view = await draw(t, path(t.id), name, t.id, ({ events }) => failing(events, 'loadItinerary', new Error(sentence)))
    await until(() => shown(view, error))
    expect(view.text(`[data-testid="${error}"]`)).toContain(title)
    expect(view.text(`[data-testid="${error}"]`)).toContain(sentence)
    expect(view.text()).not.toContain('Page not found')
    expect(view.text('[role="alert"]')).toContain(sentence)
    expect(press(view, 'Retry')).toBeTruthy()
  })

  it('also shows it when the session itself cannot be read', async () => {
    const t = await setUp()
    const view = await draw(t, path(t.id), name, t.id, ({ events }) => failing(events, 'loadSession', new Error(DOWN)))
    await until(() => shown(view, error))
    expect(view.text()).toContain(DOWN)
    expect(view.text()).not.toContain('Page not found')
  })

  it('asks again on Retry, and shows the screen once the planner answers', async () => {
    const t = await setUp()
    let heal
    const view = await draw(t, path(t.id), name, t.id, ({ events }) => {
      heal = failing(events, 'loadItinerary', new Error(SLOW))
    })
    await until(() => shown(view, error))
    heal()
    await view.click(press(view, 'Retry'))
    await until(() => !shown(view, error))
    if (ok) await until(() => shown(view, ok))
    expect(view.text()).not.toContain('Could not load')
  })

  it('keeps the Retry on screen when it fails again', async () => {
    const t = await setUp()
    const view = await draw(t, path(t.id), name, t.id, ({ events }) => failing(events, 'loadItinerary', new Error(SLOW)))
    await until(() => shown(view, error))
    await view.click(press(view, 'Retry'))
    await until(() => shown(view, error))
    expect(press(view, 'Retry')).toBeTruthy()
  })

  it('says "Page not found", with no Retry, only for a session that does not exist', async () => {
    const t = await setUp()
    const view = await draw(t, path('nope'), name, 'nope')
    await until(() => view.text().includes('Page not found'))
    expect(press(view, 'Retry')).toBeUndefined()
    expect(view.text()).not.toContain('Could not load')
  })
})

describe('GroupDetailView when the people cannot be read', () => {
  it('says it could not load, with a Retry, and recovers', async () => {
    const t = await setUp()
    let heal
    const view = await draw(t, `/sessions/${t.id}`, 'GroupDetailView', t.id, ({ groups }) => {
      heal = failing(groups, 'loadPeople', new Error(SLOW))
    })
    await until(() => view.has('[data-testid="session-load-error"]'))
    expect(view.text('[data-testid="session-load-error"]')).toContain(SLOW)
    expect(view.text()).not.toContain('Page not found')
    heal()
    await view.click(press(view, 'Retry'))
    await until(() => !view.has('[data-testid="session-load-error"]'))
    expect(view.text()).not.toContain('Could not load')
  })

  it('says "Page not found" for a session that does not exist', async () => {
    const t = await setUp()
    const view = await draw(t, '/sessions/nope', 'GroupDetailView', 'nope')
    await until(() => view.text().includes('Page not found'))
    expect(press(view, 'Retry')).toBeUndefined()
  })
})
