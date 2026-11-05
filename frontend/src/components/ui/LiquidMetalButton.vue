<script setup>
// A round icon button with a moving liquid metal rim around a black face (walkthrough, 1 November 2026). Kept for one special
// action, such as "Find places from a post" on Home, so it stays special. The rim is a WebGL shader (@paper-design/shaders,
// liquid metal on a circle); it moves slowly at rest, faster on hover and in a burst on a press, and stands still under
// reduced motion. Without WebGL the rim is a still silver gradient, so the button always looks finished.
//   <LiquidMetalButton label="Find places from a post" caption="From a post" to="/places/from-post" icon="sparkle" />
//   <LiquidMetalButton label="Surprise me" icon="sparkle" @click="surprise" />
// label: the button's name for screen readers and its tooltip. caption: a short visible word or two under the circle, so a phone shows what
// the button is for (review of 1 November 2026: an icon alone had no name on a phone, where nothing hovers); keep it inside `label`, which
// stays the accessible name. to: a route, which makes it a link; otherwise it is a button and emits click. icon: an AppIcon name.
// The shader starts when the browser is idle, not while the page is first drawn, and stops moving while the button is off screen.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  label: { type: String, required: true },
  to: { type: [String, Object], default: null },
  icon: { type: String, default: 'sparkle' },
  caption: { type: String, default: '' },
})
const emit = defineEmits(['click'])

const root = ref(null)
const rim = ref(null)
let mount = null
let idleHandle = 0
let watcher = null
let visible = true
// The rim's speeds: at rest, hovered, and the burst a press gives.
const SPEED = { rest: 0.6, hover: 1, press: 2.4 }
const still = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
let hovered = false

// Starts the shader in the rim. A browser without WebGL keeps the CSS rim. How to call: await start()
async function start() {
  if (!rim.value || typeof window === 'undefined') return
  try {
    const { ShaderMount, liquidMetalFragmentShader, LiquidMetalShapes, ShaderFitOptions, emptyPixel } = await import('@paper-design/shaders')
    if (!rim.value) return
    mount = new ShaderMount(rim.value, liquidMetalFragmentShader, {
      u_colorBack: [0, 0, 0, 0],
      u_colorTint: [1, 1, 1, 1],
      u_image: emptyPixel,
      u_isImage: false,
      u_shape: LiquidMetalShapes.circle,
      u_repetition: 4,
      u_softness: 0.5,
      u_shiftRed: 0.3,
      u_shiftBlue: 0.3,
      u_distortion: 0,
      u_contour: 0,
      u_angle: 45,
      u_fit: ShaderFitOptions.contain,
      u_scale: 1,
      u_rotation: 0,
      u_originX: 0.5,
      u_originY: 0.5,
      u_offsetX: 0,
      u_offsetY: 0,
      u_worldWidth: 0,
      u_worldHeight: 0,
    }, undefined, still() ? 0 : SPEED.rest)
    rim.value.classList.add('is-live')
    // It may have scrolled out of view while the shader loaded.
    if (!visible) mount.setSpeed?.(0)
  } catch {
    mount = null
  }
}

// Start the shader when the browser has nothing better to do (its chunk is fetched then, after the page has drawn), and keep it still
// while the button is not on screen. How to call: onMounted(begin)
function begin() {
  if (typeof window === 'undefined') return
  const later = window.requestIdleCallback ? (fn) => window.requestIdleCallback(fn, { timeout: 1500 }) : (fn) => setTimeout(fn, 200)
  idleHandle = later(start)
  // A link is a component (RouterLink), whose element is `$el`; a button is the element itself.
  const element = root.value?.$el || root.value
  if (typeof IntersectionObserver === 'undefined' || !element?.nodeType) return
  watcher = new IntersectionObserver((entries) => {
    visible = entries.at(-1)?.isIntersecting !== false
    if (still()) return
    mount?.setSpeed?.(visible ? (hovered ? SPEED.hover : SPEED.rest) : 0)
  })
  watcher.observe(element)
}
onMounted(begin)
onBeforeUnmount(() => {
  if (idleHandle) (window.cancelIdleCallback || clearTimeout)(idleHandle)
  watcher?.disconnect()
  mount?.dispose?.()
  mount = null
})

