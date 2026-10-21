<script setup>
// The top of every session screen: the button at the top left, the session's steps as a progress bar you can click
// through (SessionSteps), then the title and date. The button is a back arrow: it leaves the session for the screen it
// was opened from (Home, Sessions, the profile; Home when that is not known), and on the photos and the full map it
// goes back to the Itinerary (backFor in SessionSteps, exitFor in lib/stepNav.js). Top right: Invite (once the session has started,
// while people can still join) and a "Hold to cancel" button: hold it until it fills, then confirm "Cancel outing", to
// call the outing off for everyone. A screen reader, switch or voice control activates it with one press; the
// confirmation follows either way.
//   <SessionHeader :session="session" :title="'Today\'s plan'" />
import { computed, ref } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import HoldButton from '../ui/HoldButton.vue'
import IconButton from '../ui/IconButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import CountdownChip from '../ui/CountdownChip.vue'
import SessionSteps, { backFor } from './SessionSteps.vue'
import InviteDialog from '../group/InviteDialog.vue'
import { CANCEL_OUTING, dateLine } from '@/lib/session.js'
import { exitFor, goBackIfBehind } from '@/lib/stepNav.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  // Replaces the session title, for example "Today's plan".
  title: { type: String, default: '' },
  // Where the back arrow goes. Leave it out and it follows the steps (backFor).
  back: { type: String, default: '' },
})

const route = useRoute()
const router = useRouter()
const events = useEventsStore()
const auth = useAuthStore()
const cancelOpen = ref(false)
const inviteOpen = ref(false)
const busy = ref(false)

const status = computed(() => props.session.status)
const back = computed(() => (props.back ? { label: 'Back', to: props.back } : backFor(props.session, route.fullPath, props.session.hostId === auth.myId, exitFor())))
// While inviting, the page has its own Invite button, so the header does not repeat it.
const canInvite = computed(() => ['locating', 'voting'].includes(status.value))
// Only the host can call a shared session (one kept on the server) off; a guest leaves it instead, from its page.
const canCancel = computed(() => !['completed', 'cancelled'].includes(status.value) && (!props.session.remote || props.session.hostId === auth.myId))

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
      <IconButton :label="back.label" :to="back.to" @click.capture="goBackIfBehind($event, router, back.to)"><AppIcon name="back" /></IconButton>
      <span class="session-head__actions">
        <!-- Screen-specific icon actions, for example Map and Edit on the itinerary. -->
        <slot name="actions" />
        <IconButton v-if="canInvite" label="Invite friends" @click="inviteOpen = true"><AppIcon name="user-plus" /></IconButton>
        <HoldButton v-if="canCancel" :label="CANCEL_OUTING.hold" :action="CANCEL_OUTING.action" @done="cancelOpen = true" />
        <span v-else-if="!$slots.actions" class="session-head__spacer" />
      </span>
    </div>
    <!-- The steps come before the title, so they are in the same place on every session screen whatever the title's length. -->
    <SessionSteps :session="session" />
    <div class="screen__titles">
      <h1 class="display-xl clamp-2">{{ title || session.title }}</h1>
      <p class="session-head__meta">
        <span class="body-sm text-muted tnum">{{ title ? session.title : dateLine(session) }}</span>
        <CountdownChip :session="session" />
      </p>
    </div>

    <InviteDialog v-model:open="inviteOpen" :session="session" />

    <ModalDialog v-model:open="cancelOpen" :title="CANCEL_OUTING.title">
      <template #content><p class="body-md text-muted">{{ CANCEL_OUTING.text }}</p></template>
      <AppButton block variant="secondary" @click="cancelOpen = false">{{ CANCEL_OUTING.keep }}</AppButton>
      <AppButton block variant="danger" :disabled="busy" @click="cancelSession">{{ CANCEL_OUTING.confirm }}</AppButton>
    </ModalDialog>
  </header>
</template>

<style scoped>
.session-head__spacer { width: var(--tap-min); }
.session-head__actions { display: flex; align-items: center; gap: var(--spacing-sm); }
.session-head__meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
</style>
