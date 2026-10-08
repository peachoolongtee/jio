<script setup>
// A big number with a label on a flat white card. For stats such as rank and points.
//   <StatTile label="Successful meetups" :value="3" icon="trophy" />
import AppIcon from './AppIcon.vue'

defineProps({
  label: { type: String, required: true },
  value: { type: [Number, String], required: true },
  icon: { type: String, default: '' },
})
</script>

<template>
  <div class="stat">
    <AppIcon v-if="icon" class="stat__icon" :name="icon" :size="20" />
    <span class="stat__value tnum">{{ value }}</span>
    <span class="caption stat__label">{{ label }}</span>
  </div>
</template>

<style scoped>
/* A flat stat: white, hairline, a big ink number over a muted label. */
.stat { display: flex; flex-direction: column; gap: var(--spacing-xxs); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.stat__icon { color: var(--ink); margin-bottom: var(--spacing-xs); }
.stat__value { font: var(--text-display-md); }
.stat__label { color: var(--muted); }
</style>
