<script setup>
// The page an invite link opens: /join/<token>. Anyone can see what they are being invited to (the session's title, day,
// times and the host's name) without an account. Signed out, they sign up or log in and are brought back here. Signed in,
// "Join session" joins and opens the session. It never shows more than the preview, and never a raw error.
//
// States, in the order a person meets them:
//   loading     the preview is being read
//   offline     the preview could not be read: a sentence and Retry
//   unusable    the link does not work (expired, replaced or turned off by the host, meant for someone else, already used,
//               the session under way or over, or a mistyped link). The database answers all of these the same on purpose,
//               so the page names them together
//   invited     the preview, with Sign up and Log in (signed out) or Join session (signed in)
//   already     the person is in the session (or hosts it): "Open session"
//   not real    a demo or local account cannot join a shared session: log in with a Jio account
//   joining     the join is under way; a failure is said under the button (a full session, a link that stopped working)
import { computed, onMounted, ref, watch } from 'vue'
import { useRouter } from 'vue-router'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import JioLogo from '@/components/ui/JioLogo.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import * as api from '@/lib/api.js'
import { dateLine } from '@/lib/session.js'
import { WORDS } from '@/lib/sessionsRemote.js'
import { useAuthStore } from '@/stores/auth.js'

const props = defineProps({ token: { type: String, required: true } })

const router = useRouter()
const auth = useAuthStore()

// 'loading', 'offline', 'unusable', 'invited' (the preview), 'already' or 'full' (after trying to join).
const phase = ref('loading')
const preview = ref(null)
const message = ref('')
const joining = ref(false)
const problem = ref('')
// The session found when the person was already in it.
const found = ref(null)
let ticket = 0

// Where "Sign up" and "Log in" come back to: this page, as the guard remembers it.
const here = computed(() => `/join/${props.token}`)
const toSignUp = computed(() => ({ path: '/signup', query: { next: here.value } }))
const toLogin = computed(() => ({ path: '/login', query: { next: here.value } }))
const signedIn = computed(() => auth.signedIn)
// A demo or local account lives in this browser only; a shared session needs a real one.
const notReal = computed(() => auth.signedIn && auth.sampleWorld)
const shareable = api.sharingAvailable()

// Read the preview. A newer read wins over an older one.
// How to call: await load()
async function load() {
  const mine = ++ticket
  phase.value = 'loading'
  problem.value = ''
  if (!shareable) {
    phase.value = 'unusable'
    message.value = 'Invite links need a Jio account, and this copy of Jio has none set up.'
    return
  }
  try {
    const found = await api.previewInvite(props.token)
    if (mine !== ticket) return
    preview.value = found
    if (found) phase.value = 'invited'
    else {
      phase.value = 'unusable'
      message.value = WORDS.linkDeadWhy
    }
  } catch (e) {
    if (mine !== ticket) return
    phase.value = 'offline'
    message.value = e?.message || WORDS.offline
  }
}
onMounted(load)
watch(() => props.token, load)
// Signing in on this page (or out) can change what the preview shows (a personal invitation previews only to its person).
watch(() => auth.myId, () => {
  if (phase.value === 'invited' || phase.value === 'unusable') load()
})

// Join, then open the session. A person who was in it already is told so and given a button to open it.
// How to call: await join()
async function join() {
  if (joining.value) return
  joining.value = true
  problem.value = ''
  try {
    const { sessionId, already } = await api.joinWithLink(props.token)
    if (!already) {
      auth.askDietOnce()
      await router.replace(`/sessions/${sessionId}`)
      return
    }
    found.value = { id: sessionId }
    phase.value = 'already'
  } catch (e) {
    // A link that stopped working since the preview was read: show the page for that, not a message under a dead button.
    if (e?.code === 'P0002') {
      phase.value = 'unusable'
      message.value = WORDS.linkDeadWhy
    } else {
      problem.value = e?.message || WORDS.notSaved
    }
  }
  joining.value = false
}
</script>

<template>
  <main class="screen screen--form join" data-testid="join-view" :aria-busy="phase === 'loading'">
    <header class="screen__header">
      <div class="screen__bar"><JioLogo :height="36" /></div>
    </header>

    <div v-if="phase === 'loading'" class="screen__body join__body" role="status">
      <span class="sr-only">Loading the invitation</span>
      <SkeletonRow :lines="3" />
    </div>

    <div v-else-if="phase === 'offline'" class="screen__body join__body">
      <EmptyState title="Could not load this invitation" :text="message">
        <AppButton variant="secondary" @click="load">Retry</AppButton>
      </EmptyState>
    </div>

    <div v-else-if="phase === 'unusable'" class="screen__body join__body" data-testid="join-unusable">
      <EmptyState title="This link no longer works" :text="message">
        <AppButton v-if="signedIn" to="/">Back to Home</AppButton>
        <AppButton v-else variant="secondary" :to="toLogin">Log in</AppButton>
      </EmptyState>
    </div>

    <div v-else-if="phase === 'already'" class="screen__body join__body" data-testid="join-already">
      <EmptyState :title="`You are already in ${preview?.title || 'this session'}`" text="Nothing changed. Open it to carry on.">
        <AppButton :to="`/sessions/${found.id}`">Open session</AppButton>
      </EmptyState>
    </div>

    <template v-else>
      <div class="screen__body join__body">
        <p class="caption text-muted">{{ preview.hostName || 'Someone' }} invited you to</p>
        <h1 class="display-xl clamp-2">{{ preview.title }}</h1>
        <p class="body-md tnum">{{ dateLine(preview) }}</p>
        <p v-if="!signedIn" class="body-md text-muted">Sign up or log in to join. You will come back to this page.</p>
        <p v-else-if="notReal" class="body-md" role="alert">A demo account cannot join a shared session. Log out, then log in with a Jio account.</p>
        <p v-if="problem" class="body-sm text-error" role="alert" data-testid="join-problem">{{ problem }}</p>
      </div>

      <footer class="screen__footer join__footer">
        <template v-if="!signedIn">
          <AppButton next block :to="toSignUp">Sign up to join</AppButton>
          <AppButton variant="tertiary" underline :to="toLogin" class="join__alt">I have an account. Log in</AppButton>
        </template>
        <AppButton v-else-if="!notReal" next block :disabled="joining" @click="join">{{ joining ? 'Joining' : 'Join session' }}</AppButton>
      </footer>
    </template>
  </main>
</template>

<style scoped>
.join { min-height: 100dvh; }
.join__body { padding-top: var(--spacing-lg); }
.join__body h1 { margin: 0; }
.join__alt { align-self: center; }
/* On desktop the footer buttons stay in the form column, as on the login screen. */
@media (min-width: 1128px) {
  .join__footer { flex-direction: column; align-items: stretch; border-top: 0; }
  .join__footer > :deep(.btn--block) { width: 100%; }
}
</style>
