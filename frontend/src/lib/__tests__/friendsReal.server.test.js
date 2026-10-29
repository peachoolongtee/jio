// A real account's friends (UAT of 29 October 2026, item 8), drawn for real on an in-memory page (domless.js) on the stand-in
// database with its access rules. Friends are the people the account has shared a session with (ticket #125): Lee, who joined
// Sam's first outing with its link, is Sam's friend, and Kim, whom Sam has never been out with, is not. On Sam's next outing the
// Invite page offers Lee to pick, and Send invites writes Lee a personal invitation; Sam's own profile lists Lee under Friends.
// No network.
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
}))
vi.mock('../plannerApi.js', () => planner)
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/spots/SpotPins.vue', () => ({ default: { name: 'SpotPins', render: () => null } }))
vi.mock('../../components/ui/MeetupGraph.vue', () => ({ default: { name: 'MeetupGraph', render: () => null } }))

vi.setConfig({ testTimeout: 40000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const LEE = { email: 'lee@example.com', password: 'Th1rd-secret!', name: 'Lee', username: 'lee_third', dob: '1998-01-02', homeAreaId: 'bishan', friends: [] }
const NEXT = { ...SESSION, title: 'Sunday', date: '2026-10-11' }
const SCREENS = {
  'views/InviteView': () => import('@/views/InviteView.vue'),
  'views/ProfileView': () => import('@/views/ProfileView.vue'),
}

// A new account on the stand-in database, signed in.
// How to call: const lee = await open(database, LEE)
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

// Sam hosts Saturday, which Lee joins with the link; Kim has an account but has never been out with Sam. Sam then makes Sunday.
// Sam's app is the one booted last.
// How to call: const { database, next, sam, lee, kim } = await world()
async function world() {
  const database = createDatabase({ profiles: {} })
  const kim = await open(database, OTHER)
  const lee = await open(database, LEE)
  const sam = await open(database, PROFILE)
  const { id: first } = await sam.api.createSession({ ...SESSION })
  const { token } = await sam.api.makeInviteLink(first)
  await lee.api.joinWithLink(token)
  await boot(sam.fake, {}, { shared: true })
  const { id: next } = await sam.api.createSession({ ...NEXT })
  return { database, first, next, sam, lee, kim }
}

const press = (view, label) => view.all('button').find((b) => view.text(b) === label)
const pick = (view, name) => view.all('button').find((b) => b.attrs['aria-label'] === `Invite ${name}`)
const inviteTo = (database, sessionId, person) => database.tables.invites.find((i) => i.session_id === sessionId && i.invitee_id === person.user.id)

describe("a real account's friends", () => {
  it('are the people it has shared a session with, and a picked friend gets an invitation by name', async () => {
    const { database, next, sam, lee, kim } = await world()
    await sam.api.listSessions()
    const people = await sam.api.listPeople()
    expect(people.filter((p) => p.isFriend).map((p) => p.id)).toEqual([lee.user.id])
    await sam.api.inviteFriends(next, [lee.user.id], { pending: true })
    expect(inviteTo(database, next, lee)).toMatchObject({ created_by: sam.user.id, revoked: false, uses: 0 })
    // Someone Sam has never been out with is reached by username or the link, not as a friend.
    await expect(sam.api.inviteFriends(next, [kim.user.id], { pending: true })).rejects.toThrow('by their username')
    expect(inviteTo(database, next, kim)).toBeUndefined()
  })

  it("are offered on the Invite page of the next outing, and Send invites leaves Lee Invited", async () => {
    const { database, next, lee } = await world()
    const { view } = await draw('views/InviteView', `/sessions/${next}/invite`, { id: next })
    await until(() => !!pick(view, 'Lee'))
    expect(view.text()).toContain('Invite friends')
    expect(pick(view, 'Kim')).toBeUndefined()
    await view.click(pick(view, 'Lee'))
    await view.click(press(view, 'Send 1 invite'))
    await until(() => !!inviteTo(database, next, lee))
    await until(() => view.text().includes('Invited'))
    // Lee is in the session's list now, so is not offered again.
    expect(pick(view, 'Lee')).toBeUndefined()
  })

  it("are listed on the account's own profile, each opening their profile", async () => {
    const { lee } = await world()
    const { view } = await draw('views/ProfileView', '/profile')
    await until(() => view.has('[data-testid="profile-friends"]'))
    const section = view.one('[data-testid="profile-friends"]')
    expect(view.text(section)).toContain('Friends')
    expect(view.text(section)).toContain('Lee')
    expect(view.text(section)).not.toContain('Kim')
    expect(view.all('a').some((a) => a.attrs.href === `/people/${lee.user.id}`)).toBe(true)
  })
})
