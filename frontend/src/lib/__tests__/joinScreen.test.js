// The join page (views/JoinView.vue) drawn for real on an in-memory page (domless.js), with the real router, auth store and data
// layer on the stand-in database: what a visitor sees for a good link, for every kind of bad link, signed out and signed in,
// and what the sign-up and login screens do with the page they are asked to come back to. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'
import { createDatabase } from '../../components/dev/fakeDatabase.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), removeSessionMember: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

vi.setConfig({ testTimeout: 30000 })
beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// The page's heading says "This link no longer works"; the text under it says why.
const DEAD = 'It may have expired, the host may have replaced or turned it off, or the session may already be under way.'
const DEMO = { ...PROFILE, email: 'ian@jio.demo', name: 'Ian', username: 'ian', demo: true, friends: [] }

// Open the app on a shared database as someone (or nobody). The one opened last is the one whose screens are drawn.
// How to call: const app = await open(database, OTHER)
async function open(database, profile, options = {}) {
  const fake = fakeSupabase({ database, memoryOnly: true, ...options })
  const app = await boot(fake, {}, { shared: true })
  const user = profile ? await app.api.signUp({ ...profile }) : null
  return { ...app, fake, user }
}

// A host's session with a link, made on a database, and the token.
// How to call: const { database, token, id } = await hostedSession()
async function hostedSession(patch = {}) {
  const database = createDatabase({ profiles: {} })
  const host = await open(database, PROFILE)
  const { id } = await host.api.createSession({ ...SESSION, ...patch })
  const { token } = await host.api.makeInviteLink(id)
  return { database, host, token, id }
}

// The button whose words include `label` (a "next" button writes its label twice, once for the hover). How to call: press(view, 'Join session')
const press = (view, label) => view.all('button').find((b) => view.text(b).includes(label))

