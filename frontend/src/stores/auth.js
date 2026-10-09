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

  const signedIn = computed(() => !!user.value)

  async function init() {
    if (ready.value) return
    user.value = await api.getUser()
    ready.value = true
  }

  async function signUp() {
    user.value = await api.signUp({ ...draft.value })
    draft.value = emptyDraft()
    return user.value
  }

  // Demo tools: sign up with a ready-made profile, skipping the steps.
  async function signUpAs(profile) {
    user.value = await api.signUp(profile)
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
    user.value = await api.updateUser(patch)
  }

  async function signOut() {
    await api.signOut()
    user.value = null
    draft.value = emptyDraft()
  }

  api.subscribe(async (event) => {
    if (event.type === 'reset' || event.type === 'user') user.value = await api.getUser()
  })

  return { user, ready, startOverError, draft, signedIn, init, signUp, signUpAs, startOver, update, signOut }
})
