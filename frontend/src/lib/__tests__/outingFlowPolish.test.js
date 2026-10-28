// The lead's notes of 27 October on the outing's flow: sharing a photo (lib/sharePhoto.js), the review of a finished outing
// (lib/api.js saveReview), and the way on from the Invite page back to the Start choice (views/InviteView.vue).
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { loadApi, stubPlanner } from './planFixture.js'
import { mountScreen, until } from './domless.js'
import { photoFileName, shareTargets, shareText, sharePhoto } from '../sharePhoto.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), roamNearby: vi.fn(), forecast: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.mock('@/components/map/PlannerMap.vue', () => ({ default: { render: () => null } }))
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 })

const at = (iso) => vi.setSystemTime(new Date(iso))
const mounted = []

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
})
beforeEach(() => {
  stubPlanner(planner)
  at('2026-10-17T14:20:00+08:00')
})
afterEach(() => {
  mounted.splice(0).forEach((view) => view.unmount())
  vi.unstubAllGlobals()
})
afterAll(() => {
  vi.useRealTimers()
})

// A new local account, signed in.
// How to call: const api = await signedIn()
async function signedIn() {
  const api = await loadApi()
  await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  return api
}

describe('sharing a photo', () => {
  const photo = { id: 'p12', src: 'data:image/jpeg;base64,/9j/' }

  it('names the outing, and where the photo was taken when that is known', () => {
    expect(shareText({ title: 'Saturday' }, 'Maxwell Food Centre')).toBe('Saturday at Maxwell Food Centre, on Jio')
    expect(shareText({ title: 'Saturday' })).toBe('Saturday, on Jio')
    expect(photoFileName({ title: 'Sat @ Bugis!' }, photo)).toBe('jio-sat-bugis-p12.jpg')
  })

  it('offers WhatsApp, Instagram and Telegram, with the words where the app takes them', () => {
    const targets = shareTargets('Saturday, on Jio')
    expect(targets.map((t) => t.id)).toEqual(['whatsapp', 'instagram', 'telegram'])
    expect(targets[0].href).toBe('https://wa.me/?text=Saturday%2C%20on%20Jio')
    expect(targets[1].href).toBe('https://www.instagram.com/')
  })

  it("hands the picture to the phone's share sheet, and says when the person closed it", async () => {
    const share = vi.fn().mockResolvedValue(undefined)
    const nav = { share, canShare: () => true }
    expect(await sharePhoto({ src: photo.src, name: 'a.jpg', text: 'Saturday, on Jio' }, nav)).toBe('shared')
    const sent = share.mock.calls[0][0]
    expect(sent.files[0].name).toBe('a.jpg')
    expect(sent.text).toBe('Saturday, on Jio')
    share.mockRejectedValueOnce(Object.assign(new Error('closed'), { name: 'AbortError' }))
    expect(await sharePhoto({ src: photo.src, name: 'a.jpg', text: '' }, nav)).toBe('cancelled')
  })

  it('says it cannot when the browser has no share sheet, cannot share a picture, or refuses', async () => {
    expect(await sharePhoto({ src: photo.src, name: 'a.jpg', text: '' }, {})).toBe('unsupported')
    expect(await sharePhoto({ src: photo.src, name: 'a.jpg', text: '' }, { share: vi.fn(), canShare: () => false })).toBe('unsupported')
    const refused = { share: vi.fn().mockRejectedValue(Object.assign(new Error('no'), { name: 'NotAllowedError' })), canShare: () => true }
    expect(await sharePhoto({ src: photo.src, name: 'a.jpg', text: '' }, refused)).toBe('unsupported')
  })
})

describe('reviewing a finished outing', () => {
  it('keeps the stars, the stops that were rated and the note, and replaces them when saved again', async () => {
    const api = await signedIn()
    const { id } = await api.startRoam({ areaId: 'bugis' })
    await api.endPlan(id)
    const saved = await api.saveReview(id, 'ian', { stars: 4, stops: { gone: 3 }, note: '  Great laksa  ' })
    expect(saved.reviews.ian).toMatchObject({ stars: 4, stops: {}, note: 'Great laksa' })
    const again = await api.saveReview(id, 'ian', { stars: 5 })
    expect(again.reviews.ian).toMatchObject({ stars: 5, stops: {}, note: '' })
  })

  it('refuses before the outing has finished, without stars, and a note that is too long', async () => {
    const api = await signedIn()
    const { id } = await api.startRoam({ areaId: 'bugis' })
    await expect(api.saveReview(id, 'ian', { stars: 4 })).rejects.toThrow('once it has finished')
    await api.endPlan(id)
    await expect(api.saveReview(id, 'ian', { stars: 0 })).rejects.toThrow('1 to 5 stars')
    await expect(api.saveReview(id, 'ian', { stars: 6 })).rejects.toThrow('1 to 5 stars')
    await expect(api.saveReview(id, 'ian', { stars: 3, note: 'x'.repeat(api.REVIEW_NOTE_MAX + 1) })).rejects.toThrow('at most')
  })
})

describe('the way on from the Invite page', () => {
  // The app's stores and router, the Invite page drawn for session `id`.
  // How to call: const { view, router } = await invitePage(api, id)
  async function invitePage(api, id) {
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    const { routes } = await import('@/router/routes.js')
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    vi.stubGlobal('window', { history: { state: null, replaceState() {} } })
    await router.push(`/sessions/${id}/invite`)
    const { default: InviteView } = await import('@/views/InviteView.vue')
    const view = await mountScreen(InviteView, { plugins: [pinia, router], props: { id } })
    mounted.push(view)
    return { view, router }
  }
  const onward = (view) => view.all('[data-testid="invite-onward"]')[0]

  it('takes a host with two in back to the Start choice, with nobody selected', async () => {
    const api = await signedIn()
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-18', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['faith'])
    const { view, router } = await invitePage(api, id)
    await until(() => !!onward(view))
    expect(view.text(onward(view))).toContain('Start session')
    await view.click(onward(view))
    await until(() => router.currentRoute.value.path === `/sessions/${id}/start`)
  })

  it('says Done and goes to the session page while the host is alone', async () => {
    const api = await signedIn()
    const { id } = await api.createSession({ title: 'Saturday', date: '2026-10-18', start: '12:00', end: '20:00' })
    const { view, router } = await invitePage(api, id)
    await until(() => !!onward(view))
    expect(view.text(onward(view))).toContain('Done')
    await view.click(onward(view))
    await until(() => router.currentRoute.value.path === `/sessions/${id}`)
  })
})
