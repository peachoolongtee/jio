import { createClient } from '@supabase/supabase-js'

const url = import.meta.env.VITE_SUPABASE_URL
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY

// Where the auth client keeps its session in local storage. It is named here, not left to the library's default, so
// lib/auth.js can remove it when signing out without waiting for the server (the library only removes it after the
// server has answered).
export const AUTH_STORAGE_KEY = 'jio-auth'

// The longest the sign-out request may take before it is given up. The client then ends the session itself, so a
// sign-out that is still waiting on the server cannot finish later and end a session started in the meantime.
export const LOGOUT_LIMIT_MS = 2000

// Wrap a fetch so that a request to the auth server's logout address is cancelled after `ms`. Every other request
// is passed on as it is. The cancelled request fails like a lost connection, which the auth client answers by
// ending the session on this browser.
// How to call: createClient(url, key, { global: { fetch: limitLogout(fetch.bind(globalThis)) } })
export function limitLogout(inner, ms = LOGOUT_LIMIT_MS) {
  return (input, init = {}) => {
    const address = String(typeof input === 'string' ? input : input?.url ?? input)
    if (!/\/auth\/v1\/logout(\?|$)/.test(address)) return inner(input, init)
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), ms)
    // Keep the caller's own signal working too.
    if (init.signal) init.signal.addEventListener('abort', () => controller.abort(), { once: true })
    return inner(input, { ...init, signal: controller.signal }).finally(() => clearTimeout(timer))
  }
}

// The browser client for auth, CRUD under Row Level Security and realtime, or null when the two variables are not set.
// Without them the app keeps its local accounts (see lib/auth.js), except in a production build, which refuses to
// start (see mustRefuse). Under the test runner it is always null, so a developer's own .env can never make the suite
// reach a real project; a test hands lib/auth.js a stand-in client.
// How to call: import { supabase, supabaseConfigured } from './supabase.js'; if (supabaseConfigured) await supabase.auth.getSession()
export const supabase =
  url && anonKey && !import.meta.env.VITEST
    ? createClient(url, anonKey, {
        auth: { storageKey: AUTH_STORAGE_KEY },
        global: { fetch: limitLogout((...args) => globalThis.fetch(...args)) },
      })
    : null

export const supabaseConfigured = supabase !== null

// May accounts that live only in this browser work? Always in development (the demo account). In a production build
// only when it was built with VITE_ALLOW_LOCAL_ACCOUNTS=1, for a deployed demo; otherwise a local account with no
// Supabase account behind it is not a login.
// How to call: localAccountsAllowed() -> true in development; localAccountsAllowed({ DEV: false }) -> false
export function localAccountsAllowed(env = import.meta.env) {
  return !!env.DEV || env.VITE_ALLOW_LOCAL_ACCOUNTS === '1'
}

// Must this build refuse to start? True for a production build that has no Supabase settings and was not told to keep
// local accounts: left alone it would let anyone "sign up" into a browser-only account.
// How to call: if (mustRefuse()) showUnavailableScreen()
export function mustRefuse({ configured = supabaseConfigured, env = import.meta.env } = {}) {
  return !configured && !localAccountsAllowed(env)
}
