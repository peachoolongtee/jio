<script setup>
// The one big action on a screen, made to sit where routes meet on a map: a Rausch pill with a light that runs
// round its border, an arrow in a white circle, and soft rings pulsing out behind it like a beacon.
//   <BeaconButton to="/sessions/new">Start a session</BeaconButton>
// After Aceternity's "Moving Border" button and Magic UI's "Ripple", in plain CSS.
import AppIcon from './AppIcon.vue'

defineProps({
  to: { type: [String, Object], required: true },
})
</script>

<template>
  <RouterLink :to="to" class="beacon">
    <span class="beacon__rings" aria-hidden="true">
      <span v-for="n in 3" :key="n" class="beacon__ring" :style="{ '--n': n }" />
    </span>
    <span class="beacon__edge">
      <span class="beacon__spin" aria-hidden="true" />
      <span class="beacon__face">
        <span class="beacon__label"><slot /></span>
        <span class="beacon__arrow" aria-hidden="true"><AppIcon name="arrow-right" :size="18" /></span>
      </span>
    </span>
  </RouterLink>
</template>

<style scoped>
.beacon { position: relative; display: inline-flex; border-radius: var(--rounded-full); color: var(--on-primary); text-decoration: none; -webkit-tap-highlight-color: transparent; }
.beacon:focus-visible { outline: none; }
.beacon:focus-visible .beacon__edge { box-shadow: 0 0 0 3px var(--canvas), 0 0 0 5px var(--ink); }

/* Rings: three circles behind the button, each a little larger and fainter, breathing in turn. */
.beacon__rings { position: absolute; left: 50%; top: 50%; width: 0; height: 0; pointer-events: none; }
.beacon__ring {
  position: absolute;
  left: 50%;
  top: 50%;
  width: calc(140px + var(--n) * 64px);
  height: calc(140px + var(--n) * 64px);
  border: 1px solid color-mix(in srgb, var(--primary) 22%, transparent);
  border-radius: var(--rounded-full);
  background: color-mix(in srgb, var(--primary) 4%, transparent);
  transform: translate(-50%, -50%);
  animation: beacon-breathe 3.4s var(--ease-out) infinite;
  animation-delay: calc(var(--n) * 0.25s);
}
@media (max-width: 743px) { .beacon__ring { width: calc(120px + var(--n) * 44px); height: calc(120px + var(--n) * 44px); } }
.beacon__ring:nth-child(2) { border-color: color-mix(in srgb, var(--primary) 14%, transparent); background: color-mix(in srgb, var(--primary) 2.5%, transparent); }
.beacon__ring:nth-child(3) { border-color: color-mix(in srgb, var(--primary) 8%, transparent); background: transparent; }
@keyframes beacon-breathe { 0%, 100% { transform: translate(-50%, -50%) scale(1); } 50% { transform: translate(-50%, -50%) scale(0.92); } }

/* The border: a 2px frame whose light comes from a conic gradient spinning behind the face. */
.beacon__edge { position: relative; display: inline-flex; overflow: hidden; padding: 2px; border-radius: var(--rounded-full); background: var(--primary-active); box-shadow: 0 12px 32px -8px color-mix(in srgb, var(--primary) 55%, transparent); transition: transform var(--motion-fast) var(--ease-out), box-shadow var(--motion-fast) var(--ease-out); }
.beacon__spin { position: absolute; left: 50%; top: 50%; width: 300%; aspect-ratio: 1; background: conic-gradient(from 0deg, transparent 0 70%, rgba(255, 255, 255, 0.95) 80%, transparent 90%); transform: translate(-50%, -50%); animation: beacon-spin 3s linear infinite; }
@keyframes beacon-spin { to { transform: translate(-50%, -50%) rotate(1turn); } }
.beacon__face { position: relative; display: inline-flex; align-items: center; gap: var(--spacing-base); min-height: 60px; padding: 0 8px 0 var(--spacing-lg); border-radius: var(--rounded-full); background: var(--primary); font: var(--text-title-md); white-space: nowrap; }
.beacon__arrow { display: inline-flex; align-items: center; justify-content: center; width: 44px; height: 44px; border-radius: var(--rounded-full); background: var(--canvas); color: var(--primary); transition: transform var(--motion-fast) var(--ease-out); }

@media (hover: hover) {
  .beacon:hover .beacon__edge { transform: translateY(-2px); box-shadow: 0 18px 40px -10px color-mix(in srgb, var(--primary) 65%, transparent); }
  .beacon:hover .beacon__arrow { transform: translateX(3px); }
}
.beacon:active .beacon__edge { transform: scale(0.98); }
.beacon:active .beacon__face { background: var(--primary-active); }

@media (prefers-reduced-motion: reduce) {
  .beacon__ring, .beacon__spin { animation: none; }
  .beacon__spin { display: none; }
}
</style>
