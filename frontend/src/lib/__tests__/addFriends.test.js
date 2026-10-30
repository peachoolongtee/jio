// "Add friends" on Home (walkthrough, 30 October 2026): a people button that opens a sheet for finding people on Jio and adding them.
// For a local account: search by name or @username, "Add friend" turns into "Friends" and the person is a friend; for a real account,
// whose friends are the people it has been out with, the sheet says so instead. Drawn on the in-memory page (domless.js).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.setConfig({ testTimeout: 30000 })

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-30T10:00:00+08:00'))
  stubPlanner(planner)
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The button for a new local account (friends with nobody yet), or, with `real`, for an account with an auth id.
// How to call: const { view, api, router } = await draw()
async function draw({ real = false } = {}) {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const auth = useAuthStore()
  await auth.init()
  if (real) auth.user = { ...auth.user, authId: 'u1' }
  const { useGroupsStore } = await import('@/stores/groups.js')
  await useGroupsStore().loadPeople()
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  await router.push('/')
  const { default: AddFriends } = await import('@/components/home/AddFriends.vue')
  // The other person accepts after 100 ms here, not the 2 s of the app.
  const view = await mountScreen(AddFriends, { plugins: [pinia, router], props: { acceptAfter: 100 } })
  return { view, api, router }
}
const press = (view, label) => view.all('button').find((b) => b.attrs['aria-label'] === label || view.text(b) === label)

describe('Add friends on Home', () => {
  it('is a named button that opens a sheet of people to add, each opening their profile', async () => {
    const { view, router } = await draw()
    const button = view.one('[data-testid=add-friends]')
    expect(button.attrs['aria-label']).toBe('Add friends')
    await view.click(button)
    await until(() => view.has('[data-testid=add-friends-list]'))
    expect(view.text('[data-testid=add-friends-list]')).toContain('Mei Ling')
    await view.click(view.all('button').find((b) => view.text(b).includes('@meiling')))
    await until(() => router.currentRoute.value.path === '/people/meiling')
    expect(view.errors).toEqual([])
  })

  it('searches by name or @username', async () => {
    const { view } = await draw()
    await view.click('[data-testid=add-friends]')
    await until(() => view.has('[data-testid=add-friends-search]'))
    view.type('[data-testid=add-friends-search]', '@kai')
    await view.tick()
    expect(view.text('[data-testid=add-friends-list]')).toContain('Kai')
    expect(view.text('[data-testid=add-friends-list]')).not.toContain('Mei Ling')
    view.type('[data-testid=add-friends-search]', 'zzz')
    await view.tick()
    // The sheet is drawn on the page's body, outside the component's own root.
    expect(view.all('p').some((p) => view.text(p) === 'Nobody matches “zzz”.')).toBe(true)
  })

  it('sends a friend request that reads Requested, then is accepted: Friends, the row stays, and the person is a friend', async () => {
    const { view, api } = await draw()
    await view.click('[data-testid=add-friends]')
    await until(() => !!press(view, 'Add Kai as a friend'))
    await view.click(press(view, 'Add Kai as a friend'))
    // Sent, not yet accepted.
    expect(view.has('[data-testid=friend-requested]')).toBe(true)
    expect(view.text('[data-testid=friend-requested]')).toBe('Requested')
    expect(view.text('[data-testid=add-friends-status]')).toBe('Friend request sent to Kai')
    expect(press(view, 'Add Kai as a friend')).toBeUndefined()
    expect((await api.listPeople()).find((p) => p.id === 'kai').isFriend).toBe(false)
    // Accepted.
    await until(() => view.has('[data-testid=friend-added]'))
    expect(view.has('[data-testid=friend-requested]')).toBe(false)
    expect(view.text('[data-testid=add-friends-status]')).toBe('Kai accepted your friend request')
    expect(view.text('[data-testid=add-friends-list]')).toContain('Kai')
    expect((await api.listPeople()).find((p) => p.id === 'kai').isFriend).toBe(true)
  })

  it('still accepts a request when the sheet is closed before it is answered', async () => {
    const { view, api } = await draw()
    await view.click('[data-testid=add-friends]')
    await until(() => !!press(view, 'Add Kai as a friend'))
    await view.click(press(view, 'Add Kai as a friend'))
    await view.click(view.all('button').find((b) => b.attrs['aria-label'] === 'Close'))
    await new Promise((resolve) => setTimeout(resolve, 200))
    expect((await api.listPeople()).find((p) => p.id === 'kai').isFriend).toBe(true)
  })

  it('tells a real account how friends are made, and offers to start a session', async () => {
    const { view, router } = await draw({ real: true })
    await view.click('[data-testid=add-friends]')
    await until(() => view.has('[data-testid=add-friends-real]'))
    expect(view.text('[data-testid=add-friends-real]')).toContain('Your friends on Jio are the people you go out with.')
    expect(view.has('[data-testid=add-friends-list]')).toBe(false)
    await view.click(press(view, 'Start a session'))
    await until(() => router.currentRoute.value.path === '/sessions/new')
  })
})

describe("the profile's Suggested", () => {
  it('sends the same friend request: Requested, then Friends after two seconds, and the row stays', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const { sendFriendRequest, useFriendRequests } = await import('../friendRequests.js')
    const setFriend = vi.fn().mockResolvedValue()
    const accepted = vi.fn()
    const { requested, announcement } = useFriendRequests()
    const done = sendFriendRequest({ id: 'kai', name: 'Kai' }, setFriend, { onAccepted: accepted })
    expect(requested.value.has('kai')).toBe(true)
    expect(announcement.value).toBe('Friend request sent to Kai')
    // A second press while it waits sends nothing more.
    sendFriendRequest({ id: 'kai', name: 'Kai' }, setFriend)
    await vi.advanceTimersByTimeAsync(1999)
    expect(setFriend).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await done
    expect(setFriend).toHaveBeenCalledTimes(1)
    expect(setFriend).toHaveBeenCalledWith('kai', true)
    expect(accepted).toHaveBeenCalledWith('kai')
    expect(requested.value.has('kai')).toBe(false)
    expect(announcement.value).toBe('Kai accepted your friend request')
  })

  it('says why when the friendship could not be saved, and lets the person try again', async () => {
    vi.useFakeTimers({ toFake: ['Date', 'setTimeout'] })
    const { sendFriendRequest, useFriendRequests } = await import('../friendRequests.js')
    const failed = vi.fn()
    const done = sendFriendRequest({ id: 'siti', name: 'Siti' }, vi.fn().mockRejectedValue(new Error('Saving failed.')), { onFailed: failed })
    await vi.advanceTimersByTimeAsync(2000)
    await done
    expect(failed).toHaveBeenCalledWith('Saving failed.')
    expect(useFriendRequests().requested.value.has('siti')).toBe(false)
  })
})
