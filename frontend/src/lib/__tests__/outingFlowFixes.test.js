// Fixes from the review of pull request #191 (the outing's flow): the review of a finished outing (what is kept and who may), the
// review page itself (it starts again for another outing, says "Saving…", puts a failure by the footer, offers "Skip for now"), the
// "How was it?" row (only for someone who went), "Change plan" (never on a light meetup), "What next?" in place of the empty timeline
// (a heading, no Photos row, a secondary "Finish outing"), the way "Finish outing" goes on to the review, and sharing a photo (made
// ahead, one share at a time, a tap that is too old). Local outings are drawn for real (domless.js) on the stand-in planner.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { defineComponent, h, ref } from 'vue'
import { STORAGE_KEY, confirmedSave, loadApi, loadConfirmed, stubPlanner } from './planFixture.js'
import { liven, mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const at = (iso) => vi.setSystemTime(new Date(iso))
const mounted = []

beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  at('2026-10-09T10:00:00+08:00')
  stubPlanner(planner)
  await confirmedSave()
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

const ianProfile = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }

// The app's stores and router (stand-in screens), for whoever the data layer is signed in as.
// How to call: const t = await appFor(api)
async function appFor(api) {
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { useEventsStore } = await import('@/stores/events.js')
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  return { api, pinia, router, events: useEventsStore() }
}

// A new local account, signed in, with the app around it.
// How to call: const t = await setUp()
async function setUp() {
  const api = await loadApi()
  await api.signUp(ianProfile)
  return appFor(api)
}

// Draw a screen after the router has opened `path`.
// How to call: const view = await draw(t, '/sessions/s1/review', 'ReviewView', { id: 's1' })
async function draw(t, path, name, props = {}) {
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await t.router.push(path)
  const { default: screen } = await import(`@/views/${name}.vue`)
  const view = await mountScreen(screen, { plugins: [t.pinia, t.router], props })
  mounted.push(view)
  return view
}
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))
// Take a screen off the page, so the next one can be drawn (the stand-in page has one body).
// How to call: leave(view)
function leave(view) {
  mounted.splice(mounted.indexOf(view), 1)
  view.unmount()
}

describe('what a review keeps, and who may give one', () => {
  it("keeps the stars of a stop that is in the plan, and drops those of a stop that is not", async () => {
    const { api, id } = await loadConfirmed()
    at('2026-10-10T19:00:00+08:00')
    const { stops } = await api.getItinerary(id)
    expect(stops.length).toBeGreaterThan(1)
    const [first, second] = stops.map((s) => s.slotId)
    await api.endPlan(id)
    const done = await api.saveReview(id, 'ian', { stars: 4, stops: { [first]: 5, [second]: 2, gone: 3 }, note: 'Good' })
    expect(done.reviews.ian).toMatchObject({ stars: 4, stops: { [first]: 5, [second]: 2 }, note: 'Good' })
    expect(Object.keys(done.reviews.ian.stops)).toHaveLength(2)
  })

  it('refuses an outing that closed without a plan', async () => {
    const api = await loadApi()
    await api.signUp(ianProfile)
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-18', start: '12:00', end: '20:00' })
    at('2026-10-21T12:00:00+08:00')
    const [closed] = await api.listSessions()
    expect(closed).toMatchObject({ id, status: 'completed', endedBy: 'closed' })
    await expect(api.saveReview(id, 'ian', { stars: 4 })).rejects.toThrow('closed without a plan')
  })

  it('refuses a person who did not go, and the "How was it?" row is not offered to them', async () => {
    const { text, id } = await confirmedSave()
    const save = JSON.parse(text)
    const outing = save.sessions.find((s) => s.id === id)
    // Finished, and Ian opted out of it before: he was never at the end.
    outing.status = 'completed'
    outing.endedBy = 'hand'
    outing.members.find((m) => m.id === 'ian').state = 'opted_out'
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(save) } })
    await expect(api.saveReview(id, 'ian', { stars: 4 })).rejects.toThrow('Only the people who went')
    const t = await appFor(api)
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => view.has('[data-testid="event-view"]'))
    await until(() => view.has('.stop') || view.has('.timeline'))
    expect(view.has('[data-testid="review-cta"]')).toBe(false)
    leave(view)
    const review = await draw(t, `/sessions/${id}/review`, 'ReviewView', { id })
    await until(() => review.has('[data-testid="review-closed"]'))
    expect(review.text('[data-testid="review-closed"]')).toContain('Only the people who went can review this outing.')
  })

  it('offers the "How was it?" row to someone who went, until they have reviewed', async () => {
    const { text, id } = await confirmedSave()
    const save = JSON.parse(text)
    const outing = save.sessions.find((s) => s.id === id)
    outing.status = 'completed'
    outing.endedBy = 'hand'
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(save) } })
    const t = await appFor(api)
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => view.has('[data-testid="review-cta"]'))
    leave(view)
    await api.saveReview(id, 'ian', { stars: 4 })
    const again = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => again.has('[data-testid="event-view"]'))
    await until(() => !again.has('[data-testid="review-cta"]'))
  })
})

