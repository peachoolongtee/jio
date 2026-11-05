// The signed-in person and the sign-up draft.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'
import { MESSAGES } from '@/lib/auth.js'
import { cancelFriendRequests } from '@/lib/friendRequests.js'
import { profileProblem } from '@/lib/signupRules.js'

const emptyDraft = () => ({
  step: 0,
  email: '',
  password: '',
  name: '',
  // YYYY-MM-DD, from a date input.
  dob: '',
  username: '',
  photo: '',
  homeAreaId: '',
  // 'halal', 'vegetarian' and 'vegan' (lib/signupRules.js DIETARY_OPTIONS). Empty: no needs.
  dietary: [],
  friends: ['darius', 'jonathan', 'nicole', 'faith', 'darryl'],
})

// "Any dietary needs?" is asked once per account, and the answer is remembered in this browser (not in the account, which has no
// place for it without a schema change). A person who already has a dietary need saved has been asked, so they are not asked.
const DIET_ASKED_KEY = 'jio-diet-asked'

// Has this account been asked about dietary needs? A saved need counts as asked. Storage that cannot be read counts as not
// asked: the question can be skipped, and the person can still set their needs on the profile.
// How to call: dietAsked({ id: 'u1', dietary: [] }) -> false
function dietAsked(account) {
  if (!account) return true
  if (Array.isArray(account.dietary) && account.dietary.length) return true
  try {
    return localStorage.getItem(`${DIET_ASKED_KEY}:${account.id}`) === '1'
  } catch {
    return false
  }
}

