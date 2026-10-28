<script setup>
// A round 44px button that says yes or no with a symbol instead of a word: a tick ("check", filled in Rausch: do it) or a cross
// ("close", outlined in ink: undo it). The word is still there for screen readers and as the tooltip: `label` says the whole
// action ("Propose Green Kitchen as the next stop"), and the slot holds the short word, read but not shown.
//   <MarkButton symbol="check" label="Propose Green Kitchen as the next stop" @click="propose">Propose</MarkButton>
//   <MarkButton symbol="close" label="Take back your proposal of Green Kitchen" :busy="working">Take back</MarkButton>
import AppIcon from './AppIcon.vue'

defineProps({
  symbol: { type: String, required: true, validator: (v) => ['check', 'close'].includes(v) },
  label: { type: String, required: true },
  busy: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})
</script>

<template>
  <button type="button" class="mark" :class="`mark--${symbol}`" :disabled="disabled" :aria-busy="busy ? 'true' : undefined" :aria-label="label" :title="label">
    <AppIcon :name="symbol" :size="18" />
    <span class="sr-only"><slot /></span>
  </button>
</template>

<style scoped>
.mark { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); padding: 0; border-radius: var(--rounded-full); font: inherit; cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.mark--check { border: 0; background: var(--primary); color: var(--on-primary); }
.mark--close { border: 1px solid var(--border-strong); background: var(--canvas); color: var(--ink); }
@media (hover: hover) {
  .mark--check:not(:disabled):hover { background: var(--primary-active); }
  .mark--close:not(:disabled):hover { border-color: var(--ink); background: var(--surface-soft); }
}
.mark:not(:disabled):active { transform: scale(0.94); }
.mark:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.mark:disabled { cursor: not-allowed; border-color: transparent; background: var(--surface-strong); color: var(--muted); }
.mark[aria-busy='true'] { cursor: progress; opacity: 0.6; }
@media (prefers-reduced-motion: reduce) { .mark { transition: none; } }
</style>
