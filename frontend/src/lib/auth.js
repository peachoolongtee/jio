// The one place that talks to Supabase Auth and the two profile tables (profiles, profile_private).
//
// Without VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY there is no client and configured() is false: the data layer
// keeps its local accounts and calls nothing here except configured(). Every failure a person can act on is thrown
// as an Error whose message is fit to show as it is and whose `code` says which one it was. Supabase's own text is
// never shown, and a sign-in failure never says whether the email is registered. Nothing here writes a password
// anywhere, and nothing here logs.
//
// A test stands in for Supabase with useClient(fake): see lib/__tests__/authFixture.js.
import { supabase } from './supabase.js'

let client = supabase

// What the screens show. Plain, sentence case, no exclamation marks. The username message says "username" so the
// sign-up screen shows it under that question (see fieldForSignUpError in signupRules.js).
export const MESSAGES = {
  invalid_credentials: 'That email and password do not match. Check them and try again.',
  email_taken: 'An account with that email already exists. Sign in instead.',
  username_taken: 'That username is taken. Choose another one.',
  weak_password: 'Choose a stronger password.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  offline: 'Could not reach Jio. Check your connection and try again.',
  email_not_confirmed: 'Confirm your email first. Open the link we sent you, then sign in.',
  profile_not_saved: 'Your details are saved on this device, but could not be saved to your account. Try again later.',
  profile_not_loaded: 'Your account details could not be loaded. Try again.',
  unknown: 'Something went wrong. Try again.',
}

// How to call: throw problem('username_taken')
function problem(code, message = MESSAGES[code]) {
  return Object.assign(new Error(message), { code })
}

// Why a weak password was refused, in words (Supabase sends reasons such as 'length', 'characters' and 'pwned').
const WEAK_REASONS = {
  length: 'it is too short',
  characters: 'it needs a mix of letters, numbers and symbols',
  pwned: 'it has appeared in a known data leak',
}

// How to call: weakMessage(['length']) -> 'Choose a stronger password: it is too short.'
function weakMessage(reasons) {
  const phrases = (Array.isArray(reasons) ? reasons : []).map((r) => WEAK_REASONS[r]).filter(Boolean)
  return phrases.length ? `Choose a stronger password: ${phrases.join(' and ')}.` : MESSAGES.weak_password
}

// Did the request never reach Supabase (no network, or a server that is down)?
// How to call: if (isOffline(error)) throw problem('offline')
function isOffline(error) {
  const text = String(error?.message || '')
  return (
    error?.name === 'AuthRetryableFetchError' ||
    error instanceof TypeError ||
    error?.status === 0 ||
    /failed to fetch|networkerror|network request failed|load failed/i.test(text)
  )
}

// Turn whatever Supabase threw or returned into one of our errors. `where` is 'signUp' or 'signIn'.
// How to call: throw explain(result.error, 'signIn')
function explain(error, where) {
  const code = String(error?.code || '')
  const status = error?.status
  const text = String(error?.message || '')
  if (isOffline(error)) return problem('offline')
  if (status === 429 || /rate_limit/.test(code) || /rate limit/i.test(text)) return problem('rate_limited')
  if (error?.name === 'AuthWeakPasswordError' || code === 'weak_password') return problem('weak_password', weakMessage(error?.reasons))
  if (where === 'signIn') {
    if (code === 'email_not_confirmed') return problem('email_not_confirmed')
    // A wrong password and an unknown email get the same answer, so sign-in cannot be used to find out who is registered.
    if (status === 400 || status === 401 || status === 422 || code === 'invalid_credentials' || /invalid login credentials/i.test(text)) {
      return problem('invalid_credentials')
    }
    return problem('unknown')
  }
  if (code === 'user_already_exists' || code === 'email_exists' || /already (been )?registered/i.test(text)) return problem('email_taken')
  // The sign-up trigger raises on a taken username; Supabase reports that as a database error (status 500).
  if (/database error saving new user/i.test(text) || (/username/i.test(text) && /duplicate|unique|taken/i.test(text))) return problem('username_taken')
  return problem('unknown')
}

// The person as the rest of the app needs them. The username and date of birth come from the sign-up call's metadata,
// so a screen can still show who this is when the profile tables cannot be read.
// How to call: summary(session.user) -> { id: 'a1b2', email: 'sam@example.com', username: 'sam', dob: '2001-05-06' }
function summary(user) {
  const meta = user?.user_metadata || {}
  return {
    id: user.id,
    email: user.email || '',
    username: typeof meta.username === 'string' ? meta.username : '',
    dob: typeof meta.dob === 'string' ? meta.dob : '',
  }
}

