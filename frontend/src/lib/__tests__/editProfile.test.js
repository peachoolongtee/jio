// Edit profile: the data layer's password check and change, the "Edit profile" button on the Profile page, the route's
// guard, and the edit page drawn for real (domless.js) on the stand-in Supabase, for a real and a local account.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// Canvas drawings that need a browser; the screen's own logic is what is under test.
vi.mock('@/components/ui/GridPulse.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/ui/MeetupGraph.vue', () => ({ default: { render: () => null } }))

// Drawing a screen compiles its templates the first time, which is slow on a busy machine.
vi.setConfig({ testTimeout: 20000 })

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
// Every screen a test draws, so that after each test none of them has had an error or a warning from Vue.
const drawn = []
afterEach(() => {
  const problems = drawn.splice(0).flatMap((view) => [...view.errors, ...view.warnings]).map((e) => String(e?.stack || e).slice(0, 400))
  vi.unstubAllGlobals()
  expect(problems).toEqual([])
})

// A password that keeps the checklist's rule; PROFILE.password has a '-', which the checklist refuses.
const RIGHT = 'Sup3rSecret!'
const NEW = 'N3wSecret!'

// The app's routes with stand-in screens, the guard and the auth store. With `fake` a real account is signed up with
// the password RIGHT (and signed out again unless `signedIn`); without it the local demo account is signed in.
// How to call: const t = await setUp({ signedIn: true })
async function setUp({ fake = fakeSupabase(), signedIn = true } = {}) {
  const booted = await boot(fake)
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const store = useAuthStore()
  if (fake) {
    Object.assign(store.draft, { ...PROFILE, password: RIGHT, step: 8 })
    await store.signUp()
    if (!signedIn) await store.signOut()
  } else {
    const { DEMO_ACCOUNT } = await import('../../components/dev/demoAccount.js')
    await store.signUpAs(DEMO_ACCOUNT)
  }
  const { routes } = await import('@/router/routes.js')
  const { installGuard } = await import('@/router/guard.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  installGuard(router)
  return { ...booted, fake, store, router, pinia }
}

// Draw one screen after the router has opened `path`.
// How to call: const view = await draw(t, '/profile/edit', 'EditProfileView')
async function draw(t, path, name) {
  await t.router.push(path)
  const { default: screen } = await import(`@/views/${name}.vue`)
  const view = await mountScreen(screen, { plugins: [t.pinia, t.router] })
  drawn.push(view)
  return view
}

// Fill in the three password fields.
// How to call: typePasswords(view, RIGHT, NEW, NEW)
function typePasswords(view, current, next, again) {
  view.type('#edit-current', current)
  view.type('#edit-new', next)
  view.type('#edit-confirm', again)
}

// Pick an option of a dropdown, as the browser does, and tell Vue.
// How to call: choose(view, '#edit-area', 'bishan')
function choose(view, selector, value) {
  const select = view.one(selector)
  select.options.forEach((option) => (option.selected = option.value === value))
  select.dispatch('change')
}

// What the three password fields hold, in order.
// How to call: passwordValues(view) -> ['', '', '']
const passwordValues = (view) => ['#edit-current', '#edit-new', '#edit-confirm'].map((s) => view.one(s).value)

describe('checking and changing the password (data layer)', () => {
  it('says whether a password is the signed-in person’s, by asking Supabase', async () => {
    const { auth } = await setUp()
    await expect(auth.checkPassword(PROFILE.email, RIGHT)).resolves.toBe(true)
    await expect(auth.checkPassword(PROFILE.email, 'Wr0ngSecret!')).rejects.toMatchObject({ code: 'wrong_password', message: auth.MESSAGES.wrong_password })
  })

  it('changes nothing when the current password is wrong, and sets the new one when it is right', async () => {
    const { api, auth, fake } = await setUp()
    await expect(api.changeOwnPassword({ current: 'Wr0ngSecret!', next: NEW })).rejects.toThrow(auth.MESSAGES.wrong_password)
    expect(fake.state.passwordUpdates).toEqual([])
    await api.changeOwnPassword({ current: RIGHT, next: NEW })
    expect(fake.state.passwordUpdates).toEqual(['uid-1'])
    await api.signOut()
    await expect(api.signIn({ email: PROFILE.email, password: RIGHT })).rejects.toThrow()
    expect(await api.signIn({ email: PROFILE.email, password: NEW })).toMatchObject({ authId: 'uid-1' })
  })

  it('keeps the person signed in after the check signs them in again', async () => {
    const { api, store } = await setUp()
    await api.changeOwnPassword({ current: RIGHT, next: NEW })
    expect(store.signedIn).toBe(true)
    expect(store.user).toMatchObject({ authId: 'uid-1', name: PROFILE.name })
  })

  it('refuses for a local account, which has no password', async () => {
    const { api } = await setUp({ fake: null })
    await expect(api.changeOwnPassword({ current: RIGHT, next: NEW })).rejects.toThrow('has no password')
  })
})

describe('the Profile page', () => {
  it('has "Edit profile" under the numbers on my own profile, going to /profile/edit, and not on someone else’s', async () => {
    const t = await setUp()
    const mine = await draw(t, '/profile', 'ProfileView')
    drawn.pop()
    await until(() => mine.has('.stats'))
    expect(mine.one('[data-testid="edit-profile"]').attrs.href).toBe('/profile/edit')
    expect(mine.text('[data-testid="edit-profile"]')).toBe('Edit profile')
    mine.unmount()
    const { default: ProfileView } = await import('@/views/ProfileView.vue')
    await t.router.push('/people/darius')
    const theirs = await mountScreen(ProfileView, { plugins: [t.pinia, t.router], props: { id: 'darius' } })
    await until(() => theirs.has('.stats'))
    // Errors only: the Profile page had one warning from Vue on the stand-in page before this button, mine or not.
    expect([...mine.errors, ...theirs.errors]).toEqual([])
    expect(theirs.has('[data-testid="edit-profile"]')).toBe(false)
    expect(theirs.has('button[aria-pressed]')).toBe(true)
  })
})

describe('the route', () => {
  it('sends a signed-out visitor to the login, and lets a signed-in person in', async () => {
    const out = await setUp({ signedIn: false })
    await out.router.push('/profile/edit')
    expect(out.router.currentRoute.value.name).toBe('login')
    expect(out.router.currentRoute.value.query.next).toBe('/profile/edit')
    const t = await setUp()
    await t.router.push('/profile/edit')
    expect(t.router.currentRoute.value.name).toBe('profile-edit')
  })
})

describe('editing the details', () => {
  it('starts from the signed-in person and saves the changes to Supabase', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await until(() => view.all('option').length > 1)
    expect(view.one('#edit-name').value).toBe(PROFILE.name)
    // Nothing has changed yet, so there is nothing to save: the area and dietary needs start from the person too.
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
    view.type('#edit-name', '  Samantha ')
    choose(view, '#edit-area', 'bishan')
    await view.click(view.all('button').find((b) => view.text(b) === 'Vegan'))
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.fake.state.profiles['uid-1'].display_name).toBe('Samantha')
    expect(t.fake.state.priv['uid-1']).toMatchObject({ home_area_id: 'bishan', dietary: ['vegan'] })
    expect(t.store.user).toMatchObject({ name: 'Samantha', homeAreaId: 'bishan', dietary: ['vegan'] })
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
  })

  it('refuses an empty name and writes nothing', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const writes = t.fake.state.writes.length
    view.type('#edit-name', '   ')
    await view.click('[data-testid="save-details"]')
    expect(view.text()).toContain('Enter your name.')
    expect(t.fake.state.writes).toHaveLength(writes)
    expect(t.store.user.name).toBe(PROFILE.name)
  })

  it('does not say "Saved" when Supabase could not be written to', async () => {
    const t = await setUp()
    t.fake.state.options.failWrites = true
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    view.type('#edit-name', 'Samantha')
    await view.click('[data-testid="save-details"]')
    await until(() => !!t.store.syncNotice)
    expect(t.store.syncNotice).toBe(t.auth.MESSAGES.profile_not_saved)
    expect(view.has('[data-testid="details-saved"]')).toBe(false)
  })
})

