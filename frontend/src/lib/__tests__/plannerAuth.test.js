// The planner client and the login check: the token it sends, what it does when the server answers 401 or 503, and
// what it does when there is no backend to call. Axios's adapter and Supabase are stand-ins; nothing touches a network.
import { AxiosError } from 'axios'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as auth from '../auth.js'
import { api, goesToPlanner, meetingArea, plannerErrorMessage, rankSlot, sessionDietary } from '../plannerApi.js'
import { AUTH_STORAGE_KEY } from '../supabase.js'
import { fakeStorage } from './planFixture.js'
import { fakeSupabase } from './authFixture.js'

const ENDED = 'Your session has ended. Log in again.'
const TRY_AGAIN = 'Jio cannot check your login right now. Try again in a moment.'
const UNAUTHENTICATED = { error: 'unauthenticated', message: 'The session token is not valid or has expired. Sign in again.' }
const OK = { area: { id: 'bishan' } }
const HUB = { lat: 1.35, lng: 103.85 }
const ASK = { members: [], centre: HUB, date: '2026-10-10', slot: { start: 900, time: '15:00', duration: 90, category: 'eat' }, lastStop: false }

const realAdapter = api.defaults.adapter
const realBase = api.defaults.baseURL
let state
let seen

// A stand-in for Supabase: one token that can be replaced, a refresh that gives the next one, and a sign-out that clears it.
// `refresh`: true gives the next token; false is refused (no session); 'retryable' is a lost connection; 'server' a 502.
function fakeClient(first = 'token-1', { refresh = true } = {}) {
  state = { token: first, count: 1, refreshes: 0, signOuts: 0 }
  return {
    auth: {
      getSession: async () => ({ data: { session: state.token ? { access_token: state.token, user: { id: 'u' } } : null } }),
      refreshSession: async () => {
        state.refreshes += 1
        await Promise.resolve()
        if (refresh === 'retryable') return { data: { session: null }, error: Object.assign(new Error('Failed to fetch'), { name: 'AuthRetryableFetchError', status: 0 }) }
        if (refresh === 'server') return { data: { session: null }, error: Object.assign(new Error('Bad Gateway'), { name: 'AuthRetryableFetchError', status: 502 }) }
        if (!refresh) return { data: { session: null }, error: { message: 'no session' } }
        state.count += 1
        state.token = `token-${state.count}`
        return { data: { session: { access_token: state.token } }, error: null }
      },
      signOut: async () => {
        state.signOuts += 1
        state.token = null
        return { error: null }
      },
      onAuthStateChange: () => ({ data: { subscription: { unsubscribe() {} } } }),
    },
  }
}

// Axios's adapter, scripted: each call takes the next answer ([status, body]) and records the Authorization header sent.
// Like a real adapter, a status outside 2xx rejects with an AxiosError that carries the response.
function script(...answers) {
  seen = []
  let i = 0
  api.defaults.adapter = async (config) => {
    seen.push(config.headers.get('Authorization') || null)
    const [status, data] = answers[Math.min(i, answers.length - 1)]
    i += 1
    const response = { status, data, headers: {}, config, request: {} }
    if (status >= 200 && status < 300) return response
    throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
  }
}

beforeEach(() => {
  auth.useClient(fakeClient())
  vi.spyOn(console, 'error').mockImplementation(() => {})
})

afterEach(() => {
  api.defaults.adapter = realAdapter
  api.defaults.baseURL = realBase
  auth.useClient(null)
  vi.unstubAllEnvs()
  vi.restoreAllMocks()
})

describe('the token the planner client sends', () => {
  it('carries the token when there is one', async () => {
    script([200, OK])
    await meetingArea({ members: [] })
    expect(seen).toEqual(['Bearer token-1'])
  })

  it('carries no Authorization header when there is none', async () => {
    auth.useClient(fakeClient(null))
    script([200, OK])
    await meetingArea({ members: [] })
    expect(seen).toEqual([null])
    // The same when Supabase is not set up at all (a local account, or a build without the variables).
    auth.useClient(null)
    await meetingArea({ members: [] })
    expect(seen).toEqual([null, null])
  })

  it('reads the token again for each request', async () => {
    script([200, OK])
    await meetingArea({ members: [] })
    state.token = 'token-other'
    await meetingArea({ members: [] })
    state.token = null
    await meetingArea({ members: [] })
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-other', null])
  })
})

