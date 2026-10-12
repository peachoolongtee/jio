// Real sign-up and login against a stand-in for Supabase (authFixture.js): no network, and the test runner never
// sets Supabase up by itself. "Not configured" tests prove the local accounts are untouched; the existing suites
// (accountStart, api.storage, session*.test.js, stores.test.js) prove the same by passing unchanged.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { STORAGE_KEY } from './planFixture.js'
import { OTHER, PROFILE, SESSION, boot, fakeSupabase } from './authFixture.js'
import { DEMO_ACCOUNT } from '../../components/dev/demoAccount.js'
import { AUTH_STORAGE_KEY } from '../supabase.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

const MESSAGE = (auth, code) => auth.MESSAGES[code]
const everything = (storage) => JSON.stringify(storage.store)
const acctKey = (id) => `${STORAGE_KEY}:acct:${id}`

describe('without Supabase set up (not configured)', () => {
  it('keeps local accounts exactly as they were: sign-up, getUser and sign-out', async () => {
    const { api, auth, storage } = await boot()
    expect(auth.configured()).toBe(false)
    expect(api.realAccountsOn()).toBe(false)
    expect(await api.getUser()).toBeNull()
    const user = await api.signUp({ ...PROFILE })
    expect(user).toMatchObject({ id: 'ian', name: 'Sam', username: 'sam', authId: null, local: true, email: 'sam@example.com' })
    await api.createSession(SESSION)
    expect((await api.getUser()).name).toBe('Sam')
    expect(Object.keys(storage.store)).toEqual([STORAGE_KEY])
    await api.signOut()
    expect(await api.getUser()).toBeNull()
    expect(await api.listSessions()).toEqual([])
    await expect(api.signIn({ email: PROFILE.email, password: PROFILE.password })).rejects.toThrow()
  })

  it('never writes the password to local storage', async () => {
    const { api, storage } = await boot()
    await api.signUp({ ...PROFILE })
    expect(everything(storage)).not.toContain(PROFILE.password)
  })
})

describe('a save from before this change', () => {
  // A local save with an account in it, as an earlier visit or a hand-made save would leave.
  async function localSave() {
    const first = await boot()
    await first.api.signUp({ ...PROFILE })
    await first.api.createSession(SESSION)
    const saved = first.storage.store[STORAGE_KEY]
    expect(JSON.parse(saved).version).toBe(9)
    return saved
  }

  it('still loads for a local account when Supabase is not set up', async () => {
    const saved = await localSave()
    const { api } = await boot(null, { data: { [STORAGE_KEY]: saved } })
    expect(await api.getUser()).toMatchObject({ id: 'ian', name: 'Sam', local: true, authId: null })
    expect(await api.listSessions()).toHaveLength(1)
  })

  it('still loads in a development build with Supabase set up, which keeps the demo account', async () => {
    const saved = await localSave()
    const { api } = await boot(fakeSupabase(), { data: { [STORAGE_KEY]: saved } })
    expect(await api.getUser()).toMatchObject({ id: 'ian', name: 'Sam', local: true, authId: null })
    expect(await api.listSessions()).toHaveLength(1)
  })

  it('is signed out in a production build with Supabase set up: a local account is not a login', async () => {
    const saved = await localSave()
    vi.stubEnv('DEV', false)
    const { api, storage } = await boot(fakeSupabase(), { data: { [STORAGE_KEY]: saved } })
    expect(await api.getUser()).toBeNull()
    expect(await api.listSessions()).toEqual([])
    // The save is left alone, not erased.
    expect(storage.store[STORAGE_KEY]).toBe(saved)
    // And it does not come back on a later check, nor when a real person signs up in the same browser.
    expect(await api.getUser()).toBeNull()
    await api.signUp({ ...OTHER })
    expect(await api.getUser()).toMatchObject({ authId: 'uid-1', name: 'Kim' })
    expect(storage.store[STORAGE_KEY]).toBe(saved)
  })

  it('loads again in a production build made with VITE_ALLOW_LOCAL_ACCOUNTS=1', async () => {
    const saved = await localSave()
    vi.stubEnv('DEV', false)
    vi.stubEnv('VITE_ALLOW_LOCAL_ACCOUNTS', '1')
    const { api } = await boot(fakeSupabase(), { data: { [STORAGE_KEY]: saved } })
    expect(await api.getUser()).toMatchObject({ id: 'ian', name: 'Sam', local: true, authId: null })
  })

  it('is signed out from the very first load in a production build, before anyone asks', async () => {
    const saved = await localSave()
    vi.stubEnv('DEV', false)
    // The client is set up before the data layer is loaded, as it is in a built app.
    vi.resetModules()
    vi.stubGlobal('localStorage', { getItem: (key) => (key === STORAGE_KEY ? saved : null), setItem() {}, removeItem() {} })
    const auth = await import('../auth.js')
    auth.useClient(fakeSupabase().client)
    const api = await import('../api.js')
    expect(await api.getUser()).toBeNull()
  })
})

