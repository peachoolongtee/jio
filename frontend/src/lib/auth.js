// The one place that talks to Supabase Auth and the two profile tables (profiles, profile_private).
//
// Without VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY there is no client and configured() is false: the data layer
// keeps its local accounts and calls nothing here except configured(). Every failure a person can act on is thrown
// as an Error whose message is fit to show as it is and whose `code` says which one it was. Supabase's own text is
// never shown, and a sign-in failure never says whether the email is registered. Nothing here writes a password
// anywhere, and nothing here logs.
//
// A test stands in for Supabase with useClient(fake): see lib/__tests__/authFixture.js.
import { cleanDietary } from './signupRules.js'
import { AUTH_STORAGE_KEY, supabase } from './supabase.js'

let client = supabase

// How long to wait, in milliseconds. `startMs`: the most the first screen waits to learn who is signed in. `signOutMs`:
// the most a sign-out waits for the server before it ends this browser's session without it. `confirmMs`: the most it
// then waits for the client to say nobody is signed in. A test sets them short.
// How to call: timing.signOutMs = 50
export const timing = { startMs: 4000, signOutMs: 2000, confirmMs: 1000 }

// A promise that settles after `ms`.
// How to call: await Promise.race([call, pause(2000)])
export const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// What the screens show. Plain, sentence case, no exclamation marks. The username message says "username" so the
// sign-up screen shows it under that question (see fieldForSignUpError in signupRules.js).
export const MESSAGES = {
  invalid_credentials: 'That email and password do not match. Check them and try again.',
  email_taken: 'An account with that email already exists. Log in instead.',
  email_invalid: 'That email address does not look right. Check it and try again.',
  username_taken: 'That username is taken. Choose another one.',
  weak_password: 'Choose a stronger password.',
  rate_limited: 'Too many attempts. Wait a few minutes and try again.',
  offline: 'Could not reach Jio. Check your connection and try again.',
  email_not_confirmed: 'Confirm your email first. Open the link we sent you, then log in.',
  profile_not_saved: 'Your details are saved on this device, but could not be saved to your account. Try again later.',
  profile_not_loaded: 'Your account details could not be loaded. Try again.',
  unreachable: 'Jio could not be reached. You are seeing what was saved on this device.',
  try_again: 'Jio cannot check your login right now. Try again in a moment.',
  sign_out_failed: 'Could not log you out of this browser. Check your connection and try again.',
  reset_link_invalid: 'This reset link has expired or has already been used. Ask for a new one.',
  same_password: 'Choose a password different from your old one.',
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

// Did the request get no answer at all (no connection, a refused connection, a request cancelled)? The auth client
// reports that as AuthRetryableFetchError with status 0; the data client as a "Failed to fetch" message. A server that
// answered with an error is not this, even though the auth client gives a 500 the same class (see serverFailed).
// How to call: if (isOffline(error)) throw problem('offline')
function isOffline(error) {
  if (!error) return false
  if (error.status === 0) return true
  if (error.name === 'AuthRetryableFetchError' && !(error.status >= 100)) return true
  return /failed to fetch|networkerror|network request failed|load failed/i.test(String(error.message || ''))
}

// Did the server answer with an error of its own (a 5xx, such as the database error the sign-up trigger raises)?
// How to call: if (serverFailed(error)) askAgain()
function serverFailed(error) {
  return Number(error?.status) >= 500 && !isOffline(error)
}

// Is this failure one to try again later, with the session left exactly as it is? No connection, or a server error.
// A refused session (a token the server will not accept) is not.
// How to call: if (isRetryable(error)) keepTheSession()
function isRetryable(error) {
  return error?.name === 'AuthRetryableFetchError' || isOffline(error) || serverFailed(error)
}

// Turn whatever Supabase threw or returned into one of our errors. `where` is 'signUp', 'signIn', 'reset' (asking
// for the reset email) or 'newPassword' (setting the new password from that email's link).
// How to call: throw explain(result.error, 'signIn')
function explain(error, where) {
  const code = String(error?.code || '')
  const status = error?.status
  const text = String(error?.message || '')
  if (isOffline(error)) return problem('offline')
  if (status === 429 || /rate_limit/.test(code) || /rate limit/i.test(text)) return problem('rate_limited')
  if (error?.name === 'AuthWeakPasswordError' || code === 'weak_password') return problem('weak_password', weakMessage(error?.reasons))
  // A malformed email is the one thing a person can fix here. At sign-in nothing else is validated, but a validation
  // failure is still never reported as a wrong password.
  if (code === 'email_address_invalid' || (code === 'validation_failed' && ['signUp', 'reset'].includes(where))) return problem('email_invalid')
  if (where === 'newPassword') {
    if (code === 'same_password') return problem('same_password')
    // No session, or one the server no longer accepts: the link was used, expired or never opened here.
    if (code === 'session_missing' || code === 'session_not_found' || error?.name === 'AuthSessionMissingError' || status === 401 || status === 403) {
      return problem('reset_link_invalid')
    }
    return problem('unknown')
  }
  if (where === 'reset') return problem('unknown')
  if (where === 'signIn') {
    if (code === 'email_not_confirmed') return problem('email_not_confirmed')
    // A wrong password and an unknown email get the same answer, so sign-in cannot be used to find out who is registered.
    if (code === 'invalid_credentials' || /invalid login credentials/i.test(text) || (!code && [400, 401, 422].includes(status))) {
      return problem('invalid_credentials')
    }
    return problem('unknown')
  }
  if (code === 'user_already_exists' || code === 'email_exists' || /already (been )?registered/i.test(text)) return problem('email_taken')
  if (/username/i.test(text) && /duplicate|unique|taken/i.test(text)) return problem('username_taken')
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
  if (result.error) throw problem(isOffline(result.error) || result.status === 0 ? 'offline' : 'unknown')
  return result.data === true
}

// Is this email already used by an account? Uses the database function email_registered, which works before signing up.
// Rejects with the "could not reach Jio" message when the call fails, including when the function has not been added to
// the project yet (db/schema.sql); the sign-up itself still catches a registered email then.
// How to call: await emailRegistered('sam@example.com') -> true
export async function emailRegistered(email) {
  const c = need()
  let result
  try {
    result = await c.rpc('email_registered', { p_email: String(email || '').trim() })
  } catch {
    throw problem('offline')
  }
  if (result.error) throw problem(isOffline(result.error) || result.status === 0 ? 'offline' : 'unknown')
  return result.data === true
}

// Write the columns a signed-in person may change, for their own rows only: profiles.display_name and avatar_url,
// profile_private.dob, home_area_id and dietary. Anything else in the patch is ignored, never sent; an unknown dietary
// need is dropped. Rejects with
// MESSAGES.profile_not_saved when a write fails or changes no row (for example the session has ended).
// patch: { name?, avatarUrl?, dob?, homeAreaId?, dietary? }
// How to call: await saveProfile(user.id, { name: 'Sam', homeAreaId: 'tampines' })
export async function saveProfile(userId, patch = {}) {
  const c = need()
  const publicRow = {}
  const privateRow = {}
  if (typeof patch.name === 'string') publicRow.display_name = patch.name.trim()
  if (typeof patch.avatarUrl === 'string') publicRow.avatar_url = patch.avatarUrl || null
  if (typeof patch.dob === 'string') privateRow.dob = patch.dob
  if (typeof patch.homeAreaId === 'string') privateRow.home_area_id = patch.homeAreaId || null
  if (Array.isArray(patch.dietary)) privateRow.dietary = cleanDietary(patch.dietary)
  const writes = [
    ['profiles', publicRow],
    ['profile_private', privateRow],
  ].filter(([, row]) => Object.keys(row).length > 0)
  try {
    // Both tables are written at once, so a slow connection waits for one round trip, not two.
    await Promise.all(
      writes.map(async ([table, row]) => {
        const { data, error } = await c.from(table).update(row).eq('id', userId).select('id')
        if (error || !data || data.length === 0) throw new Error('not written')
      }),
    )
  } catch {
    throw problem('profile_not_saved')
  }
}

// The person's profile, public and private halves. Null when no profile row exists.
// Rejects with MESSAGES.profile_not_loaded when the tables cannot be read.
// How to call: await loadProfile(user.id) -> { username: 'sam', name: 'Sam', dob: '2001-05-06', homeAreaId: 'tampines', dietary: ['halal'], avatarUrl: '' }
export async function loadProfile(userId) {
  const c = need()
  let pub
  let priv
  try {
    ;[pub, priv] = await Promise.all([
      c.from('profiles').select('username, display_name, avatar_url').eq('id', userId).maybeSingle(),
      c.from('profile_private').select('dob, home_area_id, dietary').eq('id', userId).maybeSingle(),
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
    dietary: cleanDietary(priv.data?.dietary),
    avatarUrl: pub.data.avatar_url || '',
  }
}

// When sign-up fails with a server error, say why. The sign-up trigger raises when the username is taken, and the server
// reports every trigger failure (a taken username, but also a date of birth or a format check) as the same database
// error. So ask the database again: only if the username is now taken is it said to be taken; otherwise it is the
// plain "something went wrong".
// How to call: throw await explainSignUp(result.error, 'sam')
async function explainSignUp(error, username) {
  const explained = explain(error, 'signUp')
  if (!serverFailed(error) || explained.code !== 'unknown') return explained
  try {
    if ((await usernameAvailable(username)) === false) return problem('username_taken')
  } catch {
    // The check could not be made either: nothing more is known.
  }
  return explained
}

// Create an account. The call carries the email, the password and, as metadata for the sign-up trigger, the username
// and date of birth, and nothing else. The username is not checked here: the sign-up screen checks it on its own
// question, and a name taken since then is caught by the trigger (see explainSignUp). With a session back (email
// confirmation off), the display name, home area and dietary needs are then written to the profile; if that write fails the account
// still exists and `syncError` says so. With no session back (confirmation on) `needsConfirmation` is true and the
// person is not signed in.
// Rejects with: MESSAGES.username_taken, email_taken, email_invalid, a weak-password message, rate_limited, offline or unknown.
// How to call: await signUp({ email: 'sam@example.com', password: 'Sup3r-secret', username: 'sam', dob: '2001-05-06', name: 'Sam', homeAreaId: 'tampines', dietary: ['halal'] })
//   -> { user: { id, email, username, dob }, needsConfirmation: false, syncError: '' }
export async function signUp({ email, password, username, dob, name, homeAreaId, dietary = [] }) {
  const c = need()
  let result
  try {
    result = await c.auth.signUp({ email: String(email || '').trim(), password, options: { data: { username, dob } } })
  } catch (err) {
    throw await explainSignUp(err, username)
  }
  if (result.error) throw await explainSignUp(result.error, username)
  const { user, session } = result.data || {}
  if (!user) throw problem('unknown')
  // With confirmation on, Supabase answers a repeat sign-up for a registered email with a user that has no identities.
  if (Array.isArray(user.identities) && user.identities.length === 0) throw problem('email_taken')
  if (!session) return { user: summary(user), needsConfirmation: true, syncError: '' }
  // The account exists and the person is signed in; the profile write must not hold them up. `syncError` is filled in
  // by the caller once the write has finished (see `profileWrite`).
  const profileWrite = saveProfile(user.id, { name, homeAreaId, dietary }).then(
    () => '',
    (err) => err.message,
  )
  return { user: summary(user), needsConfirmation: false, syncError: '', profileWrite }
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

// Ask Supabase to email a link for choosing a new password. The link opens `redirectTo` (the reset page), signed in
// for that one purpose. It resolves the same way whether or not the email is registered, so the screen cannot be used
// to find out who has an account. The address must be listed under Authentication > URL Configuration > Redirect URLs
// in the Supabase dashboard, or Supabase sends the person to the project's Site URL instead.
// Rejects with: MESSAGES.email_invalid, rate_limited, offline or unknown.
// How to call: await requestPasswordReset('sam@example.com', 'https://jio.app/reset-password')
export async function requestPasswordReset(email, redirectTo) {
  const c = need()
  let result
  try {
    result = await c.auth.resetPasswordForEmail(String(email || '').trim(), { redirectTo })
  } catch (err) {
    throw explain(err, 'reset')
  }
  if (result?.error) throw explain(result.error, 'reset')
}

// Set a new password for the signed-in person: the one the reset link signed in. The password is sent to Supabase
// and kept nowhere else.
// Rejects with: MESSAGES.reset_link_invalid (no session, or it has ended), same_password, a weak-password message,
// rate_limited, offline or unknown.
// How to call: await updatePassword('N3w-secret!')
export async function updatePassword(password) {
  const c = need()
  let result
  try {
    result = await c.auth.updateUser({ password })
  } catch (err) {
    throw explain(err, 'newPassword')
  }
  if (result?.error) throw explain(result.error, 'newPassword')
}

// The session this browser holds, read straight from local storage, or null. It answers without the auth client, which
// can be waiting on the network; only the saved copy of who was signed in is read, never the tokens.
// How to call: savedUser() -> { id: 'a1b2', email: 'sam@example.com', username: 'sam', dob: '2001-05-06' }
export function savedUser() {
  try {
    const saved = JSON.parse(localStorage.getItem(AUTH_STORAGE_KEY))
    return saved?.user?.id ? summary(saved.user) : null
  } catch {
    return null
  }
}

// Remove the stored session without asking the server. Never throws.
// How to call: forgetSession()
function forgetSession() {
  try {
    for (const key of [AUTH_STORAGE_KEY, `${AUTH_STORAGE_KEY}-user`, `${AUTH_STORAGE_KEY}-code-verifier`]) localStorage.removeItem(key)
  } catch {
    // No storage to clear.
  }
}

// Does the client report that nobody is signed in? When it does not answer in time (it can be waiting on the network
// itself), the stored copy decides.
// How to call: if (await nobodyIsSignedIn(client)) tellTheApp()
async function nobodyIsSignedIn(c) {
  try {
    const answer = await Promise.race([c.auth.getSession(), pause(timing.confirmMs).then(() => 'late')])
    if (answer === 'late') return savedUser() === null
    return !answer?.data?.session
  } catch {
    return false
  }
}

// End this browser's session only, not the person's sessions on other devices, without depending on the server. The
// request goes out (scope 'local') and is given `timing.signOutMs` to answer; then the stored session is removed
// whatever happened, and the client is asked whether anybody is still signed in. The installed client has no
// sign-out that skips the network (its `signOut` always sends the request first, and removes the stored session only
// after it was answered), so the removal is done here, under the storage key named in supabase.js.
// Listeners are told 'signedOut' even when the client did not say so itself (it does not when the server never answers).
// Resolves when nobody is signed in; rejects with MESSAGES.sign_out_failed when the session is still there.
// How to call: await signOut()
export async function signOut() {
  if (!configured()) return
  const c = client
  const before = signedOutEvents
  const request = Promise.resolve()
    .then(() => c.auth.signOut({ scope: 'local' }))
    .catch(() => {
      // The server's answer does not matter: the session is removed below either way.
    })
  await Promise.race([request, pause(timing.signOutMs)])
  forgetSession()
  if (!(await nobodyIsSignedIn(c))) throw problem('sign_out_failed')
  if (signedOutEvents === before) tell({ event: EVENTS.SIGNED_OUT, user: null })
}

// Who is signed in, from the stored session, or null. Never throws.
// How to call: await currentUser() -> { id: 'a1b2', email: 'sam@example.com', username: 'sam', dob: '2001-05-06' }
export async function currentUser() {
  return (await checkSession()).user
}

// Who is signed in, and whether that could be checked. `unreachable` is true when the session could not be checked
// because the connection or the server failed (a refresh that could not be made): then `user` is null but the stored
// session has not been touched, and nobody should be treated as signed out. Never throws.
// How to call: const { user, unreachable } = await checkSession()
export async function checkSession() {
  if (!configured()) return { user: null, unreachable: false }
  try {
    const { data, error } = await client.auth.getSession()
    if (data?.session?.user) return { user: summary(data.session.user), unreachable: false }
    return { user: null, unreachable: !!error && isRetryable(error) }
  } catch {
    // Unexpected, so nothing is known: never sign anyone out for it.
    return { user: null, unreachable: true }
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

// A new token (after the server answers 401). Resolves null when the refresh was refused: there is no session, or the
// server will not accept it. Rejects with MESSAGES.try_again (code 'try_again') when it failed for a reason that may
// pass (no connection, a server error): the session is then left as it is and the caller should not sign anyone out.
// How to call: const token = await refreshedToken()
export async function refreshedToken() {
  if (!configured()) return null
  let result
  try {
    result = await client.auth.refreshSession()
  } catch {
    throw problem('try_again')
  }
  const { data, error } = result
  if (error) {
    if (isRetryable(error)) throw problem('try_again')
    // Another tab or call replaced the session while this refresh was running: use the one it left.
    if (error.name === 'AuthRefreshDiscardedError') return accessToken()
    return null
  }
  return data?.session?.access_token || null
}

// ── Session changes ────────────────────────────────────────────────────────

const listeners = new Set()
let watching = null
const EVENTS = { SIGNED_IN: 'signedIn', SIGNED_OUT: 'signedOut', TOKEN_REFRESHED: 'refreshed', USER_UPDATED: 'updated' }
// How many sign-outs the client has announced, so signOut() can tell whether it must announce one itself.
let signedOutEvents = 0

// Tell every listener. One listener's failure must not stop the others.
// How to call: tell({ event: 'signedOut', user: null })
function tell(info) {
  for (const fn of [...listeners]) {
    try {
      fn(info)
    } catch {
      // Ignored.
    }
  }
}

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
    if (mapped === EVENTS.SIGNED_OUT) signedOutEvents += 1
    tell({ event: mapped, user: session?.user ? summary(session.user) : null })
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
