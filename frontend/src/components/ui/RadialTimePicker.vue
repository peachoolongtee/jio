<script setup>
// A 24-hour time in a round pill. Hover it (or tap it on a touch screen) and eight buttons orbit out around it:
// +15m, +30m, +1h, +2h on the right and the same back on the left. Click the time to type one instead;
// "930" becomes 09:30 when you leave the field.
//   <RadialTimePicker v-model="start" label="Start time" />                  start is "HH:mm", or "" for none yet
//   <RadialTimePicker v-model="end" label="End time" fallback="18:00" hint="Ends 18:00" :error="endError" />
// `fallback` is the time the buttons count from while the field is empty (and is shown as its placeholder).
// Times stay within the day: 00:00 to 23:59.
import { computed, onBeforeUnmount, ref, useId, watch } from 'vue'

const model = defineModel({ type: String, default: '' })
const props = defineProps({
  label: { type: String, required: true },
  fallback: { type: String, default: '09:00' },
  hint: { type: String, default: '' },
  error: { type: String, default: '' },
})

// How far the buttons sit from the centre of the time, in px.
const ORBIT = 125
// Where each button sits around the time, in degrees clockwise from the top.
const NODES = [
  { label: '+15m', minutes: 15, angle: 25 },
  { label: '+30m', minutes: 30, angle: 68 },
  { label: '+1h', minutes: 60, angle: 112 },
  { label: '+2h', minutes: 120, angle: 155 },
  { label: '−2h', minutes: -120, angle: 205 },
  { label: '−1h', minutes: -60, angle: 248 },
  { label: '−30m', minutes: -30, angle: 292 },
  { label: '−15m', minutes: -15, angle: 335 },
].map((node) => {
  const radians = ((node.angle - 90) * Math.PI) / 180
  return { ...node, x: Math.round(ORBIT * Math.cos(radians)), y: Math.round(ORBIT * Math.sin(radians)) }
})
const id = `time-${useId()}`
const text = ref(model.value)
watch(model, (v) => { text.value = v })

const hovered = ref(false)
const focused = ref(false)
const tapped = ref(false)
const open = computed(() => (hovered.value || tapped.value) && !focused.value)
let openedAt = 0
watch(open, (v) => { if (v) openedAt = Date.now() })

// While typing: digits only, a colon after the hour, and no hour over 23 or minute tens over 5.
function formatInput(value) {
  let clean = value.replace(/[^\d]/g, '').slice(0, 4)
  if (clean.length > 0 && Number(clean[0]) > 2) clean = `0${clean}`.slice(0, 4)
  if (clean.length > 1 && Number(clean.slice(0, 2)) > 23) clean = `23${clean.slice(2)}`
  if (clean.length > 2 && Number(clean[2]) > 5) clean = `${clean.slice(0, 2)}5${clean.slice(3)}`
  return clean.length >= 3 ? `${clean.slice(0, 2)}:${clean.slice(2)}` : clean
}