// Remembers that this account has been asked. A storage that cannot be written is ignored: the question may come back.
// How to call: rememberDietAsked({ id: 'u1' })
function rememberDietAsked(account) {
  if (!account?.id) return
  try {
    localStorage.setItem(`${DIET_ASKED_KEY}:${account.id}`, '1')
  } catch {
    // Not remembered.
  }
}

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const ready = ref(false)
  // Why "Start over" left the person signed out, shown on the sign-up page.
  const startOverError = ref('')
  const draft = ref(emptyDraft())
  // Set after a sign-up that needs the email confirmed first: { email }. Nobody is signed in; the sign-up screen shows
  // "check your email". Cleared by the next sign-up, sign-in, sign-out or dismissConfirmation().
  const pendingConfirmation = ref(null)
  // A message when the last sign-up or profile update worked but could not be written to the person's Supabase account.
  const syncNotice = ref('')
  // Does sign-up and sign-in use a real Supabase project? False: local accounts only, no login screen needed.
  const realAccounts = api.realAccountsOn()

  const signedIn = computed(() => !!user.value)
  // The signed-in person's id, as components compare it: the sample person's id for the demo account and local accounts,
  // the Supabase user id for a real one, '' for nobody. The same id lib/currentUser.js gives the stores and the data layer.
  // How to call: <span v-if="session.hostId === auth.myId">You</span>
  const myId = computed(() => user.value?.id ?? '')
  // Does this person's world hold the sample friends and sample leaderboard? True for the demo account and local accounts,
  // false for a real account, which starts with nobody but itself.
  // How to call: <button v-if="auth.sampleWorld">Add friend</button>
  const sampleWorld = computed(() => !!user.value && !user.value.authId)

  // Was the session in this tab started by a password reset link, and not yet finished with? The reset page shows its form
  // only when this is true and someone is signed in. Memory only (lib/auth.js): a reload without the link makes it false.
  const recovering = ref(api.passwordRecovery())

  // Learn who is signed in, once. The first screen waits for this, so it is quick and bounded: the saved copy of the
  // account, within about four seconds (lib/auth.js timing), with the profile read afterwards. When Supabase could not
  // be asked, a person with a saved session is shown from the saved copy with a note; one without goes to the login.
  // Calls made while it is running share it.
  // How to call: await auth.init()
  let starting = null
  function init() {
    if (ready.value) return undefined
    starting ??= (async () => {
      try {
        const { user: found, unreachable } = await api.startUser()
        user.value = found
        askDietIfNew()
        recovering.value = api.passwordRecovery()
        if (found && unreachable) syncNotice.value = MESSAGES.unreachable
        ready.value = true
        // After the first screen is up, bring the saved copy up to date. Never waited for, and quiet when it fails.
        if (found && !found.local && !unreachable) api.refreshProfile().catch(() => {})
      } finally {
        starting = null
      }
    })()
    return starting
  }

  // Sign up with the draft. The password is cleared from the draft whether this works or not, so a failed sign-up asks
  // for it again. Resolves with the account, or with null when the email must be confirmed first (see pendingConfirmation).
  // Rejects with a message fit to show (see lib/auth.js).
  // How to call: await auth.signUp()
  async function signUp() {
    pendingConfirmation.value = null
    syncNotice.value = ''
    const profile = { ...draft.value }
    let result
    try {
      result = await api.signUp(profile)
    } finally {
      draft.value.password = ''
    }
    if (result.needsConfirmation) {
      pendingConfirmation.value = { email: result.email }
      return null
    }
    const { syncError, ...account } = result
    user.value = account
    // The name and home area are written to the account after sign-up; a failure arrives as an event (see subscribe).
    if (syncError) syncNotice.value = syncError
    draft.value = emptyDraft()
    // The new account is asked its dietary needs once, in a popup over the first page (DietaryFirstAsk).
    dietAsk.value = true
    return user.value
  }

  // Sign in to a real account. Rejects with a message fit to show (see lib/auth.js). Nothing is kept of the password.
  // How to call: await auth.signIn('sam@example.com', 'Sup3r-secret')
  async function signIn(email, password) {
    pendingConfirmation.value = null
    syncNotice.value = ''
    user.value = await api.signIn({ email, password })
    askDietIfNew()
    return user.value
  }

  // Email a link for choosing a new password. Rejects with a message fit to show (see lib/auth.js).
  // How to call: await auth.requestPasswordReset('sam@example.com')
  async function requestPasswordReset(email) {
    await api.requestPasswordReset(email)
  }

  // Set a new password, from the page the reset link opens. Once it is changed the reset is over, so the page cannot be
  // used again with the same session, and the account's other sessions are signed out (lib/auth.js).
  // Rejects with a message fit to show (see lib/auth.js).
  // How to call: await auth.changePassword('N3w-secret!')
  async function changePassword(password) {
    try {
      await api.changePassword(password)
    } finally {
      recovering.value = api.passwordRecovery()
    }
  }

  // Change the password from the edit-profile page, after checking the current one. Rejects with a message fit to show.
  // How to call: await auth.changeOwnPassword({ current: 'Sup3rSecret!', next: 'N3wSecret!' })
  async function changeOwnPassword(passwords) {
    await api.changeOwnPassword(passwords)
  }

  // Leave the "check your email" state, for the sign-up screen's way back to the first question.
  // How to call: auth.dismissConfirmation()
  function dismissConfirmation() {
    pendingConfirmation.value = null
  }

  // Demo tools: sign up with a ready-made profile, skipping the steps.
  async function signUpAs(profile) {
    const { syncError, ...account } = await api.signUp(profile)
    user.value = account
    syncNotice.value = syncError || ''
    startOverError.value = ''
    draft.value = emptyDraft()
    return user.value
  }

  // Demo tools: wipe everything (account, meetups, leaderboard) and sign up again with the demo account.
  // The profile is checked first, so a bad one rejects before anything is erased. If sign-up still fails after the
  // wipe, the person is signed out (the sign-up page can take over), the reason is kept in startOverError, and this rejects.
  async function startOver(profile) {
    const problem = profileProblem(profile)
    if (problem) throw new Error(problem)
    startOverError.value = ''
    await api.signOut()
    user.value = null
    cancelFriendRequests()
    try {
      return await signUpAs(profile)
    } catch (err) {
      startOverError.value = err?.message || 'Could not create the demo account.'
      throw err
    }
  }

  async function update(patch) {
    const { syncError, ...account } = await api.updateUser(patch)
    user.value = account
    syncNotice.value = syncError || ''
  }

  // "Any dietary needs?" (DietaryFirstAsk, ticket #107): asked once per account, in a popup. It opens right after sign-up, and
  // for a real account that was never asked (an account made on another device, or one whose sign-up needed its email
  // confirmed first) on its first sign-in or start-up here. True while it waits for an answer; a reload keeps it true until the
  // question is answered or skipped, because it is asked again unless the answer was remembered (see dietAsked).
  const dietAsk = ref(false)

  // Opens the question for a real account that has not been asked. Local and demo accounts are asked only at sign-up.
  // How to call: askDietIfNew()
  function askDietIfNew() {
    dietAsk.value = !!user.value?.authId && !dietAsked(user.value)
  }

  // The answer: the needs picked, saved on the profile, or none for "None, skip". Either way the popup closes for good, and a
  // real account is remembered as asked.
  // How to call: await auth.answerDietAsk(['halal'])
  async function answerDietAsk(dietary = []) {
    const asked = user.value
    try {
      if (dietary.length) await update({ dietary })
    } finally {
      if (asked?.authId) rememberDietAsked(asked)
      dietAsk.value = false
    }
  }

  // Signs the person out here whatever goes wrong, with one exception: a real account whose session could not be ended
  // on this browser (lib/auth.js says so with code 'sign_out_failed') stays signed in and this rejects, so the screen can
  // say so. Telling the app "signed out" while the session is still stored would bring the person back after a reload.
  // How to call: await auth.signOut()
  async function signOut() {
    try {
      await api.signOut()
    } catch (err) {
      if (err?.code === 'sign_out_failed') throw err
      // Anything else: they asked to be signed out.
    }
    user.value = null
    cancelFriendRequests()
    recovering.value = false
    pendingConfirmation.value = null
    syncNotice.value = ''
    dietAsk.value = false
    draft.value = emptyDraft()
  }

  // How many times the session has ended on its own while the app was open (the login expired, the planner refused
  // the token, or another tab signed out). The app frame watches it and sends the person to the login screen.
  // How to call: watch(() => auth.sessionEnds, goToLogin)
  const sessionEnds = ref(0)

  api.subscribe(async (event) => {
    // The Supabase session ended on its own (another tab, or it expired): signed out at once.
    if (event.type === 'reset' && event.reason === 'session-ended') {
      user.value = null
      cancelFriendRequests()
      recovering.value = false
      sessionEnds.value += 1
      draft.value = emptyDraft()
      return
    }
    // A password reset link was accepted.
    if (event.type === 'recovery') {
      recovering.value = api.passwordRecovery()
      return
    }
    // The name and home area could not be written to the account after sign-up.
    if (event.type === 'sync-failed') {
      if (user.value) syncNotice.value = event.message
      return
    }
    // Supabase answered again: the "could not be reached" note is out of date.
    if (event.type === 'reachable') {
      if (syncNotice.value === MESSAGES.unreachable) syncNotice.value = ''
      return
    }
    if (event.type === 'reset' || event.type === 'user') {
      user.value = await api.getUser()
      recovering.value = api.passwordRecovery()
      // The profile read brought in needs saved elsewhere: that account has been asked.
      if (dietAsk.value && user.value?.authId && dietAsked(user.value)) {
        rememberDietAsked(user.value)
        dietAsk.value = false
      }
    }
  })

  return {
    sessionEnds,
    user,
    ready,
    recovering,
    startOverError,
    draft,
    pendingConfirmation,
    syncNotice,
    realAccounts,
    signedIn,
    myId,
    sampleWorld,
    dietAsk,
    answerDietAsk,
    init,
    signUp,
    signIn,
    requestPasswordReset,
    changePassword,
    changeOwnPassword,
    dismissConfirmation,
    signUpAs,
    startOver,
    update,
    signOut,
  }
})
