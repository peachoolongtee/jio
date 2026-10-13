<script setup>
// A muted dotted map of Singapore, with routes that draw themselves in once, from each starting point to where the
// group meets. Each route fades from faint at its start to full Rausch at the meeting point over a soft glow, starts
// at a small ring, and a short streak of light keeps gliding along it towards the meeting point: people converging,
// not a train line. Quiet on purpose: it sits behind words and a button. Decoration only: hidden from screen readers.
//   <SingaporeMap :routes="[{ from: { lat: 1.333, lng: 103.742 }, to: { lat: 1.333, lng: 103.847 } }]" />
// routes: [{ from: { lat, lng }, to: { lat, lng } }]. Each start is a small ring; the meeting point is one Rausch dot.
// center: the place that sits in the middle of the box (Singapore's middle by default), so something laid over the
// box's centre lines up with it. span: how much around it always shows; the map scales to fit that and fills the
// rest of the box with whatever is beyond. Give the box a size.
// rain: [{ lat, lng }] the places where rain is likely: each is a soft wash of ink with short slanted strokes over about one
// forecast area (Home draws it only for an outing within two hours; the words for it are on the page, as the map is hidden from
// screen readers). The strokes drift slowly down; under reduced motion they stand still, so the layer is a fixed texture. It is
// under the routes and the pins, and takes no pointer events.
// quick: draw the routes in about twice as fast, for a map that redraws when the choice changes (give it a new
// :key to redraw it): <SingaporeMap :key="selected.id" :routes="routes" quick />
// Built after Aceternity's World Map, with Singapore from lib/singaporeDots.js instead of the world.
import { computed, useId } from 'vue'
import { DOT_STEP, NEARBY_DOTS, SINGAPORE_DOTS, project } from '@/lib/singaporeDots.js'

const DOT = DOT_STEP * 0.42

const props = defineProps({
  routes: { type: Array, default: () => [] },
  center: { type: Object, default: null },
  // [width, height] around the centre that always shows, in map units (1 unit is about 111 m). Singapore is about
  // 390 wide and 310 tall.
  span: { type: Array, default: () => [420, 330] },
  // Hide the meeting point (when something on top of the map marks it instead).
  hideMeet: { type: Boolean, default: false },
  quick: { type: Boolean, default: false },
  rain: { type: Array, default: () => [] },
})

// How far rain reaches around a place, in map units (4.4 km: a forecast area and the ground around it, wide enough to show round a
// pin), and the height of one tile of strokes.
const RAIN_R = 40
const RAIN_TILE = 6

const MIDDLE = { x: 395, y: 205 }
// Gradient ids must be unique on the page, so each map gets its own prefix.
const uid = `sgmap-${useId()}`
const viewBox = computed(() => {
  const c = props.center ? project(props.center.lat, props.center.lng) : MIDDLE
  const [w, h] = props.span
  return `${c.x - w / 2} ${c.y - h / 2} ${w} ${h}`
})

// A curve from start to end that bows upward, more for longer trips.
function curve(a, b) {
  const lift = Math.hypot(b.x - a.x, b.y - a.y) * 0.3
  return `M ${a.x} ${a.y} Q ${(a.x + b.x) / 2} ${Math.min(a.y, b.y) - lift} ${b.x} ${b.y}`
}

const lines = computed(() =>
  props.routes.map((r) => {
    const a = project(r.from.lat, r.from.lng)
    const b = project(r.to.lat, r.to.lng)
    return { a, b, d: curve(a, b) }
  }),
)
const patches = computed(() => props.rain.map((p, i) => ({ ...project(p.lat, p.lng), i })))

// Every route ends at the same place, so draw the meeting point once.
const meet = computed(() => (props.hideMeet ? null : lines.value[0]?.b || null))
</script>

<template>
  <div class="sgmap" :class="{ 'sgmap--quick': quick }" aria-hidden="true">
    <svg :viewBox="viewBox" preserveAspectRatio="xMidYMid meet" class="sgmap__svg">
      <path class="sgmap__dots sgmap__dots--near" :d="NEARBY_DOTS" :stroke-width="DOT" />
      <path class="sgmap__dots" :d="SINGAPORE_DOTS" :stroke-width="DOT" />

      <defs>
        <!-- Rain: a wash that fades to nothing at the edge, and a tile of short slanted strokes that repeats. -->
        <radialGradient :id="`${uid}-wash`">
          <stop offset="0" class="sgmap__wash-in" />
          <stop offset="1" class="sgmap__wash-out" />
        </radialGradient>
        <pattern :id="`${uid}-strokes`" patternUnits="userSpaceOnUse" :width="RAIN_TILE" :height="RAIN_TILE">
          <path class="sgmap__stroke" d="M4.4 0.4 3.2 3.4M1.6 3.6 0.6 5.9" />
        </pattern>
        <clipPath v-for="p in patches" :id="`${uid}-clip${p.i}`" :key="`c${p.i}`"><circle :cx="p.x" :cy="p.y" :r="RAIN_R" /></clipPath>
        <!-- Each route: faint where someone starts, full colour where everyone meets. -->
        <linearGradient v-for="(line, i) in lines" :id="`${uid}-g${i}`" :key="`g${i}`" gradientUnits="userSpaceOnUse" :x1="line.a.x" :y1="line.a.y" :x2="line.b.x" :y2="line.b.y">
          <stop offset="0" class="sgmap__stop-start" />
          <stop offset="1" class="sgmap__stop-end" />
        </linearGradient>
        <filter :id="`${uid}-glow`" x="-20%" y="-20%" width="140%" height="140%"><feGaussianBlur stdDeviation="2.4" /></filter>
      </defs>
      <g v-if="patches.length" class="sgmap__rain" data-testid="map-rain">
        <g v-for="p in patches" :key="`p${p.i}`" :clip-path="`url(#${uid}-clip${p.i})`">
          <circle :cx="p.x" :cy="p.y" :r="RAIN_R" :fill="`url(#${uid}-wash)`" />
          <rect class="sgmap__drift" :x="p.x - RAIN_R" :y="p.y - RAIN_R - RAIN_TILE" :width="RAIN_R * 2" :height="RAIN_R * 2 + RAIN_TILE * 2" :fill="`url(#${uid}-strokes)`" />
        </g>
      </g>
      <g v-for="(line, i) in lines" :key="`r${i}`" :style="{ '--i': i }">
        <path class="sgmap__glow" :d="line.d" pathLength="1" :stroke="`url(#${uid}-g${i})`" :filter="`url(#${uid}-glow)`" />
        <path class="sgmap__route" :d="line.d" pathLength="1" :stroke="`url(#${uid}-g${i})`" />
        <path class="sgmap__comet" :d="line.d" pathLength="1" />
        <circle class="sgmap__start" :cx="line.a.x" :cy="line.a.y" r="2.6" />
      </g>
      <g v-if="meet" class="sgmap__meet">
        <circle class="sgmap__halo" :cx="meet.x" :cy="meet.y" r="11" />
        <circle :cx="meet.x" :cy="meet.y" r="6" />
      </g>
    </svg>
  </div>
