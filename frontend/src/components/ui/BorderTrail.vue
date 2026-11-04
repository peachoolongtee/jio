<script setup>
// A short bright streak that runs round the border of its box, again and again: a Vue port of the "border trail" React component the
// team chose for the Rewards card (Darius, 4 November 2026). The original moves it with framer-motion; here a CSS animation moves it
// along the box's own outline (offset-path: rect(…)), so it needs no dependency, no Tailwind and no TypeScript.
//   <div class="my-card" style="position: relative"><BorderTrail :size="120" background="linear-gradient(to left, #ffd1da, #ff385c, #ffd1da)" /></div>
// Put it inside a box that is position: relative; it takes the box's corners (border-radius: inherit). size: the streak's length in px
// (60). duration: seconds for one lap (5). delay: seconds before it starts (0). width: the border it runs in, in px (1). background: the
// streak's colour, any CSS background. It is decoration: hidden from screen readers, never in the way of a click, and not shown at all
// under reduced motion (a still streak on one corner would look like a flaw).
const props = defineProps({
  size: { type: Number, default: 60 },
  duration: { type: Number, default: 5 },
  delay: { type: Number, default: 0 },
  width: { type: Number, default: 1 },
  background: { type: String, default: '#71717a' },
})
</script>

<template>
  <div class="trail" :style="{ '--trail-width': `${props.width}px` }" aria-hidden="true">
    <div
      class="trail__streak"
      :style="{
        width: `${props.size}px`,
        offsetPath: `rect(0 auto auto 0 round ${props.size}px)`,
        background: props.background,
        animationDuration: `${props.duration}s`,
        animationDelay: `${props.delay}s`,
      }"
    />
  </div>
</template>

<style scoped>
/* A frame the size of the box whose only visible part is its border: the streak shows through that ring and nowhere else. */
.trail {
  position: absolute;
  inset: 0;
  border: var(--trail-width) solid transparent;
  border-radius: inherit;
  pointer-events: none;
  -webkit-mask: linear-gradient(transparent, transparent) padding-box, linear-gradient(#000, #000) border-box;
  mask: linear-gradient(transparent, transparent) padding-box, linear-gradient(#000, #000) border-box;
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}
.trail__streak { position: absolute; aspect-ratio: 1; animation: trail-lap linear infinite; }
@keyframes trail-lap { from { offset-distance: 0%; } to { offset-distance: 100%; } }
@media (prefers-reduced-motion: reduce) { .trail { display: none; } }
</style>
