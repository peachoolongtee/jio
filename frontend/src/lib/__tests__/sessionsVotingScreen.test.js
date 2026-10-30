// The Vote page of a shared session (stage 4), drawn for real on an in-memory page (domless.js) on the stand-in database and the stand-in
// Jio server: the places the server offered, a vote that shows at once and is taken back if refused, the other person's vote arriving live,
// the radius (the host's to change), the failure state with its retry, a person who opted out, and who confirms the plan (stage 5:
// sessionsPlanScreen.test.js has the Confirm dialog). No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { KIM_PLACE, SAM_PLACE, world } from './sessionsWorld.js'
import { SERVICE } from '../../components/dev/fakeDatabase.js'

// The map needs a real browser (Leaflet).
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/spots/SpotPins.vue', () => ({ default: { name: 'SpotPins', render: () => null } }))

vi.setConfig({ testTimeout: 40000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const eq = (col, value) => ({ col, op: 'eq', value })
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))
const voteButton = (view, name) => view.one(`button[aria-label="Vote for ${name}"]`)

// Draw the Vote page of the app opened last, signed in as that person.
// How to call: const t = await draw(id)
async function draw(id) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const events = (await import('@/stores/events.js')).useEventsStore()
  const planner = (await import('@/stores/planner.js')).usePlannerStore()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(`/sessions/${id}/plan`)
  const { default: View } = await import('@/views/PlannerView.vue')
  const view = await mountScreen(View, { plugins: [pinia, router], props: { id } })
  return { view, router, events, planner }
}

// Sam hosts a session with Kim in it, both with a start, the first spot confirmed. The page is drawn for the app opened last: the host's
// by default, or Kim's (`guest`).
// How to call: const { w, sam, kim, id } = await voting({ guest: true })
async function voting({ guest = false } = {}) {
  const w = world()
  let sam
  let kim
  if (guest) {
    sam = await w.open(PROFILE)
    kim = await w.open(OTHER)
  } else {
    kim = await w.open(OTHER)
    sam = await w.open(PROFILE)
  }
  const { id } = await sam.api.createSession({ ...SESSION })
  await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
  await sam.api.startSession(id)
  await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
  await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
  await sam.api.useMeetingArea(id)
  w.server.calls.length = 0
  return { w, sam, kim, id }
}

const firstCard = async (sam, id) => {
  const slot = (await sam.api.getPlan(id)).slots[0]
  return { slot, option: slot.options[0] }
}

describe('the places and the way back', () => {
  it('lists the places the server offered in every category, with no planner call and no sign of the old placeholder', async () => {
    const { w, sam, id } = await voting()
    const { view } = await draw(id)
    await until(() => view.has('article[data-option]'))
    expect(view.errors).toEqual([])
    const plan = await sam.api.getPlan(id)
    for (const slot of plan.slots) {
      for (const option of slot.options) expect(view.has(`article[data-option="${option.id}"]`)).toBe(true)
    }
    expect(view.has('[data-testid=voting-next]')).toBe(false)
    expect(view.text()).not.toContain('Voting with friends comes next')
    expect(view.text()).toContain('Walking times are from')
    // Nothing was asked of the planner: the page read the database, the cards' places (once) from the server's place list, and the
    // outing's dietary needs (GET .../dietary, for the chips).
    expect(w.server.calls.every((c) => ['venues', 'getDietary'].includes(c.route))).toBe(true)
  })

  it('says it is finding places while it loads', async () => {
    const { w, id } = await voting()
    let release
    const held = new Promise((resolve) => { release = resolve })
    // The session itself loads first (its own read of the places); the plan's read is the second, and it is the one held.
    let reads = 0
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'slot_options' && (reads += 1) >= 2 ? held : null)
    const { view } = await draw(id)
    await until(() => view.all('p.sr-only').some((p) => view.text(p).includes('Finding places')))
    expect(view.has('article[data-option]')).toBe(false)
    w.gate.hold = null
    release()
    await until(() => view.has('article[data-option]'))
  })

  it('gives the host Confirm plan (off until two have voted), with no sentence about a next update', async () => {
    const { id } = await voting()
    const { view } = await draw(id)
    await until(() => view.has('article[data-option]'))
    expect(view.has('[data-testid=confirm-next]')).toBe(false)
    expect(view.text()).not.toContain('comes in the next update')
    expect(press(view, 'Needs 2 voters').disabled).toBe(true)
    expect(press(view, 'Confirm plan')).toBeUndefined()
  })

  it('tells a guest who confirms the plan, and gives the way back to the people', async () => {
    const { id } = await voting({ guest: true })
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=confirm-waiting]'))
    // The host's name is read from their profile a moment after the page is drawn.
    await until(() => view.text(view.one('[data-testid=confirm-waiting]')).includes('Waiting for Sam to confirm the plan.'))
    expect(view.all('a').some((a) => view.text(a).includes('Back to the people'))).toBe(true)
    expect(press(view, 'Confirm plan')).toBeUndefined()
    expect(press(view, 'Needs 2 voters')).toBeUndefined()
  })

  it('shows a failure with a retry when the places cannot be loaded, and the page works after it', async () => {
    const { w, id } = await voting()
    w.server.down = true
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=plan-error]'))
    expect(view.text(view.one('[data-testid=plan-error]'))).toMatch(/Cannot reach|Jio could not be reached/)
    expect(view.has('article[data-option]')).toBe(false)
    w.server.down = false
    await view.click(press(view, 'Try again'))
    await until(() => view.has('article[data-option]'))
    expect(view.has('[data-testid=plan-error]')).toBe(false)
  })
})

