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

  it('starts on Auto with the slider off; turned off, the slider runs from 100 m to 3 km and saves only where it comes to rest', async () => {
    const { view, api, id } = await votingPage()
    const auto = () => view.one('[role=switch]')
    // Auto is on, and the slider waits for it (Faith, 31 October 2026).
    expect(auto().attrs['aria-checked']).toBe('true')
    expect(slider(view).attrs.disabled).toBeDefined()
    expect(slider(view).attrs.min).toBe('0')
    expect(slider(view).attrs.max).toBe('5')
    expect(slider(view).attrs['aria-valuetext']).toBe('Auto')
    // Turned off: 1 km to start with, saved at once.
    await view.click(auto())
    await until(async () => (await api.getSession(id)).radius === 1000)
    expect(auto().attrs['aria-checked']).toBe('false')
    expect(slider(view).attrs.disabled).toBeUndefined()
    expect(slider(view).attrs['aria-valuetext']).toBe('Within 1 km')
    const calls = () => planner.rankSlot.mock.calls.filter(([args]) => args.radiusMeters).map(([args]) => args.radiusMeters)
    const before = calls().length
    // Dragged through 250 m to 2 km: the words follow at once, and only 2 km is asked for.
    view.type('input[type=range]', '1')
    await view.tick()
    expect(slider(view).attrs['aria-valuetext']).toBe('Within 250 m')
    view.type('input[type=range]', '4')
    await view.tick()
    expect(slider(view).attrs['aria-valuetext']).toBe('Within 2 km')
    await until(() => calls().slice(before).includes(2000))
    expect(calls().slice(before)).not.toContain(250)
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect((await api.getSession(id)).radius).toBe(2000)
    // On again: back to Auto.
    await view.click(auto())
    await until(async () => (await api.getSession(id)).radius == null)
    expect(slider(view).attrs['aria-valuetext']).toBe('Auto')
  })
})

