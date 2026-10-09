<script setup>
// The Home map's main action: a red map pin whose tip marks where the routes meet, with the words in its head.
//   <PinButton to="/sessions/new" />                       "Jio your friends"
//   <PinButton to="/sessions/new" label="Start a session" />   the name screen readers say, when it should differ
//   <PinButton :to="openTo" big="Open" small="meetup" />        words of its own in the head instead of the logo
// Place it so its bottom edge sits on the meeting point: the tip is the bottom centre of the box.
// It bobs slowly while it waits. A click plays "entering a game": the pin squashes, springs up, and a red burst
// from its head fills the screen and dissolves into the next screen (lib/enterGame.js).
import { computed, ref } from 'vue'
import { useRouter } from 'vue-router'
import { enterGame } from '@/lib/enterGame.js'
import JioLogo from './JioLogo.vue'

const props = defineProps({
  to: { type: [String, Object], required: true },
  label: { type: String, default: '' },
  // The head's two lines. With no `big`, the top line is the Jio logo.
  big: { type: String, default: '' },
  small: { type: String, default: 'your friends' },
})

// What screen readers say: the label if given, otherwise the words in the head.
const name = computed(() => props.label || `${props.big || 'Jio'} ${props.small}`.trim())

const router = useRouter()
const launching = ref(false)
// A plain link rather than a RouterLink, so the click waits for the animation instead of navigating at once.
const href = computed(() => router.resolve(props.to).href)

// A plain click plays the animation; a click that opens a new tab, or a second click, is left alone.
// How to call: @click="launch"
async function launch(event) {
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return
  event.preventDefault()
  if (launching.value) return
  launching.value = true
  const head = event.currentTarget.querySelector('.pin-btn__body').getBoundingClientRect()
  try {
    await enterGame({ x: head.left + head.width / 2, y: head.top + head.height * 0.367, go: () => router.push(props.to) })
  } finally {
    launching.value = false
  }
}
</script>

<template>
  <a :href="href" class="pin-btn" :class="{ 'is-launching': launching }" :aria-label="name" @click="launch">
    <span class="pin-btn__bob">
      <span class="pin-btn__body">
        <svg class="pin-btn__shape" viewBox="0 0 100 128" aria-hidden="true" focusable="false">
          <path d="M50 125C50 125 5 77 5 47a45 45 0 0 1 90 0c0 30-45 78-45 78Z" />
        </svg>
        <span class="pin-btn__text" aria-hidden="true">
          <span v-if="big" class="pin-btn__big">{{ big }}</span>
          <JioLogo v-else class="pin-btn__logo" :height="38" decorative />
          <span v-if="small" class="pin-btn__small">{{ small }}</span>
        </span>
      </span>
    </span>
    <span class="pin-btn__shadow" aria-hidden="true" />
  </a>
</template>

<style scoped>
.pin-btn {
  position: relative;
  display: inline-flex;
  flex-direction: column;
  align-items: center;
  width: 128px;
  color: var(--on-primary);
  text-decoration: none;
  -webkit-tap-highlight-color: transparent;
}
.pin-btn__body { position: relative; display: block; width: 100%; aspect-ratio: 100 / 128; transition: transform var(--motion-fast) var(--ease-out); }
.pin-btn__shape { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; filter: drop-shadow(0 10px 18px color-mix(in srgb, var(--primary) 45%, transparent)); }
.pin-btn__shape path { fill: var(--primary); stroke: var(--canvas); stroke-width: 3; transition: fill var(--motion-fast) var(--ease-out); }
/* The words sit in the round head: its centre is 47/128 of the way down. */
.pin-btn__text { position: absolute; left: 0; right: 0; top: 36.7%; transform: translateY(-50%); display: flex; flex-direction: column; align-items: center; line-height: 1; text-align: center; }
.pin-btn__logo { color: var(--on-primary); }
.pin-btn__big { font: 800 30px/1 var(--font-sans); letter-spacing: -0.02em; }
.pin-btn__small { margin-top: 6px; font: 600 13px/1.1 var(--font-sans); }
/* The pin's shadow on the map, under the tip. */
.pin-btn__shadow { position: absolute; left: 50%; bottom: -4px; width: 34px; height: 8px; border-radius: 50%; background: color-mix(in srgb, var(--ink) 22%, transparent); transform: translateX(-50%); filter: blur(2px); transition: transform var(--motion-fast) var(--ease-out), opacity var(--motion-fast) var(--ease-out); z-index: -1; }
/* Waiting: a slow bob, the shadow shrinking as the pin rises. On its own wrapper, so hover and press still work. */
.pin-btn__bob { display: block; width: 100%; animation: pin-bob 2.8s ease-in-out infinite; }
.pin-btn__shadow { animation: pin-bob-shadow 2.8s ease-in-out infinite; }
@keyframes pin-bob { 50% { transform: translateY(-10px); } }
@keyframes pin-bob-shadow { 50% { transform: translateX(-50%) scale(0.75); opacity: 0.55; } }
/* Launch: squash, then spring up and swell as the red bursts out of it. */
.pin-btn.is-launching .pin-btn__bob, .pin-btn.is-launching .pin-btn__shadow { animation: none; }
.pin-btn.is-launching .pin-btn__body { animation: pin-launch 700ms cubic-bezier(0.5, 0, 0.3, 1) both; transform-origin: 50% 100%; }
.pin-btn.is-launching .pin-btn__shadow { opacity: 0; transition: opacity 200ms; }
@keyframes pin-launch {
  0% { transform: none; }
  22% { transform: scale(1.12, 0.84); }
  55% { transform: translateY(-34px) scale(0.94, 1.1); }
  100% { transform: translateY(-20px) scale(1.5); opacity: 0.9; }
}
@media (hover: hover) {
  .pin-btn:hover .pin-btn__body { transform: translateY(-6px); }
  .pin-btn:hover .pin-btn__shadow { transform: translateX(-50%) scale(0.7); opacity: 0.6; }
}
.pin-btn:active .pin-btn__body { transform: translateY(-2px) scale(0.98); }
.pin-btn:active .pin-btn__shape path { fill: var(--primary-active); }
.pin-btn:focus-visible { outline: none; }
.pin-btn:focus-visible .pin-btn__shape path { stroke: var(--ink); stroke-width: 4; }
@media (prefers-reduced-motion: reduce) {
  .pin-btn__body, .pin-btn__shadow, .pin-btn__shape path { transition: none; }
  .pin-btn__bob, .pin-btn__shadow, .pin-btn.is-launching .pin-btn__body { animation: none; }
}
</style>