describe('a 401 from the login check', () => {
  it('refreshes once and retries once with the new token, and the caller gets the second answer', async () => {
    script([401, UNAUTHENTICATED], [200, OK])
    await expect(meetingArea({ members: [] })).resolves.toEqual(OK)
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2'])
    expect(state.refreshes).toBe(1)
    expect(state.signOuts).toBe(0)
  })

  it('sends the request body again on the retry', async () => {
    const bodies = []
    script([401, UNAUTHENTICATED], [200, OK])
    const inner = api.defaults.adapter
    api.defaults.adapter = async (config) => {
      bodies.push(config.data)
      return inner(config)
    }
    await meetingArea({ members: [{ id: 'a' }] })
    expect(bodies).toHaveLength(2)
    expect(bodies[1]).toBe(bodies[0])
    expect(JSON.parse(bodies[1]).members).toEqual([{ id: 'a' }])
  })

  it('ends the session and says so after a second 401, without a third request', async () => {
    script([401, UNAUTHENTICATED])
    await expect(meetingArea({ members: [] })).rejects.toThrow(ENDED)
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-2'])
    expect(state.refreshes).toBe(1)
    expect(state.signOuts).toBe(1)
  })

  it('ends the session without a retry when there is no fresh token', async () => {
    auth.useClient(fakeClient('token-1', { refresh: false }))
    script([401, UNAUTHENTICATED], [200, OK])
    await expect(meetingArea({ members: [] })).rejects.toThrow(ENDED)
    expect(seen).toEqual(['Bearer token-1'])
    expect(state.signOuts).toBe(1)
  })

  it('shares one refresh between requests that fail together', async () => {
    let calls = 0
    api.defaults.adapter = async (config) => {
      const token = config.headers.get('Authorization')
      calls += 1
      const response = { status: token === 'Bearer token-1' ? 401 : 200, data: token === 'Bearer token-1' ? UNAUTHENTICATED : OK, headers: {}, config, request: {} }
      if (response.status === 401) throw new AxiosError('401', 'ERR_BAD_REQUEST', config, {}, response)
      return response
    }
    // Three different requests (identical ones in flight together are sent once, see plannerApi.shared.test.js).
    const results = await Promise.all([meetingArea({ members: [] }), meetingArea({ members: [], alternatives: 1 }), rankSlot({ ...ASK })].map((p) => p.catch((e) => e)))
    expect(state.refreshes).toBe(1)
    expect(calls).toBe(6)
    expect(results[0]).toEqual(OK)
    expect(results[1]).toEqual(OK)
    expect(state.signOuts).toBe(0)
  })

  it('is not retried and signs nobody out when the request carried no token', async () => {
    auth.useClient(fakeClient(null))
    script([401, UNAUTHENTICATED], [200, OK])
    const failure = await meetingArea({ members: [] }).catch((e) => e)
    expect(failure.message).toBe('The planner needs you to be logged in. Log in and try again.')
    expect(seen).toEqual([null])
    expect(state.refreshes).toBe(0)
    expect(state.signOuts).toBe(0)
  })

  it('leaves a 401 with another body to the ordinary sentence, with no refresh', async () => {
    script([401, { error: 'something_else', message: 'Not allowed here.' }])
    await expect(meetingArea({ members: [] })).rejects.toThrow('Not allowed here.')
    expect(state.refreshes).toBe(0)
    expect(state.signOuts).toBe(0)
  })
})

