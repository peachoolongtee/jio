<script setup>
// The top of every session screen: back arrow, title, date, the status pill, the session's sections
// and a menu with Cancel session (and Invite friends once the session has started).
//   <SessionHeader :session="session" :title="'Today\'s plan'" />
import { computed, ref } from 'vue'
import { RouterLink, useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import BottomSheet from '../ui/BottomSheet.vue'
import IconButton from '../ui/IconButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import CountdownChip from '../ui/CountdownChip.vue'
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
  const list = [{ to: `/sessions/${id}`, label: 'People', exact: true }]
  if (['voting', 'confirmed', 'completed'].includes(s) || (s === 'cancelled' && props.session.meeting)) list.push({ to: `/sessions/${id}/plan`, label: 'Activities' })
  if (['confirmed', 'completed'].includes(s) || (s === 'cancelled' && props.session.plan)) list.push({ to: `/sessions/${id}/itinerary`, label: 'Itinerary' })
  if (['confirmed', 'completed'].includes(s)) list.push({ to: `/sessions/${id}/photos`, label: 'Photos' })
  return list
})
// While inviting, the page has its own Invite button, so the menu does not repeat it.
const canInvite = computed(() => ['locating', 'voting'].includes(status.value))
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
      <span class="session-head__actions">
        <!-- Screen-specific icon actions, for example Ask AI and Edit on the itinerary. -->
        <slot name="actions" />
        <IconButton v-if="canInvite || canCancel" label="Session options" @click="menuOpen = true"><AppIcon name="more" /></IconButton>
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
        <span class="session-head__underline" aria-hidden="true" />
      </RouterLink>
    </nav>

    <BottomSheet v-model:open="menuOpen" title="Session options">
      <AppButton v-if="canInvite" block variant="secondary" @click="goInvite">
        <AppIcon name="user-plus" />
        Invite friends
      </AppButton>
      <p v-if="canCancel" class="body-sm text-muted">Cancelling calls the meetup off for everyone in it. It cannot be undone.</p>
      <AppButton v-if="canCancel" block variant="danger" @click="askCancel">
        <AppIcon name="close" />
        Cancel session
      </AppButton>
    </BottomSheet>

    <ModalDialog v-model:open="cancelOpen" title="Cancel this session?">
      <template #content><p class="body-md text-muted">The meetup is called off for everyone in it and moves to your past sessions. This cannot be undone.</p></template>
      <AppButton block variant="secondary" @click="cancelOpen = false">Keep session</AppButton>
      <AppButton block variant="danger" :disabled="busy" @click="cancelSession">Cancel session</AppButton>
    </ModalDialog>
  </header>
</template>

<style scoped>
.session-head__spacer { width: var(--tap-min); }
.session-head__actions { display: flex; align-items: center; gap: var(--spacing-sm); }
@media (max-width: 743.98px) { .session-head__nav { gap: var(--spacing-base); } }
.session-head__meta { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
/* The session's sections, as Airbnb product tabs: muted labels, the current one ink with a 2px ink rule. */
.session-head__nav { display: flex; gap: var(--spacing-lg); max-width: 100%; margin-top: var(--spacing-sm); overflow-x: auto; border-bottom: 1px solid var(--hairline); scrollbar-width: none; }
.session-head__nav::-webkit-scrollbar { display: none; }
.session-head__link { position: relative; flex: none; display: inline-flex; align-items: center; min-height: var(--tap-min); margin-bottom: -1px; border-bottom: 2px solid transparent; color: var(--muted); font: var(--text-button-sm); text-decoration: none; white-space: nowrap; transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.session-head__link.is-active { color: var(--ink); font-weight: 600; }
/* The current tab's 2px ink rule. It is its own element so a page change can slide it to the next tab. */
.session-head__underline { position: absolute; left: 0; right: 0; bottom: -2px; height: 2px; border-radius: var(--rounded-full); }
.session-head__link.is-active .session-head__underline { background: var(--ink); view-transition-name: session-tab; }
.session-head__link:focus-visible { outline-offset: -2px; }
@media (hover: hover) { .session-head__link:not(.is-active):hover { color: var(--ink); border-bottom-color: var(--hairline); } }
</style>
