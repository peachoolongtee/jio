// Edit profile: the data layer's password check and change, the "Edit profile" button on the Profile page, the route's
// guard, and the edit page drawn for real (domless.js) on the stand-in Supabase, for a real and a local account, with
// its profile photo.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { AUTH_STORAGE_KEY } from '@/lib/supabase.js'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// Canvas drawings that need a browser; the screen's own logic is what is under test.
vi.mock('@/components/ui/GridPulse.vue', () => ({ default: { render: () => null } }))
vi.mock('@/components/ui/MeetupGraph.vue', () => ({ default: { render: () => null } }))
// Shrinking a picture needs a browser's image decoder and canvas; photo.test.js tests it. Here it answers at once.
const photoLib = vi.hoisted(() => ({ PHOTO_SIZE: 160, shrinkPhoto: vi.fn() }))
vi.mock('@/lib/photo.js', () => photoLib)

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

// Passwords that keep the checklist's rule. RIGHT is the password the real account in these tests is signed up with (set
// by setUp, in place of PROFILE.password); NEW is the one it changes to.
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

// Open a tab by clicking it in the menu, as a person does, and wait for it.
// How to call: await openTab(t, view, 'password')
async function openTab(t, view, id) {
  await view.click(`[data-testid="tab-${id}"]`)
  const name = id === 'password' ? 'profile-password' : 'profile-edit'
  await until(() => t.router.currentRoute.value.name === name && view.has(id === 'password' ? '#password-head' : '#details-head'))
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

// The button whose words are `text`.
// How to call: buttonLabelled(view, 'Vegan')
const buttonLabelled = (view, text) => view.all('button').find((b) => view.text(b) === text)

describe('checking and changing the password (data layer)', () => {
  it('says whether a password is the signed-in person’s, by asking Supabase', async () => {
    const { auth } = await setUp()
    await expect(auth.checkPassword(PROFILE.email, RIGHT, 'uid-1')).resolves.toBe(true)
    await expect(auth.checkPassword(PROFILE.email, 'Wr0ngSecret!', 'uid-1')).rejects.toMatchObject({ code: 'wrong_password', message: auth.MESSAGES.wrong_password })
  })

  it('refuses a password that signs in as another account, changes nothing, and puts the session it held back', async () => {
    const { auth, fake } = await setUp()
    // The email on file now belongs to somebody else's account, whose password this is.
    fake.state.users.push({ id: 'uid-2', email: 'kim@example.com', password: 'An0ther-secret!', meta: {} })
    const original = structuredClone(fake.state.session)
    const stored = localStorage.getItem(AUTH_STORAGE_KEY)
    await expect(auth.checkPassword('kim@example.com', 'An0ther-secret!', 'uid-1')).rejects.toMatchObject({ code: 'wrong_password' })
    expect(fake.state.passwordUpdates).toEqual([])
    expect(fake.state.setSessionCalls).toBe(1)
    expect(fake.state.session).toEqual(original)
    expect(fake.state.session.user.id).toBe('uid-1')
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBe(stored)
  })

  it('signs this browser out, instead of leaving it in another account, when the session it held cannot be put back', async () => {
    const { auth, fake } = await setUp()
    fake.state.users.push({ id: 'uid-2', email: 'kim@example.com', password: 'An0ther-secret!', meta: {} })
    fake.state.issued = {}
    await expect(auth.checkPassword('kim@example.com', 'An0ther-secret!', 'uid-1')).rejects.toMatchObject({ code: 'wrong_password' })
    expect(fake.state.session).toBeNull()
    expect(fake.state.passwordUpdates).toEqual([])
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
  // Draw the Profile page for `id` (the signed-in person's own when empty) and wait until it has settled, with the person's
  // numbers or with nothing to show for them. Each test checks the page's errors itself.
  // How to call: const view = await profileOf(t, 'darius')
  async function profileOf(t, id) {
    const { default: ProfileView } = await import('@/views/ProfileView.vue')
    await t.router.push(id ? `/people/${id}` : '/profile')
    const view = await mountScreen(ProfileView, { plugins: [t.pinia, t.router], props: id ? { id } : {} })
    await until(() => view.has('.stats') || (!view.has('.profile__loading') && !view.has('[data-testid="profile-view"]')))
    return view
  }

  it('has "Edit profile" under the numbers on my own profile, going to /profile/edit', async () => {
    const t = await setUp()
    const mine = await profileOf(t)
    expect(mine.errors).toEqual([])
    expect(mine.one('[data-testid="edit-profile"]').attrs.href).toBe('/profile/edit')
    expect(mine.text('[data-testid="edit-profile"]')).toBe('Edit profile')
    const local = await setUp({ fake: null })
    const own = await profileOf(local)
    expect(own.errors).toEqual([])
    expect(own.one('[data-testid="edit-profile"]').attrs.href).toBe('/profile/edit')
  })

  it('does not have "Edit profile" on someone else’s profile, for a real account or a local one', async () => {
    const t = await setUp()
    const theirs = await profileOf(t, 'darius')
    expect(theirs.errors).toEqual([])
    // Whatever the page shows for a person a real account has no relation to (the profile, or "not found"), it is not mine.
    expect(theirs.has('[data-testid="edit-profile"]')).toBe(false)
    expect(theirs.text()).not.toContain('Edit profile')
    // A real account has no friend button on a sample person; with a local account the friend button is there instead.
    expect(theirs.has('button[aria-pressed]')).toBe(false)
    const local = await setUp({ fake: null })
    const theirsLocal = await profileOf(local, 'darius')
    expect(theirsLocal.errors).toEqual([])
    expect(theirsLocal.has('.stats')).toBe(true)
    expect(theirsLocal.has('[data-testid="edit-profile"]')).toBe(false)
    expect(theirsLocal.has('button[aria-pressed]')).toBe(true)
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

describe('the two tabs', () => {
  it('opens Edit profile at /profile/edit and Password at /profile/edit/password, each marked as the current tab', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(view.text('h1')).toBe('Edit profile')
    expect(view.one('[data-testid="tab-details"]').attrs['aria-current']).toBe('page')
    expect(view.one('[data-testid="tab-password"]').attrs['aria-current']).toBeUndefined()
    expect(view.one('[data-testid="tab-password"]').attrs.href).toBe('/profile/edit/password')
    expect(view.has('#edit-current')).toBe(false)
    await openTab(t, view, 'password')
    expect(view.text('h1')).toBe('Password')
    expect(view.one('[data-testid="tab-password"]').attrs['aria-current']).toBe('page')
    expect(view.has('#edit-name')).toBe(false)
    expect(view.has('#edit-current')).toBe(true)
  })

  it('switches tabs without adding to the history, so Back goes to the Profile page', async () => {
    const t = await setUp()
    await t.router.push('/profile')
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await openTab(t, view, 'password')
    await openTab(t, view, 'details')
    t.router.back()
    await until(() => t.router.currentRoute.value.path === '/profile')
  })

  it('keeps what was typed in Edit profile while the Password tab is open', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    view.type('#edit-name', 'Samantha')
    await openTab(t, view, 'password')
    await openTab(t, view, 'details')
    expect(view.one('#edit-name').value).toBe('Samantha')
    expect(view.one('[data-testid="save-details"]').disabled).toBe(false)
  })

  it('shows a card with the photo, @username and name, the name following what is typed', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(view.text('[data-testid="card-username"]')).toBe(`@${PROFILE.username}`)
    expect(view.text('[data-testid="card-name"]')).toBe(PROFILE.name)
    view.type('#edit-name', 'Samantha')
    await view.tick()
    expect(view.text('[data-testid="card-name"]')).toBe('Samantha')
  })

  it('sends a signed-out visitor to the login from the Password tab too', async () => {
    const out = await setUp({ signedIn: false })
    await out.router.push('/profile/edit/password')
    expect(out.router.currentRoute.value.name).toBe('login')
    expect(out.router.currentRoute.value.query.next).toBe('/profile/edit/password')
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
    await view.click(buttonLabelled(view, 'Vegan'))
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

  it('sends only the name when only the name is edited, so a copy of the page that is out of date erases nothing', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await until(() => view.all('option').length > 1)
    const before = t.fake.state.writes.length
    // Another device set "halal" after this page opened; this copy has not heard of it.
    t.fake.state.priv['uid-1'].dietary = ['halal']
    view.type('#edit-name', 'Samantha')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.fake.state.writes.slice(before)).toEqual([{ table: 'profiles', row: { display_name: 'Samantha' }, id: 'uid-1' }])
    expect(t.fake.state.priv['uid-1'].dietary).toEqual(['halal'])
    expect(t.fake.state.priv['uid-1'].home_area_id).toBe('tampines')
  })

  it('writes nothing to Supabase when only a photo is added', async () => {
    photoLib.shrinkPhoto.mockReset().mockResolvedValue('data:image/jpeg;base64,c21hbGw=')
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const before = t.fake.state.writes.length
    const input = view.one('#edit-photo')
    input.files = [{ type: 'image/png', name: 'me.png' }]
    input.dispatch('change')
    await until(() => !view.one('[data-testid="save-details"]').disabled)
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.fake.state.writes).toHaveLength(before)
    expect(t.fake.state.profiles['uid-1'].display_name).toBe(PROFILE.name)
    expect(t.store.user.photo).toBe('data:image/jpeg;base64,c21hbGw=')
  })

  it('keeps Save usable after a write that did not reach the account, says so, and sends the unsent fields on the next press', async () => {
    const t = await setUp()
    t.fake.state.options.failWrites = true
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await until(() => view.all('option').length > 1)
    view.type('#edit-name', 'Samantha')
    choose(view, '#edit-area', 'bishan')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-not-saved"]'))
    expect(view.text('[data-testid="details-not-saved"]')).toBe('Saved on this device, but not to your account. Press Save details to try again.')
    expect(view.has('[data-testid="details-saved"]')).toBe(false)
    expect(view.one('[data-testid="save-details"]').disabled).toBe(false)
    expect(t.fake.state.profiles['uid-1'].display_name).toBe(PROFILE.name)
    // Pressing it while the account still cannot be written to changes nothing on the page.
    await view.click('[data-testid="save-details"]')
    await until(() => view.text('[data-testid="save-details"]') === 'Save details')
    expect(view.has('[data-testid="details-saved"]')).toBe(false)
    expect(view.has('[data-testid="details-not-saved"]')).toBe(true)
    expect(view.one('[data-testid="save-details"]').disabled).toBe(false)
    // The connection comes back: the same press sends the name and the home area again, and the message goes.
    t.fake.state.options.failWrites = false
    const before = t.fake.state.writes.length
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(view.has('[data-testid="details-not-saved"]')).toBe(false)
    expect(t.fake.state.profiles['uid-1'].display_name).toBe('Samantha')
    expect(t.fake.state.priv['uid-1'].home_area_id).toBe('bishan')
    expect(t.fake.state.writes.slice(before).map((w) => w.table).sort()).toEqual(['profile_private', 'profiles'])
    expect(t.store.syncNotice).toBe('')
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
  })

  it('offers the unsent details again when the page is opened after a sign-up write that failed', async () => {
    const t = await setUp()
    t.store.syncNotice = t.auth.MESSAGES.profile_not_saved
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(view.has('[data-testid="details-not-saved"]')).toBe(true)
    expect(view.one('[data-testid="save-details"]').disabled).toBe(false)
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(view.has('[data-testid="details-not-saved"]')).toBe(false)
    expect(t.store.syncNotice).toBe('')
  })

  it('shows the data layer sentence when the browser cannot store the save, and sends nothing to Supabase', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const before = t.fake.state.writes.length
    // A real account's save is under its own key, which the stand-in's size limit does not reach: refuse that key instead.
    const accept = t.storage.setItem.bind(t.storage)
    t.storage.setItem = (key, value) => {
      if (key.includes(':acct:')) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
      accept(key, value)
    }
    view.type('#edit-name', 'Samantha')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-error"]'))
    expect(view.text('[data-testid="details-error"]')).toBe("Could not save: this browser's storage is full. Remove some photos and try again.")
    expect(view.has('[data-testid="details-saved"]')).toBe(false)
    expect(view.has('[data-testid="details-not-saved"]')).toBe(false)
    expect(t.fake.state.writes).toHaveLength(before)
    expect(t.store.user.name).toBe(PROFILE.name)
  })
})

describe('changing the password', () => {
  it('has the sign-up checklist, with its hint, and holds the button until the rule is kept', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    // Every part of the sign-up rule that a checklist draws, with its hint, whatever the rule says.
    const { passwordRules, shownRules } = await import('../signupRules.js')
    expect(view.all('.checklist__item')).toHaveLength(shownRules(passwordRules('')).length)
    const hints = shownRules(passwordRules('')).map((rule) => rule.hint).filter(Boolean)
    expect(hints.length).toBeGreaterThan(0)
    for (const hint of hints) expect(view.text('.checklist')).toContain(hint)
    typePasswords(view, RIGHT, 'n3wsecret!', 'n3wsecret!')
    await view.tick()
    expect(view.one('[data-testid="save-password"]').disabled).toBe(true)
  })

  it('says under the new password when the part not on the checklist is broken, and holds the button', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    expect(view.text()).not.toContain('No more than 72 characters')
    typePasswords(view, RIGHT, 'N3wSecret! ', 'N3wSecret! ')
    await view.tick()
    expect(view.text()).toContain('Use 72 characters or fewer, with no space at the start or end and no control characters.')
    expect(view.one('#edit-new').attrs['aria-invalid']).toBe('true')
    expect(view.one('[data-testid="save-password"]').disabled).toBe(true)
  })

  it('has a Show button on each field that shows that field only, changes its words, and does not claim to be pressed', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    const types = () => ['#edit-current', '#edit-new', '#edit-confirm'].map((s) => view.one(s).attrs.type)
    const pressed = () => ['current', 'next', 'confirm'].map((id) => view.one(`[data-testid="peek-${id}"]`).attrs['aria-pressed'])
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
    expect(view.one('[data-testid="peek-confirm"]').attrs['aria-label']).toMatch(/^Hide /)
    expect(pressed()).toEqual([undefined, undefined, undefined])
  })

  it('refuses two new passwords that do not match, without asking Supabase, and keeps what was typed', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    const signIns = t.fake.state.signInCalls.length
    typePasswords(view, RIGHT, NEW, 'N3wSecret*')
    await view.click('[data-testid="save-password"]')
    expect(view.text()).toContain('The two passwords do not match.')
    expect(view.one('#edit-confirm').attrs['aria-invalid']).toBe('true')
    expect(t.fake.state.signInCalls).toHaveLength(signIns)
    expect(t.fake.state.passwordUpdates).toEqual([])
    expect(passwordValues(view)).toEqual([RIGHT, NEW, 'N3wSecret*'])
    // Typing again takes the message away, and the corrected pair goes through with the current password as it was typed.
    view.type('#edit-confirm', NEW)
    await view.tick()
    expect(view.text()).not.toContain('The two passwords do not match.')
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-changed"]'))
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
  })

  it('asks "Type it again" for the second password, as the reset page does', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    expect(view.text('label[for="edit-confirm"]')).toBe('Type it again')
  })

  it('refuses a new password that is the current one, and keeps what was typed', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    const signIns = t.fake.state.signInCalls.length
    typePasswords(view, RIGHT, RIGHT, RIGHT)
    await view.click('[data-testid="save-password"]')
    expect(view.text()).toContain(t.auth.MESSAGES.same_password)
    expect(t.fake.state.signInCalls).toHaveLength(signIns)
    expect(t.fake.state.passwordUpdates).toEqual([])
    expect(passwordValues(view)).toEqual([RIGHT, RIGHT, RIGHT])
  })

  it('shows "not right" under the current password when it is wrong, changes nothing, and empties the fields', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    typePasswords(view, 'Wr0ngSecret!', NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.text().includes(t.auth.MESSAGES.wrong_password))
    expect(view.one('#edit-current').attrs['aria-invalid']).toBe('true')
    expect(t.fake.state.passwordUpdates).toEqual([])
    expect(passwordValues(view)).toEqual(['', '', ''])
  })

  it('changes it when the current password is right, says so, and empties the fields', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-changed"]'))
    expect(t.fake.state.passwordUpdates).toEqual(['uid-1'])
    expect(passwordValues(view)).toEqual(['', '', ''])
    expect(t.store.signedIn).toBe(true)
  })

  it('puts the focus in the current-password field after a failed attempt, since the button has just become disabled', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    typePasswords(view, 'Wr0ngSecret!', NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.text().includes(t.auth.MESSAGES.wrong_password))
    await view.tick()
    expect(view.one('[data-testid="save-password"]').disabled).toBe(true)
    expect(view.focused()).toBe(view.one('#edit-current'))
  })

  it('has a hidden, read-only field holding the account email, for a password manager', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    const field = view.one('[data-testid="password-username"]')
    expect(field.attrs.autocomplete).toBe('username')
    expect(field.value).toBe(PROFILE.email)
    expect(field.attrs.readonly).not.toBeUndefined()
    expect(field.attrs['aria-hidden']).toBeTruthy()
    expect(String(field.attrs.tabindex)).toBe('-1')
  })

  it('says to type the passwords only with the form, and not above the note a local account gets', async () => {
    const real = await setUp()
    const form = await draw(real, '/profile/edit/password', 'EditProfileView')
    expect(form.text()).toContain('Type your current password, then the new one twice.')
    expect(form.has('[data-testid="password-username"]')).toBe(true)
    const local = await setUp({ fake: null })
    const note = await draw(local, '/profile/edit/password', 'EditProfileView')
    expect(note.has('[data-testid="no-password-note"]')).toBe(true)
    expect(note.text()).not.toContain('Type your current password')
    expect(note.has('[data-testid="password-username"]')).toBe(false)
  })

  it('tells the person to log in again, not about a reset link, when the login ends before the new password is set', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    // The current password is right; then the session is gone when the change is asked for.
    t.fake.client.auth.updateUser = async () => ({
      data: { user: null },
      error: Object.assign(new Error('Auth session missing!'), { name: 'AuthSessionMissingError', status: 400, code: 'session_missing' }),
    })
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-error"]'))
    expect(view.text('[data-testid="password-error"]')).toBe('Your login has ended. Log in again to change your password.')
    expect(view.text()).not.toContain('reset link')
    expect(view.has('[data-testid="password-changed"]')).toBe(false)
  })

  it('ends the account’s other sessions once the password is changed', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    expect(t.fake.state.otherSessionsEnded).toBe(0)
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.has('[data-testid="password-changed"]'))
    expect(t.fake.state.otherSessionsEnded).toBe(1)
    expect(t.fake.state.signOutCalls).toEqual([{ scope: 'others' }])
    expect(t.store.signedIn).toBe(true)
  })

  it('ends no other session when the current password is wrong', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    typePasswords(view, 'Wr0ngSecret!', NEW, NEW)
    await view.click('[data-testid="save-password"]')
    await until(() => view.text().includes(t.auth.MESSAGES.wrong_password))
    expect(t.fake.state.otherSessionsEnded).toBe(0)
  })
})