describe('a refresh that fails for a reason that may pass', () => {
  it.each([
    ['there is no connection', 'retryable'],
    ['the server answers a 502', 'server'],
  ])('fails the request with a "try again" sentence and keeps the person signed in when %s', async (_name, refresh) => {
    auth.useClient(fakeClient('token-1', { refresh }))
    script([401, UNAUTHENTICATED], [200, OK])
    const failure = await meetingArea({ members: [] }).catch((e) => e)
    expect(failure.message).toBe(TRY_AGAIN)
    expect(failure.message).not.toBe(ENDED)
    expect(seen).toEqual(['Bearer token-1'])
    expect(state.refreshes).toBe(1)
    expect(state.signOuts).toBe(0)
    expect(state.token).toBe('token-1')
    // The next request still carries the same session's token, and works once the server is back.
    script([200, OK])
    await expect(meetingArea({ members: [] })).resolves.toEqual(OK)
    expect(seen).toEqual(['Bearer token-1'])
  })

  it('still signs out when the refresh is refused (the server will not accept it)', async () => {
    auth.useClient(fakeClient('token-1', { refresh: false }))
    script([401, UNAUTHENTICATED])
    await expect(meetingArea({ members: [] })).rejects.toThrow(ENDED)
    expect(state.signOuts).toBe(1)
  })

  it('tells a refused refresh from one that may pass by its name and status', async () => {
    const { client } = fakeSupabase()
    auth.useClient(client)
    const answer = (error) => {
      client.auth.refreshSession = async () => ({ data: { session: null, user: null }, error })
      return auth.refreshedToken().then((value) => ({ value }), (err) => ({ code: err.code }))
    }
    expect(await answer(Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 0 }))).toEqual({ code: 'try_again' })
    expect(await answer(Object.assign(new Error('x'), { name: 'AuthRetryableFetchError', status: 500 }))).toEqual({ code: 'try_again' })
    expect(await answer(Object.assign(new Error('Failed to fetch'), { name: 'Error' }))).toEqual({ code: 'try_again' })
    expect(await answer({ name: 'AuthApiError', status: 400, code: 'refresh_token_not_found', message: 'gone' })).toEqual({ value: null })
    expect(await answer({ name: 'AuthSessionMissingError', status: 400, message: 'Auth session missing!' })).toEqual({ value: null })
    // An unexpected exception is not a refusal either.
    client.auth.refreshSession = async () => {
      throw new TypeError('bug')
    }
    expect(await auth.refreshedToken().catch((err) => ({ code: err.code }))).toEqual({ code: 'try_again' })
  })
})

describe('401s that arrive a little apart', () => {
  it('retries a late 401 with the token already refreshed, without refreshing again', async () => {
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    let slow = 0
    seen = []
    api.defaults.adapter = async (config) => {
      const token = config.headers.get('Authorization')
      seen.push(token)
      const stale = token === 'Bearer token-1'
      // The second request's 401 is held back until the first request's refresh has finished and settled.
      if (stale && (slow += 1) === 2) await gate
      const response = { status: stale ? 401 : 200, data: stale ? UNAUTHENTICATED : OK, headers: {}, config, request: {} }
      if (stale) throw new AxiosError('401', 'ERR_BAD_REQUEST', config, {}, response)
      return response
    }
    const first = meetingArea({ members: [] })
    const second = rankSlot({ ...ASK })
    await expect(first).resolves.toEqual(OK)
    expect(state.refreshes).toBe(1)
    release()
    expect(await second).toMatchObject({ options: [] })
    // Two requests, each sent with token-1 and then with token-2; one refresh for both.
    expect(seen.filter((t) => t === 'Bearer token-1')).toHaveLength(2)
    expect(seen.filter((t) => t === 'Bearer token-2')).toHaveLength(2)
    expect(state.refreshes).toBe(1)
    expect(state.signOuts).toBe(0)
  })
})

