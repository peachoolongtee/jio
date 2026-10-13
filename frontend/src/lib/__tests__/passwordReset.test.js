// Forgot password and the new-password page: the data layer's two calls, the router's rules for the two pages, the
// "Forgot password?" link on the login screen, and both screens drawn for real (domless.js) on the stand-in Supabase.
// The new-password form is shown only to a session that a reset link started: the client's PASSWORD_RECOVERY event, or a
// `type=recovery` link in the address whose token is the session's. Being signed in is not enough.
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
// `signedIn` leaves the registered person signed in; otherwise they are signed out. `link` says how a reset link started
// that session: 'event' (the client reports PASSWORD_RECOVERY), 'hash' (the address held the link, and the session is the
// one its token made), 'other-token' (the address held a link whose token is not the session's: it was stale), 'error'
// (the address held an error from Supabase), or false (nobody opened a link).
// How to call: const t = await setUp({ signedIn: true, link: 'event' })
async function setUp({ fake = fakeSupabase(), signedIn = false, register = true, link = false } = {}) {
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
  const { noteAuthHash } = await import('../authLink.js')
  const token = fake?.state.session?.access_token
  if (link === 'hash') noteAuthHash({ location: { hash: `#access_token=${token}&refresh_token=r&expires_in=3600&token_type=bearer&type=recovery` } })
  if (link === 'other-token') noteAuthHash({ location: { hash: '#access_token=a-link-that-was-not-used&refresh_token=r&type=recovery' } })
  if (link === 'error') noteAuthHash({ location: { hash: '#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired' } })
  if (link === 'event') {
    fake.state.emit('PASSWORD_RECOVERY')
    await until(() => store.recovering)
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
    await api.changePassword('N3wSecret!')
    expect(fake.state.passwordUpdates).toEqual(['uid-1'])
    await api.signOut()
    await expect(api.signIn({ email: PROFILE.email, password: PROFILE.password })).rejects.toThrow()
    expect(await api.signIn({ email: PROFILE.email, password: 'N3wSecret!' })).toMatchObject({ authId: 'uid-1' })
  })

  it('says the link has expired when there is no session, and asks for a different password when it is the same', async () => {
    const out = await setUp()
    await expect(out.api.changePassword('N3wSecret!')).rejects.toMatchObject({ code: 'reset_link_invalid' })
    const t = await setUp({ signedIn: true })
    await expect(t.api.changePassword(PROFILE.password)).rejects.toThrow(t.auth.MESSAGES.same_password)
  })
})

describe('after the password is changed (data layer)', () => {
  it('signs out the other sessions of the account and keeps this one', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    expect(t.auth.recoveryPending()).toBe(true)
    await t.api.changePassword('N3wSecret!')
    expect(t.fake.state.signOutCalls).toEqual([{ scope: 'others' }])
    expect(t.fake.state.otherSessionsEnded).toBe(1)
    // This browser is still signed in, and the reset is over.
    expect((await t.auth.checkSession()).user).toMatchObject({ id: 'uid-1' })
    expect(t.auth.recoveryPending()).toBe(false)
  })

  it.each([
    ['refuses', { signOutMode: 'error' }],
    ['fails to connect', { signOutMode: 'reject' }],
    ['throws', { signOutMode: 'throw' }],
    ['never answers', { signOutMode: 'hang' }],
  ])('still counts the change as done when signing out the others %s', async (_name, options) => {
    const t = await setUp({ fake: fakeSupabase(options), signedIn: true })
    t.auth.timing.signOutMs = 30
    await expect(t.api.changePassword('N3wSecret!')).resolves.toBeUndefined()
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
    expect(t.fake.state.signOutCalls).toEqual([{ scope: 'others' }])
  })

  it('does not sign out anyone when the change itself fails', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    await expect(t.api.changePassword(PROFILE.password)).rejects.toThrow(t.auth.MESSAGES.same_password)
    expect(t.fake.state.signOutCalls).toEqual([])
    // The link is not used up by a refused password: the person may try another.
    expect(t.auth.recoveryPending()).toBe(true)
  })
})