describe('a local account', () => {
  it('shows a note instead of the password form, and still saves its details', async () => {
    const t = await setUp({ fake: null })
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    expect(view.has('[data-testid="no-password-note"]')).toBe(true)
    expect(view.text('[data-testid="no-password-note"]')).toContain('no password')
    expect(view.has('#edit-current')).toBe(false)
    await openTab(t, view, 'details')
    view.type('#edit-name', 'Ian T')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.store.user.name).toBe('Ian T')
  })
})

// Things a person could do that the tests above do not: pressing twice, a lost connection, a login that ends, a page
// reload, the profile changing under the page, and the edges of the name rule.
describe('under stress', () => {
  it('checks and changes the password once when the form is sent three times at once', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
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
    // Only the name changed, so one write, to the table that holds the name.
    expect(t.fake.state.writes).toHaveLength(writes + 1)
    expect(t.fake.state.writes.at(-1)).toMatchObject({ table: 'profiles', row: { display_name: 'Samantha' } })
  })

  it('keeps the person signed in after wrong passwords, and the right one still works afterwards', async () => {
    const t = await setUp()
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
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
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
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
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
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
    const view = await draw(t, '/profile/edit/password', 'EditProfileView')
    expect(view.has('#edit-current')).toBe(true)
    t.fake.state.endSession()
    await until(() => !t.store.signedIn)
    await view.tick()
    expect(view.has('#edit-current')).toBe(false)
    expect(view.has('[data-testid="no-password-note"]')).toBe(false)
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
    await view.click('[data-testid="save-details"]')
    await openTab(t, view, 'password')
    typePasswords(view, RIGHT, NEW, NEW)
    await view.click('[data-testid="save-password"]')
    view.unmount()
    await until(() => t.fake.state.passwordUpdates.length === 1 && t.store.user?.name === 'Samantha')
    expect(t.store.signedIn).toBe(true)
  })
})

