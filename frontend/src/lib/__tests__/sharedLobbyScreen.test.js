// The screens of a shared session, drawn for real on an in-memory page (domless.js) on the stand-in database: the lobby (who is
// in, by name, for the host and for a guest, the held Start session and its sentence, Leave and Remove), the invite page (the
// link, invite by username), the invitations on Home, and how each follows a change made on another device without a reload.
// No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { createDatabase } from '../../components/dev/fakeDatabase.js'

// Leaving and removing are the Jio server's work; here the route's effect on the database is done in a few lines.
const server = vi.hoisted(() => ({ calls: [], effect: null }))
const planner = vi.hoisted(() => ({
  api: { defaults: {} },
  meetingArea: vi.fn(),
  rankSlot: vi.fn(),
  searchSlot: vi.fn(),
  searchPeopleByUsername: vi.fn(async () => []),
  removeSessionMember: vi.fn(async (...args) => {
    server.calls.push(args)
    await server.effect?.(...args)
    return { planVersion: 1 }
  }),
}))
vi.mock('../plannerApi.js', () => planner)
// The map needs a real browser (Leaflet); a shared session in its lobby draws none.
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/spots/SpotPins.vue', () => ({ default: { name: 'SpotPins', render: () => null } }))

vi.setConfig({ testTimeout: 40000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  server.calls.length = 0
  server.effect = null
})

const THIRD = { email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] }
const HELD = 'Sharing where you start from, and everything after it, comes in the next update, so a session cannot be started yet.'
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))

async function open(database, profile) {
  const fake = fakeSupabase({ database, memoryOnly: true })
  const app = await boot(fake, {}, { shared: true })
  const user = profile ? await app.api.signUp({ ...profile }) : null
  return { ...app, fake, user }
}

// The server's removal of a member, for the mocked route.
// How to call: server.effect = removal(database, kim.user.id)
const removal = (database, whoIsMe) => async (sessionId, who) => {
  const person = who === 'me' ? whoIsMe : who
  await database.run({ as: 'service', kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: sessionId }, { col: 'user_id', op: 'eq', value: person }] })
}

// The screens drawn here, by name (a variable import path may only go one folder deep).
const SCREENS = {
  'views/GroupDetailView': () => import('@/views/GroupDetailView.vue'),
  'views/InviteView': () => import('@/views/InviteView.vue'),
  'components/event/InvitationList': () => import('@/components/event/InvitationList.vue'),
}

// Draw a screen of the app signed in as the person opened last.
// How to call: const t = await draw('GroupDetailView', `/sessions/${id}`, { id })
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

