// The screens touched by the review of pull request #152, drawn for real (domless.js) on the stand-in planner (planFixture.js):
// finishing an outing of one person (the dialog, the toast and the notice say it earns nothing), the radius chips that stay
// focusable while a change runs, and the create form late at night. The maps need a browser and are stood in for.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'
import { NO_COINS } from '../session.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const at = (iso) => vi.setSystemTime(new Date(iso))
const mounted = []

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
beforeEach(() => {
  stubPlanner(planner)
  at('2026-10-17T14:20:00+08:00')
})
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})
afterAll(() => {
  vi.useRealTimers()
})

// The app's stores and router (stand-in screens), signed in as a new local account.
// How to call: const t = await setUp()
async function setUp() {
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
  return { api, pinia, router }
}

// Draw a screen after the router has opened `path`.
// How to call: const view = await draw(t, '/sessions/s1/itinerary', 'EventView', { id: 's1' })
async function draw(t, path, name, props = {}) {
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await t.router.push(path)
  const { default: screen } = await import(`@/views/${name}.vue`)
  const view = await mountScreen(screen, { plugins: [t.pinia, t.router], props })
  mounted.push(view)
  return view
}
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))

describe('finishing an outing of one person', () => {
  async function soloItinerary() {
    const t = await setUp()
    const { id } = await t.api.startRoam({ areaId: 'bugis' })
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => !!press(view, 'Finish outing'))
    return { ...t, id, view }
  }

  it('says in the dialog, before it is pressed, that it earns nothing, and does not promise coins', async () => {
    const { view } = await soloItinerary()
    await view.click(press(view, 'Finish outing'))
    await until(() => view.has('[data-testid="no-coins"]'))
    expect(view.text('[data-testid="no-coins"]')).toBe(NO_COINS.before)
    expect(view.text()).not.toContain('each for')
  })

  it('says in the toast and on the page that it earned nothing, after it is finished', async () => {
    const { view, api } = await soloItinerary()
    const before = JSON.parse(api.storage.store['jio-demo-v1']).stats.ian.points
    await view.click(press(view, 'Finish outing'))
    await until(() => view.has('[data-testid="no-coins"]'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Finish outing').at(-1))
    await until(() => view.text().includes(`Completed · ${NO_COINS.toast}`))
    await until(() => view.has('[data-testid="no-coins-notice"]'))
    expect(view.text('[data-testid="no-coins-notice"]')).toBe(NO_COINS.done)
    expect(view.text()).not.toContain('points each to spend')
    expect(JSON.parse(api.storage.store['jio-demo-v1']).stats.ian.points).toBe(before)
  })

  it('still promises the coins to a group of two', async () => {
    const t = await setUp()
    const { id } = await t.api.startRoam({ areaId: 'bugis' })
    await t.api.inviteFriends(id, ['faith'])
    at('2026-10-17T14:30:00+08:00')
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => !!press(view, 'Finish outing'))
    await view.click(press(view, 'Finish outing'))
    await until(() => view.has('[data-testid="earns-coins"]'))
    expect(view.text('[data-testid="earns-coins"]')).toContain('each for 2 people')
    expect(view.has('[data-testid="no-coins"]')).toBe(false)
  })
})

