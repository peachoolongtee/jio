// A password reset link in the address: the tokens must be read by the Supabase client, kept off the address bar and the
// history, and never written back by the router. Run in Node with a small stand-in for the browser's window, and with
// the real supabase-js client and the real vue-router, so what is checked is what those two really do (the versions in
// node_modules: @supabase/auth-js 2.117, vue-router 4.6). It cannot show what a browser does with a real emailed link;
// only opening one in a browser does that.
import { createClient } from '@supabase/supabase-js'
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { fakeStorage } from './planFixture.js'

vi.setConfig({ testTimeout: 20000 })

const TOKEN = 'tok-from-the-emailed-link'
const LINK = `https://jio.test/reset-password#access_token=${TOKEN}&expires_in=3600&refresh_token=ref-1&token_type=bearer&type=recovery`

// A stand-in for window: an address that changes the way the browser's does (history.replaceState and a hash being set),
// with a record of every address written.
// How to call: const win = fakeWindow(LINK); win.history.replaceState(null, '', '/x'); win.written -> ['/x']
function fakeWindow(href) {
  let url = new URL(href)
  const written = []
  const hashSets = []
  const location = {
    get href() { return url.href },
    get pathname() { return url.pathname },
    get search() { return url.search },
    get hash() { return url.hash },
    set hash(value) {
      hashSets.push(value)
      url.hash = value
    },
    get host() { return url.host },
    get protocol() { return url.protocol },
    get origin() { return url.origin },
  }
  const history = {
    state: null,
    length: 1,
    replaceState(state, _title, next) {
      written.push(String(next))
      url = new URL(next, url)
      this.state = state
    },
    pushState(state, _title, next) {
      written.push(String(next))
      url = new URL(next, url)
      this.state = state
    },
  }
  return { location, history, written, hashSets, addEventListener() {}, removeEventListener() {}, scrollX: 0, scrollY: 0, scrollTo() {}, innerHeight: 800, matchMedia: () => ({ matches: false }) }
}

// Make the globals a browser has, in this test.
// How to call: const win = browser(LINK)
function browser(href) {
  const win = fakeWindow(href)
  vi.stubGlobal('window', win)
  // vue-router reads these two by their bare names.
  vi.stubGlobal('location', win.location)
  vi.stubGlobal('history', win.history)
  // Just enough document for Vue and vue-router to load as they do in a browser (they look for one when they load).
  vi.stubGlobal('document', {
    visibilityState: 'hidden',
    documentElement: { style: {}, dataset: {}, getBoundingClientRect: () => ({ left: 0, top: 0 }) },
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute() {}, content: {} }),
    createElementNS: () => ({ style: {}, setAttribute() {} }),
    addEventListener() {},
    removeEventListener() {},
  })
  vi.stubGlobal('localStorage', fakeStorage())
  vi.stubGlobal('BroadcastChannel', undefined)
  return win
}

afterEach(() => vi.unstubAllGlobals())

