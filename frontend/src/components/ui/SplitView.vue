<script setup>
// A list and a map that show the same things.
//   Mobile and tablet: one at a time, with a List / Map switch above.
//   Desktop: side by side, list on the left and map on the right. The map can be expanded.
//   <SplitView v-model:view="view" label="Meeting area">
//     <template #list> ... </template>
//     <template #map> <PlannerMap ... /> </template>
//   </SplitView>
// The layout changes with CSS only, so the list and the map keep their state when the window is resized.
// mapFirst (desktop only, as Home): the map on the left and the list docked on the right as a full-height white panel, across the whole
// width of the screen and down to its foot (Darius, 4 November 2026; Locate first). Phones keep the List / Map switch.
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import SegmentTabs from './SegmentTabs.vue'

const view = defineModel('view', { type: String, default: 'list' })
const props = defineProps({
  label: { type: String, required: true },
  // Desktop: give the list and the map equal widths, for lists that need the room (the itinerary).
  even: { type: Boolean, default: false },
  mapFirst: { type: Boolean, default: false },
})
const expanded = ref(false)

// Map first: how tall the two columns are, from where they start down to the screen's foot (a long title pushes them down).
const root = ref(null)
// …and where the screen's edges are from the page's column, so the two columns run exactly from edge to edge.
const box = ref(null)
function measure() {
  if (!props.mapFirst || !root.value) return
  const top = root.value.getBoundingClientRect().top + (globalThis.scrollY || 0)
  // Where this would start without the pull to the edge: the column's left edge plus its padding.
  const parent = root.value.parentElement
  const column = parent?.getBoundingClientRect()
  const pad = parent ? parseFloat(getComputedStyle(parent).paddingLeft) || 0 : 0
  // The page's own width (it leaves room for a scrollbar on the right, as fixed bars do), so the panel ends where they do.
  const width = globalThis.document?.documentElement.getBoundingClientRect().width || 0
  box.value = { '--split-h': `calc(100dvh - ${Math.round(top)}px)`, '--split-ml': `${-Math.round((column?.left || 0) + pad)}px`, '--split-w': `${width}px` }
}
onMounted(() => {
  nextTick(measure)
  globalThis.addEventListener?.('resize', measure)
})
onBeforeUnmount(() => globalThis.removeEventListener?.('resize', measure))
watch(() => props.mapFirst, () => nextTick(measure))
</script>

<template>
  <div ref="root" class="split" :class="[`split--${view}`, { 'is-expanded': expanded, 'split--even': even, 'split--first': mapFirst }]" :style="mapFirst && box ? box : undefined">
    <SegmentTabs
      v-model="view"
      class="split__switch"
      :label="`${label}: list or map`"
      :tabs="[{ id: 'list', label: 'List' }, { id: 'map', label: 'Map', icon: 'map' }]"
    />
    <div class="split__list"><slot name="list" /></div>
    <div class="split__map">
      <button type="button" class="split__expand" :aria-pressed="String(expanded)" @click="expanded = !expanded">
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

/* Map first (Option A, as Home): from 1128px two columns across the whole width of the screen, the map on the left and the list docked
   on the right as a white panel, both down to the screen's foot (the height is measured from where this starts, --split-h). The panel
   scrolls on its own; the page's footer sits at its foot (GroupDetailView), so it leaves room for it. "Expand map" sits beside the zoom
   buttons, and expanded hides the panel. */
@media (min-width: 1128px) {
  .split--first { display: grid; grid-template-columns: minmax(0, 1fr) var(--split-panel, 420px); gap: 0; height: var(--split-h, calc(100dvh - 220px)); min-height: 480px; width: var(--split-w, 100vw); margin-right: 0; margin-left: var(--split-ml, calc(50% - 50vw)); border-top: 1px solid var(--hairline); }
  .split--first .split__map { position: relative; top: auto; grid-column: 1; grid-row: 1; display: block; height: 100%; min-height: 0; max-height: none; border: 0; border-radius: 0; }
  .split--first .split__list { grid-column: 2; grid-row: 1; height: 100%; padding: var(--spacing-base) var(--spacing-base) var(--split-foot, 104px); overflow-y: auto; overscroll-behavior: contain; border-left: 1px solid var(--border-strong); background: var(--canvas); }
  .split--first .split__list > :last-child { flex-grow: 0; }
  .split--first .split__list > :deep(*) { flex-shrink: 0; }
  .split--first.is-expanded { grid-template-columns: minmax(0, 1fr); }
  .split--first.is-expanded .split__list { display: none; }
  .split--first.is-expanded .split__map { height: 100%; }
  .split--first .split__expand { right: auto; left: calc(var(--spacing-md) + 56px); }
}
</style>
