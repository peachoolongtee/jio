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
    await until(() => !!press(view, 'Finish and review'))
    return { ...t, id, view }
  }

  it('says in the dialog, before it is pressed, that it earns nothing, and does not promise coins', async () => {
    const { view } = await soloItinerary()
    await view.click(press(view, 'Finish and review'))
    await until(() => view.has('[data-testid="no-coins"]'))
    expect(view.text('[data-testid="no-coins"]')).toBe(NO_COINS.before)
    expect(view.text()).not.toContain('each for')
  })

  it('goes on to "How was it?", which says it earned nothing, and the page says so after it is finished', async () => {
    const t = await soloItinerary()
    const { view, api, id, router } = t
    const before = JSON.parse(api.storage.store['jio-demo-v1']).stats.ian.points
    await view.click(press(view, 'Finish and review'))
    await until(() => view.has('[data-testid="no-coins"]'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Yes, finish and review').at(-1))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/review`)
    // One screen at a time: the stand-in page has one body, which the next screen's mount empties.
    const leave = (screen) => {
      mounted.splice(mounted.indexOf(screen), 1)
      screen.unmount()
    }
    leave(view)
    // The review page, arrived at straight from finishing (the flag the push left in the history entry).
    vi.stubGlobal('window', { history: { state: { justFinished: true }, replaceState() {} } })
    const { default: ReviewView } = await import('@/views/ReviewView.vue')
    const review = await mountScreen(ReviewView, { plugins: [t.pinia, router], props: { id } })
    mounted.push(review)
    await until(() => review.has('[data-testid="review-finished"]'))
    expect(review.text('[data-testid="review-finished"]')).toBe(`Outing finished. ${NO_COINS.toast}`)
    leave(review)
    // The itinerary, opened again, says why no coins were paid.
    const again = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => again.has('[data-testid="no-coins-notice"]'))
    expect(again.text('[data-testid="no-coins-notice"]')).toBe(NO_COINS.done)
    expect(again.text()).not.toContain('points each to spend')
    expect(JSON.parse(api.storage.store['jio-demo-v1']).stats.ian.points).toBe(before)
  })

  it('still promises the coins to a group of two', async () => {
    const t = await setUp()
    const { id } = await t.api.startRoam({ areaId: 'bugis' })
    await t.api.inviteFriends(id, ['faith'])
    at('2026-10-17T14:30:00+08:00')
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => !!press(view, 'Finish and review'))
    await view.click(press(view, 'Finish and review'))
    await until(() => view.has('[data-testid="earns-coins"]'))
    expect(view.text('[data-testid="earns-coins"]')).toContain('each for 2 people')
    expect(view.has('[data-testid="no-coins"]')).toBe(false)
  })
})

describe('the radius slider', () => {
  // Voting, on a page with the slider (Faith's walkthrough, 30 October 2026: it replaced a row of chips).
  async function votingPage() {
    const t = await setUp()
    const { id } = await t.api.createSession({ title: 'Saturday', date: '2026-10-17', start: '16:00', end: '20:00' })
    await t.api.inviteFriends(id, ['jonathan'])
    await t.api.startSession(id)
    await t.api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await t.api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await t.api.useMeetingArea(id)
    const view = await draw(t, `/sessions/${id}/plan`, 'PlannerView', { id })
    await until(() => view.has('input[type=range]'))
    return { ...t, id, view }
  }
  const slider = (view) => view.one('input[type=range]')

  it('runs from Auto to 3 km, says where it is, and saves only where it comes to rest', async () => {
    const { view, api, id } = await votingPage()
    expect(slider(view).attrs.min).toBe('0')
    expect(slider(view).attrs.max).toBe('6')
    expect(slider(view).attrs['aria-valuetext']).toBe('Auto')
    const calls = () => planner.rankSlot.mock.calls.filter(([args]) => args.radiusMeters).map(([args]) => args.radiusMeters)
    const before = calls().length
    // Dragged through 250 m to 1 km: the words follow at once, and only 1 km is asked for.
    view.type('input[type=range]', '2')
    await view.tick()
    expect(slider(view).attrs['aria-valuetext']).toBe('Within 250 m')
    view.type('input[type=range]', '4')
    await view.tick()
    expect(slider(view).attrs['aria-valuetext']).toBe('Within 1 km')
    await until(() => calls().length > before)
    expect(calls().slice(before).every((m) => m === 1000)).toBe(true)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await api.getSession(id)).radius).toBe(1000)
    expect(view.text()).not.toContain('Auto starts at 500 m')
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
    await until(() => view.has('input[type=range]'))
    expect(view.text()).not.toContain('were cleared')
    view.type('input[type=range]', '2')
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

