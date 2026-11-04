<script setup>
// Pick a start or end location: search for a place or postal code, or use the current location.
// For an end location, "Same as start" is the first choice.
//   <LocationSheet v-model:open="open" which="start" @select="save" />
//   <LocationSheet v-model:open="open" which="spot" title="Suggest a spot" @select="suggest" />   an area for the group
// Typing searches the areas Jio knows at once and, about 300 ms after the last key, the address search on the backend.
// A search that a newer one replaces is cancelled, and its answer is never shown. What is picked is { id, label, sub, areaId }:
// the area is what the group sees, and the label stays with the person who picked it.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import PopoverPanel from '../ui/PopoverPanel.vue'
import TextField from '../ui/TextField.vue'
import * as api from '@/lib/api.js'
import { SEARCH_MAX_CHARS, createLatest, isCancelled, searchStatus, toSpotRows } from '@/lib/placeSearch.js'

// How long after the last key the address search is asked.
const SEARCH_DELAY_MS = 300

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({
  which: { type: String, default: 'start' },
  // Ian's home area, offered as a quick choice.
  home: { type: Object, default: null },
  // The heading, when it is not one of the two locations: which="spot" picks an area for the group (a suggested
  // meeting spot, or a known place) instead of a place to start from. Only the area of what is picked is used.
  title: { type: String, default: '' },
})
const emit = defineEmits(['select'])

const query = ref('')
// The rows for the last search that has answered, as the backend layer gives them (see searchPlaces in api.js).
const found = ref([])
// A search is wanted or running; `waiting` is the part of that before it is sent, while the person is still typing.
const pending = ref(false)
const waiting = ref(false)
// The address search could not be used for the last search, so only the areas Jio knows are listed.
const unavailable = ref(false)
const error = ref('')
const locating = ref(false)
const latest = createLatest()
let timer = null

// For "Suggest a spot" a row is an area, once. Otherwise it is the place and its area.
const results = computed(() => (props.which === 'spot' ? toSpotRows(found.value) : found.value))
const text = computed(() => query.value.trim())
const status = computed(() => searchStatus({ query: text.value, pending: pending.value, unavailable: unavailable.value, count: results.value.length }))
// What a screen reader hears: the status, or how many places came back.
const announcement = computed(() => status.value || (text.value && results.value.length ? `${results.value.length} ${results.value.length === 1 ? 'place' : 'places'} found` : ''))

// Stop whatever is waiting or running and forget it.
// How to call: stopSearching()
function stopSearching() {
  clearTimeout(timer)
  latest.cancel()
  pending.value = false
  waiting.value = false
}

watch(open, (isOpen) => {
  stopSearching()
  if (isOpen) {
    query.value = ''
    found.value = []
    unavailable.value = false
    error.value = ''
  }
})
onBeforeUnmount(stopSearching)

// Ask for the places that match `q`. The areas show at once; the rest replaces them if this search is still the latest.
// How to call: await search('tampines mall')
async function search(q) {
  waiting.value = false
  const job = latest.start()
  try {
    const answer = await api.searchPlaces(q, {
      signal: job.signal,
      onBuiltIn: (areas) => {
        if (!job.current()) return
        found.value = areas
        unavailable.value = false
      },
    })
    if (!job.current()) return
    found.value = answer.places
    unavailable.value = answer.unavailable
  } catch (err) {
    if (!job.current() || isCancelled(err)) return
    found.value = []
    unavailable.value = true
  } finally {
    if (job.current()) pending.value = false
  }
}

watch(query, (value) => {
  stopSearching()
  const q = value.trim()
  if (!q) {
    found.value = []
    unavailable.value = false
    return
  }
  pending.value = true
  waiting.value = true
  timer = setTimeout(() => search(q), SEARCH_DELAY_MS)
})

