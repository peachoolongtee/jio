<script setup>
// Pick a start or end location: search for a place or postal code, or use the current location.
// For an end location, "Same as start" is the first choice.
//   <LocationSheet v-model:open="open" which="start" @select="save" />
import { ref, watch } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import PopoverPanel from '../ui/PopoverPanel.vue'
import TextField from '../ui/TextField.vue'
import * as api from '@/lib/api.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({
  which: { type: String, default: 'start' },
  // Ian's home area, offered as a quick choice.
  home: { type: Object, default: null },
})
const emit = defineEmits(['select'])

const query = ref('')
const results = ref([])
const error = ref('')
const locating = ref(false)
let timer = null

watch(open, (isOpen) => {
  if (isOpen) {
    query.value = ''
    results.value = []
    error.value = ''
  }
})

watch(query, (q) => {
  clearTimeout(timer)
  timer = setTimeout(async () => {
    results.value = await api.searchPlaces(q)
  }, 150)
})

function pick(place) {
  emit('select', place)
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
  <PopoverPanel v-model:open="open" :title="which === 'end' ? 'Where you head after' : 'Where you start'" :width="400">
    <TextField v-model="query" label="Place or postal code" hide-label placeholder="Search a place or postal code" type="text" inputmode="search" autocomplete="off" enterkeyhint="search">
      <template #trailing><AppIcon class="loc__search" name="search" /></template>
    </TextField>
    <div class="loc__quick">
      <AppButton v-if="which === 'end'" variant="secondary" small @click="pick(null)">
        <AppIcon name="swap" />
        Same as start
      </AppButton>
      <AppButton variant="secondary" small :disabled="locating" @click="useCurrent">
        <AppIcon name="locate" />
        {{ locating ? 'Finding you' : 'Use current location' }}
      </AppButton>
      <AppButton v-if="home" variant="secondary" small @click="pick({ id: `home-${home.id}`, label: `Home · ${home.name}`, areaId: home.id })">
        <AppIcon name="home" />
        Home · {{ home.name }}
      </AppButton>
    </div>
    <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    <ul v-if="results.length" class="loc__results" aria-label="Results">
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
    <p v-else-if="query.trim()" class="body-sm text-muted">No places match "{{ query.trim() }}".</p>
    <p class="caption-sm text-muted loc__privacy"><AppIcon name="lock" :size="12" /> Friends see the area name only</p>
  </PopoverPanel>
</template>

<style scoped>
.loc__search { position: absolute; top: 20px; right: 14px; color: var(--muted); pointer-events: none; }
.loc__quick { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.loc__results { display: flex; flex-direction: column; }
.loc__result { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: 56px; padding: var(--spacing-sm); border: 0; border-bottom: 1px solid var(--hairline-soft); background: transparent; color: var(--ink); text-align: left; }
.loc__text { display: flex; flex-direction: column; min-width: 0; }
@media (hover: hover) { .loc__result:hover { background: var(--surface-soft); } }
.loc__privacy { display: flex; align-items: center; gap: var(--spacing-xs); }
</style>
