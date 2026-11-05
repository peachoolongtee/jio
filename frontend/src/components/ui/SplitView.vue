<script setup>
// A list and a map that show the same things.
//   Mobile and tablet: one at a time, with a List / Map switch above.
//   Desktop: side by side, list on the left and map on the right. The map can be expanded.
//   <SplitView v-model:view="view" label="Meeting area">
//     <template #list> ... </template>
//     <template #map> <PlannerMap ... /> </template>
//   </SplitView>
// The layout changes with CSS only, so the list and the map keep their state when the window is resized.
// mapFirst (desktop only): the map is the whole screen and the page floats over it: the header as a card at the top left, the list as
// cards down the right, the button at the bottom right (Darius, 4 November 2026; Locate and the itinerary). The page's own rules are in
// app.css ("Map-first pages"). Phones keep the List / Map switch. There is no "Expand map" there: the map already fills the screen.
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'
import SegmentTabs from './SegmentTabs.vue'

const view = defineModel('view', { type: String, default: 'list' })
defineProps({
  label: { type: String, required: true },
  // Desktop: give the list and the map equal widths, for lists that need the room (the itinerary).
  even: { type: Boolean, default: false },
  mapFirst: { type: Boolean, default: false },
})
const expanded = ref(false)

</script>

<template>
  <div class="split" :class="[`split--${view}`, { 'is-expanded': expanded, 'split--even': even, 'split--first': mapFirst }]">
    <SegmentTabs
      v-model="view"
      class="split__switch"
      :label="`${label}: list or map`"
      :tabs="[{ id: 'list', label: 'List' }, { id: 'map', label: 'Map', icon: 'map' }]"
    />
    <div class="split__list"><slot name="list" /></div>
    <div class="split__map">
      <button v-if="!mapFirst" type="button" class="split__expand" :aria-pressed="String(expanded)" @click="expanded = !expanded">
        <AppIcon :name="expanded ? 'collapse' : 'expand'" :size="14" />
        {{ expanded ? 'Show list' : 'Expand map' }}
      </button>
      <slot name="map" />
    </div>
  </div>
</template>

<style scoped>
.split { display: flex; flex-direction: column; gap: var(--spacing-base); }
.split__list { display: flex; flex-direction: column; gap: var(--spacing-base); min-width: 0; }
/* Most of a phone's height, but never taller than the screen less a footer, so a phone on its side sees the whole map
   above the page's button; never shorter than 240px. */
.split__map { position: relative; height: max(240px, min(72dvh, 100dvh - 160px)); overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--rounded-md); }
.split__expand { display: none; }
.split--list .split__map { display: none; }
.split--map .split__list { display: none; }

@media (min-width: 1128px) {
  /* The map takes the larger share: it is where the group sees who travels how far and where everything is. */
  /* The two columns share one height: the map grows to match the list (at least 420px, at most a screen), and when
     the list is the shorter one its last card stretches to meet the map's bottom edge. A list longer than a screen
     scrolls past a map that stays in view. */
  .split { display: grid; grid-template-columns: minmax(0, 2fr) minmax(0, 3fr); align-items: stretch; gap: var(--spacing-lg); }
  .split__list > :last-child { flex-grow: 1; }
  .split__switch { display: none; }
  .split--list .split__map, .split--map .split__list { display: flex; }
  .split__map { position: sticky; top: var(--spacing-lg); display: block; height: auto; min-height: 420px; max-height: calc(100dvh - 120px); }
  .split--list .split__map { display: block; }
  .split--even { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  .split.is-expanded { grid-template-columns: minmax(0, 1fr); }
  .split.is-expanded .split__list { display: none; }
  .split.is-expanded .split__map { height: calc(100dvh - 140px); max-height: none; }
  .split__expand {
    position: absolute;
    top: var(--spacing-md);
    right: var(--spacing-md);
    z-index: 500;
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-xs);
    min-height: var(--tap-min);
    padding: 0 var(--spacing-base);
    border: 1px solid var(--border-strong);
    border-radius: var(--rounded-full);
    background: var(--canvas);
    box-shadow: var(--shadow-float);
    color: var(--ink);
    font: var(--text-button-sm);
  }
}
@media (min-width: 1128px) and (hover: hover) {
  .split__expand:hover { border-color: var(--ink); }
}

/* Map first (from 1128px): the map is the whole screen, behind everything; the page lays the rest over it (app.css, "Map-first pages":
   the header's card at the top left, the list's cards down the right, the footer's button at the bottom right). The list stays in the
   page's column, above the map. The zoom buttons sit at the bottom left, clear of the header's card. */
@media (min-width: 1128px) {
  .split--first { display: block; }
  .split--first .split__map { position: fixed; inset: 0; z-index: 0; display: block; height: auto; min-height: 0; max-height: none; border: 0; border-radius: 0; pointer-events: auto; }
  .split--first .split__list { position: relative; z-index: 1; }
  .split--first .split__list > :last-child { flex-grow: 0; }
  .split--first .split__map :deep(.leaflet-top.leaflet-left) { top: auto; bottom: var(--spacing-lg); left: var(--spacing-sm); }
}
</style>
