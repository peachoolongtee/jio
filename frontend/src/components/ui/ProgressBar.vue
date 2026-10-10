<script setup>
// A thin ink progress bar, for example sign-up steps.
//   <ProgressBar :value="3" :max="9" label="Sign-up progress" />
import { computed } from 'vue'

const props = defineProps({
  value: { type: Number, required: true },
  max: { type: Number, default: 1 },
  label: { type: String, required: true },
})
const width = computed(() => `${Math.min(100, Math.max(0, (props.value / props.max) * 100))}%`)
</script>

<template>
  <div class="bar" role="progressbar" :aria-label="label" :aria-valuenow="value" aria-valuemin="0" :aria-valuemax="max">
    <span class="bar__fill" :style="{ width }" />
  </div>
</template>

<style scoped>
.bar { height: 4px; overflow: hidden; border-radius: var(--rounded-full); background: var(--hairline-soft); }
.bar__fill { display: block; height: 100%; border-radius: var(--rounded-full); background: var(--ink); transition: width var(--motion-fast) var(--ease-out); }
</style>