describe('the token goes only to the planner', () => {
  it('says which requests go to the planner: a relative path, or an address on the planner\'s own origin', () => {
    const base = 'https://jio-api.example.com'
    expect(goesToPlanner({ baseURL: base, url: '/api/converge' })).toBe(true)
    expect(goesToPlanner({ baseURL: base, url: 'api/converge' })).toBe(true)
    expect(goesToPlanner({ baseURL: base, url: 'https://jio-api.example.com/api/converge' })).toBe(true)
    expect(goesToPlanner({ baseURL: '', url: '/api/converge' })).toBe(true)
    for (const url of ['https://evil.example/api', 'http://jio-api.example.com/api', 'https://jio-api.example.com.evil.example/', 'https://jio-api.example.com@evil.example/', '//evil.example/api', 'HTTPS://EVIL.example/']) {
      expect(goesToPlanner({ baseURL: base, url })).toBe(false)
    }
    expect(goesToPlanner({ baseURL: '', url: 'https://evil.example/x' })).toBe(false)
  })

  it('sends no Authorization header to another site, and does to the planner', async () => {
    api.defaults.baseURL = 'https://jio-api.example.com'
    script([200, OK])
    await api.get('/api/places')
    await api.get('https://jio-api.example.com/api/places')
    await api.get('https://evil.example/collect')
    await api.get('//evil.example/collect')
    expect(seen).toEqual(['Bearer token-1', 'Bearer token-1', null, null])
  })
})

describe('signing out after the planner refused the login', () => {
  // A person signed in on the shared stand-in, with real storage under it and a short wait.
  async function signedIn(options) {
    vi.stubGlobal('localStorage', fakeStorage())
    const fake = fakeSupabase(options)
    fake.state.users.push({ id: 'uid-1', email: 'sam@example.com', password: 'x', meta: { username: 'sam' } })
    auth.useClient(fake.client)
    auth.timing.signOutMs = 30
    auth.timing.confirmMs = 30
    await fake.client.auth.signInWithPassword({ email: 'sam@example.com', password: 'x' })
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeTruthy()
    return fake
  }

  afterEach(() => {
    vi.unstubAllGlobals()
    auth.timing.signOutMs = 2000
    auth.timing.confirmMs = 1000
  })

  it('ends the session within the limit after a second 401 even when the server never answers the sign-out', async () => {
    const fake = await signedIn({ signOutMode: 'hang' })
    script([401, UNAUTHENTICATED])
    const started = performance.now()
    await expect(meetingArea({ members: [] })).rejects.toThrow(ENDED)
    expect(performance.now() - started).toBeLessThan(1500)
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(await auth.accessToken()).toBeNull()
    expect(fake.state.signOutCalls).toEqual([{ scope: 'local' }])
  })

  it('does the same after a refused refresh', async () => {
    const fake = await signedIn({ signOutMode: 'hang' })
    // A refresh the server refuses outright, as it does for a refresh token that was already used.
    fake.client.auth.refreshSession = async () => ({ data: { session: null, user: null }, error: { name: 'AuthApiError', status: 400, code: 'refresh_token_already_used', message: 'used' } })
    script([401, UNAUTHENTICATED], [200, OK])
    await expect(meetingArea({ members: [] })).rejects.toThrow(ENDED)
    expect(localStorage.getItem(AUTH_STORAGE_KEY)).toBeNull()
    expect(await auth.accessToken()).toBeNull()
    expect(seen).toEqual(['Bearer token-1'])
  })

  it('says the session has ended even when the session cannot be removed', async () => {
    await signedIn({ signOutMode: 'hang' })
    localStorage.removeItem = () => {
      throw new Error('denied')
    }
    script([401, UNAUTHENTICATED])
    await expect(meetingArea({ members: [] })).rejects.toThrow(ENDED)
  })
})

describe('a 503 from the login check', () => {
  it('says Jio cannot check the login, not that the planner cannot be reached', async () => {
    script([503, { error: 'auth_unavailable', message: 'Cannot check your login right now.' }])
    await expect(meetingArea({ members: [] })).rejects.toThrow('Jio cannot check your login right now. Try again in a moment.')
    expect(state.refreshes).toBe(0)
    expect(state.signOuts).toBe(0)
  })
})

