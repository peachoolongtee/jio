<script setup>
// The top of every session screen: back arrow, title, date, and the session's steps as a progress bar you can click
// through (SessionSteps). Top right: Invite (once the session has started, while people can still join) and a
// "Hold to end" button: hold it until it fills, then confirm, to end the session for everyone.
//   <SessionHeader :session="session" :title="'Today\'s plan'" />
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import HoldButton from '../ui/HoldButton.vue'
import IconButton from '../ui/IconButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import CountdownChip from '../ui/CountdownChip.vue'
import SessionSteps from './SessionSteps.vue'
import InviteDialog from '../group/InviteDialog.vue'
import { dateLine } from '@/lib/session.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  // Replaces the session title, for example "Today's plan".
  title: { type: String, default: '' },
  back: { type: String, default: '/' },
})

const events = useEventsStore()
const cancelOpen = ref(false)
const inviteOpen = ref(false)
const busy = ref(false)

const status = computed(() => props.session.status)
// While inviting, the page has its own Invite button, so the header does not repeat it.
const canInvite = computed(() => ['locating', 'voting'].includes(status.value))
const canCancel = computed(() => !['completed', 'cancelled'].includes(status.value))

async function cancelSession() {
  busy.value = true
  await events.cancel(props.session.id)
  busy.value = false
  cancelOpen.value = false
}
</script>

<template>
  <header class="screen__header session-head">
    <div class="screen__bar">
      <IconButton label="Back" :to="back"><AppIcon name="back" /></IconButton>
      <span class="session-head__actions">
        <!-- Screen-specific icon actions, for example Map and Edit on the itinerary. -->
        <slot name="actions" />
        <IconButton v-if="canInvite" label="Invite friends" @click="inviteOpen = true"><AppIcon name="user-plus" /></IconButton>
        <HoldButton v-if="canCancel" label="Hold to end" action="End session" @done="cancelOpen = true" />
        <span v-else-if="!$slots.actions" class="session-head__spacer" />
      </span>
    </div>
    <div class="screen__titles">
      <h1 class="display-xl clamp-2">{{ title || session.title }}</h1>
      <p class="session-head__meta">
        <span class="body-sm text-muted tnum">{{ title ? session.title : dateLine(session) }}</span>
        <CountdownChip :session="session" />
      </p>
    </div>
    <SessionSteps :session="session" />

    <InviteDialog v-model:open="inviteOpen" :session="session" />

    <ModalDialog v-model:open="cancelOpen" title="End this session?">
      <template #content><p class="body-md text-muted">It ends for everyone in it and moves to your past sessions. This cannot be undone.</p></template>
      <AppButton block variant="secondary" @click="cancelOpen = false">Keep session</AppButton>
      <AppButton block variant="danger" :disabled="busy" @click="cancelSession">End session</AppButton>
    </ModalDialog>
  </header>
</template>

<style scoped>
.session-head__spacer { width: var(--tap-min); }
.session-head__actions { display: flex; align-items: center; gap: var(--spacing-sm); }
.session-head__meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
</style>
