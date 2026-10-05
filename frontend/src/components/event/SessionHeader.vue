<script setup>
// The top of every session screen: back arrow, title, date, the status pill, the session's sections
// and a menu with Invite friends and Cancel session.
//   <SessionHeader :session="session" :title="'Today\'s plan'" />
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import BottomSheet from '../ui/BottomSheet.vue'
import IconButton from '../ui/IconButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import StatusPill from '../ui/StatusPill.vue'
import { dateLine } from '@/lib/session.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  // Replaces the session title, for example "Today's plan".
  title: { type: String, default: '' },
  back: { type: String, default: '/' },
})

const router = useRouter()
const events = useEventsStore()
const menuOpen = ref(false)
const cancelOpen = ref(false)
const busy = ref(false)

const status = computed(() => props.session.status)
const sections = computed(() => {
  const id = props.session.id
  const s = status.value
  const list = [{ to: `/sessions/${id}`, label: 'People and area', exact: true }]
  if (['voting', 'confirmed', 'completed'].includes(s) || (s === 'cancelled' && props.session.meeting)) list.push({ to: `/sessions/${id}/plan`, label: 'Activities' })
  if (['confirmed', 'completed'].includes(s) || (s === 'cancelled' && props.session.plan)) list.push({ to: `/sessions/${id}/itinerary`, label: 'Itinerary' })
  return list
})
const canInvite = computed(() => ['inviting', 'locating', 'voting'].includes(status.value))
const canCancel = computed(() => !['completed', 'cancelled'].includes(status.value))

async function cancelSession() {
  busy.value = true
  await events.cancel(props.session.id)
  busy.value = false
  cancelOpen.value = false
}

function goInvite() {
  menuOpen.value = false
  router.push(`/sessions/${props.session.id}/invite`)
}

function askCancel() {
  menuOpen.value = false
  cancelOpen.value = true
}
</script>

<template>
  <header class="screen__header session-head">
    <div class="screen__bar">
      <IconButton label="Back" :to="back"><AppIcon name="back" /></IconButton>
      <StatusPill :status="session.status" />
      <IconButton v-if="canInvite || canCancel" label="Session options" outline @click="menuOpen = true"><AppIcon name="more" /></IconButton>
      <span v-else class="session-head__spacer" />
    </div>
    <div class="screen__titles">
      <h1 class="display-xl clamp-2">{{ title || session.title }}</h1>
      <p class="body-sm text-muted">
        <template v-if="title">{{ session.title }} · </template>{{ dateLine(session) }}
      </p>
    </div>
    <nav v-if="sections.length > 1" class="session-head__nav" aria-label="Session sections">
      <RouterLink
        v-for="section in sections"
        :key="section.to"
        :to="section.to"
        class="session-head__link"
        :exact-active-class="section.exact ? 'is-active' : ''"
        :active-class="section.exact ? '' : 'is-active'"
      >
        {{ section.label }}
      </RouterLink>
    </nav>

    <BottomSheet v-model:open="menuOpen" title="Session options">
      <AppButton v-if="canInvite" block variant="secondary" @click="goInvite">
        <AppIcon name="user-plus" />
        Invite friends
      </AppButton>
      <AppButton v-if="canCancel" block variant="danger" @click="askCancel">
        <AppIcon name="close" />
        Cancel session
      </AppButton>
    </BottomSheet>

    <ModalDialog v-model:open="cancelOpen" title="Cancel this session?">
      <AppButton block variant="secondary" @click="cancelOpen = false">Keep session</AppButton>
      <AppButton block variant="danger" :disabled="busy" @click="cancelSession">Cancel session</AppButton>
    </ModalDialog>
  </header>
</template>

<style scoped>
.session-head__spacer { width: var(--tap-min); }
.session-head__nav { display: flex; gap: var(--spacing-lg); margin-top: var(--spacing-xs); border-bottom: 1px solid var(--hairline); overflow-x: auto; scrollbar-width: none; }
.session-head__nav::-webkit-scrollbar { display: none; }
.session-head__link { flex: none; display: inline-flex; align-items: center; min-height: var(--tap-min); border-bottom: 2px solid transparent; color: var(--muted); font: var(--text-button-sm); text-decoration: none; white-space: nowrap; }
.session-head__link.is-active { border-bottom-color: var(--primary); color: var(--primary); }
.session-head__link:focus-visible { outline-offset: -2px; }
@media (hover: hover) { .session-head__link:not(.is-active):hover { color: var(--ink); } }
</style>