describe('a build with no backend, and answers that are not JSON', () => {
  it('rejects at once with a plain sentence and makes no request in a production build with no backend address', async () => {
    vi.stubEnv('DEV', false)
    api.defaults.baseURL = ''
    script([200, OK])
    const failure = await meetingArea({ members: [] }).catch((e) => e)
    expect(failure.message).toBe('The Jio planner is not available right now. Try again later.')
    expect(seen).toEqual([])
    expect(failure.message).not.toMatch(/VITE_|pnpm|env/)
    // The developer text goes to the console, once.
    await meetingArea({ members: [] }).catch(() => {})
    expect(console.error).toHaveBeenCalledTimes(1)
    expect(String(console.error.mock.calls[0][0])).toContain('VITE_API_BASE_URL')
  })

  it('still calls the backend in a production build that has an address, and in development without one', async () => {
    vi.stubEnv('DEV', false)
    api.defaults.baseURL = 'https://jio-api.example.com'
    script([200, OK])
    await expect(meetingArea({ members: [] })).resolves.toEqual(OK)
    vi.stubEnv('DEV', true)
    api.defaults.baseURL = ''
    await expect(meetingArea({ members: [] })).resolves.toEqual(OK)
    expect(seen).toHaveLength(2)
  })

  it('rejects an HTML answer with status 200 and does not read it as no places', async () => {
    script([200, '<!doctype html><html><body>Jio</body></html>'])
    const failure = await rankSlot({ ...ASK }).then(
      (value) => ({ value }),
      (e) => e,
    )
    expect(failure).toBeInstanceOf(Error)
    expect(failure.message).toBe('The planner answered with something other than JSON. Check VITE_API_BASE_URL points at the backend, not the page itself.')
    await expect(meetingArea({ members: [] })).rejects.toThrow(/something other than JSON/)
    vi.stubEnv('DEV', false)
    api.defaults.baseURL = 'https://jio-api.example.com'
    await expect(meetingArea({ members: [] })).rejects.toThrow('The planner sent an answer Jio could not read. Try again later.')
  })
})

describe('the existing error sentences', () => {
  it('are unchanged for a 429, validation issues, a 404 and no response', async () => {
    script([429, { error: 'rate_limited', message: 'Too many requests. Try again shortly.' }])
    await expect(meetingArea({ members: [] })).rejects.toThrow('Too many requests. Wait a few seconds and try again.')
    script([400, { issues: [{ path: 'members.0.start', message: 'required' }] }])
    await expect(meetingArea({ members: [] })).rejects.toThrow('The planner could not use this request (members.0.start: required).')
    script([404, { message: 'There is no POST /api/x here.' }])
    await expect(meetingArea({ members: [] })).rejects.toThrow('There is no POST /api/x here.')
    api.defaults.adapter = async (config) => {
      throw new AxiosError('Network Error', 'ERR_NETWORK', config)
    }
    await expect(meetingArea({ members: [] })).rejects.toThrow('Cannot reach the Jio planner.')
    expect(plannerErrorMessage({ response: { status: 503, data: {} } }, { dev: false })).toBe('The planner had a problem. Try again.')
  })
})

describe('an outing’s dietary needs (GET /api/sessions/:id/dietary)', () => {
  it('sends the login token, and gives the two lists back', async () => {
    script([200, { dietary: ['halal', 'vegan'], others: ['halal'] }])
    expect(await sessionDietary('3b1f')).toEqual({ dietary: ['halal', 'vegan'], others: ['halal'] })
    expect(seen).toEqual(['Bearer token-1'])
  })

  it('refuses an answer that is not two lists of known needs, and passes the server’s code on', async () => {
    script([200, { dietary: ['halal'], others: ['pescatarian'] }])
    await expect(sessionDietary('3b1f')).rejects.toThrow()
    script([200, { dietary: ['halal'] }])
    await expect(sessionDietary('3b1f')).rejects.toThrow()
    script([404, { error: 'session_not_found', message: 'This session does not exist, or you are not in it.' }])
    await expect(sessionDietary('3b1f')).rejects.toMatchObject({ code: 'session_not_found', status: 404 })
  })
})
