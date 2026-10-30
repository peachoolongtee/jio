// The navigation's Create (walkthrough, 30 October 2026): a menu asks how to start, "New session" or "Already out", before the create
// page opens, and a real account (which has no "Already out") goes straight in. Drawn on the in-memory page (domless.js); the
// "entering a game" move needs a browser, so here it just navigates.
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

  it('is a menu button that opens New session and Already out, and opens nothing until one is picked', async () => {
    const { view, router } = await draw()
    expect(button(view).attrs['aria-haspopup']).toBe('menu')
    expect(button(view).attrs['aria-expanded']).toBe('false')
    expect(button(view).attrs['aria-label']).toBe('Create session')
    expect(view.has('[data-testid=create-menu]')).toBe(false)
    await view.click(button(view))
    expect(button(view).attrs['aria-expanded']).toBe('true')
    expect(view.one('[data-testid=create-menu]').attrs.role).toBe('menu')
    const items = view.all('[role=menuitem]').map((b) => view.text(b))
    expect(items).toHaveLength(2)
    expect(items[0]).toMatch(/^New session.*Pick a day and invite friends$/)
    expect(items[1]).toMatch(/^Already out.*Find places near you now$/)
    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(view.errors).toEqual([])
  })

  it('opens the create page in Already out mode, and closes the menu', async () => {
    const { view, router } = await draw()
    await view.click(button(view))
    await view.click('[data-testid=create-out]')
    await until(() => router.currentRoute.value.fullPath === '/sessions/new?start=out')
    expect(view.has('[data-testid=create-menu]')).toBe(false)
  })

  it('opens the usual create page for New session', async () => {
    const { view, router } = await draw()
    await view.click(button(view))
    await view.click('[data-testid=create-scratch]')
    await until(() => router.currentRoute.value.fullPath === '/sessions/new')
  })

  it('closes on a second press of Create', async () => {
    const { view } = await draw()
    await view.click(button(view))
    await view.click(button(view))
    expect(view.has('[data-testid=create-menu]')).toBe(false)
  })

  it('goes straight to the create page for a real account, with no menu', async () => {
    const { view, router } = await draw({ real: true })
    expect(button(view).attrs['aria-haspopup']).toBeUndefined()
    await view.click(button(view))
    await until(() => router.currentRoute.value.fullPath === '/sessions/new')
    expect(view.has('[data-testid=create-menu]')).toBe(false)
  })
})
