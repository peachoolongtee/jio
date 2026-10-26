// The screens of stage 5 for a real account, drawn for real on an in-memory page (domless.js) on the stand-in database and the stand-in Jio
// server: the Confirm plan dialog on the Vote page (both orders and the note, a suggestion that fails, a suggested order the votes have
// outdated, a confirm that fails), the itinerary (the host's edits, a guest's read-only page, finishing the outing, the person's own
// travel ledger, a plan that cannot be loaded), the question "Re-plan?", the places waiting to be added, and "What next?". The pages are
// the ones the local mode draws; only the data behind them is the server's. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { timeAndDuration } from '../planner/format.js'
import { mountScreen, until } from './domless.js'
import { confirmed, voted } from './sessionsWorld.js'

// The map needs a real browser (Leaflet).
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/spots/SpotPins.vue', () => ({ default: { name: 'SpotPins', render: () => null } }))

vi.setConfig({ testTimeout: 40000 })
// The day of the outing, at noon in Singapore, in any time zone the tests run in.
const ON_THE_DAY = new Date('2026-10-10T04:00:00Z')
const BEFORE = new Date('2026-10-09T02:00:00Z')
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(BEFORE)
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.setSystemTime(BEFORE)
})
// The finished-outing toast animates through the browser's frames, which this page does not have.
const frames = () => {
  vi.stubGlobal('requestAnimationFrame', (fn) => setTimeout(fn, 0))
  vi.stubGlobal('cancelAnimationFrame', (id) => clearTimeout(id))
}

const eq = (col, value) => ({ col, op: 'eq', value })
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))
const pressExact = (view, label) => view.all('button').filter((b) => view.text(b) === label).at(-1)
const SCREENS = {
  PlannerView: () => import('@/views/PlannerView.vue'),
  EventView: () => import('@/views/EventView.vue'),
  RoamView: () => import('@/views/RoamView.vue'),
}

// Draw a screen of the app opened last, signed in as that person (the modules are the last app's).
// How to call: const t = await draw('PlannerView', `/sessions/${id}/plan`, id)
async function draw(name, path, id, historyState = null) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const events = (await import('@/stores/events.js')).useEventsStore()
  const planner = (await import('@/stores/planner.js')).usePlannerStore()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  // The itinerary reads the history entry's flag for "Plan confirmed" (window.history.state).
  if (name === 'EventView') vi.stubGlobal('window', { history: { state: historyState, replaceState() {} } })
  await router.push(path)
  const { default: View } = await SCREENS[name]()
  const view = await mountScreen(View, { plugins: [pinia, router], props: { id } })
  return { view, router, events, planner }
}

// The two order tabs of the dialog, or [] while there is only the voted order.
// How to call: tabs(view).map((b) => view.text(b)) -> ['Voted order', 'Suggested order']
const tabs = (view) => view.all('button').filter((b) => ['Voted order', 'Suggested order'].includes(view.text(b)))
const hasTabs = (view) => tabs(view).length === 2
const dialog = (view) => view.all('[role=dialog]').at(-1)
// The words of the dialog that is open, or ''.
const dialogText = (view) => (dialog(view) ? view.text(dialog(view)) : '')

