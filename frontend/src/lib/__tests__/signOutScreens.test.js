// Signing out from the Profile screen while it is drawn with sessions (ticket #60: the signed-in person becomes null
// while screens that read their name are still on screen), and what its dialog says for a real and a local account.
// Drawn on the in-memory page (domless.js).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// Canvas drawings that need a browser; the screen's own logic is what is under test.
vi.mock('@/components/ui/GridPulse.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/ui/MeetupGraph.vue', () => ({ default: { render: () => null } }))

vi.setConfig({ testTimeout: 20000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// The Profile screen, signed in (a real account with Supabase, else the local demo account) and holding one session.
// How to call: const t = await setUp(fakeSupabase())
async function setUp(fake) {
  const booted = await boot(fake)
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const store = useAuthStore()
  if (fake) {
    Object.assign(store.draft, { ...PROFILE, step: 8 })
    await store.signUp()
  } else {
    const { DEMO_ACCOUNT } = await import('../../components/dev/demoAccount.js')
    await store.signUpAs(DEMO_ACCOUNT)
  }
  await booted.api.createSession(SESSION)
  const { routes } = await import('@/router/routes.js')
  const { installGuard } = await import('@/router/guard.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  installGuard(router)
  await router.push('/profile')
  const { default: ProfileView } = await import('@/views/ProfileView.vue')
  const view = await mountScreen(ProfileView, { plugins: [pinia, router] })
  await until(() => view.has('[data-testid=profile-view]') && view.text().includes(SESSION.title))
  return { store, router, view }
}

const openDialog = async (view) => {
  await view.click('button[aria-label="Sign out"]')
  await until(() => view.has('[role=dialog]'))
}
const buttonLabelled = (view, text) => view.all('button').find((b) => view.text(b) === text)

describe('signing out of a real account', () => {
  it('draws the screen with sessions, signs out without a single error, and lands on /login', async () => {
    const { store, router, view } = await setUp(fakeSupabase())
    expect(view.errors.map((e) => String(e.stack || e).slice(0, 400))).toEqual([])
    await openDialog(view)
    await view.click(buttonLabelled(view, 'Sign out'))
    await until(() => router.currentRoute.value.name === 'login')
    expect(store.signedIn).toBe(false)
    expect(store.user).toBeNull()
    expect(view.errors.map((e) => String(e.stack || e).slice(0, 400))).toEqual([])
  })

  it('says the meetups stay in this browser, and keeps that wording while the sign-out runs', async () => {
    const { view } = await setUp(fakeSupabase())
    await openDialog(view)
    expect(view.text('[role=dialog]')).toContain('Sign out?')
    expect(view.text('[role=dialog]')).toContain('Your meetups, votes and points stay in this browser. Log in here again to get them back.')
    expect(view.text('[role=dialog]')).not.toContain('erases')
    await view.click(buttonLabelled(view, 'Sign out'))
    expect(view.text('[role=dialog]')).not.toContain('erases')
  })

  it('does not call the account a local one', async () => {
    const { view } = await setUp(fakeSupabase())
    expect(view.has('[data-testid=local-account-note]')).toBe(false)
  })
})

describe('signing out of a local account', () => {
  it('signs out without an error and lands on /signup when there are no real accounts', async () => {
    const { store, router, view } = await setUp(null)
    await openDialog(view)
    await view.click(buttonLabelled(view, 'Erase and sign out'))
    await until(() => router.currentRoute.value.name === 'signup')
    expect(store.signedIn).toBe(false)
    expect(view.errors.map((e) => String(e.stack || e).slice(0, 400))).toEqual([])
  })

  it('says that everything is erased', async () => {
    const { view } = await setUp(null)
    await openDialog(view)
    expect(view.text('[role=dialog]')).toContain('Erase everything and sign out?')
    expect(view.text('[role=dialog]')).toContain('Signing out erases everything saved in this browser')
    expect(view.has('[data-testid=local-account-note]')).toBe(false)
  })

  it('lands on /login when real accounts are on, and says on the Profile screen that the account lives only in this browser', async () => {
    const fake = fakeSupabase()
    const { store, router, view } = await setUp(fake)
    // The demo account is local even with Supabase set up.
    const { DEMO_ACCOUNT } = await import('../../components/dev/demoAccount.js')
    await store.signUpAs(DEMO_ACCOUNT)
    await until(() => view.has('[data-testid=local-account-note]'))
    expect(view.text('[data-testid=local-account-note]')).toContain('This account lives only in this browser.')
    await openDialog(view)
    expect(view.text('[role=dialog]')).toContain('Erase everything and sign out?')
    await view.click(buttonLabelled(view, 'Erase and sign out'))
    await until(() => router.currentRoute.value.name === 'login')
    expect(view.errors.map((e) => String(e.stack || e).slice(0, 400))).toEqual([])
  })
})
