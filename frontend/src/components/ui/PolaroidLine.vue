<script setup>
// Instant photos pegged to a sagging string. Drag the line (or use the arrows, or ← and →) and the prints slide
// along it, swinging on their pegs with the speed you give them and settling back; a light breeze plays while
// the line moves, and once everything has settled the drawing stops until the next input. The print in the middle
// is the current one: tapping it emits `open`, tapping another brings it over.
//   <PolaroidLine v-model:index="i" :photos="[{ id, src, note, title, caption }]" @open="view" />
// note     handwritten under the photo (a place, or a name)
// title    and caption: the line under the string, for the current print
// It moves on by itself every `autoplay` ms (0 turns that off), waiting while someone is using it, and stops
// drawing while off screen. A Pause/Play button turns the moving on by itself off and on, and it also waits while
// the pointer is over the line or focus is inside it. Under reduced motion it never moves by itself (the button is
// not shown), the prints hang still and the line jumps. Only moves the user makes are announced to screen readers.
// Each photo frame carries data-photo="index", so a viewer can grow out of the print. Physics: lib/polaroid.js.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { clamp, nearestAt, pad2, springStep, stringY, swingStep } from '@/lib/polaroid.js'

const props = defineProps({
  photos: { type: Array, required: true },
  height: { type: String, default: 'clamp(420px, 66vh, 620px)' },
  cardWidth: { type: Number, default: 260 },
  sag: { type: Number, default: 40 },
  swing: { type: Number, default: 1 },
  autoplay: { type: Number, default: 5000 },
  label: { type: String, default: 'Photos' },
})
const index = defineModel('index', { type: Number, default: 0 })
const emit = defineEmits(['open'])

const n = computed(() => props.photos.length)
const active = ref(clamp(index.value, 0, Math.max(0, n.value - 1)))
const dragging = ref(false)
// Moving on by itself: the user's Pause/Play choice, the pointer over the line, focus inside it, reduced motion.
const paused = ref(false)
const hovering = ref(false)
const inside = ref(false)
const reduceMotion = ref(false)
const canPlay = computed(() => props.autoplay > 0 && !reduceMotion.value && n.value > 1)
// What the live region says. It changes only when the user moves the line, never on its own.
const said = ref('')
const size = ref({ w: 1000, h: 600, cw: props.cardWidth })
const spacing = computed(() => size.value.cw * 1.08)
const current = computed(() => props.photos[active.value] || {})

const root = ref(null)
const path = ref(null)
const cards = []
const sim = { off: active.value * spacing.value, vel: 0, target: active.value * spacing.value, a: [], w: [] }
let drag = null
let lastTouch = 0

// `announce`: the user asked for this move, so say where it lands.
function goTo(i, announce = false) {
  const to = clamp(i, 0, n.value - 1)
  sim.target = to * spacing.value
  if (announce) {
    const title = props.photos[to]?.title
    said.value = `Photo ${to + 1} of ${n.value}${title ? `: ${title}` : ''}`
  }
  start()
}
function step(dir) {
  lastTouch = performance.now()
  goTo(Math.round(sim.target / spacing.value) + dir, true)
}

// Two-way: the line follows the index from outside (a viewer, a thumbnail), and reports where it settles.
watch(active, (i) => {
  if (index.value !== i) index.value = i
})
watch(index, (i) => {
  if (i >= 0 && i !== active.value) goTo(i)
})
// Photos added or removed. The list is newest first, so a new photo lands at the front and every index moves up:
// find the print that was in the middle by its id and keep it there, instead of staying on the same index.
// If that print is gone, stay on a print that exists.
const keyOf = (p, i) => p.id ?? p.src ?? i
watch(
  () => props.photos.map(keyOf),
  (keys, before) => {
    const count = keys.length
    const kept = before.length ? keys.indexOf(before[Math.min(active.value, before.length - 1)]) : -1
    if (kept >= 0 && kept !== active.value) {
      const shift = kept - active.value
      // The line and each print's swing move with their prints, so nothing jumps on screen.
      sim.off += shift * spacing.value
      sim.target += shift * spacing.value
      sim.a = shift > 0 ? [...Array(shift).fill(0), ...sim.a] : sim.a.slice(-shift)
      sim.w = shift > 0 ? [...Array(shift).fill(0), ...sim.w] : sim.w.slice(-shift)
      active.value = kept
    } else if (count && active.value > count - 1) {
      goTo(count - 1)
    }
    start()
  },
)
// A new spacing (the window resized): keep the current print in the middle.
watch(spacing, (s) => {
  sim.target = active.value * s
  sim.off = active.value * s
  start()
})
// A change to the look (the sag, the swing) shows even when everything is still.
watch(() => [props.sag, props.swing], start)

