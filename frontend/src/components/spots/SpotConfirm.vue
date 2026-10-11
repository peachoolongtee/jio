<script setup>
// The foot of the Locate screen while the group is choosing where to meet. The host sees the screen's one main action,
// "Confirm <area>", which works at any time (nobody is waited for); everyone else sees who is waiting on whom.
//   <SpotConfirm :session="session" :is-host="isHost" host-name="Ian" :selected-id="shown" :disabled="loading"
//                @error="error = $event" />
// selectedId: the area the host has selected in the list (or the one most people chose). It moves the session to Voting; the
// screen sees the status change and takes the host on, so there is no event for it.
// Emits error (a message from the data layer; nothing was saved). While it saves the button says so (aria-busy) but stays
// enabled, so the keyboard focus stays on it if the save fails; a second press is ignored.
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  isHost: { type: Boolean, default: false },
  hostName: { type: String, default: 'the host' },
  selectedId: { type: String, default: '' },
  // Something else is in flight (the planner is finding the meeting point).
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['error'])

const events = useEventsStore()
const working = ref(false)
const spot = computed(() => (props.session.spots?.list || []).find((s) => s.areaId === props.selectedId) || null)
const label = computed(() => (props.disabled ? 'Finding the meeting point…' : spot.value ? `Confirm ${spot.value.area.name}` : 'Confirm a spot'))

// Settle on the selected spot. The host may do this before anyone has said which spots work for them.
// How to call: confirm()
async function confirm() {
  if (!spot.value || working.value) return
  working.value = true
  emit('error', '')
  try {
    await events.confirmSpot(props.session.id, spot.value.areaId)
  } catch (e) {
    emit('error', e.message)
  }
  working.value = false
}
</script>

<template>
  <AppButton v-if="isHost" next block :disabled="!spot || disabled" :aria-busy="working ? 'true' : undefined" @click="confirm"><span class="confirm__label">{{ label }}</span></AppButton>
  <p v-else class="confirm__wait body-md"><AppIcon name="clock" :size="18" />Waiting for {{ hostName }} to confirm</p>
</template>

<style scoped>
/* A long area name is cut with an ellipsis inside the button instead of pushing past the screen's edge. */
.confirm__label { display: block; max-width: calc(100vw - 2 * var(--gutter) - 2 * var(--spacing-lg) - 30px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 744px) { .confirm__label { max-width: 32ch; } }
.confirm__wait { display: flex; align-items: center; justify-content: center; gap: var(--spacing-sm); min-height: 48px; margin: 0; color: var(--body); text-align: center; }
@media (min-width: 744px) { .confirm__wait { justify-content: flex-end; } }
</style>
