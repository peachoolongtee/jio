// The sign-up screen (views/AuthView.vue) with real accounts: the password goes to the store, is empty after a failed
// attempt while the other answers stay, "Check your email" replaces the questions when the project wants the email
// confirmed, and the rule on screen is the one Supabase enforces. Drawn on the in-memory page (domless.js).
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'
import { mountScreen, until } from './domless.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), emailRegistered: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// The development-only demo buttons are not under test, and they load the showcase.
vi.mock('@/components/dev/DemoSignIn.vue', () => ({ default: { render: () => null } }))

// Drawing a screen compiles its templates the first time, which is slow on a busy machine.
vi.setConfig({ testTimeout: 20000 })

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())
// The backend's email check says nobody has an account unless a test makes it say otherwise.
beforeEach(() => {
  planner.emailRegistered.mockReset().mockResolvedValue(false)
})

// The sign-up screen with the draft filled in and on the last question. `fake` null means local accounts only.
// How to call: const t = await setUp(fakeSupabase(), { password: 'weak' })
async function setUp(fake, draft = {}) {
  await boot(fake)
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const store = useAuthStore()
  Object.assign(store.draft, { ...PROFILE, step: 8, ...draft })
  const { routes } = await import('@/router/routes.js')
  const stub = { render: () => null }
  const router = createRouter({ history: createMemoryHistory(), routes: routes.map((r) => ({ ...r, component: stub })) })
  await router.push('/signup')
  const { default: AuthView } = await import('@/views/AuthView.vue')
  const view = await mountScreen(AuthView, { plugins: [pinia, router] })
  await until(() => store.draft.step === (draft.step ?? 8))
  return { fake, store, router, view }
}

// The main button (the "next" pill) of the screen.
const mainButton = (view) => view.all('button').find((b) => (b.attrs.class || '').includes('btn--next'))

describe('the password rule on screen', () => {
  it('asks real accounts for 8 to 72 characters with an uppercase and a lowercase letter, a number and a symbol, and keeps the older checklist otherwise', async () => {
    const { passwordChecks } = await import('@/views/AuthView.vue')
    const labels = ['8 or more characters', 'An uppercase letter', 'A lowercase letter', 'A number', 'A symbol', 'No more than 72 characters, and no space at the start or end']
    expect(passwordChecks('abc1!', true).map((c) => [c.label, c.ok])).toEqual([
      [labels[0], false],
      [labels[1], false],
      [labels[2], true],
      [labels[3], true],
      [labels[4], true],
      [labels[5], true],
    ])
    expect(passwordChecks('Abc1!xyz', true).every((c) => c.ok)).toBe(true)
    // What a password manager makes: a dash, an underscore and a question mark are symbols.
    expect(passwordChecks('Zx9-qL_mW?4k', true).every((c) => c.ok)).toBe(true)
    expect(passwordChecks('abcdef', false).map((c) => c.label)).toEqual(['8 or more characters', 'A letter', 'A number', 'A symbol'])
  })

  it('draws that rule on the password question and lets a password through only when every part is met', async () => {
    const { view, store } = await setUp(fakeSupabase(), { step: 1, password: 'abc1!x' })
    expect(view.all('.checklist__item')).toHaveLength(6)
    expect(view.all('.checklist__hint').map((h) => view.text(h))).toEqual([
      'Any character that is not a letter, number or space, like - _ ? ! @ #',
      'Accented letters and emoji take more room. Control characters are not allowed.',
    ])
    expect(view.one('input[autocomplete=new-password]')).toBeTruthy()
    await view.click(mainButton(view))
    expect(store.draft.step).toBe(1)
    view.type('input[autocomplete=new-password]', 'Abc1!xyz')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 2)
  })

  it('draws the four-part checklist for local accounts', async () => {
    const { view } = await setUp(null, { step: 1, password: '' })
    expect(view.all('.checklist__item')).toHaveLength(4)
  })
})

describe('the first question', () => {
  it('offers a way to log in when accounts are real, and not otherwise', async () => {
    const real = await setUp(fakeSupabase(), { step: 0 })
    expect(real.view.one('a[href="/login"]')).toBeTruthy()
    expect(real.view.text()).toContain('Already have an account?')
    const local = await setUp(null, { step: 0 })
    expect(local.view.has('a[href="/login"]')).toBe(false)
  })
})

