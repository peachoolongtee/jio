<script setup>
// The map screen: a full-screen map in the style of a maps app.
//   - Numbered pins for the stops, joined by the route.
//   - A pin for the meeting area. No one's start is shown.
//   - Tapping a pin opens a small card with the stop's name, time and price tier.
// It is a mobile screen; on desktop the itinerary already shows the map, and this is its expanded view.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import PriceTier from '@/components/ui/PriceTier.vue'
import StatusPill from '@/components/ui/StatusPill.vue'
import WeatherSource from '@/components/weather/WeatherSource.vue'
import PlannerMap from '@/components/map/PlannerMap.vue'
import NotFoundView from './NotFoundView.vue'
import { timeAndDuration } from '@/lib/planner/format.js'
import { watchSessions } from '@/lib/api.js'
import { itineraryRain } from '@/lib/rainLook.js'
import { useNow } from '@/lib/useNow.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

const events = useEventsStore()
// The session does not exist, or the person is not in it (the data layer's `not_found`), and why the map could not load it at
// all (no connection, the planner slow or down) with a Retry. The two are different pages: only the first is "not found".
const missing = ref(false)
const loadError = ref('')
const selected = ref('')

// Only the newest load speaks, so a slow answer for a map already left never changes what the person sees.
let loadTicket = 0
// How to call: load() (on mount, when the id changes, and from Retry)
async function load() {
  const ticket = ++loadTicket
  missing.value = false
  loadError.value = ''
  try {
    await events.loadSession(props.id)
    await events.loadItinerary(props.id)
    // The rain on the map comes from the check on the day. The itinerary page makes it; a map opened on its own (a reload, a
    // shared link) asks once, on the day of a confirmed plan, and never waits for the answer.
    const loaded = events.byId[props.id]
    if (loaded?.status === 'confirmed' && loaded.isToday && !events.weatherChecks[props.id]) events.checkWeather(props.id)
  } catch (err) {
    if (ticket !== loadTicket) return
    if (err?.code === 'not_found') missing.value = true
    else loadError.value = err?.message || 'The map could not be loaded.'
  }
}
// A shared session's stops move on the map as they change on another device (a no-op for the demo and local accounts).
let stopWatching = () => {}
onMounted(() => {
  stopWatching = watchSessions()
  load()
})
onBeforeUnmount(() => stopWatching())
watch(() => props.id, load)

const session = computed(() => events.byId[props.id])
const itinerary = computed(() => events.itineraries[props.id])
const stops = computed(() => itinerary.value?.stops || [])
const places = computed(() => stops.value.flatMap((s, i) => (s.venue.noPin ? [] : [{ id: s.venue.id, name: s.venue.name, lat: s.venue.lat, lng: s.venue.lng, label: String(i + 1), category: s.category }])))
// The rain on the map, as on the itinerary's map: the latest check on the day when there is one, else what the plan kept, for a
// confirmed plan only, and only while that forecast is current (the plan's own was kept when it was confirmed, which may be hours ago).
// `weather` is the block the source line reads. How to call: rain.value -> { places: [{ lat, lng }], text: 'Rain likely', weather: { source: 'live', ... } }
const now = useNow()
const rain = computed(() => {
  if (session.value?.status !== 'confirmed' || !itinerary.value) return { places: [], text: '', weather: null }
  const check = events.weatherChecks[props.id]
  const weather = check?.weather ?? itinerary.value.weather ?? null
  return { ...itineraryRain(stops.value, (stop) => check?.stops?.[stop.slotId] ?? stop.weather, weather, now.value), weather }
})
const area = computed(() => itinerary.value?.area || session.value?.area || null)
const card = computed(() => {
  const i = stops.value.findIndex((s) => s.venue.id === selected.value)
  return i === -1 ? null : { ...stops.value[i], number: i + 1 }
})
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="loadError" class="screen" data-testid="map-load-error">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <EmptyState title="Could not load the map" :text="loadError" role="alert">
        <AppButton variant="secondary" @click="load">Retry</AppButton>
        <AppButton variant="tertiary" :to="`/sessions/${id}/itinerary`">Back to the itinerary</AppButton>
      </EmptyState>
    </div>
  </main>
  <main v-else class="full-map">
    <PlannerMap class="full-map__map" :places="places" :area="area" :rain="rain.places" :rain-label="rain.text" route fit-to="places" zoom-position="bottomright" :selected="selected" label="Plan map" @select="selected = $event" />

    <header class="full-map__bar">
      <IconButton label="Back to the itinerary" :to="`/sessions/${id}/itinerary`"><AppIcon name="back" /></IconButton>
      <div v-if="session" class="full-map__title">
        <span class="title-sm truncate">{{ session.title }}</span>
        <StatusPill :status="session.status" />
      </div>
    </header>

    <!-- NEA's rain on the map carries its source line and licence notice, as Home and the itinerary do, under the rain chip. -->
    <div v-if="rain.places.length" class="full-map__weather" data-testid="map-weather"><div class="full-map__weather-card"><WeatherSource :block="rain.weather" /></div></div>

    <ol v-if="stops.length && !card" class="full-map__legend" aria-label="Stops">
      <li v-for="(stop, i) in stops" :key="stop.slotId">
        <button type="button" class="full-map__stop" @click="selected = stop.venue.id">
          <span class="full-map__num" :class="`full-map__num--${stop.category}`" aria-hidden="true">{{ i + 1 }}</span>
          <span class="caption truncate">{{ stop.venue.name }}</span>
        </button>
      </li>
    </ol>

    <section v-if="card" class="full-map__card" :aria-label="card.venue.name">
      <span class="full-map__num" :class="`full-map__num--${card.category}`" aria-hidden="true">{{ card.number }}</span>
      <div class="full-map__card-text">
        <span class="caption tnum">{{ timeAndDuration(card.start, card.duration) }}</span>
        <h2 class="title-md clamp-2">{{ card.venue.name }}</h2>
        <div class="row gap-sm wrap">
          <CategoryIcon :category="card.category" :size="24" />
          <PriceTier :price="card.venue.price" />
        </div>
      </div>
      <IconButton label="Close" @click="selected = ''"><AppIcon name="close" /></IconButton>
    </section>
  </main>
