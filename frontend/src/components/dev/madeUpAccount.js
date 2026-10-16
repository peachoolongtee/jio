// A real account with no Supabase project behind it, for walking a real account's flow in a development build.
//
// Signing up for real needs a Supabase project, which a developer's browser must not reach for a check like this. So this
// puts a stand-in for the Supabase client (fakeSupabase.js, the one the account tests use) inside lib/auth.js and signs up
// through the real code path: the account store, lib/api.js's real sign-up, the account's own save under its own key. What
// is made up is only the server. The account has a uuid-shaped id and lives in this tab's memory only: the stand-in never
// writes to local storage, so it cannot overwrite a real session the real client keeps there (`jio-auth`). After a reload the
// stand-in is gone and the person is signed out; the account's save stays under its own key.
//
// Only development builds load this file (DemoSignIn.vue imports it behind import.meta.env.DEV), so it is not in a
// production bundle.
// How to call: await signUpAsMadeUp(auth) (auth is the account store); await signUpAsMadeUp(auth, { name: 'Kim', username: 'kim_made_up' })
import * as lib from '@/lib/auth.js'
import { fakeSupabase } from './fakeSupabase.js'

// The details of the first made-up account. `demo` is left out on purpose: that is what makes the sign-up real.
export const MADE_UP_ACCOUNT = {
  email: 'sam@jio.invalid',
  password: 'Made-up-1',
  name: 'Sam',
  username: 'sam_made_up',
  dob: '2001-05-06',
  photo: '',
  homeAreaId: 'tampines',
  friends: [],
}

let stand = null

// A database to share with other pages, when a script that drives several browsers has put one on the page as
// `globalThis.__jioStandInDatabase` ({ run, subscribe, setProfile, getProfiles, usernameTaken, profileByUsername }, each
// possibly returning a Promise). Without it the stand-in's database is this page's own. A script may also set
// `globalThis.__jioStandInAccount` ({ email, name, username }) to make this page's made-up account differ from another's.
// How to call: sharedDatabase() -> the shared database, or undefined
const sharedDatabase = () => globalThis.__jioStandInDatabase || undefined

// The stand-in client, made once per page and handed to lib/auth.js.
// How to call: const { state } = installStandIn()
export function installStandIn() {
  if (!stand) {
    stand = fakeSupabase({ uuidIds: true, memoryOnly: true, database: sharedDatabase() })
    lib.useClient(stand.client, { storage: false })
  }
  return stand
}

// Sign up as a made-up real account. A second call with the same details signs in instead, because the stand-in already
// knows the email.
// How to call: await signUpAsMadeUp(auth)
export async function signUpAsMadeUp(auth, details = {}) {
  const { state } = installStandIn()
  const profile = { ...MADE_UP_ACCOUNT, ...(globalThis.__jioStandInAccount || {}), ...details }
  if (state.users.some((u) => u.email === profile.email)) return auth.signIn(profile.email, profile.password)
  return auth.signUpAs(profile)
}

// Put the stand-in in place before the app starts, when a script has handed this page a shared database. Then a visitor who
// is not signed in (the join page) reads through the stand-in too, not through the real client, which has nowhere to go.
// Called by main.js in development builds only.
// How to call: installForSharedDatabase()
export function installForSharedDatabase() {
  if (sharedDatabase()) installStandIn()
}
