// "Any dietary needs?" (ticket #107): not a question in sign-up, but a popup asked once, right after the account is made
// (auth.signUp, components/event/DietaryFirstAsk.vue). The answer is saved on the profile; answered or skipped, it closes for
// good, and nothing else opens it.
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import { loadApi } from './planFixture.js'
import { mountScreen } from './domless.js'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

vi.setConfig({ testTimeout: 20000 })
afterAll(() => vi.unstubAllGlobals())
afterEach(() => vi.unstubAllGlobals())

// A local account's sign-up draft, filled in, with the auth and events stores. How to call: const { auth } = await fresh()
async function fresh() {
  await loadApi()
  const { createPinia, setActivePinia } = await import('pinia')
  const pinia = createPinia()
  setActivePinia(pinia)
  const { useAuthStore } = await import('@/stores/auth.js')
  const { useEventsStore } = await import('@/stores/events.js')
  const auth = useAuthStore()
  Object.assign(auth.draft, { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  return { auth, events: useEventsStore(), pinia }
}

describe('the dietary popup after sign-up', () => {
  it('opens once the account is made, saves the answer on the profile, and does not open again', async () => {
    const { auth, events } = await fresh()
    expect(auth.dietAsk).toBe(false)
    await auth.signUp()
    expect(auth.dietAsk).toBe(true)
    await auth.answerDietAsk(['halal'])
    expect(auth.dietAsk).toBe(false)
    expect(auth.user.dietary).toEqual(['halal'])
    // Tomorrow in Singapore, so the session's day has not passed whenever the test runs (the past-day rule holds on every path).
    const tomorrow = new Date(Date.now() + 24 * 60 * 60 * 1000).toLocaleDateString('en-CA', { timeZone: 'Asia/Singapore' })
    await events.create({ title: 'Saturday', date: tomorrow, start: '12:00', end: '20:00' })
    expect(auth.dietAsk).toBe(false)
  })

  it('can be skipped, which leaves the profile with no needs', async () => {
    const { auth } = await fresh()
    await auth.signUp()
    await auth.answerDietAsk([])
    expect(auth.dietAsk).toBe(false)
    expect(auth.user.dietary).toEqual([])
  })

  it('is a popup with the three needs, saved with Save and skipped with "None, skip"', async () => {
    const { auth, pinia } = await fresh()
    const { default: DietaryFirstAsk } = await import('@/components/event/DietaryFirstAsk.vue')
    const view = await mountScreen(DietaryFirstAsk, { plugins: [pinia] })
    expect(view.has('[data-testid="diet-first-ask"]')).toBe(false)
    await auth.signUp()
    await view.tick()
    expect(view.text('h2')).toBe('Any dietary needs?')
    const chip = (name) => view.all('button').find((b) => b.attrs['aria-pressed'] !== undefined && view.text(b) === name)
    expect(['Halal', 'Vegetarian', 'Vegan'].every((name) => chip(name))).toBe(true)
    expect(view.text('[data-testid="diet-first-save"]')).toBe('None, skip')
    await view.click(chip('Vegetarian'))
    expect(view.text('[data-testid="diet-first-save"]')).toBe('Save')
    await view.click('[data-testid="diet-first-save"]')
    await vi.waitFor(() => expect(auth.dietAsk).toBe(false))
    await view.tick()
    expect(auth.user.dietary).toEqual(['vegetarian'])
    expect(view.has('[data-testid="diet-first-ask"]')).toBe(false)
  })
})

// A real account (the stand-in Supabase client): the question is asked once per account, whatever the way in, and a reload keeps
// it until it is answered.
describe('the dietary question for a real account', () => {
  // A page load on the given browser storage: a fresh auth store, started as the app starts. How to call: const page = await load(fake, previous?.storage.store)
  async function load(fake, data = {}) {
    const booted = await boot(fake, { data })
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    return { ...booted, store: useAuthStore() }
  }

  it('is kept by a reload until it is answered, then never asked again', async () => {
    const fake = fakeSupabase()
    const first = await load(fake)
    Object.assign(first.store.draft, { ...PROFILE, step: 8 })
    await first.store.signUp()
    expect(first.store.dietAsk).toBe(true)

    // Reloaded before answering: asked again.
    const second = await load(fake, first.storage.store)
    expect(second.store.dietAsk).toBe(false)
    await second.store.init()
    expect(second.store.signedIn).toBe(true)
    expect(second.store.dietAsk).toBe(true)

    // Skipped: remembered for this account, so the next reload does not ask.
    await second.store.answerDietAsk([])
    expect(second.store.dietAsk).toBe(false)
    const third = await load(fake, second.storage.store)
    await third.store.init()
    expect(third.store.signedIn).toBe(true)
    expect(third.store.dietAsk).toBe(false)
  })

  it('asks an account that signs in for the first time, and not one that has a need saved', async () => {
    const fake = fakeSupabase()
    const made = await load(fake)
    Object.assign(made.store.draft, { ...PROFILE, step: 8 })
    await made.store.signUp()
    await made.store.signOut()

    // A different browser, with no memory of the account: signing in asks.
    const elsewhere = await load(fake)
    await elsewhere.store.signIn(PROFILE.email, PROFILE.password)
    expect(elsewhere.store.dietAsk).toBe(true)
    await elsewhere.store.answerDietAsk(['halal'])
    expect(elsewhere.store.user.dietary).toEqual(['halal'])
    await elsewhere.store.signOut()

    // Yet another browser: the need is saved on the account, so the account has been asked.
    const another = await load(fake)
    await another.store.signIn(PROFILE.email, PROFILE.password)
    expect(another.store.user.dietary).toEqual(['halal'])
    expect(another.store.dietAsk).toBe(false)
  })

  it('does not break when the browser will not remember: it asks again, and answering still works', async () => {
    const fake = fakeSupabase()
    const first = await load(fake)
    Object.assign(first.store.draft, { ...PROFILE, step: 8 })
    await first.store.signUp()
    const page = await load(fake, first.storage.store)
    // Only the note that the question was asked is refused; the login still reads and writes.
    const guarded = (method) => (key, ...rest) => {
      if (String(key).startsWith('jio-diet-asked')) throw new Error('denied')
      return page.storage[method](key, ...rest)
    }
    vi.stubGlobal('localStorage', { ...page.storage, getItem: guarded('getItem'), setItem: guarded('setItem') })
    await page.store.init()
    expect(page.store.dietAsk).toBe(true)
    await expect(page.store.answerDietAsk([])).resolves.toBeUndefined()
    expect(page.store.dietAsk).toBe(false)
  })
})