describe('the profile photo', () => {
  const PHOTO = 'data:image/jpeg;base64,c21hbGw='
  const OTHER = 'data:image/jpeg;base64,b3RoZXI='
  // Choose a file in the photo input, as the browser does: the change event, with the file on the input.
  // How to call: await choosePhoto(view, { type: 'image/png', name: 'me.png' })
  async function choosePhoto(view, file) {
    const input = view.one('#edit-photo')
    input.files = [file]
    input.dispatch('change')
    await view.tick()
  }
  const avatarSrc = (view) => view.all('img').map((img) => img.attrs.src).find(Boolean) || ''

  it('starts with the letter of the name, then shows, saves and keeps a chosen photo', async () => {
    photoLib.shrinkPhoto.mockReset().mockResolvedValue(PHOTO)
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(avatarSrc(view)).toBe('')
    expect(view.text('.edit__upload')).toBe('Add photo')
    expect(view.has('[data-testid="remove-photo"]')).toBe(false)
    const file = { type: 'image/png', name: 'me.png' }
    await choosePhoto(view, file)
    await until(() => avatarSrc(view) === PHOTO)
    expect(photoLib.shrinkPhoto).toHaveBeenCalledWith(file)
    expect(view.text('.edit__upload')).toBe('Change photo')
    // The input is emptied, so the same file can be chosen again.
    expect(view.one('#edit-photo').value).toBe('')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.store.user.photo).toBe(PHOTO)
    // Kept over a page reload, in this browser.
    const again = await boot(t.fake, { data: t.storage.store })
    expect((await again.api.startUser()).user.photo).toBe(PHOTO)
  })

  it('never sends the photo to Supabase', async () => {
    photoLib.shrinkPhoto.mockReset().mockResolvedValue(PHOTO)
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const writes = t.fake.state.writes.length
    await choosePhoto(view, { type: 'image/png' })
    await until(() => avatarSrc(view) === PHOTO)
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    const sent = t.fake.state.writes.slice(writes).map((w) => JSON.stringify(w.row)).join(' ')
    expect(sent).not.toContain('base64')
    expect(t.fake.state.profiles['uid-1'].avatar_url).toBeNull()
  })

  it('removes a photo, and changes it for another one', async () => {
    photoLib.shrinkPhoto.mockReset().mockResolvedValue(OTHER)
    const t = await setUp()
    await t.store.update({ photo: PHOTO })
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    expect(avatarSrc(view)).toBe(PHOTO)
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
    await view.click('[data-testid="remove-photo"]')
    expect(avatarSrc(view)).toBe('')
    expect(view.text('.edit__upload')).toBe('Add photo')
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.store.user.photo).toBe('')
    await choosePhoto(view, { type: 'image/jpeg' })
    await until(() => avatarSrc(view) === OTHER)
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.store.user.photo).toBe(OTHER)
  })

  it('says why a picture could not be used, and keeps the photo there was', async () => {
    photoLib.shrinkPhoto.mockReset().mockRejectedValue(new Error('Choose an image file.'))
    const t = await setUp()
    await t.store.update({ photo: PHOTO })
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await choosePhoto(view, { type: 'application/pdf', name: 'cv.pdf' })
    await until(() => view.has('[data-testid="photo-error"]'))
    expect(view.text('[data-testid="photo-error"]')).toBe('Choose an image file.')
    expect(avatarSrc(view)).toBe(PHOTO)
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
    // A picture that works takes the message away.
    photoLib.shrinkPhoto.mockResolvedValue(OTHER)
    await choosePhoto(view, { type: 'image/png' })
    await until(() => avatarSrc(view) === OTHER)
    expect(view.has('[data-testid="photo-error"]')).toBe(false)
  })

  it('does nothing when the file picker is closed without a choice', async () => {
    photoLib.shrinkPhoto.mockReset()
    const t = await setUp()
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    const input = view.one('#edit-photo')
    input.files = []
    input.dispatch('change')
    await view.tick()
    expect(photoLib.shrinkPhoto).not.toHaveBeenCalled()
    expect(view.one('[data-testid="save-details"]').disabled).toBe(true)
  })

  it('works for a local account too', async () => {
    photoLib.shrinkPhoto.mockReset().mockResolvedValue(PHOTO)
    const t = await setUp({ fake: null })
    const view = await draw(t, '/profile/edit', 'EditProfileView')
    await choosePhoto(view, { type: 'image/png' })
    await until(() => avatarSrc(view) === PHOTO)
    await view.click('[data-testid="save-details"]')
    await until(() => view.has('[data-testid="details-saved"]'))
    expect(t.store.user.photo).toBe(PHOTO)
  })
})
