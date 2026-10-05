// The signed-in person (Ian, the host) and the sign-up draft.
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'

const emptyDraft = () => ({
  step: 0,
  email: '',
  password: '',
  name: '',
  username: '',
  photo: '',
  homeAreaId: '',
  locationAllowed: null,
  contactsAllowed: null,
  friends: ['darius', 'jonathan', 'nicole', 'faith', 'darryl'],
})

export const useAuthStore = defineStore('auth', () => {
  const user = ref(null)
  const ready = ref(false)
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

  return { user, ready, draft, signedIn, init, signUp, update, signOut }
})
