<script setup>
// A card whose border lights up where the pointer is, in a colour that shifts as the pointer moves across the screen: a Vue port of the
// "spotlight card" (GlowCard) React component the team chose for the profile's header (Darius, 4 November 2026). The app is Vue with
// scoped CSS, so it is written as one component with no Tailwind, TypeScript or shadcn, and no dependencies.
//   <SpotlightCard glow-color="red" custom-size class="my-card">…</SpotlightCard>
//   <SpotlightCard size="md">…</SpotlightCard>                     a fixed 3:4 card, 256 by 320
// glowColor: blue, purple, green, red or orange (the hue it starts from, and how far it moves across the screen). size: sm, md or lg, a
// fixed 3:4 card, unless customSize, when the card is as big as its content (or width and height, or the class, say). The light follows
// the pointer anywhere on the page, so it shows best with a mouse; on a touch screen the card keeps its soft frame. Two changes from the
// React original, for this app: the card does not set touch-action: none (it would stop a finger scrolling the page over it), and its
// drop shadow is a softer black, for a light page.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'

const props = defineProps({
  glowColor: { type: String, default: 'blue', validator: (v) => ['blue', 'purple', 'green', 'red', 'orange'].includes(v) },
  size: { type: String, default: 'md', validator: (v) => ['sm', 'md', 'lg'].includes(v) },
  width: { type: [String, Number], default: undefined },
  height: { type: [String, Number], default: undefined },
  // When true the size prop is ignored, and width, height or the class decide the size.
  customSize: { type: Boolean, default: false },
})

const GLOW = {
  blue: { base: 220, spread: 200 },
  purple: { base: 280, spread: 300 },
  green: { base: 120, spread: 200 },
  red: { base: 0, spread: 200 },
  orange: { base: 30, spread: 200 },
}

const card = ref(null)

// Where the pointer is, in px and as a share of the window, for the gradients. How to call: syncPointer(pointerEvent)
function syncPointer(event) {
  const el = card.value
  if (!el) return
  el.style.setProperty('--x', event.clientX.toFixed(2))
  el.style.setProperty('--xp', (event.clientX / window.innerWidth).toFixed(2))
  el.style.setProperty('--y', event.clientY.toFixed(2))
  el.style.setProperty('--yp', (event.clientY / window.innerHeight).toFixed(2))
}
onMounted(() => document.addEventListener('pointermove', syncPointer))
onBeforeUnmount(() => document.removeEventListener('pointermove', syncPointer))

const px = (v) => (typeof v === 'number' ? `${v}px` : v)
const style = computed(() => {
  const { base, spread } = GLOW[props.glowColor] || GLOW.blue
  return {
    '--base': base,
    '--spread': spread,
    ...(props.width !== undefined ? { width: px(props.width) } : {}),
    ...(props.height !== undefined ? { height: px(props.height) } : {}),
  }
})
</script>

<template>
  <div ref="card" class="glow" :class="customSize ? '' : ['glow--fixed', `glow--${size}`]" :style="style" data-glow>
    <div class="glow__outer" data-glow aria-hidden="true" />
    <slot />
  </div>
</template>

<style scoped>
.glow {
  --radius: 14;
  --border: 3;
  --backdrop: hsl(0 0% 60% / 0.12);
  --backup-border: var(--backdrop);
  --size: 200;
  --outer: 1;
  --border-size: calc(var(--border, 2) * 1px);
  --spotlight-size: calc(var(--size, 150) * 1px);
  --hue: calc(var(--base) + (var(--xp, 0) * var(--spread, 0)));
  position: relative;
  display: grid;
  grid-template-rows: 1fr auto;
  gap: 1rem;
  padding: 1rem;
  border: var(--border-size) solid var(--backup-border);
  border-radius: 1rem;
  background-color: var(--backdrop, transparent);
  background-image: radial-gradient(
    var(--spotlight-size) var(--spotlight-size) at calc(var(--x, 0) * 1px) calc(var(--y, 0) * 1px),
    hsl(var(--hue, 210) calc(var(--saturation, 100) * 1%) calc(var(--lightness, 70) * 1%) / var(--bg-spot-opacity, 0.1)),
    transparent
  );
  background-size: calc(100% + (2 * var(--border-size))) calc(100% + (2 * var(--border-size)));
  background-position: 50% 50%;
  background-attachment: fixed;
  box-shadow: 0 1rem 2rem -1rem rgb(0 0 0 / 0.35);
  -webkit-backdrop-filter: blur(5px);
  backdrop-filter: blur(5px);
}
/* The fixed sizes, 3:4, when the card does not take its content's size. */
.glow--fixed { aspect-ratio: 3 / 4; }
.glow--sm { width: 12rem; height: 16rem; }
.glow--md { width: 16rem; height: 20rem; }
.glow--lg { width: 20rem; height: 24rem; }

/* The lit border: a coloured spot and a white one inside it, both following the pointer, drawn only on the border. */
.glow::before,
.glow::after,
.glow__outer::before {
  pointer-events: none;
  content: "";
  position: absolute;
  inset: calc(var(--border-size) * -1);
  border: var(--border-size) solid transparent;
  border-radius: calc(var(--radius) * 1px);
  background-attachment: fixed;
  background-size: calc(100% + (2 * var(--border-size))) calc(100% + (2 * var(--border-size)));
  background-repeat: no-repeat;
  background-position: 50% 50%;
  -webkit-mask: linear-gradient(transparent, transparent), linear-gradient(white, white);
  mask: linear-gradient(transparent, transparent), linear-gradient(white, white);
  -webkit-mask-clip: padding-box, border-box;
  mask-clip: padding-box, border-box;
  -webkit-mask-composite: source-in;
  mask-composite: intersect;
}
.glow::before,
.glow__outer::before {
  background-image: radial-gradient(
    calc(var(--spotlight-size) * 0.75) calc(var(--spotlight-size) * 0.75) at calc(var(--x, 0) * 1px) calc(var(--y, 0) * 1px),
    hsl(var(--hue, 210) calc(var(--saturation, 100) * 1%) calc(var(--lightness, 50) * 1%) / var(--border-spot-opacity, 1)),
    transparent 100%
  );
  filter: brightness(2);
}
.glow::after {
  background-image: radial-gradient(
    calc(var(--spotlight-size) * 0.5) calc(var(--spotlight-size) * 0.5) at calc(var(--x, 0) * 1px) calc(var(--y, 0) * 1px),
    hsl(0 100% 100% / var(--border-light-opacity, 1)),
    transparent 100%
  );
}
/* The soft halo outside the border: the same coloured spot, blurred. */
.glow__outer {
  position: absolute;
  inset: 0;
  opacity: var(--outer, 1);
  border-radius: calc(var(--radius) * 1px);
  filter: blur(calc(var(--border-size) * 10));
  will-change: filter;
  pointer-events: none;
}
.glow__outer::before { inset: -10px; border-width: 10px; }
</style>
