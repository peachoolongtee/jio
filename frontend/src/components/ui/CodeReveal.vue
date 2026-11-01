<script setup>
// A voucher code under a red sticker that peels back. At rest the sticker is flat and covers the whole box; on hover (or keyboard
// focus) its corner lifts, to say it can be peeled. Pressing the sticker peels it off and shows the code, which stays on screen and can be
// selected (one click selects all of it, to copy by hand), with a Copy button beside it. A copy says "Copied" beside the code for a moment,
// then goes back to the code and the button; the code is never replaced (review of 1 November 2026: "Copied" used to replace it until the
// page was left, and nothing could be selected).
//   <CodeReveal code="JIO-AAAA-BBBB" front="Show code" back="Your code" label="SGD 3 off any coffee" />
// The Vue form of a peel-back coupon button (a React and Tailwind one was the model, Faith, 31 October 2026): the sticker is Rausch
// (--primary) with white text, like every main button, and the code sits on a pale Rausch wash inside a dashed Rausch line.
// `code` is what is shown and copied; `front` is on the sticker, `back` under it before the code shows; `label` names the voucher
// for a screen reader. Emits `reveal` the first time it is peeled.
// Two buttons, never one inside the other: the sticker (a button until it is peeled; then it is gone, and focus moves to Copy, so the
// keyboard goes Tab to the sticker, Enter to peel, Enter again to copy) and Copy. What is said to a screen reader is in a live region beside
// them, not inside either.
// The sticker's edge is drawn in pixels from the box's own width, which a ResizeObserver keeps up to date. With reduced motion it
// still peels, without the slide.
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  code: { type: String, required: true },
  front: { type: String, default: 'Show code' },
  back: { type: String, default: 'Your code' },
  label: { type: String, default: '' },
})
const emit = defineEmits(['reveal'])

const box = ref(null)
const copyButton = ref(null)
const codeText = ref(null)
const width = ref(240)
const hovered = ref(false)
const peeled = ref(false)
const copied = ref(false)
const announcement = ref('')

// How long "Copied" stays beside the code, in ms.
const NOTE_MS = 2500
let noteTimer = 0

let observer = null
onMounted(() => {
  if (!box.value) return
  width.value = box.value.getBoundingClientRect?.().width || width.value
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) width.value = entry.contentRect.width
  })
  observer.observe(box.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
  clearTimeout(noteTimer)
})

// Where the sticker's torn edge meets the top, in pixels: past the right edge at rest (the whole box is covered), lifted on hover,
// off to the left once peeled.
const FLAP = 24
const lifting = computed(() => hovered.value && !peeled.value)
const peelX = computed(() => (peeled.value ? -2 * FLAP : lifting.value ? width.value - 2 * FLAP : width.value + FLAP))
const stickerClip = computed(() => `polygon(0px 0px, ${peelX.value}px 0px, ${peelX.value - FLAP}px 100%, 0px 100%)`)
const flapStyle = computed(() => ({
  left: `${peeled.value ? -36 : peelX.value - 36}px`,
  opacity: lifting.value ? 1 : 0,
  transform: `scale(${lifting.value ? 1.05 : 0.8})`,
}))
const peelName = computed(() => `${props.front}${props.label ? `: ${props.label}` : ''}`)
const copyName = computed(() => `Copy code ${props.code}${props.label ? `, ${props.label}` : ''}`)

// Peel the sticker off and move focus to Copy, since the sticker is gone. How to call: <button @click="peel">
function peel() {
  if (peeled.value) return
  peeled.value = true
  announcement.value = `Code ${props.code}. Press Copy to copy it.`
  emit('reveal')
  nextTick(() => copyButton.value?.focus?.({ preventScroll: true }))
}

// Select the whole code, so it can be copied by hand. How to call: selectCode()
function selectCode() {
  const selection = typeof window !== 'undefined' ? window.getSelection?.() : null
  if (!selection || !codeText.value) return
  selection.removeAllRanges()
  const range = document.createRange()
  range.selectNodeContents(codeText.value)
  selection.addRange(range)
}

// Copy the code. When the browser refuses, the code is selected and a sentence says to copy it by hand. How to call: <button @click="copy">
async function copy() {
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    announcement.value = 'Copied'
    clearTimeout(noteTimer)
    noteTimer = setTimeout(() => { copied.value = false }, NOTE_MS)
  } catch {
    // Copying is refused here (an older browser, or no permission): the code is selected on screen to copy by hand.
    selectCode()
    announcement.value = `Could not copy. The code ${props.code} is selected: copy it by hand.`
  }
}
</script>

