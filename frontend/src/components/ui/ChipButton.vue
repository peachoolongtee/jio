<script setup>
// A chip: a 32px pill inside a 44px tap area. Hairline-outlined at rest, ink when selected.
//   <ChipButton :selected="vibe === 'Chill'" @click="vibe = 'Chill'">Chill</ChipButton>
// `radio` marks it as one choice in a set (wrap the set in role="radiogroup").
// Without it the chip is a toggle. `check` shows a tick when selected.
// The `leading` slot holds an avatar or an icon.
// Set --chip-on (for example to a category colour) to fill the selected chip with it instead of ink.
// A disabled chip stays focusable (aria-disabled) and ignores clicks, so focus is not lost while a request runs. A chip given
// aria-busy="true" dims while its change is saved.
// A set of radio chips gets one Tab stop and the arrow keys from v-radio-group on its radiogroup.
import AppIcon from './AppIcon.vue'

const props = defineProps({
  selected: { type: Boolean, default: false },
  radio: { type: Boolean, default: false },
  check: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
})
const emit = defineEmits(['click'])

// How to call: <button @click="onClick"> (passes the click on unless the chip is disabled)
function onClick(event) {
  if (props.disabled) {
    event.preventDefault()
    return
  }
  emit('click', event)
}
</script>

<template>
  <button
    type="button"
    class="chip"
    :class="{ 'is-selected': selected, 'has-leading': $slots.leading }"
    :role="radio ? 'radio' : undefined"
    :aria-checked="radio ? String(selected) : undefined"
    :aria-pressed="radio ? undefined : String(selected)"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="onClick"
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
  border: 1px solid var(--border-control);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  color: var(--ink);
  font: var(--text-caption);
  white-space: nowrap;
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), transform 260ms var(--ease-spring);
}
.chip:not([aria-disabled="true"]):active .chip__pill { transform: scale(0.94); }
/* Turning a chip on pops it, so the choice registers. */
.chip.is-selected .chip__pill { animation: chip-pop 320ms var(--ease-spring); }
@keyframes chip-pop { 0% { transform: scale(0.9); } 100% { transform: scale(1); } }
@media (prefers-reduced-motion: reduce) { .chip.is-selected .chip__pill { animation: none; } }
.chip:not([aria-disabled="true"]):active .chip__pill { border-color: var(--ink); background: var(--surface-strong); transition-duration: 0ms; }
.chip.is-selected:not([aria-disabled="true"]):active .chip__pill { border-color: var(--chip-on, var(--body)); background: var(--chip-on, var(--body)); filter: brightness(0.9); }
.chip__text { overflow: hidden; text-overflow: ellipsis; }
/* A chip with an avatar is a little taller and hugs the avatar on the left. */
.chip.has-leading .chip__pill { gap: var(--spacing-sm); height: 40px; padding: 0 var(--spacing-md) 0 var(--spacing-xs); }
.chip.is-selected .chip__pill { border-color: var(--chip-on, var(--selected)); background: var(--chip-on, var(--selected)); color: var(--on-selected); }
/* A disabled chip that is not chosen fades. A chosen one keeps its fill and white text, so it stays readable. */
.chip[aria-disabled="true"] { cursor: not-allowed; }
.chip[aria-disabled="true"]:not(.is-selected) .chip__pill { border-color: var(--hairline); color: var(--muted-soft); }
/* A chip that is saving (aria-busy) dims and shows the progress cursor, and stays enabled so the keyboard focus stays. */
.chip[aria-busy="true"] { cursor: progress; }
.chip[aria-busy="true"] .chip__pill { opacity: 0.6; }
/* The focus ring sits on the pill, not on the larger tap area. */
.chip:focus-visible { outline: none; }
.chip:focus-visible .chip__pill { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (hover: hover) {
  .chip:not([aria-disabled="true"]):hover .chip__pill { border-color: var(--ink); }
  .chip.is-selected:not([aria-disabled="true"]):hover .chip__pill { border-color: var(--chip-on, var(--body)); background: var(--chip-on, var(--body)); filter: brightness(1.06); }
}
</style>