// On leaving the field: fill in what is missing ("9" → 09:00, "930" → 09:30). Empty stays empty.
function formatOnBlur(value) {
  let clean = value.replace(/[^\d]/g, '')
  if (!clean) return ''
  if (clean.length === 1) clean = `0${clean}00`
  else if (clean.length === 2) clean = `${clean}00`
  else if (clean.length === 3) clean = `0${clean}`
  const hours = Math.min(23, Number(clean.slice(0, 2)))
  const minutes = Math.min(59, Number(clean.slice(2, 4)))
  return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}`
}

function adjust(minutes) {
  // A button that was still flying out when the tap landed: not a real choice.
  if (Date.now() - openedAt < 250) return
  const [h, m] = (model.value || props.fallback).split(':').map(Number)
  const total = Math.max(0, Math.min(23 * 60 + 59, h * 60 + m + minutes))
  model.value = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
}

function onBlur() {
  focused.value = false
  model.value = formatOnBlur(text.value)
  text.value = model.value
}

// Mouse: open on hover. Leaving waits a moment before closing, so the pointer can cross the gap between the time
// and a button (entering a button counts as entering the picker again).
let closeTimer = 0
function onEnter() {
  clearTimeout(closeTimer)
  hovered.value = true
}
function onLeave() {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => { hovered.value = false }, 300)
}

// Touch screens have no hover: the first tap on the time opens the buttons instead of the keyboard.
// A tap on the time while they are open starts typing; a tap anywhere else closes them.
const root = ref(null)
function onPointerDown(event) {
  if (event.pointerType === 'mouse' || focused.value) return
  if (!tapped.value) {
    event.preventDefault()
    tapped.value = true
    document.addEventListener('pointerdown', closeOnOutside, true)
  }
}
function closeOnOutside(event) {
  if (root.value?.contains(event.target)) return
  tapped.value = false
  document.removeEventListener('pointerdown', closeOnOutside, true)
}
onBeforeUnmount(() => {
  clearTimeout(closeTimer)
  document.removeEventListener('pointerdown', closeOnOutside, true)
})
</script>

<template>
  <div class="tp">
    <label :for="id" class="tp__label caption text-muted">{{ label }}</label>
    <div
      ref="root"
      class="tp__wheel"
      :class="{ 'is-open': open }"
      @mouseenter="onEnter"
      @mouseleave="onLeave"
      @keydown.esc="tapped = false; hovered = false"
    >
      <button
        v-for="(node, i) in NODES"
        :key="node.label"
        type="button"
        class="tp__node"
        :class="node.minutes > 0 ? 'is-later' : 'is-earlier'"
        :style="{ '--x': `${node.x}px`, '--y': `${node.y}px`, '--i': i }"
        :tabindex="open ? 0 : -1"
        :aria-hidden="open ? undefined : 'true'"
        :aria-label="`${label}: ${node.minutes > 0 ? 'later' : 'earlier'} by ${node.label.slice(1)}`"
        @mousedown.prevent
        @click="adjust(node.minutes)"
      >
        {{ node.label }}
      </button>
      <div class="tp__pill" :class="{ 'has-error': error }" @pointerdown="onPointerDown">
        <input
          :id="id"
          v-model="text"
          class="tp__input tnum"
          type="text"
          inputmode="numeric"
          autocomplete="off"
          :placeholder="fallback"
          :aria-invalid="error ? 'true' : undefined"
          :aria-describedby="error || hint ? `${id}-note` : undefined"
          @input="text = formatInput($event.target.value)"
          @focus="focused = true; tapped = false; $event.target.select()"
          @blur="onBlur"
          @keydown.enter.prevent="$event.target.blur()"
        />
      </div>
    </div>
    <p v-if="error" :id="`${id}-note`" class="caption-sm text-error" role="alert">{{ error }}</p>
    <p v-else-if="hint" :id="`${id}-note`" class="caption-sm text-muted">{{ hint }}</p>
  </div>
</template>

<style scoped>
/* Full width with everything centred, so two pickers stay lined up whatever note sits under them. */
.tp { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-sm); width: 100%; text-align: center; }
/* The wheel is as big as the pill; the buttons fly out around it and float over whatever is beside it. */
.tp__wheel { position: relative; z-index: 1; display: inline-flex; }
.tp__wheel.is-open { z-index: 40; }

.tp__pill { position: relative; z-index: 2; padding: var(--spacing-md) var(--spacing-lg); border-radius: var(--rounded-full); background: var(--canvas); box-shadow: 0 0 0 1px var(--hairline), 0 2px 6px rgb(0 0 0 / 0.08); transition: box-shadow var(--motion-fast) var(--ease-out); }
.tp__pill:focus-within { box-shadow: 0 0 0 1px var(--ink), 0 0 0 5px var(--surface-strong), 0 12px 24px -8px rgb(0 0 0 / 0.2); }
.tp__pill.has-error { box-shadow: 0 0 0 2px var(--primary-error-text); }
.tp__input { width: 5.2ch; padding: 0; border: 0; background: transparent; color: var(--ink); font: 700 26px/1.2 var(--font-sans); letter-spacing: 0.04em; text-align: center; outline: none; }
.tp__input::placeholder { color: var(--muted-soft); }

/* The eight buttons: folded behind the time, then sprung out to their place one after another. They sit under the
   pill, so the tap that opens them lands on the time, not on a button passing underneath. */
.tp__node {
  position: absolute;
  top: 50%;
  left: 50%;
  z-index: 1;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  margin: -28px 0 0 -28px;
  padding: 0;
  border: 2px solid var(--hairline);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  box-shadow: 0 4px 10px -2px rgb(0 0 0 / 0.14);
  font: 700 12px/1 var(--font-sans);
  white-space: nowrap;
  cursor: pointer;
  opacity: 0;
  transform: translate(0, 0) scale(0.2);
  pointer-events: none;
  transition: transform 150ms var(--ease-out), opacity 150ms var(--ease-out), background-color var(--motion-fast), border-color var(--motion-fast);
}
.tp__wheel.is-open .tp__node {
  opacity: 1;
  transform: translate(var(--x), var(--y)) scale(1);
  pointer-events: auto;
  transition: transform 420ms var(--ease-spring) calc(var(--i) * 18ms), opacity 200ms var(--ease-out) calc(var(--i) * 18ms), background-color var(--motion-fast), border-color var(--motion-fast);
}
/* Later in Rausch, earlier in ink. */
.tp__node.is-later { border-color: color-mix(in srgb, var(--primary) 28%, var(--canvas)); color: var(--primary-active); }
.tp__node.is-earlier { color: var(--body); }
@media (hover: hover) {
  .tp__wheel.is-open .tp__node:hover { transform: translate(var(--x), var(--y)) scale(1.08); }
  .tp__node.is-later:hover { border-color: var(--primary); background: color-mix(in srgb, var(--primary) 8%, var(--canvas)); }
  .tp__node.is-earlier:hover { border-color: var(--border-strong); background: var(--surface-soft); }
}
.tp__wheel.is-open .tp__node:active { transform: translate(var(--x), var(--y)) scale(0.95); }
.tp__node:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

@media (prefers-reduced-motion: reduce) {
  .tp__node, .tp__wheel.is-open .tp__node { transition: opacity 120ms linear; }
}
</style>
