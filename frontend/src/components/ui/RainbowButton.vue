<script setup>
// A round icon button with a rainbow border that turns slowly, for a feature worth noticing: "Find places from a post" on Home and in the
// top bar (Darius, 4 November 2026, in place of the liquid metal look).
//   <RainbowButton label="Find places from a post" to="/places/from-post" icon="sparkles" />
//   <RainbowButton label="Surprise me" icon="sparkle" @click="surprise" />
// label: the button's name for screen readers and its tooltip. to: a route, which makes it a link; otherwise it is a button and emits
// click. icon: an AppIcon name. 46px across by default; set --rb-size on it for another size. Under reduced motion the border stands still.
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'

const props = defineProps({
  label: { type: String, required: true },
  to: { type: [String, Object], default: null },
  icon: { type: String, default: 'sparkle' },
})
const emit = defineEmits(['click'])
</script>

<template>
  <component :is="props.to ? RouterLink : 'button'" :to="props.to || undefined" :type="props.to ? undefined : 'button'" class="rb" :aria-label="label" :title="label" @click="emit('click', $event)">
    <span class="rb__ring" aria-hidden="true" />
    <span class="rb__face" aria-hidden="true"><AppIcon :name="icon" :size="20" /></span>
  </component>
</template>

<style scoped>
/* A dark face inside a 2px ring of every colour, the ring turning once every 3 seconds, with a faint glow of the same colours under it. */
.rb { position: relative; isolation: isolate; display: inline-flex; flex-shrink: 0; align-items: center; justify-content: center; width: var(--rb-size, 46px); height: var(--rb-size, 46px); padding: 0; border: 0; border-radius: var(--rounded-full); background: transparent; color: #f5f5f5; text-decoration: none; cursor: pointer; -webkit-tap-highlight-color: transparent; transition: transform 260ms var(--ease-spring); }
.rb__ring { position: absolute; inset: 0; z-index: -1; border-radius: inherit; background: conic-gradient(from 0deg, #ff385c, #ff9f1c, #ffe14d, #3ddc84, #22c3ee, #6a5cff, #d946ef, #ff385c); animation: rb-turn 3s linear infinite; }
.rb__ring::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: inherit; filter: blur(8px); opacity: 0.45; z-index: -1; }
.rb__face { position: absolute; inset: 2px; display: inline-flex; align-items: center; justify-content: center; border-radius: inherit; background: #141414; }
@keyframes rb-turn { to { transform: rotate(1turn); } }
@media (hover: hover) { .rb:hover { transform: translateY(-1px) scale(1.04); } }
.rb:active { transform: scale(0.95); }
.rb:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
@media (prefers-reduced-motion: reduce) { .rb__ring { animation: none; } .rb { transition: none; } }
</style>
