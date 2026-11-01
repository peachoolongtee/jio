// The Start choice for a real account, drawn for real on an in-memory page (domless.js) on the stand-in database and the stand-in Jio
// server: the host's two cards and what the main button says, the follow-up (a popular area, a search), location
// refused, a failed save and its retry, and what a guest reads on the Locate step, live. No network. The arrow keys and the layout are
// checked in a browser (the in-memory page has no MutationObserver or layout).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { world } from './sessionsWorld.js'

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
const SCREENS = {
  'views/GroupDetailView': () => import('@/views/GroupDetailView.vue'),
  'views/StartView': () => import('@/views/StartView.vue'),
}

// Draw a screen of the app signed in as the person opened last.
// How to call: const t = await draw('views/StartView', `/sessions/${id}/start`, { id })
async function draw(file, path, props = {}) {
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
  const { default: View } = await SCREENS[file]()
  const view = await mountScreen(View, { plugins: [pinia, router], props })
  return { view, router, auth, events }
}

// Sam hosts a session with Kim in it, still inviting. `guest` opens Kim last (so a screen is Kim's), otherwise Sam is last.
// How to call: const { w, sam, kim, id } = await started({ guest: true })
async function started({ guest = false } = {}) {
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
  return { w, sam, kim, id }
}

// A geolocation that answers with a position, or refuses (code 1 is "permission denied").
// How to call: vi.stubGlobal('navigator', geo({ lat: 1.3521, lng: 103.9448 }))
const geo = (position, code = 1) => ({
  geolocation: { getCurrentPosition: (ok, no) => (position ? ok({ coords: { latitude: position.lat, longitude: position.lng } }) : no({ code })) },
})
const row = (w, id) => w.database.tables.sessions.find((s) => s.id === id)
const chip = (view, name) => view.all('button').find((b) => b.attrs.role === 'radio' && view.text(b) === name)
// The main button at the foot: "Next" on the choice, "Meet at <area>" on the follow-up.
const nextButton = (view) => view.one('[data-testid=start-next]')

describe('the host\'s choice screen', () => {
  it('shows the two cards with the fairest spot chosen, and Next under them', async () => {
    const { w, id } = await started()
    const { view } = await draw('views/StartView', `/sessions/${id}/start`, { id })
    await until(() => view.text().includes('How do you want to pick the meeting point?'))
    expect(view.errors).toEqual([])
    const [fair, known] = view.all('button').filter((b) => b.attrs.role === 'radio')
    expect(view.text(fair)).toContain('Find the fairest spot')
    expect(view.text(fair)).toContain('Default')
    expect(view.text(fair)).toContain('Best when people start from different places')
    expect(view.text(known)).toContain('We already know where')
    expect(view.text(known)).toContain('Best when the group has already agreed on an area')
    // Each card is named by its title and described by the rest.
    for (const card of [fair, known]) {
      expect(card.attrs['aria-labelledby']).toMatch(/-title$/)
      expect(card.attrs['aria-describedby']).toMatch(/-text.*-meta$/)
    }
    expect(fair.attrs['aria-checked']).toBe('true')
    expect(known.attrs['aria-checked']).toBe('false')
    expect(view.all('[role=radiogroup]')).toHaveLength(1)
    // No note under the button, which is "Next" for either card (Faith's walkthrough, 30 October 2026).
    expect(view.text()).not.toContain('Guests see that you chose this.')
    expect(view.text(nextButton(view))).toContain('Next')
    await view.click(known)
    expect(known.attrs['aria-checked']).toBe('true')
    expect(fair.attrs['aria-checked']).toBe('false')
    expect(view.text(nextButton(view))).toContain('Next')
    // Choosing saves nothing.
    expect(row(w, id)).toMatchObject({ status: 'inviting', meet_by: null })
  })

  it('starts the session with the fairest spot saved in the same update, and hands over to the session page', async () => {
    const { w, id } = await started()
    const { view, router } = await draw('views/StartView', `/sessions/${id}/start`, { id })
    await until(() => view.has('[data-testid=start-view]'))
    await view.click(nextButton(view))
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
    expect(row(w, id)).toMatchObject({ status: 'locating', meet_by: 'fairest' })
    const update = w.ops.find((op) => op.kind === 'update' && op.table === 'sessions')
    expect(update.values).toEqual({ status: 'locating', meet_by: 'fairest' })
  })

  it('goes on to the follow-up for "We already know where", without saving, and Back returns to the cards', async () => {
    const { w, id } = await started()
    const { view, router } = await draw('views/StartView', `/sessions/${id}/start`, { id })
    await until(() => view.has('[data-testid=start-view]'))
    await view.click(view.all('button').filter((b) => b.attrs.role === 'radio')[1])
    await view.click(nextButton(view))
    await until(() => view.text().includes('Pick the meeting area'))
    expect(router.currentRoute.value.query.where).toBe('1')
    expect(view.text()).not.toContain('The group then goes straight to choosing places.')
    expect(row(w, id)).toMatchObject({ status: 'inviting', meet_by: null })
    await router.push(`/sessions/${id}/start`)
    await until(() => view.text().includes('How do you want to pick the meeting point?'))
  })

  it('sends a person who is not the host, and a session that has already started, back to the session page', async () => {
    const guest = await started({ guest: true })
    const g = await draw('views/StartView', `/sessions/${guest.id}/start`, { id: guest.id })
    await until(() => g.router.currentRoute.value.path === `/sessions/${guest.id}`)
    const host = await started()
    await host.sam.api.startSession(host.id, { meetBy: 'fairest' })
    const h = await draw('views/StartView', `/sessions/${host.id}/start`, { id: host.id })
    await until(() => h.router.currentRoute.value.path === `/sessions/${host.id}`)
  })

  it('says the database\'s sentence when the start is refused, and keeps the button', async () => {
    const { w, id } = await started()
    const { view } = await draw('views/StartView', `/sessions/${id}/start`, { id })
    await until(() => view.has('[data-testid=start-view]'))
    w.database.tables.session_members.splice(1, 1)
    await view.click(nextButton(view))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toBe('A session needs at least two people before it can start.')
    expect(nextButton(view).disabled).toBe(false)
  })
})

