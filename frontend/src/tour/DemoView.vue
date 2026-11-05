<script setup>
// /demo: the one link into the demo tour. Public, and it does one of four things depending on who is signed in:
//   nobody             make the demo account, load the tour, and go Home (no clicks), showing progress in words
//   the demo account   ask: restart the tour (replaces the demo account's sessions) or carry on where it stopped
//   anyone else        touch nothing: say that, and how to try the demo (sign out first, then open this page again)
//   a part-way failure say what was loaded and what was not, and offer to try again
// The "anyone else" case covers a real account and any other account kept in this browser, so nothing a person made is lost.
import { computed, onMounted, ref } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import JioLogo from '@/components/ui/JioLogo.vue'
import ProgressBar from '@/components/ui/ProgressBar.vue'
import SampleNote from '@/components/ui/SampleNote.vue'
import { DEMO_ACCOUNT } from '@/components/dev/demoAccount.js'
import { useAuthStore } from '@/stores/auth.js'
import { useTourStore } from './store.js'

const router = useRouter()
const auth = useAuthStore()
const tour = useTourStore()

// 'run' (working), 'choose' (the demo account is here), 'other' (someone else is signed in), 'failed'.
const phase = ref(auth.user ? (auth.user.demo ? 'choose' : 'other') : 'run')
const words = ref('Starting')
const done = ref(0)
const total = ref(1)
const error = ref('')
// Whether the demo account is signed in after a failure, so the page can say so.
const accountMade = ref(false)

const hasTour = computed(() => tour.loaded)

// Make the account when nobody is signed in, load the tour, and go Home with the outing selected.
// How to call: await begin()
async function begin() {
  phase.value = 'run'
  error.value = ''
  done.value = 0
  try {
    if (!auth.user) {
      words.value = 'Creating the demo account'
      await auth.signUpAs(DEMO_ACCOUNT)
      accountMade.value = true
    }
    words.value = 'Loading the outing'
    await tour.start({
      onProgress: (progress) => {
        done.value = progress.done
        total.value = progress.total
        words.value = `Loading the outing: ${progress.done} of ${progress.total} sessions`
      },
    })
    words.value = 'Opening Home'
    await router.replace({ path: '/', query: { meetup: tour.sessionId(0) } })
  } catch (err) {
    error.value = err?.message || 'The tour could not be loaded.'
    phase.value = 'failed'
  }
}

// Carry on where the tour stopped, or from the first checkpoint.
// How to call: await carryOn()
async function carryOn() {
  tour.resume()
  await router.replace(tour.pathFor(tour.index))
}

onMounted(() => {
  if (phase.value === 'run') begin()
})
</script>

<template>
  <main class="screen screen--form demo" data-testid="demo-view">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>

    <div class="screen__body">
      <!-- Working. -->
      <template v-if="phase === 'run'">
        <h1 class="display-xl">Setting up the demo</h1>
        <div class="stack gap-sm" role="status" aria-live="polite">
          <p class="body-md">{{ words }}</p>
          <ProgressBar :value="done" :max="total" label="Loading the demo" />
        </div>
        <p class="body-sm text-muted">It takes a few seconds. Everything stays in this browser.</p>
      </template>

      <!-- The demo account is already here. -->
      <template v-else-if="phase === 'choose'">
        <h1 class="display-xl">Demo tour</h1>
        <p class="body-md">
          {{ hasTour ? 'The demo account is signed in and the tour is loaded.' : 'The demo account is signed in, without the tour.' }}
          Restarting replaces its sessions with the tour's, so anything you changed in them is lost.
        </p>
        <div class="demo__actions">
          <AppButton block :variant="hasTour ? 'secondary' : 'primary'" @click="begin">Restart the tour</AppButton>
          <AppButton v-if="hasTour" block @click="carryOn">Carry on</AppButton>
          <AppButton block variant="tertiary" underline to="/">Go to Home</AppButton>
        </div>
        <SampleNote>Sample data for the demo</SampleNote>
      </template>

      <!-- Someone else's account. -->
      <template v-else-if="phase === 'other'">
        <h1 class="display-xl">You are signed in</h1>
        <p class="body-md" data-testid="demo-other">
          The demo tour uses its own account, so it was not started and nothing in your account was changed. To try the demo,
          sign out first, then open this page again.
        </p>
        <div class="demo__actions">
          <AppButton block to="/profile">Go to your profile</AppButton>
          <AppButton block variant="tertiary" underline to="/">Go to Home</AppButton>
        </div>
      </template>

      <!-- Stopped part way. -->
      <template v-else>
        <h1 class="display-xl">The demo did not finish loading</h1>
        <p class="body-md text-error" role="alert">{{ error }}</p>
        <p class="body-sm text-muted">
          {{ accountMade ? 'The demo account was made, and whatever was loaded is in it.' : 'Nothing was loaded.' }}
          Trying again starts the tour over.
        </p>
        <div class="demo__actions">
          <AppButton block @click="begin">Try again</AppButton>
          <AppButton v-if="accountMade || auth.signedIn" block variant="tertiary" underline to="/">Go to Home</AppButton>
        </div>
      </template>
    </div>
  </main>
</template>

<style scoped>
.demo { min-height: 100dvh; }
.demo .screen__body { padding-top: var(--spacing-lg); }
.demo__actions { display: flex; flex-direction: column; gap: var(--spacing-sm); }
</style>
