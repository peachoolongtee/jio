// Forgot password and the new-password page: the data layer's two calls, the router's rules for the two pages, the
// "Forgot password?" link on the login screen, and both screens drawn for real (domless.js) on the stand-in Supabase.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

// Drawing a screen compiles its templates the first time, which is slow on a busy machine.
vi.setConfig({ testTimeout: 20000 })

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// The app's routes with stand-in screens, the guard and the auth store, on real accounts unless `fake` is null.
// `signedIn` leaves the registered person signed in (as the reset link does); otherwise they are signed out.
// How to call: const t = await setUp({ signedIn: true })
async function setUp({ fake = fakeSupabase(), signedIn = false, register = true } = {}) {
  const booted = await boot(fake)
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const store = useAuthStore()
  if (fake && register) {
    Object.assign(store.draft, { ...PROFILE, step: 8 })
    await store.signUp()
    if (!signedIn) await store.signOut()
  }
  const { routes } = await import('@/router/routes.js')
  const { installGuard } = await import('@/router/guard.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  installGuard(router)
  return { ...booted, fake, store, router, pinia }
}

// Draw one screen after the router has opened `path`.
// How to call: const view = await draw(t, '/reset-password', 'ResetPasswordView')
async function draw(t, path, name) {
  await t.router.push(path)
  const { default: screen } = await import(`@/views/${name}.vue`)
  return mountScreen(screen, { plugins: [t.pinia, t.router] })
}

const mainButton = (view) => view.all('button').find((b) => (b.attrs.class || '').includes('btn--next'))

describe('asking for the reset email (data layer)', () => {
  it('sends the email with a link back to /reset-password on this site, and nothing else', async () => {
    const { api, fake } = await setUp()
    await api.requestPasswordReset(' sam@example.com ')
    expect(fake.state.resetCalls).toHaveLength(1)
    expect(fake.state.resetCalls[0].email).toBe('sam@example.com')
    expect(fake.state.resetCalls[0].options.redirectTo).toMatch(/\/reset-password$/)
  })

  it('answers the same for an email nobody signed up with', async () => {
    const { api } = await setUp()
    await expect(api.requestPasswordReset('nobody@example.com')).resolves.toBeUndefined()
  })

  it('says so in plain words when too many emails were asked for, or there is no connection', async () => {
    const { api, auth } = await setUp()
    await expect(api.requestPasswordReset('limited@example.com')).rejects.toThrow(auth.MESSAGES.rate_limited)
    const down = await setUp({ fake: fakeSupabase({ down: true }), register: false })
    await expect(down.api.requestPasswordReset('sam@example.com')).rejects.toThrow(down.auth.MESSAGES.offline)
  })
})

describe('setting the new password (data layer)', () => {
  it('changes the password of the person the link signed in, who can then log in with it', async () => {
    const { api, fake } = await setUp({ signedIn: true })
    await api.changePassword('N3w-secret!')
    expect(fake.state.passwordUpdates).toEqual(['uid-1'])
    await api.signOut()
    await expect(api.signIn({ email: PROFILE.email, password: PROFILE.password })).rejects.toThrow()
    expect(await api.signIn({ email: PROFILE.email, password: 'N3w-secret!' })).toMatchObject({ authId: 'uid-1' })
  })

  it('says the link has expired when there is no session, and asks for a different password when it is the same', async () => {
    const out = await setUp()
    await expect(out.api.changePassword('N3w-secret!')).rejects.toMatchObject({ code: 'reset_link_invalid' })
    const t = await setUp({ signedIn: true })
    await expect(t.api.changePassword(PROFILE.password)).rejects.toThrow(t.auth.MESSAGES.same_password)
  })
})

describe('the routes', () => {
  it('lets a signed-out visitor open both pages, and sends them to /signup when accounts are not real', async () => {
    const t = await setUp()
    await t.router.push('/forgot-password')
    expect(t.router.currentRoute.value.path).toBe('/forgot-password')
    await t.router.push('/reset-password')
    expect(t.router.currentRoute.value.path).toBe('/reset-password')
    const local = await setUp({ fake: null })
    await local.router.push('/forgot-password')
    expect(local.router.currentRoute.value.path).toBe('/signup')
    await local.router.push('/reset-password')
    expect(local.router.currentRoute.value.path).toBe('/signup')
  })

  it('sends a signed-in person from /forgot-password to Home, but lets the reset link open /reset-password', async () => {
    const t = await setUp({ signedIn: true })
    await t.router.push('/forgot-password')
    expect(t.router.currentRoute.value.path).toBe('/')
    await t.router.push('/reset-password')
    expect(t.router.currentRoute.value.path).toBe('/reset-password')
  })

  it('never remembers either page as the place to go after logging in', async () => {
    const { safeNext } = await import('@/router/guard.js')
    expect(safeNext('/forgot-password')).toBe('')
    expect(safeNext('/reset-password')).toBe('')
  })
})

describe('the login screen', () => {
  it('has a "Forgot password?" link that opens the page with the email typed so far, not in the address', async () => {
    const t = await setUp()
    const view = await draw(t, '/login', 'LoginView')
    view.type('#login-email', 'sam@example.com')
    await view.click('[data-testid="forgot-password"]')
    await until(() => t.router.currentRoute.value.name === 'forgot-password')
    expect(t.router.currentRoute.value.fullPath).toBe('/forgot-password')
    expect(t.router.options.history.state.email).toBe('sam@example.com')
  })
})

describe('the forgot-password screen', () => {
  it('refuses an address that is not one, without asking Supabase', async () => {
    const t = await setUp()
    const view = await draw(t, '/forgot-password', 'ForgotPasswordView')
    view.type('#forgot-email', 'sam@example')
    await view.click(mainButton(view))
    expect(view.text()).toContain('Enter a valid email address, like name@example.com.')
    expect(t.fake.state.resetCalls).toEqual([])
  })

  it('sends the link and says to check the email, the same whether or not the email has an account', async () => {
    const t = await setUp()
    const view = await draw(t, '/forgot-password', 'ForgotPasswordView')
    view.type('#forgot-email', 'nobody@example.com')
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="reset-sent"]'))
    expect(view.text('h1')).toBe('Check your email')
    expect(view.text()).toContain('If an account uses nobody@example.com')
    expect(t.fake.state.resetCalls.map((c) => c.email)).toEqual(['nobody@example.com'])
  })

  it('shows the reason when the email could not be sent, and keeps the form', async () => {
    const t = await setUp()
    const view = await draw(t, '/forgot-password', 'ForgotPasswordView')
    view.type('#forgot-email', 'limited@example.com')
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="forgot-error"]'))
    expect(view.text('[data-testid="forgot-error"]')).toBe(t.auth.MESSAGES.rate_limited)
    expect(view.has('#forgot-email')).toBe(true)
  })
})

