<script setup>
// The host's invite link for a shared session: make it, copy or share it, turn it off.
//   <ShareLink :session-id="session.id" :title="session.title" />
// A session has one link. It works for seven days, for anyone who has it, signed up or not; the host can turn it off at
// any time and make a new one. States: loading the link, no link yet, a link, an expired link (it must be replaced), and
// a failed load or write (a sentence and a Retry). Copying says so in words for a screen reader, and when the browser will
// not copy the link is selected instead. "Share" shows only where the browser has a share sheet.
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { useRouter } from 'vue-router'
import { format } from 'date-fns'
import AppButton from '../ui/AppButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import SkeletonRow from '../ui/SkeletonRow.vue'
import * as api from '@/lib/api.js'

const props = defineProps({
  sessionId: { type: String, required: true },
  title: { type: String, default: '' },
  // In a small popover: no "Turn off link", whose question would open outside the popover and close it. The invite page has it.
  compact: { type: Boolean, default: false },
})

const router = useRouter()
const fieldId = `link-${useId()}`
// The link as the data layer gives it: { token, path, expiresAt, expired }, or null when there is none.
const link = ref(null)
// 'loading', 'ready' or 'failed' (the load).
const phase = ref('loading')
const busy = ref('')
const error = ref('')
const note = ref('')
const offOpen = ref(false)
const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
let ticket = 0
let noteTimer = 0

// The address to share: this site's own origin and the link's path.
const url = computed(() => (link.value ? `${typeof location !== 'undefined' ? location.origin : ''}${router.resolve(link.value.path).href}` : ''))
const until = computed(() => (link.value ? format(new Date(link.value.expiresAt), 'EEE d MMM, HH:mm') : ''))

// Read the session's link. A newer read wins over an older one.
// How to call: await load()
async function load() {
  const mine = ++ticket
  phase.value = 'loading'
  error.value = ''
  try {
    const found = await api.getInviteLink(props.sessionId)
    if (mine !== ticket) return
    link.value = found
    phase.value = 'ready'
  } catch (e) {
    if (mine !== ticket) return
    error.value = e?.message || 'The link could not be loaded.'
    phase.value = 'failed'
  }
}
onMounted(load)
watch(() => props.sessionId, load)
onBeforeUnmount(() => {
  ticket += 1
  clearTimeout(noteTimer)
})

// How to call: say('Link copied.')
function say(text) {
  note.value = text
  clearTimeout(noteTimer)
  noteTimer = setTimeout(() => (note.value = ''), 4000)
}

// Make a link (a new one when the old has expired). How to call: await make()
async function make() {
  if (busy.value) return
  busy.value = 'make'
  error.value = ''
  try {
    link.value = await api.makeInviteLink(props.sessionId)
    phase.value = 'ready'
  } catch (e) {
    error.value = e?.message || 'The link could not be made. Try again.'
  }
  busy.value = ''
}

// Turn the link off for good, after the host has confirmed. How to call: await turnOff()
async function turnOff() {
  if (busy.value) return
  busy.value = 'off'
  error.value = ''
  try {
    await api.revokeInviteLink(props.sessionId)
    link.value = null
    offOpen.value = false
    say('The link is off. Nobody can join with it now.')
  } catch (e) {
    error.value = e?.message || 'The link could not be turned off. Try again.'
  }
  busy.value = ''
}

// Copy the link; where the browser will not, select it so it can be copied by hand.
// How to call: await copy()
async function copy() {
  try {
    await navigator.clipboard.writeText(url.value)
    say('Link copied.')
  } catch {
    document.getElementById(fieldId)?.select()
    say('The link is selected. Copy it with your keyboard.')
  }
}

// How to call: await share()
async function share() {
  try {
    await navigator.share({ title: props.title || 'Jio', text: `Join ${props.title || 'my session'} on Jio`, url: url.value })
  } catch (e) {
    if (e?.name !== 'AbortError') error.value = 'The link could not be shared. Copy it instead.'
  }
}
</script>

<template>
  <section class="share" aria-labelledby="share-head" data-testid="share-link">
    <h3 id="share-head" class="title-sm">Invite link</h3>

    <SkeletonRow v-if="phase === 'loading'" :lines="2" />

    <template v-else-if="phase === 'failed'">
      <p class="body-sm text-error" role="alert">{{ error }}</p>
      <AppButton variant="secondary" small @click="load">Retry</AppButton>
    </template>

    <!-- A link: the address to copy or share, how long it works, and the way to turn it off. -->
    <template v-else-if="link && !link.expired">
      <label class="share__label caption text-muted" :for="fieldId">Anyone with this link can join</label>
      <input :id="fieldId" class="share__field" :value="url" readonly spellcheck="false" autocomplete="off" @focus="$event.target.select()" />
      <p class="caption-sm text-muted">It works until {{ until }}.</p>
      <div class="share__actions">
        <AppButton small :disabled="!!busy" @click="copy">Copy link</AppButton>
        <AppButton v-if="canShare" small variant="secondary" :disabled="!!busy" @click="share">Share</AppButton>
        <AppButton v-if="!compact" small variant="tertiary" underline :disabled="!!busy" @click="offOpen = true">Turn off link</AppButton>
      </div>
    </template>

    <!-- The link ran out: it cannot be used, and a new one replaces it. -->
    <template v-else-if="link">
      <p class="body-sm">The link ran out on {{ until }}. Nobody can join with it now.</p>
      <AppButton small :disabled="!!busy" @click="make">{{ busy === 'make' ? 'Making a new link' : 'Make a new link' }}</AppButton>
    </template>

    <!-- No link yet, or it was turned off. -->
    <template v-else>
      <div class="share__actions">
        <AppButton small :disabled="!!busy" @click="make">{{ busy === 'make' ? 'Making the link' : 'Make a link' }}</AppButton>
      </div>
    </template>

    <p v-if="error && phase !== 'failed'" class="body-sm text-error" role="alert">{{ error }}</p>
    <p class="sr-only" role="status">{{ note }}</p>
    <p v-if="note" class="caption-sm share__note" aria-hidden="true">{{ note }}</p>

    <ModalDialog v-model:open="offOpen" title="Turn off this link?" text="Nobody can join with it after this. You can make a new link whenever you like.">
      <AppButton block variant="secondary" @click="offOpen = false">Keep link</AppButton>
      <AppButton block variant="danger" :disabled="busy === 'off'" @click="turnOff">Turn off link</AppButton>
    </ModalDialog>
  </section>
</template>

<style scoped>
.share { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.share h3 { margin: 0; }
.share__label { margin-top: var(--spacing-xxs); }
.share__field { width: 100%; height: var(--tap-min); padding: 0 var(--spacing-md); border: 1px solid var(--hairline); border-radius: var(--rounded-sm); background: var(--surface-soft); color: var(--ink); font: var(--text-body-sm); text-overflow: ellipsis; }
.share__field:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.share__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
.share__note { color: var(--ink); }
</style>