// Is there a Supabase client? False means the app keeps its local accounts.
// How to call: if (configured()) await signIn({ email, password })
export function configured() {
  return client !== null && client !== undefined
}

// Give this module another client (a test's stand-in), or null. Listeners added with onChange move across.
// How to call: useClient(fakeSupabase())
export function useClient(next) {
  client = next
  watch()
}

// How to call: const c = need() (throws the "could not reach Jio" error when there is no client)
function need() {
  if (!configured()) throw problem('offline')
  return client
}

// Is this username free? Uses the database function username_available, which also works before signing up.
// Rejects with the "could not reach Jio" message when the call fails.
// How to call: await usernameAvailable('sam') -> true
export async function usernameAvailable(username) {
  const c = need()
  let result
  try {
    result = await c.rpc('username_available', { p_username: username })
  } catch {
    throw problem('offline')
  }
  if (result.error) throw problem(isOffline(result.error) ? 'offline' : 'unknown')
  return result.data === true
}

// Write the columns a signed-in person may change, for their own rows only: profiles.display_name and avatar_url,
// profile_private.dob and home_area_id. Anything else in the patch is ignored, never sent. Rejects with
// MESSAGES.profile_not_saved when a write fails or changes no row (for example the session has ended).
// patch: { name?, avatarUrl?, dob?, homeAreaId? }
// How to call: await saveProfile(user.id, { name: 'Sam', homeAreaId: 'tampines' })
export async function saveProfile(userId, patch = {}) {
  const c = need()
  const publicRow = {}
  const privateRow = {}
  if (typeof patch.name === 'string') publicRow.display_name = patch.name.trim()
  if (typeof patch.avatarUrl === 'string') publicRow.avatar_url = patch.avatarUrl || null
  if (typeof patch.dob === 'string') privateRow.dob = patch.dob
  if (typeof patch.homeAreaId === 'string') privateRow.home_area_id = patch.homeAreaId || null
  const writes = [
    ['profiles', publicRow],
    ['profile_private', privateRow],
  ].filter(([, row]) => Object.keys(row).length > 0)
  try {
    for (const [table, row] of writes) {
      const { data, error } = await c.from(table).update(row).eq('id', userId).select('id')
      if (error || !data || data.length === 0) throw new Error('not written')
    }
  } catch {
    throw problem('profile_not_saved')
  }
}

// The person's profile, public and private halves. Null when no profile row exists.
// Rejects with MESSAGES.profile_not_loaded when the tables cannot be read.
// How to call: await loadProfile(user.id) -> { username: 'sam', name: 'Sam', dob: '2001-05-06', homeAreaId: 'tampines', avatarUrl: '' }
export async function loadProfile(userId) {
  const c = need()
  let pub
  let priv
  try {
    ;[pub, priv] = await Promise.all([
      c.from('profiles').select('username, display_name, avatar_url').eq('id', userId).maybeSingle(),
      c.from('profile_private').select('dob, home_area_id').eq('id', userId).maybeSingle(),
    ])
  } catch {
    throw problem('profile_not_loaded')
  }
  if (pub.error || priv.error) throw problem('profile_not_loaded')
  if (!pub.data) return null
  return {
    username: pub.data.username,
    name: pub.data.display_name || pub.data.username,
    dob: priv.data?.dob || '',
    homeAreaId: priv.data?.home_area_id || '',
    avatarUrl: pub.data.avatar_url || '',
  }
}

// Create an account. The call carries the email, the password and, as metadata for the sign-up trigger, the username
// and date of birth, and nothing else. With a session back (email confirmation off), the display name and home area
// are then written to the profile; if that write fails the account still exists and `syncError` says so. With no
// session back (confirmation on) `needsConfirmation` is true and the person is not signed in.
// Rejects with: MESSAGES.username_taken, email_taken, a weak-password message, rate_limited, offline or unknown.
// How to call: await signUp({ email: 'sam@example.com', password: 'Sup3r-secret', username: 'sam', dob: '2001-05-06', name: 'Sam', homeAreaId: 'tampines' })
//   -> { user: { id, email, username, dob }, needsConfirmation: false, syncError: '' }
export async function signUp({ email, password, username, dob, name, homeAreaId }) {
  const c = need()
  // A cheap early answer. The trigger's unique violation below still catches a race, and a failed check is not fatal.
  try {
    if ((await usernameAvailable(username)) === false) throw problem('username_taken')
  } catch (err) {
    if (err.code === 'username_taken') throw err
  }
  let result
  try {
    result = await c.auth.signUp({ email: String(email || '').trim(), password, options: { data: { username, dob } } })
  } catch (err) {
    throw explain(err, 'signUp')
  }
  if (result.error) throw explain(result.error, 'signUp')
  const { user, session } = result.data || {}
  if (!user) throw problem('unknown')
  // With confirmation on, Supabase answers a repeat sign-up for a registered email with a user that has no identities.
  if (Array.isArray(user.identities) && user.identities.length === 0) throw problem('email_taken')
  if (!session) return { user: summary(user), needsConfirmation: true, syncError: '' }
  let syncError = ''
  try {
    await saveProfile(user.id, { name, homeAreaId })
  } catch (err) {
    syncError = err.message
  }
  return { user: summary(user), needsConfirmation: false, syncError }
}