describe('reading and clearing the address', () => {
  it('notes a recovery link, and takes every Supabase part out of the address, keeping the path and query', async () => {
    const { noteAuthHash, stripAuthHash, recoveryHint } = await import('../authLink.js')
    const win = fakeWindow(`${LINK.replace('/reset-password', '/reset-password?next=1')}`)
    expect(noteAuthHash(win)).toEqual({ accessToken: TOKEN })
    expect(recoveryHint()).toEqual({ accessToken: TOKEN })
    stripAuthHash(win)
    expect(win.written).toEqual(['/reset-password?next=1'])
    expect(win.location.href).toBe('https://jio.test/reset-password?next=1')
  })

  it('does not call a link with an error, or one that is not a recovery, a recovery', async () => {
    const { noteAuthHash } = await import('../authLink.js')
    const error = fakeWindow('https://jio.test/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid+or+has+expired')
    expect(noteAuthHash(error)).toBeNull()
    const magic = fakeWindow('https://jio.test/#access_token=a&refresh_token=b&type=magiclink')
    expect(noteAuthHash(magic)).toBeNull()
    const claimed = fakeWindow('https://jio.test/reset-password#type=recovery')
    expect(noteAuthHash(claimed)).toBeNull()
    const both = fakeWindow('https://jio.test/reset-password#access_token=a&type=recovery&error=x')
    expect(noteAuthHash(both)).toBeNull()
  })

  it('clears an error from Supabase too, but leaves a hash that is not Supabase\'s alone', async () => {
    const { stripAuthHash } = await import('../authLink.js')
    const error = fakeWindow('https://jio.test/reset-password#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid')
    stripAuthHash(error)
    expect(error.written).toEqual(['/reset-password'])
    const anchor = fakeWindow('https://jio.test/sessions/s1#photos')
    stripAuthHash(anchor)
    expect(anchor.written).toEqual([])
    expect(anchor.location.hash).toBe('#photos')
    const mixed = fakeWindow('https://jio.test/sessions/s1#access_token=a&section=photos')
    stripAuthHash(mixed)
    expect(mixed.written).toEqual(['/sessions/s1#section=photos'])
  })

  it('does nothing without a window, or when the page may not change its own address', async () => {
    const { noteAuthHash, stripAuthHash, openWithAuthHash } = await import('../authLink.js')
    expect(noteAuthHash(undefined)).toBeNull()
    expect(() => stripAuthHash(undefined)).not.toThrow()
    const win = fakeWindow(LINK)
    win.history.replaceState = () => {
      throw new Error('SecurityError')
    }
    expect(openWithAuthHash(() => 'made', win)).toBe('made')
  })

  it('cleans the address even when creating the client throws', async () => {
    const { openWithAuthHash } = await import('../authLink.js')
    const win = fakeWindow(LINK)
    expect(() => openWithAuthHash(() => { throw new Error('boom') }, win)).toThrow('boom')
    expect(win.location.hash).toBe('')
  })
})

describe('the Supabase client and the address, in this order', () => {
  // The client built the way lib/supabase.js builds it, on a stand-in network that knows one user.
  function clientOn(fetched) {
    const fetchStub = async (input, init = {}) => {
      const target = new URL(typeof input === 'string' ? input : input.url)
      const auth = new Headers(init.headers).get('authorization')
      fetched.push({ path: target.pathname, auth })
      if (target.pathname === '/auth/v1/user' && auth === `Bearer ${TOKEN}`) {
        return new Response(JSON.stringify({ id: 'u1', aud: 'authenticated', email: 'sam@example.com', app_metadata: {}, user_metadata: {}, created_at: '2026-01-01T00:00:00Z' }), { status: 200, headers: { 'content-type': 'application/json' } })
      }
      return new Response(JSON.stringify({ code: 401, msg: 'invalid' }), { status: 401, headers: { 'content-type': 'application/json' } })
    }
    return createClient('https://project.supabase.test', 'anon-key', { auth: { storageKey: 'jio-auth', autoRefreshToken: false }, global: { fetch: fetchStub } })
  }

  it('lets the client read the link first: it signs in with the link\'s token and reports PASSWORD_RECOVERY, though the address is already clean', async () => {
    const win = browser(LINK)
    const { openWithAuthHash } = await import('../authLink.js')
    const fetched = []
    const client = openWithAuthHash(() => clientOn(fetched))
    // Straight after creating the client, before anything is awaited, the tokens are already out of the address.
    expect(win.location.href).toBe('https://jio.test/reset-password')
    expect(win.written).toEqual(['/reset-password'])
    const events = []
    client.auth.onAuthStateChange((event, session) => events.push([event, session?.access_token]))
    const { data } = await client.auth.getSession()
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(data.session?.access_token).toBe(TOKEN)
    expect(data.session?.user.id).toBe('u1')
    expect(fetched).toContainEqual({ path: '/auth/v1/user', auth: `Bearer ${TOKEN}` })
    expect(events).toContainEqual(['PASSWORD_RECOVERY', TOKEN])
    // The client's own clearing of the hash afterwards leaves no token behind either.
    expect(win.location.href).not.toContain(TOKEN)
    expect(win.written.join(' ')).not.toContain(TOKEN)
    await client.auth.stopAutoRefresh()
  })

  it('with no link in the address the client starts exactly as before', async () => {
    const win = browser('https://jio.test/reset-password')
    const { openWithAuthHash, recoveryHint } = await import('../authLink.js')
    const fetched = []
    const client = openWithAuthHash(() => clientOn(fetched))
    expect((await client.auth.getSession()).data.session).toBeNull()
    expect(win.written).toEqual([])
    expect(recoveryHint()).toBeNull()
    expect(fetched).toEqual([])
    await client.auth.stopAutoRefresh()
  })
})