describe('the Confirm plan dialog', () => {
  // Sam (the host) has the page; two people have voted, so the winners are the first places.
  async function open() {
    const world = await voted({ hostLast: true })
    const t = await draw('PlannerView', `/sessions/${world.id}/plan`, world.id)
    await until(() => !!press(t.view, 'Confirm plan'))
    await t.view.click(press(t.view, 'Confirm plan'))
    return { ...world, ...t }
  }

  it('shows the voted order and, once the server has answered, the suggested order with its note, the voted one selected', async () => {
    const { view, w, id } = await open()
    expect(dialogText(view)).toContain('Confirm plan?')
    await until(() => hasTabs(view))
    expect(view.errors).toEqual([])
    expect(tabs(view).map((b) => view.text(b))).toEqual(['Voted order', 'Suggested order'])
    expect(tabs(view)[0].attrs['aria-pressed']).toBe('true')
    // The note is the server's sentence, introduced as an AI suggestion; the host asked for it once, with an empty body.
    expect(dialogText(view)).toContain('AI suggestion: The meal keeps its time and the other stops are turned round.')
    const asked = w.server.calls.filter((c) => c.route === 'suggestOrder')
    expect(asked).toHaveLength(1)
    expect(asked[0]).toMatchObject({ path: `/api/sessions/${id}/order/suggest`, body: {} })
    // Four rows, one a place, in the order the votes make.
    expect(view.all('.winners__row')).toHaveLength(4)
  })

  it('draws the voted order from what the server will store, not from the slots\' own times', async () => {
    const world = await voted({ hostLast: true })
    // The server lays the stops out later than the slots do (the travel between them); the dialog must show the server's starts.
    world.w.server.plan.voteShift = 11
    const t = await draw('PlannerView', `/sessions/${world.id}/plan`, world.id)
    await until(() => !!press(t.view, 'Confirm plan'))
    await t.view.click(press(t.view, 'Confirm plan'))
    await until(() => hasTabs(t.view))
    const slots = world.w.database.tables.slots.filter((x) => x.session_id === world.id && !x.deleted)
    const rows = t.view.all('.winners__row').map((r) => t.view.text(r))
    expect(rows).toHaveLength(slots.length)
    for (const slot of slots) {
      expect(rows.some((r) => r.includes(timeAndDuration(slot.start_minute + 11, slot.duration_minutes)))).toBe(true)
      expect(rows.some((r) => r.includes(timeAndDuration(slot.start_minute, slot.duration_minutes)))).toBe(false)
    }
  })

  it('shows the suggested rows when the host picks them, and confirms that order with the basis it saw', async () => {
    const { view, w, id, router, sam } = await open()
    await until(() => hasTabs(view))
    const voted = view.all('.winners__row').map((r) => view.text(r))
    await view.click(press(view, 'Suggested order'))
    const suggested = view.all('.winners__row').map((r) => view.text(r))
    expect(suggested).not.toEqual(voted)
    expect([...suggested].sort()).not.toEqual([])
    await view.click(pressExact(view, 'Confirm'))
    await until(() => w.server.calls.some((c) => c.route === 'confirmPlan'))
    const call = w.server.calls.find((c) => c.route === 'confirmPlan')
    expect(call.body).toEqual({ order: 'suggested', basis: expect.stringMatching(/^[0-9a-f]{64}$/) })
    await until(() => router.currentRoute.value.path === `/sessions/${id}/itinerary`)
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/itinerary`)
    expect((await sam.api.getSession(id)).status).toBe('confirmed')
  })

  it('confirms the voted order when the host leaves it as it is', async () => {
    const { view, w, id, router } = await open()
    await until(() => hasTabs(view))
    await view.click(pressExact(view, 'Confirm'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/itinerary`)
    // The voted order goes with the basis of the votes the dialog was drawn from, so a vote that moved a winner meanwhile is turned away.
    expect(w.server.calls.find((c) => c.route === 'confirmPlan').body).toEqual({ order: 'voted', basis: expect.stringMatching(/^[0-9a-f]{64}$/) })
  })

  it('keeps the dialog open with the reason in words and Confirm still there, when the server cannot be reached; and confirms on the second press', async () => {
    const { view, w, id, router } = await open()
    await until(() => hasTabs(view))
    w.server.down = true
    await view.click(pressExact(view, 'Confirm'))
    await until(() => view.has('[data-testid=confirm-error]'))
    expect(view.text(view.one('[data-testid=confirm-error]'))).toMatch(/Cannot reach the Jio planner/)
    expect(view.one('[data-testid=confirm-error]').attrs.role).toBe('alert')
    expect(dialogText(view)).toContain('Confirm plan?')
    expect(pressExact(view, 'Confirm').disabled).toBeFalsy()
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/plan`)
    w.server.down = false
    await view.click(pressExact(view, 'Confirm'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/itinerary`)
  })

  it('keeps the dialog open and says so in words when the server refuses (here: only one person has voted)', async () => {
    const { view, w, id } = await open()
    await until(() => hasTabs(view))
    // Kim's votes go behind the page's back (the page is told a moment later).
    w.database.run({ as: SERVICE, kind: 'delete', table: 'votes', filters: [eq('user_id', w.database.tables.session_members.find((m) => m.role !== 'host').user_id)] })
    await view.click(pressExact(view, 'Confirm'))
    await until(() => view.has('[data-testid=confirm-error]'))
    expect(view.text(view.one('[data-testid=confirm-error]'))).toBe('At least 2 people need to vote first.')
    expect(w.database.tables.stops).toEqual([])
    void id
  })

  it('says it could not get the order of the stops, offers Try again, and holds Confirm back until the server has shown the order it will save', async () => {
    const world = await voted({ hostLast: true })
    const { view } = await draw('PlannerView', `/sessions/${world.id}/plan`, world.id)
    await until(() => !!press(view, 'Confirm plan'))
    world.w.server.down = true
    await view.click(press(view, 'Confirm plan'))
    await until(() => view.has('[data-testid=order-failed]'))
    expect(view.text(view.one('[data-testid=order-failed]'))).toContain('Could not get the order of the stops.')
    expect(hasTabs(view)).toBe(false)
    // Rows drawn from the slots' own times are not what is saved, so there are none and Confirm waits.
    expect(view.all('.winners__row')).toHaveLength(0)
    expect(pressExact(view, 'Confirm').disabled).toBe(true)
    world.w.server.down = false
    await view.click(view.one('[data-testid=order-retry]'))
    await until(() => hasTabs(view))
    expect(view.has('[data-testid=order-failed]')).toBe(false)
    expect(pressExact(view, 'Confirm').disabled).toBeFalsy()
  })

  it('stays open and draws both orders again, with one line saying why, when the server refuses a suggested order the votes have outdated', async () => {
    const world = await voted({ hostLast: true, third: true })
    const { w, id, plan, lee } = world
    for (const slot of plan.slots) w.database.run({ as: SERVICE, kind: 'insert', table: 'votes', values: { slot_id: slot.id, user_id: lee.id, venue_id: slot.options[0].id } })
    const { view } = await draw('PlannerView', `/sessions/${id}/plan`, id)
    await until(() => !!press(view, 'Confirm plan'))
    await view.click(press(view, 'Confirm plan'))
    await until(() => hasTabs(view))
    await view.click(press(view, 'Suggested order'))
    const before = view.all('.winners__row').map((r) => view.text(r))
    // The votes change behind the page's back: Kim and Lee both move to the second place of a category, against Sam's first.
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'votes' ? held : null)
    const kim = w.database.tables.session_members.find((m) => m.role !== 'host' && m.user_id !== lee.id).user_id
    for (const user of [kim, lee.id]) w.database.run({ as: SERVICE, kind: 'update', table: 'votes', values: { venue_id: plan.slots[0].options[1].id }, filters: [eq('slot_id', plan.slots[0].id), eq('user_id', user)] })
    await view.click(pressExact(view, 'Confirm'))
    await until(() => view.text(view.one('[data-testid=order-stale]')) !== '')
    expect(view.text(view.one('[data-testid=order-stale]'))).toBe('The votes changed, so the suggested order changed too. Look at it again and confirm.')
    expect(dialogText(view)).toContain('Confirm plan?')
    expect(w.database.tables.stops).toEqual([])
    // The page then reads the votes, and the dialog shows the new winners with the voted order selected.
    w.gate.hold = null
    release()
    await until(() => view.all('.winners__row').map((r) => view.text(r)).join() !== before.join())
    await until(() => hasTabs(view))
    expect(tabs(view)[0].attrs['aria-pressed']).toBe('true')
    expect(view.text()).toContain(plan.slots[0].options[1].venue.name)
    // And confirming now works.
    await view.click(pressExact(view, 'Confirm'))
    await until(() => w.database.tables.stops.length === plan.slots.length)
  })

  it('draws the dialog again when the votes change under it, and says so', async () => {
    const world = await voted({ hostLast: true, third: true })
    const { w, id, plan, lee } = world
    for (const slot of plan.slots) w.database.run({ as: SERVICE, kind: 'insert', table: 'votes', values: { slot_id: slot.id, user_id: lee.id, venue_id: slot.options[0].id } })
    const { view } = await draw('PlannerView', `/sessions/${id}/plan`, id)
    await until(() => !!press(view, 'Confirm plan'))
    await view.click(press(view, 'Confirm plan'))
    await until(() => hasTabs(view))
    // The live region is there from the start and empty.
    expect(view.text(view.one('[data-testid=order-stale]'))).toBe('')
    const kim = w.database.tables.session_members.find((m) => m.role !== 'host' && m.user_id !== lee.id).user_id
    for (const user of [kim, lee.id]) w.database.run({ as: SERVICE, kind: 'update', table: 'votes', values: { venue_id: plan.slots[0].options[1].venue_id ?? plan.slots[0].options[1].id }, filters: [eq('slot_id', plan.slots[0].id), eq('user_id', user)] })
    await until(() => view.text(view.one('[data-testid=order-stale]')) !== '')
    expect(view.text(view.one('[data-testid=order-stale]'))).toBe('The votes changed, so the order below was updated.')
  })

  it('closes when the group is no longer voting (the plan was confirmed from another device)', async () => {
    const { view, w, id } = await open()
    await until(() => hasTabs(view))
    const row = w.database.tables.sessions.find((s) => s.id === id)
    w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed', plan_version: row.plan_version + 1 }, filters: [eq('id', id)] })
    await until(() => !dialog(view))
    expect(view.text()).not.toContain('Confirm plan?')
  })
})