let raf = 0
let ro = null
let io = null
let timer = 0
let motion = null
let visible = true
let prev = 0

function frame(now) {
  raf = 0
  if (!visible || document.hidden) return
  const reduce = reduceMotion.value
  const dt = Math.min(0.033, (now - prev) / 1000)
  prev = now
  const { w, h, cw } = size.value
  const y0 = Math.max(36, h * 0.16)
  let lineVel
  if (drag?.moved) {
    lineVel = drag.v * 1000
  } else {
    const before = sim.off
    if (reduce) {
      sim.off = sim.target
      sim.vel = 0
    } else {
      ;[sim.off, sim.vel] = springStep(sim.off, sim.vel, sim.target, dt)
    }
    lineVel = -(sim.off - before) / Math.max(dt, 1e-3)
  }
  const gain = reduce ? 0 : props.swing
  const near = nearestAt(sim.off, spacing.value, n.value)
  let swinging = false
  for (let i = 0; i < n.value; i++) {
    const el = cards[i]
    if (!el) continue
    const x = w / 2 + i * spacing.value - sim.off
    if (x < -cw * 1.5 || x > w + cw * 1.5) {
      el.style.visibility = 'hidden'
      continue
    }
    el.style.visibility = 'visible'
    let a = sim.a[i] || 0
    let av = sim.w[i] || 0
    ;[a, av] = swingStep(a, av, lineVel, dt, gain)
    sim.a[i] = a
    sim.w[i] = av
    if (Math.abs(a) > 0.002 || Math.abs(av) > 0.01) swinging = true
    // A light breeze, a little different for each print. It is drawn on top and never fed back into the swing,
    // so it cannot keep the line awake.
    const breeze = gain ? Math.sin(now / 1300 + i * 1.7) * 0.0009 * gain : 0
    const y = stringY(x, w, y0, props.sag) - 6
    el.style.transform = `translate(${(x - cw / 2).toFixed(1)}px, ${y.toFixed(1)}px) rotate(${(a + breeze).toFixed(4)}rad)`
    el.style.zIndex = String(i === near ? n.value + 1 : n.value - Math.abs(i - near))
  }
  path.value?.setAttribute('d', `M0 ${y0} Q${w / 2} ${y0 + 2 * props.sag} ${w} ${y0}`)
  if (near !== active.value) active.value = near
  // Nothing is moving: stop drawing. Input, new photos, a resize or coming back to the page start it again.
  if (!drag && !swinging && Math.abs(sim.target - sim.off) < 0.05 && Math.abs(sim.vel) < 0.5) {
    sim.off = sim.target
    sim.vel = 0
    return
  }
  raf = requestAnimationFrame(frame)
}
function start() {
  if (raf) return
  prev = performance.now()
  raf = requestAnimationFrame(frame)
}

