// The Vote page's search for a place to add, for a keyboard and a screen reader (review of 1 November 2026): Escape closes the panel,
// the box says whether it is open (aria-expanded), what came back is announced, the two CDC controls say what each one filters in words,
// and "Added" is an ink state with a tick whose name says what a press does and whose reason for being off is read out. Drawn for real
// (domless.js) on the stand-in planner (planFixture.js); the map needs a browser and is stood in for.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
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

// A voting session of this browser, its Vote page drawn.
// How to call: const { view } = await votingPage()
async function votingPage() {
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
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-17', start: '16:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan'])
  await api.startSession(id)
  await api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
  await api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
  await api.useMeetingArea(id)
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await router.push(`/sessions/${id}/plan`)
  const { default: screen } = await import('@/views/PlannerView.vue')
  const view = await mountScreen(screen, { plugins: [pinia, router], props: { id } })
  mounted.push(view)
  await until(() => view.has('article[data-option]'))
  return { view, api, id }
}
const box = (view) => view.one('[data-testid=place-search]').querySelector('input')
const results = (cdc = false) => async ({ slot }) => (slot.category === 'eat' ? [{ id: 'near-1', name: `Near ${cdc ? 'CDC ' : ''}place`, area: 'Bishan', category: 'eat', walk: 3, unfit: '', verify: [], dietUnknown: [], cdc }] : [])

describe('the search box', () => {
  it('says whether the panel is open, closes it on Escape while keeping focus, and opens it again on the next focus', async () => {
    const { view } = await votingPage()
    planner.searchSlot.mockImplementation(results())
    expect(box(view).attrs.role).toBe('combobox')
    expect(box(view).attrs['aria-expanded']).toBe('false')
    box(view).dispatch('focusin')
    await until(() => view.has('[data-testid=search-panel]'))
    expect(box(view).attrs['aria-expanded']).toBe('true')
    expect(box(view).attrs['aria-controls']).toBe(view.one('[data-testid=search-panel]').attrs.id)
    box(view).dispatch('keydown', { key: 'Escape' })
    await view.tick()
    expect(view.has('[data-testid=search-panel]')).toBe(false)
    expect(box(view).attrs['aria-expanded']).toBe('false')
    // Typing opens it again.
    view.type('input[type=search]', 'kopi')
    await until(() => view.has('[data-testid=search-panel]'))
    expect(box(view).attrs['aria-expanded']).toBe('true')
  })

  it('announces that it is searching and how many places came back, outside the panel', async () => {
    const { view } = await votingPage()
    planner.searchSlot.mockImplementation(results())
    box(view).dispatch('focusin')
    await until(() => view.text('[data-testid=search-status]') === '1 suggested place')
    view.type('input[type=search]', 'zzz')
    planner.searchSlot.mockImplementation(async () => [])
    await until(() => view.text('[data-testid=search-status]') === 'No places found')
    const status = view.one('[data-testid=search-status]')
    expect(status.attrs.role).toBe('status')
    expect(status.closest('[data-testid=search-panel]')).toBeNull()
  })

  it('names what each CDC control filters, in words', async () => {
    const { view } = await votingPage()
    box(view).dispatch('focusin')
    await until(() => view.has('[data-testid=search-cdc]'))
    // The chip beside the filter reads "CDC-friendly" (4 November 2026); its name starts with those words and says what it filters.
    expect(view.text('[data-testid=list-cdc]')).toBe('CDC-friendly')
    const name = view.one('[data-testid=list-cdc]').attrs['aria-label'] || ''
    expect(name.startsWith('CDC-friendly')).toBe(true)
    expect(name).toContain('Eat and Drink')
    expect(view.text('[data-testid=search-cdc]')).toBe('Search CDC vouchers only')
  })
})

describe('"Added"', () => {
  // A place in the search is picked, then added (Darius, 4 November 2026): each row is a checkbox named by the place, ticked in ink,
  // and one "Add" at the foot adds the ticked ones. The "Added" button now belongs to the saved places only.
  it('is a checkbox named by the place, ticked in ink with no red, and "Add" at the foot counts the ticks', async () => {
    const { view } = await votingPage()
    const { VENUES } = await import('../mock/venues.js')
    const fresh = VENUES.filter((v) => v.category === 'eat')[5]
    planner.searchSlot.mockImplementation(async ({ slot }) => (slot.category === 'eat' ? [{ id: fresh.id, name: fresh.name, area: fresh.area, category: 'eat', walk: 4, unfit: '', verify: [], dietUnknown: [], cdc: false }] : []))
    box(view).dispatch('focusin')
    await until(() => view.has('[data-testid=search-panel]') && view.text('[data-testid=search-panel]').includes(fresh.name))
    const pick = () => view.one(`[data-testid="pick-${fresh.id}"]`)
    expect(pick().attrs.role).toBe('checkbox')
    expect(pick().attrs['aria-label']).toBe(fresh.name)
    expect(pick().attrs['aria-checked']).toBe('false')
    expect(view.one('[data-testid=add-picked]').attrs.disabled).toBeDefined()
    await view.click(pick())
    expect(pick().attrs['aria-checked']).toBe('true')
    expect(pick().closest('li').attrs.class).toContain('is-ticked')
    expect(pick().attrs.class).not.toContain('btn--primary')
    expect(view.text('[data-testid=add-picked]')).toBe('Add')
    expect(view.one('[data-testid=add-picked]').attrs.disabled).toBeUndefined()
  })

  it('draws its off state in the muted ink, which is 4.5:1 on white, not the grey of a switched-off button', () => {
    const source = readFileSync(new URL('../../views/PlannerView.vue', import.meta.url), 'utf8')
    const rule = source.match(/\.add-btn\.btn\.is-added:disabled \{[^}]*\}/)[0]
    expect(rule).toContain('color: var(--muted)')
    expect(rule).not.toContain('muted-soft')
    const tokens = readFileSync(new URL('../../styles/tokens.css', import.meta.url), 'utf8')
    const hex = tokens.match(/--muted:\s*(#[0-9a-fA-F]{6})/)[1]
    const lum = (h) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)).reduce((t, v, i) => t + v * [0.2126, 0.7152, 0.0722][i], 0)
    expect((1.05) / (lum(hex) + 0.05)).toBeGreaterThanOrEqual(4.5)
  })
})