describe('the itinerary', () => {
  async function drawn({ host = true, day = false } = {}) {
    const world = await confirmed({ hostLast: host })
    if (day) vi.setSystemTime(ON_THE_DAY)
    const t = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => t.view.has('.stop') || t.view.has('[data-testid=plan-load-error]'))
    return { ...world, ...t }
  }
  const names = (view) => view.all('.stop__name').map((n) => view.text(n))

  it('draws the plan the server confirmed, in order, for the host and for a guest', async () => {
    const host = await drawn()
    expect(host.view.errors).toEqual([])
    const itinerary = await host.sam.api.getItinerary(host.id)
    expect(names(host.view)).toEqual(itinerary.stops.map((s) => s.venue.name))
    const guest = await drawn({ host: false })
    expect(names(guest.view)).toHaveLength(4)
    expect(guest.view.has('[data-testid=remote-finish]')).toBe(false)
  })

  it('gives the host the edit controls and a guest none (no pencil, travel modes only to read)', async () => {
    const host = await drawn()
    expect(host.view.has('button[aria-label="Edit itinerary"]')).toBe(true)
    const guest = await drawn({ host: false })
    expect(guest.view.has('button[aria-label="Edit itinerary"]')).toBe(false)
  })

  it('has no photos link for a session on the server (photos are not shared yet)', async () => {
    const { view } = await drawn()
    expect(view.all('a').some((a) => (a.attrs.href || '').includes('/photos'))).toBe(false)
    expect(view.text()).not.toContain('Photos from the day')
  })

  it('deletes a stop for everyone when the host edits and confirms, and keeps the page on the stop that took its place', async () => {
    const { view, w, id } = await drawn()
    await view.click(view.one('button[aria-label="Edit itinerary"]'))
    const first = names(view)[1]
    await view.click(view.one(`button[aria-label="Delete stop: ${first}"]`))
    expect(dialogText(view)).toContain(`Delete ${first}?`)
    await view.click(pressExact(view, 'Delete'))
    await until(() => w.database.tables.stops.length === 3)
    await until(() => names(view).length === 3)
    expect(names(view)).not.toContain(first)
    expect(w.server.calls.filter((c) => c.route === 'deleteStop')).toHaveLength(1)
    void id
  })

  it('says "Plan confirmed" only while it is true: a stop deleted afterwards takes the card and the words read out away', async () => {
    const world = await confirmed({ hostLast: true })
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id, { justConfirmed: true })
    await until(() => view.has('.celebrate'))
    await until(() => view.all('p[role=status]').some((p) => view.text(p).startsWith('Plan confirmed.')))
    expect(view.text()).toContain('4 stops')
    await view.click(view.one('button[aria-label="Edit itinerary"]'))
    const first = names(view)[1]
    await view.click(view.one(`button[aria-label="Delete stop: ${first}"]`))
    await view.click(pressExact(view, 'Delete'))
    await until(() => names(view).length === 3)
    await until(() => !view.has('.celebrate'))
    expect(view.text()).not.toContain('Plan confirmed')
  })

  it('does not say "Plan confirmed" once the outing is finished', async () => {
    const world = await confirmed({ hostLast: true })
    vi.setSystemTime(ON_THE_DAY)
    frames()
    const { w, id } = world
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id, { justConfirmed: true })
    await until(() => view.all('p[role=status]').some((p) => view.text(p).startsWith('Plan confirmed.')))
    await view.click(press(view, 'Finish outing'))
    await view.click(pressExact(view, 'Finish outing'))
    await until(() => w.database.tables.sessions.find((s) => s.id === id).status === 'completed')
    await until(() => !view.has('.celebrate') && !view.all('p[role=status]').some((p) => view.text(p).includes('Plan confirmed')))
    expect(view.text()).not.toContain('Plan confirmed')
  })

  it('shows the trips home the server works out, the figures the finished outing\'s travel ledger keeps, and none once it is finished', async () => {
    const { view, w, id } = await drawn({ day: true })
    frames()
    await until(() => view.has('.home__row'))
    expect(w.server.calls.filter((c) => c.route === 'tripsHome')).toHaveLength(1)
    const shown = view.all('.home__row').map((r) => Number(/about (\d+) min/.exec(view.text(r))[1])).sort((a, b) => a - b)
    expect(shown.length).toBeGreaterThan(0)
    expect(view.text(view.one('.home__summary'))).toContain(`Longest about ${shown.at(-1)} min`)
    await view.click(press(view, 'Finish outing'))
    await view.click(pressExact(view, 'Finish outing'))
    await until(() => w.database.tables.sessions.find((s) => s.id === id).status === 'completed')
    const kept = w.database.tables.commute_ledger.filter((r) => r.session_id === id).map((r) => r.minutes_home).sort((a, b) => a - b)
    expect(kept).toEqual(shown)
    // A finished outing's record of the way home is the ledger, not a second figure on the plan.
    await until(() => !view.has('.home'))
  })

  it('deletes the stop the dialog was opened for, even when another device moved the stops while it was open', async () => {
    const { view, w, sam, id } = await drawn()
    await view.click(view.one('button[aria-label="Edit itinerary"]'))
    const target = names(view)[1]
    const targetVenue = w.database.tables.stops.find((s) => s.seq === 1).venue_id
    await view.click(view.one(`button[aria-label="Delete stop: ${target}"]`))
    // The host's other device moves that stop to the front before Delete is pressed: position 1 is now another stop.
    const seen = (await sam.api.getItinerary(id)).stops.map((s) => s.stopId)
    await sam.api.reorderStops(id, 1, 0, { seen })
    await until(() => names(view)[0] === target)
    expect(dialogText(view)).toContain(`Delete ${target}?`)
    await view.click(pressExact(view, 'Delete'))
    await until(() => w.database.tables.stops.length === 3)
    expect(w.database.tables.stops.some((s) => s.venue_id === targetVenue)).toBe(false)
    await until(() => !names(view).includes(target))
  })

  it('says why a change the server refused did not happen, in one line above the stops, and shows the plan as stored', async () => {
    const { view, w } = await drawn()
    await view.click(view.one('button[aria-label="Edit itinerary"]'))
    const target = names(view)[1]
    // Another device deletes it first.
    w.database.run({ as: SERVICE, kind: 'delete', table: 'stops', filters: [eq('venue_id', w.database.tables.stops.find((s) => s.seq === 1).venue_id)] })
    await view.click(view.one(`button[aria-label="Delete stop: ${target}"]`))
    await view.click(pressExact(view, 'Delete'))
    await until(() => view.all('p[role=alert]').some((p) => view.text(p) === 'That stop is not in the plan any more.'))
    await until(() => names(view).length === 3)
    expect(names(view)).not.toContain(target)
  })

  it('draws a stop whose place the server cannot describe as "A place that is no longer listed", and keeps the host\'s controls for it', async () => {
    const world = await confirmed({ hostLast: true })
    const gone = world.w.database.tables.stops.find((s) => s.seq === 1)
    world.w.database.run({ as: SERVICE, kind: 'update', table: 'stops', values: { venue_id: 'a-place-the-server-does-not-list' }, filters: [eq('id', gone.id)] })
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => view.has('.stop'))
    expect(view.has('[data-testid=plan-load-error]')).toBe(false)
    expect(names(view)).toHaveLength(4)
    expect(names(view)[1]).toBe('A place that is no longer listed')
    await view.click(view.one('button[aria-label="Edit itinerary"]'))
    // The host can still take it out, and put another place in it.
    expect(view.has('button[aria-label="Delete stop: A place that is no longer listed"]')).toBe(true)
    expect(view.all('button').some((b) => (b.attrs['aria-label'] || '').includes('A place that is no longer listed') && /Replace/.test(b.attrs['aria-label'] || ''))).toBe(true)
    await view.click(view.one('button[aria-label="Delete stop: A place that is no longer listed"]'))
    await view.click(pressExact(view, 'Delete'))
    await until(() => world.w.database.tables.stops.length === 3)
    expect(view.errors).toEqual([])
  })

  it('says it could not load the plan, with Retry, and draws it after', async () => {
    const world = await confirmed({ hostLast: true })
    world.w.gate.hold = (op) => {
      if (op.kind === 'select' && op.table === 'stops') throw new Error('Cannot reach the database.')
      return null
    }
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => view.has('[data-testid=plan-load-error]'))
    expect(view.text(view.one('[data-testid=plan-load-error]'))).toContain('Could not load this plan')
    expect(view.has('.stop')).toBe(false)
    world.w.gate.hold = null
    await view.click(press(view, 'Retry'))
    await until(() => view.has('.stop'))
    expect(view.has('[data-testid=plan-load-error]')).toBe(false)
  })

  it('says the plan could not be loaded, with Retry, when the server cannot describe the place of a stop this device has not seen', async () => {
    const world = await confirmed({ hostLast: true })
    // A place Sam's device never described (the stop is made behind its back), and the server's place list is out of reach.
    const { VENUES } = await import('../mock/venues.js')
    const used = new Set(world.w.database.tables.slot_options.map((o) => o.venue_id))
    const unseen = VENUES.find((v) => v.category === 'shop' && !used.has(v.id))
    world.w.database.run({ as: SERVICE, kind: 'insert', table: 'stops', values: { session_id: world.id, seq: 4, slot_id: null, category: 'shop', venue_id: unseen.id, planned_start_minute: 1100, duration_minutes: 60, not_before_minute: 1100 } })
    world.w.server.down = true
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => view.has('[data-testid=plan-load-error]'))
    expect(view.text(view.one('[data-testid=plan-load-error]'))).toContain('Could not load this plan')
    expect(view.has('.stop')).toBe(false)
    world.w.server.down = false
    await view.click(press(view, 'Retry'))
    await until(() => view.has('.stop'))
    expect(names(view)).toHaveLength(5)
    expect(names(view).at(-1)).toBe(unseen.name)
  })

  it('has the host finish the outing on the day, says no coins are paid, and then shows the person\'s own travel', async () => {
    const { view, w, id } = await drawn({ day: true })
    frames()
    await view.click(press(view, 'Finish outing'))
    expect(dialogText(view)).toContain('The outing ends for everyone.')
    expect(view.has('[data-testid=earns-coins]')).toBe(false)
    await view.click(pressExact(view, 'Finish outing'))
    await until(() => w.database.tables.sessions.find((s) => s.id === id).status === 'completed')
    await until(() => view.has('[data-testid=ledger-card]') && view.text(view.one('[data-testid=ledger-card]')).includes('Getting there'))
    const card = view.text(view.one('[data-testid=ledger-card]'))
    expect(card).toContain('Your travel')
    expect(card).toContain('Getting home')
    expect(card).toMatch(/Total\s*about \d+ min/)
    expect(view.text(view.one('[data-testid=ledger-compare]'))).toMatch(/group's average/)
    expect(view.text()).not.toContain('points each to spend')
    expect(view.errors).toEqual([])
  })

  it('says to a guest on the day that the host finishes the outing, and offers no Finish', async () => {
    const { view } = await drawn({ host: false, day: true })
    expect(view.text(view.one('[data-testid=host-finishes]'))).toBe('Sam finishes the outing.')
    expect(press(view, 'Finish outing')).toBeUndefined()
    expect(view.all('a').some((a) => view.text(a) === 'Back to Home')).toBe(true)
  })

  it('shows a guest the ledger when the host finishes, live, and a retry when it cannot be read', async () => {
    const { view, w, sam, id } = await drawn({ host: false, day: true })
    w.gate.hold = (op) => {
      if (op.table === 'commute_ledger') throw new Error('Cannot reach the database.')
      return null
    }
    await sam.api.endPlan(id)
    await until(() => view.has('[data-testid=ledger-none]'))
    expect(view.text(view.one('[data-testid=ledger-none]'))).toBe('Could not load your travel.')
    w.gate.hold = null
    await view.click(view.one('[data-testid=ledger-retry]'))
    await until(() => view.has('[data-testid=ledger-compare]'))
    expect(view.text(view.one('[data-testid=ledger-card]'))).toContain('Total')
  })

  it('keeps "Try again" on the page while the new read is out (disabled, so focus is not lost), with a live region that was there from the start', async () => {
    const { view, w, sam, id } = await drawn({ host: false, day: true })
    w.gate.hold = (op) => {
      if (op.table === 'commute_ledger') throw new Error('Cannot reach the database.')
      return null
    }
    await sam.api.endPlan(id)
    await until(() => view.has('[data-testid=ledger-none]'))
    // The live region is on the page already (empty when the card was drawn, then it says what is happening).
    const status = view.one('[data-testid=ledger-status]')
    expect(status.attrs.role).toBe('status')
    expect(view.text(status)).toBe('Could not load your travel.')
    const retry = view.one('[data-testid=ledger-retry]')
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.table === 'commute_ledger' ? held : null)
    const pressed = view.click(retry)
    await until(() => !!view.one('[data-testid=ledger-retry]')?.disabled)
    // The same button, still there, and disabled while the read is out.
    expect(view.one('[data-testid=ledger-retry]')).toBe(retry)
    expect(view.text(view.one('[data-testid=ledger-status]'))).toBe('Loading your travel')
    w.gate.hold = null
    release()
    await pressed
    await until(() => view.has('[data-testid=ledger-compare]'))
  })

  it('says to a person with no row that no travel was recorded for them, with no retry that could never succeed', async () => {
    const { view, w, sam, kim, id } = await drawn({ host: false, day: true })
    // Kim has no row: the server writes one only for people who were in the outing with a start.
    w.database.tables.session_members.find((m) => m.user_id === kim.id).travel_minutes = null
    const original = w.database.run.bind(w.database)
    w.gate.hold = null
    await sam.api.endPlan(id)
    await until(() => view.has('[data-testid=ledger-compare]'))
    w.database.run({ as: SERVICE, kind: 'delete', table: 'commute_ledger', filters: [eq('user_id', kim.id)] })
    void original
    // Read again (a reload): the answer has no row, and the card says so.
    const { useEventsStore } = await import('../../stores/events.js')
    await useEventsStore().loadLedger(id)
    await until(() => view.text(view.one('[data-testid=ledger-none]')) === 'No travel was recorded for you.')
    expect(view.has('[data-testid=ledger-retry]')).toBe(false)
  })

  it('draws a finished outing without the ledger of anyone else: only the person\'s own totals', async () => {
    const { view, w, sam, kim, id } = await drawn({ host: false, day: true })
    await sam.api.endPlan(id)
    await until(() => view.has('[data-testid=ledger-compare]'))
    const mine = w.database.tables.commute_ledger.find((r) => r.user_id === kim.id)
    const theirs = w.database.tables.commute_ledger.find((r) => r.user_id === sam.id)
    expect(mine.total_minutes).not.toBe(theirs.total_minutes)
    expect(view.text(view.one('[data-testid=ledger-card]'))).toMatch(new RegExp(`Total\\s*about ${mine.total_minutes} min`))
    expect(view.text(view.one('[data-testid=ledger-card]'))).not.toMatch(new RegExp(`Total\\s*about ${theirs.total_minutes} min`))
  })
})

