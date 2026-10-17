<script setup>
// "Already out? Find something nearby" on Home (ticket #98). A row with the box of the start row (StartMeetupRow), in a quiet
// outline instead of the red one, so "Plan a new meetup" stays the main action. Pressing it asks where the person is: an
// area from the search, their home area, or "Use current location" (LocationSheet). A refused or unavailable location
// says so in the sheet, which stays open on the search, so picking an area is always the way forward. Only the area is
// kept: the group sees its name, never the exact place. Then it starts a light meetup for today (lib/api.js startRoam),
// with no location step, and opens its Roam list. Friends can be invited from there, or not at all.
//   <RoamFromHome :home="{ id: 'tampines', name: 'Tampines' }" />
import { ref } from 'vue'
import { useRouter } from 'vue-router'
import AppIcon from '../ui/AppIcon.vue'
import LocationSheet from '../group/LocationSheet.vue'
import { useEventsStore } from '@/stores/events.js'

defineProps({
  // The signed-in person's home area, offered as a quick choice, or null.
  home: { type: Object, default: null },
})

const router = useRouter()
const events = useEventsStore()
const open = ref(false)
const busy = ref(false)
const error = ref('')

// The area is picked: start the light meetup and go to its list.
// How to call: await start({ areaId: 'bugis', label: 'Bugis Junction' })
async function start(place) {
  if (!place?.areaId || busy.value) return
  busy.value = true
  error.value = ''
  try {
    const session = await events.startRoam({ areaId: place.areaId })
    await router.push(`/sessions/${session.id}/roam`)
  } catch (e) {
    error.value = e?.message || 'Could not start. Try again.'
  } finally {
    busy.value = false
  }
}
</script>

<template>
  <div class="roam-entry">
    <button type="button" class="rrow" :disabled="busy" data-testid="roam-from-home" @click="open = true">
      <span class="rrow__icon" aria-hidden="true"><AppIcon name="locate" :size="20" /></span>
      <span class="rrow__text">
        <span class="rrow__title title-md">Already out?</span>
        <span class="rrow__meta body-sm text-muted">{{ busy ? 'Starting' : 'Find something nearby' }}</span>
      </span>
      <AppIcon class="rrow__go" name="chevron-right" :size="18" />
    </button>
    <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
    <LocationSheet v-model:open="open" which="spot" title="Where are you?" :home="home" @select="start" />
  </div>
</template>

<style scoped>
.roam-entry { display: flex; flex-direction: column; gap: var(--spacing-xs); }
/* The start row's box (StartMeetupRow), with a hairline outline and an ink badge: a second, quieter way in. */
.rrow {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  width: 100%;
  min-height: var(--tap-min);
  padding: var(--spacing-md) var(--spacing-base);
  border: 1px solid var(--hairline);
  border-radius: var(--rounded-md);
  background: var(--canvas);
  color: var(--ink);
  font: inherit;
  text-align: left;
  cursor: pointer;
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
@media (hover: hover) { .rrow:hover { border-color: var(--ink); background: var(--surface-soft); } }
.rrow:disabled { cursor: progress; }
.rrow__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.rrow__text { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xs); flex: 1 1 0; min-width: 0; }
.rrow__go { flex-shrink: 0; color: var(--muted); }
@media (prefers-reduced-motion: reduce) { .rrow { transition: none; } }
</style>
