<script setup>
// The white chip on a map that names its rain: a cloud-rain icon and a few words. Information, not a button: it takes no pointer
// events, has no tap target and is not focusable. The caller places it (absolute, over a corner of the map) and chooses the words
// with lib/rainLook.js rainChipText, which says "Rain likely · next 2 h" only for the live two-hour forecast.
//   <RainChip :text="rainChipText(block)" />               on Home's map the page already says it in words, so add aria-hidden="true"
//   <RainChip :text="rainChipText(block)" class="pm-rain-chip" />    on a session map the chip is the words for the rain, so it is read
// An empty `text` draws nothing.
import AppIcon from '../ui/AppIcon.vue'

defineProps({
  text: { type: String, default: '' },
})
</script>

<template>
  <span v-if="text" class="rain-chip rain-chip-in" data-testid="rain-chip"><AppIcon name="rain" :size="16" />{{ text }}</span>
</template>

<style scoped>
.rain-chip { display: inline-flex; align-items: center; gap: var(--spacing-xs); height: 32px; padding: 0 var(--spacing-md) 0 10px; border-radius: var(--rounded-full); background: var(--canvas); color: var(--rain-text); box-shadow: var(--shadow-float); font: var(--text-caption); white-space: nowrap; pointer-events: none; user-select: none; }
/* It arrives a moment after the rain, rising a few pixels. */
.rain-chip-in { animation: rain-chip-in 600ms var(--ease-out) 200ms both; }
@keyframes rain-chip-in { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
@media (prefers-reduced-motion: reduce) {
  .rain-chip-in { animation: none; }
}
</style>