describe('the question "Re-plan?"', () => {
  async function asked({ host }) {
    const world = await confirmed({ hostLast: host })
    world.w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { replan: { reason: 'Kim opted out.', trigger: { kind: 'optout' }, at: 1 }, plan_version: world.w.database.tables.sessions[0].plan_version + 1 }, filters: [eq('id', world.id)] })
    const t = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => t.view.has('.stop'))
    return { ...world, ...t }
  }

  it('gives the host Re-plan and Keep plan, and keeping the plan turns the question off for everyone', async () => {
    const { view, w, id } = await asked({ host: true })
    expect(view.text()).toContain('Re-plan? Kim opted out.')
    await view.click(press(view, 'Keep plan'))
    await until(() => !view.text().includes('Re-plan? Kim opted out.'))
    expect(w.database.tables.sessions.find((s) => s.id === id)).toMatchObject({ replan: null, status: 'confirmed' })
  })

  it('takes the host back to voting when they re-plan', async () => {
    const { view, w, id, router } = await asked({ host: true })
    await view.click(press(view, 'Re-plan'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    expect(w.database.tables.sessions.find((s) => s.id === id).status).toBe('voting')
  })

  it('tells a guest who decides, with no buttons', async () => {
    const { view } = await asked({ host: false })
    expect(view.text()).toContain('Re-plan? Kim opted out. Sam decides.')
    expect(press(view, 'Keep plan')).toBeUndefined()
  })

  it('says why the answer did not go through, and leaves the buttons to try again', async () => {
    const { view, w } = await asked({ host: true })
    w.server.down = true
    await view.click(press(view, 'Keep plan'))
    await until(() => view.has('[data-testid=replan-error]'))
    expect(view.text(view.one('[data-testid=replan-error]'))).toMatch(/Cannot reach the Jio planner/)
    expect(press(view, 'Keep plan')).toBeTruthy()
    w.server.down = false
    await view.click(press(view, 'Keep plan'))
    await until(() => !view.text().includes('Re-plan? Kim opted out.'))
  })
})