describe('signing up for a real account', () => {
  it('sends the username, date of birth, name, home area and dietary needs in options.data, and not the photo or friends', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    await api.signUp({ ...PROFILE, name: ' Sam Tan ', dietary: ['vegan', 'paleo'], photo: 'data:image/png;base64,AAAA' })
    expect(fake.state.signUpCalls).toEqual([
      {
        email: 'sam@example.com',
        password: PROFILE.password,
        options: { data: { username: 'sam', dob: '2001-05-06', name: 'Sam Tan', home_area_id: 'tampines', dietary: ['vegan'] } },
      },
    ])
  })

  it('keeps the name, home area and dietary needs when the email must be confirmed first, and shows them at login', async () => {
    const fake = fakeSupabase({ confirmEmail: true })
    const { api } = await boot(fake)
    const result = await api.signUp({ ...PROFILE, name: 'Sam Tan', dietary: ['halal'] })
    expect(result).toEqual({ needsConfirmation: true, email: 'sam@example.com' })
    expect(fake.state.profiles['uid-1'].display_name).toBe('Sam Tan')
    expect(fake.state.priv['uid-1']).toMatchObject({ home_area_id: 'tampines', dietary: ['halal'] })
    const user = await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect(user).toMatchObject({ authId: 'uid-1', name: 'Sam Tan', homeAreaId: 'tampines', homeAreaName: 'Tampines', dietary: ['halal'] })
  })

  it('signs the person in and writes the display name and home area when a session comes back', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    const user = await api.signUp({ ...PROFILE })
    expect(user).toMatchObject({ id: 'ian', authId: 'uid-1', local: false, email: 'sam@example.com', name: 'Sam', username: 'sam', homeAreaId: 'tampines', homeAreaName: 'Tampines', syncError: '' })
    expect(fake.state.profiles['uid-1'].display_name).toBe('Sam')
    expect(fake.state.priv['uid-1'].home_area_id).toBe('tampines')
    expect(await api.getUser()).toMatchObject({ authId: 'uid-1' })
  })

  it('writes the dietary needs picked at sign-up, dropping any the database would refuse', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    const user = await api.signUp({ ...PROFILE, dietary: ['vegan', 'paleo', 'halal', 'vegan'] })
    expect(user.dietary).toEqual(['halal', 'vegan'])
    await vi.waitFor(() => expect(fake.state.priv['uid-1'].dietary).toEqual(['halal', 'vegan']))
  })

  it('writes no dietary needs when none were picked', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    const user = await api.signUp({ ...PROFILE })
    expect(user.dietary).toEqual([])
    await vi.waitFor(() => expect(fake.state.priv['uid-1'].home_area_id).toBe('tampines'))
    expect(fake.state.priv['uid-1'].dietary).toEqual([])
  })

  it('reports needsConfirmation and leaves the person signed out when no session comes back', async () => {
    const fake = fakeSupabase({ confirmEmail: true })
    const { api } = await boot(fake)
    expect(await api.signUp({ ...PROFILE })).toEqual({ needsConfirmation: true, email: 'sam@example.com' })
    expect(await api.getUser()).toBeNull()
    expect(fake.state.writes).toEqual([])
  })

  it('tells a taken username and an already registered email apart, in plain words', async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    await api.signUp({ ...PROFILE })
    await api.signOut()
    await expect(api.signUp({ ...OTHER, username: 'sam' })).rejects.toThrow(MESSAGE(auth, 'username_taken'))
    await expect(api.signUp({ ...OTHER, email: PROFILE.email })).rejects.toThrow(MESSAGE(auth, 'email_taken'))
    expect(MESSAGE(auth, 'username_taken')).toMatch(/username/)
    // The rpc said "free" but the trigger's unique violation caught it: the same message.
    fake.state.options.staleUsernameCheck = true
    await expect(api.signUp({ ...OTHER, username: 'sam' })).rejects.toThrow(MESSAGE(auth, 'username_taken'))
    // With email confirmation on, a repeat sign-up shows as a user with no identities.
    fake.state.options.confirmEmail = true
    await expect(api.signUp({ ...OTHER, email: PROFILE.email })).rejects.toThrow(MESSAGE(auth, 'email_taken'))
  })

  it('explains a weak password, too many attempts and no connection without developer text', async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    await expect(api.signUp({ ...PROFILE, password: 'weak' })).rejects.toThrow('Choose a stronger password: it is too short.')
    await expect(api.signUp({ ...PROFILE, password: 'limited' })).rejects.toThrow('Sign-ups are paused for a few minutes. Try again later.')
    fake.state.options.down = true
    await expect(api.signUp({ ...PROFILE })).rejects.toThrow(MESSAGE(auth, 'offline'))
    await expect(api.signIn({ email: PROFILE.email, password: 'x' })).rejects.toThrow(MESSAGE(auth, 'offline'))
    for (const text of Object.values(auth.MESSAGES)) expect(text).not.toMatch(/supabase|error|exception|!|undefined/i)
  })

  it('signs in at once when the display name and home area cannot be written, and says so afterwards', async () => {
    const fake = fakeSupabase({ failWrites: true })
    const { api, auth } = await boot(fake)
    const events = []
    api.subscribe((e) => events.push(e))
    const user = await api.signUp({ ...PROFILE })
    expect(user.authId).toBe('uid-1')
    expect(user.name).toBe('Sam')
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events).toContainEqual({ type: 'sync-failed', message: MESSAGE(auth, 'profile_not_saved') })
  })

  it('does not wait for the profile writes before the person is in, and writes both tables together', async () => {
    const fake = fakeSupabase({ writesHang: true })
    const { api } = await boot(fake)
    const user = await Promise.race([api.signUp({ ...PROFILE }), new Promise((resolve) => setTimeout(() => resolve('waited'), 500))])
    expect(user).toMatchObject({ authId: 'uid-1', name: 'Sam' })
    // Both writes were sent without the first having answered.
    expect(fake.state.writes.map((w) => w.table)).toEqual(['profiles', 'profile_private'])
  })

  it('checks the username once, on its own question, and not again when the account is created', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    await api.checkUsername('sam')
    await api.signUp({ ...PROFILE })
    expect(fake.state.rpcCalls).toHaveLength(1)
  })
})

