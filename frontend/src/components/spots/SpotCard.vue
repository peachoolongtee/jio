<script setup>
// What the card at a meeting spot's pin on the Locate map says: its name, who put it forward, the longest trip, how many
// people it works for and, while the group is choosing, "Vote" under that count, the same toggle as the spot's row.
//   <SpotCard :spot="spot" :session="session" my-id="ian" :confirmed="false" />
// spot: one entry of the list SpotPins draws. session: the session summary (lib/api.js), or null for a card with no
// control. confirmed: this is the spot the host confirmed.
// "Vote" shows only while the person may approve (spotText.js canApprove: the session is locating and they are in
// it), marks only their own choice, and goes through spotChange.js, the list's way, so the count changes in place when the
// session does. A refusal is said in the card. The host also has "Confirm <area>" here while the group is choosing (walkthrough,
// 30 October 2026: on a phone the map is where the host looks, and the footer's button is far from the pin). It is the same confirm as
// the footer's (events.confirmSpot, with the store's `confirming` flag shared, so a second press while either runs is ignored); the
// screen sees the session move to Voting, as after the footer's.
// Only areas are shown, never a member's exact place.
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import ChipButton from '../ui/ChipButton.vue'
import { useEventsStore } from '@/stores/events.js'
import { useSpotChange } from './spotChange.js'
import { ABOUT_NOTE, byLine, canApprove, isChoosing, tripsLine, votesText } from './spotText.js'

const props = defineProps({
  spot: { type: Object, required: true },
  session: { type: Object, default: null },
  myId: { type: String, default: '' },
  confirmed: { type: Boolean, default: false },
  isHost: { type: Boolean, default: false },
})
const events = useEventsStore()
// The host, while the group is choosing: the card can confirm this spot.
const canConfirm = computed(() => props.isHost && !!props.session && isChoosing(props.session) && !props.confirmed)

// Settle on this spot, as the footer's "Confirm <area>" does. How to call: await confirm()
async function confirm() {
  if (events.confirming) return
  error.value = ''
  try {
    await events.confirmSpot(props.session.id, props.spot.areaId)
  } catch (e) {
    error.value = e?.message || 'Could not confirm. Try again.'
  }
}

const { busy, approve: approveSpot } = useSpotChange()
const error = ref('')
const approving = computed(() => !!props.session && canApprove(props.session, props.myId))
const mine = computed(() => (props.session?.spots?.approvals?.[props.myId] || []).includes(props.spot.areaId))

// Say this spot works for you, or take that back.
// How to call: <ChipButton @click="toggle">
async function toggle() {
  if (busy.value) return
  error.value = ''
  const message = await approveSpot(props.session.id, props.spot.areaId, !mine.value)
  if (message) error.value = message
}
</script>

<template>
  <div class="spotcard">
    <p class="title-md">{{ spot.area.name }}</p>
    <p v-if="confirmed" class="body-sm"><strong>Confirmed</strong></p>
    <p class="caption-sm text-muted">{{ byLine(spot, myId) }}<template v-if="spot.here"> · We are here already</template></p>
    <p v-if="tripsLine(spot)" class="body-sm tnum" :title="spot.approximate ? ABOUT_NOTE : undefined">{{ tripsLine(spot) }}</p>
    <p class="body-sm" :class="{ 'text-muted': !spot.approvalCount }">{{ votesText(spot) }}</p>
    <ChipButton v-if="approving" check class="spotcard__works" :selected="mine" :aria-busy="busy ? 'true' : undefined" :aria-label="`Vote for ${spot.area.name}`" @click="toggle">Vote</ChipButton>
    <AppButton v-if="canConfirm" small class="spotcard__confirm" :aria-busy="events.confirming ? 'true' : undefined" data-testid="pin-confirm" @click="confirm">{{ events.confirming ? 'Confirming…' : `Confirm ${spot.area.name}` }}</AppButton>
    <p v-if="error" class="caption-sm text-error" role="alert">{{ error }}</p>
  </div>
</template>

<style scoped>
.spotcard { display: flex; flex-direction: column; gap: var(--spacing-xs); min-width: 0; }
.spotcard p { margin: 0; overflow-wrap: anywhere; }
.spotcard__works { align-self: flex-start; }
.spotcard__confirm { align-self: stretch; }
</style>
