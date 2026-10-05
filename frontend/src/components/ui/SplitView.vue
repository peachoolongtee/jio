<script setup>
// A list and a map that show the same things.
//   Mobile and tablet: one at a time, with a List / Map switch above.
//   Desktop: side by side, list on the left and map on the right. The map can be expanded.
//   <SplitView v-model:view="view" label="Meeting area">
//     <template #list> ... </template>
//     <template #map> <PlannerMap ... /> </template>
//   </SplitView>
// The layout changes with CSS only, so the list and the map keep their state when the window is resized.
import { ref } from 'vue'
import AppIcon from './AppIcon.vue'
import SegmentTabs from './SegmentTabs.vue'

const view = defineModel('view', { type: String, default: 'list' })
defineProps({
  label: { type: String, required: true },
})
const expanded = ref(false)
</script>

<template>
  <div class="split" :class="[`split--${view}`, { 'is-expanded': expanded }]">
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
.split__map { position: relative; height: 60dvh; min-height: 320px; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--rounded-md); }
.split__expand { display: none; }
.split--list .split__map { display: none; }
.split--map .split__list { display: none; }

@media (min-width: 1128px) {
  .split { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: start; gap: var(--spacing-lg); }
  .split__switch { display: none; }
  .split--list .split__map, .split--map .split__list { display: flex; }
  .split__map { position: sticky; top: var(--spacing-lg); display: block; height: min(640px, calc(100dvh - 160px)); }
  .split--list .split__map { display: block; }
  .split.is-expanded { grid-template-columns: minmax(0, 1fr); }
  .split.is-expanded .split__list { display: none; }
  .split.is-expanded .split__map { height: calc(100dvh - 200px); }
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
</style>