describe('Finish outing on a local outing', () => {
  it('goes on to the review page with the flag that says it was just finished', async () => {
    const t = await setUp()
    const { id } = await t.api.startRoam({ areaId: 'bugis' })
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => !!press(view, 'Finish and review'))
    const push = vi.spyOn(t.router, 'push')
    await view.click(press(view, 'Finish and review'))
    await until(() => view.has('[data-testid="no-coins"]'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Yes, finish and review').at(-1))
    await until(() => push.mock.calls.length > 0)
    expect(push).toHaveBeenCalledWith({ path: `/sessions/${id}/review`, state: { justFinished: true } })
  })
})

describe('"What next?" in place of the empty timeline', () => {
  async function lightItinerary() {
    const t = await setUp()
    const { id } = await t.api.startRoam({ areaId: 'bugis' })
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => view.has('[data-testid="roam-panel"]'))
    return { ...t, id, view }
  }

  it('has a heading, no Photos row and no Change plan, and keeps "Finish outing" as a secondary button', async () => {
    const { view } = await lightItinerary()
    const headings = view.all('h2').filter((h2) => view.text(h2) === 'What next?')
    expect(headings).toHaveLength(1)
    expect(view.text()).not.toContain('Photos from the day')
    expect(view.has('[data-testid="change-plan"]')).toBe(false)
    const finish = press(view, 'Finish and review')
    expect(finish).toBeTruthy()
    expect(finish.attrs.class).toContain('btn--secondary')
  })

  it('keeps the Photos row and a main "Finish outing" once there is a stop', async () => {
    const { text, id } = await confirmedSave()
    const save = JSON.parse(text)
    // The confirmed outing's day, so the plan is under way.
    at('2026-10-10T14:00:00+08:00')
    const api = await loadApi({ data: { [STORAGE_KEY]: JSON.stringify(save) } })
    const t = await appFor(api)
    const view = await draw(t, `/sessions/${id}/itinerary`, 'EventView', { id })
    await until(() => !!press(view, 'Finish and review'))
    expect(view.text()).toContain('Photos from the day')
    expect(press(view, 'Finish and review').attrs.class).toContain('btn--primary')
    expect(view.all('h2').filter((h2) => view.text(h2) === 'What next?')).toHaveLength(0)
  })
})