describe('signing in', () => {
  it('gives one message for a wrong password and an unknown email, never saying which', async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    await api.signUp({ ...PROFILE })
    await api.signOut()
    let wrong
    let unknown
    await api.signIn({ email: PROFILE.email, password: 'nope-nope-1' }).catch((e) => (wrong = e))
    await api.signIn({ email: 'nobody@example.com', password: 'nope-nope-1' }).catch((e) => (unknown = e))
    expect(wrong.message).toBe(MESSAGE(auth, 'invalid_credentials'))
    expect(unknown.message).toBe(wrong.message)
    expect(wrong.message).not.toMatch(/exist|registered|no account/i)
    expect(await api.getUser()).toBeNull()
  })

  it("restores the account's own save, and signing out keeps it for the next sign-in", async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    const { id } = await api.createSession(SESSION)
    await api.signOut()
    expect(await api.getUser()).toBeNull()
    expect(await api.listSessions()).toEqual([])
    // The save is still there under the account's own key, and the local key was never used.
    expect(Object.keys(storage.store)).toEqual([acctKey('uid-1')])
    expect(JSON.parse(storage.store[acctKey('uid-1')]).sessions).toHaveLength(1)
    const user = await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect(user).toMatchObject({ authId: 'uid-1', name: 'Sam', homeAreaId: 'tampines' })
    expect((await api.listSessions()).map((s) => s.id)).toEqual([id])
  })

  it("starts a second account fresh, never showing it the first account's meetups", async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    await api.createSession(SESSION)
    await api.signOut()
    await api.signUp({ ...OTHER })
    expect(await api.listSessions()).toEqual([])
    await api.createSession({ ...SESSION, title: 'Sunday' })
    await api.signOut()
    await api.signIn({ email: OTHER.email, password: OTHER.password })
    expect((await api.listSessions()).map((s) => s.title)).toEqual(['Sunday'])
    await api.signOut()
    await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect((await api.listSessions()).map((s) => s.title)).toEqual(['Saturday'])
    // (The client's own session is stored beside the saves while someone is signed in.)
    expect(Object.keys(storage.store).filter((key) => key !== AUTH_STORAGE_KEY).sort()).toEqual([acctKey('uid-1'), acctKey('uid-2')])
  })

  it('starts fresh from the profile in Supabase on a browser with no save for the account', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    await first.api.signOut()
    const { api } = await boot(fake)
    const user = await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect(user).toMatchObject({ authId: 'uid-1', name: 'Sam', username: 'sam', dob: '2001-05-06', homeAreaId: 'tampines', photo: '' })
    expect(await api.listSessions()).toEqual([])
  })

  it('never shows a real account the local save, and leaves the local save alone', async () => {
    const fake = fakeSupabase()
    const local = await boot()
    await local.api.signUp({ ...DEMO_ACCOUNT })
    await local.api.createSession(SESSION)
    const localText = local.storage.store[STORAGE_KEY]
    const { api, storage } = await boot(fake, { data: { [STORAGE_KEY]: localText } })
    await api.signUp({ ...PROFILE })
    expect(await api.listSessions()).toEqual([])
    await api.signOut()
    expect(storage.store[STORAGE_KEY]).toBe(localText)
  })
})

