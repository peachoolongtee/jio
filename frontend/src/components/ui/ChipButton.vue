<script setup>
// A chip: a 32px pill inside a 44px tap area. Outlined at rest, Lagoon when selected.
//   <ChipButton :selected="vibe === 'Chill'" @click="vibe = 'Chill'">Chill</ChipButton>
// `radio` marks it as one choice in a set (wrap the set in role="radiogroup").
// Without it the chip is a toggle. `check` shows a tick when selected.
// The `leading` slot holds an avatar or an icon.
import AppIcon from './AppIcon.vue'

defineProps({
  selected: { type: Boolean, default: false },
  radio: { type: Boolean, default: false },
  check: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})
</script>

<template>
  <button
    type="button"
    class="chip"
    :class="{ 'is-selected': selected, 'has-leading': $slots.leading }"
    :role="radio ? 'radio' : undefined"
    :aria-checked="radio ? String(selected) : undefined"
    :aria-pressed="radio ? undefined : String(selected)"
    :disabled="disabled"
  >
    <span class="chip__pill">
      <slot name="leading" />
      <span class="chip__text"><slot /></span>
      <AppIcon v-if="check && selected" name="check" :size="12" />
    </span>
  </button>
</template>

<style scoped>
.chip {
  flex-shrink: 0;
  display: inline-flex;
  align-items: center;
  min-width: var(--tap-min);
  min-height: var(--tap-min);
  margin: 0;
  padding: 0;
  border: 0;
  border-radius: var(--rounded-full);
  background: transparent;
  cursor: pointer;
}
.chip__pill {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  min-width: var(--tap-min);
  height: 32px;
  padding: 0 var(--spacing-md);
  border: 1px solid var(--border-strong);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  color: var(--ink);
  font: var(--text-caption);
  white-space: nowrap;
  transition: background-color var(--motion-fast) ease, border-color var(--motion-fast) ease;
}
.chip__text { overflow: hidden; text-overflow: ellipsis; }
/* A chip with an avatar is a little taller and hugs the avatar on the left. */
.chip.has-leading .chip__pill { gap: var(--spacing-sm); height: 40px; padding: 0 var(--spacing-md) 0 var(--spacing-xs); }
.chip.is-selected .chip__pill { border-color: var(--primary); background: var(--primary); color: var(--on-primary); }
.chip:disabled { cursor: not-allowed; }
.chip:disabled .chip__pill { border-color: var(--hairline); color: var(--muted-soft); }
/* The focus ring sits on the pill, not on the larger tap area. */
.chip:focus-visible { outline: none; }
.chip:focus-visible .chip__pill { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (hover: hover) {
  .chip:not(:disabled):hover .chip__pill { border-color: var(--ink); }
  .chip.is-selected:not(:disabled):hover .chip__pill { border-color: var(--primary-active); background: var(--primary-active); }
}
</style>
