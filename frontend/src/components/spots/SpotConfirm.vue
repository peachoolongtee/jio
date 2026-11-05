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
// others stay in the session. The host's button on a pin's card (SpotCard) asks the same question here (confirmSpot.js), so a phone,
// where the map's button is the near one, warns too.
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import { useEventsStore, waitingFor } from '@/stores/events.js'
import { useSpotConfirm } from './confirmSpot.js'

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
const { saving, press: pressSpot, confirm: confirmSpot } = useSpotConfirm()
const spotOf = (areaId) => (props.session.spots?.list || []).find((s) => s.areaId === areaId) || null
const spot = computed(() => spotOf(props.selectedId))
const label = computed(() => (props.disabled ? 'Finding the meeting point…' : saving.value ? 'Confirming…' : spot.value ? `Confirm ${spot.value.area.name}` : 'Confirm a spot'))

// The question "Confirm <area> without everyone?", asked by this button or by the host's button on a pin's card (one question, held
// in the events store, because a card closes when the pointer leaves it and this footer does not).
const ask = computed(() => (events.confirmAsk && events.confirmAsk.sessionId === props.session.id ? events.confirmAsk : null))
const askedSpot = computed(() => (ask.value ? spotOf(ask.value.areaId) : null))
const warnOpen = computed({ get: () => !!ask.value, set: (open) => { if (!open) events.confirmAsk = null } })

// Tell the screen what the data layer said. How to call: say(await confirmSpot('s1', 'bugis'))
function say(message) {
  if (message !== undefined) emit('error', message)
}

// The button: ask first when anyone has not shared a start, otherwise settle at once. How to call: press()
async function press() {
  if (!spot.value || saving.value) return
  emit('error', '')
  say(await pressSpot(props.session, spot.value.areaId, props.names))
}

// The dialog's "Confirm <area>": settle on the spot that was asked about. The host may do this before anyone has said which spots work for them.
// How to call: confirm()
async function confirm() {
  if (!ask.value) return
  const { sessionId, areaId } = ask.value
  emit('error', '')
  say(await confirmSpot(sessionId, areaId))
}
</script>

<template>
  <AppButton v-if="isHost" next block :disabled="!spot || disabled" :aria-busy="saving ? 'true' : undefined" @click="press"><span class="confirm__label">{{ label }}</span></AppButton>
  <p v-else class="confirm__wait body-md"><AppIcon name="clock" :size="18" />Waiting for {{ hostName }} to confirm</p>
  <ModalDialog v-if="isHost" v-model:open="warnOpen" :title="`Confirm ${askedSpot?.area.name || 'this spot'} without everyone?`" :text="`${ask?.text || ''} not shared where they start, so their trips are not counted. They stay in the session.`">
    <AppButton block variant="secondary" @click="warnOpen = false">Keep waiting</AppButton>
    <AppButton block data-testid="confirm-anyway" @click="confirm">Confirm {{ askedSpot?.area.name || 'spot' }}</AppButton>
  </ModalDialog>
</template>

<style scoped>
/* A long area name is cut with an ellipsis inside the button instead of pushing past the screen's edge. */
.confirm__label { display: block; max-width: calc(100vw - 2 * var(--gutter) - 2 * var(--spacing-lg) - 30px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
@media (min-width: 744px) { .confirm__label { max-width: 32ch; } }
.confirm__wait { display: flex; align-items: center; justify-content: center; gap: var(--spacing-sm); min-height: 48px; margin: 0; color: var(--body); text-align: center; }
@media (min-width: 744px) { .confirm__wait { justify-content: flex-end; } }
</style>
