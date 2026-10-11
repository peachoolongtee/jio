// Starting the app: what is on screen at once, how long the first screen waits to learn who is signed in, what a
// session that cannot be checked does (nothing: it is neither thrown away nor treated as signed out), and the build that
// has no Supabase settings. The stand-in (authFixture.js) can expire the stored token, refuse or fail its refresh, and
// never answer.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { OTHER, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { AUTH_STORAGE_KEY, localAccountsAllowed, mustRefuse } from '../supabase.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

vi.setConfig({ testTimeout: 20000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

// A page load: a person (Kim) has signed up on `fake` in an earlier visit; the new page starts on the same storage with
// a fresh data layer and store. `kept: false` starts it on empty storage instead (nobody saved).
// How to call: const t = await reload(fake, { startMs: 60 })
async function reload(fake, { startMs = 60, kept = true, router: withRouter = false } = {}) {
  const first = await boot(fake)
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  let { useAuthStore } = await import('@/stores/auth.js')
  Object.assign(useAuthStore().draft, { ...OTHER, step: 7 })
  await useAuthStore().signUp()
  const data = kept ? first.storage.store : {}
  const booted = await boot(fake, { data })
  booted.auth.timing.startMs = startMs
  const pinia = createPinia()
  setActivePinia(pinia)
  ;({ useAuthStore } = await import('@/stores/auth.js'))
  const store = useAuthStore()
  const out = { ...booted, store, pinia }
  if (withRouter) {
    const { routes } = await import('@/router/routes.js')
    const { installGuard } = await import('@/router/guard.js')
    const stub = { render: () => null }
    out.router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    installGuard(out.router)
  }
  return out
}

describe('a session that cannot be checked', () => {
  it.each([
    ['there is no connection', { refreshMode: 'retryable' }],
    ['the server answers an error', { refreshMode: 'server' }],
  ])('shows the person from the saved copy with a note, and keeps the stored session, when %s', async (_name, options) => {
    const fake = fakeSupabase()
    const { store, storage, auth } = await reload(fake)
    Object.assign(fake.state.options, { expired: true, ...options })
    await store.init()
    expect(store.ready).toBe(true)
    expect(store.signedIn).toBe(true)
    expect(store.user).toMatchObject({ authId: 'uid-1', name: 'Kim', username: 'kim' })
    expect(store.syncNotice).toBe(auth.MESSAGES.unreachable)
    expect(store.syncNotice).toMatch(/could not be reached/i)
    // Nothing was signed out or thrown away.
    expect(storage.store[AUTH_STORAGE_KEY]).toBeTruthy()
    expect(fake.state.signOutCalls).toEqual([])
  })

  it('keeps the stored session and signs nobody out for a retryable error from the session check, wherever it is read', async () => {
    const fake = fakeSupabase()
    const { api, auth, storage } = await reload(fake)
    Object.assign(fake.state.options, { expired: true, refreshMode: 'retryable' })
    expect(await auth.checkSession()).toEqual({ user: null, unreachable: true })
    expect((await api.startUser()).user).toMatchObject({ authId: 'uid-1' })
    expect((await api.getUser()).authId).toBe('uid-1')
    expect(storage.store[AUTH_STORAGE_KEY]).toBeTruthy()
    // When Supabase answers again the same session is there.
    fake.state.options.refreshMode = 'ok'
    expect(await auth.checkSession()).toMatchObject({ user: { id: 'uid-1' }, unreachable: false })
  })

  it('goes to the login for a session the server refused, which the client has removed', async () => {
    const fake = fakeSupabase()
    const { store, storage } = await reload(fake)
    Object.assign(fake.state.options, { expired: true, refreshMode: 'refused' })
    await store.init()
    expect(store.ready).toBe(true)
    expect(store.signedIn).toBe(false)
    expect(store.syncNotice).toBe('')
    expect(storage.store[AUTH_STORAGE_KEY]).toBeUndefined()
  })

  it('refreshes an expired token when it can, and says nothing', async () => {
    const fake = fakeSupabase()
    const { store } = await reload(fake)
    fake.state.options.expired = true
    await store.init()
    expect(store.user).toMatchObject({ authId: 'uid-1' })
    expect(store.syncNotice).toBe('')
  })

  it('clears the note when Supabase answers again', async () => {
    const fake = fakeSupabase()
    const { store, auth } = await reload(fake)
    Object.assign(fake.state.options, { expired: true, refreshMode: 'retryable' })
    await store.init()
    expect(store.syncNotice).toBe(auth.MESSAGES.unreachable)
    fake.state.options.refreshMode = 'ok'
    await auth.refreshedToken()
    await flush()
    expect(store.syncNotice).toBe('')
  })
})

describe('a server that never answers', () => {
  it('lets the first screen go after the limit, from the saved copy, with the note, and keeps the session', async () => {
    const fake = fakeSupabase()
    const { store, storage, auth } = await reload(fake, { startMs: 80 })
    fake.state.options.getSessionMode = 'hang'
    const started = performance.now()
    await store.init()
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(75)
    expect(took).toBeLessThan(1500)
    expect(store.user).toMatchObject({ authId: 'uid-1', name: 'Kim' })
    expect(store.syncNotice).toBe(auth.MESSAGES.unreachable)
    expect(storage.store[AUTH_STORAGE_KEY]).toBeTruthy()
  })

  it('shows the login for a person with nothing saved', async () => {
    const fake = fakeSupabase()
    const { store } = await reload(fake, { kept: false })
    fake.state.options.getSessionMode = 'hang'
    await store.init()
    expect(store.ready).toBe(true)
    expect(store.signedIn).toBe(false)
  })

  it('has a limit of about four seconds', async () => {
    const { auth } = await boot(fakeSupabase())
    expect(auth.timing.startMs).toBe(4000)
    expect(auth.timing.signOutMs).toBe(2000)
  })

  it('takes the router to the saved person\'s page, or to the login when nobody is saved', async () => {
    const fake = fakeSupabase()
    const a = await reload(fake, { router: true })
    fake.state.options.getSessionMode = 'hang'
    await a.router.push('/profile')
    expect(a.router.currentRoute.value.name).toBe('profile')
    const fake2 = fakeSupabase()
    const b = await reload(fake2, { router: true, kept: false })
    fake2.state.options.getSessionMode = 'hang'
    await b.router.push('/profile')
    expect(b.router.currentRoute.value.fullPath).toBe('/login?next=/profile')
  })
})

describe('the profile', () => {
  it('is not waited for: the first screen has the saved copy while the profile read never answers', async () => {
    const fake = fakeSupabase()
    const { store } = await reload(fake)
    fake.state.options.readsHang = true
    const started = performance.now()
    await store.init()
    expect(performance.now() - started).toBeLessThan(1000)
    expect(store.user).toMatchObject({ authId: 'uid-1', name: 'Kim', homeAreaId: 'bishan' })
    expect(store.syncNotice).toBe('')
  })

  it('is read after the first screen and brings the saved copy up to date', async () => {
    const fake = fakeSupabase()
    const { store } = await reload(fake)
    fake.state.profiles['uid-1'].display_name = 'Kimberly'
    fake.state.priv['uid-1'].home_area_id = 'tampines'
    await store.init()
    expect(store.user.name).toBe('Kim')
    await until(() => store.user.name === 'Kimberly')
    expect(store.user.homeAreaId).toBe('tampines')
  })

  it('does not undo a change made while it was being read', async () => {
    const fake = fakeSupabase()
    const { api, store } = await reload(fake)
    await store.init()
    await until(() => !!store.user)
    fake.state.profiles['uid-1'].display_name = 'Older'
    const reading = api.refreshProfile()
    await api.updateUser({ name: 'Newer' })
    await reading
    expect((await api.getUser()).name).toBe('Newer')
  })

  it('is quiet when it cannot be read', async () => {
    const fake = fakeSupabase()
    const { api, store } = await reload(fake)
    await store.init()
    fake.state.options.down = true
    await expect(api.refreshProfile()).resolves.toBeUndefined()
    expect(store.user.name).toBe('Kim')
  })
})

describe('the first screen', () => {
  it('draws a placeholder at once, in the shape of the app, until the app knows who is signed in', async () => {
    // Nobody saved, so once it is ready the screen is the empty frame (no demo panel).
    const { store, pinia } = await reload(fakeSupabase(), { kept: false })
    const { default: App } = await import('@/App.vue')
    const { routes } = await import('@/router/routes.js')
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    const view = await mountScreen(App, { plugins: [pinia, router] })
    expect(store.ready).toBe(false)
    expect(view.has('[data-testid=app-starting]')).toBe(true)
    expect(view.text('[data-testid=app-starting]')).toContain('Loading Jio')
    expect(view.all('.skeleton').length).toBeGreaterThan(0)
    expect(view.one('[data-testid=app-starting]').attrs['aria-busy']).toBe('true')
    await store.init()
    await view.tick()
    expect(view.has('[data-testid=app-starting]')).toBe(false)
    expect(view.errors).toEqual([])
  })
})

describe('a build with no Supabase settings', () => {
  it('keeps local accounts always in development, and in production only when told to', () => {
    expect(localAccountsAllowed({ DEV: true })).toBe(true)
    expect(localAccountsAllowed({ DEV: false })).toBe(false)
    expect(localAccountsAllowed({ DEV: false, VITE_ALLOW_LOCAL_ACCOUNTS: '1' })).toBe(true)
    for (const value of ['', '0', 'true', 'yes', undefined]) expect(localAccountsAllowed({ DEV: false, VITE_ALLOW_LOCAL_ACCOUNTS: value })).toBe(false)
  })

  it('refuses to start in production without a client, unless local accounts were asked for', () => {
    expect(mustRefuse({ configured: false, env: { DEV: false } })).toBe(true)
    expect(mustRefuse({ configured: false, env: { DEV: false, VITE_ALLOW_LOCAL_ACCOUNTS: '1' } })).toBe(false)
    expect(mustRefuse({ configured: true, env: { DEV: false } })).toBe(false)
    expect(mustRefuse({ configured: false, env: { DEV: true } })).toBe(false)
  })

  it('under the test runner has no client, and the test build is a development build, so it does not refuse', () => {
    expect(mustRefuse()).toBe(false)
  })

  it('draws a plain sentence and no way into the app', async () => {
    const { default: UnavailableView } = await import('@/views/UnavailableView.vue')
    const view = await mountScreen(UnavailableView, {})
    expect(view.text('h1')).toBe('Jio is not available right now')
    expect(view.has('[data-testid=unavailable-view]')).toBe(true)
    expect(view.has('a')).toBe(false)
    expect(view.has('form')).toBe(false)
    expect(view.all('button')).toHaveLength(0)
    expect(view.text()).not.toMatch(/VITE_|env|supabase/i)
    expect(view.errors).toEqual([])
  })

  it('local accounts do work in a production build made with the opt-out, with no Supabase set up', async () => {
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_ALLOW_LOCAL_ACCOUNTS', '1')
    const { api } = await boot(null)
    expect(mustRefuse()).toBe(false)
    const { DEMO_ACCOUNT } = await import('../../components/dev/demoAccount.js')
    expect(await api.signUp({ ...DEMO_ACCOUNT })).toMatchObject({ local: true })
    expect(await api.getUser()).toMatchObject({ local: true })
    vi.unstubAllEnvs()
  })
})