describe('knowing that a session came from a reset link (data layer)', () => {
  it('is not recovering for a plain sign-in, a sign-up, or a reload', async () => {
    const t = await setUp({ signedIn: true })
    expect(t.auth.recoveryPending()).toBe(false)
    expect((await t.auth.checkSession()).user).toMatchObject({ id: 'uid-1' })
    expect(t.auth.recoveryPending()).toBe(false)
  })

  it('is recovering after the client reports PASSWORD_RECOVERY, and stops at sign-out', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    expect(t.auth.recoveryPending()).toBe(true)
    await t.api.signOut()
    expect(t.auth.recoveryPending()).toBe(false)
  })

  it('is recovering when the address held a recovery link and the session is the one its token made', async () => {
    const t = await setUp({ signedIn: true, link: 'hash' })
    expect(t.auth.recoveryPending()).toBe(false)
    expect((await t.auth.checkSession()).user).toMatchObject({ id: 'uid-1' })
    expect(t.auth.recoveryPending()).toBe(true)
  })

  it('is not recovering when the link\'s token is not the session\'s, and the link is not kept to try again', async () => {
    const t = await setUp({ signedIn: true, link: 'other-token' })
    await t.auth.checkSession()
    expect(t.auth.recoveryPending()).toBe(false)
    const { recoveryHint } = await import('../authLink.js')
    expect(recoveryHint()).toBeNull()
  })

  it('is not recovering when the address held an error from Supabase, even with a session from before', async () => {
    const t = await setUp({ signedIn: true, link: 'error' })
    await t.auth.checkSession()
    expect(t.auth.recoveryPending()).toBe(false)
  })

  it('is not recovering after a reload without the link, although the session is still there', async () => {
    const first = await setUp({ signedIn: true, link: 'event' })
    expect(first.auth.recoveryPending()).toBe(true)
    const again = await boot(first.fake, { data: first.storage.store })
    expect(again.auth.recoveryPending()).toBe(false)
    expect((await again.auth.checkSession()).user).toMatchObject({ id: 'uid-1' })
    expect(again.auth.recoveryPending()).toBe(false)
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

  it.each([
    ['a signed-in person who opened the address by hand', {}],
    ['an expired or used link, with an earlier session still signed in', { link: 'other-token' }],
    ['an error from Supabase in the address, with an earlier session still signed in', { link: 'error' }],
  ])('does not show the form to %s, and offers a new link', async (_name, options) => {
    const t = await setUp({ signedIn: true, ...options })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.has('[data-testid="reset-link-invalid"]')).toBe(true)
    expect(view.has('[data-testid="reset-view"]')).toBe(false)
    expect(view.has('#reset-password')).toBe(false)
    expect(view.text()).toContain('This reset link has expired or has already been used. Ask for a new one.')
    expect(view.one('a[href="/forgot-password"]')).toBeTruthy()
    expect(t.fake.state.passwordUpdates).toEqual([])
  })

  it.each([
    ['the client reports a password recovery', 'event'],
    ['the address held a recovery link and the session is its', 'hash'],
  ])('shows the form when %s', async (_name, link) => {
    const t = await setUp({ signedIn: true, link })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.has('[data-testid="reset-view"]')).toBe(true)
    expect(view.has('#reset-password')).toBe(true)
    expect(view.text('h1')).toBe('Choose a new password')
  })

  it('shows the form when the recovery arrives while the page is already open', async () => {
    const t = await setUp({ signedIn: true })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.has('[data-testid="reset-link-invalid"]')).toBe(true)
    t.fake.state.emit('PASSWORD_RECOVERY')
    await until(() => view.has('[data-testid="reset-view"]'))
  })

  it('holds the button until the password meets the rule, and asks for the same password twice', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.all('.checklist__item')).toHaveLength(6)
    view.type('#reset-password', 'n3wsecret!')
    view.type('#reset-confirm', 'n3wsecret!')
    await view.tick()
    expect(mainButton(view).disabled).toBe(true)
    view.type('#reset-password', 'N3wSecret!')
    view.type('#reset-confirm', 'N3wSecret*')
    await view.click(mainButton(view))
    expect(view.text()).toContain('The two passwords do not match.')
    expect(t.fake.state.passwordUpdates).toEqual([])
  })

  it('ticks off the same six parts as the sign-up page, in the same words', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.all('.body-sm').filter((el) => (el.parent?.attrs.class || '').includes('checklist__text')).map((label) => view.text(label))).toEqual([
      '8 or more characters',
      'An uppercase letter',
      'A lowercase letter',
      'A number',
      'A symbol',
      'No more than 72 characters, and no space at the start or end',
    ])
    expect(view.all('.checklist__hint').map((hint) => view.text(hint))).toEqual([
      'Any character that is not a letter, number or space, like - _ ? ! @ #',
      'Accented letters and emoji take more room. Control characters are not allowed.',
    ])
    expect(view.all('.checklist__item').filter((el) => (el.attrs.class || '').includes('is-ok'))).toHaveLength(0)
    view.type('#reset-password', 'Zx9-qL_mW?4k')
    await view.tick()
    expect(view.all('.checklist__item').filter((el) => (el.attrs.class || '').includes('is-ok'))).toHaveLength(6)
  })

  it('saves the new password, says so, ends the reset and signs out the account\'s other sessions', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    view.type('#reset-password', 'N3w-Secret?')
    view.type('#reset-confirm', 'N3w-Secret?')
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="reset-done"]'))
    expect(view.text('h1')).toBe('Password changed')
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
    expect(t.fake.state.signOutCalls).toEqual([{ scope: 'others' }])
    expect(t.store.recovering).toBe(false)
    // The same session cannot change the password again from this page.
    const again = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(again.has('[data-testid="reset-link-invalid"]')).toBe(true)
    expect(again.has('#reset-password')).toBe(false)
  })

  it('turns into "link expired" when the session ends while the page is open', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.has('[data-testid="reset-view"]')).toBe(true)
    t.fake.state.endSession()
    await until(() => view.has('[data-testid="reset-link-invalid"]'))
  })

  it('shows "link expired" after signing out, even if the same person signs in again by password', async () => {
    const t = await setUp({ signedIn: true, link: 'event' })
    await t.store.signOut()
    expect(t.store.recovering).toBe(false)
    await t.store.signIn(PROFILE.email, PROFILE.password)
    const view = await draw(t, '/reset-password', 'ResetPasswordView')
    expect(view.has('[data-testid="reset-link-invalid"]')).toBe(true)
  })

  it('shows "link expired" after a reload without the link, although the session is still stored', async () => {
    const first = await setUp({ signedIn: true, link: 'event' })
    expect(first.store.recovering).toBe(true)
    // The same stored session, a new page: no link in the address this time.
    await boot(first.fake, { data: first.storage.store })
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    const store = useAuthStore()
    await store.init()
    expect(store.signedIn).toBe(true)
    expect(store.recovering).toBe(false)
  })
})