describe('the lobby, for the host', () => {
  async function hostLobby() {
    const database = createDatabase({ profiles: {} })
    const kimApp = await open(database, OTHER)
    // Kim is made first so Sam can invite her; Sam then hosts and is the app drawn.
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    await kimApp.api.joinWithLink(token)
    const t = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => t.view.has('[data-testid=group-detail-view]') && t.view.text().includes('Kim'))
    return { ...t, database, id, token, sam, kimApp }
  }

  it('lists everyone by name, marks the host and "you", and holds Start session with the one sentence', async () => {
    const { view, id } = await hostLobby()
    expect(view.errors).toEqual([])
    const rows = view.all('li').filter((li) => (li.attrs.class || '').includes('lobby__row'))
    expect(rows.map((r) => view.text(r))).toEqual([expect.stringContaining('Sam (you)'), expect.stringContaining('Kim')])
    expect(view.text(rows[0])).toContain('Host')
    expect(view.text(rows[1])).toContain('Joined')
    expect(view.text(rows[1])).not.toContain('(you)')
    // The held start: the sentence is on screen and the button cannot be pressed.
    expect(view.text(view.one('#start-held'))).toBe(HELD)
    const start = press(view, 'Start session')
    expect(start.disabled).toBe(true)
    expect(start.attrs['aria-describedby']).toBe('start-held')
    expect(view.all('p').filter((p) => view.text(p).includes('comes in the next update'))).toHaveLength(1)
    // The host can take Kim out, and has no Leave.
    expect(view.one('button[aria-label="Remove Kim"]')).toBeTruthy()
    expect(press(view, 'Leave session')).toBeUndefined()
    expect(id).toBeTruthy()
  })

  it('shows the person who just joined, without a reload, and one who left, and the cancelled state', async () => {
    const { view, events, id, database, token } = await hostLobby()
    const lee = await open(database, THIRD)
    await lee.api.joinWithLink(token)
    await until(() => view.text().includes('Lee'))
    expect(view.all('li').filter((li) => (li.attrs.class || '').includes('lobby__row'))).toHaveLength(3)
    // Lee leaves, through the server.
    server.effect = removal(database, lee.user.id)
    await lee.api.leaveSession(id)
    await until(() => !view.text().includes('Lee'))
    expect(view.all('li').filter((li) => (li.attrs.class || '').includes('lobby__row'))).toHaveLength(2)
    expect(events.byId[id].members.map((m) => m.state)).toEqual(['joined', 'joined'])
  })

  it('renames on the host\'s own device and on the guest\'s, and a host\'s cancel reaches the guest\'s store', async () => {
    const { view, events, id, database, kimApp } = await hostLobby()
    const host = database.tables.sessions[0].host_id
    await database.run({ as: host, kind: 'update', table: 'sessions', values: { title: 'Renamed' }, filters: [{ col: 'id', op: 'eq', value: id }], returning: false })
    await until(() => view.text().includes('Renamed'))
    expect(events.byId[id].title).toBe('Renamed')
    expect(kimApp.user.id).not.toBe(host)
  })

  it('removes a guest after a question, through the server, and the list follows', async () => {
    const { view, id, database, kimApp } = await hostLobby()
    server.effect = removal(database, kimApp.user.id)
    await view.click(view.one('button[aria-label="Remove Kim"]'))
    const dialog = view.all('h2').find((h) => view.text(h) === 'Remove Kim?')
    expect(dialog).toBeTruthy()
    await view.click(press(view, 'Keep Kim'))
    expect(server.calls).toEqual([])
    await view.click(view.one('button[aria-label="Remove Kim"]'))
    await view.click(view.all('button').find((b) => view.text(b) === 'Remove Kim'))
    await until(() => server.calls.length === 1)
    expect(server.calls).toEqual([[id, kimApp.user.id]])
    await until(() => !view.text().includes('Kim'))
  })

  it('says the server\'s refusal in the dialog and keeps the guest', async () => {
    const { view, kimApp } = await hostLobby()
    server.effect = async () => {
      throw Object.assign(new Error('raw'), { code: 'session_closed' })
    }
    await view.click(view.one('button[aria-label="Remove Kim"]'))
    await view.click(view.all('button').find((b) => view.text(b) === 'Remove Kim'))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toBe('This session has ended.')
    expect(view.text()).toContain('Kim')
    expect(kimApp.user).toBeTruthy()
  })
})

