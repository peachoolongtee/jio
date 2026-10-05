<script setup>
// A big number with a label, on a soft tint. For profile stats such as successful meetups and points.
//   <StatTile label="Successful meetups" :value="3" icon="trophy" />
import AppIcon from './AppIcon.vue'

defineProps({
  label: { type: String, required: true },
  value: { type: [Number, String], required: true },
  icon: { type: String, default: '' },
  tone: { type: String, default: 'lagoon', validator: (v) => ['lagoon', 'warm'].includes(v) },
})
</script>

<template>
  <div class="stat" :class="`stat--${tone}`">
    <AppIcon v-if="icon" class="stat__icon" :name="icon" :size="20" />
    <span class="display-xl stat__value">{{ value }}</span>
    <span class="caption stat__label">{{ label }}</span>
  </div>
</template>

<style scoped>
.stat { display: flex; flex-direction: column; gap: var(--spacing-xxs); padding: var(--spacing-base); border-radius: var(--rounded-md); }
.stat__value { line-height: 1.2; }
.stat--lagoon { background: var(--primary-tint); }
.stat--lagoon .stat__icon { color: var(--primary-active); }
.stat--warm { background: var(--cat-drink-bg); }
.stat--warm .stat__icon { color: var(--cat-drink-fg); }
.stat__label { color: var(--body); }
</style>
