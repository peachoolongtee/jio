<script setup>
// One big choice of a set of radio cards (the Start choice, and "We're here now" beside the area chips). The whole card is the
// radio; the selected one has the 2px ink outline a selected spot has, and a filled dot. Put the cards in an element with
// role="radiogroup" and `v-radio-group` (lib/radioGroup.js): the set is one Tab stop and the arrow keys move between cards.
//   <ChoiceCard :selected="choice === 'fairest'" icon="people" @click="choice = 'fairest'">
//     <template #title>Find the fairest spot</template> <template #text>...</template> <template #meta>...</template>
//   </ChoiceCard>
// A disabled card stays focusable (aria-disabled) and ignores clicks, so focus is not lost while a request runs.
import AppIcon from '../ui/AppIcon.vue'

const props = defineProps({
  selected: { type: Boolean, default: false },
  disabled: { type: Boolean, default: false },
  icon: { type: String, default: 'pin' },
})
const emit = defineEmits(['click'])

// How to call: <button @click="onClick"> (passes the click on unless the card is disabled)
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
    role="radio"
    class="choice"
    :class="{ 'is-selected': selected }"
    :aria-checked="String(selected)"
    :aria-disabled="disabled ? 'true' : undefined"
    @click="onClick"
  >
    <span class="choice__icon" aria-hidden="true"><AppIcon :name="icon" :size="24" /></span>
    <span class="choice__body">
      <span class="choice__title title-md"><slot name="title" /><span v-if="$slots.tag" class="choice__tag"><slot name="tag" /></span></span>
      <span class="choice__text body-sm text-muted"><slot name="text" /></span>
      <span v-if="$slots.meta" class="choice__meta caption-sm"><slot name="meta" /></span>
    </span>
    <span class="choice__dot" aria-hidden="true" />
  </button>
</template>

<style scoped>
/* A flat card with a hairline. The selected one has a 2px ink outline and a soft fill (the padding gives back the pixel so nothing moves). */
.choice { display: flex; align-items: flex-start; gap: var(--spacing-md); width: 100%; min-width: 0; min-height: var(--tap-min); margin: 0; padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); font: inherit; text-align: left; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: border-color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out); }
.choice.is-selected { padding: calc(var(--spacing-base) - 1px); border: 2px solid var(--ink); background: var(--surface-soft); }
@media (hover: hover) { .choice:not(.is-selected):hover { border-color: var(--border-control); } }
.choice:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.choice__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.choice__body { flex: 1 1 0; display: flex; flex-direction: column; gap: var(--spacing-xs); min-width: 0; }
.choice__title { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); overflow-wrap: anywhere; }
/* "Default": an ink outline on white, like the other tags. */
.choice__tag { display: inline-flex; align-items: center; min-height: 22px; padding: 1px 7px; border: 1px solid var(--ink); border-radius: var(--rounded-full); background: var(--canvas); font: var(--text-caption-sm); font-weight: 600; white-space: nowrap; }
.choice__meta { color: var(--body); }
.choice__dot { flex-shrink: 0; display: inline-grid; place-items: center; width: 24px; height: 24px; margin-top: 1px; border: 1px solid var(--border-control); border-radius: var(--rounded-full); background: var(--canvas); }
.choice__dot::after { content: ""; width: 12px; height: 12px; border-radius: var(--rounded-full); background: var(--ink); transform: scale(0); transition: transform 260ms var(--ease-spring); }
.choice.is-selected .choice__dot { border-color: var(--ink); }
.choice.is-selected .choice__dot::after { transform: scale(1); }
@media (prefers-reduced-motion: reduce) { .choice, .choice__dot::after { transition: none; } }
</style>
