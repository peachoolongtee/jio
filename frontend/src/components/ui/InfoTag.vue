<script setup>
// A small label that is not a control, for example "Near MRT", "Quiet · est." or "Rain expected".
// It has no outline, so it never looks tappable next to a chip.
//   <InfoTag>Near MRT</InfoTag>  <InfoTag tone="warning" icon="rain">Rain expected</InfoTag>
// Tones: neutral (default), lagoon, warning, error.
import AppIcon from './AppIcon.vue'

defineProps({
  tone: { type: String, default: 'neutral', validator: (v) => ['neutral', 'lagoon', 'warning', 'error'].includes(v) },
  icon: { type: String, default: '' },
})
</script>

<template>
  <span class="tag" :class="`tag--${tone}`">
    <AppIcon v-if="icon" :name="icon" :size="12" />
    <slot />
  </span>
</template>

<style scoped>
.tag { flex-shrink: 0; display: inline-flex; align-items: center; gap: var(--spacing-xs); min-height: 22px; padding: var(--spacing-xxs) var(--spacing-sm); border-radius: var(--rounded-full); font: var(--text-caption-sm); white-space: nowrap; }
.tag--neutral { background: var(--surface-strong); color: var(--body); }
.tag--lagoon { background: var(--primary-tint); color: var(--primary-active); }
.tag--warning { background: var(--warning-tint); color: var(--warning-text); }
.tag--error { background: var(--error-tint); color: var(--primary-error-text); }
</style>