</template>

<style scoped>
.sgmap { position: relative; overflow: hidden; pointer-events: none; user-select: none; }
.sgmap__svg { display: block; width: 100%; height: 100%; overflow: visible; }
/* Dots: a path of zero-length lines with round caps. Singapore in a pale grey, its neighbours paler still. */
.sgmap__dots { fill: none; stroke: color-mix(in srgb, var(--ink) 16%, transparent); stroke-linecap: round; }
.sgmap__dots--near { stroke: color-mix(in srgb, var(--ink) 6%, transparent); }
/* Each route draws itself in once, one after another: a fine line over a soft glow, both fading in from the start. */
.sgmap__stop-start { stop-color: var(--primary); stop-opacity: 0.08; }
.sgmap__stop-end { stop-color: var(--primary); stop-opacity: 0.85; }
.sgmap__route, .sgmap__glow { fill: none; stroke-linecap: round; stroke-dasharray: 1; stroke-dashoffset: 1; animation: sgmap-draw 1.4s var(--ease-out) forwards; animation-delay: calc(0.2s + var(--i) * 0.2s); }
.sgmap__route { stroke-width: 0.9; }
.sgmap__glow { stroke-width: 4; opacity: 0.35; }
@keyframes sgmap-draw { to { stroke-dashoffset: 0; } }
/* A short streak of light that glides along the route towards the meeting point, again and again, each route on
   its own beat so they never move in step. */
.sgmap__comet { fill: none; stroke: var(--primary-bright); stroke-width: 1.6; stroke-linecap: round; stroke-dasharray: 0.07 2; stroke-dashoffset: 0.07; opacity: 0; animation: sgmap-comet 3.2s cubic-bezier(0.45, 0, 0.25, 1) infinite; animation-delay: calc(1.8s + var(--i) * 0.55s); }
@keyframes sgmap-comet {
  0% { stroke-dashoffset: 0.07; opacity: 0; }
  10% { opacity: 1; }
  70% { stroke-dashoffset: -0.93; opacity: 1; }
  80%, 100% { stroke-dashoffset: -0.93; opacity: 0; }
}
/* Rain: ink, so it adds no colour that means something else. A wash and short strokes over the dots; the dots under them stay readable. */
.sgmap__wash-in { stop-color: var(--ink); stop-opacity: 0.14; }
.sgmap__wash-out { stop-color: var(--ink); stop-opacity: 0; }
.sgmap__stroke { fill: none; stroke: var(--body); stroke-width: 0.5; stroke-linecap: round; opacity: 0.75; }
/* The strokes fall one tile (6 units) each second, which is the pattern's own height, so the loop has no seam. */
.sgmap__drift { animation: sgmap-fall 1.2s linear infinite; }
@keyframes sgmap-fall { to { transform: translateY(6px); } }
/* Where someone starts: a small open ring, not a station dot. */
.sgmap__start { fill: var(--canvas); stroke: var(--primary); stroke-width: 1.1; opacity: 0; animation: sgmap-pop 400ms var(--ease-out) forwards; animation-delay: calc(0.1s + var(--i) * 0.2s); }
@keyframes sgmap-pop { to { opacity: 0.9; } }
.sgmap__meet circle { fill: var(--primary); }
.sgmap__meet .sgmap__halo { fill: color-mix(in srgb, var(--primary) 22%, transparent); }
/* Quick: the same draw-in, shorter and closer together. Reduced motion below still wins (animation: none). */
.sgmap--quick .sgmap__route, .sgmap--quick .sgmap__glow { animation-duration: 0.7s; animation-delay: calc(0.05s + var(--i) * 0.08s); }
.sgmap--quick .sgmap__start { animation-delay: calc(var(--i) * 0.08s); }
.sgmap--quick .sgmap__comet { animation-delay: calc(0.9s + var(--i) * 0.55s); }
@media (prefers-reduced-motion: reduce) {
  .sgmap__drift { animation: none; }
  .sgmap__route, .sgmap__glow { animation: none; stroke-dashoffset: 0; }
  .sgmap__comet { display: none; }
  .sgmap__start { animation: none; opacity: 0.9; }
}
</style>
