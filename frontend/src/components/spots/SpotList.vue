<script setup>
// "Where to meet": the meeting spots of a session that is choosing where to meet, with "Vote" on each and "Add a spot" (the
// area picker, in a popover; it was "Suggest a spot"). How the meeting point is picked was settled on the Start choice before this
// screen, so the list has no way to name a place of its own (Faith's walkthrough, 30 October 2026: "Pick the place yourself" is gone).
//   <SpotList :session="session" my-id="ian" :names="nameOf" :selected-id="shown" :is-host="true" host-name="Ian"
//             @select="picked = $event" @error="error = $event" />
// session: a session summary (lib/api.js). selectedId: the area shown as chosen (SpotRow outlines it; the map's pin matches).
// Changes go through the events store as the signed-in person: approveMySpot (through spotChange.js, as the map's card
// does), suggestMySpot and withdrawMySpot. A refusal or a planner failure is sentence-sized and goes up as `error` (the write has rolled back).
// Emits select (an area id) and error (a message, or '' to clear). Confirming a spot or setting a known place moves the
// session on to Voting, and this list stays where it is.
// States: the group is choosing (the list, with every control); the group has moved on (the same spots with the confirmed
// one first and marked "Confirmed", and no control on any of them: no "Vote", "Add a spot" or Withdraw); the planner working it out (placeholder rows); the list while its times are updated; and your own
// suggestion with no row (a reload caught it before it was priced): "Try again" prices it, "Withdraw" takes it back.
// With fewer than two starts there is no list and nothing to say about it (the "Waiting for N people" card on the screen
// says who is missing), and the section does not show.
// "Jio remembers": on the first spot's own row only, one quiet line, "This spot is closer to you.", for the person whose past travel the planner
// counts when it picks that spot, and only when their own minutes to it are below the group's average (lib/travelLean.js). The answer is the
// signed-in person's own flag (api.travelLean), asked once the group is choosing with two starts in. It shows nothing when the answer is no, when
// it could not be read, when the planner did not pick by fairness (everyone starts together), when the host named a known place, or when the
// minutes are missing. It names no one, and no one else's answer is ever read.
// A control that starts a change stays enabled while it saves (aria-busy), so a key press never drops the keyboard focus; a
// second press is ignored until the first is saved. A confirm running anywhere on the screen (the footer's "Confirm …" or this
// list's "Meet at …", one flag in the events store) counts as saving, so a change and a confirm never overlap; "Meet at …" reads
// "Confirming…" while it runs.
import { computed, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import SkeletonRow from '../ui/SkeletonRow.vue'
import LocationSheet from '../group/LocationSheet.vue'
import SpotRow from './SpotRow.vue'
import { useSpotChange } from './spotChange.js'
import { closerToYou, leanLine } from '@/lib/travelLean.js'
import { useEventsStore } from '@/stores/events.js'
import { canApprove, canSuggest, confirmedAreaId, confirmedLine, isChoosing, spotsToShow, startsShared, unpricedSuggestion } from './spotText.js'

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
// A change of this list or the map's card, or a confirm from anywhere, is being saved (one flag, spotChange.js).
const { busy, run: change, approve: approveSpot } = useSpotChange()
const suggestOpen = ref(false)

const spots = computed(() => props.session.spots || { list: [], approvals: {}, suggestions: {}, preselectedAreaId: null, appMethod: null })
const choosing = computed(() => isChoosing(props.session))
// The spots as listed now: while choosing, the data layer's list; after, the confirmed one first.
const list = computed(() => spotsToShow(props.session))
const confirmedId = computed(() => confirmedAreaId(props.session))
const mine = computed(() => new Set(spots.value.approvals?.[props.myId] || []))
const own = computed(() => spots.value.suggestions?.[props.myId] || null)
const unpriced = computed(() => unpricedSuggestion(props.session, props.myId))
const offerSuggest = computed(() => canSuggest(props.session, props.myId))
const approving = computed(() => canApprove(props.session, props.myId))
// "Fairest" belongs to the app's first spot, and only when the planner really chose it by fairness.
const fairestId = computed(() => (choosing.value && spots.value.appMethod === 'fairest' ? list.value.find((s) => s.by === 'app')?.areaId : ''))
const leadingId = computed(() => {
  const spot = choosing.value ? list.value.find((s) => s.areaId === spots.value.preselectedAreaId) : null
  return spot && spot.approvalCount > 0 ? spot.areaId : ''
})
// Is there anything to show? Not with fewer than two starts.
const visible = computed(() => list.value.length > 0 || !!props.session.findingSpots || !!unpriced.value)
// The host's own buttons say what to do, so only a guest is told how the spots are settled.
const intro = computed(() => {
  if (!list.value.length) return ''
  if (confirmedId.value) return confirmedLine(list.value[0].area.name)
  if (!choosing.value || props.isHost) return ''
  return `Vote for the spots that work for you. ${props.hostName} confirms the final spot.`
})

// The line for the first spot, "This spot is closer to you.", or '' (nothing to say). The signed-in person's own answer must be yes (the planner
// counted their past travel), the group must be choosing, the host must not have named the place, and the planner must have picked the first spot
// by fairness (the caller passes only that spot). It also has to be true on the screen: the person's own minutes to the spot, among the figures
// its row shows everyone, are below their average (lib/travelLean.js closerToYou). Missing minutes show nothing.
// How to call: leanNote(list.value[0]) // 'This spot is closer to you.'
function leanNote(spot) {
  const answer = events.leans[props.session.id]
  if (!answer?.owed || !choosing.value || !props.myId || props.session.meetBy === 'known' || spots.value.appMethod !== 'fairest') return ''
  return closerToYou(spot.times, props.myId) ? leanLine(answer.rule) : ''
}
// Ask again when the group starts choosing, or when the number of starts shared or the person's own start changes: the answer depends on them.
// How to call: leanKey.value // 's1|true|2|true'
const leanKey = computed(() => `${props.session.id}|${choosing.value}|${startsShared(props.session)}|${!!props.session.locations?.[props.myId]?.start}`)
watch(leanKey, () => { if (choosing.value && props.myId && startsShared(props.session) >= 2) events.loadLean(props.session.id) }, { immediate: true })

// Run a change as the signed-in person. A failure goes up as a message; the data layer has already put things back. A press
// while an earlier change is still being saved does nothing.
// How to call: run(() => change(() => events.withdrawMySpot('s1')))
async function run(fn) {
  if (busy.value) return
  emit('error', '')
  const message = await fn()
  if (message) emit('error', message)
}

// "Vote" on a spot, or taking it back, the same way the map's card does. How to call: approve(spot, true)
const approve = (spot, on) => run(() => approveSpot(props.session.id, spot.areaId, on))
// Add a spot (from the area picker), replacing your own. How to call: suggest({ areaId: 'bugis' })
const suggest = (place) => run(() => change(() => events.suggestMySpot(props.session.id, place.areaId, { here: false })))
// Mark your own suggestion "we are here already", or unmark it. How to call: setHere(spot, true)
const setHere = (spot, on) => run(() => change(() => events.suggestMySpot(props.session.id, spot.areaId, { here: on })))
// Price your suggestion again, keeping its "here" label. How to call: retry()
const retry = () => run(() => change(() => events.suggestMySpot(props.session.id, unpriced.value.areaId, { here: unpriced.value.here })))
// Take your suggestion back. How to call: withdraw()
const withdraw = () => run(() => change(() => events.withdrawMySpot(props.session.id)))

</script>

<template>
  <section v-if="visible" class="spots" aria-labelledby="spots-head" data-testid="spots">
    <div class="section__head">
      <h2 id="spots-head" class="display-sm">Where to meet</h2>
    </div>
    <p v-if="intro" class="body-sm text-muted">{{ intro }}</p>
    <p v-if="own && choosing" class="caption-sm text-muted">You have one suggestion. A new one replaces it.</p>

    <div v-if="offerSuggest" class="spots__actions">
      <AppButton variant="secondary" small :aria-busy="busy ? 'true' : undefined" @click="busy || (suggestOpen = true)">Add a spot</AppButton>
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
        :readonly="!choosing"
        :confirmed="spot.areaId === confirmedId"
        :busy="busy"
        :names="names"
        :my-id="myId"
        :note="spot.areaId === fairestId ? leanNote(spot) : ''"
        @select="emit('select', spot.areaId)"
        @approve="(on) => approve(spot, on)"
        @here="(on) => setHere(spot, on)"
        @withdraw="withdraw"
      />
    </ul>
    <div v-else-if="session.findingSpots" class="spots__wait" role="status" aria-label="Working out where to meet">
      <SkeletonRow v-for="n in 3" :key="n" />
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

    <LocationSheet v-model:open="suggestOpen" which="spot" title="Add a spot" @select="suggest" />
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
@media (prefers-reduced-motion: reduce) { .spots__list { transition: none; } }
</style>
