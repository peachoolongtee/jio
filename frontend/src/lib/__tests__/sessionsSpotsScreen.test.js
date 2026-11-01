// The screens of stage 3 for a real account, drawn for real on an in-memory page (domless.js) on the stand-in database and the stand-in
// Jio server: starting the session, the Locate step (the spots, "Vote", the host's confirm, leaving, removing, rejoining, a
// failed save and its retry), and the Vote page. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { KIM_PLACE, SAM_PLACE, THIRD, world } from './sessionsWorld.js'
import { removeText } from '../../components/group/removeCopy.js'

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
  'views/PlannerView': () => import('@/views/PlannerView.vue'),
}

// Draw a screen of the app signed in as the person opened last (the modules are the last app's).
// How to call: const t = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
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

// Sam hosts a session with Kim in it, still inviting. A screen is drawn for the app opened last, so `guest` opens Kim last and
// otherwise Sam is the last.
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

// The session started, with both people's starts in.
// How to call: const { w, sam, kim, id } = await locating({ guest: true })
async function locating(options) {
  const world = await started(options)
  await world.sam.api.startSession(world.id)
  await world.sam.api.setLocation(world.id, world.sam.id, 'start', SAM_PLACE)
  await world.kim.api.setLocation(world.id, world.kim.id, 'start', KIM_PLACE)
  return world
}

describe('starting the session', () => {
  it('offers the host Next as a link to the Start choice, and the choice starts it: the page becomes the Locate step', async () => {
    const { w, id } = await started()
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Kim'))
    expect(view.has('#start-held')).toBe(false)
    // Pressing Next saves nothing: it opens the choice.
    const start = view.one('[data-testid=lobby-next]')
    expect(start.attrs.href).toBe(`/sessions/${id}/start`)
    expect(w.database.tables.sessions[0].status).toBe('inviting')
    const choice = await draw('views/StartView', `/sessions/${id}/start`, { id })
    await until(() => choice.view.text().includes('How do you want to pick the meeting point?'))
    await choice.view.click(choice.view.one('[data-testid=start-next]'))
    await until(() => w.database.tables.sessions[0].status === 'locating')
    // The choice is saved in the same update as the start.
    expect(w.database.tables.sessions[0].meet_by).toBe('fairest')
    // The session page is now the Locate step.
    const page = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => page.view.text().includes('Add where you are starting'))
    expect(page.view.text()).not.toContain('comes in the next update')
  })

  it('says the database\'s sentence when it cannot start, and keeps the button for another try', async () => {
    const { w, id } = await started()
    const { view } = await draw('views/StartView', `/sessions/${id}/start`, { id })
    await until(() => view.text().includes('How do you want to pick the meeting point?'))
    // Kim goes without the page hearing of it, so the button is still there when the host presses it.
    w.database.tables.session_members.splice(1, 1)
    await view.click(view.one('[data-testid=start-next]'))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toBe('A session needs at least two people before it can start.')
    expect(w.database.tables.sessions[0].status).toBe('inviting')
    expect(view.one('[data-testid=start-next]').disabled).toBe(false)
  })
})

