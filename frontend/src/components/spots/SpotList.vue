<script setup>
// "Where to meet": the meeting spots of a session that is choosing where to meet, with "Works for me" on each, "Suggest a
// spot" (the area picker, in a popover) and, for the host, "We already have a place".
//   <SpotList :session="session" my-id="ian" :names="nameOf" :selected-id="shown" :is-host="true" host-name="Ian"
//             @select="picked = $event" @error="error = $event" />
// session: a session summary (lib/api.js). selectedId: the area shown as chosen (SpotRow outlines it; the map's pin matches).
// Changes go through the events store as the signed-in person: approveMySpot, suggestMySpot, withdrawMySpot, and the
// host's setKnownPlace. A refusal or a planner failure is sentence-sized and goes up as `error` (the write has rolled back).
// Emits select (an area id) and error (a message, or '' to clear). Setting a known place moves the session on to Voting;
// the screen sees the status change and takes the host there, so there is no event for it.
// States: fewer than two starts (no list; says what opens it), the planner working it out (placeholder rows), the list,
// the list while its times are updated, and your own suggestion with no row (a reload caught it before it was priced):
// "Try again" prices it, "Withdraw" takes it back.
// A control that starts a change stays enabled while it saves (aria-busy), so a key press never drops the keyboard focus; a
// second press is ignored until the first is saved.
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import SkeletonRow from '../ui/SkeletonRow.vue'
import LocationSheet from '../group/LocationSheet.vue'
import SpotRow from './SpotRow.vue'
import { AREAS } from '@/lib/mock/places.js'
import { TRAVEL_TONES } from '@/lib/planner/travel.js'
import { useEventsStore } from '@/stores/events.js'
import { canApprove, canSuggest, isChoosing, startsShared, unpricedSuggestion } from './spotText.js'

const props = defineProps({
  session: { type: Object, required: true },
  myId: { type: String, default: '' },
  // (id) => name.
  names: { type: Function, default: (id) => id },
  selectedId: { type: String, default: '' },
  isHost: { type: Boolean, default: false },
  hostName: { type: String, default: 'the host' },
})
const emit = defineEmits(['select', 'error'])

const events = useEventsStore()
const busy = ref(false)
const suggestOpen = ref(false)
const placeOpen = ref(false)
const confirmOpen = ref(false)
const placeArea = ref(null)
const dialogError = ref('')

const spots = computed(() => props.session.spots || { list: [], approvals: {}, suggestions: {}, preselectedAreaId: null, appMethod: null })
const list = computed(() => spots.value.list)
const mine = computed(() => new Set(spots.value.approvals?.[props.myId] || []))
const own = computed(() => spots.value.suggestions?.[props.myId] || null)
const unpriced = computed(() => unpricedSuggestion(props.session, props.myId))
const shared = computed(() => startsShared(props.session))
const total = computed(() => (props.session.activeIds || []).length)
const offerSuggest = computed(() => canSuggest(props.session, props.myId))
const offerKnown = computed(() => props.isHost && isChoosing(props.session))
const approving = computed(() => canApprove(props.session, props.myId))
// "Fairest" belongs to the app's first spot, and only when the planner really chose it by fairness.
const fairestId = computed(() => (spots.value.appMethod === 'fairest' ? list.value.find((s) => s.by === 'app')?.areaId : ''))
const leadingId = computed(() => {
  const spot = list.value.find((s) => s.areaId === spots.value.preselectedAreaId)
  return spot && spot.approvalCount > 0 ? spot.areaId : ''
})
const hasTrips = computed(() => list.value.some((s) => Object.keys(s.times || {}).length > 0))
const intro = computed(() => {
  if (!list.value.length) return ''
  return props.isHost ? 'Pick a spot and confirm it when you are ready. You do not need to wait for anyone.' : `Say which spots work for you. ${props.hostName} confirms the final spot.`
})

// Run a change as the signed-in person. A failure goes up as a message; the data layer has already put things back. A press
// while an earlier change is still being saved does nothing.
// How to call: run(() => events.approveMySpot('s1', 'bugis', true))
async function run(fn, after) {
  if (busy.value) return
  busy.value = true
  emit('error', '')
  try {
    await fn()
    after?.()
  } catch (e) {
    emit('error', e.message)
  }
  busy.value = false
}

// "Works for me" on a spot, or taking it back. How to call: approve(spot, true)
const approve = (spot, on) => run(() => events.approveMySpot(props.session.id, spot.areaId, on))
// Suggest a spot (from the area picker), replacing your own. How to call: suggest({ areaId: 'bugis' })
const suggest = (place) => run(() => events.suggestMySpot(props.session.id, place.areaId, { here: false }))
// Mark your own suggestion "we are here already", or unmark it. How to call: setHere(spot, true)
const setHere = (spot, on) => run(() => events.suggestMySpot(props.session.id, spot.areaId, { here: on }))
// Price your suggestion again, keeping its "here" label. How to call: retry()
const retry = () => run(() => events.suggestMySpot(props.session.id, unpriced.value.areaId, { here: unpriced.value.here }))
// Take your suggestion back. How to call: withdraw()
const withdraw = () => run(() => events.withdrawMySpot(props.session.id))

// The host picked the known place's area: ask once before the list is replaced.
// How to call: pickKnown({ areaId: 'bugis' })
function pickKnown(place) {
  placeArea.value = AREAS.find((a) => a.id === place.areaId) || null
  dialogError.value = ''
  confirmOpen.value = !!placeArea.value
}
// The host confirmed the known place: replace the list with it. A press while this is saving does nothing.
// How to call: settleKnown()
async function settleKnown() {
  if (busy.value) return
  busy.value = true
  dialogError.value = ''
  try {
    await events.setKnownPlace(props.session.id, placeArea.value.id)
    confirmOpen.value = false
  } catch (e) {
    dialogError.value = e.message
  }
  busy.value = false
}
</script>

