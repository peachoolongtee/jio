<script setup>
// A small label that is not a control, for example "Near MRT", "Quiet · est." or "Rain expected".
// It has no outline, so it never looks tappable next to a chip.
//   <InfoTag>Near MRT</InfoTag>  <InfoTag tone="warning" icon="rain">Rain expected</InfoTag>
// Tones: neutral (grey, default), strong (ink outline, for "Fairest", "Added" or "Leading"), warning and error
// (error red text), and good and middle (the data scale, for crowd levels: always with words).
import AppIcon from './AppIcon.vue'

defineProps({
  tone: { type: String, default: 'neutral', validator: (v) => ['neutral', 'strong', 'warning', 'error', 'good', 'middle'].includes(v) },
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
.tag--good { background: var(--surface-soft); color: var(--scale-good); }
.tag--middle { background: var(--surface-soft); color: var(--scale-middle); }
</style>