describe('a failed sign-up', () => {
  it('goes back to the password with the other answers kept, an empty field and the reason shown', async () => {
    const { view, store, fake } = await setUp(fakeSupabase(), { password: 'weak' })
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
    expect(fake.state.signUpCalls[0].password).toBe('weak')
    expect(store.draft.password).toBe('')
    expect(view.one('input[autocomplete=new-password]').value).toBe('')
    expect(view.text('h1')).toBe('Create a password')
    expect(view.text('[data-testid=signup-error]')).toBe('Choose a stronger password: it is too short.')
    expect(view.text()).toContain('Enter your password again.')
    expect(store.draft).toMatchObject({ email: PROFILE.email, name: 'Sam', username: 'sam', dob: PROFILE.dob, homeAreaId: 'tampines' })
    expect(view.errors).toEqual([])
  })

  it('asks for the password again before it tries again, then goes straight to the last question', async () => {
    const { view, store, fake } = await setUp(fakeSupabase(), { password: 'weak' })
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
    view.type('input[autocomplete=new-password]', 'Sup3rSecret!')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 8)
    expect(fake.state.signUpCalls).toHaveLength(1)
    await view.click(mainButton(view))
    await until(() => store.signedIn)
    expect(fake.state.signUpCalls).toHaveLength(2)
    expect(fake.state.signUpCalls[1].password).toBe('Sup3rSecret!')
  })

  it('does not send an empty password: pressing Finish with none goes to the password question', async () => {
    const { view, store, fake } = await setUp(fakeSupabase(), { password: '' })
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
    expect(fake.state.signUpCalls).toHaveLength(0)
    expect(view.text()).toContain('Enter your password again.')
  })

  it('shows a taken username under the username question', async () => {
    const fake = fakeSupabase({ staleUsernameCheck: true })
    const { view, store } = await setUp(fake)
    // Someone else holds the name.
    fake.state.profiles.other = { username: PROFILE.username }
    await view.click(mainButton(view))
    await until(() => store.draft.step === 4)
    expect(view.text()).toContain('That username is taken. Choose another one.')
    expect(store.draft.password).toBe('')
  })

  it('sends an email that is already registered back to the email question, with a way to log in', async () => {
    const fake = fakeSupabase()
    fake.state.users.push({ id: 'uid-9', email: PROFILE.email, password: 'x', meta: {} })
    const { view, store } = await setUp(fake)
    await view.click(mainButton(view))
    await until(() => store.draft.step === 0)
    expect(view.text()).toContain('An account with that email already exists. Log in instead.')
    expect(view.one('a[href="/login"]')).toBeTruthy()
  })
})

describe('a sign-up that needs the email confirmed', () => {
  it('shows "Check your email" with the address and a way on to /login, then goes back to the first question', async () => {
    const { view, store } = await setUp(fakeSupabase({ confirmEmail: true }))
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid=check-email]'))
    expect(view.text('h1')).toBe('Check your email')
    expect(view.text('[data-testid=check-email]')).toContain(`We sent a link to ${PROFILE.email}.`)
    expect(view.one('a[href="/login"]')).toBeTruthy()
    expect(view.has('[data-testid=auth-view]')).toBe(false)
    expect(store.signedIn).toBe(false)
    expect(store.draft.password).toBe('')
    // "Use a different email" goes back to the first question.
    const other = view.all('button').find((b) => b.children.some((c) => c.text === 'Use a different email'))
    await view.click(other)
    await until(() => view.has('[data-testid=auth-view]'))
    expect(store.pendingConfirmation).toBeNull()
    expect(view.text('h1')).toBe('Your email')
  })
})

describe('local accounts', () => {
  it('still finish sign-up without a password and go Home', async () => {
    const { view, store, router } = await setUp(null, { password: '' })
    await view.click(mainButton(view))
    await until(() => store.signedIn)
    await until(() => router.currentRoute.value.name === 'home')
    expect(store.user.local).toBe(true)
  })
})

