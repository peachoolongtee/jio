// Taking back an invite nobody has answered yet, for the demo and local accounts: the data layer (lib/api.js revokeInvite) and the
// × beside an "Invited" name on the Invite page and the session page (components/group/TakeBackInvite.vue), drawn for real on an
// in-memory page (domless.js). A real account's path is in takeBackInvite.server.test.js. No network.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/spots/SpotPins.vue', () => ({ default: { render: () => null } }))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const mounted = []
// An invite that waits a week, so nobody accepts on their own during a test.
const WEEK = 7 * 24 * 60 * 60 * 1000
const stateOf = (session, id) => session.members.find((m) => m.id === id)?.state

beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }))
beforeEach(() => {
  stubPlanner(planner)
  vi.setSystemTime(new Date('2026-10-17T14:20:00+08:00'))
})
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})
afterAll(() => vi.useRealTimers())

// A new local account, signed in, hosting a session with Jonathan joined and Faith invited.
// How to call: const { api, id } = await hosting()
async function hosting() {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-18', start: '12:00', end: '20:00' })
  await api.inviteFriends(id, ['jonathan'])
  await api.inviteFriends(id, ['faith'], { pending: true, acceptAfter: WEEK })
  return { api, id }
}

// The app's stores and router, with a screen drawn at `path`.
// How to call: const view = await draw('@/views/InviteView.vue', `/sessions/${id}/invite`, id)
async function draw(file, path, id) {
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
  await router.push(path)
  const View = file === 'invite' ? (await import('@/views/InviteView.vue')).default : (await import('@/views/GroupDetailView.vue')).default
  const view = await mountScreen(View, { plugins: [pinia, router], props: { id } })
  mounted.push(view)
  return view
}

const crosses = (view) => view.all('button').filter((b) => (b.attrs['aria-label'] || '').startsWith('Take back the invite'))

describe('revokeInvite, for a local account', () => {
  it('takes the invited person off the session, and they can be invited again', async () => {
    const { api, id } = await hosting()
    const session = await api.revokeInvite(id, 'faith')
    expect(stateOf(session, 'faith')).toBeUndefined()
    expect((await api.getSession(id)).members.map((m) => m.id)).toEqual(['ian', 'jonathan'])
    await api.inviteFriends(id, ['faith'], { pending: true, acceptAfter: WEEK })
    expect(stateOf(await api.getSession(id), 'faith')).toBe('invited')
  })

  it('refuses someone who has joined, and someone who is not there', async () => {
    const { api, id } = await hosting()
    await expect(api.revokeInvite(id, 'jonathan')).rejects.toThrow('They are not waiting on an invite.')
    await expect(api.revokeInvite(id, 'nobody')).rejects.toThrow('They are not waiting on an invite.')
    expect(stateOf(await api.getSession(id), 'jonathan')).toBe('joined')
  })
})

describe('the × on an Invited row, for a local host', () => {
  for (const [screen, path, heading] of [['invite', (id) => `/sessions/${id}/invite`, 'invite-in'], ['detail', (id) => `/sessions/${id}`, 'lobby-members']]) {
    it(`shows only on the Invited row of the ${screen === 'invite' ? 'Invite page' : 'session page'}, asks, and takes Faith off the list`, async () => {
      const { api, id } = await hosting()
      const view = await draw(screen, path(id), id)
      await until(() => crosses(view).length > 0)
      // One ×, on Faith's row: not on the host, not on Jonathan who joined.
      expect(crosses(view).map((b) => b.attrs['aria-label'])).toEqual(['Take back the invite to Faith'])
      await view.click(crosses(view)[0])
      const dialog = view.one('[role=dialog]')
      expect(view.text(dialog)).toContain('Take back the invite?')
      expect(view.text(dialog)).toContain("Faith won't be able to join from this invite. You can invite them again.")
      // Keep invite changes nothing.
      await view.click(view.all('button').find((b) => view.text(b) === 'Keep invite'))
      expect(stateOf(await api.getSession(id), 'faith')).toBe('invited')
      await view.click(crosses(view)[0])
      await view.click(view.all('button').find((b) => view.text(b) === 'Take back'))
      await until(() => crosses(view).length === 0)
      expect(stateOf(await api.getSession(id), 'faith')).toBeUndefined()
      expect(view.all('li').some((li) => view.text(li).includes('Faith'))).toBe(false)
      // The page says so, and focus went to the list's heading (the × is gone).
      expect(view.all('[role=status]').map((n) => view.text(n))).toContain("Faith's invite taken back")
      await until(() => view.focused()?.attrs.id === heading)
    })
  }
})
