<script>
// Is this click an activation by assistive technology (a screen reader, switch or voice control, or Enter on the
// button), not the end of a pointer press or of a key the person was holding? Those clicks have `detail` 0. A mouse
// or touch click has detail 1 or more and still needs the hold. `keyHeld`: a key was pressed on the button just now.
// How to call: isAssistiveClick({ detail: 0 }, false) -> true
export function isAssistiveClick(event, keyHeld = false) {
  return event.detail === 0 && !keyHeld
}
</script>

<script setup>
// A button you press and hold to confirm something that cannot be undone, such as cancelling an outing. While held, a
// fill sweeps across it; letting go early runs it back. Held to the end, it emits `done` (follow it with a
// confirmation). Works with a pointer (mouse, touch) and with Space or Enter held down. A screen reader, switch or
// voice control cannot hold, so their activation (a click that is not from a pointer or a held key) emits `done` at
// once: the confirmation that follows is what keeps it safe.
//   <HoldButton label="Hold to cancel" action="Cancel outing" @done="confirmOpen = true" />
import { onBeforeUnmount, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  label: { type: String, required: true },
  // Said to screen readers, for example "Cancel outing".
  action: { type: String, default: '' },
  icon: { type: String, default: 'close' },
  duration: { type: Number, default: 1200 },
  // A shorter word shown on the narrowest phones (under 360px), where the full label does not fit beside other buttons. The full label
  // stays in the accessible name. For example "Hold to cancel" with short "Cancel".
  short: { type: String, default: '' },
})
const emit = defineEmits(['done'])

const progress = ref(0)
const holding = ref(false)
let frame = 0
let startedAt = 0
let from = 0
// A key went down on the button and its click, if any, has not arrived yet.
let keyHeld = false

function tick(now) {
  progress.value = Math.min(1, from + (now - startedAt) / props.duration)
  if (progress.value >= 1) {
    holding.value = false
    emit('done')
    // Hold the full bar a moment, then empty it.
    setTimeout(() => { progress.value = 0 }, 250)
    return
  }
  frame = requestAnimationFrame(tick)
}

function start() {
  if (holding.value) return
  holding.value = true
  from = progress.value
  startedAt = performance.now()
  frame = requestAnimationFrame(tick)
}

function stop() {
  if (!holding.value) return
  holding.value = false
  cancelAnimationFrame(frame)
  progress.value = 0
}

function onKeydown(event) {
  if (event.repeat) return
  keyHeld = true
  start()
}

// Space sends its click when the key comes up; that click ends a hold, it is not an assistive activation.
function onKeyup() {
  stop()
  setTimeout(() => { keyHeld = false })
}

function onBlur() {
  stop()
  keyHeld = false
}

function onClick(event) {
  if (isAssistiveClick(event, keyHeld)) emit('done')
}

onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <button
    type="button"
    class="hold"
    :class="{ 'is-holding': holding }"
    :style="{ '--p': progress }"
    :aria-label="`${label}${action ? ` (${action})` : ''}. Press and hold, or activate with a screen reader.`"
    @pointerdown.prevent="start"
    @pointerup="stop"
    @pointerleave="stop"
    @pointercancel="stop"
    @keydown.space.prevent="onKeydown"
    @keydown.enter.prevent="onKeydown"
    @keyup.space="onKeyup"
    @keyup.enter="onKeyup"
    @click="onClick"
    @blur="onBlur"
    @contextmenu.prevent
  >
    <span class="hold__fill" aria-hidden="true" />
    <span class="hold__label" aria-hidden="true">
      <AppIcon :name="icon" :size="14" />
      <template v-if="holding">Keep holding</template>
      <template v-else><span class="hold__long">{{ label }}</span><span v-if="short" class="hold__short">{{ short }}</span></template>
    </span>
  </button>
</template>

<style scoped>
.hold__short { display: none; }
@media (max-width: 359.98px) {
  .hold__short { display: inline; }
  .hold__short + * , .hold__long:has(+ .hold__short) { display: none; }
}
.hold { position: relative; overflow: hidden; display: inline-flex; align-items: center; height: var(--tap-min); padding: 0 var(--spacing-base); border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--canvas)); border-radius: var(--rounded-full); background: var(--canvas); color: var(--primary); font: var(--text-button-sm); white-space: nowrap; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
/* The fill: grows from the left as you hold. No transition while holding (it follows the clock); letting go
   runs it back quickly. */
.hold__fill { position: absolute; inset: 0; background: color-mix(in srgb, var(--primary) 16%, var(--canvas)); transform: scaleX(var(--p)); transform-origin: left; transition: transform 220ms var(--ease-out); }
.hold.is-holding .hold__fill { transition: none; }
.hold__label { position: relative; display: inline-flex; align-items: center; gap: 6px; }
@media (hover: hover) { .hold:hover { border-color: var(--primary); } }
.hold:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