describe('the places waiting to be added, and What next?', () => {
  it('shows the host a proposed place with Add to plan, and adds it to the plan for everyone', async () => {
    const world = await confirmed({ hostLast: true })
    vi.setSystemTime(ON_THE_DAY)
    const place = (await world.kim.api.roamNearby(world.id)).places.find((p) => p.state === 'free')
    await world.kim.api.proposeStop(world.id, world.kim.id, place.id)
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => view.has('[data-testid=proposed-stops]'))
    expect(view.text(view.one('[data-testid=proposed-stops]'))).toContain(place.venue.name)
    expect(view.text(view.one('[data-testid=proposed-stops]'))).toContain('Proposed by Kim')
    await view.click(view.one(`button[aria-label="Add to plan: ${place.venue.name}"]`))
    await until(() => world.w.database.tables.stops.length === 5)
    await until(() => names(view).length === 5)
    expect(names(view).at(-1)).toBe(place.venue.name)
    expect(view.has('[data-testid=proposed-stops]')).toBe(false)
  })

  const names = (view) => view.all('.stop__name').map((n) => view.text(n))

  it('tells a guest that the host decides, and lets the proposer take their own back', async () => {
    const world = await confirmed()
    vi.setSystemTime(ON_THE_DAY)
    const place = (await world.kim.api.roamNearby(world.id)).places.find((p) => p.state === 'free')
    await world.kim.api.proposeStop(world.id, world.kim.id, place.id)
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => view.has('[data-testid=proposed-stops]'))
    expect(view.text(view.one('[data-testid=proposed-stops]'))).toContain('Waiting for Sam to decide')
    expect(view.has(`button[aria-label="Add to plan: ${place.venue.name}"]`)).toBe(false)
    await view.click(view.one(`button[aria-label="Take back your proposal of ${place.venue.name}"]`))
    await until(() => !view.has('[data-testid=proposed-stops]'))
    expect(world.w.database.tables.stop_proposals[0].status).toBe('dismissed')
  })

  it('lists the places near the group on What next? and proposes one for the host', async () => {
    const world = await confirmed()
    vi.setSystemTime(ON_THE_DAY)
    const { view } = await draw('RoamView', `/sessions/${world.id}/roam`, world.id)
    await until(() => view.has('article[data-option]') || view.all('button').some((b) => view.text(b).startsWith('Propose')))
    const propose = view.all('button').find((b) => (b.attrs['aria-label'] || '').startsWith('Propose '))
    expect(propose).toBeTruthy()
    const name = propose.attrs['aria-label'].replace(/^Propose (.*) as the next stop$/, '$1')
    await view.click(propose)
    await until(() => world.w.database.tables.stop_proposals.length === 1)
    expect(world.w.database.tables.stop_proposals[0]).toMatchObject({ proposed_by: world.kim.id, status: 'pending' })
    await until(() => view.text().includes('Proposed by you'))
    expect(view.text()).toContain(name)
    expect(view.errors).toEqual([])
  })
})