<template>
  <div ref="box" class="reveal" :class="{ 'is-peeled': peeled, 'is-copied': copied }" data-testid="code-reveal">
    <!-- Under the sticker: the words, then the code once peeled. -->
    <div class="reveal__under">
      <span v-if="!peeled" class="reveal__line" aria-hidden="true">{{ back }}</span>
      <template v-else>
        <code ref="codeText" class="reveal__code" data-testid="code-text" @click="selectCode">{{ code }}</code>
        <span v-if="copied" class="reveal__note" aria-hidden="true" data-testid="code-copied">Copied</span>
        <button ref="copyButton" type="button" class="reveal__copy" :aria-label="copyName" data-testid="code-copy" @click="copy">
          <AppIcon :name="copied ? 'check' : 'copy'" :size="16" />
        </button>
      </template>
    </div>
    <!-- The sticker, a button until it is peeled. -->
    <button
      type="button"
      class="reveal__peel"
      :aria-label="peelName"
      :disabled="peeled"
      :aria-hidden="peeled ? 'true' : undefined"
      data-testid="code-peel"
      @click="peel"
      @mouseenter="hovered = true"
      @mouseleave="hovered = false"
      @focus="hovered = true"
      @blur="hovered = false"
    >
      <span class="reveal__sticker" aria-hidden="true" :style="{ clipPath: stickerClip }"><span class="truncate">{{ front }}</span></span>
      <!-- Its turned-up corner. -->
      <span class="reveal__flap" aria-hidden="true" :style="flapStyle">
        <svg width="48" height="56" viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg">
          <path d="M 36 4 L 12 52 L 28 56 Z" class="reveal__flap-shape" />
        </svg>
      </span>
    </button>
    <span class="sr-only" role="status">{{ announcement }}</span>
  </div>
</template>

<style scoped>
.reveal {
  position: relative;
  width: 100%;
  max-width: 280px;
  height: 48px;
  border-radius: var(--rounded-sm);
  font: inherit;
  overflow: visible;
}
/* Under the sticker: a pale Rausch wash in a dashed Rausch line; the code in ink so it reads. */
.reveal__under {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  padding: 0 var(--spacing-xs) 0 var(--spacing-md);
  border: 2px dashed var(--primary);
  border-radius: var(--rounded-sm);
  background: color-mix(in srgb, var(--primary) 8%, var(--canvas));
  color: var(--primary-error-text);
  font-weight: 600;
  font-size: 14px;
}
.reveal__line { min-width: 0; text-align: center; }
/* The code stays: one click selects all of it, so it can be copied by hand. */
.reveal__code { min-width: 0; padding: 2px var(--spacing-sm); border-radius: var(--rounded-xs, 4px); background: color-mix(in srgb, var(--primary) 12%, var(--canvas)); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; letter-spacing: 0.04em; overflow-wrap: anywhere; user-select: all; -webkit-user-select: all; cursor: text; }
/* "Copied", for a moment beside the code: ink on the pale wash, so it reads. */
.reveal__note { flex: none; color: var(--ink); font-size: 13px; font-weight: 600; }
.reveal__copy { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; padding: 0; border: 0; border-radius: var(--rounded-full); background: transparent; color: var(--ink); cursor: pointer; }
.reveal.is-copied .reveal__copy { background: var(--selected); color: var(--on-selected); }
.reveal__copy:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
@media (hover: hover) {
  .reveal__copy:hover { background: color-mix(in srgb, var(--ink) 10%, transparent); }
  .reveal.is-copied .reveal__copy:hover { background: var(--selected); }
}
/* The sticker's button covers the box until it is peeled, then goes (after its slide) so it takes no press and no focus. */
.reveal__peel {
  position: absolute;
  inset: 0;
  padding: 0;
  border: 0;
  border-radius: var(--rounded-sm);
  background: transparent;
  font: inherit;
  cursor: pointer;
  user-select: none;
  overflow: visible;
  transition: transform var(--motion-fast) var(--ease-out), visibility 0s linear 400ms;
}
.reveal__peel:active:not(:disabled) { transform: scale(0.98); }
.reveal__peel:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.reveal.is-peeled .reveal__peel { visibility: hidden; pointer-events: none; }
/* The sticker: Rausch, white words, the one shadow tier; its edge slides left as it peels. */
.reveal__sticker {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--spacing-lg);
  border-radius: var(--rounded-sm);
  background: var(--primary);
  color: var(--on-dark);
  font-weight: 600;
  font-size: 14px;
  box-shadow: var(--shadow-float);
  pointer-events: none;
  transition: clip-path 400ms cubic-bezier(0.22, 1, 0.36, 1);
}
@media (hover: hover) { .reveal:not(.is-peeled) .reveal__peel:hover .reveal__sticker { background: var(--primary-active); } }
.reveal__flap {
  position: absolute;
  top: -4px;
  width: 48px;
  height: 56px;
  pointer-events: none;
  transform-origin: bottom left;
  transition: left 400ms cubic-bezier(0.22, 1, 0.36, 1), transform 400ms cubic-bezier(0.22, 1, 0.36, 1), opacity 250ms ease-out;
}
.reveal__flap svg { filter: drop-shadow(-3px 4px 5px rgba(0, 0, 0, 0.18)); }
.reveal__flap-shape { fill: var(--primary-active); }
@media (prefers-reduced-motion: reduce) {
  .reveal__sticker, .reveal__flap, .reveal__peel { transition: none; }
}
</style>
