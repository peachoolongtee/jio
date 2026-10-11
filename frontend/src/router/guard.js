// Who may open what. Kept apart from the router so a test can run it on a memory router with stand-in screens.
//   - A signed-out visitor to a private page goes to /login when accounts are real (remembering where they were
//     headed in ?next=), and to /signup otherwise, as before.
//   - A signed-in visitor to /login or /signup goes Home.
//   - /login with no real accounts behind it goes to /signup: there is nothing to log in to.
import { useAuthStore } from '@/stores/auth.js'

const BASE = 'http://jio.invalid'

// The in-app path for a ?next= value, or '' when it is anything else (an outside address, a protocol-relative address,
// a backslash trick, control characters, a path back to the login or sign-up screen, a list of values). Only a path
// that stays on this site comes back, and it comes back rebuilt from the parsed address.
// How to call: safeNext('/sessions/s1?tab=past') -> '/sessions/s1?tab=past';  safeNext('//evil.example') -> ''
export function safeNext(raw) {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 500) return ''
  if (!raw.startsWith('/') || raw.startsWith('//')) return ''
  // eslint-disable-next-line no-control-regex
  if (/[\\\u0000-\u001f\u007f\s]/.test(raw)) return ''
  let url
  try {
    url = new URL(raw, BASE)
  } catch {
    return ''
  }
  if (url.origin !== BASE) return ''
  if (/^\/(login|signup)(\/|$)/.test(url.pathname)) return ''
  return url.pathname + url.search + url.hash
}

// Where the visitor goes instead of `to`, or true to let them through. `auth` is the auth store, already initialised.
// How to call: const answer = guardFor(to, auth)  (true, or a location such as { name: 'login', query: { next: '/profile' } })
export function guardFor(to, auth) {
  if (to.name === 'login') {
    if (!auth.realAccounts) return { name: 'signup' }
    if (auth.signedIn) return { name: 'home' }
    // A ?next= that is not an in-app path is dropped, never followed.
    if (to.query.next !== undefined && safeNext(to.query.next) !== to.query.next) return { name: 'login' }
    return true
  }
  if (!to.meta.public && !auth.signedIn) {
    if (!auth.realAccounts) return { name: 'signup' }
    const next = safeNext(to.fullPath)
    return next && next !== '/' ? { name: 'login', query: { next } } : { name: 'login' }
  }
  if (to.name === 'signup' && auth.signedIn) return { name: 'home' }
  return true
}

// Put the rules on a router.
// How to call: installGuard(router)
export function installGuard(router) {
  router.beforeEach(async (to) => {
    const auth = useAuthStore()
    await auth.init()
    return guardFor(to, auth)
  })
}