describe('the router and the address', () => {
  it('vue-router writes the address it copied back after the first navigation (the defect this order prevents)', async () => {
    const win = browser(LINK)
    const { createRouter, createWebHistory } = await import('vue-router')
    // The history is created while the tokens are still in the address, as when the router module loads first.
    const history = createWebHistory()
    expect(history.location).toContain(TOKEN)
    // The Supabase client clears the hash while the guard waits.
    win.location.hash = ''
    const router = createRouter({ history, routes: [{ path: '/reset-password', component: { render: () => null } }] })
    await router.push(history.location)
    expect(win.written.join(' ')).toContain(TOKEN)
    expect(win.location.href).toContain(TOKEN)
    expect(router.currentRoute.value.fullPath).toContain(TOKEN)
  })

  it('vue-router copies nothing once the tokens were taken out first', async () => {
    const win = browser(LINK)
    const { openWithAuthHash } = await import('../authLink.js')
    openWithAuthHash(() => null)
    const { createRouter, createWebHistory } = await import('vue-router')
    const history = createWebHistory()
    expect(history.location).toBe('/reset-password')
    const router = createRouter({ history, routes: [{ path: '/reset-password', component: { render: () => null } }] })
    await router.push(history.location)
    expect(win.written.join(' ')).not.toContain(TOKEN)
    expect(win.location.href).toBe('https://jio.test/reset-password')
  })

  it('the app\'s own router module takes the tokens out before it copies the address, and its first navigation never writes them back', async () => {
    const win = browser(LINK)
    vi.resetModules()
    const { default: router } = await import('../../router/index.js')
    const { createApp } = await import('vue')
    const { createPinia } = await import('pinia')
    // Real accounts, on a client of the tests' own, so /reset-password is a route and not a redirect to /signup.
    const { fakeSupabase } = await import('./authFixture.js')
    const auth = await import('../auth.js')
    auth.useClient(fakeSupabase().client)
    expect(router.options.history.location).toBe('/reset-password')
    createApp({ render: () => null }).use(createPinia()).use(router)
    await router.isReady()
    expect(router.currentRoute.value.fullPath).toBe('/reset-password')
    expect(win.location.href).toBe('https://jio.test/reset-password')
    expect(win.written.join(' ')).not.toContain(TOKEN)
    expect(win.written.join(' ')).not.toContain('access_token')
  })

  it('imports the Supabase client module before it creates the history, and creates the client through openWithAuthHash', () => {
    const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
    const index = read('../../router/index.js')
    expect(index.indexOf("import '@/lib/supabase.js'")).toBeGreaterThan(-1)
    expect(index.indexOf("import '@/lib/supabase.js'")).toBeLessThan(index.indexOf('createWebHistory('))
    const supabase = read('../supabase.js')
    expect(supabase).toMatch(/export const supabase = openWithAuthHash\(\(\) =>\s+url && anonKey && !import\.meta\.env\.VITEST\s+\? createClient\(url, anonKey/)
  })
})