describe('the Locate step, for the host', () => {
  it('lists the spots with Vote and the host\'s one main action; with two people Remove is not offered, and nor is Leave', async () => {
    const { w, sam, kim, id } = await locating()
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet') && view.text().includes('Kim'))
    expect(view.errors).toEqual([])
    const spots = (await sam.api.getSession(id)).spots.list
    expect(spots).toHaveLength(3)
    for (const spot of spots) expect(view.text()).toContain(spot.area.name)
    expect(view.text()).toContain('Suggested by Jio')
    expect(view.text()).not.toContain('Pick the place yourself')
    expect(view.text()).toContain('Add a spot')
    // The one main action, named for the spot shown first. Removing Kim would leave Sam alone, so it is not offered; a host cannot leave.
    expect(press(view, `Confirm ${spots[0].area.name}`)).toBeTruthy()
    expect(view.all('button[aria-label="Remove Kim"]')).toHaveLength(0)
    expect(press(view, 'Leave session')).toBeUndefined()
    // Another member's exact place is nowhere on the page.
    expect(view.text()).not.toContain('Blk 123')
    expect(w.database.tables.session_member_places).toHaveLength(2)
  })

  it('saves Vote as the person\'s own row, and follows the guest\'s mark made on the other device', async () => {
    const { w, sam, kim, id } = await locating()
    const { view, events } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet'))
    const works = view.all('button').filter((b) => view.text(b).includes('Vote'))
    expect(works.length).toBeGreaterThan(0)
    await view.click(works[0])
    await until(() => w.database.tables.spot_approvals.length === 1)
    expect(w.database.tables.spot_approvals[0].user_id).toBe(sam.id)
    await until(() => events.byId[id].spots.list[0].approvalCount === 1)
    // Kim's mark, made on her device, reaches the open page without a reload.
    const spot = (await kim.api.getSession(id)).spots.list[1].areaId
    await kim.api.approveSpot(id, kim.id, spot, true)
    await until(() => events.byId[id].spots.list[1].approvalCount === 1)
    await until(() => view.text().includes('1 vote'))
  })

  it('confirms the spot and stays on the page, which then offers Choose places', async () => {
    const { w, sam, kim, id } = await locating()
    const { view, router } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet'))
    const first = (await sam.api.getSession(id)).spots.list[0]
    await view.click(press(view, `Confirm ${first.area.name}`))
    await until(() => w.database.tables.sessions[0].status === 'voting')
    await until(() => view.all('a').some((a) => view.text(a).includes('Choose places')))
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}`)
    expect(view.text()).toContain(first.area.name)
    expect(view.text()).toContain('Meeting spot')
    expect(view.text()).toContain(`${first.area.name} is confirmed. Press Choose places to carry on.`)
  })

  // On a phone or tablet the page opens on the List, and the map pane (with the spinner) is hidden by CSS, so the busy state has to
  // be on the button the host pressed. The test has no layout; it checks that the list is the open view and the words are on the button.
  it('says Confirming… on the button and to a screen reader while the server works, in the list view, where the map is hidden', async () => {
    const { w, sam, id } = await locating()
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet'))
    const first = (await sam.api.getSession(id)).spots.list[0]
    expect(view.has('.split--list')).toBe(true)
    let release
    w.server.after.confirm = () => new Promise((resolve) => (release = resolve))
    await view.click(press(view, `Confirm ${first.area.name}`))
    await until(() => view.text().includes('Confirming…'))
    const busy = press(view, 'Confirming…')
    expect(busy.attrs['aria-busy']).toBe('true')
    expect(busy.disabled).toBe(false)
    expect(view.all('p[role=status]').some((p) => view.text(p) === 'Confirming the meeting spot…')).toBe(true)
    // The list's own controls are held too, so nothing changes under the confirm.
    expect(view.all('button').filter((b) => view.text(b).includes('Vote')).every((b) => b.attrs['aria-busy'] === 'true')).toBe(true)
    release()
    await until(() => w.database.tables.sessions[0].status === 'voting')
    await until(() => view.text().includes(`${first.area.name} is confirmed. Press Choose places to carry on.`))
    expect(view.text()).not.toContain('Confirming')
  })

  it('says what failed under the list and keeps Confirm for another try', async () => {
    const { w, sam, kim, id } = await locating()
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet'))
    const first = (await sam.api.getSession(id)).spots.list[0]
    w.server.down = true
    await view.click(press(view, `Confirm ${first.area.name}`))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toMatch(/Cannot reach the Jio planner/)
    expect(w.database.tables.sessions[0].status).toBe('locating')
    expect(press(view, `Confirm ${first.area.name}`).disabled).toBe(false)
    w.server.down = false
    await view.click(press(view, `Confirm ${first.area.name}`))
    await until(() => w.database.tables.sessions[0].status === 'voting')
  })

  it('takes a guest out after a question when two others remain, and the list follows', async () => {
    const { w, sam, id } = await threeWaiting({ kimStarts: true })
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet') && view.text().includes('Kim'))
    await view.click(view.one('button[aria-label="Remove Kim"]'))
    await view.click(view.all('button').find((b) => view.text(b) === 'Remove Kim'))
    await until(() => w.database.tables.session_members.length === 2)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'removeMember', as: sam.id })
    await until(() => !view.text().includes('Kim'))
  })

  // Sam hosts a started session with Kim and Lee in it; only Sam has shared where he starts. Sam's app is opened last, so the page is his.
  // With `kimStarts`, Kim has shared hers too, so only Lee is waited for and the spots are listed.
  // How to call: const { w, sam, kim, lee, id } = await threeWaiting({ kimStarts: true })
  async function threeWaiting({ kimStarts = false } = {}) {
    const w = world()
    const kim = await w.open(OTHER)
    const lee = await w.open(THIRD)
    const sam = await w.open(PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    await kim.api.joinWithLink(token)
    await lee.api.joinWithLink(token)
    await sam.api.startSession(id)
    await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    if (kimStarts) await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
    return { w, sam, kim, lee, id }
  }

  it('lets the host remove a person who has not shared where they start from the people list, after a question that says what removing means', async () => {
    const { w, kim, id } = await threeWaiting()
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    // No line says who has not shared a start: the people list shows it (walkthrough, 30 October 2026).
    await until(() => view.has('button[aria-label="Remove Kim"]'))
    expect(view.has('[data-testid=waiting-line]')).toBe(false)
    expect(press(view, 'Continue without')).toBeUndefined()
    await view.click(view.one('button[aria-label="Remove Kim"]'))
    const said = removeText('Kim')
    expect(said).toBe('Kim is removed from this session and it disappears from their list. If they joined with an invite link that still works, they can rejoin with it. Someone invited by username cannot.')
    await until(() => view.has('[role=dialog]'))
    const dialog = view.text(view.one('[role=dialog]'))
    expect(dialog).toContain(said)
    expect(dialog).toContain('Remove Kim?')
    expect(dialog).not.toContain('This cannot be undone')
    expect(view.all('button').some((b) => view.text(b) === 'Keep Kim')).toBe(true)
    await view.click(view.all('button').filter((b) => view.text(b) === 'Remove Kim').at(-1))
    await until(() => w.database.tables.session_members.length === 2)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'removeMember', path: `/api/sessions/${id}/members/${kim.id}` })
  })

  it('offers no way to carry on without the only other person, since removing them would leave one', async () => {
    const w = world()
    const kim = await w.open(OTHER)
    const host = await w.open(PROFILE)
    const session = await host.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await host.api.makeInviteLink(session.id)).token)
    await host.api.startSession(session.id)
    await host.api.setLocation(session.id, host.id, 'start', SAM_PLACE)
    const { view } = await draw('views/GroupDetailView', `/sessions/${session.id}`, { id: session.id })
    await until(() => view.text().includes('Kim'))
    expect(press(view, 'Remove Kim')).toBeUndefined()
    expect(press(view, 'Continue without')).toBeUndefined()
    expect(view.text()).not.toContain('you can remove them')
    expect(view.text()).not.toContain('carry on without them')
    // Nothing was asked of the server.
    expect(w.server.calls.filter((c) => c.route === 'removeMember')).toEqual([])
  })
})

describe('a start the server could not confirm', () => {
  it('is said as a quiet notice, not an error, and the start stays', async () => {
    const { w, sam, id } = await locating()
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet'))
    // The planner cannot be reached when the person changes where they start.
    w.server.down = true
    await view.click(view.one('button.route__row'))
    await view.click(view.all('button').find((b) => view.text(b).startsWith('Home')))
    await until(() => view.text().includes('Your start is saved. The travel times may take a moment to appear.'))
    expect(view.has('p[role=alert]')).toBe(false)
    expect(view.has('[role=status]')).toBe(true)
    // Sam's home is where he already started from; the label of the exact place is what changed, and it stayed.
    const label = w.database.tables.session_member_places.find((p) => p.user_id === sam.id).start_label
    expect(label).toContain('Home')
    expect(label).not.toBe(SAM_PLACE.label)
  })
})

describe('the Locate step, for a guest', () => {
  it('says who it is waiting for, offers Leave session, and leaves for Home after a question', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    await sam.api.startSession(id)
    await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
    const { view, router } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Where to meet') && view.text().includes('Sam'))
    expect(view.text()).toContain('Waiting for Sam to confirm')
    expect(view.all('button').some((b) => (b.attrs['aria-label'] || '').startsWith('Remove'))).toBe(false)
    expect(view.text()).toContain('Blk 123 Bishan St 12, #05-67')
    expect(view.text()).not.toContain(SAM_PLACE.label)
    await view.click(press(view, 'Leave session'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Leave session').at(-1))
    await until(() => router.currentRoute.value.name === 'home')
    expect(w.database.tables.session_members.map((m) => m.role)).toEqual(['host'])
  })

  it('waits for the host in the lobby with Leave session, and has no Start', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('Waiting for Sam to start the session.'))
    expect(press(view, 'Start session')).toBeUndefined()
    expect(press(view, 'Leave session')).toBeTruthy()
  })

  it('tells a person who opted out, and lets them rejoin', async () => {
    const { w, kim, id } = await locating({ guest: true })
    await kim.api.optOut(id, kim.id)
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('You opted out of this session'))
    await view.click(press(view, 'Rejoin'))
    await until(() => w.database.tables.session_members.every((m) => m.state === 'joined'))
    await until(() => !view.text().includes('You opted out of this session'))
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'rejoin' })
  })
})

describe('the banner about marks that went with a spot', () => {
  it('shows to the group while choosing, and is dismissed by the person alone', async () => {
    const { sam, kim, id } = await locating()
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    await sam.api.approveSpot(id, sam.id, 'orchard', true)
    await kim.api.withdrawSpot(id, kim.id)
    const { view } = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => view.text().includes('approvals for it were removed'))
    await view.click(view.one('button[aria-label="Dismiss"]'))
    await until(() => !view.text().includes('approvals for it were removed'))
    expect((await kim.api.getSession(id)).banner).toBeTruthy()
  })
})

describe('the Vote page of a shared session', () => {
  it('lists the places the server offered, names the confirmed spot as the area, and has Confirm plan for the host, with nothing about a next update (stage 4: sessionsVotingScreen.test.js has the rest)', async () => {
    const { w, sam, id } = await locating()
    const first = (await sam.api.getSession(id)).spots.list[0]
    await sam.api.confirmSpot(id, first.areaId)
    w.server.calls.length = 0
    const { view } = await draw('views/PlannerView', `/sessions/${id}/plan`, { id })
    await until(() => view.has('article[data-option]'))
    expect(view.errors).toEqual([])
    expect(view.has('[data-testid=voting-next]')).toBe(false)
    expect(view.text()).toContain(`Walking times are from ${first.area.name}`)
    // Stage 5: the host (this is Sam's page) has Confirm plan, disabled until two people have voted; stage 4's note is gone.
    expect(view.has('[data-testid=confirm-next]')).toBe(false)
    expect(view.text()).not.toContain('comes in the next update')
    expect(view.text()).toContain('Needs 2 voters')
    expect(view.has('[data-testid=plan-error]')).toBe(false)
  })
})
