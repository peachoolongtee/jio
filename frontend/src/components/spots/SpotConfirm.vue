<script setup>
// The foot of the Locate screen while the group is choosing where to meet. The host sees the screen's one main action,
// "Confirm <area>", which works at any time (nobody is waited for); everyone else sees who is waiting on whom.
//   <SpotConfirm :session="session" :is-host="isHost" host-name="Ian" :selected-id="shown" :disabled="loading"
//                @error="error = $event" />
// selectedId: the area the host has selected in the list (or the one most people chose). It moves the session to Voting; the
// screen sees the status change and takes the host on, so there is no event for it.
// Emits error (a message from the data layer; nothing was saved). While it saves, here or in the list's "Meet at …" (one flag in the
// events store, `confirming`), the button reads "Confirming…" and says so (aria-busy) but stays enabled, so the keyboard focus stays
// on it if the save fails; a press while any confirm is running is ignored. The words are on the button itself, so they show on a phone
// where the map, and its spinner, are out of view.
// The host never waits for anyone (Faith's walkthrough, 30 October 2026: "Continue without …" for each person is gone). When some people
// have not shared where they start, pressing Confirm first asks once, naming them: the spot is fair on the trips that are known, and the
// others stay in the session.
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { useEventsStore, waitingFor } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  isHost: { type: Boolean, default: false },
  hostName: { type: String, default: 'the host' },
  selectedId: { type: String, default: '' },
  // Something else is in flight (the planner is finding the meeting point).
  disabled: { type: Boolean, default: false },
  // (id) => name, for the people the warning names.
  names: { type: Function, default: (id) => id },
})
const emit = defineEmits(['error'])

const events = useEventsStore()
const working = ref(false)
const spot = computed(() => (props.session.spots?.list || []).find((s) => s.areaId === props.selectedId) || null)
// A confirm is running, started here or by the list's "Meet at …".
const saving = computed(() => working.value || events.confirming)
const label = computed(() => (props.disabled ? 'Finding the meeting point…' : saving.value ? 'Confirming…' : spot.value ? `Confirm ${spot.value.area.name}` : 'Confirm a spot'))

// Who has not shared a start yet, by name, and the sentence that names them. How to call: missingText.value -> 'Faith and Nicole have'
const missing = computed(() => waitingFor(props.session).map((id) => props.names(id)))
const missingText = computed(() => {
  const list = missing.value
  if (list.length <= 2) return `${list.join(' and ')} ${list.length === 1 ? 'has' : 'have'}`
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} ${list.length - 2 === 1 ? 'other' : 'others'} have`
})
const warnOpen = ref(false)

// The button: ask first when anyone has not shared a start, otherwise settle at once. How to call: press()
function press() {
  if (!spot.value || saving.value) return
  if (missing.value.length) warnOpen.value = true
  else confirm()
}

// Settle on the selected spot. The host may do this before anyone has said which spots work for them.
// How to call: confirm()
async function confirm() {
  warnOpen.value = false
  if (!spot.value || saving.value) return
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
  <AppButton v-if="isHost" next block :disabled="!spot || disabled" :aria-busy="saving ? 'true' : undefined" @click="press"><span class="confirm__label">{{ label }}</span></AppButton>
  <p v-else class="confirm__wait body-md"><AppIcon name="clock" :size="18" />Waiting for {{ hostName }} to confirm</p>
  <ModalDialog v-if="isHost" v-model:open="warnOpen" :title="`Confirm ${spot?.area.name || 'this spot'} without everyone?`" :text="`${missingText} not shared where they start, so their trips are not counted. They stay in the session.`">
    <AppButton block variant="secondary" @click="warnOpen = false">Keep waiting</AppButton>
    <AppButton block data-testid="confirm-anyway" @click="confirm">Confirm {{ spot?.area.name || 'spot' }}</AppButton>
  </ModalDialog>
</template>

<style scoped>
/* A long area name is cut with an ellipsis inside the button instead of pushing past the screen's edge. */
.confirm__label { display: block; max-width: calc(100vw - 2 * var(--gutter) - 2 * var(--spacing-lg) - 30px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 744px) { .confirm__label { max-width: 32ch; } }
.confirm__wait { display: flex; align-items: center; justify-content: center; gap: var(--spacing-sm); min-height: 48px; margin: 0; color: var(--body); text-align: center; }
@media (min-width: 744px) { .confirm__wait { justify-content: flex-end; } }
</style>
