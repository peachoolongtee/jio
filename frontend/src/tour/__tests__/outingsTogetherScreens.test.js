// Outings together on the profile screens, drawn for real (lib/__tests__/domless.js) on the demo tour's data: someone's profile
// says "N outings together · last on <day>" only when the two have finished an outing together, and the signed-in person's Friends
// list carries the count beside each name. The tour's last save is the finished outing; at checkpoint 1 it is hidden
// (lib/sessionFilter.js), so nothing is shown. The planner backend is not there (a closed port).
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { loadApi } from '../../lib/__tests__/planFixture.js'
import { mountScreen, until } from '../../lib/__tests__/domless.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'

vi.mock('../../components/ui/GridPulse.vue', () => ({ default: { name: 'GridPulse', render: () => null } }))
vi.mock('../../components/ui/MeetupGraph.vue', () => ({ default: { name: 'MeetupGraph', render: () => null } }))
vi.setConfig({ testTimeout: 90000, hookTimeout: 90000 })

const NOW = new Date('2026-10-10T14:20:00')
const stubPhotos = async (kinds, count) => Array.from({ length: count }, (_, i) => `data:image/jpeg;base64,AAAA${i}`)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(NOW)
})
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The data layer on a fake storage, signed in as the demo account, the tour loaded and attached.
// How to call: const t = await boot()
async function boot() {
  const api = await loadApi()
  await api.signUp(DEMO_ACCOUNT)
  api.api.defaults.baseURL = 'http://127.0.0.1:1'
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useTourStore } = await import('../store.js')
  const tour = useTourStore()
  await tour.attach()
  await tour.settled()
  await tour.start({ now: NOW, makePhotos: stubPhotos })
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { useEventsStore } = await import('@/stores/events.js')
  return { api, tour, pinia, events: useEventsStore(), auth: useAuthStore() }
}

// The profile screen at a path, with the sessions read again for the checkpoint that is selected.
// How to call: const view = await profile(t, '/people/darius', { id: 'darius' })
async function profile(t, path, props = {}) {
  t.events.sessions = []
  t.events.loaded = false
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(path)
  const { default: View } = await import('@/views/ProfileView.vue')
  const view = await mountScreen(View, { plugins: [t.pinia, router], props })
  await until(() => view.has('[data-testid=profile-view]') && t.events.loaded)
  await view.tick()
  return view
}

describe('outings together on the profile screens', () => {
  let t
  beforeAll(async () => {
    t = await boot()
  })

  it('says nothing on a friend\'s profile at checkpoint 1, where no outing has finished', async () => {
    t.tour.select(0)
    const view = await profile(t, '/people/darius', { id: 'darius' })
    expect(view.errors).toEqual([])
    expect(view.has('[data-testid=outings-together-line]')).toBe(false)
  })

  it('says how many and the day of the last on a friend\'s profile once the outing has finished', async () => {
    t.tour.select(9)
    const view = await profile(t, '/people/darius', { id: 'darius' })
    expect(view.errors).toEqual([])
    const line = view.text(view.all('[data-testid=outings-together-line]')[0])
    expect(line).toMatch(/^\d+ outings? together · last on \d{1,2} [A-Z][a-z]{2} 2026$/)
  })

  it('says nothing on a profile of someone the person has not been out with', async () => {
    t.tour.select(9)
    const view = await profile(t, '/people/jonathan', { id: 'jonathan' })
    expect(view.has('[data-testid=outings-together-line]')).toBe(false)
  })

  it('puts the count beside the names in the signed-in person\'s own Friends sheet, and no line under their own name', async () => {
    t.tour.select(9)
    const view = await profile(t, '/profile')
    expect(view.errors).toEqual([])
    expect(view.has('[data-testid=outings-together-line]')).toBe(false)
    // The friends are in the sheet the Friends count opens.
    await view.click(view.one('[data-testid=friends-count]'))
    await until(() => view.has('[data-testid=friends-list]'))
    const badges = view.all('[data-testid=outings-together]')
    expect(badges.length).toBeGreaterThanOrEqual(1)
    expect(view.text(badges[0])).toMatch(/outings? together/)
  })

  it('reads the sessions only when they have not been read, not on every mount or change of person', async () => {
    t.tour.select(9)
    await t.events.loadSessions()
    const read = vi.spyOn(t.events, 'loadSessions')
    const { routes } = await import('@/router/routes.js')
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    await router.push('/people/darius')
    const { default: View } = await import('@/views/ProfileView.vue')
    const view = await mountScreen(View, { plugins: [t.pinia, router], props: { id: 'darius' } })
    await until(() => view.has('[data-testid=profile-view]'))
    expect(t.events.loaded).toBe(true)
    expect(read).not.toHaveBeenCalled()
    t.events.loaded = false
    const again = await mountScreen(View, { plugins: [t.pinia, router], props: { id: 'darius' } })
    await until(() => again.has('[data-testid=profile-view]'))
    expect(read).toHaveBeenCalledTimes(1)
    read.mockRestore()
  })

  it('shows no badge in Friends at checkpoint 1', async () => {
    t.tour.select(0)
    const view = await profile(t, '/profile')
    expect(view.all('[data-testid=outings-together]')).toHaveLength(0)
  })
})

