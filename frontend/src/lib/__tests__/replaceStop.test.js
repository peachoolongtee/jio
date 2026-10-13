// Replacing one stop of a confirmed plan: the data layer's two calls (the places that could take a stop's place, and the
// swap itself), then the itinerary's Replace button and the voting page's replace mode drawn for real (domless.js) on a
// stand-in planner (planFixture.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { VENUES } from '../mock/venues.js'
import { STORAGE_KEY, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), arrangeItinerary: vi.fn(), lastWeather: { value: null } }))
vi.mock('../plannerApi.js', () => planner)
// The map needs a browser (Leaflet); the screens' own logic is what is under test.
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))

// Drawing a screen compiles its templates the first time, which is slow on a busy machine.
vi.setConfig({ testTimeout: 20000 })

// Every screen a test draws, closed after the test, so a page left open never asks the planner during a later test.
const mounted = []
beforeEach(() => stubPlanner(planner))
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})

const eatVenues = VENUES.filter((v) => v.category === 'eat')
// The stand-in planner's answer for a slot is the first three places of its category, so the fourth is not suggested.
const notSuggested = eatVenues[3]

// The stop of the itinerary for a category.
// How to call: stopOf(itinerary, 'eat') -> { slotId, venue, start, ... }
const stopOf = (itinerary, category) => itinerary.stops.find((s) => s.category === category)

describe('the places that could replace a stop (data layer)', () => {
  it('lists the other places that fit the stop, voted ones first with their votes, never the stop itself', async () => {
    const { api, id } = await loadConfirmed()
    const eat = stopOf(await api.getItinerary(id), 'eat')
    const { stop, options } = await api.replaceChoices(id, eat.slotId)
    expect(stop).toMatchObject({ slotId: eat.slotId, category: 'eat', duration: eat.duration })
    expect(stop.venue.id).toBe(eat.venue.id)
    expect(options.map((o) => o.id)).not.toContain(eat.venue.id)
    expect(options.length).toBeGreaterThan(0)
    expect(options.every((o) => o.venue.category === 'eat')).toBe(true)
    // Nobody voted for the others, so each has 0 votes and the planner's order.
    expect(options.every((o) => o.votes === 0 && o.swap === null)).toBe(true)
    expect(options.map((o) => o.score)).toEqual([...options.map((o) => o.score)].sort((a, b) => a - b))
  })

  it('asks the planner about the stop at the time it has in the itinerary now, after a move', async () => {
    const { api, id } = await loadConfirmed()
    await api.reorderStops(id, 0, 1)
    const eat = stopOf(await api.getItinerary(id), 'eat')
    planner.rankSlot.mockClear()
    await api.replaceChoices(id, eat.slotId)
    const asked = planner.rankSlot.mock.calls[0][0]
    expect(asked.slot).toMatchObject({ category: 'eat', duration: eat.duration, start: eat.start })
    expect(asked.slot.time).toMatch(/^\d{2}:\d{2}$/)
    // The eat stop is last after the move, so the planner is told so.
    expect(asked.lastStop).toBe(true)
  })

  it('refuses a session that is not confirmed, and a stop that is not in the plan', async () => {
    const { api, id } = await loadConfirmed()
    await expect(api.replaceChoices(id, 'drink')).rejects.toThrow('no longer in the plan')
    await api.replan(id)
    await expect(api.replaceChoices(id, 'eat')).rejects.toThrow('Only a confirmed plan')
  })
})