// How to call: speed('hover')
function speed(kind) {
  if (!still()) mount?.setSpeed?.(SPEED[kind])
}
function enter() {
  hovered = true
  speed('hover')
}
function leave() {
  hovered = false
  speed('rest')
}
// A press: a burst of speed, then back to how it was. How to call: <… @click="press">
function press(event) {
  speed('press')
  setTimeout(() => speed(hovered ? 'hover' : 'rest'), 300)
  emit('click', event)
}
</script>

<template>
  <component
    :is="to ? RouterLink : 'button'"
    ref="root"
    class="lmb"
    v-bind="to ? { to } : { type: 'button' }"
    :aria-label="label"
    :title="label"
    @mouseenter="enter"
    @mouseleave="leave"
    @click="press"
  >
    <span class="lm" aria-hidden="true">
      <span ref="rim" class="lm__rim" />
      <span class="lm__face" />
      <AppIcon class="lm__icon" :name="icon" :size="18" />
    </span>
    <span v-if="caption" class="lm__caption caption-sm" aria-hidden="true">{{ caption }}</span>
  </component>
</template>

<style scoped>
/* The whole control: the circle and, under it, its caption. A plain box, so the link or button has no look of its own. */
.lmb { display: inline-flex; flex-direction: column; align-items: center; gap: var(--spacing-xxs); padding: 0; border: 0; background: transparent; color: var(--ink); text-decoration: none; cursor: pointer; -webkit-tap-highlight-color: transparent; }
.lmb:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; border-radius: var(--rounded-md); }
.lm__caption { max-width: 9ch; color: var(--body); font-weight: 600; line-height: 1.15; text-align: center; text-wrap: balance; }
/* 46px across: a 2px metal rim, a black face and a grey icon. Lifts on hover with a deeper shadow, sinks a little when pressed. */
.lm { position: relative; isolation: isolate; display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 46px; height: 46px; border-radius: var(--rounded-full); background: transparent; color: #a3a3a3; box-shadow: 0 0 0 1px rgb(0 0 0 / 30%), 0 20px 12px rgb(0 0 0 / 8%), 0 9px 9px rgb(0 0 0 / 12%), 0 2px 5px rgb(0 0 0 / 15%); transition: transform 260ms var(--ease-spring), box-shadow var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .lmb:hover .lm { color: #d4d4d4; box-shadow: 0 0 0 1px rgb(0 0 0 / 40%), 0 8px 5px rgb(0 0 0 / 10%), 0 4px 4px rgb(0 0 0 / 15%), 0 1px 2px rgb(0 0 0 / 20%); } }
.lmb:active .lm { transform: translateY(1px) scale(0.97); box-shadow: 0 0 0 1px rgb(0 0 0 / 50%), 0 1px 2px rgb(0 0 0 / 30%); }
/* The rim: a still silver gradient until the shader draws over it. */
.lm__rim { position: absolute; inset: 0; z-index: -2; overflow: hidden; border-radius: var(--rounded-full); background: conic-gradient(from 45deg, #f5f5f5, #8a8a8a, #ffffff, #6f6f6f, #e6e6e6, #9a9a9a, #f5f5f5); }
.lm__rim.is-live { background: #9a9a9a; }
.lm__rim :deep(canvas) { position: absolute !important; inset: 0; display: block; width: 100% !important; height: 100% !important; border-radius: var(--rounded-full); }
.lm__face { position: absolute; inset: 2px; z-index: -1; border-radius: var(--rounded-full); background: linear-gradient(180deg, #202020 0%, #000000 100%); transition: box-shadow 150ms var(--ease-out); }
.lmb:active .lm__face { box-shadow: inset 0 2px 4px rgb(0 0 0 / 40%), inset 0 1px 2px rgb(0 0 0 / 30%); }
.lm__icon { filter: drop-shadow(0 1px 2px rgb(0 0 0 / 50%)); }
@media (prefers-reduced-motion: reduce) { .lm, .lm__face { transition: none; } .lmb:active .lm { transform: none; } }
</style>
