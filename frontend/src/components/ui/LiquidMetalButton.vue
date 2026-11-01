<script setup>
// A round icon button with a moving liquid metal rim around a black face (walkthrough, 1 November 2026). Kept for one special
// action, such as "Find places from a post" on Home, so it stays special. The rim is a WebGL shader (@paper-design/shaders,
// liquid metal on a circle); it moves slowly at rest, faster on hover and in a burst on a press, and stands still under
// reduced motion. Without WebGL the rim is a still silver gradient, so the button always looks finished.
//   <LiquidMetalButton label="Find places from a post" to="/places/from-post" icon="sparkle" />
//   <LiquidMetalButton label="Surprise me" icon="sparkle" @click="surprise" />
// label: the button's name for screen readers and its tooltip (it has no visible words). to: a route, which makes it a link;
// otherwise it is a button and emits click. icon: an AppIcon name.
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  label: { type: String, required: true },
  to: { type: [String, Object], default: null },
  icon: { type: String, default: 'sparkle' },
})
const emit = defineEmits(['click'])

const rim = ref(null)
let mount = null
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
  } catch {
    mount = null
  }
}
onMounted(start)
onBeforeUnmount(() => {
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
    class="lm"
    v-bind="to ? { to } : { type: 'button' }"
    :aria-label="label"
    :title="label"
    @mouseenter="enter"
    @mouseleave="leave"
    @click="press"
  >
    <span ref="rim" class="lm__rim" aria-hidden="true" />
    <span class="lm__face" aria-hidden="true" />
    <AppIcon class="lm__icon" :name="icon" :size="18" />
  </component>
</template>

<style scoped>
/* 46px across: a 2px metal rim, a black face and a grey icon. Lifts on hover with a deeper shadow, sinks a little when pressed. */
.lm { position: relative; isolation: isolate; display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: 46px; height: 46px; padding: 0; border: 0; border-radius: var(--rounded-full); background: transparent; color: #a3a3a3; text-decoration: none; cursor: pointer; box-shadow: 0 0 0 1px rgb(0 0 0 / 30%), 0 20px 12px rgb(0 0 0 / 8%), 0 9px 9px rgb(0 0 0 / 12%), 0 2px 5px rgb(0 0 0 / 15%); transition: transform 260ms var(--ease-spring), box-shadow var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .lm:hover { color: #d4d4d4; box-shadow: 0 0 0 1px rgb(0 0 0 / 40%), 0 8px 5px rgb(0 0 0 / 10%), 0 4px 4px rgb(0 0 0 / 15%), 0 1px 2px rgb(0 0 0 / 20%); } }
.lm:active { transform: translateY(1px) scale(0.97); box-shadow: 0 0 0 1px rgb(0 0 0 / 50%), 0 1px 2px rgb(0 0 0 / 30%); }
.lm:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
/* The rim: a still silver gradient until the shader draws over it. */
.lm__rim { position: absolute; inset: 0; z-index: -2; overflow: hidden; border-radius: var(--rounded-full); background: conic-gradient(from 45deg, #f5f5f5, #8a8a8a, #ffffff, #6f6f6f, #e6e6e6, #9a9a9a, #f5f5f5); }
.lm__rim.is-live { background: #9a9a9a; }
.lm__rim :deep(canvas) { position: absolute !important; inset: 0; display: block; width: 100% !important; height: 100% !important; border-radius: var(--rounded-full); }
.lm__face { position: absolute; inset: 2px; z-index: -1; border-radius: var(--rounded-full); background: linear-gradient(180deg, #202020 0%, #000000 100%); transition: box-shadow 150ms var(--ease-out); }
.lm:active .lm__face { box-shadow: inset 0 2px 4px rgb(0 0 0 / 40%), inset 0 1px 2px rgb(0 0 0 / 30%); }
.lm__icon { filter: drop-shadow(0 1px 2px rgb(0 0 0 / 50%)); }
@media (prefers-reduced-motion: reduce) { .lm, .lm__face { transition: none; } .lm:active { transform: none; } }
</style>