// Sign in with email and password.
// Rejects with: MESSAGES.invalid_credentials (a wrong password and an unknown email give the same words),
// email_not_confirmed, rate_limited, offline or unknown.
// How to call: await signIn({ email: 'sam@example.com', password: 'Sup3r-secret' }) -> { user: { id, email, username, dob } }
export async function signIn({ email, password }) {
  const c = need()
  let result
  try {
    result = await c.auth.signInWithPassword({ email: String(email || '').trim(), password })
  } catch (err) {
    throw explain(err, 'signIn')
  }
  if (result.error) throw explain(result.error, 'signIn')
  if (!result.data?.user) throw problem('unknown')
  return { user: summary(result.data.user) }
}

// End this browser's session only (scope 'local'), not the person's sessions on other devices. Always resolves.
// How to call: await signOut()
export async function signOut() {
  if (!configured()) return
  try {
    await client.auth.signOut({ scope: 'local' })
  } catch {
    // Nothing to tell the person: they asked to be signed out here, and the caller signs them out whatever happens.
  }
}

// Who is signed in, from the stored session, or null. Never throws.
// How to call: await currentUser() -> { id: 'a1b2', email: 'sam@example.com', username: 'sam', dob: '2001-05-06' }
export async function currentUser() {
  if (!configured()) return null
  try {
    const { data } = await client.auth.getSession()
    return data?.session?.user ? summary(data.session.user) : null
  } catch {
    return null
  }
}

// The session's access token, for the planner client to send, or null when signed out. Never throws.
// How to call: const token = await accessToken(); if (token) headers.Authorization = `Bearer ${token}`
export async function accessToken() {
  if (!configured()) return null
  try {
    const { data } = await client.auth.getSession()
    return data?.session?.access_token || null
  } catch {
    return null
  }
}

// A new token (after the server answers 401), or null when there is no session or it cannot be refreshed. Never throws.
// How to call: const token = await refreshedToken()
export async function refreshedToken() {
  if (!configured()) return null
  try {
    const { data } = await client.auth.refreshSession()
    return data?.session?.access_token || null
  } catch {
    return null
  }
}

// ── Session changes ────────────────────────────────────────────────────────

const listeners = new Set()
let watching = null
const EVENTS = { SIGNED_IN: 'signedIn', SIGNED_OUT: 'signedOut', TOKEN_REFRESHED: 'refreshed', USER_UPDATED: 'updated' }

// Keep one Supabase subscription for the current client while anyone is listening.
// How to call: watch()
function watch() {
  if (watching && watching.client === client && listeners.size > 0) return
  if (watching) {
    watching.subscription.unsubscribe()
    watching = null
  }
  if (!configured() || listeners.size === 0) return
  const { data } = client.auth.onAuthStateChange((event, session) => {
    const mapped = EVENTS[event]
    if (!mapped) return
    const info = { event: mapped, user: session?.user ? summary(session.user) : null }
    for (const fn of [...listeners]) {
      try {
        fn(info)
      } catch {
        // One listener's failure must not stop the others.
      }
    }
  })
  watching = { client, subscription: data.subscription }
}

// Call fn({ event, user }) when the session starts ('signedIn'), ends ('signedOut'), is refreshed ('refreshed') or the
// account is updated ('updated'); `user` is null after sign-out. Keep fn short and do not await Supabase inside it.
// Returns a function that stops listening.
// How to call: const stop = onChange(({ event }) => { if (event === 'signedOut') show('You were signed out.') })
export function onChange(fn) {
  listeners.add(fn)
  watch()
  return () => {
    listeners.delete(fn)
    watch()
  }
}
