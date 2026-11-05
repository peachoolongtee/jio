// The auth store on top of the real data layer and the stand-in Supabase client (authFixture.js): the password in the
// draft, the "check your email" state, sign-out that cannot fail, and the session ending on its own.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OTHER, PROFILE, boot, fakeSupabase } from './authFixture.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// A fresh store on a fresh data layer. Pinia and the store are imported after the reset so they share its modules.
async function bootStore(fake, storageOptions = {}) {
  const booted = await boot(fake, storageOptions)
  const { createPinia, setActivePinia } = await import('pinia')
  setActivePinia(createPinia())
  const { useAuthStore } = await import('@/stores/auth.js')
  return { ...booted, store: useAuthStore() }
}

const fill = (store, profile) => Object.assign(store.draft, { ...profile, step: 8 })
// Does the data layer's own sign-out reject now? (It must, for the test that uses this to mean anything.)
async function dataLayerSignOutRejects() {
  const api = await import('@/lib/api.js')
  return api.signOut().then(() => false, () => true)
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('the auth store with real accounts', () => {
  it('knows whether accounts are real, so a screen can offer sign-in', async () => {
    expect((await bootStore(null)).store.realAccounts).toBe(false)
    expect((await bootStore(fakeSupabase())).store.realAccounts).toBe(true)
  })

  it('signs up with the draft, and the draft keeps no password afterwards', async () => {
    const fake = fakeSupabase()
    const { store } = await bootStore(fake)
    fill(store, PROFILE)
    const user = await store.signUp()
    expect(user).toMatchObject({ authId: 'uid-1', name: 'Sam' })
    expect(store.signedIn).toBe(true)
    expect(fake.state.signUpCalls[0].password).toBe(PROFILE.password)
    expect(JSON.stringify(store.draft)).not.toContain(PROFILE.password)
    expect(store.user).not.toHaveProperty('syncError')
  })

  it('clears the password from the draft when sign-up fails, keeping the answers', async () => {
    const fake = fakeSupabase()
    const { store } = await bootStore(fake)
    fill(store, { ...PROFILE, password: 'weak' })
    await expect(store.signUp()).rejects.toThrow('Choose a stronger password')
    expect(store.draft.password).toBe('')
    expect(store.draft.username).toBe('sam')
    expect(store.signedIn).toBe(false)
  })

  it('exposes "check your email" after a sign-up that needs confirmation, and stays signed out', async () => {
    const fake = fakeSupabase({ confirmEmail: true })
    const { store } = await bootStore(fake)
    fill(store, PROFILE)
    expect(await store.signUp()).toBeNull()
    expect(store.pendingConfirmation).toEqual({ email: 'sam@example.com' })
    expect(store.signedIn).toBe(false)
    expect(store.draft.password).toBe('')
    store.dismissConfirmation()
    expect(store.pendingConfirmation).toBeNull()
  })

  it('shows a notice when the profile could not be written, and the person is still signed in', async () => {
    const { store } = await bootStore(fakeSupabase({ failWrites: true }))
    fill(store, PROFILE)
    await store.signUp()
    expect(store.signedIn).toBe(true)
    // The write runs after the person is in, so its failure arrives a moment later.
    await flush()
    expect(store.syncNotice).toMatch(/could not be saved to your account/)
  })

  it('signs in, and a failed sign-in leaves the store signed out with the plain message', async () => {
    const fake = fakeSupabase()
    const { store } = await bootStore(fake)
    fill(store, PROFILE)
    await store.signUp()
    await store.signOut()
    await expect(store.signIn(PROFILE.email, 'wrong-password-1')).rejects.toThrow('That email and password do not match')
    expect(store.signedIn).toBe(false)
    const user = await store.signIn(PROFILE.email, PROFILE.password)
    expect(user.authId).toBe('uid-1')
    expect(store.signedIn).toBe(true)
    expect(JSON.stringify(store.$state)).not.toContain(PROFILE.password)
  })

  it("leaves the store signed out when the data layer's signOut rejects", async () => {
    const { store, storage } = await bootStore(fakeSupabase())
    await store.signUpAs(DEMO_ACCOUNT)
    expect(store.signedIn).toBe(true)
    // The browser's storage now refuses every save, so the data layer's sign-out rejects.
    storage.limit = 10
    expect(await dataLayerSignOutRejects()).toBe(true)
    await expect(store.signOut()).resolves.toBeUndefined()
    expect(store.signedIn).toBe(false)
    expect(store.draft.password).toBe('')
  })

  it('signs out even when Supabase cannot be reached', async () => {
    const fake = fakeSupabase({ signOutMode: 'reject' })
    const { store } = await bootStore(fake)
    fill(store, PROFILE)
    await store.signUp()
    await expect(store.signOut()).resolves.toBeUndefined()
    expect(store.signedIn).toBe(false)
  })

  it('becomes signed out when the Supabase session ends on its own', async () => {
    const fake = fakeSupabase()
    const { store } = await bootStore(fake)
    fill(store, PROFILE)
    await store.signUp()
    expect(store.signedIn).toBe(true)
    fake.state.endSession()
    await flush()
    expect(store.signedIn).toBe(false)
    expect(store.user).toBeNull()
  })

  it('counts a session that ends on its own, and not a sign-out the person asked for', async () => {
    const fake = fakeSupabase()
    const { store } = await bootStore(fake)
    fill(store, PROFILE)
    await store.signUp()
    expect(store.sessionEnds).toBe(0)
    fake.state.endSession()
    await flush()
    expect(store.sessionEnds).toBe(1)
    await store.signIn(PROFILE.email, PROFILE.password)
    await store.signOut()
    await flush()
    expect(store.signedIn).toBe(false)
    expect(store.sessionEnds).toBe(1)
  })

  it('restores a real account at start-up with init(), on the same browser storage', async () => {
    const fake = fakeSupabase()
    const first = await bootStore(fake)
    fill(first.store, OTHER)
    await first.store.signUp()
    const second = await bootStore(fake, { data: first.storage.store })
    expect(second.store.signedIn).toBe(false)
    await second.store.init()
    expect(second.store.ready).toBe(true)
    expect(second.store.user).toMatchObject({ authId: 'uid-1', name: 'Kim', local: false })
  })

  it('keeps the demo account working: signUpAs and startOver make a local account, with Supabase set up', async () => {
    const fake = fakeSupabase()
    const { store } = await bootStore(fake)
    await store.signUpAs(DEMO_ACCOUNT)
    expect(store.user).toMatchObject({ local: true, demo: true, authId: null })
    await store.startOver(DEMO_ACCOUNT)
    expect(store.user).toMatchObject({ local: true, demo: true })
    expect(fake.state.signUpCalls).toEqual([])
  })

  it('updates the profile and reports a failed remote write as a notice', async () => {
    const fake = fakeSupabase()
    const { store } = await bootStore(fake)
    fill(store, PROFILE)
    await store.signUp()
    await store.update({ name: 'Sam T' })
    expect(store.user.name).toBe('Sam T')
    expect(store.syncNotice).toBe('')
    fake.state.options.failWrites = true
    await store.update({ name: 'Sam U' })
    expect(store.user.name).toBe('Sam U')
    expect(store.syncNotice).toMatch(/could not be saved to your account/)
    expect(store.user).not.toHaveProperty('syncError')
  })
})
