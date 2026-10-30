// "How are you starting?" on Create session (walkthrough, 30 October 2026): "From scratch" is the usual form, and "Already out" brings
// Home's "Already out? Find something nearby" into creating a session: no day or times, "Where are you?", then a light meetup for
// today and its itinerary. For the demo and local accounts only. The screen is drawn on the in-memory page (domless.js), with the
// location sheet stood in for by one button that picks Bugis.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'
import { START_MODES, areaName, startModesFor } from '../startChoice.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/group/LocationSheet.vue', () => ({
  default: {
    props: ['open', 'which', 'title', 'home'],
    emits: ['select', 'update:open'],
    setup(props, { emit }) {
      return () => (props.open ? h('button', { type: 'button', 'data-testid': 'pick-bugis', onClick: () => { emit('select', { areaId: 'bugis', label: 'Bugis Junction' }); emit('update:open', false) } }, 'Bugis') : null)
    },
  },
}))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const mounted = []
beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }))
beforeEach(() => {
  stubPlanner(planner)
  vi.setSystemTime(new Date('2026-10-17T14:20:00+08:00'))
})
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})
afterAll(() => vi.useRealTimers())

describe('the start modes', () => {
  it('are From scratch and Already out for the demo and local accounts, and From scratch alone for a real account', () => {
    expect(startModesFor(true)).toEqual([{ value: 'scratch', label: 'From scratch' }, { value: 'out', label: 'Already out' }])
    expect(startModesFor(false)).toEqual([{ value: 'scratch', label: 'From scratch' }])
    expect(START_MODES.out.note).toContain('today')
  })

  it('names an area by its id', () => {
    expect(areaName('bugis')).toBe('Bugis')
    expect(areaName('nowhere')).toBe('')
  })
})

describe('Create session, already out', () => {
  // The create form for a new local account, at `path`.
  async function form(path = '/sessions/new') {
    const api = await loadApi()
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    const { routes } = await import('@/router/routes.js')
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
    await router.push(path)
    const { default: CreateEventView } = await import('@/views/CreateEventView.vue')
    const view = await mountScreen(CreateEventView, { plugins: [pinia, router] })
    mounted.push(view)
    await until(() => view.has('[data-testid=create-event-view]'))
    return { api, router, view }
  }
  const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))

  it('starts on From scratch, with the day and times', async () => {
    const { view } = await form()
    expect(view.one('select').attrs['data-testid']).toBe('start-mode')
    expect(view.text()).toContain('How are you starting?')
    expect(view.all('option').map((o) => view.text(o))).toEqual(['From scratch', 'Already out'])
    expect(view.has('[data-testid=where-row]')).toBe(false)
    expect(press(view, 'Next')).toBeTruthy()
  })

  it('hides the day and times, asks where you are, and starts a light meetup for today that opens its itinerary', async () => {
    const { api, router, view } = await form('/sessions/new?start=out')
    await until(() => view.has('[data-testid=where-row]'))
    expect(view.text()).toContain(START_MODES.out.note)
    expect(view.has('.tp__input')).toBe(false)
    expect(press(view, 'Find places nearby').disabled).toBe(true)
    await view.click('[data-testid=where-row]')
    await view.click('[data-testid=pick-bugis]')
    await until(() => view.text('[data-testid=where-row]').includes('Bugis'))
    await view.click(press(view, 'Find places nearby'))
    await until(() => /\/sessions\/[^/]+\/itinerary$/.test(router.currentRoute.value.path))
    const id = router.currentRoute.value.path.split('/')[2]
    const session = await api.getSession(id)
    expect(session).toMatchObject({ light: true, status: 'confirmed', date: '2026-10-17', title: 'Out in Bugis', areaName: 'Bugis' })
    expect(view.errors).toEqual([])
  })

  it('keeps a title that was typed', async () => {
    const { api, router, view } = await form('/sessions/new?start=out')
    await until(() => view.has('[data-testid=where-row]'))
    view.type('input', 'After work')
    await view.click('[data-testid=where-row]')
    await view.click('[data-testid=pick-bugis]')
    await view.click(press(view, 'Find places nearby'))
    await until(() => router.currentRoute.value.path.endsWith('/itinerary'))
    expect((await api.getSession(router.currentRoute.value.path.split('/')[2])).title).toBe('After work')
  })
})