describe('the new-password screen', () => {
  it('says the link has expired when it did not sign anyone in, and offers a new one', async () => {
    const t = await setUp()
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.has('[data-testid="reset-link-invalid"]')).toBe(true)
    expect(view.one('a[href="/forgot-password"]')).toBeTruthy()
  })

  it('holds the button until the password meets the rule, and asks for the same password twice', async () => {
    const t = await setUp({ signedIn: true })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.all('.checklist__item')).toHaveLength(4)
    view.type('#reset-password', 'abcdef')
    view.type('#reset-confirm', 'abcdef')
    await view.tick()
    expect(mainButton(view).disabled).toBe(true)
    view.type('#reset-password', 'N3w-secret!')
    view.type('#reset-confirm', 'N3w-secret?')
    await view.click(mainButton(view))
    expect(view.text()).toContain('The two passwords do not match.')
    expect(t.fake.state.passwordUpdates).toEqual([])
  })

  it('saves the new password and says so', async () => {
    const t = await setUp({ signedIn: true })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    view.type('#reset-password', 'N3w-secret!')
    view.type('#reset-confirm', 'N3w-secret!')
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="reset-done"]'))
    expect(view.text('h1')).toBe('Password changed')
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
  })

  it('turns into "link expired" when the session ends while the page is open', async () => {
    const t = await setUp({ signedIn: true })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.has('[data-testid="reset-view"]')).toBe(true)
    t.fake.state.endSession()
    await until(() => view.has('[data-testid="reset-link-invalid"]'))
  })
})
