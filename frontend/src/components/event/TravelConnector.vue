<script>
// Kept outside <script setup> so the prop validator below can use it.
const MODES = { walk: 'Walk', mrt: 'MRT', car: 'Car' }
</script>

<script setup>
// The link between two stops: a line and a visible three-way switch, Walk, MRT and Car,
// each with its own time. Choosing one moves every later stop. The times are estimates from the distance between
// the stops, so screen readers hear "about". On screen each choice is its symbol and its time, with no word and no "est." (Darius,
// 4 November 2026); the mode's name stays for screen readers and as a tooltip.
//   <TravelConnector :options="{ walk: 12, mrt: 9, car: 7 }" mode="walk" @change="setMode(index, $event)" />
// Set `readonly` where the mode cannot be changed: only the chosen mode is shown.
// Two stops in the same place (every mode 0 min) just say so: there is nothing to choose.
// Inside a .timeline list it sits on the rail, between two stops.
import { computed, useId } from 'vue'
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps({
  options: { type: Object, required: true },
  mode: { type: String, required: true, validator: (v) => v in MODES },
  readonly: { type: Boolean, default: false },
  // For screen readers, for example "Travel from Bishan Public Library to Junction 8".
  label: { type: String, default: 'Travel between stops' },
})
defineEmits(['change'])
const id = useId()
const together = computed(() => Object.values(props.options).every((m) => m === 0))
</script>

<template>
  <div class="leg">
    <span class="leg__rail" aria-hidden="true" />
    <span v-if="together" class="leg__fixed caption-sm text-muted">
      <AppIcon name="pin" :size="14" />
      Same building · no travel needed
    </span>
    <span v-else-if="readonly" class="leg__fixed caption-sm text-muted">
      <AppIcon :name="mode" :size="14" />
      {{ MODES[mode] }} about {{ options[mode] }} min
    </span>
    <div v-else class="leg__group">
      <div class="leg__switch" role="radiogroup" :aria-label="label">
        <label v-for="(text, key) in MODES" :key="key" class="leg__opt" :class="{ 'is-on': mode === key }" :title="text">
          <input class="sr-only" type="radio" :name="`leg-${id}`" :value="key" :checked="mode === key" @change="$emit('change', key)" />
          <AppIcon :name="key" :size="14" />
          <span class="leg__name sr-only">{{ text }}</span>
          <span class="leg__min"><span class="sr-only">about </span>{{ options[key] }} min</span>
        </label>
      </div>
    </div>
  </div>
</template>

<style scoped>
.leg { display: grid; grid-template-columns: 28px minmax(0, 1fr); align-items: center; gap: var(--spacing-md); padding: var(--spacing-xs) 0; }
.leg__fixed { display: inline-flex; align-items: center; gap: var(--spacing-xs); min-height: 32px; }
.leg__group { display: flex; flex-wrap: wrap; align-items: center; justify-self: start; gap: var(--spacing-xs) var(--spacing-sm); min-width: 0; }
.leg__switch { display: inline-flex; gap: 2px; padding: 2px; border-radius: var(--rounded-full); background: var(--surface-strong); }
.leg__opt { position: relative; display: inline-flex; align-items: center; gap: var(--spacing-xs); min-height: 36px; padding: 0 var(--spacing-md); border-radius: var(--rounded-full); color: var(--body); font: var(--text-caption-sm); white-space: nowrap; cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
/* The tap area reaches 44px without making the pill taller. */
.leg__opt::after { content: ""; position: absolute; inset: -4px 0; }
.leg__min { color: var(--muted); }
/* Phones: icon and minutes only; the mode name stays available to screen readers. */
@media (max-width: 743.98px) {
  .leg__name { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); white-space: nowrap; }
  .leg__opt { padding: 0 var(--spacing-md) 0 var(--spacing-sm); }
}
/* Narrow phones: tighter pills, so the three modes stay inside the card at 320px. */
@media (max-width: 399.98px) {
  .leg { gap: var(--spacing-sm); }
  .leg__opt { gap: 2px; padding: 0 var(--spacing-sm) 0 var(--spacing-xs); }
}
.leg__opt.is-on { background: var(--selected); color: var(--on-selected); font-weight: 600; }
.leg__opt.is-on .leg__min { color: var(--on-selected); }
.leg__opt:focus-within { outline: 2px solid var(--ink); outline-offset: 1px; }
@media (hover: hover) { .leg__opt:not(.is-on):hover { color: var(--ink); } }
</style>
