// The navigation's Create goes straight into the create page, for every account (Faith's walkthrough, 30 October 2026: the menu that
// asked "New session" or "Already out" first is gone; "Already out" is a link on the create page). Drawn on the in-memory page
// (domless.js); the "entering a game" move needs a browser, so here it just navigates.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { mountScreen, until } from './domless.js'
import { START_MODES, startModesFor } from '../startChoice.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.setConfig({ testTimeout: 20000 })
afterEach(() => vi.unstubAllGlobals())

describe('the ways to start', () => {
  it('are New session and Already out for the demo and local accounts, each with where it opens', () => {
    expect(startModesFor(true).map((m) => [m.label, m.to])).toEqual([['New session', '/sessions/new'], ['Already out', '/sessions/new?start=out']])
    expect(START_MODES.scratch.hint).toBeTruthy()
    expect(START_MODES.out.hint).toBeTruthy()
  })

  it('are New session alone for a real account', () => {
    expect(startModesFor(false).map((m) => m.value)).toEqual(['scratch'])
  })
})

describe('Create in the navigation', () => {
  // The tab bar for an account: `real` signs in a real account (one with an auth id), otherwise a local one.
  async function draw({ real = false } = {}) {
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    useAuthStore().user = real ? { id: 'u1', authId: 'u1', name: 'Sam' } : { id: 'ian', name: 'Ian', local: true }
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: stub }] })
    await router.push('/')
    const { default: TabBar } = await import('@/components/ui/TabBar.vue')
    const view = await mountScreen(TabBar, { plugins: [pinia, router] })
    return { view, router }
  }
  const button = (view) => view.one('[data-testid=create-button]')

  it('goes straight to the create page for the demo account, with no menu', async () => {
    const { view, router } = await draw()
    expect(button(view).attrs['aria-haspopup']).toBeUndefined()
    expect(button(view).attrs['aria-label']).toBe('Create session')
    await view.click(button(view))
    await until(() => router.currentRoute.value.fullPath === '/sessions/new')
    expect(view.has('[data-testid=create-menu]')).toBe(false)
    expect(view.errors).toEqual([])
  })

  it('goes straight to the create page for a real account, with no menu', async () => {
    const { view, router } = await draw({ real: true })
    expect(button(view).attrs['aria-haspopup']).toBeUndefined()
    await view.click(button(view))
    await until(() => router.currentRoute.value.fullPath === '/sessions/new')
    expect(view.has('[data-testid=create-menu]')).toBe(false)
  })
})