describe('replacing a stop (data layer)', () => {
  it('puts the new place in the stop, at the same time, and leaves the other stop and the votes alone', async () => {
    const { api, id } = await loadConfirmed()
    const before = await api.getItinerary(id)
    const eat = stopOf(before, 'eat')
    const other = before.stops.find((s) => s.category !== 'eat')
    const votesBefore = (await api.getSession(id)).votes
    const { options } = await api.replaceChoices(id, eat.slotId)
    await api.replaceStop(id, eat.slotId, options[0].id)
    const after = await api.getItinerary(id)
    expect(stopOf(after, 'eat')).toMatchObject({ start: eat.start, duration: eat.duration })
    expect(stopOf(after, 'eat').venue.id).toBe(options[0].id)
    expect(after.stops.find((s) => s.category !== 'eat').venue.id).toBe(other.venue.id)
    expect(after.stops.map((s) => s.slotId)).toEqual(before.stops.map((s) => s.slotId))
    const session = await api.getSession(id)
    expect(session.status).toBe('confirmed')
    expect(session.votes).toEqual(votesBefore)
  })

  it('refuses a place that does not fit the stop, and changes nothing', async () => {
    const { api, id } = await loadConfirmed()
    const itinerary = await api.getItinerary(id)
    const eat = stopOf(itinerary, 'eat')
    // An Activity place, offered for the Eat stop as Eat: the planner does not list it.
    const activity = VENUES.find((v) => v.category === 'activity' && v.id !== stopOf(itinerary, 'activity').venue.id)
    await expect(api.replaceStop(id, eat.slotId, activity.id)).rejects.toThrow('does not fit this stop')
    expect(stopOf(await api.getItinerary(id), 'eat').venue.id).toBe(eat.venue.id)
  })

  it('takes a place the planner did not suggest, when it fits', async () => {
    const { api, id } = await loadConfirmed()
    const eat = stopOf(await api.getItinerary(id), 'eat')
    await api.replaceStop(id, eat.slotId, notSuggested.id)
    expect(stopOf(await api.getItinerary(id), 'eat').venue.id).toBe(notSuggested.id)
  })

  it('puts the travel to and from the stop back to its default, and drops the note about the order', async () => {
    const { api, id } = await loadConfirmed()
    const before = await api.getItinerary(id)
    const leg = before.legs[0]
    // The leg's options are its minutes by mode ({ walk: 12, mrt: 9, car: 6 }).
    const other = Object.keys(leg.options).find((mode) => mode !== leg.mode)
    await api.setTravelMode(id, 0, other)
    expect((await api.getItinerary(id)).legs[0].mode).toBe(other)
    const second = before.stops[1]
    const { options } = await api.replaceChoices(id, second.slotId)
    await api.replaceStop(id, second.slotId, options[0].id)
    const after = await api.getItinerary(id)
    expect(after.legs[0].mode).toBe(leg.mode)
    expect(after.aiNote).toBeNull()
  })

  it('does nothing when the place is already the stop, and refuses once the plan is not confirmed', async () => {
    const { api, id } = await loadConfirmed()
    const eat = stopOf(await api.getItinerary(id), 'eat')
    planner.rankSlot.mockClear()
    await api.replaceStop(id, eat.slotId, eat.venue.id)
    expect(planner.rankSlot).not.toHaveBeenCalled()
    await api.endPlan(id)
    await expect(api.replaceStop(id, eat.slotId, notSuggested.id)).rejects.toThrow('Only a confirmed plan')
  })

  it('is kept over a page reload', async () => {
    const { api, id } = await loadConfirmed()
    const eat = stopOf(await api.getItinerary(id), 'eat')
    await api.replaceStop(id, eat.slotId, notSuggested.id)
    const again = await loadApi({ data: { [STORAGE_KEY]: api.storage.store[STORAGE_KEY] } })
    expect(stopOf(await again.getItinerary(id), 'eat').venue.id).toBe(notSuggested.id)
  })
})

// ── The screens ──

