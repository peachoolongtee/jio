// "Jio remembers" for a real account, drawn for real on an in-memory page (domless.js) on the stand-in database and the stand-in Jio server
// (whose GET .../travel-lean answers the caller's own flag; the server's own rules for it are tested in backend/tests/sessions-travel-lean.test.js):
// the Locate step shows one quiet line on the first spot to the person it applies to, when the spot is closer to them than to the group on
// average, and nothing to the other member of the same session, nor when the read fails or the answer is not one it knows. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { mountScreen, until } from './domless.js'
import { locating } from './sessionsWorld.js'
import { leanLine } from '../travelLean.js'

// The map needs a real browser (Leaflet).
vi.mock('../../components/map/PlannerMap.vue', () => ({ default: { name: 'PlannerMap', render: () => null } }))
vi.mock('../../components/spots/SpotPins.vue', () => ({ default: { name: 'SpotPins', render: () => null } }))

vi.setConfig({ testTimeout: 40000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// The Locate step, drawn as the person whose app was opened last.
// How to call: const { view } = await draw(id)
async function draw(id) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const auth = useAuthStore()
  await auth.init()
  const events = (await import('@/stores/events.js')).useEventsStore()
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push(`/sessions/${id}`)
  const { default: View } = await import('@/views/GroupDetailView.vue')
  const view = await mountScreen(View, { plugins: [pinia, router], props: { id } })
  await until(() => view.text().includes('Where to meet'))
  return { view, events }
}

const leanCalls = (w) => w.server.calls.filter((c) => c.route === 'travelLean')
const LINE = '[data-testid="spots-lean"]'

// In these sessions Sam starts at Pasir Ris and Kim at Bishan, and the first spot is clearly closer to Kim. From Tampines (the helper's own start)
// the fairest MRT station is Ubi, about 21 minutes from each of them, which is closer to nobody.
const SAM_FAR = { areaId: 'pasir-ris', label: 'Pasir Ris Mall' }
describe('the line on the Locate step of a session on the server', () => {
  it('shows the person it applies to the line on the first spot when it is closer to them, and nothing else about anyone', async () => {
    const { w, kim, id } = await locating({ places: true, samPlace: SAM_FAR })
    w.server.owed = new Set([kim.id])
    const { view } = await draw(id)
    await until(() => view.has(LINE))
    expect(view.text(view.one(LINE))).toBe(leanLine('longest'))
    expect(view.text(view.one(LINE))).toBe('This spot is closer to you.')
    expect(leanCalls(w).every((c) => c.as === kim.id)).toBe(true)
    expect(view.text()).not.toMatch(/Sam.{0,40}closer to you/)
    expect(view.errors).toEqual([])
  })

  it('shows nothing to the other member of the same session', async () => {
    const { w, sam, kim, id } = await locating({ places: true, samPlace: SAM_FAR })
    w.server.owed = new Set([sam.id])
    const { view } = await draw(id)
    await until(() => leanCalls(w).length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(leanCalls(w).every((c) => c.as === kim.id)).toBe(true)
    expect(view.has(LINE)).toBe(false)
    expect(view.text()).not.toContain('closer to you')
  })

  it('shows nothing to a person who is owed but whose trip to the first spot is the longer one', async () => {
    const { w, sam, id } = await locating({ places: true, samPlace: SAM_FAR, hostLast: true })
    w.server.owed = new Set([sam.id])
    const { view } = await draw(id)
    await until(() => leanCalls(w).length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(leanCalls(w).every((c) => c.as === sam.id)).toBe(true)
    expect(view.has(LINE)).toBe(false)
  })

  it('says the same thing under the balanced rule when the server names it', async () => {
    const { w, kim, id } = await locating({ places: true, samPlace: SAM_FAR })
    w.server.owed = new Set([kim.id])
    w.server.leanRule = 'balanced'
    const { view } = await draw(id)
    await until(() => view.has(LINE))
    expect(view.text(view.one(LINE))).toBe('This spot is closer to you.')
  })

  it('shows nothing when the read fails, or the answer names a rule the screen does not know', async () => {
    const failed = await locating({ places: true, samPlace: SAM_FAR })
    failed.w.server.owed = new Set([failed.kim.id])
    failed.w.server.after.travelLean = async () => {
      throw new Error('boom')
    }
    const first = await draw(failed.id)
    await until(() => leanCalls(failed.w).length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(first.view.has(LINE)).toBe(false)
    expect(first.view.has('[role=alert]')).toBe(false)
    expect(first.view.text()).toContain('Where to meet')

    const strange = await locating({ places: true, samPlace: SAM_FAR })
    strange.w.server.owed = new Set([strange.kim.id])
    strange.w.server.leanRule = 'shortest'
    const second = await draw(strange.id)
    await until(() => leanCalls(strange.w).length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(second.view.has(LINE)).toBe(false)
  })

  it('shows nothing when the answer is no', async () => {
    const { w, id } = await locating({ places: true, samPlace: SAM_FAR })
    const { view } = await draw(id)
    await until(() => leanCalls(w).length > 0)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(view.has(LINE)).toBe(false)
  })
})
