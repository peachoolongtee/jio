<script setup>
// The rain warning on the day: a banner for everyone in the session when rain is likely at an exposed stop still to come, and
// for the host the question "Swap to <indoor place>?" with Swap and Keep. A member who is not the host sees the banner only.
//   <RainBanners :session="session" :itinerary="itinerary" :my-id="auth.myId" />
// Shown for a confirmed plan on its day (the parent decides). What triggers it is the latest weather check in the events store
// (events.weatherChecks) and lib/weatherText.js rainWarnings. The indoor place is the swap the planner gives for that stop
// (events.loadRainSwap), asked for only on the host's screen. Nothing is swapped without the host pressing Swap. Keep dismisses
// the warning for that stop, for the whole session, until the forecast changes state (the host's press is saved with the plan).
import { computed, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import BannerNote from '../ui/BannerNote.vue'
import { singaporeMinutes } from '@/lib/session.js'
import { useNow } from '@/lib/useNow.js'
import { isDismissed, rainBannerText, rainWarnings, stateOf } from '@/lib/weatherText.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  itinerary: { type: Object, default: null },
  myId: { type: String, default: '' },
})

const events = useEventsStore()
const now = useNow()
const isHost = computed(() => props.session.hostId === props.myId)
const check = computed(() => events.weatherChecks[props.session.id])
const nowMinutes = computed(() => singaporeMinutes(now.value))
// The stops with a rain warning that the host has not dismissed (for this state of the forecast).
const warnings = computed(() =>
  rainWarnings(props.itinerary?.stops, check.value, nowMinutes.value).filter((w) => !isDismissed(props.session.weatherDismissed, w)),
)
// The indoor place offered for a warning, or null. How to call: swapOf(warning) -> { id: 'toa-payoh-library', name: '...' }
const swapOf = (w) => events.rainSwaps[props.session.id]?.[w.slotId]?.swap ?? null
// Where the offer stands: 'loading', 'ready', 'none' or 'failed'. How to call: swapStatus(warning) -> 'ready'
const swapStatus = (w) => events.rainSwaps[props.session.id]?.[w.slotId]?.status ?? 'loading'
// Names a stop and a forecast state, so the planner is asked once for each. How to call: keyOf(warning) -> 'east-coast-park:showers'
const keyOf = (w) => `${w.venueId}:${stateOf(w.weather.state)}`

// The host's screen asks the planner for the indoor place, once for each stop and state.
watch(
  () => (isHost.value ? warnings.value.map((w) => [w.slotId, keyOf(w)]) : []),
  (list) => list.forEach(([slotId, key]) => events.loadRainSwap(props.session.id, slotId, key)),
  { immediate: true },
)

const busy = ref('')
const errors = ref({})

// The host swaps the stop. One press, one swap: the buttons are off while it is made, and once it is made the warning is gone.
// How to call: await accept(warning, { id: 'toa-payoh-library', name: 'Toa Payoh Public Library' })
async function accept(w, swap) {
  if (busy.value) return
  busy.value = w.slotId
  errors.value = { ...errors.value, [w.slotId]: '' }
  try {
    await events.swapStop(props.session.id, w.slotId, w.venueId, swap.id)
  } catch (e) {
    errors.value = { ...errors.value, [w.slotId]: e.message }
  } finally {
    busy.value = ''
  }
}

// The host keeps the stop. How to call: await keep(warning)
async function keep(w) {
  if (busy.value) return
  busy.value = w.slotId
  errors.value = { ...errors.value, [w.slotId]: '' }
  try {
    await events.dismissRain(props.session.id, w.slotId, stateOf(w.weather.state))
  } catch (e) {
    errors.value = { ...errors.value, [w.slotId]: e.message }
  } finally {
    busy.value = ''
  }
}

// Ask for the indoor place again after it failed. How to call: retry(warning)
const retry = (w) => events.loadRainSwap(props.session.id, w.slotId, keyOf(w))
</script>

<template>
  <div v-if="warnings.length" class="rain" data-testid="rain-banners">
    <BannerNote v-for="w in warnings" :key="w.slotId" tone="warning" icon="rain" data-testid="rain-banner">
      {{ rainBannerText(w) }}
      <template v-if="isHost">
        <span v-if="swapStatus(w) === 'ready'" class="rain__ask"> Swap to {{ swapOf(w).name }}?</span>
        <span v-else-if="swapStatus(w) === 'loading'" class="rain__ask"> Looking for an indoor place…</span>
        <span v-else-if="swapStatus(w) === 'none'" class="rain__ask"> Jio found no indoor place to swap in.</span>
        <span v-else class="rain__ask"> Could not look for an indoor place.</span>
        <span v-if="errors[w.slotId]" class="rain__error" role="alert">{{ errors[w.slotId] }}</span>
      </template>
      <template v-else> The host can swap it for an indoor place.</template>
      <template v-if="isHost" #actions>
        <AppButton v-if="swapStatus(w) === 'ready'" small :disabled="!!busy" :aria-label="`Swap ${w.name} for ${swapOf(w).name}`" @click="accept(w, swapOf(w))">Swap</AppButton>
        <AppButton v-if="swapStatus(w) === 'failed'" small variant="secondary" @click="retry(w)">Try again</AppButton>
        <AppButton small variant="secondary" :disabled="!!busy" :aria-label="`Keep ${w.name}`" @click="keep(w)">Keep</AppButton>
      </template>
    </BannerNote>
  </div>
</template>

<style scoped>
.rain { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.rain__ask { font-weight: 600; }
.rain__error { display: block; color: var(--primary-error-text); }
</style>
