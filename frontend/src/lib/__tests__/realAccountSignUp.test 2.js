// What must hold where the account-from-sign-up work (the new sign-up questions, the password rule, the email check, the
// password reset) meets the signed-in-person-from-the-account work (a real account's id, its own save, no sample friends):
//  - a real account's dietary needs go to Supabase with the sign-up and are kept in its own save, under its own id, and
//    nowhere else: not under the sample person's id and not in the local save (that no read about other people asks for
//    them is held by realAccountData.test.js, which pins the columns that read asks for);
//  - the development-only made-up account signs up through the real code path under the new password rule, is not
//    "recovering" a password, and never touches the real client's `jio-auth` storage key;
//  - a real account has no sample friends, whatever the sign-up draft held.
// No network; Supabase is the stand-in in components/dev/fakeSupabase.js.
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { STORAGE_KEY, stubPlanner } from './planFixture.js'
import { PROFILE, boot, fakeSupabase } from './authFixture.js'
import { passwordRules } from '../signupRules.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), emailRegistered: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
vi.setConfig({ testTimeout: 30000 })

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
beforeEach(() => {
  stubPlanner(planner)
  planner.emailRegistered.mockReset().mockResolvedValue(false)
})
afterEach(() => vi.unstubAllGlobals())

// A password the new rule accepts, so the sign-up is not refused by the screen's own rule.
const PASSWORD = 'Sup3r-secret!'

describe("a real account's dietary needs", () => {
  it('are sent with the sign-up, saved to the account, and kept in its own save under its own id', async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    expect(passwordRules(PASSWORD).every((rule) => rule.ok)).toBe(true)
    const user = await api.signUp({ ...PROFILE, password: PASSWORD, dietary: ['vegan', 'halal'], friends: ['darius'] })
    // Sent as sign-up metadata, and written to profile_private by the stand-in's sign-up trigger.
    expect(fake.state.signUpCalls[0].options.data.dietary).toEqual(['halal', 'vegan'])
    await vi.waitFor(() => expect(fake.state.priv['uid-1'].dietary).toEqual(['halal', 'vegan']))
    // The account's id is Supabase's, never the sample person's.
    expect(user.id).toBe('uid-1')
    expect(user.id).not.toBe('ian')
    expect(user.dietary).toEqual(['halal', 'vegan'])
    // Kept in the save under the account's own key, and in no other save.
    const keys = Object.keys(storage.store).filter((k) => k.startsWith(STORAGE_KEY))
    expect(keys).toEqual([`${STORAGE_KEY}:acct:uid-1`])
    const save = JSON.parse(storage.store[keys[0]])
    expect(save.user).toMatchObject({ id: 'uid-1', authId: 'uid-1', dietary: ['halal', 'vegan'] })
    expect(storage.store[STORAGE_KEY]).toBeUndefined()
    // A real account starts with no sample friends, whatever the draft held.
    expect(save.friends).toEqual([])
  })

  it('come back from the account on a browser with no save, under the same id', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE, password: PASSWORD, dietary: ['halal'] })
    await vi.waitFor(() => expect(fake.state.priv['uid-1'].dietary).toEqual(['halal']))
    await first.api.signOut()
    // Another browser: same Supabase, empty storage.
    const second = await boot(fake)
    const user = await second.api.signIn({ email: PROFILE.email, password: PASSWORD })
    expect(user.dietary).toEqual(['halal'])
    expect(user.id).toBe('uid-1')
    expect(Object.keys(second.storage.store).filter((k) => k.startsWith(STORAGE_KEY))).toEqual([`${STORAGE_KEY}:acct:uid-1`])
  })

  it('are not the only thing that changed: the email check goes to the backend and never to the database', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    expect(await api.checkEmail('sam@example.com')).toEqual({ registered: false })
    expect(planner.emailRegistered).toHaveBeenCalledWith('sam@example.com')
    expect(fake.state.rpcCalls.map((c) => c.name)).not.toContain('email_registered')
  })
})

describe('the development-only made-up real account', () => {
  it('signs up through the real code path under the new password rule, keeps its dietary needs under its own id, is not recovering a password, and leaves the real client\'s storage alone', async () => {
    const { api, storage } = await boot(null)
    storage.store['jio-auth'] = 'a real developer session'
    const { installStandIn, MADE_UP_ACCOUNT } = await import('../../components/dev/madeUpAccount.js')
    const auth = await import('../auth.js')
    const stand = installStandIn()
    expect(passwordRules(MADE_UP_ACCOUNT.password).every((rule) => rule.ok)).toBe(true)
    const user = await api.signUp({ ...MADE_UP_ACCOUNT, dietary: ['vegetarian'] })
    expect(user.authId).toBe(user.id)
    expect(user.id).not.toBe('ian')
    expect(user.dietary).toEqual(['vegetarian'])
    await vi.waitFor(() => expect(stand.state.priv[user.id].dietary).toEqual(['vegetarian']))
    // Not a password reset: the flag is false in the module, through the data layer and in the store.
    expect(auth.recoveryPending()).toBe(false)
    expect(api.passwordRecovery()).toBe(false)
    setActivePinia(createPinia())
    const { useAuthStore } = await import('@/stores/auth.js')
    expect(useAuthStore().recovering).toBe(false)
    // Its own save under its own id; the real client's key is exactly as it was.
    expect(JSON.parse(storage.store[`${STORAGE_KEY}:acct:${user.id}`]).user.dietary).toEqual(['vegetarian'])
    expect(storage.store['jio-auth']).toBe('a real developer session')
    await api.signOut()
    expect(storage.store['jio-auth']).toBe('a real developer session')
  })
})
