<script setup>
// Text tabs in the Airbnb category-tab style: muted labels, the current one in ink with a 2px ink rule beneath.
// For example Upcoming / Past or List / Map.
//   <SegmentTabs v-model="tab" label="Sessions" :tabs="[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }]" />
// A tab can carry an `icon` from AppIcon; with `iconOnly` the label is kept for screen readers only.
import AppIcon from './AppIcon.vue'

const model = defineModel({ type: String, required: true })
defineProps({
  tabs: { type: Array, required: true },
  // What this set of tabs switches, for screen readers.
  label: { type: String, required: true },
})
</script>

<template>
  <nav class="seg" :aria-label="label">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      class="seg__tab"
      :class="{ 'is-active': model === tab.id }"
      :aria-pressed="String(model === tab.id)"
      :aria-label="tab.iconOnly ? tab.label : undefined"
      :title="tab.iconOnly ? tab.label : undefined"
      @click="model = tab.id"
    >
      <AppIcon v-if="tab.icon" :name="tab.icon" :size="16" />
      <span v-if="!tab.iconOnly">{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.seg { display: flex; gap: var(--spacing-lg); max-width: 100%; overflow-x: auto; border-bottom: 1px solid var(--hairline); scrollbar-width: none; }
.seg::-webkit-scrollbar { display: none; }
.seg__tab {
  flex: none;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  min-width: var(--tap-min);
  min-height: var(--tap-min);
  padding: var(--spacing-md) 0;
  border: 0;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  background: transparent;
  color: var(--muted);
  font: var(--text-button-sm);
  white-space: nowrap;
  transition: color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out);
}
.seg__tab.is-active { border-bottom-color: var(--ink); color: var(--ink); font-weight: 600; }
.seg__tab:focus-visible { outline-offset: -2px; }
@media (hover: hover) { .seg__tab:not(.is-active):hover { color: var(--ink); border-bottom-color: var(--hairline); } }
</style>