describe('signing out', () => {
  it.each(['reject', 'throw', 'error'])("resolves when the client's signOut %s", async (mode) => {
    const fake = fakeSupabase({ signOutMode: mode })
    const { api, auth } = await boot(fake)
    await api.signUp({ ...PROFILE })
    await expect(auth.signOut()).resolves.toBeUndefined()
    await expect(api.signOut()).resolves.toBeUndefined()
    expect(fake.state.signOutCalls[0]).toEqual({ scope: 'local' })
  })
})

describe('after a reload', () => {
  it('restores a real account from the stored session, with its own save', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    const { id } = await first.api.createSession(SESSION)
    const { api } = await boot(fake, { data: first.storage.store })
    const user = await api.getUser()
    expect(user).toMatchObject({ id: 'ian', authId: 'uid-1', local: false, name: 'Sam' })
    expect((await api.listSessions()).map((s) => s.id)).toEqual([id])
  })

  it('answers nobody when the stored session has ended and the save holds no local account', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    fake.state.endSession()
    const { api } = await boot(fake, { data: first.storage.store })
    expect(await api.getUser()).toBeNull()
  })

  it('still signs in from the stored session when the profile tables cannot be read', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    fake.state.options.down = true
    // Only the client's stored session is kept: the account's own save is gone, so the profile tables are all there is.
    const { api } = await boot(fake, { data: { [AUTH_STORAGE_KEY]: first.storage.store[AUTH_STORAGE_KEY] } })
    expect(await api.getUser()).toMatchObject({ authId: 'uid-1', username: 'sam', dob: '2001-05-06' })
  })
})

