// The router's rules about who may open what (router/guard.js), run on a memory router with the app's real route table
// and stand-in screens, on the real auth store with the stand-in Supabase client.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// A router with the app's routes, the guard, and screens that draw nothing. Real accounts are on when `fake` is given.
// How to call: const { router, store } = await setUp(fakeSupabase())
async function setUp(fake, storageOptions = {}) {
  const booted = await boot(fake, storageOptions)
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useAuthStore } = await import('@/stores/auth.js')
  const { routes } = await import('@/router/routes.js')
  const { installGuard } = await import('@/router/guard.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  installGuard(router)
  return { ...booted, router, store: useAuthStore() }
}

const signUpFirst = async (store) => {
  Object.assign(store.draft, { ...PROFILE, step: 7 })
  await store.signUp()
}

describe('the route table', () => {
  it('has a public login screen without navigation, titled "Log in"', async () => {
    const { routes } = await import('@/router/routes.js')
    const login = routes.find((r) => r.path === '/login')
    expect(login.name).toBe('login')
    expect(login.meta).toMatchObject({ public: true, nav: false, title: 'Log in' })
  })
})

describe('with real accounts on', () => {
  it('sends a signed-out visitor to /login and remembers where they were going', async () => {
    const { router } = await setUp(fakeSupabase())
    await router.push('/sessions/s1/itinerary?tab=stops')
    expect(router.currentRoute.value.path).toBe('/login')
    expect(router.currentRoute.value.query).toEqual({ next: '/sessions/s1/itinerary?tab=stops' })
  })

  it('sends a signed-out visitor to Home to /login with nothing to remember', async () => {
    const { router } = await setUp(fakeSupabase())
    await router.push('/')
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('lets a signed-out visitor open /login and /signup', async () => {
    const { router } = await setUp(fakeSupabase())
    await router.push('/signup')
    expect(router.currentRoute.value.path).toBe('/signup')
    await router.push('/login')
    expect(router.currentRoute.value.path).toBe('/login')
  })

  it.each([
    ['an outside address', 'https://evil.example/steal'],
    ['a protocol-relative address', '//evil.example'],
    ['a backslash address', '/\\evil.example'],
    ['a tab that hides a second slash', '/\t/evil.example'],
    ['a path back to the login screen', '/login'],
  ])('drops a remembered destination that is %s', async (_name, next) => {
    const { router } = await setUp(fakeSupabase())
    await router.push({ path: '/login', query: { next } })
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('drops a remembered destination given twice', async () => {
    const { router } = await setUp(fakeSupabase())
    await router.push('/login?next=/profile&next=/rewards')
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('keeps a remembered destination inside the app', async () => {
    const { router } = await setUp(fakeSupabase())
    await router.push('/login?next=%2Fprofile')
    expect(router.currentRoute.value.query).toEqual({ next: '/profile' })
  })

  it('sends a signed-in visitor from /login and /signup to Home', async () => {
    const { router, store } = await setUp(fakeSupabase())
    await signUpFirst(store)
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('home')
    await router.push('/signup')
    expect(router.currentRoute.value.name).toBe('home')
  })

  it('lets a signed-in visitor open a private page', async () => {
    const { router, store } = await setUp(fakeSupabase())
    await signUpFirst(store)
    await router.push('/rewards')
    expect(router.currentRoute.value.name).toBe('rewards')
  })

  it('treats a person whose session was restored at start-up as signed in', async () => {
    const fake = fakeSupabase()
    const first = await setUp(fake)
    await signUpFirst(first.store)
    const second = await setUp(fake, { data: first.storage.store })
    await second.router.push('/profile')
    expect(second.router.currentRoute.value.name).toBe('profile')
  })
})

describe('with real accounts off', () => {
  it('sends a signed-out visitor to /signup, as before, with nothing remembered', async () => {
    const { router, store } = await setUp(null)
    expect(store.realAccounts).toBe(false)
    await router.push('/sessions/s1')
    expect(router.currentRoute.value.fullPath).toBe('/signup')
  })

  it('sends /login to /signup, with or without a destination', async () => {
    const { router } = await setUp(null)
    await router.push('/login')
    expect(router.currentRoute.value.fullPath).toBe('/signup')
    await router.push('/login?next=/profile')
    expect(router.currentRoute.value.fullPath).toBe('/signup')
  })

  it('sends a signed-in local account from /signup to Home and lets it open private pages', async () => {
    const { router, store } = await setUp(null)
    const { DEMO_ACCOUNT } = await import('../../components/dev/demoAccount.js')
    await store.signUpAs(DEMO_ACCOUNT)
    await router.push('/signup')
    expect(router.currentRoute.value.name).toBe('home')
    await router.push('/login')
    expect(router.currentRoute.value.name).toBe('home')
    await router.push('/leaderboard')
    expect(router.currentRoute.value.name).toBe('leaderboard')
  })
})

describe('safeNext', () => {
  it('returns in-app paths rebuilt from the parsed address, and nothing else', async () => {
    const { safeNext } = await import('@/router/guard.js')
    expect(safeNext('/sessions/s1?tab=past#photos')).toBe('/sessions/s1?tab=past#photos')
    expect(safeNext('/')).toBe('/')
    const bad = ['', undefined, null, 5, ['/profile'], 'profile', 'http://evil.example', '//evil.example', '/\\x', '/a b', '/signup', '/login?x=1', 'javascript:alert(1)', `/${'a'.repeat(600)}`]
    for (const value of bad) expect(safeNext(value)).toBe('')
  })

  it('returns nothing when dot segments resolve to a protocol-relative address', async () => {
    const { safeNext } = await import('@/router/guard.js')
    // The address parser turns each of these into '//evil.example', which a router or a browser would read as another site.
    for (const value of ['/.//evil.example', '/..//evil.example', '/a/..//evil.example', '/%2e//evil.example', '/%2E%2e//evil.example']) {
      expect(new URL(value, 'http://jio.invalid').pathname.startsWith('//')).toBe(true)
      expect(safeNext(value)).toBe('')
    }
    // Dot segments that stay on this site are still fine, rebuilt without them.
    expect(safeNext('/./sessions/../profile')).toBe('/profile')
  })

  it('drops such a destination from the login address too', async () => {
    const { router } = await setUp(fakeSupabase())
    await router.push({ path: '/login', query: { next: '/.//evil.example' } })
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })
})