// Moves on by itself, back to the first print after the last, while nobody is using it.
function tick() {
  if (document.hidden || drag || paused.value || hovering.value || inside.value || n.value < 2 || performance.now() - lastTouch < props.autoplay) return
  goTo(active.value >= n.value - 1 ? 0 : active.value + 1)
}
function syncTimer() {
  window.clearInterval(timer)
  timer = canPlay.value ? window.setInterval(tick, props.autoplay) : 0
}
watch(canPlay, syncTimer)
const onMotion = (e) => {
  reduceMotion.value = e.matches
  start()
}
function togglePlay() {
  paused.value = !paused.value
  lastTouch = performance.now()
}
// After the pointer or focus leaves, wait a full turn before moving on.
function resume() {
  lastTouch = performance.now()
}
function onEnter(e) {
  if (e.pointerType === 'mouse') hovering.value = true
}
function onLeave() {
  if (hovering.value) resume()
  hovering.value = false
}
function onFocusIn() {
  inside.value = true
}
function onFocusOut(e) {
  if (root.value?.contains(e.relatedTarget)) return
  inside.value = false
  resume()
}

onMounted(() => {
  const el = root.value
  motion = window.matchMedia('(prefers-reduced-motion: reduce)')
  reduceMotion.value = motion.matches
  motion.addEventListener('change', onMotion)
  ro = new ResizeObserver(() => {
    const r = el.getBoundingClientRect()
    // Narrow screens give a print more of the width, so it is not lost on the paper.
    const cw = Math.round(Math.max(140, Math.min(props.cardWidth, r.width * (r.width < 600 ? 0.6 : 0.42), r.height * 0.45)))
    size.value = { w: r.width, h: r.height, cw }
    start()
  })
  ro.observe(el)
  io = new IntersectionObserver(([e]) => {
    visible = e.isIntersecting
    if (visible) start()
  })
  io.observe(el)
  document.addEventListener('visibilitychange', start)
  syncTimer()
  start()
})
onBeforeUnmount(() => {
  cancelAnimationFrame(raf)
  ro?.disconnect()
  io?.disconnect()
  document.removeEventListener('visibilitychange', start)
  motion?.removeEventListener('change', onMotion)
  window.clearInterval(timer)
})

function onDown(e) {
  if (e.target.closest('.pl-bar') || e.button > 0) return
  lastTouch = performance.now()
  start()
  drag = { x: e.clientX, off: sim.off, lx: e.clientX, lt: e.timeStamp, v: 0, moved: false }
}
function onMove(e) {
  if (!drag) return
  const dx = e.clientX - drag.x
  if (!drag.moved && Math.abs(dx) > 5) {
    drag.moved = true
    dragging.value = true
    root.value?.setPointerCapture(e.pointerId)
  }
  if (!drag.moved) return
  start()
  const dt = Math.max(1, e.timeStamp - drag.lt)
  drag.v = 0.7 * ((e.clientX - drag.lx) / dt) + 0.3 * drag.v
  drag.lx = e.clientX
  drag.lt = e.timeStamp
  // Past either end the line gives, like pulling on a string.
  const max = (n.value - 1) * spacing.value
  let off = drag.off - dx
  if (off < 0) off *= 0.35
  if (off > max) off = max + (off - max) * 0.35
  sim.off = off
}
function onUp(e) {
  const d = drag
  drag = null
  lastTouch = performance.now()
  if (!d) return
  if (d.moved) {
    dragging.value = false
    sim.vel = -d.v * 1000
    // A flick carries on a little, the way it was thrown.
    goTo(nearestAt(sim.off - d.v * 180, spacing.value, n.value), true)
    return
  }
  const card = e.target.closest('[data-i]')
  if (!card) return
  const i = Number(card.dataset.i)
  if (i === active.value) emit('open', i)
  else goTo(i, true)
}
function onKey(e) {
  if (e.key === 'ArrowRight') step(1)
  else if (e.key === 'ArrowLeft') step(-1)
  else if (e.key === 'Enter' && e.target === root.value) emit('open', active.value)
  else return
  e.preventDefault()
}
const setCard = (el, i) => {
  cards[i] = el
}
</script>

