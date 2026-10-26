// Every session screen follows the host's change of the meeting place (lib/followRelease.js, called once by the app frame): a guest on Vote,
// Itinerary, What next?, the map or the photos goes to Locate when the session goes back to locating, waits briefly and looks again so that
// "We already know where" (locating for a moment, then voting at the new area) lands on Vote with the notice, and is left alone on Locate and on
// the host's own page. Drawn on the stand-in database and server, with the real stores. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { mountScreen, until } from './domless.js'
import { confirmed, voted } from './sessionsWorld.js'

vi.setConfig({ testTimeout: 40000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const WAIT = 80

// The app frame's part: the follower, in the app opened last (the guest's), with the session loaded and watched live.
// How to call: const { router, events } = await atPath(id, 'plan')
async function atPath(id, tail) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const events = (await import('@/stores/events.js')).useEventsStore()
  const { watchSessions } = await import('@/lib/api.js')
  const { useFollowRelease } = await import('@/lib/followRelease.js')
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(`/sessions/${id}${tail ? `/${tail}` : ''}`)
  await events.loadSession(id)
  const stop = watchSessions()
  const Frame = { setup() { useFollowRelease({ wait: WAIT }); return () => null } }
  const view = await mountScreen(Frame, { plugins: [pinia, router] })
  return { router, events, view, stop }
}

describe('a guest on a session screen when the host releases the meeting area', () => {
  it.each(['plan', 'roam', 'map', 'photos'])('on %s goes to Locate', async (screen) => {
    const { id, sam } = await voted()
    const { router, stop } = await atPath(id, screen)
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
    stop()
  })

  it('on the Itinerary of a confirmed plan goes to Locate', async () => {
    const { id, sam } = await confirmed()
    const { router, stop } = await atPath(id, 'itinerary')
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
    stop()
  })

  it('waits before it leaves: it is still on the screen just after the session went back to locating', async () => {
    const { id, sam } = await voted()
    const { router, events, stop } = await atPath(id, 'plan')
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    await until(() => events.byId[id]?.status === 'locating')
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/plan`)
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
    stop()
  })

  it('"We already know where": from the Itinerary the guest ends on Vote, where the notice is, not on Locate', async () => {
    const { id, sam } = await confirmed()
    const { router, events, stop } = await atPath(id, 'itinerary')
    await sam.api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'orchard' })
    await until(() => router.currentRoute.value.path === `/sessions/${id}/plan`)
    await new Promise((resolve) => setTimeout(resolve, WAIT * 3))
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/plan`)
    expect(events.byId[id]).toMatchObject({ status: 'voting', banner: expect.objectContaining({ released: true, votesCleared: true }) })
    stop()
  })

  it('"We already know where": a guest already on Vote stays there', async () => {
    const { id, sam } = await voted()
    const { router, stop } = await atPath(id, 'plan')
    await sam.api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'orchard' })
    await new Promise((resolve) => setTimeout(resolve, WAIT * 4))
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}/plan`)
    stop()
  })

  it('looks again after the wait: when the session is voting again by then (a spot confirmed meanwhile), a guest on Vote stays on Vote', async () => {
    const { id, sam } = await voted()
    const onVote = await atPath(id, 'plan')
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    await sam.api.useMeetingArea(id)
    await new Promise((resolve) => setTimeout(resolve, WAIT * 4))
    expect(onVote.router.currentRoute.value.path).toBe(`/sessions/${id}/plan`)
    onVote.stop()
  })

  it('leaves alone a guest on Locate and on a page that is not a session screen', async () => {
    const { id, sam } = await voted()
    const locate = await atPath(id, '')
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    await new Promise((resolve) => setTimeout(resolve, WAIT * 3))
    expect(locate.router.currentRoute.value.path).toBe(`/sessions/${id}`)
    locate.stop()
  })
})