describe('the username question when the check cannot be made', () => {
  const UNCHECKED = 'Could not check that username right now. Press Next to carry on; it is checked again when you sign up.'

  it.each([
    ['Supabase is unreachable', { down: true }],
    ['the function answers a 500', { rpcError: { message: 'boom', code: 'XX000', details: '', hint: '' } }],
  ])('shows a message under the field and lets Next work again, then goes on, when %s', async (_name, options) => {
    const { view, store, fake } = await setUp(fakeSupabase(options), { step: 4 })
    await view.click(mainButton(view))
    await until(() => view.text().includes(UNCHECKED))
    // Still on the question, with the message under the username field, and the button usable again.
    expect(store.draft.step).toBe(4)
    expect(view.text('h1')).toBe('Pick a username')
    expect(view.text('p[role=alert]')).toBe(UNCHECKED)
    expect(mainButton(view).disabled).toBe(false)
    expect(view.text(mainButton(view))).toContain('Next')
    // The next press goes on without asking again.
    await view.click(mainButton(view))
    await until(() => store.draft.step === 5)
    expect(fake.state.rpcCalls).toHaveLength(1)
  })

  it('checks again when the username is changed', async () => {
    const { view, store, fake } = await setUp(fakeSupabase({ down: true }), { step: 4 })
    await view.click(mainButton(view))
    await until(() => view.text().includes(UNCHECKED))
    view.type('input[autocomplete=nickname]', 'samuel')
    await view.tick()
    expect(view.has('p[role=alert]')).toBe(false)
    fake.state.options.down = false
    await view.click(mainButton(view))
    await until(() => store.draft.step === 5)
    expect(fake.state.rpcCalls).toHaveLength(2)
  })

  it('says a taken username is taken, and does not go on', async () => {
    const fake = fakeSupabase()
    fake.state.profiles.other = { username: PROFILE.username }
    const { view, store } = await setUp(fake, { step: 4 })
    await view.click(mainButton(view))
    await until(() => view.text().includes('That username is taken. Try another one.'))
    expect(store.draft.step).toBe(4)
    expect(mainButton(view).disabled).toBe(false)
  })

  it('says what the button is doing while it checks, and does not offer the browser the saved email', async () => {
    const { view, fake, store } = await setUp(fakeSupabase(), { step: 4 })
    expect(view.has('input[autocomplete=username]')).toBe(false)
    expect(view.one('input[autocomplete=nickname]')).toBeTruthy()
    let answer
    fake.client.rpc = () => new Promise((resolve) => (answer = resolve))
    await view.click(mainButton(view))
    expect(view.text(mainButton(view))).toContain('Checking username')
    expect(mainButton(view).disabled).toBe(true)
    expect(view.text('[role=status]')).toBe('Checking username')
    await until(() => answer)
    answer({ data: true, error: null })
    await until(() => store.draft.step === 5)
    expect(view.has('[role=status]')).toBe(false)
  })
})

