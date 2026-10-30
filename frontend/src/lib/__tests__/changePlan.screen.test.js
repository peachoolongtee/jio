// "Change plan" for a real account, drawn for real on an in-memory page (domless.js) on the stand-in database and the stand-in Jio server: the
// host's button on the Vote and Itinerary screens (and not the guest's, or in any other status), the two choices, the question that names what is
// lost, the same two cards as Start in change mode, a failed change and its retry, and what a guest sees live: the session back on Locate and the
// host's notice. No network. Focus, the layout and the dialog's focus trap are checked in a browser (the in-memory page has no layout).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { mountScreen, until } from './domless.js'
import { confirmed, voted } from './sessionsWorld.js'

// The map needs a real browser (Leaflet).
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/spots/SpotPins.vue', () => ({ default: { name: 'SpotPins', render: () => null } }))

vi.setConfig({ testTimeout: 40000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))
const row = (w, id) => w.database.tables.sessions.find((s) => s.id === id)
const SCREENS = {
  PlannerView: () => import('@/views/PlannerView.vue'),
  EventView: () => import('@/views/EventView.vue'),
  StartView: () => import('@/views/StartView.vue'),
  GroupDetailView: () => import('@/views/GroupDetailView.vue'),
  ChangePlan: () => import('@/components/event/ChangePlan.vue'),
}

// Draw a screen of the app opened last, signed in as that person.
// How to call: const t = await draw('StartView', `/sessions/${id}/change-place`, { id, change: true })
async function draw(name, path, props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const auth = useAuthStore()
  await auth.init()
  const events = (await import('@/stores/events.js')).useEventsStore()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(path)
  if (name === 'EventView') vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  const { default: View } = await SCREENS[name]()
  const view = await mountScreen(View, { plugins: [pinia, router], props })
  return { view, router, auth, events }
}

describe('the button', () => {
  it('is the host\'s on the Vote screen of a voting session, and the guest has none', async () => {
    const host = await voted({ hostLast: true })
    const mine = await draw('PlannerView', `/sessions/${host.id}/plan`, { id: host.id })
    await until(() => mine.view.has('[data-testid=change-plan]'))
    expect(mine.view.text('[data-testid=change-plan]')).toContain('Change plan')
    expect(mine.view.errors).toEqual([])
    const guest = await voted()
    const theirs = await draw('PlannerView', `/sessions/${guest.id}/plan`, { id: guest.id })
    await until(() => theirs.view.has('[data-testid=planner-view]'))
    await until(() => theirs.view.has('[data-testid=confirm-waiting]'))
    expect(theirs.view.has('[data-testid=change-plan]')).toBe(false)
  })

  it('is on the Itinerary outside edit mode, for the host only', async () => {
    const host = await confirmed({ hostLast: true })
    const mine = await draw('EventView', `/sessions/${host.id}/itinerary`, { id: host.id })
    await until(() => mine.view.has('[data-testid=event-view]'))
    await until(() => mine.view.has('[data-testid=change-plan]'))
    expect(mine.view.text('[data-testid=change-plan]')).toContain('Change plan')
    const guest = await confirmed()
    const theirs = await draw('EventView', `/sessions/${guest.id}/itinerary`, { id: guest.id })
    await until(() => theirs.view.has('[data-testid=event-view]'))
    expect(theirs.view.has('[data-testid=change-plan]')).toBe(false)
  })

  it.each([['inviting', false], ['locating', false], ['voting', true], ['confirmed', true], ['completed', false], ['cancelled', false]])(
    'in status %s the host sees it: %s',
    async (status, shown) => {
      const { id, sam } = await voted({ hostLast: true })
      const { view, auth } = await draw('ChangePlan', `/sessions/${id}/plan`, { session: { id, hostId: sam.id, status } })
      expect(auth.myId).toBe(sam.id)
      expect(view.has('[data-testid=change-plan]')).toBe(shown)
    },
  )
})