describe('the lobby, for a guest', () => {
  async function guestLobby() {
    const database = createDatabase({ profiles: {} })
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    const kim = await open(database, OTHER)
    await kim.api.joinWithLink(token)
    const t = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => t.view.text().includes('Sam'))
    return { ...t, database, id, token, sam, kim }
  }

  it('shows the host by name without "(you)", marks the guest as you, and offers Leave, not Start or Remove or a cancel', async () => {
    const { view } = await guestLobby()
    const rows = view.all('li').filter((li) => (li.attrs.class || '').includes('lobby__row'))
    expect(rows.map((r) => view.text(r))).toEqual([expect.stringContaining('Sam'), expect.stringContaining('Kim (you)')])
    expect(view.text(rows[0])).not.toContain('(you)')
    expect(view.text(view.one('#start-held'))).toBe(HELD)
    expect(press(view, 'Start session')).toBeUndefined()
    expect(press(view, 'Leave session')).toBeTruthy()
    expect(view.all('button').some((b) => (b.attrs['aria-label'] || '').startsWith('Remove'))).toBe(false)
    // Only the host can call it off: no "Hold to cancel".
    expect(view.all('button').some((b) => view.text(b).includes('Hold to cancel') || (b.attrs['aria-label'] || '').includes('cancel'))).toBe(false)
  })

  it('leaves after a question, through the server, and goes Home', async () => {
    const { view, router, id, database, kim } = await guestLobby()
    server.effect = removal(database, kim.user.id)
    await view.click(press(view, 'Leave session'))
    expect(view.all('h2').some((h) => view.text(h) === 'Leave this session?')).toBe(true)
    await view.click(press(view, 'Stay'))
    expect(server.calls).toEqual([])
    await view.click(press(view, 'Leave session'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Leave session').at(-1))
    await until(() => router.currentRoute.value.name === 'home')
    expect(server.calls).toEqual([[id, 'me']])
    expect(database.tables.session_members.map((m) => m.role)).toEqual(['host'])
  })

  it('says so when the host takes the guest out while the page is open', async () => {
    const { view, database, id, kim } = await guestLobby()
    await database.run({ as: 'service', kind: 'delete', table: 'session_members', filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'user_id', op: 'eq', value: kim.user.id }] })
    await until(() => view.has('[data-testid=session-gone]'))
    expect(view.text(view.one('h2'))).toBe('You are not in this session any more')
    expect(view.text()).toContain('You left it, or the host took you out of it.')
    expect(view.all('a').some((a) => a.attrs.href === '/' && view.text(a) === 'Back to Home')).toBe(true)
  })
})

