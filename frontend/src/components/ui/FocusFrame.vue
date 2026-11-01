<script setup>
// A framed panel for a step's form (walkthrough, 30 October 2026): a white card, and four
// corner brackets in the brand colour that glow and pulse one after another, like a camera locking focus. It gives the session steps'
// pages (Create, the Start choice, Invite) a frame, so a form on white does not look bare. The brackets are decoration: they take
// no clicks and are hidden from screen readers, and under reduced motion they stay lit and still.
//   <FocusFrame>…the form…</FocusFrame>
//   <FocusFrame color="var(--status-planning-fg)" :duration="3" :padded="false">…</FocusFrame>
defineProps({
  // The brackets' colour, any CSS colour.
  color: { type: String, default: 'var(--primary)' },
  // Seconds for one pulse of a bracket.
  duration: { type: Number, default: 2.4 },
  // The card's own padding; off for content that brings its own.
  padded: { type: Boolean, default: true },
})

// Each corner, and how long after the first it pulses.
const CORNERS = [
  { at: 'tl', delay: 0 },
  { at: 'tr', delay: 0.3 },
  { at: 'bl', delay: 0.6 },
  { at: 'br', delay: 0.9 },
]
</script>

<template>
  <div class="focus-frame" :style="{ '--frame-color': color, '--frame-duration': `${duration}s` }">
    <span v-for="c in CORNERS" :key="c.at" class="focus-frame__corner" :class="`focus-frame__corner--${c.at}`" :style="{ animationDelay: `${c.delay}s` }" aria-hidden="true" />
    <div class="focus-frame__body" :class="{ 'focus-frame__body--padded': padded }"><slot /></div>
  </div>
</template>

<style scoped>
.focus-frame { position: relative; border-radius: var(--rounded-md); }
.focus-frame__body { position: relative; z-index: 1; display: flex; flex-direction: column; gap: var(--spacing-lg); height: 100%; border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); }
.focus-frame__body--padded { padding: var(--spacing-lg); }
@media (max-width: 479px) { .focus-frame__body--padded { padding: var(--spacing-base); } }
/* The brackets sit over the card's corners, on its border. */
.focus-frame__corner { position: absolute; z-index: 2; width: 40px; height: 40px; border: 0 solid var(--frame-color); pointer-events: none; filter: drop-shadow(0 0 4px color-mix(in srgb, var(--frame-color) 60%, transparent)); opacity: 0.6; animation: focus-frame-pulse var(--frame-duration) ease-in-out infinite; }
.focus-frame__corner--tl { top: 0; left: 0; border-top-width: 2px; border-left-width: 2px; border-top-left-radius: var(--rounded-md); }
.focus-frame__corner--tr { top: 0; right: 0; border-top-width: 2px; border-right-width: 2px; border-top-right-radius: var(--rounded-md); }
.focus-frame__corner--bl { bottom: 0; left: 0; border-bottom-width: 2px; border-left-width: 2px; border-bottom-left-radius: var(--rounded-md); }
.focus-frame__corner--br { bottom: 0; right: 0; border-bottom-width: 2px; border-right-width: 2px; border-bottom-right-radius: var(--rounded-md); }
@keyframes focus-frame-pulse {
  0%, 100% { opacity: 0.6; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) { .focus-frame__corner { animation: none; opacity: 1; } }
</style>
