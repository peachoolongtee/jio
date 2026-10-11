// What a failed sign-up or login says: a server error is told apart from a lost connection by its status and name, a
// taken username is only reported when the database says so, and a validation failure is never a wrong password. The
// stand-in answers the way the installed auth client does (see authFixture.js): a lost connection is an
// AuthRetryableFetchError with status 0, and an HTTP 500 is the same class with status 500.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OTHER, PROFILE, boot, fakeSupabase } from './authFixture.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const failure = (promise) => promise.then(() => null, (err) => err)
const apiError = (status, code, message) => ({ name: 'AuthApiError', status, code, message })

describe('a sign-up the server answered with an error', () => {
  it('says the username is taken when the trigger failed and the database now says it is taken', async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    fake.state.profiles.other = { username: PROFILE.username }
    const err = await failure(api.signUp({ ...PROFILE }))
    expect(err.code).toBe('username_taken')
    expect(err.message).toBe(auth.MESSAGES.username_taken)
    // It asked the database once, after the failure.
    expect(fake.state.rpcCalls).toHaveLength(1)
    expect(fake.state.signUpCalls).toHaveLength(1)
  })

  it('does not call that a connection problem: the stand-in gives a 500 the class and shape the real client does', async () => {
    const fake = fakeSupabase({ breakTrigger: true })
    const { auth } = await boot(fake)
    const { error } = await fake.client.auth.signUp({ email: 'a@b.co', password: 'x', options: { data: {} } })
    expect(error).toMatchObject({ name: 'AuthRetryableFetchError', status: 500, message: 'Database error saving new user' })
    expect(error.code).toBeUndefined()
    expect(error).toBeInstanceOf(Error)
    expect(auth.configured()).toBe(true)
  })

  it('says only "something went wrong" when the trigger failed for another reason and the name is free', async () => {
    // A bad date of birth or a format check raises the same database error.
    const fake = fakeSupabase({ breakTrigger: true })
    const { api, auth } = await boot(fake)
    const err = await failure(api.signUp({ ...PROFILE }))
    expect(err.code).toBe('unknown')
    expect(err.message).toBe(auth.MESSAGES.unknown)
    expect(err.message).not.toMatch(/username|reach|connection/i)
    expect(fake.state.rpcCalls).toHaveLength(1)
  })

  it('says "something went wrong" too when the second look at the username cannot be made either', async () => {
    const fake = fakeSupabase({ breakTrigger: true, rpcError: { message: 'boom', code: 'XX000' } })
    const { api, auth } = await boot(fake)
    const err = await failure(api.signUp({ ...PROFILE }))
    expect(err).toMatchObject({ code: 'unknown', message: auth.MESSAGES.unknown })
  })

  it('does not go on to look when the server did not answer an error (a lost connection is "offline")', async () => {
    const fake = fakeSupabase({ down: true })
    const { api, auth } = await boot(fake)
    const err = await failure(api.signUp({ ...PROFILE }))
    expect(err).toMatchObject({ code: 'offline', message: auth.MESSAGES.offline })
    expect(fake.state.rpcCalls).toHaveLength(0)
  })

  it('reports a 502 or 503 as something that went wrong, not as no connection', async () => {
    for (const status of [502, 503]) {
      const fake = fakeSupabase({ signUpError: Object.assign(new Error('Bad Gateway'), { name: 'AuthRetryableFetchError', status }) })
      const { api, auth } = await boot(fake)
      const err = await failure(api.signUp({ ...PROFILE }))
      expect(err.code).toBe('unknown')
      expect(err.message).toBe(auth.MESSAGES.unknown)
    }
  })

  it('does not take a TypeError for no connection: it is a bug, and is reported as something that went wrong', async () => {
    const fake = fakeSupabase()
    const { api, auth } = await boot(fake)
    fake.client.auth.signUp = async () => {
      throw new TypeError("Cannot read properties of undefined (reading 'user')")
    }
    const err = await failure(api.signUp({ ...PROFILE }))
    expect(err).toMatchObject({ code: 'unknown', message: auth.MESSAGES.unknown })
  })

  it('maps email_address_invalid and validation_failed to the email, with an email message', async () => {
    for (const code of ['email_address_invalid', 'validation_failed']) {
      const fake = fakeSupabase({ signUpError: apiError(code === 'validation_failed' ? 400 : 422, code, 'Unable to validate email address: invalid format') })
      const { api, auth } = await boot(fake)
      const err = await failure(api.signUp({ ...PROFILE }))
      expect(err).toMatchObject({ code: 'email_invalid', message: auth.MESSAGES.email_invalid })
      expect(err.message).toMatch(/email/i)
    }
  })
})

describe('a login that fails', () => {
  const signedUp = async () => {
    const fake = fakeSupabase()
    const booted = await boot(fake)
    await booted.api.signUp({ ...OTHER })
    await booted.api.signOut()
    return { fake, ...booted }
  }

  it('does not report a validation failure as a wrong password', async () => {
    const { fake, api, auth } = await signedUp()
    fake.client.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: apiError(400, 'validation_failed', 'Bad input') })
    const err = await failure(api.signIn({ email: OTHER.email, password: OTHER.password }))
    expect(err.code).toBe('unknown')
    expect(err.message).toBe(auth.MESSAGES.unknown)
    expect(err.message).not.toBe(auth.MESSAGES.invalid_credentials)
    // A malformed email is told as such, also not as a wrong password.
    fake.client.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: apiError(422, 'email_address_invalid', 'Bad email') })
    expect((await failure(api.signIn({ email: 'x', password: 'y' }))).code).toBe('email_invalid')
  })

  it('still reports a wrong password and an unknown email as the one sentence', async () => {
    const { api, auth } = await signedUp()
    const wrong = await failure(api.signIn({ email: OTHER.email, password: 'nope-nope-1' }))
    expect(wrong).toMatchObject({ code: 'invalid_credentials', message: auth.MESSAGES.invalid_credentials })
    // An older server that sends no error code still means a wrong password on a 400.
    const { fake } = await signedUp()
    fake.client.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: { name: 'AuthApiError', status: 400, message: 'Invalid login credentials' } })
    expect((await failure(api.signIn({ email: OTHER.email, password: 'x' }))).code).toBe('invalid_credentials')
  })

  it('reports a server error as something that went wrong and a lost connection as offline', async () => {
    const { fake, api, auth } = await signedUp()
    fake.client.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: Object.assign(new Error('boom'), { name: 'AuthRetryableFetchError', status: 500 }) })
    expect(await failure(api.signIn({ email: OTHER.email, password: 'x' }))).toMatchObject({ code: 'unknown', message: auth.MESSAGES.unknown })
    fake.state.options.down = true
    fake.client.auth.signInWithPassword = async () => ({ data: { user: null, session: null }, error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }) })
    expect(await failure(api.signIn({ email: OTHER.email, password: 'x' }))).toMatchObject({ code: 'offline', message: auth.MESSAGES.offline })
  })
})

describe('the sentences', () => {
  it('use one verb, "log in", and never "sign in"', async () => {
    const { auth } = await boot(fakeSupabase())
    for (const text of Object.values(auth.MESSAGES)) expect(text).not.toMatch(/sign in|signed in/i)
    expect(auth.MESSAGES.email_taken).toBe('An account with that email already exists. Log in instead.')
    expect(auth.MESSAGES.email_not_confirmed).toMatch(/then log in\.$/)
    for (const text of Object.values(auth.MESSAGES)) expect(text).not.toMatch(/supabase|error|exception|!|undefined/i)
  })
})