describe('photos and the map of a shared outing', () => {
  it('says photos are not shared yet, with the way back, and offers no camera', async () => {
    const world = await confirmed({ hostLast: true })
    const { view } = await draw('EventView', `/sessions/${world.id}/itinerary`, world.id)
    await until(() => view.has('.stop'))
    SCREENS.PhotosView = () => import('@/views/PhotosView.vue')
    const photos = await draw('PhotosView', `/sessions/${world.id}/photos`, world.id)
    await until(() => photos.view.has('[data-testid=photos-later]'))
    expect(photos.view.text(photos.view.one('[data-testid=photos-later]'))).toContain('Photos are not shared yet')
    expect(photos.view.all('a').some((a) => photos.view.text(a) === 'Back to the itinerary')).toBe(true)
    expect(photos.view.has('input[type=file]')).toBe(false)
    expect(photos.view.has('button[aria-label="Add photos"]')).toBe(false)
  })

  it('refuses a photo for a shared outing in words', async () => {
    const world = await confirmed()
    await expect(world.kim.api.addPhoto(world.id, world.kim.id, 'data:image/png;base64,AAAA')).rejects.toThrow('Photos are not shared yet. They come in a later update.')
    expect(await world.kim.api.getPhotos(world.id)).toEqual([])
    await expect(world.kim.api.deletePhoto(world.id, 'p1')).rejects.toThrow('Photos are not shared yet')
  })

  it('follows a change to the stops on the full-screen map, live', async () => {
    SCREENS.SessionMapView = () => import('@/views/SessionMapView.vue')
    const world = await confirmed({ hostLast: false })
    const { view } = await draw('SessionMapView', `/sessions/${world.id}/map`, world.id)
    await until(() => view.all('li').length >= 4)
    const before = view.all('li').length
    const first = (await world.sam.api.getItinerary(world.id)).stops[1]
    await world.sam.api.deleteStop(world.id, 1, { stopId: first.stopId })
    await until(() => view.all('li').length === before - 1)
  })
})