describe('the review page', () => {
  // Two finished outings of the signed-in person, and the review page of the first.
  async function twoOutings() {
    const t = await setUp()
    const ids = []
    for (const area of ['bugis', 'bishan']) {
      const { id } = await t.api.startRoam({ areaId: area })
      await t.api.endPlan(id)
      ids.push(id)
    }
    return { ...t, ids }
  }
  const stars = (view, n) => view.all('[role="radio"]').find((r) => r.attrs['aria-label'] === `${n} ${n === 1 ? 'star' : 'stars'}`)
  const save = (view) => view.one('[data-testid="review-save"]')
  const skip = (view) => view.one('[data-testid="review-skip"]')

  // The review page for whichever outing `id.value` names, as the router draws one page for both addresses.
  // How to call: const { view, id } = await pageFor(t, t.ids[0])
  async function pageFor(t, first) {
    vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
    const { default: ReviewView } = await import('@/views/ReviewView.vue')
    await liven(ReviewView)
    const id = ref(first)
    const Wrapper = defineComponent({ setup: () => () => h(ReviewView, { id: id.value }) })
    const view = await mountScreen(Wrapper, { plugins: [t.pinia, t.router] })
    mounted.push(view)
    await until(() => view.has('[data-testid="review-save"]'))
    return { view, id }
  }

  it('starts the form again for another outing: no stars, no note, no old error', async () => {
    const t = await twoOutings()
    t.events.saveReview = vi.fn().mockRejectedValue(new Error('Could not save.'))
    const { view, id } = await pageFor(t, t.ids[0])
    await view.click(stars(view, 4))
    view.type('textarea', 'Lovely')
    await view.click(save(view))
    await until(() => view.has('[data-testid="review-error"]'))
    expect(save(view).disabled).toBe(false)
    id.value = t.ids[1]
    await until(() => view.has('[data-testid="review-save"]') && save(view).disabled)
    expect(view.has('[data-testid="review-error"]')).toBe(false)
    expect(view.one('textarea').value).toBe('')
    expect(view.text()).toContain('Tap a star to rate the outing.')
    expect(view.text(skip(view))).toBe('Not now')
  })

  it('fills in the saved review of the outing it goes to', async () => {
    const t = await twoOutings()
    await t.api.saveReview(t.ids[1], 'ian', { stars: 5, note: 'The best' })
    const { view, id } = await pageFor(t, t.ids[0])
    expect(view.text()).toContain('Tap a star to rate the outing.')
    id.value = t.ids[1]
    await until(() => view.has('textarea') && !view.text().includes('Tap a star to rate the outing.'))
    expect(view.one('textarea').value).toBe('The best')
  })

  it('says "Saving…" on the button while it saves, and a failure is said inside the footer', async () => {
    const t = await twoOutings()
    let fail
    t.events.saveReview = vi.fn(() => new Promise((_, reject) => (fail = reject)))
    const { view } = await pageFor(t, t.ids[0])
    await view.click(stars(view, 3))
    await view.click(save(view))
    await until(() => view.text(save(view)) === 'Saving…')
    expect(save(view).attrs['aria-busy']).toBe('true')
    fail(new Error('Could not save.'))
    await until(() => view.has('[data-testid="review-error"]'))
    const footer = view.one('footer')
    expect(view.text(footer)).toContain('Could not save.')
    expect(view.one('[data-testid="review-error"]').attrs.role).toBe('alert')
    expect(view.text(save(view))).toBe('Save review')
  })

  it('calls "Not now" "Skip for now" once there are stars or a note that would be lost', async () => {
    const t = await twoOutings()
    const { view } = await pageFor(t, t.ids[0])
    expect(view.text(skip(view))).toBe('Not now')
    await view.click(stars(view, 2))
    expect(view.text(skip(view))).toBe('Skip for now')
  })
})

describe('"Change plan" on a light meetup', () => {
  it('is not offered to the host of an "Already out?" outing, whatever its status', async () => {
    const t = await setUp()
    const { id } = await t.api.startRoam({ areaId: 'bugis' })
    const { default: ChangePlan } = await import('@/components/event/ChangePlan.vue')
    const session = await t.api.getSession(id)
    expect(session).toMatchObject({ light: true, status: 'confirmed', hostId: 'ian' })
    const light = await mountScreen(ChangePlan, { plugins: [t.pinia, t.router], props: { session } })
    mounted.push(light)
    expect(light.has('[data-testid="change-plan"]')).toBe(false)
    // The same session without the mark is the host's, as before.
    const planned = await mountScreen(ChangePlan, { plugins: [t.pinia, t.router], props: { session: { ...session, light: false } } })
    mounted.push(planned)
    expect(planned.has('[data-testid="change-plan"]')).toBe(true)
  })
})