describe('changing the password', () => {
  it('has the sign-up checklist, with its hint, and holds the button until the rule is kept', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(view.all('.checklist__item')).toHaveLength(6)
    expect(view.text('.checklist')).toContain('e.g. ! @ # $ % *')
    typePasswords(view, RIGHT, 'n3wsecret!', 'n3wsecret!')
    await view.tick()
    expect(view.one('[data-testid="save-password"]').disabled).toBe(true)
  })

  it('has a Show button on each field that shows that field only', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const types = () => ['#edit-current', '#edit-new', '#edit-confirm'].map((s) => view.one(s).attrs.type)
    expect(types()).toEqual(['password', 'password', 'password'])
    await view.click('[data-testid="peek-next"]')
    expect(types()).toEqual(['password', 'text', 'password'])
    expect(view.text('[data-testid="peek-next"]')).toBe('Hide')
    expect(view.one('[data-testid="peek-next"]').attrs['aria-label']).toBe('Hide new password')
    await view.click('[data-testid="peek-current"]')
    await view.click('[data-testid="peek-next"]')
    expect(types()).toEqual(['text', 'password', 'password'])
    await view.click('[data-testid="peek-confirm"]')
    expect(types()).toEqual(['text', 'password', 'text'])
  })

  it('refuses two new passwords that do not match, without asking Supabase, and empties the fields', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    typePasswords(view, RIGHT, NEW, 'N3wSecret*')
    await view.click('[data-testid="save-password"]')
    expect(view.text()).toContain('The two new passwords do not match.')
    expect(t.fake.state.passwordUpdates).toEqual([])
    expect(passwordValues(view)).toEqual(['', '', ''])
  })

  it('refuses a new password that is the current one, and empties the fields', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const signIns = t.fake.state.signInCalls.length
    typePasswords(view, RIGHT, RIGHT, RIGHT)
    await view.click('[data-testid="save-password"]')
    expect(view.text()).toContain(t.auth.MESSAGES.same_password)
    expect(t.fake.state.signInCalls).toHaveLength(signIns)
    expect(t.fake.state.passwordUpdates).toEqual([])
    expect(passwordValues(view)).toEqual(['', '', ''])
  })

  it('shows "not right" under the current password when it is wrong, changes nothing, and empties the fields', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    typePasswords(view, 'Wr0ngSecret!', NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.text().includes(t.auth.MESSAGES.wrong_password))
    expect(view.one('#edit-current').attrs['aria-invalid']).toBe('true')
    expect(t.fake.state.passwordUpdates).toEqual([])
    expect(passwordValues(view)).toEqual(['', '', ''])
  })

  it('changes it when the current password is right, says so, and empties the fields', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-changed"]'))
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
    expect(passwordValues(view)).toEqual(['', '', ''])
    expect(t.store.signedIn).toBe(true)
  })
})