// The join page for `token`, on a router that knows the real routes, with the person from `as` (the last app opened).
// How to call: const t = await show(token)
async function show(token) {
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const store = useAuthStore()
  await store.init()
  const { routes } = await import('@/router/routes.js')
  const { installGuard } = await import('@/router/guard.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  installGuard(router)
  await router.push(`/join/${token}`)
  const { default: JoinView } = await import('@/views/JoinView.vue')
  const view = await mountScreen(JoinView, { plugins: [pinia, router], props: { token } })
  await until(() => !view.has('[aria-busy]'))
  return { view, router, store }
}

describe('a link, seen by someone who is not signed in', () => {
  it('shows the session\'s title, day, times and the host\'s name, and the two ways in', async () => {
    const { database, token } = await hostedSession({ title: 'Saturday lunch' })
    await open(database, null)
    const { view, router } = await show(token)
    expect(view.errors).toEqual([])
    expect(view.text('h1')).toBe('Saturday lunch')
    expect(view.text()).toContain('Sam invited you to')
    expect(view.text()).toContain('Sat 10 Oct · 12:00 to 20:00')
    expect(view.text()).toContain('Sign up or log in to join. You will come back to this page.')
    const signup = view.all('a').find((a) => a.attrs.href === router.resolve({ path: '/signup', query: { next: `/join/${token}` } }).href)
    const login = view.all('a').find((a) => a.attrs.href === router.resolve({ path: '/login', query: { next: `/join/${token}` } }).href)
    expect(view.text(signup)).toContain('Sign up to join')
    expect(view.text(login)).toBe('I have an account. Log in')
    // Nothing else about the session: no members, no ids.
    expect(view.text()).not.toContain('Kim')
    expect(view.has('button')).toBe(false)
    expect(router.currentRoute.value.name).toBe('join')
  })

  it('has one main heading, and every control is a link with words', async () => {
    const { database, token } = await hostedSession()
    await open(database, null)
    const { view } = await show(token)
    expect(view.all('h1')).toHaveLength(1)
    for (const link of view.all('a')) expect(view.text(link).length).toBeGreaterThan(3)
  })

  it('says the link no longer works for a revoked link, an expired link, a cancelled session and a mistyped link, with a way to log in', async () => {
    for (const how of ['revoked', 'expired', 'cancelled', 'mistyped']) {
      const { database, host, token, id } = await hostedSession()
      if (how === 'revoked') await host.api.revokeInviteLink(id)
      if (how === 'expired') database.tables.invites[0].expires_at = '2026-10-01T00:00:00.000Z'
      if (how === 'cancelled') await host.api.cancelSession(id)
      await open(database, null)
      const { view } = await show(how === 'mistyped' ? 'q'.repeat(43) : token)
      expect(view.text(view.one('h2'))).toBe('This link no longer works')
      expect(view.text(view.one('[data-testid=join-unusable]'))).toContain(DEAD)
      expect(view.text(view.one('a'))).toBe('Log in')
      expect(view.has('h1')).toBe(false)
      expect(view.errors).toEqual([])
    }
  })

  it('says it could not load the invitation when Jio cannot be reached, and tries again on Retry', async () => {
    const { database, token } = await hostedSession()
    const visitor = await open(database, null)
    visitor.fake.state.options.down = true
    const { view } = await show(token)
    expect(view.text(view.one('h2'))).toBe('Could not load this invitation')
    expect(view.text()).toContain('Jio could not be reached. Check your connection and try again.')
    visitor.fake.state.options.down = false
    await view.click(press(view, 'Retry'))
    await until(() => view.has('h1'))
    expect(view.text('h1')).toBe(SESSION.title)
  })
})

describe('a link, seen by someone signed in', () => {
  it('joins on "Join session" and opens the session', async () => {
    const { database, token, id } = await hostedSession()
    await open(database, OTHER)
    const { view, router } = await show(token)
    expect(view.text()).toContain('Sam invited you to')
    expect(view.all('a').some((a) => a.attrs.href?.startsWith('/signup'))).toBe(false)
    await view.click(press(view, 'Join session'))
    await until(() => router.currentRoute.value.name === 'session')
    expect(router.currentRoute.value.path).toBe(`/sessions/${id}`)
    expect(database.tables.session_members.map((m) => m.role)).toEqual(['host', 'guest'])
  })

  it('tells a person who is already in the session, and the host who opens their own link', async () => {
    const { database, host, token, id } = await hostedSession()
    const kim = await open(database, OTHER)
    await kim.api.joinWithLink(token)
    const { view } = await show(token)
    await view.click(press(view, 'Join session'))
    await until(() => view.has('[data-testid=join-already]'))
    expect(view.text(view.one('h2'))).toBe(`You are already in ${SESSION.title}`)
    const link = view.all('a').find((a) => view.text(a) === 'Open session')
    expect(link.attrs.href).toBe(`/sessions/${id}`)
    expect(database.tables.session_members).toHaveLength(2)
    expect(host.user.id).toBeTruthy()
  })

  it('opens a popup naming the meetup in the way when the person is already in one at that time, and does not join', async () => {
    const { database, token } = await hostedSession({ title: 'Saturday lunch' })
    const app = await open(database, OTHER)
    await app.api.createSession({ ...SESSION, title: 'Kim\'s dinner', start: '19:00', end: '21:00', date: '2026-10-10' })
    const { view } = await show(token)
    await view.click(press(view, 'Join session'))
    await until(() => view.has('[data-testid=clash-change]'))
    const dialog = view.one('[role=dialog]')
    expect(view.text(dialog)).toContain('You have a clashing meetup')
    expect(view.text(dialog)).toContain('Kim\'s dinner')
    expect(database.tables.session_members.filter((m) => m.role === 'guest')).toEqual([])
    expect(view.has('[data-testid=join-problem]')).toBe(false)
    expect(press(view, 'Join session')).toBeTruthy()
  })

  it('says so under the button when the session is full, and keeps the button for another try', async () => {
    const { database, token } = await hostedSession()
    for (let i = 0; i < 29; i += 1) {
      const user = `00000000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`
      database.setProfile(user, { username: `g${i}`, display_name: `G${i}`, avatar_url: null })
      database.run({ as: user, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
    }
    await open(database, OTHER)
    const { view } = await show(token)
    await view.click(press(view, 'Join session'))
    await until(() => view.has('[data-testid=join-problem]'))
    expect(view.text(view.one('[data-testid=join-problem]'))).toBe('This session is full.')
    expect(view.one('[data-testid=join-problem]').attrs.role).toBe('alert')
    expect(press(view, 'Join session')).toBeTruthy()
  })

  it('switches to the "no longer works" page when the link stops working between the preview and the press', async () => {
    const { database, host, token, id } = await hostedSession()
    await open(database, OTHER)
    const { view } = await show(token)
    database.tables.invites[0].revoked = true
    await view.click(press(view, 'Join session'))
    await until(() => view.has('[data-testid=join-unusable]'))
    expect(view.text(view.one('[data-testid=join-unusable]'))).toContain(DEAD)
    expect(host).toBeTruthy()
    expect(id).toBeTruthy()
  })

  it('does not offer a demo account a button, and says what to do', async () => {
    const { database, token } = await hostedSession()
    await open(database, DEMO)
    const { view } = await show(token)
    expect(view.text()).toContain('A demo account cannot join a shared session. Log out, then log in with a Jio account.')
    expect(view.has('button')).toBe(false)
    expect(view.one('p[role=alert]')).toBeTruthy()
  })

  it('says invite links need an account when this copy of Jio has none set up', async () => {
    const { token } = await hostedSession()
    await boot(null, {}, { shared: true })
    const { view } = await show(token)
    expect(view.text(view.one('[data-testid=join-unusable]'))).toContain('Invite links need a Jio account, and this copy of Jio has none set up.')
  })
})

describe('coming back to the invitation after signing up or logging in', () => {
  // The login and sign-up screens on a router at `path`, with the real guard, for a visitor with no account yet.
  async function screen(file, path) {
    const database = createDatabase({ profiles: {} })
    const fake = fakeSupabase({ database, memoryOnly: true })
    await boot(fake, {}, { shared: true })
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    const store = useAuthStore()
    await store.init()
    const { routes } = await import('@/router/routes.js')
    const { installGuard } = await import('@/router/guard.js')
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
    installGuard(router)
    await router.push(path)
    const { default: View } = await import(`@/views/${file}.vue`)
    const view = await mountScreen(View, { plugins: [pinia, router] })
    return { view, router, store, fake }
  }
  const next = `/join/${'q'.repeat(43)}`

  it('keeps the page on the links between the login and sign-up screens', async () => {
    const login = await screen('LoginView', `/login?next=${encodeURIComponent(next)}`)
    const to = (router, path) => router.resolve({ path, query: { next } }).href
    expect(login.view.all('a').some((a) => a.attrs.href === to(login.router, '/signup'))).toBe(true)
    const signup = await screen('AuthView', `/signup?next=${encodeURIComponent(next)}`)
    expect(signup.view.all('a').some((a) => a.attrs.href === to(signup.router, '/login'))).toBe(true)
  })

  it('drops a page that is not on this site, from the sign-up screen\'s link to the login', async () => {
    const signup = await screen('AuthView', `/signup?next=${encodeURIComponent('//evil.example/x')}`)
    const hrefs = signup.view.all('a').map((a) => a.attrs.href)
    expect(hrefs.some((h) => h?.startsWith('/login?'))).toBe(false)
    expect(hrefs).toContain('/login')
  })

  it('logs in and goes back to the invitation', async () => {
    const login = await screen('LoginView', `/login?next=${encodeURIComponent(next)}`)
    // A registered person who is signed out.
    Object.assign(login.store.draft, { ...PROFILE, step: 8 })
    await login.store.signUp()
    await login.store.signOut()
    login.view.type('#login-email', PROFILE.email)
    login.view.type('#login-password', PROFILE.password)
    await login.view.click('button[type=submit]')
    await until(() => login.store.signedIn)
    await until(() => login.router.currentRoute.value.name === 'join')
    expect(login.router.currentRoute.value.path).toBe(next)
  })
})
