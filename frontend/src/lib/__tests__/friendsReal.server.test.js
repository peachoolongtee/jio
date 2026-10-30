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
const MIA = { email: 'mia@example.com', password: 'F0urth-secret!', name: 'Mia', username: 'mia_fourth', dob: '1997-03-04', homeAreaId: 'clementi', friends: [] }
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
const pick = (view, name) => view.all('button').find((b) => b.attrs['aria-label'] === `Select ${name}` || b.attrs['aria-label'] === `Selected ${name}`)
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
    // The chip's accessible name starts with the words on it (WCAG 2.5.3), before and after it is pressed.
    expect(pick(view, 'Lee').attrs['aria-label']).toBe('Select Lee')
    expect(view.text(pick(view, 'Lee'))).toBe('Select')
    await view.click(pick(view, 'Lee'))
    expect(pick(view, 'Lee').attrs['aria-label']).toBe('Selected Lee')
    expect(view.text(pick(view, 'Lee'))).toBe('Selected')
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

// Sam's friends here are Kim, Lee and Mia, all of whom joined Saturday with its link; Sunday is the next outing.
// How to call: const { database, profiles, next, sam, kim, lee, mia } = await crowd()
async function crowd() {
  const profiles = {}
  const database = createDatabase({ profiles })
  const kim = await open(database, OTHER)
  const lee = await open(database, LEE)
  const mia = await open(database, MIA)
  const sam = await open(database, PROFILE)
  const { id: first } = await sam.api.createSession({ ...SESSION })
  const { token } = await sam.api.makeInviteLink(first)
  for (const guest of [kim, lee, mia]) await guest.api.joinWithLink(token)
  await boot(sam.fake, {}, { shared: true })
  const { id: next } = await sam.api.createSession({ ...NEXT })
  return { database, profiles, first, next, sam, kim, lee, mia }
}

