<script setup>
// A small label that is not a control, for example "Near MRT", "Leading" or "Rain expected".
// It has no outline, so it never looks tappable next to a chip.
//   <InfoTag>Near MRT</InfoTag>  <InfoTag tone="warning" icon="rain">Rain expected</InfoTag>
// Tones: neutral (grey, default), strong (ink outline, for "Fairest", "Added" or "Leading"), warning and error
// (error red text), and the dietary tones halal (brown) and veg (green, for vegetarian and vegan).
//   <InfoTag tone="halal">Halal likely</InfoTag>
import AppIcon from './AppIcon.vue'

defineProps({
  tone: { type: String, default: 'neutral', validator: (v) => ['neutral', 'strong', 'warning', 'error', 'halal', 'veg'].includes(v) },
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
.tag--strong { border: 1px solid var(--ink); padding: 1px 7px; background: var(--canvas); color: var(--ink); font-weight: 600; }
.tag--warning, .tag--error { background: var(--surface-soft); color: var(--primary-error-text); }
.tag--halal { background: var(--diet-halal-bg); color: var(--diet-halal-fg); }
.tag--veg { background: var(--diet-veg-bg); color: var(--diet-veg-fg); }
</style>