describe('the radius chips', () => {
  // Voting, with a planner that answers the radius only when told to.
  async function votingPage(release) {
    const t = await setUp()
    const { id } = await t.api.createSession({ title: 'Saturday', date: '2026-10-17', start: '16:00', end: '20:00' })
    await t.api.inviteFriends(id, ['jonathan'])
    await t.api.startSession(id)
    await t.api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await t.api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await t.api.useMeetingArea(id)
    const answer = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      if (args.radiusMeters) await release.promise
      return answer(args)
    })
    const view = await draw(t, `/sessions/${id}/plan`, 'PlannerView', { id })
    await until(() => view.has('[data-testid="radius"]') && chips(view).length === 7)
    return { ...t, id, view }
  }
  // Only the radius chips: the category filter above them is a set of radio chips too.
  const LABELS = ['Auto', '100 m', '250 m', '500 m', '1 km', '2 km', '3 km']
  const chips = (view) => view.all('[role="radio"]').filter((chip) => LABELS.includes(view.text(chip)))

  it('stay enabled and focusable while a change runs, say they are busy, and ignore presses meanwhile', async () => {
    let open
    const release = { promise: new Promise((resolve) => (open = resolve)) }
    const { view, api, id } = await votingPage(release)
    const calls = () => planner.rankSlot.mock.calls.filter(([args]) => args.radiusMeters).length
    // The row is a named radio group (one Tab stop and the arrow keys come from v-radio-group, tested with the directive).
    expect(view.all('[role="radiogroup"]').some((group) => group.attrs['aria-labelledby'] === 'radius-label')).toBe(true)
    expect(view.text('#radius-label')).toBe('Search within')
    const second = chips(view).find((chip) => view.text(chip) === '250 m')
    await view.click(second)
    await until(() => second.attrs['aria-disabled'] === 'true')
    // Not disabled: a disabled button drops the keyboard focus the person is on.
    for (const chip of chips(view)) {
      expect(chip.disabled, view.text(chip)).toBe(false)
      expect(chip.attrs['aria-disabled'], view.text(chip)).toBe('true')
    }
    // A press while the change runs does nothing more.
    const asked = calls()
    await view.click(chips(view).find((chip) => view.text(chip) === '1 km'))
    expect(calls()).toBe(asked)
    open()
    await until(() => chips(view).every((chip) => chip.attrs['aria-disabled'] === undefined))
    expect((await api.getSession(id)).radius).toBe(250)
  })
})

describe('a radius change that clears votes', () => {
  it('says so on the voting page, in the words, and the notice can be dismissed', async () => {
    const t = await setUp()
    const { id } = await t.api.createSession({ title: 'Saturday', date: '2026-10-17', start: '16:00', end: '20:00' })
    await t.api.inviteFriends(id, ['jonathan'])
    await t.api.startSession(id)
    await t.api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await t.api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await t.api.useMeetingArea(id)
    const { slots } = await t.api.getPlan(id)
    const eat = slots.find((s) => s.category === 'eat')
    await t.api.vote(id, eat.id, 'ian', eat.options[2].id)
    // With a radius set, only the first place of a category fits.
    const answer = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      const ranked = await answer(args)
      if (!args.radiusMeters) return ranked
      return { ...ranked, options: ranked.options.slice(0, 1), current: ranked.current.filter((o) => o.venue.id === ranked.options[0].venue.id) }
    })
    const view = await draw(t, `/sessions/${id}/plan`, 'PlannerView', { id })
    await until(() => view.has('[data-testid="radius"]') && view.all('[role="radio"]').some((chip) => view.text(chip) === '250 m'))
    expect(view.text()).not.toContain('were cleared')
    await view.click(view.all('[role="radio"]').find((chip) => view.text(chip) === '250 m'))
    await until(() => view.text().includes('Votes for places outside the new ring were cleared.'))
    expect(view.errors).toEqual([])
    await view.click(view.one('button[aria-label="Dismiss"]'))
    await until(() => !view.text().includes('were cleared'))
  })
})