// The app's stores and router (stand-in screens) on top of the confirmed save, signed in as its local account.
// How to call: const t = await setUp()
async function setUp() {
  const { api, id } = await loadConfirmed()
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const { installGuard } = await import('@/router/guard.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  installGuard(router)
  return { api, id, pinia, router }
}

// Draw a screen after the router has opened `path`.
// How to call: const view = await draw(t, `/sessions/${t.id}/itinerary`, 'EventView')
async function draw(t, path, name) {
  // The itinerary reads the browser's history entry for a "Plan confirmed" card; this one has none.
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await t.router.push(path)
  const { default: screen } = await import(`@/views/${name}.vue`)
  const view = await mountScreen(screen, { plugins: [t.pinia, t.router], props: { id: t.id } })
  mounted.push(view)
  return view
}
const errorsOf = (view) => view.errors.map((e) => String(e?.stack || e).slice(0, 300))

describe('the itinerary', () => {
  it('has Replace on every stop only in edit mode, which opens the voting page for that stop', async () => {
    const t = await setUp()
    const eat = stopOf(await t.api.getItinerary(t.id), 'eat')
    const view = await draw(t, `/sessions/${t.id}/itinerary`, 'EventView')
    await until(() => view.has('.stop__name') || view.text().includes(eat.venue.name))
    expect(view.has(`[data-testid="replace-${eat.slotId}"]`)).toBe(false)
    await view.click('button[aria-label="Edit itinerary"]')
    await until(() => view.has(`[data-testid="replace-${eat.slotId}"]`))
    expect(view.one(`[data-testid="replace-${eat.slotId}"]`).attrs['aria-label']).toBe(`Replace stop: ${eat.venue.name}`)
    await view.click(`[data-testid="replace-${eat.slotId}"]`)
    await until(() => t.router.currentRoute.value.path === `/sessions/${t.id}/plan`)
    expect(t.router.currentRoute.value.query.replace).toBe(eat.slotId)
    expect(errorsOf(view)).toEqual([])
  })

  it('offers Replace even when the plan has one stop left, but not Delete', async () => {
    const t = await setUp()
    await t.api.deleteStop(t.id, 1)
    const only = (await t.api.getItinerary(t.id)).stops[0]
    const view = await draw(t, `/sessions/${t.id}/itinerary`, 'EventView')
    await until(() => view.text().includes(only.venue.name))
    await view.click('button[aria-label="Edit itinerary"]')
    await until(() => view.has(`[data-testid="replace-${only.slotId}"]`))
    expect(view.has(`button[aria-label="Delete stop: ${only.venue.name}"]`)).toBe(false)
  })
})

describe('the voting page, replacing a stop', () => {
  it('shows the stop being replaced and the other places, each with Use this place, and no voting', async () => {
    const t = await setUp()
    const eat = stopOf(await t.api.getItinerary(t.id), 'eat')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${eat.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    expect(view.text('[data-testid="replace-view"]')).toContain(eat.venue.name)
    expect(view.text('[data-testid="replace-view"]')).toMatch(/Eat at \d{2}:\d{2} · \d+ min/)
    const uses = view.all('button').filter((b) => (b.attrs['aria-label'] || '').endsWith(' instead'))
    expect(uses.length).toBeGreaterThan(0)
    expect(view.text(uses[0])).toBe('Use this place')
    // The stop's own place is not offered, and there is nothing to vote on or confirm.
    expect(uses.map((b) => b.attrs['aria-label'])).not.toContain(`Use ${eat.venue.name} instead`)
    expect(view.all('button').some((b) => /^(Vote|Voted)$/.test(view.text(b)))).toBe(false)
    expect(view.text()).not.toContain('Confirm plan')
    expect(view.text('[data-testid="keep-stop"]')).toBe(`Keep ${eat.venue.name}`)
    expect(errorsOf(view)).toEqual([])
  })

  it('swaps the chosen place into the itinerary and goes back to it', async () => {
    const t = await setUp()
    const eat = stopOf(await t.api.getItinerary(t.id), 'eat')
    const { options } = await t.api.replaceChoices(t.id, eat.slotId)
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${eat.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    const use = view.all('button').find((b) => b.attrs['aria-label'] === `Use ${options[0].venue.name} instead`)
    await view.click(use)
    await until(() => t.router.currentRoute.value.path === `/sessions/${t.id}/itinerary`)
    expect(stopOf(await t.api.getItinerary(t.id), 'eat').venue.id).toBe(options[0].id)
    expect(errorsOf(view)).toEqual([])
  })

  it('goes back with Keep and changes nothing', async () => {
    const t = await setUp()
    const eat = stopOf(await t.api.getItinerary(t.id), 'eat')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${eat.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    await view.click('[data-testid="keep-stop"]')
    await until(() => t.router.currentRoute.value.path === `/sessions/${t.id}/itinerary`)
    expect(stopOf(await t.api.getItinerary(t.id), 'eat').venue.id).toBe(eat.venue.id)
  })

  it('says why when the place no longer fits, keeps the stop, and lists the places again', async () => {
    const t = await setUp()
    const eat = stopOf(await t.api.getItinerary(t.id), 'eat')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${eat.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    // From now on the planner says nothing fits.
    planner.rankSlot.mockImplementation(async () => ({ options: [], current: [], widened: false, few: null, empty: null }))
    const use = view.all('button').find((b) => (b.attrs['aria-label'] || '').endsWith(' instead'))
    await view.click(use)
    await until(() => view.has('[data-testid="replace-error"]'))
    expect(view.text('[data-testid="replace-error"]')).toContain('does not fit this stop')
    expect(t.router.currentRoute.value.path).toBe(`/sessions/${t.id}/plan`)
    await until(() => view.text().includes('Nothing else fits'))
    expect(stopOf(await t.api.getItinerary(t.id), 'eat').venue.id).toBe(eat.venue.id)
  })

  it('shows the usual voting page when the session is not confirmed', async () => {
    const t = await setUp()
    await t.api.replan(t.id)
    const view = await draw(t, `/sessions/${t.id}/plan?replace=eat`, 'PlannerView')
    await until(() => /Confirm plan|Needs 2 voters/.test(view.text()))
    expect(view.has('[data-testid="replace-view"]')).toBe(false)
    expect(errorsOf(view)).toEqual([])
  })
})

describe('replacing a stop with another category (data layer)', () => {
  it('lists places of the chosen category for the stop, at its time, and never one already in the plan', async () => {
    const { api, id } = await loadConfirmed()
    const itinerary = await api.getItinerary(id)
    const activity = stopOf(itinerary, 'activity')
    const eat = stopOf(itinerary, 'eat')
    planner.rankSlot.mockClear()
    const drink = await api.replaceChoices(id, activity.slotId, 'drink')
    expect(drink.category).toBe('drink')
    expect(drink.stop).toMatchObject({ slotId: activity.slotId, category: 'activity' })
    expect(drink.options.length).toBeGreaterThan(0)
    expect(drink.options.every((o) => o.venue.category === 'drink' && o.votes === 0)).toBe(true)
    // The call for this stop (an earlier test's re-plan may still be ranking the voting page's categories).
    const asked = planner.rankSlot.mock.calls.map(([args]) => args.slot).find((slot) => slot.id === activity.slotId && slot.category === 'drink')
    expect(asked).toMatchObject({ start: activity.start, duration: activity.duration })
    // The Eat stop asked for Activity places: the Activity stop's own place is not offered.
    const instead = await api.replaceChoices(id, eat.slotId, 'activity')
    expect(instead.options.map((o) => o.id)).not.toContain(activity.venue.id)
  })

  it('turns the stop into the new category, with the same length and place in the plan’s order', async () => {
    const { api, id } = await loadConfirmed()
    const before = await api.getItinerary(id)
    const activity = stopOf(before, 'activity')
    const { options } = await api.replaceChoices(id, activity.slotId, 'drink')
    await api.replaceStop(id, activity.slotId, options[0].id, 'drink')
    const after = await api.getItinerary(id)
    const changed = after.stops.find((s) => s.slotId === activity.slotId)
    expect(changed).toMatchObject({ category: 'drink', duration: activity.duration })
    expect(changed.venue.id).toBe(options[0].id)
    expect(after.stops.map((s) => s.slotId)).toEqual(before.stops.map((s) => s.slotId))
    // The first stop keeps its time. A later stop starts when the travel from the stop before it ends, and the new
    // place is somewhere else, so its start may move by the difference in travel time.
    expect(after.stops[0].start).toBe(before.stops[0].start)
    expect(stopOf(after, 'activity')).toBeUndefined()
    // Replacing it again starts from its new category.
    const again = await api.replaceChoices(id, activity.slotId)
    expect(again.stop.category).toBe('drink')
    expect(again.category).toBe('drink')
  })

  it('refuses a place another stop already has, and a category that does not exist', async () => {
    const { api, id } = await loadConfirmed()
    const itinerary = await api.getItinerary(id)
    const eat = stopOf(itinerary, 'eat')
    const activity = stopOf(itinerary, 'activity')
    await expect(api.replaceStop(id, eat.slotId, activity.venue.id, 'activity')).rejects.toThrow('already in the plan')
    await expect(api.replaceChoices(id, eat.slotId, 'nap')).rejects.toThrow('Choose Eat, Drink, Shop or Activity.')
    expect(stopOf(await api.getItinerary(id), 'eat').venue.id).toBe(eat.venue.id)
  })
})

describe('the voting page, replacing with another category', () => {
  it('starts on the stop’s category, switches to another, says the stop will change, and saves it as that category', async () => {
    const t = await setUp()
    const activity = stopOf(await t.api.getItinerary(t.id), 'activity')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${activity.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    expect(view.one('[data-testid="replace-cat-activity"]').attrs['aria-checked']).toBe('true')
    expect(view.has('[data-testid="replace-change"]')).toBe(false)
    await view.click('[data-testid="replace-cat-drink"]')
    await until(() => view.has('[data-testid="replace-change"]') && view.has('[data-testid="replace-options"]'))
    expect(view.text('[data-testid="replace-change"]')).toMatch(/^This stop becomes Drink instead of Activity, at \d{2}:\d{2}\.$/)
    const { options } = await t.api.replaceChoices(t.id, activity.slotId, 'drink')
    const use = view.all('button').find((b) => b.attrs['aria-label'] === `Use ${options[0].venue.name} instead`)
    expect(use).toBeTruthy()
    await view.click(use)
    await until(() => t.router.currentRoute.value.path === `/sessions/${t.id}/itinerary`)
    const changed = (await t.api.getItinerary(t.id)).stops.find((s) => s.slotId === activity.slotId)
    expect(changed).toMatchObject({ category: 'drink' })
    expect(changed.venue.id).toBe(options[0].id)
    expect(errorsOf(view)).toEqual([])
  })

  it('goes back to the stop’s own category, and the note goes', async () => {
    const t = await setUp()
    const activity = stopOf(await t.api.getItinerary(t.id), 'activity')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${activity.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    await view.click('[data-testid="replace-cat-shop"]')
    await until(() => view.has('[data-testid="replace-change"]'))
    await view.click('[data-testid="replace-cat-activity"]')
    await until(() => !view.has('[data-testid="replace-change"]') && view.has('[data-testid="replace-options"]'))
    expect(errorsOf(view)).toEqual([])
  })

  it('says when no place of a category fits, and suggests another', async () => {
    const t = await setUp()
    const activity = stopOf(await t.api.getItinerary(t.id), 'activity')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${activity.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    planner.rankSlot.mockImplementation(async () => ({ options: [], current: [], widened: false, few: null, empty: null }))
    await view.click('[data-testid="replace-cat-shop"]')
    await until(() => view.text().includes('No Shop places fit'))
    expect(view.text()).toContain('Try another category')
  })
})

// Things that could go wrong that the tests above do not try: answers that come back late or for the wrong category,
// pressing twice, the planner failing, a stop that is not there, and a plan changed again after a stop was replaced.
describe('replacing a stop, under stress', () => {
  const eventsStore = async () => (await import('@/stores/events.js')).useEventsStore()
  const useButtons = (view) => view.all('button').filter((b) => (b.attrs['aria-label'] || '').endsWith(' instead'))
  // The planner's answer for a slot, `ms` later for the categories in `slow`.
  const slowFor = (slow, ms) => {
    const answer = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      if (slow.includes(args.slot.category)) await new Promise((r) => setTimeout(r, ms))
      return answer(args)
    })
  }

  it('never shows places of another category than the tab, even when the answer is for the wrong one', async () => {
    const t = await setUp()
    const activity = stopOf(await t.api.getItinerary(t.id), 'activity')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${activity.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    // As an events store from before the tabs did: the category is dropped, so the stop's own places come back.
    const store = await eventsStore()
    vi.spyOn(store, 'replaceChoices').mockImplementation((id, slotId) => t.api.replaceChoices(id, slotId))
    await view.click('[data-testid="replace-cat-eat"]')
    await until(() => view.has('[data-testid="replace-error"]'))
    expect(view.text('[data-testid="replace-error"]')).toBe('The places could not be loaded. Reload the page and try again.')
    expect(view.has('[data-testid="replace-options"]')).toBe(false)
    expect(useButtons(view)).toEqual([])
    // The stop and the tabs stay.
    expect(view.text('#replace-head')).toBe(activity.venue.name)
    expect(view.one('[data-testid="replace-cat-eat"]').attrs['aria-checked']).toBe('true')
  })

  it('shows the last tab picked when answers come back out of order', async () => {
    const t = await setUp()
    const activity = stopOf(await t.api.getItinerary(t.id), 'activity')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${activity.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    // Drink answers late; Shop is picked straight after it and answers first.
    slowFor(['drink'], 300)
    await view.click('[data-testid="replace-cat-drink"]')
    await view.click('[data-testid="replace-cat-shop"]')
    await until(() => view.has('[data-testid="replace-options"]'))
    await new Promise((r) => setTimeout(r, 400))
    await view.tick()
    const shops = (await t.api.replaceChoices(t.id, activity.slotId, 'shop')).options.map((o) => `Use ${o.venue.name} instead`)
    expect(useButtons(view).map((b) => b.attrs['aria-label'])).toEqual(shops)
    expect(view.one('[data-testid="replace-cat-shop"]').attrs['aria-checked']).toBe('true')
    expect(view.text('[data-testid="replace-change"]')).toContain('becomes Shop')
    expect(errorsOf(view)).toEqual([])
  })

  it('saves once when Use this place is pressed twice at once', async () => {
    const t = await setUp()
    const eat = stopOf(await t.api.getItinerary(t.id), 'eat')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${eat.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    const store = await eventsStore()
    const spy = vi.spyOn(store, 'replaceStop')
    const [first, second] = useButtons(view)
    first.dispatch('click')
    first.dispatch('click')
    second?.dispatch('click')
    await until(() => t.router.currentRoute.value.path === `/sessions/${t.id}/itinerary`)
    expect(spy).toHaveBeenCalledTimes(1)
  })

  it('says why when the planner cannot be reached on opening, and Keep still goes back', async () => {
    const t = await setUp()
    const eat = stopOf(await t.api.getItinerary(t.id), 'eat')
    planner.rankSlot.mockRejectedValue(new Error('The planner could not be reached.'))
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${eat.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-error"]'))
    expect(view.text('[data-testid="replace-error"]')).toBe('The planner could not be reached.')
    expect(view.text('[data-testid="keep-stop"]')).toBe('Back to the itinerary')
    await view.click('[data-testid="keep-stop"]')
    await until(() => t.router.currentRoute.value.path === `/sessions/${t.id}/itinerary`)
    expect(errorsOf(view)).toEqual([])
  })

  it('keeps the stop and its tabs when a category cannot be loaded, and works again on the next pick', async () => {
    const t = await setUp()
    const activity = stopOf(await t.api.getItinerary(t.id), 'activity')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${activity.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    const answer = planner.rankSlot.getMockImplementation()
    planner.rankSlot.mockImplementation(async (args) => {
      if (args.slot.category === 'drink') throw new Error('The planner could not be reached.')
      return answer(args)
    })
    await view.click('[data-testid="replace-cat-drink"]')
    await until(() => view.has('[data-testid="replace-error"]'))
    expect(view.text('#replace-head')).toBe(activity.venue.name)
    expect(view.text('[data-testid="keep-stop"]')).toBe(`Keep ${activity.venue.name}`)
    expect(view.has('[data-testid="replace-options"]')).toBe(false)
    await view.click('[data-testid="replace-cat-eat"]')
    await until(() => view.has('[data-testid="replace-options"]'))
    expect(view.has('[data-testid="replace-error"]')).toBe(false)
    expect(errorsOf(view)).toEqual([])
  })

  it('says so for a stop that is not in the plan', async () => {
    const t = await setUp()
    const view = await draw(t, `/sessions/${t.id}/plan?replace=drink`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-error"]'))
    expect(view.text('[data-testid="replace-error"]')).toBe('This stop is no longer in the plan.')
    expect(view.has('[data-testid="replace-options"]')).toBe(false)
    expect(errorsOf(view)).toEqual([])
  })

  it('opens Replace on a stop that changed category on its new category', async () => {
    const t = await setUp()
    const activity = stopOf(await t.api.getItinerary(t.id), 'activity')
    const { options } = await t.api.replaceChoices(t.id, activity.slotId, 'drink')
    await t.api.replaceStop(t.id, activity.slotId, options[0].id, 'drink')
    const view = await draw(t, `/sessions/${t.id}/plan?replace=${activity.slotId}`, 'PlannerView')
    await until(() => view.has('[data-testid="replace-options"]'))
    expect(view.one('[data-testid="replace-cat-drink"]').attrs['aria-checked']).toBe('true')
    expect(view.text('#replace-head')).toBe(options[0].venue.name)
    expect(view.text('[data-testid="replace-view"]')).toMatch(/Drink at \d{2}:\d{2}/)
    expect(view.has('[data-testid="replace-change"]')).toBe(false)
    // The place now in the stop is not offered again.
    expect(useButtons(view).map((b) => b.attrs['aria-label'])).not.toContain(`Use ${options[0].venue.name} instead`)
    expect(errorsOf(view)).toEqual([])
  })
})

describe('a plan changed again after a stop was replaced (data layer)', () => {
  it('takes two stops of one category, each kept apart, and can still move, delete and replace them', async () => {
    const { api, id } = await loadConfirmed()
    const before = await api.getItinerary(id)
    const eat = stopOf(before, 'eat')
    const { options } = await api.replaceChoices(id, eat.slotId, 'activity')
    await api.replaceStop(id, eat.slotId, options[0].id, 'activity')
    let itinerary = await api.getItinerary(id)
    expect(itinerary.stops.map((s) => s.category)).toEqual(['activity', 'activity'])
    expect(new Set(itinerary.stops.map((s) => s.slotId)).size).toBe(2)
    expect(new Set(itinerary.stops.map((s) => s.venue.id)).size).toBe(2)
    await api.reorderStops(id, 0, 1)
    itinerary = await api.getItinerary(id)
    expect(itinerary.stops.map((s) => s.slotId)).toEqual([...before.stops.map((s) => s.slotId)].reverse())
    // Replace it back to food, from where it now is.
    const food = await api.replaceChoices(id, eat.slotId, 'eat')
    await api.replaceStop(id, eat.slotId, food.options[0].id, 'eat')
    expect((await api.getItinerary(id)).stops.find((s) => s.slotId === eat.slotId)).toMatchObject({ category: 'eat' })
    await api.deleteStop(id, 0)
    expect((await api.getItinerary(id)).stops).toHaveLength(1)
  })

  it('keeps the first stop’s time when the first stop is replaced', async () => {
    const { api, id } = await loadConfirmed()
    const before = await api.getItinerary(id)
    const first = before.stops[0]
    const { options } = await api.replaceChoices(id, first.slotId, 'shop')
    await api.replaceStop(id, first.slotId, options[0].id, 'shop')
    const after = await api.getItinerary(id)
    expect(after.stops[0]).toMatchObject({ slotId: first.slotId, category: 'shop', start: first.start, duration: first.duration })
  })

  it('replaces the only stop left with another category', async () => {
    const { api, id } = await loadConfirmed()
    await api.deleteStop(id, 1)
    const only = (await api.getItinerary(id)).stops[0]
    const other = only.category === 'eat' ? 'drink' : 'eat'
    const { options } = await api.replaceChoices(id, only.slotId, other)
    await api.replaceStop(id, only.slotId, options[0].id, other)
    expect((await api.getItinerary(id)).stops).toEqual([expect.objectContaining({ slotId: only.slotId, category: other })])
  })

  it('can still be re-planned, and finished, after a stop changed category', async () => {
    const { api, id } = await loadConfirmed()
    const activity = stopOf(await api.getItinerary(id), 'activity')
    const { options } = await api.replaceChoices(id, activity.slotId, 'drink')
    await api.replaceStop(id, activity.slotId, options[0].id, 'drink')
    await api.endPlan(id)
    expect((await api.getSession(id)).status).toBe('completed')
    const again = await loadConfirmed()
    await again.api.replaceStop(again.id, activity.slotId, options[0].id, 'drink')
    await again.api.replan(again.id)
    expect((await again.api.getSession(again.id)).status).toBe('voting')
    expect(await again.api.getItinerary(again.id)).toBeNull()
  })
})