describe('the date of birth of a real account', () => {
  it('is kept in memory for the visit and never written to the local save, in any account\'s save', async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    const user = await api.signUp({ ...PROFILE })
    expect(user.dob).toBe('2001-05-06')
    await api.createSession(SESSION)
    expect(JSON.parse(storage.store[acctKey('uid-1')]).user).not.toHaveProperty('dob')
    await api.updateUser({ dob: '2002-02-02', name: 'Sam T' })
    expect((await api.getUser()).dob).toBe('2002-02-02')
    await api.signOut()
    // After sign-out nothing in the browser's storage holds a date of birth, in any key.
    expect(everything(storage)).not.toMatch(/2001-05-06|2002-02-02/)
    expect(JSON.parse(storage.store[acctKey('uid-1')]).user).not.toHaveProperty('dob')
  })

  it('is read back from the account when someone logs in again, and from the session after a reload', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    // After a reload the session's sign-up details have it.
    const reloaded = await boot(fake, { data: first.storage.store })
    expect((await reloaded.api.getUser()).dob).toBe('2001-05-06')
    await reloaded.api.signOut()
    const again = await boot(fake, { data: reloaded.storage.store })
    const loggedIn = await again.api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect(loggedIn.dob).toBe('2001-05-06')
    // The client keeps its own session (which has the sign-up details) while someone is logged in; the app's saves do not.
    const saves = Object.entries(again.storage.store).filter(([key]) => key !== AUTH_STORAGE_KEY)
    expect(JSON.stringify(saves)).not.toContain('2001-05-06')
    await again.api.signOut()
    expect(everything(again.storage)).not.toContain('2001-05-06')
  })

  it('is dropped from a save an earlier version wrote, the next time it is saved', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE })
    const key = acctKey('uid-1')
    const old = JSON.parse(first.storage.store[key])
    old.user.dob = '2001-05-06'
    first.storage.store[key] = JSON.stringify(old)
    const { api, storage } = await boot(fake, { data: first.storage.store })
    await api.getUser()
    await api.createSession(SESSION)
    expect(storage.store[key]).not.toContain('2001-05-06')
  })

  it('is put back after a save that could not be written is rolled back', async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    // The browser's storage refuses this account's save, as a full one does.
    const setItem = storage.setItem.bind(storage)
    storage.setItem = (key, value) => {
      if (key.startsWith(`${STORAGE_KEY}:acct:`)) throw Object.assign(new Error('The quota has been exceeded.'), { name: 'QuotaExceededError' })
      return setItem(key, value)
    }
    await expect(api.updateUser({ name: 'Sam T' })).rejects.toThrow(/storage is full/)
    storage.setItem = setItem
    const user = await api.getUser()
    expect(user.dob).toBe('2001-05-06')
    expect(user.name).toBe('Sam')
  })

  it('is still kept in the save of a local account, as before', async () => {
    const { api, storage } = await boot()
    await api.signUp({ ...PROFILE })
    expect(JSON.parse(storage.store[STORAGE_KEY]).user.dob).toBe('2001-05-06')
  })
})

describe('the demo account', () => {
  it('is local even when Supabase is set up, and signing it out erases it as before', async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    const user = await api.signUp({ ...DEMO_ACCOUNT })
    expect(user).toMatchObject({ authId: null, local: true, demo: true })
    expect(fake.state.signUpCalls).toEqual([])
    expect(Object.keys(storage.store)).toEqual([STORAGE_KEY])
    await api.createSession(SESSION)
    await api.signOut()
    expect(await api.getUser()).toBeNull()
    expect(JSON.parse(storage.store[STORAGE_KEY])).toMatchObject({ user: null, sessions: [] })
  })

  it("replaces a real account in the same browser without touching that account's save", async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    await api.createSession(SESSION)
    const before = storage.store[acctKey('uid-1')]
    await api.signOut()
    const user = await api.signUp({ ...DEMO_ACCOUNT })
    expect(user.local).toBe(true)
    expect(storage.store[acctKey('uid-1')]).toBe(before)
    expect(JSON.parse(storage.store[STORAGE_KEY]).user.demo).toBe(true)
  })
})

describe('the password', () => {
  it('appears nowhere in local storage after sign-up, sign-in or a failed sign-up', async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    await api.signOut()
    await api.signUp({ ...OTHER, username: 'sam' }).catch(() => {})
    await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    await api.signIn({ email: PROFILE.email, password: 'wrong-password-1' }).catch(() => {})
    for (const password of [PROFILE.password, OTHER.password, 'wrong-password-1']) expect(everything(storage)).not.toContain(password)
  })
})

describe('checking a username', () => {
  it('asks the database function when Supabase is set up, and answers { available }', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    expect(await api.checkUsername('sam')).toEqual({ available: true })
    await api.signUp({ ...PROFILE })
    expect(await api.checkUsername('sam')).toEqual({ available: false })
    expect(fake.state.rpcCalls.every((c) => c.name === 'username_available')).toBe(true)
    await expect(api.checkUsername('NO')).rejects.toThrow(/Username must be/)
  })
})

