// The address a Supabase email link opens, such as /reset-password#access_token=...&refresh_token=...&type=recovery.
//
// Two things must hold about that address:
//   1. The Supabase client reads it as it starts (supabase-js reads window.location when it is created, before its first
//      await), and works out from `type=recovery` that this is a password reset. So the client must be created first.
//   2. The tokens must then leave the address bar and the history, before the router is created. vue-router's
//      createWebHistory copies the whole address, hash included, when it is created, and its first navigation writes
//      that copy back with history.replaceState once the screen is chosen, which would put the tokens back after the
//      client had cleared them.
// openWithAuthHash does both in that order. lib/supabase.js uses it for the client, and router/index.js imports that
// module before it creates the history, so the order cannot change by accident (see lib/__tests__/authLink.test.js).
//
// What was in the address is kept in memory only (never in storage): `recoveryHint` says a reset link was opened, with the
// access token it carried, so lib/auth.js can check that the session it finds is the one the link started.

// The parts of an address that Supabase puts in the hash (or, for an error, in the hash too). A hash that holds none of
// these, such as #photos, is left alone.
const AUTH_KEYS = ['access_token', 'refresh_token', 'provider_token', 'provider_refresh_token', 'token_type', 'expires_in', 'expires_at', 'error', 'error_code', 'error_description']

let hint = null

// The hash of this address as a list of parts, or null when there is no hash or it is not a list of name=value parts.
// How to call: hashParts('#access_token=a&type=recovery') -> URLSearchParams { access_token: 'a', type: 'recovery' }
function hashParts(win) {
  const hash = String(win?.location?.hash || '')
  if (hash.length < 2 || hash[0] !== '#') return null
  try {
    return new URLSearchParams(hash.slice(1))
  } catch {
    return null
  }
}

// Does this address carry a Supabase sign-in or an error from one?
// How to call: carriesAuth(parts) -> true
function carriesAuth(parts) {
  return !!parts && AUTH_KEYS.some((key) => parts.has(key))
}

// Note a reset link in the address, if there is one: `type=recovery` with an access token and no error. Reads only; the
// address is not changed.
// How to call: noteAuthHash(window) -> { accessToken: 'a1b2' } or null
export function noteAuthHash(win = globalThis.window) {
  const parts = hashParts(win)
  hint = null
  if (carriesAuth(parts) && parts.get('type') === 'recovery' && parts.get('access_token') && !parts.has('error') && !parts.has('error_code')) {
    hint = { accessToken: parts.get('access_token') }
  }
  return hint
}

// Take the Supabase parts out of the address, in place, with no new history entry. Anything else in the address stays:
// the path, the query, and a hash that is not Supabase's.
// How to call: stripAuthHash(window)
export function stripAuthHash(win = globalThis.window) {
  const parts = hashParts(win)
  if (!carriesAuth(parts) || !win?.history?.replaceState) return
  for (const key of [...AUTH_KEYS, 'type']) parts.delete(key)
  const rest = parts.toString()
  const { pathname, search } = win.location
  try {
    win.history.replaceState(win.history.state, '', pathname + search + (rest ? `#${rest}` : ''))
  } catch {
    // The page cannot change its own address (a sandbox, say); the client still has the session.
  }
}

// Run `open` (which creates the Supabase client) with the address as it is, then take the tokens out of the address. The
// reset link is noted first. Returns what `open` returns; the address is cleaned even if `open` throws.
// How to call: const client = openWithAuthHash(() => createClient(url, key))
export function openWithAuthHash(open, win = globalThis.window) {
  noteAuthHash(win)
  try {
    return open()
  } finally {
    stripAuthHash(win)
  }
}

// The reset link this page was opened with, or null: { accessToken }. Memory only.
// How to call: const link = recoveryHint(); if (link) { ... }
export function recoveryHint() {
  return hint
}

// Forget the reset link: it was used, did not match the session, or the person signed out.
// How to call: dropRecoveryHint()
export function dropRecoveryHint() {
  hint = null
}