// Hand the pick to the screen: the area and the label, nothing else of the row.
// How to call: pick({ id: 'om-529510-0', label: 'Tampines Mall', sub: 'Singapore 529510 · Tampines', areaId: 'tampines' })
function pick(place) {
  emit('select', place && { id: place.id, label: place.label, sub: place.sub, areaId: place.areaId })
  open.value = false
}

function useCurrent() {
  error.value = ''
  if (!navigator.geolocation) {
    error.value = 'This browser cannot share your location. Search for a place instead.'
    return
  }
  locating.value = true
  navigator.geolocation.getCurrentPosition(
    async (pos) => {
      const place = await api.placeFromCoords(pos.coords.latitude, pos.coords.longitude)
      locating.value = false
      if (!place) error.value = 'Your current location is outside Singapore. Search for a place instead.'
      else pick(place)
    },
    () => {
      locating.value = false
      error.value = 'Location access is off. Search for a place instead.'
    },
    { timeout: 10000 },
  )
}
</script>

<template>
  <PopoverPanel v-model:open="open" :title="title || (which === 'end' ? 'Where you head after' : 'Where you start')" :width="400">
    <TextField v-model="query" label="Place or postal code" hide-label placeholder="Search a place or postal code" type="text" inputmode="search" autocomplete="off" enterkeyhint="search" :maxlength="SEARCH_MAX_CHARS">
      <template #trailing><AppIcon class="loc__search" name="search" /></template>
    </TextField>
    <div class="loc__quick">
      <!-- One line of short choices (Darius, 4 November 2026); each keeps its full name for screen readers and as a tooltip. -->
      <AppButton v-if="which === 'end'" variant="secondary" small aria-label="Same as start" title="Same as start" @click="pick(null)">
        <AppIcon name="swap" />
        Start
      </AppButton>
      <AppButton variant="secondary" small :disabled="locating" :aria-label="locating ? 'Finding you' : 'Use current location'" title="Use current location" @click="useCurrent">
        <AppIcon name="locate" />
        {{ locating ? 'Finding…' : 'Here' }}
      </AppButton>
      <AppButton v-if="home" variant="secondary" small :aria-label="`Home, ${home.name}`" :title="`Home · ${home.name}`" @click="pick({ id: `home-${home.id}`, label: `Home · ${home.name}`, areaId: home.id })">
        <AppIcon name="home" />
        Home
      </AppButton>
    </div>
    <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    <ul v-if="results.length" class="loc__results" :class="{ 'is-waiting': waiting }" aria-label="Results" :aria-busy="pending ? 'true' : undefined" :inert="waiting || undefined">
      <li v-for="place in results" :key="place.id">
        <button type="button" class="loc__result" @click="pick(place)">
          <AppIcon name="pin" />
          <span class="loc__text">
            <span class="title-sm truncate">{{ place.label }}</span>
            <span class="caption-sm text-muted truncate">{{ place.sub }}</span>
          </span>
        </button>
      </li>
    </ul>
    <p v-if="status" class="body-sm text-muted">{{ status }}</p>
    <p class="sr-only" role="status">{{ announcement }}</p>
  </PopoverPanel>
</template>

<style scoped>
.loc__search { position: absolute; top: 20px; right: 14px; color: var(--muted); pointer-events: none; }
.loc__quick { display: flex; flex-wrap: nowrap; gap: var(--spacing-sm); }
.loc__quick > * { flex-shrink: 0; }
.loc__results { display: flex; flex-direction: column; transition: opacity var(--motion-fast) var(--ease-out); }
.loc__results.is-waiting { opacity: 0.6; }
.loc__result { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: 56px; padding: var(--spacing-sm); border: 0; border-bottom: 1px solid var(--hairline-soft); background: transparent; color: var(--ink); text-align: left; }
.loc__text { display: flex; flex-direction: column; min-width: 0; }
@media (prefers-reduced-motion: reduce) { .loc__results { transition: none; } }
@media (hover: hover) { .loc__result:hover { background: var(--surface-soft); } }
</style>