describe('updating a real account', () => {
  it('writes only the columns a person may change, and keeps the photo here', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    await api.signUp({ ...PROFILE })
    fake.state.writes.length = 0
    const user = await api.updateUser({ name: 'Sam T', photo: 'data:image/png;base64,AAAA', homeAreaId: 'bishan', username: 'hacker', email: 'x@example.com', id: 'someone', authId: 'uid-9', demo: true })
    expect(user).toMatchObject({ id: 'ian', authId: 'uid-1', username: 'sam', email: 'sam@example.com', name: 'Sam T', photo: 'data:image/png;base64,AAAA', homeAreaId: 'bishan', syncError: '' })
    expect(user.demo).toBeUndefined()
    expect(fake.state.writes.map((w) => [w.table, Object.keys(w.row)])).toEqual([
      ['profiles', ['display_name']],
      ['profile_private', ['home_area_id']],
    ])
    expect(fake.state.profiles['uid-1'].display_name).toBe('Sam T')
  })

  it('writes a change to the dietary needs to Supabase', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    await api.signUp({ ...PROFILE })
    fake.state.writes.length = 0
    const user = await api.updateUser({ dietary: ['vegetarian'] })
    expect(user).toMatchObject({ dietary: ['vegetarian'], syncError: '' })
    expect(fake.state.writes.map((w) => [w.table, w.row])).toEqual([['profile_private', { dietary: ['vegetarian'] }]])
  })

  it('still succeeds here when the write to Supabase fails, and tells the caller', async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    await api.signUp({ ...PROFILE })
    fake.state.options.failWrites = true
    const user = await api.updateUser({ name: 'Sam T' })
    expect(user.name).toBe('Sam T')
    expect(user.syncError).toBe(MESSAGE(auth, 'profile_not_saved'))
    expect((await api.getUser()).name).toBe('Sam T')
  })

  it('does not call Supabase for a local account', async () => {
    const fake = fakeSupabase()
    const { api } = await boot(fake)
    await api.signUp({ ...DEMO_ACCOUNT })
    const user = await api.updateUser({ name: 'Ian T' })
    expect(user.name).toBe('Ian T')
    expect(fake.state.writes).toEqual([])
  })
})

describe('the access token', () => {
  it("answers the session's token, a fresh one on request, and null when signed out", async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    expect(await auth.accessToken()).toBeNull()
    expect(await auth.refreshedToken()).toBeNull()
    await api.signUp({ ...PROFILE })
    expect(await auth.accessToken()).toBe('token-1')
    expect(await auth.refreshedToken()).toBe('token-2')
    expect(await auth.accessToken()).toBe('token-2')
    await api.signOut()
    expect(await auth.accessToken()).toBeNull()
  })
})

describe('profile reads', () => {
  it('loads the public and private halves together', async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    await api.signUp({ ...PROFILE })
    expect(await auth.loadProfile('uid-1')).toEqual({ username: 'sam', name: 'Sam', dob: '2001-05-06', homeAreaId: 'tampines', dietary: [], avatarUrl: '' })
    expect(await auth.loadProfile('uid-404')).toBeNull()
  })

  it('brings back the dietary needs on a browser with no save for the account', async () => {
    const fake = fakeSupabase()
    const first = await boot(fake)
    await first.api.signUp({ ...PROFILE, dietary: ['halal'] })
    await vi.waitFor(() => expect(fake.state.priv['uid-1'].dietary).toEqual(['halal']))
    await first.api.signOut()
    const { api } = await boot(fake)
    const user = await api.signIn({ email: PROFILE.email, password: PROFILE.password })
    expect(user.dietary).toEqual(['halal'])
  })
})

describe('the session ending on its own', () => {
  it('signs a real account out of the data layer, keeping its save', async () => {
    const fake = fakeSupabase()
    const { api, storage } = await boot(fake)
    await api.signUp({ ...PROFILE })
    await api.createSession(SESSION)
    const events = []
    api.subscribe((e) => events.push(e))
    fake.state.endSession()
    expect(events).toEqual([{ type: 'reset', reason: 'session-ended' }])
    expect(await api.getUser()).toBeNull()
    expect(JSON.parse(storage.store[acctKey('uid-1')]).sessions).toHaveLength(1)
  })
})
