// Signing out ends this browser's session without depending on the server: a sign-out the server never answers, or
// answers with a failure, still leaves nobody signed in, and a reload (a new boot on the same storage) stays signed out.
// The stand-in keeps the session in local storage under the client's storage key and, in the failing modes, leaves it
// there, as the real client can (it only removes it after the server answered). See authFixture.js.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'
import { AUTH_STORAGE_KEY, LOGOUT_LIMIT_MS, limitLogout } from '../supabase.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

// A person signed in on a data layer whose waits are short (the real ones are two seconds and one).
// How to call: const t = await signedIn({ signOutMode: 'hang' })
async function signedIn(options = {}) {
  const fake = fakeSupabase(options)
  const booted = await boot(fake)
  booted.auth.timing.signOutMs = 40
  booted.auth.timing.confirmMs = 40
  await booted.api.signUp({ ...PROFILE })
  expect(booted.storage.store[AUTH_STORAGE_KEY]).toBeTruthy()
  return { fake, ...booted }
}

describe('the stand-in, so the tests below mean something', () => {
  it.each(['hang', 'reject', 'throw', 'error'])('leaves the stored session behind when its sign-out %s', async (mode) => {
    const { fake, storage } = await signedIn({ signOutMode: mode })
    await Promise.race([Promise.resolve().then(() => fake.client.auth.signOut({ scope: 'local' })).catch(() => {}), new Promise((resolve) => setTimeout(resolve, 30))])
    expect(storage.store[AUTH_STORAGE_KEY]).toBeTruthy()
    expect((await fake.client.auth.getSession()).data.session).toBeTruthy()
  })
})

describe('signing out when the server does not do its part', () => {
  it.each(['hang', 'reject', 'throw', 'error'])('ends the session when the sign-out %s, and a reload stays signed out', async (mode) => {
    const { fake, api, auth, storage } = await signedIn({ signOutMode: mode })
    const started = performance.now()
    await api.signOut()
    // Waited for the server at most the limit (40 ms here, about 2 s for real), then for the client's answer.
    expect(performance.now() - started).toBeLessThan(1000)
    expect(storage.store[AUTH_STORAGE_KEY]).toBeUndefined()
    expect(await auth.accessToken()).toBeNull()
    expect(await api.getUser()).toBeNull()
    // The page loads again on the same storage.
    const again = await boot(fake, { data: storage.store })
    expect(await again.api.getUser()).toBeNull()
    expect(await again.auth.accessToken()).toBeNull()
    expect(await again.auth.currentUser()).toBeNull()
  })

  it('does not wait for a server that never answers beyond the limit', async () => {
    const { auth, api } = await signedIn({ signOutMode: 'hang' })
    auth.timing.signOutMs = 150
    const started = performance.now()
    await api.signOut()
    const took = performance.now() - started
    expect(took).toBeGreaterThanOrEqual(140)
    expect(took).toBeLessThan(900)
  })

  it('tells the listeners the person is signed out even though the client never said so', async () => {
    const { auth } = await signedIn({ signOutMode: 'hang' })
    const seen = []
    const stop = auth.onChange(({ event }) => seen.push(event))
    await auth.signOut()
    expect(seen).toEqual(['signedOut'])
    stop()
  })

  it('tells them once when the client does say so', async () => {
    const { auth } = await signedIn()
    const seen = []
    const stop = auth.onChange(({ event }) => seen.push(event))
    await auth.signOut()
    expect(seen).toEqual(['signedOut'])
    stop()
  })

  it('makes the data layer let go of the account when the app signs out on its own (the planner refused the login)', async () => {
    const { api, auth } = await signedIn({ signOutMode: 'hang' })
    const events = []
    api.subscribe((e) => events.push(e))
    await auth.signOut()
    expect(events).toContainEqual({ type: 'reset', reason: 'session-ended' })
    expect(await api.getUser()).toBeNull()
  })

  it('does not say the person is signed out while the session is still there, and says so', async () => {
    const { fake, api, auth, storage } = await signedIn({ signOutMode: 'hang' })
    // Storage refuses the removal, and the client still reports the session.
    storage.removeItem = () => {
      throw new Error('denied')
    }
    const err = await api.signOut().catch((e) => e)
    expect(err.code).toBe('sign_out_failed')
    expect(err.message).toBe(auth.MESSAGES.sign_out_failed)
    expect(await api.getUser()).toMatchObject({ authId: 'uid-1' })
    expect(fake.state.session).toBeTruthy()
  })

  it('leaves the store signed in and rejects with that message, so the profile dialog can show it', async () => {
    const fake = fakeSupabase({ signOutMode: 'hang' })
    const booted = await boot(fake)
    booted.auth.timing.signOutMs = 30
    booted.auth.timing.confirmMs = 30
    const { createPinia, setActivePinia } = await import('pinia')
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    const store = useAuthStore()
    Object.assign(store.draft, { ...PROFILE, step: 7 })
    await store.signUp()
    const removeItem = booted.storage.removeItem
    booted.storage.removeItem = () => {
      throw new Error('denied')
    }
    await expect(store.signOut()).rejects.toMatchObject({ code: 'sign_out_failed' })
    expect(store.signedIn).toBe(true)
    // Once storage lets go, it works.
    booted.storage.removeItem = removeItem
    await expect(store.signOut()).resolves.toBeUndefined()
    expect(store.signedIn).toBe(false)
  })

  it('is quick for a server that answers: the client ends the session itself and nothing waits', async () => {
    const { auth, storage } = await signedIn()
    auth.timing.signOutMs = 5000
    const started = performance.now()
    await auth.signOut()
    expect(performance.now() - started).toBeLessThan(500)
    expect(storage.store[AUTH_STORAGE_KEY]).toBeUndefined()
  })
})

describe('the sign-out request itself', () => {
  const LOGOUT = 'https://abc.supabase.example/auth/v1/logout?scope=local'

  it('is cancelled after the limit, so it cannot finish later and end a session started in the meantime', async () => {
    const inner = vi.fn((_url, init) => new Promise((_resolve, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))))
    const started = performance.now()
    await expect(limitLogout(inner, 40)(LOGOUT, { method: 'POST' })).rejects.toThrow('aborted')
    expect(performance.now() - started).toBeLessThan(1000)
    expect(inner).toHaveBeenCalledTimes(1)
  })

  it('leaves every other request untouched, and an answer in time is passed on', async () => {
    const inner = vi.fn(async () => 'answer')
    const init = { method: 'POST', body: '{}' }
    expect(await limitLogout(inner, 40)('https://abc.supabase.example/auth/v1/token?grant_type=refresh_token', init)).toBe('answer')
    expect(inner).toHaveBeenCalledWith('https://abc.supabase.example/auth/v1/token?grant_type=refresh_token', init)
    expect(await limitLogout(inner, 40)(LOGOUT, init)).toBe('answer')
    expect(LOGOUT_LIMIT_MS).toBe(2000)
  })
})