</template>

<style scoped>
.full-map { position: fixed; inset: 0; z-index: 1; background: var(--surface-strong); }
.full-map__map { position: absolute; inset: 0; }
/* The rain chip (PlannerMap) rides under the bar with the back button and the title, not behind it, and the source line under the chip. */
.full-map { --pm-rain-top: calc(var(--spacing-md) + var(--tap-min) + var(--spacing-sm) + env(safe-area-inset-top, 0px)); }
/* Leaflet's own controls (the zoom buttons and the attribution) sit in corner boxes at the edge of the map, which runs under
   the notch and the home indicator; the boxes move in by the insets, and the controls keep their 10px margin inside. */
.full-map__map :deep(.leaflet-top) { top: env(safe-area-inset-top, 0px); }
.full-map__map :deep(.leaflet-bottom) { bottom: env(safe-area-inset-bottom, 0px); }
.full-map__map :deep(.leaflet-left) { left: env(safe-area-inset-left, 0px); }
.full-map__map :deep(.leaflet-right) { right: env(safe-area-inset-right, 0px); }
/* The map runs under a notch and the home indicator; the controls on it stay inside the safe area. */
.full-map__bar { position: absolute; top: calc(var(--spacing-md) + env(safe-area-inset-top, 0px)); left: calc(var(--spacing-md) + env(safe-area-inset-left, 0px)); right: calc(var(--spacing-md) + env(safe-area-inset-right, 0px)); z-index: 1100; display: flex; align-items: center; gap: var(--spacing-sm); pointer-events: none; }
.full-map__bar > * { pointer-events: auto; box-shadow: var(--shadow-float); }
.full-map__bar :deep(.icon-btn) { background: var(--canvas); }
.full-map__weather { position: absolute; z-index: 1100; top: calc(var(--pm-rain-top, 64px) + 32px + var(--spacing-sm)); left: calc(var(--spacing-md) + env(safe-area-inset-left, 0px)); right: calc(var(--spacing-md) + env(safe-area-inset-right, 0px)); display: flex; justify-content: center; pointer-events: none; }
.full-map__weather-card { max-width: 420px; padding: var(--spacing-xs) var(--spacing-md); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); pointer-events: auto; }
.full-map__title { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; min-height: var(--tap-min); padding: 0 var(--spacing-base); border-radius: var(--rounded-full); background: var(--canvas); }
.full-map__legend { position: absolute; left: calc(var(--spacing-md) + env(safe-area-inset-left, 0px)); right: calc(64px + env(safe-area-inset-right, 0px)); bottom: calc(var(--spacing-xl) + env(safe-area-inset-bottom, 0px)); z-index: 1100; display: flex; gap: var(--spacing-sm); overflow-x: auto; scrollbar-width: none; }
.full-map__stop { display: inline-flex; align-items: center; gap: var(--spacing-sm); max-width: 240px; min-height: var(--tap-min); padding: 0 var(--spacing-base) 0 var(--spacing-xs); border: 0; border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); color: var(--ink); }
@media (hover: hover) { .full-map__stop:hover { background: var(--surface-soft); } }
.full-map__num { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rounded-full); background: var(--ink); color: var(--on-dark); font: var(--text-caption); }
/* Numbers in the category colour, matching the pins. */
.full-map__num--eat { background: var(--cat-eat-fg); }
.full-map__num--drink { background: var(--cat-drink-fg); }
.full-map__num--shop { background: var(--cat-shop-fg); }
.full-map__num--activity { background: var(--cat-activity-fg); }
.full-map__card { position: absolute; left: calc(var(--spacing-md) + env(safe-area-inset-left, 0px)); right: calc(64px + env(safe-area-inset-right, 0px)); bottom: calc(var(--spacing-xl) + env(safe-area-inset-bottom, 0px)); z-index: 1100; display: flex; align-items: flex-start; gap: var(--spacing-md); max-width: var(--dialog-max-width); margin: 0 auto; padding: var(--spacing-base); border-radius: var(--rounded-lg); background: var(--canvas); box-shadow: var(--shadow-float); }
.full-map__card-text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xs); }
</style>
