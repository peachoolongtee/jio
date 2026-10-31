<script setup>
// A voucher code under a red sticker that peels back. At rest the sticker is flat and covers the whole button; on hover (or keyboard
// focus) its corner lifts, to say it can be peeled. The first press peels it off and shows the code; each press after that copies the
// code. Once copied it says "Copied" on an ink ground and stays so until the page is left or reloaded; a press then copies again.
//   <CodeReveal code="JIO-AAAA-BBBB" front="Show code" back="Your code" label="SGD 3 off any coffee" />
// The Vue form of a peel-back coupon button (a React and Tailwind one was the model, Faith, 31 October 2026): the sticker is Rausch
// (--primary) with white text, like every main button, and the code sits on a pale Rausch wash inside a dashed Rausch line.
// `code` is what is shown and copied; `front` is on the sticker, `back` under it before the code shows; `label` names the voucher
// for a screen reader. Emits `reveal` the first time it is peeled.
// The sticker's edge is drawn in pixels from the button's own width, which a ResizeObserver keeps up to date. With reduced motion it
// still peels, without the slide.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  code: { type: String, required: true },
  front: { type: String, default: 'Show code' },
  back: { type: String, default: 'Your code' },
  label: { type: String, default: '' },
})
const emit = defineEmits(['reveal'])

const button = ref(null)
const width = ref(240)
const hovered = ref(false)
const peeled = ref(false)
const copied = ref(false)
const announcement = ref('')

let observer = null
onMounted(() => {
  if (!button.value) return
  width.value = button.value.getBoundingClientRect?.().width || width.value
  if (typeof ResizeObserver === 'undefined') return
  observer = new ResizeObserver((entries) => {
    for (const entry of entries) width.value = entry.contentRect.width
  })
  observer.observe(button.value)
})
onBeforeUnmount(() => {
  observer?.disconnect()
})

// Where the sticker's torn edge meets the top, in pixels: past the right edge at rest (the whole button is covered), lifted on hover,
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
const name = computed(() => (peeled.value ? `Copy code ${props.code}` : `${props.front}${props.label ? `: ${props.label}` : ''}`))

// How to call: <button @click="press">
async function press() {
  if (!peeled.value) {
    peeled.value = true
    announcement.value = `Code ${props.code}`
    emit('reveal')
    return
  }
  try {
    await navigator.clipboard.writeText(props.code)
    copied.value = true
    announcement.value = 'Copied'
  } catch {
    // Copying is refused here (an older browser, or no permission): the code is on screen to copy by hand.
    announcement.value = `Code ${props.code}`
  }
}
</script>

<template>
  <button
    ref="button"
    type="button"
    class="reveal"
    :class="{ 'is-peeled': peeled, 'is-copied': copied }"
    :aria-label="name"
    data-testid="code-reveal"
    @click="press"
    @mouseenter="hovered = true"
    @mouseleave="hovered = false"
    @focus="hovered = true"
    @blur="hovered = false"
  >
    <!-- Under the sticker: the words, then the code once peeled. -->
    <span class="reveal__under">
      <span v-if="copied" class="reveal__line"><AppIcon name="check" :size="16" />Copied</span>
      <span v-else-if="peeled" class="reveal__line">
        <code class="reveal__code">{{ code }}</code>
        <AppIcon v-if="peeled" name="copy" :size="14" class="reveal__copy" />
      </span>
      <span v-else class="reveal__line">{{ back }}</span>
    </span>
    <!-- The sticker. -->
    <span class="reveal__sticker" aria-hidden="true" :style="{ clipPath: stickerClip }"><span class="truncate">{{ front }}</span></span>
    <!-- Its turned-up corner. -->
    <span class="reveal__flap" aria-hidden="true" :style="flapStyle">
      <svg width="48" height="56" viewBox="0 0 48 56" fill="none" xmlns="http://www.w3.org/2000/svg">
        <path d="M 36 4 L 12 52 L 28 56 Z" class="reveal__flap-shape" />
      </svg>
    </span>
    <span class="sr-only" aria-live="polite">{{ announcement }}</span>
  </button>
</template>

<style scoped>
.reveal {
  position: relative;
  width: 100%;
  max-width: 280px;
  height: 48px;
  padding: 0;
  border: 0;
  border-radius: var(--rounded-sm);
  background: transparent;
  font: inherit;
  cursor: pointer;
  user-select: none;
  overflow: visible;
  transition: transform var(--motion-fast) var(--ease-out);
}
.reveal:active { transform: scale(0.98); }
.reveal:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* Under the sticker: a pale Rausch wash in a dashed Rausch line; the code in ink so it reads. */
.reveal__under {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 0 var(--spacing-md);
  border: 2px dashed var(--primary);
  border-radius: var(--rounded-sm);
  background: color-mix(in srgb, var(--primary) 8%, var(--canvas));
  color: var(--primary-error-text);
  font-weight: 600;
  font-size: 14px;
  transition: background-color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
/* Copied: filled with ink, the app's colour for something done or selected, so it stands apart from the pink code box and the red sticker. */
.reveal.is-copied .reveal__under { border-style: solid; border-color: var(--selected); background: var(--selected); color: var(--on-selected); }
.reveal__line { display: inline-flex; align-items: center; gap: var(--spacing-xs); min-width: 0; }
.reveal__code { padding: 2px var(--spacing-sm); border-radius: var(--rounded-xs, 4px); background: color-mix(in srgb, var(--primary) 12%, var(--canvas)); color: var(--ink); font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 13px; letter-spacing: 0.04em; }
.reveal__copy { opacity: 0.7; }
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
@media (hover: hover) { .reveal:not(.is-peeled):hover .reveal__sticker { background: var(--primary-active); } }
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
  .reveal__sticker, .reveal__flap, .reveal { transition: none; }
}
</style>