describe('creating the account', () => {
  it('says so on the button while it waits, and the button cannot be pressed twice', async () => {
    const { view, store, fake } = await setUp(fakeSupabase())
    let answer
    const real = fake.client.auth.signUp
    fake.client.auth.signUp = (args) => new Promise((resolve) => (answer = () => resolve(real(args))))
    await view.click(mainButton(view))
    await until(() => view.text(mainButton(view)).includes('Creating your account'))
    expect(mainButton(view).disabled).toBe(true)
    await view.click(mainButton(view))
    await until(() => answer)
    answer()
    await until(() => store.signedIn)
    expect(fake.state.signUpCalls).toHaveLength(1)
  })

  it('does not wait for the profile writes: the person is in while they have not answered', async () => {
    const { view, store, router } = await setUp(fakeSupabase({ writesHang: true }))
    await view.click(mainButton(view))
    await until(() => store.signedIn)
    await until(() => router.currentRoute.value.name === 'home')
  })

  it('tells the person afterwards that the profile could not be saved to the account', async () => {
    const { view, store } = await setUp(fakeSupabase({ failWrites: true }))
    await view.click(mainButton(view))
    await until(() => store.signedIn)
    await until(() => store.syncNotice !== '')
    expect(store.syncNotice).toMatch(/could not be saved to your account/)
  })

  it('does not send the person to the username when the server failed for another reason: "something went wrong", on the password step', async () => {
    const { view, store, fake } = await setUp(fakeSupabase({ breakTrigger: true }))
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
    expect(view.text('[data-testid=signup-error]')).toBe('Something went wrong. Try again.')
    expect(view.text()).not.toMatch(/username is taken|Could not reach Jio/)
    expect(store.draft.password).toBe('')
    expect(store.draft.username).toBe('sam')
    // It asked once whether the username was taken, and was told it was free.
    expect(fake.state.rpcCalls).toHaveLength(1)
  })

  it('sends a taken username, found when the account was created, to the username question', async () => {
    const fake = fakeSupabase({ staleUsernameCheck: true })
    fake.state.profiles.other = { username: PROFILE.username }
    const { view, store } = await setUp(fake)
    await view.click(mainButton(view))
    await until(() => store.draft.step === 4)
    expect(view.text()).toContain('That username is taken. Choose another one.')
    expect(view.text()).not.toMatch(/Could not reach Jio/)
  })

  it('sends a refused email address back to the email question with an email message', async () => {
    const { view, store } = await setUp(fakeSupabase({ signUpError: { name: 'AuthApiError', status: 422, code: 'email_address_invalid', message: 'bad' } }))
    await view.click(mainButton(view))
    await until(() => store.draft.step === 0)
    expect(view.text()).toContain('That email address does not look right. Check it and try again.')
    expect(view.text('h1')).toBe('Your email')
  })

  it('the password step offers Show and Hide with its words only', async () => {
    const { view } = await setUp(fakeSupabase(), { step: 1 })
    const peek = view.all('button').find((b) => ['Show', 'Hide'].includes(view.text(b)))
    expect(peek.attrs['aria-pressed']).toBeUndefined()
    await view.click(peek)
    expect(view.text(peek)).toBe('Hide')
  })
})

describe('the dietary question', () => {
  it('comes after the home area, offers halal, vegetarian and vegan, and can be skipped', async () => {
    const { view, store } = await setUp(fakeSupabase(), { step: 7, dietary: [] })
    expect(view.text('h1')).toBe('Dietary needs')
    const chips = view.all('button').filter((b) => ['Halal', 'Vegetarian', 'Vegan'].includes(view.text(b)))
    expect(chips.map((b) => view.text(b))).toEqual(['Halal', 'Vegetarian', 'Vegan'])
    expect(view.text(mainButton(view))).toContain('None, skip')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 8)
    expect(store.draft.dietary).toEqual([])
  })

  it('picks and unpicks any number of needs, and sends them with the sign-up', async () => {
    const { view, store, fake } = await setUp(fakeSupabase(), { step: 7, dietary: [] })
    const chip = (label) => view.all('button').find((b) => view.text(b) === label)
    await view.click(chip('Halal'))
    await view.click(chip('Vegan'))
    await view.click(chip('Vegan'))
    await view.click(chip('Vegetarian'))
    expect(store.draft.dietary).toEqual(['halal', 'vegetarian'])
    expect(view.text(mainButton(view))).not.toContain('skip')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 8)
    await view.click(mainButton(view))
    await until(() => store.signedIn)
    expect(store.user.dietary).toEqual(['halal', 'vegetarian'])
    await until(() => fake.state.priv['uid-1'].dietary.length === 2)
  })
})

describe('the email question', () => {
  it('does not move on from an address that is not one, and says why once the field is left', async () => {
    const { view, store } = await setUp(fakeSupabase(), { step: 0, email: '' })
    for (const bad of ['sam', 'sam@', 'sam@example', 'sam@example.c', 'sam@@example.com', 'sam..tan@example.com', 'sam @example.com']) {
      view.type('input[type=email]', bad)
      await view.click(mainButton(view))
      expect(store.draft.step).toBe(0)
    }
    view.one('input[type=email]').dispatch('blur')
    await view.tick()
    expect(view.text()).toContain('Enter a valid email address, like name@example.com.')
    view.type('input[type=email]', 'sam.tan@example.com.sg')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
  })
})