<template>
  <div
    ref="root"
    class="pl"
    :class="{ 'is-dragging': dragging }"
    :style="{ height, '--pl-cw': `${size.cw}px` }"
    role="region"
    aria-roledescription="carousel"
    :aria-label="label"
    tabindex="0"
    @keydown="onKey"
    @pointerdown="onDown"
    @pointermove="onMove"
    @pointerup="onUp"
    @pointercancel="onUp"
    @pointerenter="onEnter"
    @pointerleave="onLeave"
    @focusin="onFocusIn"
    @focusout="onFocusOut"
  >
    <svg class="pl-string" aria-hidden="true"><path ref="path" fill="none" stroke-width="1.5" stroke-linecap="round" /></svg>

    <div
      v-for="(p, i) in photos"
      :key="p.id || i"
      :ref="(el) => setCard(el, i)"
      class="pl-card"
      :class="{ 'is-on': i === active }"
      :data-i="i"
      :aria-hidden="i === active ? undefined : 'true'"
    >
      <div class="pl-print">
        <div class="pl-shot" :data-photo="i"><img :src="p.src" :alt="p.alt || ''" draggable="false" /></div>
        <div class="pl-note">{{ p.note || '' }}</div>
      </div>
      <span class="pl-peg" aria-hidden="true" />
    </div>

    <div class="pl-bar">
      <div :key="active" class="pl-cap" aria-hidden="true">
        <span v-if="current.title" class="pl-title">{{ current.title }}</span>
        <span v-if="current.caption" class="pl-sub">{{ current.caption }}</span>
      </div>
      <span class="pl-count tnum" aria-hidden="true"><b>{{ pad2(active + 1) }}</b> / {{ pad2(n) }}</span>
      <button v-if="canPlay" type="button" class="pl-btn" :aria-label="paused ? 'Play slideshow' : 'Pause slideshow'" :title="paused ? 'Play slideshow' : 'Pause slideshow'" @click="togglePlay">
        <svg v-if="paused" width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M5 3v10l8-5Z" /></svg>
        <svg v-else width="16" height="16" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><path d="M4.5 3h2.5v10H4.5ZM9 3h2.5v10H9Z" /></svg>
      </button>
      <button type="button" class="pl-btn" aria-label="Previous photo" :disabled="active === 0" @click="step(-1)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="M10 3 5 8l5 5" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
      <button type="button" class="pl-btn" aria-label="Next photo" :disabled="active === n - 1" @click="step(1)">
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true"><path d="m6 3 5 5-5 5" stroke="currentColor" stroke-width="1.5" /></svg>
      </button>
    </div>
    <p class="sr-only" aria-live="polite">{{ said }}</p>
  </div>
</template>

<style scoped>
/* Warm paper behind the line, the string in a soft brown, the prints in off-white like real instant film.
   These warm tones belong to this one picture, so they have no design token; they are named here once. */
.pl {
  --pl-bg: #f1ede6;
  --pl-string: #8a7f72;
  --pl-print: #fbfaf7;
  --pl-shot-bg: #d9d5cc;
  --pl-pen: #3b3833;
  --pl-peg-light: #e3c9a1;
  --pl-peg-mid: #c9a67a;
  --pl-peg-dark: #b8915f;
  --pl-peg-hole: rgb(80 60 30 / 0.45);
  --pl-shadow-edge: rgb(0 0 0 / 0.12);
  --pl-shadow-drop: rgb(0 0 0 / 0.4);
  --pl-shadow-peg: rgb(0 0 0 / 0.25);
  position: relative; width: 100%; overflow: hidden; border-radius: var(--rounded-lg); background: var(--pl-bg); color: var(--ink); user-select: none; -webkit-user-select: none; touch-action: pan-y; outline: none; cursor: grab; }
.pl.is-dragging { cursor: grabbing; }
.pl:focus-visible { box-shadow: inset 0 0 0 2px var(--ink); }
.pl-string { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; pointer-events: none; }
.pl-string path { stroke: var(--pl-string); }