describe('voting', () => {
  it('writes the vote, marks the card "Voted" and counts the person in the donut, and taps again to take it back', async () => {
    const { w, sam, id } = await voting()
    const { slot, option } = await firstCard(sam, id)
    const { view } = await draw(id)
    await until(() => view.has(`article[data-option="${option.id}"]`))
    const name = option.venue.name
    expect(view.text(voteButton(view, name))).toBe('Vote')
    await view.click(voteButton(view, name))
    await until(() => view.text(voteButton(view, name)) === 'Voted')
    expect(w.database.tables.votes).toMatchObject([{ slot_id: slot.id, user_id: sam.id, venue_id: option.id }])
    expect(view.text(view.one(`article[data-option="${option.id}"]`))).toContain('You voted')
    await view.click(voteButton(view, name))
    await until(() => view.text(voteButton(view, name)) === 'Vote')
    expect(w.database.tables.votes).toEqual([])
    // No request went to the Jio server for any of it but the reads of the places and the outing's needs, and the planner was never asked.
    expect(w.server.calls.every((c) => ['venues', 'getDietary'].includes(c.route))).toBe(true)
  })

  it('shows the person\'s own vote before the database has answered', async () => {
    const { w, sam, id } = await voting()
    const { option } = await firstCard(sam, id)
    const { view } = await draw(id)
    await until(() => view.has(`article[data-option="${option.id}"]`))
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.kind === 'insert' && op.table === 'votes' ? held : null)
    await view.click(voteButton(view, option.venue.name))
    await until(() => view.text(voteButton(view, option.venue.name)) === 'Voted')
    w.gate.hold = null
    release()
    await until(() => w.database.tables.votes.length === 1)
    await until(() => view.text(voteButton(view, option.venue.name)) === 'Voted')
  })

  it('takes the vote back and says why when the database refuses it, and leaves a vote the group moved on from alone', async () => {
    const { w, sam, id } = await voting()
    const { option } = await firstCard(sam, id)
    const { view } = await draw(id)
    await until(() => view.has(`article[data-option="${option.id}"]`))
    // The host has confirmed the plan on another device; this page does not know yet.
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    await view.click(voteButton(view, option.venue.name))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toBe('Votes are read-only once the plan is confirmed.')
    await until(() => view.text(voteButton(view, option.venue.name)) === 'Vote' || !view.has(`button[aria-label="Vote for ${option.venue.name}"]`))
    expect(w.database.tables.votes).toEqual([])
  })

  it('shows the other person\'s vote on this device live, with their name, and the leader', async () => {
    const { sam, kim, id } = await voting()
    const { slot, option } = await firstCard(sam, id)
    const { view } = await draw(id)
    await until(() => view.has(`article[data-option="${option.id}"]`))
    await vi.waitFor(() => expect(sam.fake.state.dataClient.getChannels()).toHaveLength(1))
    const card = () => view.text(view.one(`article[data-option="${option.id}"]`))
    expect(card()).not.toContain('Kim voted')
    await kim.api.vote(id, slot.id, kim.id, option.id)
    await until(() => card().includes('Kim voted'))
    expect(card()).toContain('Leading')
    await kim.api.vote(id, slot.id, kim.id, option.id)
    await until(() => !card().includes('Kim voted'))
  })
})

describe('the radius', () => {
  it('lets the host choose one, and shows it', async () => {
    const { w, id } = await voting()
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=radius]'))
    await view.click(press(view, '1 km'))
    await until(() => w.server.calls.some((c) => c.route === 'radius'))
    expect(w.server.calls.find((c) => c.route === 'radius').body).toEqual({ radiusMeters: 1000 })
    await until(() => view.text(view.one('[data-testid=radius]')).includes('Only places within 1 km'))
    expect(w.database.tables.sessions[0].radius_meters).toBe(1000)
  })

  it('shows a guest the host\'s radius as a line, not as choices', async () => {
    const { sam, id } = await voting({ guest: true })
    await sam.api.setRadius(id, 2000)
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=radius-readonly]'))
    expect(view.text(view.one('[data-testid=radius-readonly]'))).toContain('2 km')
    expect(view.text(view.one('[data-testid=radius-readonly]'))).toContain('set by Sam')
    expect(view.has('[data-testid=radius]')).toBe(false)
  })

  it('says why in plain words when the radius cannot be set, and offers the choices again', async () => {
    const { w, id } = await voting()
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=radius]'))
    w.server.down = true
    await view.click(press(view, '500 m'))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toMatch(/Cannot reach|could not be reached/)
    w.server.down = false
    await view.click(press(view, '500 m'))
    await until(() => w.database.tables.sessions[0].radius_meters === 500)
  })
})