describe('sharing a photo from the dialog', () => {
  const photo = { id: 'p12', src: 'data:image/jpeg;base64,/9j/' }
  const session = { title: 'Saturday' }

  // The dialog drawn, with its `prepare` and `share` in hand.
  // How to call: const { view, dialog } = await dialogPage()
  async function dialogPage() {
    const { default: ShareDialog } = await import('@/components/event/ShareDialog.vue')
    await liven(ShareDialog)
    const holder = {}
    const Wrapper = defineComponent({ setup: () => () => h(ShareDialog, { session, ref: (instance) => (holder.dialog = instance) }) })
    const view = await mountScreen(Wrapper)
    mounted.push(view)
    return { view, holder }
  }
  const shareSheet = (impl) => ({ share: vi.fn(impl), canShare: () => true })
  const opened = (view) => view.all('[role="dialog"]').length > 0
  // A little time for the picture to be made, as it is while the photo is shown.
  const ready = () => new Promise((resolve) => setTimeout(resolve, 20))

  it('calls the share sheet in the tap itself when the picture was made ahead, and ignores a second tap meanwhile', async () => {
    let close
    const nav = shareSheet(() => new Promise((resolve) => (close = resolve)))
    vi.stubGlobal('navigator', nav)
    const { view, holder } = await dialogPage()
    holder.dialog.prepare(photo)
    await ready()
    const first = holder.dialog.share(photo, 'Maxwell')
    // Nothing was awaited before it: the tap is still fresh.
    expect(nav.share).toHaveBeenCalledTimes(1)
    expect(nav.share.mock.calls[0][0].text).toBe('Saturday at Maxwell, on Jio')
    expect(nav.share.mock.calls[0][0].files[0].name).toBe('jio-saturday-p12.jpg')
    // A second tap while the sheet is open does nothing: no second sheet, no dialog over it.
    await holder.dialog.share(photo, 'Maxwell')
    expect(nav.share).toHaveBeenCalledTimes(1)
    expect(opened(view)).toBe(false)
    close()
    await first
    expect(opened(view)).toBe(false)
    // And the next tap works.
    nav.share.mockResolvedValue(undefined)
    await holder.dialog.share(photo)
    expect(nav.share).toHaveBeenCalledTimes(2)
  })

  it('opens the dialog, saying the sheet did not open, when the browser finds the tap too old', async () => {
    vi.stubGlobal('navigator', shareSheet(() => Promise.reject(Object.assign(new Error('gesture'), { name: 'NotAllowedError' }))))
    const { view, holder } = await dialogPage()
    holder.dialog.prepare(photo)
    await ready()
    await holder.dialog.share(photo)
    await until(() => opened(view))
    expect(view.text(view.all('[role="dialog"]')[0])).toContain('The share sheet did not open.')
    expect(view.text(view.all('[role="dialog"]')[0])).toContain('First save the photo, then open an app below and post it.')
  })

  it('opens no dialog when the person closes the share sheet', async () => {
    vi.stubGlobal('navigator', shareSheet(() => Promise.reject(Object.assign(new Error('closed'), { name: 'AbortError' }))))
    const { view, holder } = await dialogPage()
    holder.dialog.prepare(photo)
    await ready()
    await holder.dialog.share(photo)
    expect(opened(view)).toBe(false)
  })

  it('offers saving the photo and opening each app, in that order, where the browser has no share sheet', async () => {
    vi.stubGlobal('navigator', {})
    const { view, holder } = await dialogPage()
    holder.dialog.prepare(photo)
    await holder.dialog.share(photo)
    await until(() => opened(view))
    const dialog = view.all('[role="dialog"]')[0]
    const words = view.text(dialog)
    expect(words).toContain('First save the photo, then open an app below and post it.')
    expect(words.indexOf('Save photo')).toBeLessThan(words.indexOf('Open WhatsApp'))
    for (const app of ['Open WhatsApp', 'Open Instagram', 'Open Telegram']) expect(words).toContain(app)
    await view.click('[data-testid="share-save"]')
    expect(view.text(view.all('[role="dialog"]')[0])).toContain('Saved. Now open an app below and post the photo from your photos.')
  })
})
