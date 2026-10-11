// The signed-in person (Ian, the host) and the sign-up draft.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'
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
  friends: ['darius', 'jonathan', 'nicole', 'faith', 'darryl'],
})

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

  async function init() {
    if (ready.value) return
    user.value = await api.getUser()
    ready.value = true
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
    syncNotice.value = syncError || ''
    draft.value = emptyDraft()
    return user.value
  }

  // Sign in to a real account. Rejects with a message fit to show (see lib/auth.js). Nothing is kept of the password.
  // How to call: await auth.signIn('sam@example.com', 'Sup3r-secret')
  async function signIn(email, password) {
    pendingConfirmation.value = null
    syncNotice.value = ''
    user.value = await api.signIn({ email, password })
    return user.value
  }

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

  // Never throws: the person is signed out here even if ending the session failed.
  // How to call: await auth.signOut()
  async function signOut() {
    try {
      await api.signOut()
    } catch {
      // Whatever went wrong, they asked to be signed out.
    }
    user.value = null
    pendingConfirmation.value = null
    syncNotice.value = ''
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
      sessionEnds.value += 1
      draft.value = emptyDraft()
      return
    }
    if (event.type === 'reset' || event.type === 'user') user.value = await api.getUser()
  })

  return {
    sessionEnds,
    user,
    ready,
    startOverError,
    draft,
    pendingConfirmation,
    syncNotice,
    realAccounts,
    signedIn,
    init,
    signUp,
    signIn,
    dismissConfirmation,
    signUpAs,
    startOver,
    update,
    signOut,
  }
})