describe('the search panel, the CDC filters and the one widen line (Faith, 31 October 2026)', () => {
  async function votingPage() {
    const t = await setUp()
    const { id } = await t.api.createSession({ title: 'Saturday', date: '2026-10-17', start: '16:00', end: '20:00' })
    await t.api.inviteFriends(id, ['jonathan'])
    await t.api.startSession(id)
    await t.api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await t.api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await t.api.useMeetingArea(id)
    const view = await draw(t, `/sessions/${id}/plan`, 'PlannerView', { id })
    await until(() => view.has('article[data-option]'))
    return { ...t, id, view }
  }
  const names = (view) => view.all('article[data-option]').map((a) => a.attrs['aria-label'])

  it('opens suggestions with the CDC toggle on top when the box is clicked, and the toggle asks for CDC places in both', async () => {
    const { view } = await votingPage()
    planner.searchSlot.mockImplementation(async ({ slot, query, cdcOnly, browse }) => [
      { id: `${slot.category}-${query || 'near'}${cdcOnly ? '-cdc' : ''}`, name: `${browse ? 'Near' : 'Found'} ${slot.category}${cdcOnly ? ' CDC' : ''}`, area: 'Bishan', category: slot.category, walk: 3, unfit: '', verify: [], dietUnknown: [], cdc: !!cdcOnly },
    ])
    expect(view.has('[data-testid=search-panel]')).toBe(false)
    const box = () => view.one('[data-testid=place-search]').querySelector('input')
    box().dispatch('focusin')
    await until(() => view.has('[data-testid=search-panel]') && view.text('[data-testid=search-panel]').includes('Near eat'))
    expect(view.text('[data-testid=search-panel]')).toContain('Suggested near')
    expect(planner.searchSlot.mock.calls.at(-1)[0]).toMatchObject({ query: '', browse: true, cdcOnly: false })
    await view.click(view.one('[data-testid=search-cdc]'))
    await until(() => view.text('[data-testid=search-panel]').includes('Near eat CDC'))
    expect(view.text('[data-testid=search-panel]')).toContain('CDC vouchers')
    view.type('input[type=search]', 'kopi')
    await until(() => view.text('[data-testid=search-panel]').includes('Found eat CDC'))
    expect(planner.searchSlot.mock.calls.at(-1)[0]).toMatchObject({ query: 'kopi', cdcOnly: true, browse: false })
  })

  it('leaves places the group has out of the suggestions; Added can be pressed to take back; a refusal is said on its own row', async () => {
    const { view } = await votingPage()
    const { VENUES } = await import('../mock/venues.js')
    const eats = VENUES.filter((v) => v.category === 'eat')
    const [have, fresh, refused] = [eats[0], eats[5], eats[6]]
    const row = (v) => ({ id: v.id, name: v.name, area: v.area, category: 'eat', walk: 4, unfit: '', verify: [], dietUnknown: [], cdc: false })
    planner.searchSlot.mockImplementation(async ({ slot, currentOptionIds = [] }) => (slot.category === 'eat' ? [{ ...row(have) }, { ...row(fresh) }, { ...row(refused) }] : []))
    // The planner takes `fresh` when it is added, and never `refused`.
    const rank = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      const out = await rank(args)
      out.current = out.current.filter((o) => o.venue.id !== refused.id)
      return out
    })
    view.one('[data-testid=place-search]').querySelector('input').dispatch('focusin')
    await until(() => view.has('[data-testid=search-panel]') && view.text('[data-testid=search-panel]').includes(fresh.name))
    // Already one of the places: not suggested.
    expect(view.text('[data-testid=search-panel]')).not.toContain(have.name)
    const button = (name) => view.all('button').find((b) => b.attrs['aria-label'] === `Add ${name}` || b.attrs['aria-label'] === `Take back ${name}`)
    await view.click(button(fresh.name))
    await until(() => button(fresh.name)?.attrs['aria-label'] === `Take back ${fresh.name}`)
    expect(view.text(button(fresh.name))).toBe('Added')
    await until(() => names(view).includes(fresh.name))
    // Pressed again, it is taken back, and stays in the list to add again.
    await view.click(button(fresh.name))
    await until(() => button(fresh.name)?.attrs['aria-label'] === `Add ${fresh.name}`)
    await until(() => !names(view).includes(fresh.name))
    // A place the planner will not take says why on its own row, not at the top of the page.
    await view.click(button(refused.name))
    await until(() => view.all('[role=alert]').some((a) => view.text(a).includes('does not fit this slot')))
    const note = view.all('[role=alert]').find((a) => view.text(a).includes('does not fit this slot'))
    expect(note.closest('li')).toBeTruthy()
    expect(view.text(note.closest('li'))).toContain(refused.name)
  })

  it('says when Google did not answer, so a place missing from the search is not taken as not there', async () => {
    const { view } = await votingPage()
    planner.searchSlot.mockImplementation(async () => Object.assign([], { google: 'unavailable' }))
    view.one('[data-testid=place-search]').querySelector('input').dispatch('focusin')
    view.type('input[type=search]', 'chagee')
    await until(() => view.has('[data-testid=google-down]'))
    expect(view.text('[data-testid=google-down]')).toContain("Google isn't answering right now")
    planner.searchSlot.mockImplementation(async () => Object.assign([], { google: 'google' }))
    view.type('input[type=search]', 'chagee pl')
    await until(() => !view.has('[data-testid=google-down]'))
  })

  it('shows a vote at once in a session of this browser, while the planner is still slow to rank again', async () => {
    const { view } = await votingPage()
    // From now on the planner takes 3 seconds to answer.
    const rank = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      await new Promise((resolve) => setTimeout(resolve, 3000))
      return rank(args)
    })
    const voteButton = view.all('button').find((b) => view.text(b) === 'Vote')
    const card = voteButton.closest('article')
    await view.click(voteButton)
    // Well before the planner answers (the wait is counted in turns, as the date is frozen here), the card says so.
    await until(() => view.text(card).includes('Voted'), 1000)
  })

  it('"CDC vouchers" beside the filter keeps only the Eat and Drink places that take them, and leaves Shop and Activity', async () => {
    const { view } = await votingPage()
    const before = names(view)
    expect(before).toContain('Plain Vanilla Tiong Bahru')
    await view.click(view.one('[data-testid=list-cdc]'))
    await view.tick()
    const after = names(view)
    // Eat keeps its two CDC places; Drink has none, and says so; Shop and Activity are as they were.
    expect(after).toEqual(expect.arrayContaining(["Tiong Bahru Market and Food Centre", "Loo's Hainanese Curry Rice", 'VivoCity', 'Henderson Waves']))
    expect(after).not.toContain('Plain Vanilla Tiong Bahru')
    expect(after).not.toContain('Forty Hands')
    expect(view.text()).toContain('1 other is hidden')
    expect(view.text()).toContain('None of these Drink places take CDC vouchers.')
    await view.click(view.one('[data-testid=list-cdc]'))
    await view.tick()
    expect(names(view)).toEqual(before)
  })

  it('says once which categories are short of places, with one "Widen to" far enough for all of them', async () => {
    const t = await setUp()
    planner.rankSlot.mockImplementation(async ({ slot }) => {
      const { VENUES } = await import('../mock/venues.js')
      const one = VENUES.filter((v) => v.category === slot.category).slice(0, slot.category === 'eat' ? 3 : 1)
      const few = { drink: { found: 1, widenToKm: 1.5 }, activity: { found: 1, widenToKm: 2.6 }, shop: { found: 1, widenToKm: 0.8 } }[slot.category] || null
      return { options: one.map((venue, i) => ({ venue, rank: i + 1, score: i, walk: 5, crowd: 'quiet', reasons: [], warnings: [], swap: null, explanation: '', dietUnknown: [], verify: [], approximate: false })), current: [], widened: false, few, empty: null }
    })
    const { id } = await t.api.createSession({ title: 'Saturday', date: '2026-10-17', start: '16:00', end: '20:00' })
    await t.api.inviteFriends(id, ['jonathan'])
    await t.api.startSession(id)
    await t.api.setLocation(id, 'ian', 'start', { areaId: 'tampines' })
    await t.api.setLocation(id, 'jonathan', 'start', { areaId: 'jurong-east' })
    await t.api.useMeetingArea(id)
    await t.api.setRadius(id, 250)
    const view = await draw(t, `/sessions/${id}/plan`, 'PlannerView', { id })
    await until(() => view.has('[data-testid=radius-short]'))
    expect(view.text('[data-testid=radius-short]')).toContain('Few places within 250 m for Drink, Shop and Activity.')
    expect(view.all('button').filter((b) => view.text(b).startsWith('Widen to')).map((b) => view.text(b))).toEqual(['Widen to 3 km'])
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
    // Saving the edit of a session that is still inviting goes on to the Start choice (how to pick the meeting point), which comes before inviting.
    await until(() => router.currentRoute.value.path === `/sessions/${id}/start`)
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