describe('the choices and the question', () => {
  it('in voting offers only "Change meeting place", and the question names the votes and the places to vote on, and that starts are kept', async () => {
    const { id, sam, w } = await voted({ hostLast: true })
    const { view, router } = await draw('ChangePlan', `/sessions/${id}/plan`, { session: { id, hostId: sam.id, status: 'voting' } })
    await view.click('[data-testid=change-plan]')
    expect(view.has('[role=dialog]')).toBe(true)
    expect(view.text('[role=dialog]')).toContain('Change plan')
    expect(view.has('[data-testid=change-again]')).toBe(false)
    expect(view.text('[data-testid=change-place]')).toContain('Change meeting place')
    await view.click('[data-testid=change-place]')
    await until(() => view.has('[data-testid=change-lost]'))
    const text = view.text('[data-testid=change-lost]')
    expect(text).toContain('everyone\'s votes')
    expect(text).toContain('the places to vote on')
    expect(text).toContain('the votes for meeting spots and the suggested spots')
    expect(text).not.toContain('stops')
    expect(text).toContain('Everyone\'s starting places are kept.')
    // The safer choice comes first, and keeping the place changes nothing.
    const labels = view.all('button').map((b) => view.text(b))
    expect(labels.indexOf('Keep the meeting place')).toBeGreaterThan(-1)
    expect(labels.indexOf('Keep the meeting place')).toBeLessThan(labels.indexOf('Choose a new meeting place'))
    await view.click(press(view, 'Keep the meeting place'))
    expect(row(w, id).status).toBe('voting')
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/plan`)
  })

  it('from a confirmed plan the question also names the stops and any proposed places, and going on opens the cards (nothing is changed yet)', async () => {
    const { id, sam, w } = await confirmed({ hostLast: true })
    const { view, router } = await draw('ChangePlan', `/sessions/${id}/itinerary`, { session: { id, hostId: sam.id, status: 'confirmed' } })
    await view.click('[data-testid=change-plan]')
    expect(view.text('[data-testid=change-again]')).toContain('Choose places again')
    expect(view.text('[data-testid=change-again]')).toContain('The stops go; the votes stay unless the meeting area moves.')
    await view.click('[data-testid=change-place]')
    await until(() => view.has('[data-testid=change-lost]'))
    expect(view.text('[data-testid=change-lost]')).toContain('the itinerary\'s stops and any proposed places')
    await view.click('[data-testid=change-go]')
    await until(() => router.currentRoute.value.path === `/sessions/${id}/change-place`)
    expect(row(w, id).status).toBe('confirmed')
    expect(w.server.calls.filter((c) => c.route === 'changeMeetingPlace')).toEqual([])
  })

  it('"Choose places again" opens the plan for voting, keeps the votes and goes to the Vote screen', async () => {
    const { id, sam, w } = await confirmed({ hostLast: true })
    const { view, router } = await draw('ChangePlan', `/sessions/${id}/itinerary`, { session: { id, hostId: sam.id, status: 'confirmed' } })
    await view.click('[data-testid=change-plan]')
    await view.click('[data-testid=change-again]')
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    expect(row(w, id).status).toBe('voting')
    expect(w.database.tables.votes.length).toBeGreaterThan(0)
    expect(w.server.calls.map((c) => c.route)).toContain('replan')
  })
})

describe('the cards in change mode', () => {
  it('shows the same two cards with words for what the button does, and "fairest" changes the session and goes to Locate', async () => {
    const { id, w } = await voted({ hostLast: true })
    const { view, router } = await draw('StartView', `/sessions/${id}/change-place`, { id, change: true })
    await until(() => view.has('[data-testid=start-view]'))
    expect(view.errors).toEqual([])
    expect(view.text()).toContain('How do you want to pick the new meeting point?')
    const [fair, known] = view.all('button').filter((b) => b.attrs.role === 'radio')
    expect(view.text(fair)).toContain('Find the fairest spot')
    expect(view.text(known)).toContain('We already know where')
    expect(view.text()).toContain('This clears the votes and the plan. Everyone keeps where they start.')
    // Nothing is changed by looking, or by choosing a card.
    await view.click(known)
    await view.click(fair)
    expect(row(w, id).status).toBe('voting')
    await view.click(press(view, 'Work out the spots again'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
    expect(w.server.calls.filter((c) => c.route === 'changeMeetingPlace')).toEqual([expect.objectContaining({ body: { meetBy: 'fairest', planVersion: expect.any(Number) } })])
    expect(row(w, id)).toMatchObject({ status: 'locating', meet_by: 'fairest', meeting_area_id: null })
  })

  it('"We already know where" asks for the area, and "Meet at <area>" changes the session and goes to the Vote screen', async () => {
    const { id, w } = await voted({ hostLast: true })
    const { view, router } = await draw('StartView', `/sessions/${id}/change-place`, { id, change: true })
    await until(() => view.has('[data-testid=start-view]'))
    await view.click(view.all('button').find((b) => b.attrs.role === 'radio' && view.text(b).includes('We already know where')))
    await view.click(press(view, 'Choose the area'))
    await until(() => router.currentRoute.value.query.where === '1')
    expect(view.text()).toContain('Where is the place?')
    expect(row(w, id).status).toBe('voting')
    await view.click(view.all('button').find((b) => b.attrs.role === 'radio' && view.text(b) === 'Orchard'))
    await view.click(press(view, 'Meet at Orchard'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    expect(w.server.calls.filter((c) => c.route === 'changeMeetingPlace')).toEqual([expect.objectContaining({ body: { meetBy: 'known', areaId: 'orchard', planVersion: expect.any(Number) } })])
    expect(row(w, id)).toMatchObject({ status: 'voting', meeting_area_id: 'orchard', meet_by: 'known' })
  })

  it('says why a change failed in an alert, stays on the page, and the retry goes through', async () => {
    const { id, w } = await voted({ hostLast: true })
    const { view, router } = await draw('StartView', `/sessions/${id}/change-place`, { id, change: true })
    await until(() => view.has('[data-testid=start-view]'))
    w.server.down = true
    await view.click(press(view, 'Work out the spots again'))
    await until(() => view.has('[role=alert]'))
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/change-place`)
    expect(row(w, id).status).toBe('voting')
    w.server.down = false
    await view.click(press(view, 'Work out the spots again'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
    expect(row(w, id).status).toBe('locating')
  })

  it('is the host\'s alone, and only for a voting or confirmed session: anyone else goes back to the session page', async () => {
    const guest = await voted()
    const theirs = await draw('StartView', `/sessions/${guest.id}/change-place`, { id: guest.id, change: true })
    await until(() => theirs.router.currentRoute.value.path === `/sessions/${guest.id}`)
    const host = await voted({ hostLast: true })
    await host.sam.api.changeMeetingPlace(host.id, { meetBy: 'fairest' })
    const mine = await draw('StartView', `/sessions/${host.id}/change-place`, { id: host.id, change: true })
    await until(() => mine.router.currentRoute.value.path === `/sessions/${host.id}`)
  })
})

describe('what a guest and the host see on Locate', () => {
  it('on Locate, the notice names the host and nobody else, and can be dismissed', async () => {
    const { id, sam } = await voted()
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    const { view } = await draw('GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('changed the meeting place'))
    expect(view.text()).toContain('Sam changed the meeting place, so the votes were cleared.')
    expect(view.text()).not.toContain('Kim changed')
    expect(view.errors).toEqual([])
  })

  it('the host\'s error survives the change: when naming the area fails after the release, Locate shows it with a way on', async () => {
    const { id, w } = await voted({ hostLast: true })
    const { view, events, router } = await draw('GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.has('[data-testid=planner-view]') || view.text().includes('Catch') || view.text().length > 0)
    w.server.after.knownPlace = () => {
      throw new Error('The stand-in server went away.')
    }
    await expect(events.changeMeetingPlace(id, { meetBy: 'known', areaId: 'orchard' })).rejects.toMatchObject({ released: true })
    await until(() => view.has('[data-testid=place-failure]'))
    expect(view.text('[data-testid=place-failure]')).toContain('The meeting place was released, but the new area could not be set')
    expect(view.text()).toContain('Pick the place yourself')
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}`)
    // The failure's own Dismiss (the release notice has one too): the button inside its banner.
    const inside = (node) => (node.tag === 'button' ? [node] : (node.children || []).flatMap(inside))
    await view.click(inside(view.one('[data-testid=place-failure]'))[0])
    await until(() => !view.has('[data-testid=place-failure]'))
  })
})

describe('while "Choose places again" runs', () => {
  it('Escape and the backdrop are ignored, the buttons are off, and the dialog closes by itself when it is done', async () => {
    const { id, sam, w } = await confirmed({ hostLast: true })
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.server.after.replan = () => held
    const { view, router } = await draw('ChangePlan', `/sessions/${id}/itinerary`, { session: { id, hostId: sam.id, status: 'confirmed' } })
    await view.click('[data-testid=change-plan]')
    await view.click('[data-testid=change-again]')
    await until(() => w.server.calls.some((c) => c.route === 'replan'))
    // A click on the backdrop does not close it while the plan is being opened (Escape runs the same close, which ModalDialog reports as update:open).
    await view.click(view.one('.modal__scrim'))
    expect(view.has('[role=dialog]')).toBe(true)
    expect(view.one('[data-testid=change-again]').disabled).toBeTruthy()
    release()
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    await until(() => !view.has('[role=dialog]'))
    expect(row(w, id).status).toBe('voting')
  })
})