describe('the milestone line on a finished outing', () => {
  let t
  beforeAll(async () => {
    t = await boot()
  })

  // The component for the tour's finished outing (the save the last checkpoint shows). With `read` false the sessions are marked unread.
  // How to call: const view = await milestone(t, { announce: true })
  async function milestone(t, props = {}, read = true) {
    t.tour.select(9)
    await t.events.loadSessions()
    const { visibleSessions } = await import('@/lib/sessionFilter.js')
    const session = visibleSessions(t.events.sessions).find((x) => x.status === 'completed')
    t.events.loaded = read
    const { default: View } = await import('@/components/event/OutingMilestone.vue')
    const { useGroupsStore } = await import('@/stores/groups.js')
    await useGroupsStore().loadPeople()
    const view = await mountScreen(View, { plugins: [t.pinia], props: { session, ...props } })
    // The line waits for the people to be read, so give that read time to finish.
    if (read) await until(() => view.has('[data-testid=outing-milestone]'))
    else await view.tick()
    return view
  }

  it('says nothing until the sessions have been read, as the count needs them', async () => {
    const view = await milestone(t, {}, false)
    expect(view.has('[data-testid=outing-milestone]')).toBe(false)
  })

  it('draws nothing while the people are being read, so the status never says "Someone", then names the friends', async () => {
    t.tour.select(9)
    await t.events.loadSessions()
    const { visibleSessions } = await import('@/lib/sessionFilter.js')
    const session = visibleSessions(t.events.sessions).find((x) => x.status === 'completed')
    t.events.loaded = true
    const { useGroupsStore } = await import('@/stores/groups.js')
    const groups = useGroupsStore()
    await groups.loadPeople()
    const people = [...groups.people]
    groups.people = []
    let release
    const real = groups.loadPeople
    groups.loadPeople = () => new Promise((resolve) => { release = () => { groups.people = people; resolve() } })
    const { default: View } = await import('@/components/event/OutingMilestone.vue')
    const view = await mountScreen(View, { plugins: [t.pinia], props: { session, announce: true } })
    await view.tick()
    expect(view.has('[data-testid=outing-milestone]')).toBe(false)
    expect(view.text()).not.toContain('Someone')
    release()
    await until(() => view.has('[data-testid=outing-milestone]'))
    expect(view.text(view.one('[data-testid=outing-milestone]'))).not.toContain('Someone')
    groups.loadPeople = real
  })

  it('draws the line with the neutral name when the people cannot be read', async () => {
    t.tour.select(9)
    await t.events.loadSessions()
    const { visibleSessions } = await import('@/lib/sessionFilter.js')
    const session = visibleSessions(t.events.sessions).find((x) => x.status === 'completed')
    t.events.loaded = true
    const { useGroupsStore } = await import('@/stores/groups.js')
    const groups = useGroupsStore()
    const real = groups.loadPeople
    groups.people = []
    groups.loadPeople = () => Promise.reject(new Error('offline'))
    const { default: View } = await import('@/components/event/OutingMilestone.vue')
    const view = await mountScreen(View, { plugins: [t.pinia], props: { session } })
    await until(() => view.has('[data-testid=outing-milestone]'))
    expect(view.text(view.one('[data-testid=outing-milestone]'))).toContain('Someone')
    groups.loadPeople = real
  })

  it('names the friends of a first outing together, in a polite status when the person just finished it', async () => {
    const view = await milestone(t, { announce: true })
    const line = view.one('[data-testid=outing-milestone]')
    expect(view.text(line)).toMatch(/^That's your first outing with \w+, \w+ and 1 other\.$/)
    expect(line.attrs.role).toBe('status')
  })

  it('is plain text, with no role, when the person did not just finish it', async () => {
    const view = await milestone(t)
    const line = view.one('[data-testid=outing-milestone]')
    expect(view.text(line)).toContain("That's your first outing with")
    expect(line.attrs.role).toBeUndefined()
  })
})
