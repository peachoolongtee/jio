<script setup>
// Two ways into the demo account, on the first question of sign-up. Only in development builds: AuthView loads this file
// behind import.meta.env.DEV, so a production build has neither the buttons nor the words.
//   <DemoSignIn />
// "Use the demo account" signs up as Ian with the sample friends and history (demoAccount.js) and goes to Home.
// "...with showcase data" does that, then fills the account with ten sessions in every state (showcase.js), which takes
// a few seconds, with a count shown. "Start the tour" does the first, then loads the demo tour (tour/) and opens Home. If the showcase stops part way, the account is there, the message says what was
// loaded, and "Continue to Home" goes on.
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import { useAuthStore } from '@/stores/auth.js'
import { DEMO_ACCOUNT } from './demoAccount.js'
import { loadShowcase } from './showcase.js'
import { useTourStore } from '@/tour/store.js'

const router = useRouter()
const auth = useAuthStore()
const tour = useTourStore()

// '' when idle, otherwise which button is working.
const busy = ref('')
const progress = ref('')
const error = ref('')
const stranded = computed(() => !!error.value && auth.signedIn)

// How to call: await enter('showcase'), await enter('tour') or await enter('plain')
async function enter(kind) {
  if (busy.value) return
  const withShowcase = kind === 'showcase'
  busy.value = kind
  error.value = ''
  progress.value = ''
  try {
    await auth.signUpAs(DEMO_ACCOUNT)
    if (withShowcase) {
      progress.value = 'Loading showcase data'
      await loadShowcase({ onProgress: ({ done, total }) => (progress.value = `Loading showcase data: ${done} of ${total} sessions`) })
    }
    if (kind === 'tour') {
      progress.value = 'Loading the tour'
      await tour.start({ onProgress: ({ done, total }) => (progress.value = `Loading the tour: ${done} of ${total} sessions`) })
      router.replace({ path: '/', query: { meetup: tour.sessionId(0) } })
      return
    }
    router.replace('/')
  } catch (err) {
    error.value = err?.message || 'Could not create the demo account. Try again.'
  } finally {
    busy.value = ''
    progress.value = ''
  }
}
</script>

<template>
  <section class="demo-in" aria-labelledby="demo-in-title">
    <h2 id="demo-in-title" class="title-md">Demo account</h2>
    <p class="caption-sm text-muted">Development only</p>

    <AppButton block variant="secondary" :disabled="!!busy" @click="enter('plain')">
      {{ busy === 'plain' ? 'Logging in' : 'Use the demo account' }}
    </AppButton>
    <p class="body-sm text-muted">Signs in as Ian, with sample friends and history.</p>

    <AppButton block variant="secondary" :disabled="!!busy" @click="enter('showcase')">
      {{ busy === 'showcase' ? 'Loading showcase data' : 'Use the demo account with showcase data' }}
    </AppButton>
    <p class="body-sm text-muted">The same, plus ten sessions in every state a screen can show, including the vote for where to meet. It takes about ten seconds.</p>

    <AppButton block variant="secondary" :disabled="!!busy" @click="enter('tour')">
      {{ busy === 'tour' ? 'Loading the tour' : 'Start the tour' }}
    </AppButton>
    <p class="body-sm text-muted">The same, plus one outing told in eight checkpoints with a strip to move between them (also at /demo).</p>

    <p v-if="progress" class="body-sm" role="status">{{ progress }}</p>
    <div v-if="error" class="demo-in__error">
      <p class="body-sm text-error" role="alert">{{ error }}</p>
      <AppButton v-if="stranded" variant="tertiary" underline small @click="router.replace('/')">Continue to Home</AppButton>
    </div>
  </section>
</template>

<style scoped>
.demo-in { display: flex; flex-direction: column; gap: var(--spacing-sm); margin-top: var(--spacing-lg); padding-top: var(--spacing-lg); border-top: 1px solid var(--hairline); }
/* Each note sits under its button, a little apart from the next one. */
.demo-in p + .btn { margin-top: var(--spacing-sm); }
.demo-in__error { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xs); }
</style>
