<script setup>
// A strip of text tabs with an underline on the current one, for example Upcoming / Past.
//   <SegmentTabs v-model="tab" label="Plan lists" :tabs="[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }]" />
// The current tab is Lagoon. A tab can carry an `icon` name from AppIcon.
import AppIcon from './AppIcon.vue'

const model = defineModel({ type: String, required: true })
defineProps({
  tabs: { type: Array, required: true },
  // What this set of tabs switches, for screen readers.
  label: { type: String, required: true },
})
</script>

<template>
  <nav class="tabs" :aria-label="label">
    <button
      v-for="tab in tabs"
      :key="tab.id"
      type="button"
      class="tabs__tab"
      :class="{ 'is-active': model === tab.id }"
      :aria-pressed="String(model === tab.id)"
      @click="model = tab.id"
    >
      <AppIcon v-if="tab.icon" :name="tab.icon" :size="14" />
      <span>{{ tab.label }}</span>
    </button>
  </nav>
</template>

<style scoped>
.tabs { display: flex; gap: var(--spacing-lg); border-bottom: 1px solid var(--hairline); overflow-x: auto; scrollbar-width: none; }
.tabs::-webkit-scrollbar { display: none; }
.tabs__tab {
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
  background: transparent;
  color: var(--muted);
  font: var(--text-button-sm);
  white-space: nowrap;
}
.tabs__tab.is-active { border-bottom-color: var(--primary); color: var(--primary); }
.tabs__tab:focus-visible { outline-offset: -2px; }
@media (hover: hover) { .tabs__tab:not(.is-active):hover { color: var(--ink); } }
</style>