describe('replacing a stop of a shared plan', () => {
  it('lists the places that could take the stop\'s place and puts the chosen one in, for everyone', async () => {
    const world = await confirmed({ hostLast: true })
    const itinerary = await world.sam.api.getItinerary(world.id)
    const drink = itinerary.stops.find((s) => s.category === 'drink')
    const { view, router } = await draw('PlannerView', `/sessions/${world.id}/plan?replace=${drink.slotId}`, world.id)
    await until(() => view.has('[data-testid=replace-options]'))
    expect(view.text(view.one('[data-testid=replace-view]'))).toContain(drink.venue.name)
    const use = view.all('button').find((b) => (b.attrs['aria-label'] || '').startsWith('Use '))
    const chosen = use.attrs['aria-label'].replace(/^Use (.*) instead$/, '$1')
    await view.click(use)
    await until(() => router.currentRoute.value.path === `/sessions/${world.id}/itinerary`)
    const after = await world.kim.api.getItinerary(world.id)
    expect(after.stops.find((s) => s.slotId === drink.slotId).venue.name).toBe(chosen)
  })

  it('says why a place could not be put in, and offers the places again', async () => {
    const world = await confirmed({ hostLast: true })
    const drink = (await world.sam.api.getItinerary(world.id)).stops.find((s) => s.category === 'drink')
    const { view } = await draw('PlannerView', `/sessions/${world.id}/plan?replace=${drink.slotId}`, world.id)
    await until(() => view.has('[data-testid=replace-options]'))
    // Another device replaced the stop meanwhile, with a place of the eat category this device knows.
    const other = world.w.database.tables.slot_options.find((o) => !world.w.database.tables.stops.some((s) => s.venue_id === o.venue_id)).venue_id
    world.w.database.run({ as: SERVICE, kind: 'update', table: 'stops', values: { venue_id: other }, filters: [eq('id', drink.stopId)] })
    await view.click(view.all('button').find((b) => (b.attrs['aria-label'] || '').startsWith('Use ')))
    await until(() => view.has('[data-testid=replace-error]'))
    expect(view.text(view.one('[data-testid=replace-error]'))).toContain('That stop has changed. Look at the plan again.')
  })

  it('tells a guest that only the host replaces a stop', async () => {
    const world = await confirmed()
    const drink = (await world.kim.api.getItinerary(world.id)).stops.find((s) => s.category === 'drink')
    const { view } = await draw('PlannerView', `/sessions/${world.id}/plan?replace=${drink.slotId}`, world.id)
    await until(() => view.has('[data-testid=replace-host-only]'))
    expect(view.text(view.one('[data-testid=replace-host-only]'))).toContain('Only the host can replace a stop')
  })
})