describe('a local account', () => {
  it('shows a note instead of the password form, and still saves its details', async () => {
    const t = await setUp({ fake: null })
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(view.has('[data-testid="no-password-note"]')).toBe(true)
    expect(view.text('[data-testid="no-password-note"]')).toContain('no password')
    expect(view.has('#edit-current')).toBe(false)
    view.type('#edit-name', 'Ian T')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.store.user.name).toBe('Ian T')
  })
})

// Things a person could do that the tests above do not: pressing twice, a lost connection, a login that ends, a page
// reload, the profile changing under the page, and the edges of the name rule.
describe('under stress', () => {
  const buttonLabelled = (view, text) => view.all('button').find((b) => view.text(b) === text)

  it('checks and changes the password once when the form is sent three times at once', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const signIns = t.fake.state.signInCalls.length
    typePasswords(view, RIGHT, NEW, NEW)
    await view.tick()
    const form = view.one('form#password-form')
    form.dispatch('submit')
    form.dispatch('submit')
    form.dispatch('submit')
    await until(() => view.has('[data-testid="password-changed"]'))
    expect(t.fake.state.signInCalls).toHaveLength(signIns + 1)
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
  })

  it('saves the details once when the form is sent twice at once', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const writes = t.fake.state.writes.length
    view.type('#edit-name', 'Samantha')
    await view.tick()
    const form = view.one('form#details-form')
    form.dispatch('submit')
    form.dispatch('submit')
    await until(() => view.has('[data-testid="details-saved"]'))
    // One write to each of the two tables.
    expect(t.fake.state.writes).toHaveLength(writes + 2)
  })

  it('keeps the person signed in after wrong passwords, and the right one still works afterwards', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    for (const wrong of ['Wr0ngSecret!', 'Sup3rSecret*', 'sup3rSecret!']) {
      typePasswords(view, wrong, NEW, NEW)
      await view.click('[data-testid="save-password"]')
      await until(() => view.text().includes(t.auth.MESSAGES.wrong_password))
      expect(passwordValues(view)).toEqual(['', '', ''])
      expect(t.store.signedIn).toBe(true)
      // Typing again takes the message away.
      view.type('#edit-current', 'x')
      await view.tick()
      expect(view.text()).not.toContain(t.auth.MESSAGES.wrong_password)
    }
    expect(t.fake.state.passwordUpdates).toEqual([])
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-changed"]'))
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
  })

  it('can change the password twice in a row, the second time from the new one', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-changed"]'))
    typePasswords(view, NEW, 'Th1rdSecret!', 'Th1rdSecret!')
    await view.tick()
    expect(view.has('[data-testid="password-changed"]')).toBe(false)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-changed"]'))
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1', 'uid-1'])
    await t.api.signOut()
    expect(await t.api.signIn({ email: PROFILE.email, password: 'Th1rdSecret!' })).toMatchObject({ authId: 'uid-1' })
  })

  it('says there is no connection, changes nothing, empties the fields and keeps the person signed in', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    t.fake.state.options.down = true
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-error"]'))
    expect(view.text('[data-testid="password-error"]')).toBe(t.auth.MESSAGES.offline)
    expect(passwordValues(view)).toEqual(['', '', ''])
    expect(t.fake.state.passwordUpdates).toEqual([])
    expect(t.store.signedIn).toBe(true)
  })

  it('changes the password after a page reload, when the person comes from the saved session', async () => {
    const t = await setUp()
    const again = await boot(t.fake, { data: t.storage.store })
    expect(await again.api.startUser()).toMatchObject({ user: { authId: 'uid-1', email: PROFILE.email } })
    await again.api.changeOwnPassword({ current: RIGHT, next: NEW })
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
  })

  it('shows neither the form nor the local-account note when the login ends while the page is open', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(view.has('#edit-current')).toBe(true)
    t.fake.state.endSession()
    await until(() => !t.store.signedIn)
    await view.tick()
    expect(view.has('#edit-current')).toBe(false)
    expect(view.has('[data-testid="no-password-note"]')).toBe(false)
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
  })

  it('takes in a profile read from Supabase after the page opened, but keeps what the person has typed', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await until(() => view.all('option').length > 1)
    // Another device changed the name and the dietary needs.
    t.fake.state.profiles['uid-1'].display_name = 'Samuel'
    t.fake.state.priv['uid-1'].dietary = ['halal']
    await t.api.refreshProfile()
    await until(() => view.one('#edit-name').value === 'Samuel')
    expect(buttonLabelled(view, 'Halal').attrs['aria-pressed']).toBe('true')
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
    // Now the person types a name, and the home area changes elsewhere: the typed name stays.
    view.type('#edit-name', 'Sammy')
    t.fake.state.priv['uid-1'].home_area_id = 'bishan'
    await t.api.refreshProfile()
    await until(() => t.store.user.homeAreaId === 'bishan')
    await view.tick()
    expect(view.one('#edit-name').value).toBe('Sammy')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.fake.state.profiles['uid-1'].display_name).toBe('Sammy')
    expect(t.fake.state.priv['uid-1']).toMatchObject({ home_area_id: 'bishan', dietary: ['halal'] })
  })

  it('takes a name of exactly 50 characters and refuses 51, and treats spaces around the name as no change', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    view.type('#edit-name', `  ${PROFILE.name}  `)
    await view.tick()
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
    view.type('#edit-name', 'a'.repeat(51))
    await view.click('[data-testid="save-details"]')
    expect(view.text()).toContain('Use 50 characters or fewer.')
    expect(t.store.user.name).toBe(PROFILE.name)
    view.type('#edit-name', 'a'.repeat(50))
    await view.tick()
    expect(view.text()).not.toContain('Use 50 characters or fewer.')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.fake.state.profiles['uid-1'].display_name).toBe('a'.repeat(50))
  })

  it('saves no home area and no dietary needs, then saves again, with "Saved" going away on the next change', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await until(() => view.all('option').length > 1)
    choose(view, '#edit-area', '')
    await view.click(buttonLabelled(view, 'Vegan'))
    await view.click(buttonLabelled(view, 'Vegan'))
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.fake.state.priv['uid-1']).toMatchObject({ home_area_id: null, dietary: [] })
    // The saved person coming back to the page does not take "Saved" away.
    for (let i = 0; i < 5; i += 1) await view.tick()
    expect(view.has('[data-testid="details-saved"]')).toBe(true)
    await view.click(buttonLabelled(view, 'Halal'))
    expect(view.has('[data-testid="details-saved"]')).toBe(false)
    await view.click(buttonLabelled(view, 'Vegetarian'))
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.fake.state.priv['uid-1'].dietary).toEqual(['halal', 'vegetarian'])
    expect(t.store.user.dietary).toEqual(['halal', 'vegetarian'])
  })

  it('has no trouble when the person leaves the page while both saves are on their way', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    view.type('#edit-name', 'Samantha')
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-details"]')
    await view.click('[data-testid="save-password"]')
    view.unmount()
    await until(() => t.fake.state.passwordUpdates.length === 1 && t.store.user?.name === 'Samantha')
    expect(t.store.signedIn).toBe(true)
  })
})
