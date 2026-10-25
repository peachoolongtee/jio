// The strip (tour/TourStrip.vue) and the page /demo (tour/DemoView.vue), drawn on the in-memory page (lib/__tests__/domless.js):
// every checkpoint listed and named, the current one marked, next and back, leaving, the quiet line about stand-ins, and what
// /demo does for nobody, for the demo account and for someone else's account.
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi } from '../../lib/__tests__/planFixture.js'
import { mountScreen, until } from '../../lib/__tests__/domless.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'

vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 })
vi.mock('@/components/ui/GridPulse.vue', () => ({ default: { render: () => null } }))
// Photos are drawn on a canvas, which the test runner does not have; /demo makes its own, so they are stood in for here.
const photos = vi.hoisted(() => ({ fail: false }))
vi.mock('@/components/dev/demoPhotos.js', () => ({
  makeDemoPhotos: async (kinds, count) => {
    if (photos.fail) throw new Error('Could not load the park photo.')
    return Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,AAAA${i}`)
  },
}))

const NOW = new Date('2026-10-10T14:20:00')
const stubPhotos = async (kinds, count) => Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,AAAA${i}`)
const NAMES = ['Just created', 'Invites out', 'Choosing how to meet', 'A place already known', 'Sharing locations', 'Choosing the spot', 'Voting on places', 'Plan confirmed', 'On the day', 'Finished with photos']

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The data layer on a fake storage, the demo account signed in (or not), the stores and a router with stand-in screens.
// How to call: const t = await boot({ signedIn: true, tour: true })
async function boot({ signedIn = true, tour = false, account = DEMO_ACCOUNT } = {}) {
  const api = await loadApi()
  api.api.defaults.baseURL = 'http://127.0.0.1:1'
  if (signedIn) await api.signUp(account)
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const { useTourStore } = await import('../store.js')
  const auth = useAuthStore()
  await auth.init()
  const store = useTourStore()
  await store.attach()
  if (tour) await store.start({ now: NOW, makePhotos: stubPhotos })
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push('/')
  await router.isReady()
  return { api, auth, store, router, pinia, storage: api.storage }
}

const named = (view, name) => view.all('button').find((b) => b.attrs['aria-label'] === name)

describe('the strip', () => {
  let t
  let view
  beforeAll(async () => {
    t = await boot({ tour: true })
    const { default: TourStrip } = await import('../TourStrip.vue')
    view = await mountScreen(TourStrip, { plugins: [t.pinia, t.router] })
  })

  it('lists the ten checkpoints in order, by name, and marks the first as current', () => {
    const stops = view.all('.tour__stop')
    expect(stops).toHaveLength(10)
    expect(stops.map((s) => view.text(s))).toEqual(NAMES.map((name, i) => `${i + 1}${name}`))
    expect(stops.map((s) => s.attrs['aria-current'])).toEqual(['step', ...Array(9).fill(undefined)])
    expect(view.text('.tour__toggle')).toContain('1 of 10')
  })

  it('names every control for a screen reader, and says it is a demo with sample data', () => {
    expect(named(view, 'Previous checkpoint')).toBeTruthy()
    expect(named(view, 'Next checkpoint')).toBeTruthy()
    expect(view.one('[data-testid=tour-strip]').attrs['aria-label']).toBe('Demo tour')
    // The tour was loaded with the planner backend not there, so its places and times are rough, and the line says so.
    expect(view.text('.tour__caption')).toBe('Sample data. Places and times are rough.')
    // The line about what to look at is announced when it changes, and starts with where we are.
    expect(view.one('.tour__look').attrs.role).toBe('status')
    expect(view.text('.tour__look')).toContain('Checkpoint 1 of 10, Just created.')
  })

  it('has nothing before the first checkpoint to go back to', () => {
    expect(named(view, 'Previous checkpoint').attrs.disabled).toBeDefined()
  })

  it('goes next, opening the page of the next checkpoint, and back', async () => {
    await view.click(named(view, 'Next checkpoint'))
    await until(() => t.router.currentRoute.value.path === '/sessions/s2/invite')
    expect(t.store.index).toBe(1)
    expect(view.all('.tour__stop').map((s) => s.attrs['aria-current'])).toEqual([undefined, 'step', ...Array(8).fill(undefined)])
    expect(view.text('.tour__look')).toContain('Darius and Nicole said yes')
    await view.click(named(view, 'Previous checkpoint'))
    await until(() => t.router.currentRoute.value.path === '/sessions/s1')
    expect(t.store.index).toBe(0)
  })

  it('opens the right page when a checkpoint is pressed, and does not go past the last', async () => {
    await view.click(view.all('.tour__stop')[6])
    await until(() => t.router.currentRoute.value.path === '/sessions/s7/plan')
    expect(view.text('.tour__toggle')).toContain('7 of 10')
    await view.click(view.all('.tour__stop')[9])
    await until(() => t.router.currentRoute.value.path === '/sessions/s10/photos')
    expect(named(view, 'Next checkpoint').attrs.disabled).toBeDefined()
    expect(view.errors).toEqual([])
  })

  it('says only that it is sample data when the planner backend answered, and that places and times are rough when it did not', async () => {
    t.store.manifest = { ...t.store.manifest, rough: false }
    t.store.lastPlanner = 'backend'
    await view.tick()
    expect(view.text('.tour__caption')).toBe('Demo tour. Sample data.')
    t.store.lastPlanner = 'stand-in'
    await view.tick()
    expect(view.text('.tour__caption')).toBe('Sample data. Places and times are rough.')
  })

  it('goes away when the tour is left, keeping the account, and comes back when resumed', async () => {
    await view.click(view.all('button').find((b) => view.text(b) === 'Leave tour'))
    await until(() => !view.has('[data-testid=tour-strip]'))
    expect(t.router.currentRoute.value.path).toBe('/')
    expect((await t.api.getUser()).demo).toBe(true)
    t.store.resume()
    await until(() => view.has('[data-testid=tour-strip]'))
  })
})

describe('/demo', () => {
  async function open(options) {
    const t = await boot(options)
    const { default: DemoView } = await import('../DemoView.vue')
    const view = await mountScreen(DemoView, { plugins: [t.pinia, t.router] })
    return { ...t, view }
  }

  it('makes the demo account and loads the tour when nobody is signed in, then goes Home with the outing chosen', async () => {
    const t = await open({ signedIn: false })
    expect(t.view.text()).toContain('Setting up the demo')
    await until(() => t.router.currentRoute.value.path === '/' && t.router.currentRoute.value.query.meetup === 's1', 80000)
    expect(t.auth.user).toMatchObject({ demo: true, username: 'ian' })
    expect(t.store.live).toBe(true)
    expect(await t.api.listSessions()).toHaveLength(13)
    expect(t.view.errors).toEqual([])
  })

  it('shows progress in words while it works', async () => {
    const t = await open({ signedIn: false })
    await until(() => /Loading the outing: \d+ of 13 sessions/.test(t.view.text()), 40000)
    expect(t.view.has('[role=progressbar]')).toBe(true)
    await until(() => t.router.currentRoute.value.query.meetup === 's1', 80000)
  })

  it('asks what to do when the demo account is already there, and carries on from the same checkpoint', async () => {
    const t = await open({ tour: true })
    t.store.select(7)
    expect(t.view.text()).toContain('Demo tour')
    const labels = t.view.all('.btn').map((b) => t.view.text(b))
    expect(labels).toEqual(expect.arrayContaining(['Restart the tour', 'Carry on', 'Go to Home']))
    await t.view.click(t.view.all('.btn').find((b) => t.view.text(b) === 'Carry on'))
    await until(() => t.router.currentRoute.value.path === '/sessions/s8/itinerary')
  })

  it('offers only to start the tour when the demo account has none', async () => {
    const t = await open({})
    const labels = t.view.all('.btn').map((b) => t.view.text(b))
    expect(labels).toContain('Restart the tour')
    expect(labels).not.toContain('Carry on')
  })

  it('leaves a signed-in account that is not the demo account untouched, and says to sign out first', async () => {
    const own = { email: 'sam@example.com', name: 'Sam', username: 'sam', dob: '2001-05-06', homeAreaId: 'tampines', friends: ['darius'] }
    const t = await boot({ account: own })
    await t.api.createSession({ title: 'Saturday', date: '2026-10-17', start: '12:00', end: '20:00' })
    const key = 'jio-demo-v1'
    const before = t.storage.store[key]
    const { default: DemoView } = await import('../DemoView.vue')
    const view = await mountScreen(DemoView, { plugins: [t.pinia, t.router] })
    await view.tick()
    expect(view.text('[data-testid=demo-other]')).toContain('sign out first')
    expect(view.has('[role=progressbar]')).toBe(false)
    // Nothing was written: not the account, not the sessions, and no tour.
    expect(t.storage.store[key]).toBe(before)
    expect(t.storage.store['jio-tour-v1']).toBeUndefined()
    expect(t.auth.user).toMatchObject({ username: 'sam' })
    expect((await t.api.listSessions()).map((s) => s.title)).toEqual(['Saturday'])
    expect(t.store.manifest).toBeNull()
  })

  it('says what was and was not loaded when it stops part way, and loads everything when tried again', async () => {
    photos.fail = true
    const t = await open({ signedIn: false })
    await until(() => t.view.has('[role=alert]'), 80000)
    expect(t.view.text('[role=alert]')).toMatch(/^Loaded 12 of 13 sessions\. Not finished: "Catch-up makan with the gang" stopped at photos \(Could not load the park photo\.\)/)
    expect(t.view.text()).toContain('The demo account was made, and whatever was loaded is in it.')
    expect(t.router.currentRoute.value.path).toBe('/')
    expect(t.store.manifest).toBeNull()
    expect(t.view.all('.btn').map((b) => t.view.text(b))).toEqual(['Try again', 'Go to Home'])
    photos.fail = false
    await t.view.click(t.view.all('.btn').find((b) => t.view.text(b) === 'Try again'))
    await until(() => t.router.currentRoute.value.query.meetup === 's1', 80000)
    expect(t.store.live).toBe(true)
    expect(await t.api.listSessions()).toHaveLength(13)
  })
})