.pl-card { position: absolute; top: 0; left: 0; width: var(--pl-cw); transform-origin: 50% 0; will-change: transform; cursor: inherit; }
.pl-print { margin-top: 10px; padding: 10px 10px 0; background: var(--pl-print); box-shadow: 0 1px 2px var(--pl-shadow-edge), 0 18px 30px -16px var(--pl-shadow-drop); transition: transform 500ms cubic-bezier(0.2, 0.7, 0.2, 1), filter 500ms ease; }
.pl-card:not(.is-on) .pl-print { transform: scale(0.9); filter: saturate(0.7) brightness(0.96); }
.pl-card.is-on .pl-shot { cursor: zoom-in; }
.pl-shot { position: relative; aspect-ratio: 1; overflow: hidden; background: var(--pl-shot-bg); }
.pl-shot img { position: absolute; inset: 0; display: block; width: 100%; height: 100%; max-width: none; object-fit: cover; pointer-events: none; }
/* Written on the white strip under the photo, like a pen note. */
.pl-note { display: flex; align-items: center; justify-content: center; height: 46px; padding: 0 6px; overflow: hidden; color: var(--pl-pen); font: italic 400 15px/1.1 var(--font-display); white-space: nowrap; text-overflow: ellipsis; }
.pl-peg { position: absolute; top: 0; left: 50%; width: 10px; height: 26px; margin-left: -5px; border-radius: 2px; background: linear-gradient(90deg, var(--pl-peg-mid), var(--pl-peg-light) 45%, var(--pl-peg-dark)); box-shadow: 0 2px 3px var(--pl-shadow-peg); }
.pl-peg::after { content: ""; position: absolute; top: 8px; left: 4px; width: 2px; height: 7px; border-radius: 1px; background: var(--pl-peg-hole); }

/* Under the string: what this photo is, the count, and the arrows. */
.pl-bar { position: absolute; right: clamp(16px, 4vw, 40px); bottom: clamp(16px, 4vh, 32px); left: clamp(16px, 4vw, 40px); display: flex; align-items: center; gap: clamp(10px, 2vw, 20px); cursor: default; }
.pl-cap { flex: 1; min-width: 0; overflow: hidden; padding-bottom: 0.15em; }
.pl-cap > * { display: block; animation: pl-in 550ms cubic-bezier(0.2, 0.8, 0.2, 1) both; }
.pl-title { overflow: hidden; font: 500 clamp(18px, 2.2vw, 24px)/1.15 var(--font-display); white-space: nowrap; text-overflow: ellipsis; }
.pl-sub { margin-top: 4px; overflow: hidden; color: var(--muted); font: var(--text-caption); white-space: nowrap; text-overflow: ellipsis; }
.pl-count { color: var(--muted); font: 500 12px/1 var(--font-sans); letter-spacing: 0.14em; }
.pl-count b { color: var(--ink); font-weight: 600; }
.pl-btn { display: grid; place-items: center; flex-shrink: 0; width: var(--tap-min); height: var(--tap-min); padding: 0; border: 1px solid color-mix(in srgb, var(--ink) 18%, transparent); border-radius: var(--rounded-full); background: transparent; color: var(--ink); cursor: pointer; transition: background-color 200ms ease, color 200ms ease, transform 260ms var(--ease-spring); }
.pl-btn:disabled { opacity: 0.35; cursor: default; }
.pl-btn:not(:disabled):active { transform: scale(0.9); transition-duration: 80ms; }
@media (hover: hover) { .pl-btn:not(:disabled):hover { background: var(--ink); color: var(--pl-bg); } }
.pl-btn:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* On the narrowest phones the buttons (44px each) need the room the count takes. */
@media (max-width: 419.98px) {
  .pl-count { display: none; }
  .pl-bar { gap: var(--spacing-sm); }
  /* The title may take two lines here, so more of it shows beside three buttons. */
  .pl-title { display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 2; white-space: normal; text-overflow: clip; }
}
@keyframes pl-in { from { transform: translateY(100%); opacity: 0; } to { transform: none; opacity: 1; } }
@media (prefers-reduced-motion: reduce) {
  .pl-cap > * { animation: none; }
  .pl-print { transition: none; }
}
</style>
