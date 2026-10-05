<script>
// Kept outside <script setup> so the prop validator below can use it.
const MODES = { walk: 'Walk', mrt: 'MRT', grab: 'Grab' }
</script>

<script setup>
// The link between two stops: a line and a visible three-way switch, Walk, MRT and Grab,
// each with its own time. Choosing one moves every later stop.
//   <TravelConnector :options="{ walk: 12, mrt: 9, grab: 7 }" mode="walk" @change="setMode(index, $event)" />
// Set `readonly` where the mode cannot be changed: only the chosen mode is shown.
import { useId } from 'vue'
import AppIcon from '../ui/AppIcon.vue'

defineProps({
  options: { type: Object, required: true },
  mode: { type: String, required: true, validator: (v) => v in MODES },
  readonly: { type: Boolean, default: false },
  // Names for screen readers, for example "Bishan Public Library to Junction 8".
  label: { type: String, default: 'Travel between stops' },
})
defineEmits(['change'])
const id = useId()
</script>

<template>
  <div class="leg">
    <span class="leg__line" aria-hidden="true" />
    <span v-if="readonly" class="leg__chip">
      <AppIcon :name="mode" />
      {{ MODES[mode] }} · {{ options[mode] }} min
    </span>
    <div v-else class="leg__switch" role="radiogroup" :aria-label="label">
      <label v-for="(text, key) in MODES" :key="key" class="leg__opt" :class="{ 'is-on': mode === key }">
        <input
          class="sr-only"
          type="radio"
          :name="`leg-${id}`"
          :value="key"
          :checked="mode === key"
          @change="$emit('change', key)"
        />
        <AppIcon :name="key" />
        <span class="leg__text">
          <span class="caption">{{ text }}</span>
          <span class="caption-sm leg__min">{{ options[key] }} min</span>
        </span>
      </label>
    </div>
  </div>
</template>

<style scoped>
.leg { display: flex; align-items: stretch; gap: var(--spacing-md); padding: var(--spacing-xs) 0 var(--spacing-xs) var(--spacing-lg); }
.leg__line { flex-shrink: 0; width: 2px; margin: calc(var(--spacing-xs) * -1) 0; border-radius: var(--rounded-full); background: var(--primary-tint-strong); }
.leg__chip { display: inline-flex; align-items: center; gap: var(--spacing-xs); align-self: center; height: 32px; padding: 0 var(--spacing-md); border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); font: var(--text-caption); }
.leg__switch { flex: 1 1 auto; display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); max-width: 360px; padding: 3px; border: 1px solid var(--border-strong); border-radius: var(--rounded-sm); background: var(--canvas); }
.leg__opt { position: relative; display: flex; align-items: center; justify-content: center; gap: var(--spacing-xs); min-height: var(--tap-min); padding: 0 var(--spacing-xs); border-radius: 6px; color: var(--body); cursor: pointer; transition: background-color var(--motion-fast) ease; }
.leg__text { display: flex; flex-direction: column; line-height: 1.1; }
.leg__opt.is-on { background: var(--primary); color: var(--on-primary); }
.leg__opt.is-on .leg__min { color: var(--on-primary); }
.leg__min { color: var(--muted); }
.leg__opt:focus-within { outline: 2px solid var(--ink); outline-offset: 1px; }
@media (hover: hover) { .leg__opt:not(.is-on):hover { background: var(--surface-soft); color: var(--ink); } }
</style>