describe('the date of birth question', () => {
  it('takes the date as DD/MM/YYYY, puts the slashes in, and keeps YYYY-MM-DD in the draft', async () => {
    const { view, store } = await setUp(fakeSupabase(), { step: 3, dob: '' })
    expect(view.one('input[inputmode=numeric]').attrs.placeholder).toBe('DD/MM/YYYY')
    view.type('input[inputmode=numeric]', '1803')
    await view.tick()
    expect(view.one('input[inputmode=numeric]').value).toBe('18/03')
    expect(store.draft.dob).toBe('')
    view.type('input[inputmode=numeric]', '18/03/2004')
    await view.tick()
    expect(store.draft.dob).toBe('2004-03-18')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 4)
  })

  it('shows an answered date as DD/MM/YYYY, and refuses a date that does not exist', async () => {
    const { view, store } = await setUp(fakeSupabase(), { step: 3, dob: '2001-05-06' })
    expect(view.one('input[inputmode=numeric]').value).toBe('06/05/2001')
    view.type('input[inputmode=numeric]', '31022004')
    await view.tick()
    expect(view.text()).toContain('That date does not exist.')
    await view.click(mainButton(view))
    expect(store.draft.step).toBe(3)
  })
})

describe('an email that already has an account', () => {
  // A sign-up screen on the first question, on a project where PROFILE's email is already registered.
  // How to call: const t = await registeredSetUp()
  async function registeredSetUp(options = {}) {
    const fake = fakeSupabase(options)
    fake.state.users.push({ id: 'uid-9', email: PROFILE.email, password: 'x', meta: {} })
    planner.emailRegistered.mockImplementation(async (email) => fake.state.emailRegistered(email))
    return setUp(fake, { step: 0 })
  }

  it('is told on the email question, when Enter is pressed, with the Log in link beside it', async () => {
    const { view, store, fake } = await registeredSetUp()
    view.type('input[type=email]', 'SAM@example.com ')
    await view.enter('input[type=email]')
    await until(() => view.text().includes('An account with that email already exists. Log in instead.'))
    expect(store.draft.step).toBe(0)
    expect(view.one('a[href="/login"]')).toBeTruthy()
    // It asked the backend (once, with the address trimmed), and never the database itself: the browser's key may not call it.
    expect(planner.emailRegistered.mock.calls).toEqual([['SAM@example.com']])
    expect(fake.state.rpcCalls.filter((c) => c.name === 'email_registered')).toEqual([])
    expect(fake.state.signUpCalls).toEqual([])
  })

  it('lets a new email through to the password question', async () => {
    const { view, store } = await registeredSetUp()
    view.type('input[type=email]', 'new@example.com')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
  })

  it.each([
    ['the backend says too many requests (429)', 'Too many requests. Wait a few seconds and try again.'],
    ['the backend or database is down (503)', 'Accounts cannot be checked right now. Try again shortly.'],
    ['there is no connection', 'Cannot reach the Jio planner right now. Check your connection and try again.'],
    ['the backend sends something unreadable', 'The planner sent an answer Jio could not read. Try again later.'],
  ])('goes on when the check cannot be made because %s, leaving the sign-up to catch it at the end', async (_name, message) => {
    const { view, store } = await registeredSetUp()
    planner.emailRegistered.mockImplementation(async () => {
      throw new Error(message)
    })
    view.type('input[type=email]', PROFILE.email)
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
    expect(view.text()).not.toContain('already exists')
    expect(view.has('p[role=alert]')).toBe(false)
  })

  it('clears the message once the email is changed', async () => {
    const { view } = await registeredSetUp()
    view.type('input[type=email]', PROFILE.email)
    await view.click(mainButton(view))
    await until(() => view.text().includes('already exists'))
    view.type('input[type=email]', 'other@example.com')
    await view.tick()
    expect(view.text()).not.toContain('already exists')
  })
})

