<script setup>
// A button you press and hold to confirm something that cannot be undone, such as ending a session. While held, a
// fill sweeps across it; letting go early runs it back. Held to the end, it emits `done` (follow it with a
// confirmation). Works with a pointer (mouse, touch) and with Space or Enter held down.
//   <HoldButton label="Hold to end" @done="confirmOpen = true" />
import { onBeforeUnmount, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  label: { type: String, required: true },
  // Said to screen readers, for example "End session".
  action: { type: String, default: '' },
  icon: { type: String, default: 'close' },
  duration: { type: Number, default: 1200 },
})
const emit = defineEmits(['done'])

const progress = ref(0)
const holding = ref(false)
let frame = 0
let startedAt = 0
let from = 0

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
  start()
}

onBeforeUnmount(() => cancelAnimationFrame(frame))
</script>

<template>
  <button
    type="button"
    class="hold"
    :class="{ 'is-holding': holding }"
    :style="{ '--p': progress }"
    :aria-label="`${action || label}. Press and hold.`"
    @pointerdown.prevent="start"
    @pointerup="stop"
    @pointerleave="stop"
    @pointercancel="stop"
    @keydown.space.prevent="onKeydown"
    @keydown.enter.prevent="onKeydown"
    @keyup.space="stop"
    @keyup.enter="stop"
    @blur="stop"
    @contextmenu.prevent
  >
    <span class="hold__fill" aria-hidden="true" />
    <span class="hold__label" aria-hidden="true">
      <AppIcon :name="icon" :size="14" />
      {{ holding ? 'Keep holding' : label }}
    </span>
  </button>
</template>

<style scoped>
.hold { position: relative; overflow: hidden; display: inline-flex; align-items: center; height: var(--tap-min); padding: 0 var(--spacing-base); border: 1px solid color-mix(in srgb, var(--primary) 35%, var(--canvas)); border-radius: var(--rounded-full); background: var(--canvas); color: var(--primary); font: var(--text-button-sm); white-space: nowrap; cursor: pointer; touch-action: none; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; -webkit-tap-highlight-color: transparent; }
/* The fill: grows from the left as you hold. No transition while holding (it follows the clock); letting go
   runs it back quickly. */
.hold__fill { position: absolute; inset: 0; background: color-mix(in srgb, var(--primary) 16%, var(--canvas)); transform: scaleX(var(--p)); transform-origin: left; transition: transform 220ms var(--ease-out); }
.hold.is-holding .hold__fill { transition: none; }
.hold__label { position: relative; display: inline-flex; align-items: center; gap: 6px; }
@media (hover: hover) { .hold:hover { border-color: var(--primary); } }
.hold:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