describe('a stale device', () => {
  it('cannot rewrite the choice of a session that already started on another device', async () => {
    const { w, sam, id } = await started()
    await sam.api.startSession(id, { meetBy: 'known' })
    await expect(sam.api.startSession(id, { meetBy: 'fairest' })).rejects.toThrow('Only the host can start a session, and only once.')
    expect(row(w, id)).toMatchObject({ status: 'locating', meet_by: 'known' })
  })
})

describe('the follow-up for "We already know where"', () => {
  it('lists the popular areas then every other one, finds an area by search, and names the chosen one on the button', async () => {
    const { id } = await started()
    const { view } = await draw('views/StartView', `/sessions/${id}/start?where=1`, { id })
    await until(() => view.text().includes('Pick the meeting area'))
    const names = view.all('button').filter((b) => b.attrs.role === 'radio').map((b) => view.text(b))
    expect(names.slice(0, 7)).toEqual(['Bishan', 'Tampines', 'Jurong East', 'Bugis', 'Orchard', 'Punggol', 'Woodlands'])
    expect(names.length).toBeGreaterThan(30)
    expect(view.text()).toContain('Popular areas')
    expect(view.text()).toContain('All areas')
    expect(press(view, 'Meet at Bishan')).toBeTruthy()
    // No "We're here now": the host picks an area (Faith's walkthrough, 30 October 2026).
    expect(view.text()).not.toContain("We're here now")
    expect(view.all('[role=radiogroup]').map((g) => g.attrs['aria-label'])).toEqual(['Popular areas'])
    await view.click(chip(view, 'Orchard'))
    expect(press(view, 'Meet at Orchard')).toBeTruthy()
    view.type('input[type=text]', 'jurong')
    await view.tick()
    expect(view.all('button').filter((b) => b.attrs.role === 'radio').map((b) => view.text(b)).slice(0, 1)).toEqual(['Jurong East'])
    expect(view.text()).toContain('Areas that match')
    // The chosen area stays on screen, so the button never names an area that is hidden.
    expect(chip(view, 'Orchard')).toBeTruthy()
    expect(press(view, 'Meet at Orchard')).toBeTruthy()
    view.type('input[type=text]', 'zzz')
    await view.tick()
    expect(view.text()).toContain('No area matches that.')
    expect(chip(view, 'Orchard').attrs['aria-checked']).toBe('true')
  })

  it('starts the session with the choice saved as known, names the area through the known place, and goes on to choosing places', async () => {
    const { w, id } = await started()
    const { view, router } = await draw('views/StartView', `/sessions/${id}/start?where=1`, { id })
    await until(() => view.text().includes('Pick the meeting area'))
    await view.click(chip(view, 'Tampines'))
    await view.click(press(view, 'Meet at Tampines'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    expect(row(w, id)).toMatchObject({ status: 'voting', meet_by: 'known', meeting_area_id: 'tampines', meeting_method: 'chosen' })
    expect(w.server.calls.map((c) => c.route)).toContain('knownPlace')
  })

  it('stays open when naming the area fails after the start, keeps the choice, and the next press only names the area', async () => {
    const { w, id } = await started()
    const { view, router } = await draw('views/StartView', `/sessions/${id}/start?where=1`, { id })
    await until(() => view.text().includes('Pick the meeting area'))
    w.server.down = true
    await view.click(press(view, 'Meet at Bishan'))
    await until(() => view.has('p[role=alert]'))
    expect(row(w, id)).toMatchObject({ status: 'locating', meet_by: 'known' })
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/start`)
    expect(view.has('[data-testid=start-view]')).toBe(true)
    w.server.down = false
    w.ops.length = 0
    await view.click(press(view, 'Meet at Bishan'))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    expect(w.ops.some((op) => op.kind === 'update' && op.table === 'sessions' && 'meet_by' in (op.values || {}))).toBe(false)
    expect(row(w, id)).toMatchObject({ status: 'voting', meet_by: 'known', meeting_area_id: 'bishan' })
  })
})

describe('what a guest reads on the Locate step', () => {
  it('names the host\'s choice: the fairest spot', async () => {
    const { sam, id } = await started({ guest: true })
    await sam.api.startSession(id, { meetBy: 'fairest' })
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    // The host's name arrives with the people list a moment after the session.
    await until(() => view.has('[data-testid=meet-by-note]') && view.text().includes('Sam chose'))
    expect(view.text(view.one('[data-testid=meet-by-note]'))).toBe("Sam chose to find the fairest spot. Add where you are starting. Jio then finds the meeting point that is fair on everyone's trip. You can still suggest a spot.")
    expect(view.has('[data-testid=meet-by-pending]')).toBe(false)
  })

  it('says the host chose the place until it is set, then shows today\'s confirmed view, live', async () => {
    const { w, sam, id } = await started({ guest: true })
    await sam.api.startSession(id, { meetBy: 'known' })
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.has('[data-testid=meet-by-note]') && view.text().includes('Sam chose'))
    expect(view.text(view.one('[data-testid=meet-by-note]'))).toContain('Sam chose the place.')
    await sam.api.setKnownPlace(id, 'bugis')
    await until(() => !view.has('[data-testid=meet-by-note]'))
    await until(() => view.text().includes('Meeting spot') && view.text().includes('Bugis'))
    expect(row(w, id).meet_by).toBe('known')
  })

  it('keeps "fairest" when the host\'s "We already have a place" fails, so nobody reads "chose the place" for a place that was never set', async () => {
    const { w, sam, id } = await started({ guest: true })
    await sam.api.startSession(id, { meetBy: 'fairest' })
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Sam chose to find the fairest spot.'))
    w.server.down = true
    await expect(sam.api.setKnownPlace(id, 'orchard')).rejects.toThrow()
    w.server.down = false
    // The browser wrote nothing for the choice: the server records it together with the place.
    expect(row(w, id)).toMatchObject({ status: 'locating', meet_by: 'fairest' })
    await view.tick()
    expect(view.text()).toContain('Sam chose to find the fairest spot.')
  })

  it('has the server record "known" with the place when the host switches while locating, with no extra write from the browser', async () => {
    const { w, sam, id } = await started({ guest: true })
    await sam.api.startSession(id, { meetBy: 'fairest' })
    w.ops.length = 0
    await sam.api.setKnownPlace(id, 'orchard')
    expect(row(w, id)).toMatchObject({ status: 'voting', meet_by: 'known', meeting_area_id: 'orchard' })
    expect(w.ops.some((op) => op.kind === 'update' && op.table === 'sessions')).toBe(false)
  })

  it('says nothing for a session that started before the choice existed', async () => {
    const { sam, id } = await started({ guest: true })
    await sam.api.startSession(id)
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet') || view.text().includes('Add where you are starting'))
    expect(view.has('[data-testid=meet-by-note]')).toBe(false)
  })
})

describe('what the host reads on the Locate step', () => {
  it('is reminded when they chose "We already know where" and the area is not named yet, and not told the guest\'s line', async () => {
    const { sam, id } = await started()
    await sam.api.startSession(id, { meetBy: 'known' })
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.has('[data-testid=meet-by-pending]'))
    expect(view.text(view.one('[data-testid=meet-by-pending]'))).toContain('have not named the area yet')
    expect(view.text(view.one('[data-testid=meet-by-pending]'))).toContain('Pick the area')
    expect(view.has('[data-testid=meet-by-note]')).toBe(false)
  })

  it('is told nothing after choosing the fairest spot', async () => {
    const { sam, id } = await started()
    await sam.api.startSession(id, { meetBy: 'fairest' })
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Add where you are starting'))
    expect(view.has('[data-testid=meet-by-note]')).toBe(false)
    expect(view.has('[data-testid=meet-by-pending]')).toBe(false)
  })
})

describe('a database one migration behind', () => {
  it('names the migration when the meet_by column is missing, instead of "could not load"', async () => {
    const { plain } = await import('../sessionsRemote.js')
    const error = { code: '42703', message: 'column sessions.meet_by does not exist' }
    expect(plain(error).message).toContain('20261026000000_jio_session_meet_by.sql')
    expect(plain({ code: 'PGRST204', message: "Could not find the 'meet_by' column of 'sessions' in the schema cache" }).message).toContain('20261026000000_jio_session_meet_by.sql')
    // Any other missing column says what it always did.
    expect(plain({ code: '42703', message: 'column sessions.zzz does not exist' }).message).not.toContain('meet_by')
  })

  it('shows that sentence on the session page, with a retry, when the read fails for that reason', async () => {
    const { w, id } = await started()
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.has('[data-testid=group-detail-view]') && view.text().includes('Kim'))
    // The same project, now without the column: every read of a session asks for it.
    const run = w.database.run
    w.database.run = (op) => (op.table === 'sessions' && op.kind === 'select' && String(op.columns).includes('meet_by')
      ? { data: null, error: { code: '42703', message: 'column sessions.meet_by does not exist', status: 400 } }
      : run(op))
    const again = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => again.view.has('[data-testid=session-load-error]'))
    expect(again.view.text()).toContain('20261026000000_jio_session_meet_by.sql')
    expect(press(again.view, 'Retry')).toBeTruthy()
  })
})

describe('the choice before inviting (walkthrough, 30 October 2026)', () => {
  // Sam alone in a new session, as it is right after Create.
  async function alone() {
    const w = world()
    const sam = await w.open(PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    return { w, id }
  }

  it('sends the fairest spot on to inviting friends, starting nothing', async () => {
    const { w, id } = await alone()
    const { view, router } = await draw('views/StartView', `/sessions/${id}/start`, { id })
    await until(() => view.has('[data-testid=start-next]'))
    expect(view.has('[data-testid=start-too-few]')).toBe(false)
    expect(nextButton(view).attrs.disabled).toBeUndefined()
    await view.click(nextButton(view))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/invite`)
    expect(router.currentRoute.value.query).toEqual({ then: 'fairest' })
    expect(row(w, id).status).toBe('inviting')
  })

  it('takes "We already know where" straight to the area, then on to inviting with it', async () => {
    const { w, id } = await alone()
    const { view, router } = await draw('views/StartView', `/sessions/${id}/start?where=1`, { id })
    await until(() => !!chip(view, 'Tampines'))
    await view.click(chip(view, 'Tampines'))
    await view.click(nextButton(view))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/invite`)
    expect(router.currentRoute.value.query).toEqual({ then: 'known', area: 'tampines' })
    expect(row(w, id).status).toBe('inviting')
  })
})