describe('the create form late at night', () => {
  async function form() {
    const t = await setUp()
    const view = await draw(t, '/sessions/new', 'CreateEventView')
    await until(() => view.has('input'))
    return view
  }
  const next = (view) => view.all('button').find((b) => view.text(b).includes('Next'))

  it('has tomorrow as the day at 23:30, so a title is all that is left to choose', async () => {
    at('2026-10-17T23:30:00+08:00')
    const view = await form()
    expect(next(view).disabled).toBe(true)
    view.type('input', 'Late supper')
    await view.tick()
    expect(next(view).disabled).toBe(false)
  })

  it('holds Next when 23:59 would otherwise produce a zero-length session', async () => {
    at('2026-10-17T23:30:00+08:00')
    const view = await form()
    view.type('input', 'Late supper')
    const start = view.all('.tp__input')[0]
    start.value = '23:59'
    start.dispatch('input')
    start.dispatch('blur')
    await view.tick()
    expect(view.text()).toContain('End time must be after the start time.')
    expect(next(view).disabled).toBe(true)
  })

  it('holds Next when the selected start time has already passed in Singapore', async () => {
    at('2026-10-17T08:20:00Z') // 16:20 in Singapore
    const view = await form()
    await view.click('[data-day="2026-10-17"]')
    view.type('input', 'Afternoon tea')
    const start = view.all('.tp__input')[0]
    start.value = '16:00'
    start.dispatch('input')
    start.dispatch('blur')
    await view.tick()
    expect(view.text()).toContain('That start time has already passed today.')
    expect(next(view).disabled).toBe(true)
    // The sentence is the start time's own note, not the end time's.
    const [startInput, endInput] = view.all('.tp__input')
    const note = view.all('p[role="alert"]').find((p) => view.text(p) === 'That start time has already passed today.')
    expect(startInput.attrs['aria-describedby']).toBe(note.attrs.id)
    expect(startInput.attrs['aria-invalid']).toBe('true')
    expect(endInput.attrs['aria-invalid']).toBeUndefined()
  })

  it('reads the clock in Singapore, not in the browser\'s zone: at 00:30 on the 18th there the 17th has gone and the form starts at 01:00', async () => {
    at('2026-10-17T16:30:00Z')
    const view = await form()
    expect(view.all('.tp__input')[0].value).toBe('01:00')
    view.type('input', 'Supper')
    await view.tick()
    // At 00:30 no day is preset (only 23:00 to midnight presets tomorrow), so Next waits for one.
    expect(next(view).disabled).toBe(true)
  })

  it('leaves the day to be chosen at 14:20, as before', async () => {
    const view = await form()
    view.type('input', 'Afternoon tea')
    await view.tick()
    expect(next(view).disabled).toBe(true)
  })
})

describe('editing a session whose start has passed', () => {
  // A session made at 14:20 for 15:00 to 18:00 that day; then it is 16:00 and the start has passed, with the session still inviting.
  async function editForm() {
    const t = await setUp()
    const { id } = await t.api.createSession({ title: 'Saturday', date: '2026-10-17', start: '15:00', end: '18:00' })
    at('2026-10-17T16:00:00+08:00')
    const view = await draw(t, `/sessions/${id}/edit`, 'CreateEventView', { id })
    await until(() => view.has('input') && view.all('input')[0].value === 'Saturday')
    return { ...t, id, view }
  }
  const next = (view) => view.all('button').find((b) => view.text(b).includes('Next'))

  it('lets the title change alone, with no complaint about the start that has passed', async () => {
    const { view, api, id, router } = await editForm()
    expect(view.text()).not.toContain('has already passed today')
    expect(next(view).disabled).toBe(false)
    view.type('input', 'Saturday tea')
    await view.tick()
    await view.click(next(view))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/invite`)
    expect(await api.getSession(id)).toMatchObject({ title: 'Saturday tea', date: '2026-10-17', start: '15:00', end: '18:00' })
  })

  it('still refuses a new start that has passed, under the start time', async () => {
    const { view } = await editForm()
    const start = view.all('.tp__input')[0]
    start.value = '15:30'
    start.dispatch('input')
    start.dispatch('blur')
    await view.tick()
    expect(view.text()).toContain('That start time has already passed today.')
    expect(next(view).disabled).toBe(true)
    start.value = '16:30'
    start.dispatch('input')
    start.dispatch('blur')
    await view.tick()
    expect(view.text()).not.toContain('has already passed today')
    expect(next(view).disabled).toBe(false)
  })
})

