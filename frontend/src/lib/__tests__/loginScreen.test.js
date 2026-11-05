// The login screen (views/LoginView.vue), drawn for real on an in-memory page (domless.js), with the real router, auth
// store and data layer on the stand-in Supabase client.
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

// The login screen on a router at `path`, with a registered person who is signed out.
// How to call: const t = await setUp('/login?next=%2Fprofile')
async function setUp(path = '/login') {
  const fake = fakeSupabase()
  await boot(fake)
  const { createPinia } = await import('pinia')
  const pinia = createPinia()
  const { setActivePinia } = await import('pinia')
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const store = useAuthStore()
  Object.assign(store.draft, { ...PROFILE, step: 8 })
  await store.signUp()
  await store.signOut()
  const { routes } = await import('@/router/routes.js')
  const { installGuard } = await import('@/router/guard.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  installGuard(router)
  await router.push(path)
  const { default: LoginView } = await import('@/views/LoginView.vue')
  const view = await mountScreen(LoginView, { plugins: [pinia, router] })
  return { fake, store, router, view }
}

const fillIn = (view, email, password) => {
  view.type('#login-email', email)
  view.type('#login-password', password)
}

describe('the login screen', () => {
  it('draws two labelled fields with the right types for a password manager, one primary button and a way to sign up', async () => {
    const { view } = await setUp()
    expect(view.errors).toEqual([])
    expect(view.text('h1')).toBe('Log in')
    const email = view.one('input#login-email')
    expect(email.attrs).toMatchObject({ type: 'email', autocomplete: 'username', inputmode: 'email' })
    const password = view.one('input#login-password')
    expect(password.attrs).toMatchObject({ type: 'password', autocomplete: 'current-password' })
    // Each input has a visible label that points at it.
    expect(view.all('label').map((l) => [l.attrs.for, view.text(`label[for="${l.attrs.for}"]`)])).toEqual([
      ['login-email', 'Email'],
      ['login-password', 'Password'],
    ])
    const submit = view.one('button[type=submit]')
    expect(view.text('button[type=submit]')).toContain('Log in')
    expect(submit.attrs.form).toBe('login-form')
    expect(view.one('form#login-form')).toBeTruthy()
    expect(view.one('a[href="/signup"]')).toBeTruthy()
  })

  it('shows the password only when asked, and says which state the button is in with its words, not also aria-pressed', async () => {
    const { view } = await setUp()
    const peek = view.all('button').find((b) => ['Show', 'Hide'].includes(view.text(b)))
    expect(view.text(peek)).toBe('Show')
    expect(view.one('input#login-password').attrs.type).toBe('password')
    await view.click(peek)
    expect(view.one('input#login-password').attrs.type).toBe('text')
    expect(view.text(peek)).toBe('Hide')
    // One signal for the state, not two.
    expect(peek.attrs['aria-pressed']).toBeUndefined()
  })

  it('shows the sentence for a failed sign-in, keeps the email, empties the password and puts focus on it', async () => {
    const { view, store, fake } = await setUp()
    fillIn(view, PROFILE.email, 'not-the-password')
    await view.click('button[type=submit]')
    await until(() => view.has('p[role=alert]'))
    expect(view.text('p[role=alert]')).toBe('That email and password do not match. Check them and try again.')
    expect(view.one('input#login-email').value).toBe(PROFILE.email)
    expect(view.one('input#login-password').value).toBe('')
    expect(view.focused()).toBe(view.one('input#login-password'))
    expect(store.signedIn).toBe(false)
    expect(fake.state.signInCalls).toHaveLength(1)
    expect(view.errors).toEqual([])
  })

  it('gives the same sentence for an email nobody registered', async () => {
    const { view } = await setUp()
    fillIn(view, 'nobody@example.com', 'whatever-1')
    await view.click('button[type=submit]')
    await until(() => view.has('p[role=alert]'))
    expect(view.text('p[role=alert]')).toBe('That email and password do not match. Check them and try again.')
  })

  it('goes Home after a successful sign-in, with Enter in a field', async () => {
    const { view, store, router } = await setUp()
    fillIn(view, PROFILE.email, PROFILE.password)
    await view.enter('input#login-password')
    await until(() => store.signedIn)
    await until(() => router.currentRoute.value.name === 'home')
    expect(router.currentRoute.value.fullPath).toBe('/')
    expect(store.user).toMatchObject({ authId: 'uid-1', name: 'Sam' })
  })

  it('goes to the page the person was heading for', async () => {
    const { view, router } = await setUp('/login?next=%2Fsessions%2Fs1%2Fitinerary')
    fillIn(view, PROFILE.email, PROFILE.password)
    await view.click('button[type=submit]')
    await until(() => router.currentRoute.value.name === 'session-itinerary')
    expect(router.currentRoute.value.path).toBe('/sessions/s1/itinerary')
  })

  it('never follows an outside address, and falls back to Home for a path that is not a screen', async () => {
    for (const next of ['https://evil.example', '//evil.example', '/nowhere/at-all']) {
      const { view, router, store } = await setUp('/login')
      // The router would already have dropped these; set the query as a stale tab might still hold it.
      router.currentRoute.value.query.next = next
      fillIn(view, PROFILE.email, PROFILE.password)
      await view.click('button[type=submit]')
      await until(() => store.signedIn)
      await until(() => router.currentRoute.value.name === 'home')
      expect(router.currentRoute.value.fullPath).toBe('/')
    }
  })

  it('asks for each field before calling Supabase', async () => {
    const { view, fake } = await setUp()
    await view.click('button[type=submit]')
    expect(view.text('p[role=alert]')).toBe('Enter the email address you signed up with.')
    expect(view.focused()).toBe(view.one('input#login-email'))
    view.type('#login-email', PROFILE.email)
    await view.click('button[type=submit]')
    expect(view.text('p[role=alert]')).toBe('Enter your password.')
    expect(view.focused()).toBe(view.one('input#login-password'))
    expect(fake.state.signInCalls).toHaveLength(0)
  })

  it('ties each empty-field message to its own field, and keeps the wrong-credentials message as the form\'s alert', async () => {
    const { view } = await setUp()
    const email = () => view.one('input#login-email')
    const password = () => view.one('input#login-password')
    await view.click('button[type=submit]')
    expect(email().attrs['aria-invalid']).toBe('true')
    expect(email().attrs['aria-describedby']).toBe('login-email-help')
    expect(view.text('#login-email-help')).toBe('Enter the email address you signed up with.')
    expect(password().attrs['aria-invalid']).toBeUndefined()
    // It goes away when the person types in that field.
    view.type('#login-email', PROFILE.email)
    await view.tick()
    expect(view.has('#login-email-help')).toBe(false)
    expect(email().attrs['aria-invalid']).toBeUndefined()
    await view.click('button[type=submit]')
    expect(password().attrs['aria-invalid']).toBe('true')
    expect(password().attrs['aria-describedby']).toBe('login-password-help')
    expect(view.text('#login-password-help')).toBe('Enter your password.')
    expect(email().attrs['aria-invalid']).toBeUndefined()
    // No loose alert for either: the only alert is the field's own.
    expect(view.has('[data-testid=login-error]')).toBe(false)
    // A wrong password is the form's alert, under the fields, and marks neither field.
    view.type('#login-password', 'not-the-password')
    await view.click('button[type=submit]')
    await until(() => view.has('[data-testid=login-error]'))
    expect(view.text('[data-testid=login-error]')).toBe('That email and password do not match. Check them and try again.')
    expect(email().attrs['aria-invalid']).toBeUndefined()
    expect(password().attrs['aria-invalid']).toBeUndefined()
    expect(view.has('#login-password-help')).toBe(false)
  })

  it('uses "log in" for the action everywhere on the screen', async () => {
    const { view } = await setUp()
    expect(view.text()).not.toMatch(/sign in/i)
  })

  it('never puts the email or the password in the address', async () => {
    const { view, router } = await setUp()
    fillIn(view, PROFILE.email, 'not-the-password')
    await view.click('button[type=submit]')
    await until(() => view.has('p[role=alert]'))
    expect(router.currentRoute.value.fullPath).toBe('/login')
  })

  it('fills in the email from a sign-up that is waiting for its confirmation', async () => {
    const fake = fakeSupabase({ confirmEmail: true })
    await boot(fake)
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    const store = useAuthStore()
    Object.assign(store.draft, { ...PROFILE, step: 8 })
    expect(await store.signUp()).toBeNull()
    const { routes } = await import('@/router/routes.js')
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    await router.push('/login')
    const { default: LoginView } = await import('@/views/LoginView.vue')
    const view = await mountScreen(LoginView, { plugins: [pinia, router] })
    expect(view.one('input#login-email').value).toBe(PROFILE.email)
    expect(view.one('input#login-password').value).toBe('')
  })

  it('shows the sentence for an email that was never confirmed', async () => {
    const { view, fake } = await setUp()
    // The stand-in answers the way Supabase does when the email is not confirmed yet.
    fake.client.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: { name: 'AuthApiError', status: 400, code: 'email_not_confirmed', message: 'Email not confirmed' } })
    fillIn(view, PROFILE.email, PROFILE.password)
    await view.click('button[type=submit]')
    await until(() => view.has('p[role=alert]'))
    expect(view.text('p[role=alert]')).toBe('Confirm your email first. Open the link we sent you, then log in.')
  })
})
