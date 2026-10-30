// Taking back an invite by username for a real account, drawn for real on an in-memory page (domless.js) on the stand-in database
// with its access rules: the host's × on an Invited row of the Invite page and the session page, the question, the invitation turned
// off (`invites.revoked`), the person gone from the list and from their own invitations, the sentence when the invite was answered
// first, and a guest who sees no ×. The local path is in takeBackInvite.test.js. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { createDatabase } from '../../components/dev/fakeDatabase.js'

const planner = vi.hoisted(() => ({
  api: { defaults: {} },
  meetingArea: vi.fn(),
  rankSlot: vi.fn(),
  searchSlot: vi.fn(),
  searchPeopleByUsername: vi.fn(async () => []),
  removeSessionMember: vi.fn(async () => ({ planVersion: 1 })),
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
afterEach(() => vi.unstubAllGlobals())

const THIRD = { email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] }
const SCREENS = {
  'views/GroupDetailView': () => import('@/views/GroupDetailView.vue'),
  'views/InviteView': () => import('@/views/InviteView.vue'),
}

// A new account on the stand-in database, signed in.
// How to call: const kim = await open(database, OTHER)
async function open(database, profile) {
  const fake = fakeSupabase({ database, memoryOnly: true })
  const app = await boot(fake, {}, { shared: true })
  const user = await app.api.signUp({ ...profile })
  return { ...app, fake, user }
}

// Draw a screen of the app signed in as the person booted last.
// How to call: const { view } = await draw('views/InviteView', `/sessions/${id}/invite`, { id })
async function draw(file, path, props = {}) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(path)
  const { default: View } = await SCREENS[file]()
  const view = await mountScreen(View, { plugins: [pinia, router], props })
  return { view, router }
}

// Sam hosts, Lee joined with the link, and Kim is invited by username. Sam's app is the one booted last.
// How to call: const { database, id, kim, lee } = await invited()
async function invited() {
  const database = createDatabase({ profiles: {} })
  const kim = await open(database, OTHER)
  const lee = await open(database, THIRD)
  const sam = await open(database, PROFILE)
  const { id } = await sam.api.createSession({ ...SESSION })
  const { token } = await sam.api.makeInviteLink(id)
  await lee.api.joinWithLink(token)
  await boot(sam.fake, {}, { shared: true })
  await sam.api.inviteByUsername(id, kim.user.id)
  return { database, id, sam, kim, lee }
}

const crosses = (view) => view.all('button').filter((b) => (b.attrs['aria-label'] || '').startsWith('Take back the invite'))
const press = (view, label) => view.all('button').find((b) => view.text(b) === label)
const kimsInvite = (database, kim) => database.tables.invites.find((i) => i.invitee_id === kim.user.id)

describe('taking back an invite by username, for the host', () => {
  for (const [file, path, heading] of [['views/InviteView', (id) => `/sessions/${id}/invite`, 'invite-in'], ['views/GroupDetailView', (id) => `/sessions/${id}`, 'lobby-members']]) {
    it(`on ${file.slice(6)}: shows the × only on Kim's Invited row, asks, turns the invitation off, and Kim leaves the list`, async () => {
      const { database, id, kim } = await invited()
      const { view } = await draw(file, path(id), { id })
      // The names come a moment after the rows.
      await until(() => crosses(view).length > 0 && view.text().includes('Lee'))
      expect(crosses(view).map((b) => b.attrs['aria-label'])).toEqual(['Take back the invite to Kim'])
      // Lee joined: Remove, not take back.
      expect(view.has('button[aria-label="Remove Lee"]')).toBe(true)
      expect(view.has('button[aria-label="Remove Kim"]')).toBe(false)
      await view.click(crosses(view)[0])
      const dialog = view.one('[role=dialog]')
      expect(view.text(dialog)).toContain('Take back the invite?')
      expect(view.text(dialog)).toContain("Kim won't be able to join from this invite, and you can't invite them by name to this session again. You can send them the session's link.")
      await view.click(press(view, 'Keep invite'))
      expect(kimsInvite(database, kim).revoked).toBe(false)
      await view.click(crosses(view)[0])
      await view.click(press(view, 'Take back'))
      await until(() => kimsInvite(database, kim).revoked === true)
      await until(() => !view.all('li').some((li) => view.text(li).includes('Kim')))
      expect(crosses(view)).toHaveLength(0)
      expect(view.text()).toContain('Lee')
      // The × is gone, so focus went to the list's heading, and the page said what happened.
      await until(() => view.focused()?.attrs.id === heading)
      expect(view.all('[role=status]').map((n) => view.text(n))).toContain("Kim's invite taken back")
      // Kim's own list of invitations no longer has it.
      const again = await boot(kim.fake, {}, { shared: true })
      expect(await again.api.listInvitations()).toEqual([])
    })
  }

  it('says so in the dialog when Kim answered first, and turns nothing off', async () => {
    const { database, id, kim } = await invited()
    const { view } = await draw('views/InviteView', `/sessions/${id}/invite`, { id })
    await until(() => crosses(view).length > 0)
    // Kim declines on her phone; this page has not heard yet.
    kimsInvite(database, kim).declined_at = new Date().toISOString()
    await view.click(crosses(view)[0])
    await view.click(press(view, 'Take back'))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toBe('That invite has already been answered. Reload to see who is in.')
    expect(kimsInvite(database, kim).revoked).toBe(false)
  })
})

describe('what taking back an invite does to the person, in the database', () => {
  it("refuses Kim's join with her personal invitation, and still lets her in with the session's link", async () => {
    const { database, id, sam, kim } = await invited()
    const personal = kimsInvite(database, kim).token
    // Before: her personal invitation is on her list.
    expect((await kim.api.listInvitations()).length).toBe(1)
    await sam.api.revokeInvite(id, kim.user.id)
    expect(kimsInvite(database, kim).revoked).toBe(true)
    // The invitation no longer joins her (join_session says the link is no longer valid), and she has no row in the session.
    expect(await kim.api.listInvitations()).toEqual([])
    await expect(kim.api.joinWithLink(personal)).rejects.toThrow("This link no longer works.")
    expect(database.tables.session_members.some((m) => m.session_id === id && m.user_id === kim.user.id)).toBe(false)
    expect(kimsInvite(database, kim).uses).toBe(0)
    // The session's link, which is not tied to a name, still brings her in.
    const { token } = await sam.api.makeInviteLink(id)
    const joined = await kim.api.joinWithLink(token)
    expect(joined.sessionId).toBe(id)
    expect(database.tables.session_members.find((m) => m.session_id === id && m.user_id === kim.user.id)).toMatchObject({ state: 'joined', role: 'guest' })
  })

  it('cannot invite her by name again, and the refusal points to the link', async () => {
    const { id, sam, kim } = await invited()
    await sam.api.revokeInvite(id, kim.user.id)
    await expect(sam.api.inviteByUsername(id, kim.user.id)).rejects.toThrow("You have already invited that person. Send them the session's link instead.")
  })
})

describe('an invite by username, for a guest', () => {
  it('shows Kim as Invited with no × on the session page or the Invite page', async () => {
    const { id, lee } = await invited()
    await boot(lee.fake, {}, { shared: true })
    for (const [file, path] of [['views/GroupDetailView', `/sessions/${id}`], ['views/InviteView', `/sessions/${id}/invite`]]) {
      const { view } = await draw(file, path, { id })
      await until(() => view.text().includes('Kim') && view.text().includes('Invited'))
      expect(crosses(view)).toHaveLength(0)
    }
  })
})