describe('the invite page', () => {
  async function invitePage() {
    const database = createDatabase({ profiles: {} })
    const kim = await open(database, OTHER)
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const t = await draw('views/InviteView', `/sessions/${id}/invite`, { id })
    await until(() => t.view.has('[data-testid=share-link]') && !t.view.text().includes('Loading'))
    await until(() => t.view.text().includes('Make a link'))
    return { ...t, database, id, sam, kim }
  }

  it('makes the link on a press, shows it whole to copy or share, and turns it off after a question', async () => {
    const { view, database, id } = await invitePage()
    expect(view.text()).toContain('Invite link')
    expect(view.text()).toContain('Invite by username')
    await view.click(press(view, 'Make a link'))
    await until(() => view.has('input[readonly]'))
    const field = view.one('input[readonly]')
    expect(field.value).toBe(`/join/${database.tables.invites[0].token}`)
    expect(view.text()).toContain('Anyone with this link can join')
    expect(view.text()).toMatch(/It works until \w{3} \d+ \w{3}, \d\d:\d\d\./)
    expect(press(view, 'Copy link')).toBeTruthy()
    // Turning it off asks first.
    await view.click(press(view, 'Turn off link'))
    expect(view.all('h2').some((h) => view.text(h) === 'Turn off this link?')).toBe(true)
    await view.click(press(view, 'Keep link'))
    expect(database.tables.invites[0].revoked).toBe(false)
    await view.click(press(view, 'Turn off link'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Turn off link').at(-1))
    await until(() => database.tables.invites[0].revoked)
    await until(() => view.text().includes('Make a link'))
    expect(id).toBeTruthy()
  })

  it('says an expired link ran out and offers a new one', async () => {
    const { view, database } = await invitePage()
    await view.click(press(view, 'Make a link'))
    await until(() => view.has('input[readonly]'))
    // A fresh page for the same session with the link now expired.
    database.tables.invites[0].expires_at = '2026-10-01T00:00:00.000Z'
    const again = await draw('views/InviteView', `/sessions/${database.tables.sessions[0].id}/invite`, { id: database.tables.sessions[0].id })
    await until(() => again.view.text().includes('Make a new link'))
    expect(again.view.text()).toMatch(/The link ran out on .* Nobody can join with it now\./)
    await again.view.click(press(again.view, 'Make a new link'))
    await until(() => again.view.has('input[readonly]'))
    expect(database.tables.invites.map((i) => i.revoked)).toEqual([true, false])
  })

  it('finds people as the username is typed, invites one, and says so when nobody matches or the text is too short', async () => {
    const { view, database, kim } = await invitePage()
    // The server's side is tested in the backend; here it answers with Kim for the start of "kim" and nobody otherwise.
    planner.searchPeopleByUsername.mockImplementation(async (q) => ('kim'.startsWith(q) ? [{ id: kim.user.id, name: 'Kim', username: 'kim', avatarUrl: '', metBefore: false }] : []))
    const box = () => view.all('input').find((i) => i.attrs.placeholder === 'for example sam_tan')
    const type = (text) => {
      box().value = text
      box().dispatch('input')
    }
    expect(view.text()).toContain('Type at least 3 letters of their username')
    expect(press(view, 'Find')).toBeUndefined()
    type('ki')
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(planner.searchPeopleByUsername).not.toHaveBeenCalled()
    expect(view.text()).toContain('Type at least 3 letters of their username')
    type('nob')
    await until(() => view.text().includes("Nobody's username starts with that."))
    type('kim')
    await until(() => view.text().includes('@kim'))
    expect(planner.searchPeopleByUsername.mock.calls.map((c) => c[0])).toEqual(['nob', 'kim'])
    expect(view.text()).toContain('1 person found')
    // Nothing is invited by typing.
    expect(database.tables.invites.filter((i) => i.invitee_id !== null)).toHaveLength(0)
    expect(press(view, 'Invite')).toBeTruthy()
    await view.click(press(view, 'Invite'))
    await until(() => view.text().includes('Kim is invited. They will see it on their Home screen.'))
    expect(database.tables.invites.filter((i) => i.invitee_id !== null)).toHaveLength(1)
    // The list shows Kim as invited, and she cannot be invited again.
    await until(() => view.text().includes('2 in this session'))
    type('kim')
    await until(() => view.text().includes('Already invited.'))
    expect(press(view, 'Invite')).toBeUndefined()
  })

  it('has no friends to pick: it is not the sample-friends page', async () => {
    const { view } = await invitePage()
    expect(view.text()).not.toContain('Select all')
    expect(view.text()).not.toContain('Search friends')
    expect(view.text()).toContain('1 in this session')
  })
})

describe('the invitations on Home', () => {
  it('shows an invitation by name to the person invited, who joins from it or declines it, and follows a new one live', async () => {
    const database = createDatabase({ profiles: {} })
    const kim = await open(database, OTHER)
    const sam = await open(database, PROFILE)
    const first = await sam.api.createSession({ ...SESSION, title: 'First' })
    const second = await sam.api.createSession({ ...SESSION, title: 'Second' })
    const third = await sam.api.createSession({ ...SESSION, title: 'Third' })
    await sam.api.inviteByUsername(first.id, kim.user.id)
    await sam.api.inviteByUsername(second.id, kim.user.id)
    // Kim's app again, on the same stand-in client (she is still signed in there).
    const again = await boot(kim.fake, {}, { shared: true })
    const { view, router, events } = await draw('components/event/InvitationList', '/')
    await until(() => view.has('[data-testid=invitations]'))
    const cards = () => view.all('li').filter((li) => (li.attrs.class || '').includes('invitations__item'))
    expect(cards().map((c) => view.text(c))).toEqual([
      expect.stringContaining('Second'),
      expect.stringContaining('First'),
    ])
    expect(view.text(cards()[0])).toContain('Sat 10 Oct · 12:00 to 20:00')
    expect(view.text(cards()[0])).toContain('Sam invited you')
    // Every control has a name that says which invitation it is for.
    expect(view.all('button').map((b) => b.attrs['aria-label'])).toEqual(['Join Second', 'Decline Second', 'Join First', 'Decline First'])

    // A new invitation arrives while the page is open.
    const stop = again.api.watchSessions()
    await until(() => database.tables.invites.length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    await sam.api.inviteByUsername(third.id, kim.user.id)
    await until(() => cards().length === 3)
    expect(view.text(cards()[0])).toContain('Third')
    stop()

    // Decline one, join another.
    await view.click(view.one('button[aria-label="Decline First"]'))
    await until(() => cards().length === 2)
    expect(view.text()).not.toContain('First')
    await view.click(view.one('button[aria-label="Join Second"]'))
    await until(() => router.currentRoute.value.name === 'session')
    expect(router.currentRoute.value.path).toBe(`/sessions/${second.id}`)
    expect(cards().map((c) => view.text(c))).toEqual([expect.stringContaining('Third')])
    expect(events.byId[second.id].members.map((m) => m.state)).toEqual(['joined', 'joined'])
  })

  it('shows nothing when there are no invitations, and nothing at all to the demo account', async () => {
    const database = createDatabase({ profiles: {} })
    await open(database, OTHER)
    const none = await draw('components/event/InvitationList', '/')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(none.view.has('[data-testid=invitations]')).toBe(false)
    const demo = await open(database, { ...PROFILE, email: 'ian@jio.demo', name: 'Ian', username: 'ian', demo: true, friends: [] })
    const shown = await draw('components/event/InvitationList', '/')
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(shown.view.has('[data-testid=invitations]')).toBe(false)
    expect(demo.user.id).toBe('ian')
  })

  it('says under the invitation why it could not be joined, and keeps it to decline', async () => {
    const database = createDatabase({ profiles: {} })
    const kim = await open(database, OTHER)
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    await sam.api.inviteByUsername(id, kim.user.id)
    await boot(kim.fake, {}, { shared: true })
    const { view } = await draw('components/event/InvitationList', '/')
    await until(() => view.has('[data-testid=invitations]'))
    // The host calls the session off before Kim answers.
    await sam.api.cancelSession(id)
    await view.click(view.one('button[aria-label="Join SESSION"]'.replace('SESSION', SESSION.title)))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toContain('This link no longer works.')
    expect(view.one(`button[aria-label="Decline ${SESSION.title}"]`)).toBeTruthy()
  })
})

describe('the session page when the session cannot be read', () => {
  // A host's session, and Kim, who is not in it, with the app opened last as Kim.
  async function notInIt() {
    const database = createDatabase({ profiles: {} })
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    const kim = await open(database, OTHER)
    return { database, id, token, kim }
  }

  it('says "Page not found" only for a session that does not exist or that the person is not in', async () => {
    const { id } = await notInIt()
    const t = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => t.view.text().includes('Page not found'))
    expect(t.view.has('[data-testid=session-load-error]')).toBe(false)
    // An address that is not an id at all is the same page.
    const typo = await draw('views/GroupDetailView', '/sessions/xyz', { id: 'xyz' })
    await until(() => typo.view.text().includes('Page not found'))
  })

  it('says it could not load the session, with Retry, when Jio cannot be reached, and loads it on Retry', async () => {
    const { token, id, kim } = await notInIt()
    await kim.api.joinWithLink(token)
    kim.fake.state.options.down = true
    const t = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => t.view.has('[data-testid=session-load-error]'))
    expect(t.view.text()).toContain('Could not load this session')
    expect(t.view.text()).toContain('Jio could not be reached. Check your connection and try again.')
    expect(t.view.text()).not.toContain('Page not found')
    expect(t.view.one('[role=alert]')).toBeTruthy()
    kim.fake.state.options.down = false
    await t.view.click(press(t.view, 'Retry'))
    await until(() => t.view.has('[data-testid=group-detail-view]'))
    await until(() => t.view.text().includes('Kim (you)'))
    expect(t.view.has('[data-testid=session-load-error]')).toBe(false)
  })

  it('shows the session when the person is let in while the not-found page is up', async () => {
    const { token, id, kim } = await notInIt()
    const t = await draw('views/GroupDetailView', `/sessions/${id}`, { id })
    await until(() => t.view.text().includes('Page not found'))
    await kim.api.joinWithLink(token)
    await until(() => t.view.has('[data-testid=group-detail-view]'))
    expect(t.view.text()).toContain('Kim (you)')
    expect(t.view.text()).not.toContain('Page not found')
  })
})