describe('a person who opted out', () => {
  it('is told so, cannot vote, and can rejoin', async () => {
    const { w, kim, id } = await voting({ guest: true })
    await kim.api.optOut(id, kim.id)
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=opted-out]'))
    expect(view.text(view.one('[data-testid=opted-out]'))).toContain("You opted out of this session, so you can't vote")
    expect(view.all('button').filter((b) => view.text(b) === 'Vote')).toEqual([])
    await view.click(press(view, 'Rejoin'))
    await until(() => !view.has('[data-testid=opted-out]'))
    expect(w.database.tables.session_members.every((m) => m.state === 'joined')).toBe(true)
    await until(() => view.all('button').some((b) => view.text(b) === 'Vote'))
  })
})

describe('more places and the search', () => {
  it('asks the server for more places and shows them', async () => {
    const { w, id } = await voting()
    const { view } = await draw(id)
    await until(() => view.has('article[data-option]'))
    const before = view.all('article[data-option]').length
    const more = view.all('button').filter((b) => view.text(b) === 'More places' && !b.disabled)[0]
    expect(more).toBeTruthy()
    await view.click(more)
    await until(() => w.server.calls.some((c) => c.route === 'moreOptions'))
    await until(() => view.all('article[data-option]').length > before)
  })
})

describe('voting that is waiting for a start (the server took the meeting area away)', () => {
  // Nobody has a start the server could plan from: the area and the places are gone, as the server leaves a voting session in that case.
  // `kimHasStart` false takes Kim's start as well.
  const pause = (w, id, { kimHasStart = false } = {}) => {
    w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { meeting_area_id: null, meeting_method: null }, filters: [eq('id', id)] })
    if (!kimHasStart) w.database.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { start_area_id: null }, filters: [eq('session_id', id), eq('user_id', w.database.tables.session_members.find((m) => m.role !== 'host').user_id)] })
    w.database.run({ as: SERVICE, kind: 'delete', table: 'slot_options', filters: [] })
  }

  it('says why there is nothing to vote on, in the server\'s words, and sends a person with no start to share one', async () => {
    const { w, id } = await voting({ guest: true })
    pause(w, id)
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=waiting-for-starts]'))
    const empty = view.one('[data-testid=waiting-for-starts]')
    expect(view.text(empty)).toContain('Places open once two people have shared where they start.')
    expect(view.text(empty)).toContain('No meeting area yet')
    // Kim has no start: the button says what to do, and goes to the page where it is done.
    const share = view.all('a').find((a) => view.text(a) === 'Share where you start')
    expect(share).toBeTruthy()
    expect(share.attrs.href).toBe(`/sessions/${id}`)
    // A guest cannot call the outing off.
    expect(view.has('[data-testid=cancel-waiting]')).toBe(false)
    expect(view.all('button').filter((b) => view.text(b) === 'Vote')).toEqual([])
  })

  it('gives the host a way to cancel, which asks first, and cancels the outing', async () => {
    const { w, id } = await voting()
    pause(w, id)
    const { view } = await draw(id)
    await until(() => view.has('[data-testid=cancel-waiting]'))
    // Sam has a start, so the way back is the people page under its own name.
    expect(view.all('a').some((a) => view.text(a) === 'People')).toBe(true)
    expect(view.text(view.one('[data-testid=waiting-for-starts]'))).toContain('Places open once two people have shared where they start.')
    await view.click(view.one('[data-testid=cancel-waiting]'))
    await until(() => view.has('[data-testid=cancel-waiting-confirm]'))
    expect(w.database.tables.sessions[0].status).toBe('voting')
    await view.click(view.one('[data-testid=cancel-waiting-confirm]'))
    await until(() => w.database.tables.sessions[0].status === 'cancelled')
  })

  it('keeps the old "no meeting area yet" page, without the voting words, for a session that is still being set up', async () => {
    const { w, id } = await voting()
    pause(w, id)
    w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'locating' }, filters: [eq('id', id)] })
    const { view } = await draw(id)
    await until(() => view.text().includes('No meeting area yet'))
    expect(view.has('[data-testid=waiting-for-starts]')).toBe(false)
    expect(view.has('[data-testid=cancel-waiting]')).toBe(false)
  })
})