<template>
  <section class="spots" aria-labelledby="spots-head" data-testid="spots">
    <div class="section__head">
      <h2 id="spots-head" class="display-sm">Where to meet</h2>
    </div>
    <p v-if="intro" class="body-sm text-muted">{{ intro }}</p>
    <p v-if="own" class="caption-sm text-muted">You have one suggestion. A new one replaces it.</p>

    <div v-if="offerSuggest || offerKnown" class="spots__actions">
      <AppButton v-if="offerSuggest" variant="secondary" small :aria-busy="busy ? 'true' : undefined" @click="busy || (suggestOpen = true)">Suggest a spot</AppButton>
      <AppButton v-if="offerKnown" variant="tertiary" :aria-busy="busy ? 'true' : undefined" @click="busy || (placeOpen = true)">We already have a place</AppButton>
    </div>

    <ul v-if="list.length" class="spots__list" :class="{ 'is-busy': session.findingSpots }" :aria-busy="session.findingSpots ? 'true' : undefined" aria-label="Meeting spots">
      <SpotRow
        v-for="(spot, i) in list"
        :key="spot.areaId"
        :spot="spot"
        :number="i + 1"
        :selected="spot.areaId === selectedId"
        :mine="mine.has(spot.areaId)"
        :own="own && own.areaId === spot.areaId ? own : null"
        :fairest="spot.areaId === fairestId"
        :leading="spot.areaId === leadingId"
        :can-approve="approving"
        :busy="busy"
        :names="names"
        :my-id="myId"
        @select="emit('select', spot.areaId)"
        @approve="(on) => approve(spot, on)"
        @here="(on) => setHere(spot, on)"
        @withdraw="withdraw"
      />
    </ul>
    <div v-else-if="session.findingSpots" class="spots__wait" role="status" aria-label="Working out where to meet">
      <SkeletonRow v-for="n in 3" :key="n" />
    </div>
    <div v-else class="spots__empty">
      <h3 class="title-md">No spots yet</h3>
      <p class="body-sm text-muted">Spots open once two people have shared where they start. So far, {{ shared }} of {{ total }} have.</p>
    </div>
    <p v-if="list.length && session.findingSpots" class="caption-sm text-muted" role="status">Updating travel times…</p>

    <div v-if="unpriced" class="spots__empty" role="group" aria-label="Your suggestion">
      <h3 class="title-md">{{ unpriced.name }} has no travel times yet</h3>
      <p class="body-sm text-muted">Your suggestion was saved but not worked out. Try again, or take it back.</p>
      <div class="spots__actions">
        <AppButton variant="secondary" small :aria-busy="busy ? 'true' : undefined" @click="retry">Try again</AppButton>
        <AppButton variant="tertiary" :aria-busy="busy ? 'true' : undefined" @click="withdraw">Withdraw<span class="sr-only"> my suggestion of {{ unpriced.name }}</span></AppButton>
      </div>
    </div>

    <p v-if="hasTrips" class="spots__key" aria-label="Travel time colours">
      <span v-for="t in TRAVEL_TONES" :key="t.id" class="spots__key-item"><span class="spots__dot" :class="`is-${t.id}`" />{{ t.label }}</span>
    </p>

    <LocationSheet v-model:open="suggestOpen" which="spot" title="Suggest a spot" @select="suggest" />
    <LocationSheet v-model:open="placeOpen" which="spot" title="Where is the place?" @select="pickKnown" />
    <ModalDialog v-model:open="confirmOpen" :title="`Meet at ${placeArea?.name || 'this place'}?`" text="This replaces the list of spots and takes the group on to choosing places. Everyone can still add where they start.">
      <template #content><p v-if="dialogError" class="body-sm text-error" role="alert">{{ dialogError }}</p></template>
      <AppButton block variant="secondary" @click="confirmOpen = false">Not yet</AppButton>
      <AppButton block :aria-busy="busy ? 'true' : undefined" @click="settleKnown">Meet at {{ placeArea?.name }}</AppButton>
    </ModalDialog>
  </section>
</template>

<style scoped>
.spots { display: flex; flex-direction: column; gap: var(--spacing-md); min-width: 0; }
.spots .section__head { min-height: 0; }
.spots h2, .spots p { margin: 0; }
.spots__actions { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-base); }
.spots__list { display: flex; flex-direction: column; gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; transition: opacity var(--motion-fast) var(--ease-out); }
.spots__list.is-busy { opacity: 0.6; }
.spots__empty { display: flex; flex-direction: column; gap: var(--spacing-xs); padding: var(--spacing-base); border: 1px dashed var(--border-strong); border-radius: var(--rounded-md); }
.spots__empty h3 { margin: 0; }
.spots__key { display: flex; flex-wrap: wrap; gap: var(--spacing-xs) var(--spacing-base); font: var(--text-caption-sm); color: var(--muted); }
.spots__key-item { display: inline-flex; align-items: center; gap: var(--spacing-xs); }
.spots__dot { width: 10px; height: 10px; border-radius: var(--rounded-full); }
.spots__dot.is-short { background: var(--travel-short); }
.spots__dot.is-medium { background: var(--travel-medium); }
.spots__dot.is-long { background: var(--travel-long); }
@media (prefers-reduced-motion: reduce) { .spots__list { transition: none; } }
</style>