describe('suggestions for a taken username', () => {
  it('offers up to 3 free names counting up from the taken one, and leaves out names that are also taken', async () => {
    const fake = fakeSupabase()
    fake.state.profiles.a = { username: 'testuser_887' }
    fake.state.profiles.b = { username: 'testuser_889' }
    const { view, store } = await setUp(fake, { step: 4, username: 'testuser_887' })
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="username-suggestions"]'))
    const chips = view.all('button.signup__suggestion').map((b) => view.text(b))
    expect(chips).toHaveLength(3)
    expect(chips[0]).toBe('testuser_888')
    expect(chips).not.toContain('testuser_889')
    expect(chips.every((c) => /^testuser_\d+$/.test(c))).toBe(true)
    expect(store.draft.step).toBe(4)
  })

  it('checks no more than 4 names, and stops asking once 3 are free', async () => {
    // Everything free: the first three are enough, so only three are asked (and the taken name was asked once before).
    const fake = fakeSupabase()
    fake.state.profiles.other = { username: PROFILE.username }
    const first = await setUp(fake, { step: 4 })
    await first.view.click(mainButton(first.view))
    await until(() => first.view.has('[data-testid="username-suggestions"]'))
    expect(fake.state.rpcCalls.map((c) => c.args.p_username)).toHaveLength(1 + 3)
    expect(first.view.all('button.signup__suggestion')).toHaveLength(3)
  })

  it('asks for a fourth name only when one of the first three is taken, and never for a fifth', async () => {
    const fake = fakeSupabase()
    // The taken name, and every name the screen could suggest except the last one tried: nearly all taken.
    for (const n of [1, 2]) fake.state.profiles[`t${n}`] = { username: `sam_${n}` }
    fake.state.profiles.me = { username: 'sam' }
    const { view } = await setUp(fake, { step: 4 })
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="username-suggestions"]'))
    const asked = fake.state.rpcCalls.map((c) => c.args.p_username)
    // The taken name itself, then three names, then the one name still needed: five calls in all, four of them suggestions.
    expect(asked).toHaveLength(1 + 4)
    expect(asked.slice(1, 3)).toEqual(['sam_1', 'sam_2'])
    expect(view.all('button.signup__suggestion')).toHaveLength(2)
  })

  it('fills the field with the one tapped, clears the message, and goes on with it', async () => {
    const fake = fakeSupabase()
    fake.state.profiles.other = { username: PROFILE.username }
    const { view, store } = await setUp(fake, { step: 4 })
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="username-suggestions"]'))
    const first = view.all('button.signup__suggestion')[0]
    expect(view.text(first)).toBe('sam_1')
    await view.click(first)
    expect(store.draft.username).toBe('sam_1')
    expect(view.text()).not.toContain('That username is taken')
    expect(view.has('[data-testid="username-suggestions"]')).toBe(false)
    await view.click(mainButton(view))
    await until(() => store.draft.step === 5)
  })

  it('offers nothing when a free name is checked', async () => {
    const { view, store } = await setUp(fakeSupabase(), { step: 4 })
    await view.click(mainButton(view))
    await until(() => store.draft.step === 5)
    expect(view.has('[data-testid="username-suggestions"]')).toBe(false)
  })
})

describe('a sign-up refused for being over a limit', () => {
  it('stays on the last question with "Sign-ups are paused" above the button, not on the password', async () => {
    const { view, store } = await setUp(fakeSupabase(), { password: 'limited' })
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="signup-error"]'))
    expect(view.text('[data-testid="signup-error"]')).toBe('Sign-ups are paused for a few minutes. Try again later.')
    expect(store.draft.step).toBe(8)
    expect(view.text()).not.toContain('Enter your password again.')
  })

  it('asks for the password once on the next try, then comes straight back to the last question', async () => {
    const { view, store, fake } = await setUp(fakeSupabase(), { password: 'limited' })
    await view.click(mainButton(view))
    await until(() => view.has('[data-testid="signup-error"]'))
    await view.click(mainButton(view))
    await until(() => store.draft.step === 1)
    view.type('input[autocomplete=new-password]', 'Sup3rSecret!')
    await view.click(mainButton(view))
    await until(() => store.draft.step === 8)
    await view.click(mainButton(view))
    await until(() => store.signedIn)
    expect(fake.state.signUpCalls).toHaveLength(2)
  })
})
