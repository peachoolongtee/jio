<script setup>
// A progress bar made of rounded segments that fill left to right, with the percentage above it.
//   <SegmentedProgress :value="64" label="Finding the meeting point" />
// value: 0 to 100. segments: how many blocks (20 by default, so each is 5%).
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, required: true },
  label: { type: String, default: '' },
  segments: { type: Number, default: 20 },
})

const pct = computed(() => Math.max(0, Math.min(100, Math.round(props.value))))
const filled = computed(() => Math.round((pct.value / 100) * props.segments))
</script>

<template>
  <div class="seg" role="progressbar" :aria-valuenow="pct" aria-valuemin="0" aria-valuemax="100" :aria-label="label || undefined">
    <div class="seg__head">
      <span class="seg__pct tnum">{{ pct }}%</span>
      <span v-if="label" class="caption text-muted">{{ label }}</span>
    </div>
    <div class="seg__track" :style="{ '--n': segments }">
      <span v-for="i in segments" :key="i" class="seg__block" :class="{ 'is-on': i <= filled, 'is-edge': i === filled }" />
    </div>
  </div>
</template>

<style scoped>
.seg { display: flex; flex-direction: column; gap: var(--spacing-md); }
.seg__head { display: flex; align-items: baseline; justify-content: space-between; gap: var(--spacing-md); }
.seg__pct { color: var(--ink); font: var(--text-display-sm); }
.seg__track { display: grid; grid-template-columns: repeat(var(--n), minmax(0, 1fr)); gap: 5px; }
/* Each block: pale until reached, then Rausch. The newest block pops a little as it fills. */
.seg__block { height: 14px; border-radius: 5px; background: var(--surface-strong); transition: background-color 160ms var(--ease-out), transform 260ms var(--ease-spring); }
.seg__block.is-on { background: var(--primary); }
.seg__block.is-edge { transform: scaleY(1.25); }
@media (prefers-reduced-motion: reduce) { .seg__block { transition: none; } .seg__block.is-edge { transform: none; } }
</style>