describe('friends who cannot be invited by name', () => {
  it("leaves out someone whose invite was taken back, and Select all then Send invites the others", async () => {
    const { database, next, sam, kim, lee, mia } = await crowd()
    await sam.api.listSessions()
    await sam.api.inviteByUsername(next, kim.user.id)
    await sam.api.revokeInvite(next, kim.user.id)
    const { view } = await draw('views/InviteView', `/sessions/${next}/invite`, { id: next })
    await until(() => !!pick(view, 'Lee') && !!pick(view, 'Mia'))
    expect(pick(view, 'Kim')).toBeUndefined()
    await view.click(press(view, 'Select all'))
    await view.click(press(view, 'Send 2 invites'))
    await until(() => !!inviteTo(database, next, lee) && !!inviteTo(database, next, mia))
    expect(view.has('p[role=alert]')).toBe(false)
    // Kim keeps her one, taken back invitation; nothing new was written for her.
    expect(database.tables.invites.filter((i) => i.session_id === next && i.invitee_id === kim.user.id)).toHaveLength(1)
    expect(inviteTo(database, next, kim).revoked).toBe(true)
  })

  it('also leaves out someone who declined, and someone who opted out of the session', async () => {
    const { database, next, sam, kim, lee, mia } = await crowd()
    await sam.api.listSessions()
    await sam.api.inviteByUsername(next, kim.user.id)
    inviteTo(database, next, kim).declined_at = new Date().toISOString()
    // Mia has a member row of her own that is not joined (she opted out).
    database.tables.session_members.push({ session_id: next, user_id: mia.user.id, role: 'guest', state: 'opted_out', start_area_id: null, end_area_id: null, categories: [], stay_until: null, travel_minutes: null, joined_at: new Date().toISOString(), updated_at: new Date().toISOString() })
    const { view } = await draw('views/InviteView', `/sessions/${next}/invite`, { id: next })
    await until(() => !!pick(view, 'Lee'))
    expect(pick(view, 'Kim')).toBeUndefined()
    expect(pick(view, 'Mia')).toBeUndefined()
  })

  it('invites the rest and then says how many could not be invited, when a stale list still sends someone who cannot be', async () => {
    const { database, next, sam, kim, lee, mia } = await crowd()
    await sam.api.listSessions()
    await sam.api.inviteByUsername(next, kim.user.id)
    await sam.api.revokeInvite(next, kim.user.id)
    // Kim was picked before she was taken back; Lee was already invited a moment ago; Mia is new.
    await sam.api.inviteByUsername(next, lee.user.id)
    const sent = sam.api.inviteFriends(next, [kim.user.id, lee.user.id, mia.user.id], { pending: true })
    await expect(sent).rejects.toThrow('1 person could not be invited')
    const error = await sent.catch((e) => e)
    expect(error.message).toContain("only the session's link works for them")
    expect(error.message).toContain('The rest are invited.')
    expect(error.invited).toEqual([mia.user.id])
    expect(error.skipped).toEqual([lee.user.id])
    expect(error.blocked).toEqual([kim.user.id])
    expect(inviteTo(database, next, mia)).toMatchObject({ revoked: false })
    // Lee is not invited twice.
    expect(database.tables.invites.filter((i) => i.session_id === next && i.invitee_id === lee.user.id)).toHaveLength(1)
  })

  it('on the Invite page, a refusal leaves only the refused person picked, so a retry sends no one twice', async () => {
    const { database, profiles, next, kim, lee, mia } = await crowd()
    const { view } = await draw('views/InviteView', `/sessions/${next}/invite`, { id: next })
    await until(() => !!pick(view, 'Kim') && !!pick(view, 'Lee') && !!pick(view, 'Mia'))
    await view.click(press(view, 'Select all'))
    expect(press(view, 'Send 3 invites')).toBeDefined()
    delete profiles[kim.user.id]
    await view.click(press(view, 'Send 3 invites'))
    await until(() => view.has('p[role=alert]'))
    expect(view.text(view.one('p[role=alert]'))).toMatch(/^1 person could not be invited: /)
    expect(inviteTo(database, next, lee)).toBeDefined()
    expect(inviteTo(database, next, mia)).toBeDefined()
    // Lee and Mia went through, so only Kim is still picked, and the count says so.
    await until(() => !!press(view, 'Send 1 invite'))
    expect(view.text()).toContain('1 selected')
  })

  it('carries on past a refusal for one person, and the sentence names how many', async () => {
    const { database, profiles, next, sam, kim, lee, mia } = await crowd()
    await sam.api.listSessions()
    // The database refuses Kim (her account is gone) but not the two before and after her in the list.
    delete profiles[kim.user.id]
    const sent = sam.api.inviteFriends(next, [lee.user.id, kim.user.id, mia.user.id], { pending: true })
    const error = await sent.then(() => null, (e) => e)
    expect(error.message).toMatch(/^1 person could not be invited: .*The rest are invited\.$/)
    expect(error.invited).toEqual([lee.user.id, mia.user.id])
    expect(inviteTo(database, next, lee)).toBeDefined()
    expect(inviteTo(database, next, mia)).toBeDefined()
    expect(inviteTo(database, next, kim)).toBeUndefined()
  })
})

describe("the profile's Friends list", () => {
  it('shows six, says how many more, and opens the rest', async () => {
    const database = createDatabase({ profiles: {} })
    const guests = []
    for (let n = 1; n <= 9; n++) guests.push(await open(database, { ...OTHER, email: `g${n}@example.com`, name: `Guest ${n}`, username: `guest_${n}` }))
    const sam = await open(database, PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    const { token } = await sam.api.makeInviteLink(id)
    for (const guest of guests) await guest.api.joinWithLink(token)
    await boot(sam.fake, {}, { shared: true })
    const { view } = await draw('views/ProfileView', '/profile')
    const rows = () => view.all('a').filter((a) => a.attrs.href?.startsWith('/people/') && view.text(a).includes('@guest_'))
    await until(() => view.has('[data-testid="profile-friends-more"]'))
    expect(rows()).toHaveLength(6)
    const more = view.one('[data-testid="profile-friends-more"]')
    expect(view.text(more)).toBe('Show 3 more')
    expect(more.attrs['aria-expanded']).toBe('false')
    await view.click(more)
    expect(rows()).toHaveLength(9)
    expect(view.text(view.one('[data-testid="profile-friends-more"]'))).toBe('Show fewer friends')
    await view.click(view.one('[data-testid="profile-friends-more"]'))
    expect(rows()).toHaveLength(6)
  })

  it('has no button when there are six or fewer', async () => {
    const { lee } = await world()
    const { view } = await draw('views/ProfileView', '/profile')
    await until(() => view.has('[data-testid="profile-friends"]'))
    expect(view.has('[data-testid="profile-friends-more"]')).toBe(false)
    expect(lee).toBeDefined()
  })
})
