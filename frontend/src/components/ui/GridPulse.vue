<script setup>
// A fine grid that takes colour where the pointer passes and lets it go a moment later, with a few cells lighting
// on their own so it is never dead. The spectrum runs down the field like a printed colour chart (yellow at the
// top, through orange, red, magenta and blue, to green), so a sweep reveals one band of colour, not confetti (muted to grey
// on 30 October 2026, brought back on 4 November 2026; lib/gridPulse.js holds the colours and the defaults).
//   <main class="screen" style="position: relative"><GridPulse /> ...content above it... </main>
// Place it inside a positioned container, under the content. Decoration only: hidden from screen readers,
// transparent to the pointer (it listens on the window), drawn on one canvas that sleeps when nothing is lit,
// paused off screen, and only the still grid under reduced motion. Cells behind lines of text marked
// `data-grid-avoid` (inside the grid's parent) go faint, so the colour never crowds the words.
// cell     cell size in px (the hairlines and the lit cells share it)
// reach    how far from the pointer a cell can still catch light, in cells
// ambient  how many cells light on their own each beat
// maxLit   a lid, so a fast sweep cannot light the whole field at once
import { onBeforeUnmount, onMounted, ref } from 'vue'
import { GRID_PULSE, spectrumPaint } from '@/lib/gridPulse.js'

const props = defineProps({
  cell: { type: Number, default: GRID_PULSE.cell },
  reach: { type: Number, default: GRID_PULSE.reach },
  ambient: { type: Number, default: GRID_PULSE.ambient },
  maxLit: { type: Number, default: GRID_PULSE.maxLit },
  avoid: { type: String, default: '[data-grid-avoid]' },
})

// How faint a cell goes right behind a line of text, how many cells it takes to come back to full strength,
// and the clearing kept around each line (px).
const FAINT = 0.13
const FADE = 2.2
const PAD = 5
const FADE_IN = 160
const FADE_OUT = 750

const box = ref(null)
const paper = ref(null)
let stop = () => {}

const easeOut = (t) => 1 - (1 - t) ** 2
const easeIn = (t) => t * t

onMounted(() => {
  const el = box.value
  const canvas = paper.value
  const ctx = canvas?.getContext('2d')
  if (!el || !canvas || !ctx) return
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const cell = props.cell
  let cols = 1
  let rows = 1
  let width = 0
  let height = 0
  let clear = []
  const cells = new Map()

  // Hold back from the lines of text, not the boxes that hold them: a short last line keeps its box's full width.
  // How to call: measureText() (after layout or text changes)
  function measureText() {
    const bounds = el.getBoundingClientRect()
    const scope = el.parentElement || document
    clear = [...scope.querySelectorAll(props.avoid)].flatMap((node) => {
      const range = document.createRange()
      range.selectNodeContents(node)
      const lines = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0)
      const boxes = lines.length ? lines : [node.getBoundingClientRect()]
      return boxes.map((r) => new DOMRect(r.left - bounds.left - PAD, r.top - bounds.top - PAD, r.width + PAD * 2, r.height + PAD * 2))
    })
  }

  // How to call: measure() (on mount and whenever the grid's box changes size)
  function measure() {
    width = el.clientWidth
    height = el.clientHeight
    cols = Math.max(1, Math.ceil(width / cell))
    rows = Math.max(1, Math.ceil(height / cell))
    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = Math.round(width * dpr)
    canvas.height = Math.round(height * dpr)
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    measureText()
    wake()
  }

  // How bright a cell may be, by its distance from the nearest line of text: faint behind the words, not dark,
  // so it reads as depth rather than a hole. How to call: brightness(col, row) -> 0.13 to 1
  function brightness(col, row) {
    const x = col * cell + cell / 2
    const y = row * cell + cell / 2
    let nearest = Infinity
    for (const r of clear) {
      const dx = Math.max(r.left - x, 0, x - r.right)
      const dy = Math.max(r.top - y, 0, y - r.bottom)
      nearest = Math.min(nearest, Math.hypot(dx, dy))
      if (nearest === 0) break
    }
    if (nearest === Infinity) return 1
    return FAINT + (1 - FAINT) * Math.min(1, nearest / (FADE * cell))
  }


  // One loop draws every lit cell; it runs only while something is lit.
  let frame = 0
  function draw(now) {
    frame = 0
    ctx.clearRect(0, 0, width, height)
    for (const [key, c] of cells) {
      let alpha
      if (now < c.until) {
        alpha = easeOut(Math.min(1, (now - c.born) / FADE_IN))
      } else {
        const t = (now - c.until) / FADE_OUT
        if (t >= 1) {
          cells.delete(key)
          continue
        }
        alpha = 1 - easeIn(t)
      }
      ctx.globalAlpha = alpha * c.dim * c.alpha
      ctx.fillStyle = c.colour
      // Inset by the hairline, so the grid still shows between lit cells.
      ctx.fillRect(c.col * cell + 1, c.row * cell + 1, cell - 1, cell - 1)
    }
    ctx.globalAlpha = 1
    if (cells.size) frame = requestAnimationFrame(draw)
  }
  function wake() {
    if (!frame) frame = requestAnimationFrame(draw)
  }

  // Lights one cell, unless it is off the grid or already lit. A cell caught again while fading picks up from
  // where it had got to. How to call: light(col, row, holdMs)
  function light(col, row, hold) {
    if (col < 0 || row < 0 || col >= cols || row >= rows || cells.size >= props.maxLit) return
    const key = `${col},${row}`
    const now = performance.now()
    const lit = cells.get(key)
    if (lit && now < lit.until) return
    let born = now
    if (lit) {
      const faded = 1 - easeIn(Math.min(1, (now - lit.until) / FADE_OUT))
      born = now - (1 - Math.sqrt(1 - faded)) * FADE_IN
    }
    const paint = lit ?? spectrumPaint(row, rows, Math.random())
    cells.set(key, { col, row, colour: paint.colour, alpha: paint.alpha, dim: brightness(col, row), born, until: now + hold })
    wake()
  }

  // The pointer paints. Cells further from it catch light less often, so the edge of the trail breaks up.
  let pending = 0
  let at = null
  function paint() {
    pending = 0
    if (!at) return
    const cx = Math.floor(at.x / cell)
    const cy = Math.floor(at.y / cell)
    const span = Math.ceil(props.reach)
    for (let dy = -span; dy <= span; dy++) {
      for (let dx = -span; dx <= span; dx++) {
        const away = Math.hypot(dx, dy)
        if (away > props.reach) continue
        if (Math.random() > 1 - away / (props.reach + 0.6)) continue
        light(cx + dx, cy + dy, 260 + Math.random() * 900)
      }
    }
  }
  // On the window, because the grid sits under the content and never gets the pointer itself.
  function onMove(event) {
    const bounds = el.getBoundingClientRect()
    at = { x: event.clientX - bounds.left, y: event.clientY - bounds.top }
    if (!pending) pending = requestAnimationFrame(paint)
  }

  // A few cells light on their own (`ambient`), so the grid is alive on arrival and on touch screens. Paused out of sight.
  let visible = true
  let beat = 0
  function drift() {
    beat = window.setTimeout(drift, 1400 + Math.random() * 1800)
    if (!visible || document.hidden || !props.ambient) return
    for (let i = 0; i < props.ambient; i++) light(Math.floor(Math.random() * cols), Math.floor(Math.random() * rows), 900 + Math.random() * 1600)
  }
  beat = window.setTimeout(drift, 500)

  const sight = new IntersectionObserver(([entry]) => {
    visible = entry?.isIntersecting ?? true
  })
  sight.observe(el)
  const resize = new ResizeObserver(measure)
  resize.observe(el)
  // Text added, removed or rewritten moves the lines to hold back from.
  let recheck = 0
  const copy = new MutationObserver(() => {
    if (!recheck) recheck = requestAnimationFrame(() => {
      recheck = 0
      measureText()
    })
  })
  copy.observe(el.parentElement || document.body, { childList: true, subtree: true, characterData: true })
  measure()
  document.fonts?.ready.then(measureText).catch(() => {})
  window.addEventListener('pointermove', onMove, { passive: true })

  stop = () => {
    sight.disconnect()
    resize.disconnect()
    copy.disconnect()
    cancelAnimationFrame(recheck)
    cancelAnimationFrame(frame)
    cancelAnimationFrame(pending)
    clearTimeout(beat)
    window.removeEventListener('pointermove', onMove)
  }
})

onBeforeUnmount(() => stop())
</script>

<template>
  <div ref="box" class="grid-pulse" aria-hidden="true" :style="{ '--grid-pulse-cell': `${cell}px` }">
    <canvas ref="paper" class="grid-pulse__canvas" />
  </div>
</template>

<style scoped>
/* The hairlines: faint on their own, so the lit cells keep full colour. The field fades out at the bottom. */
.grid-pulse {
  --grid-pulse-line: color-mix(in srgb, var(--ink) 7%, transparent);
  position: absolute;
  inset: 0;
  z-index: 0;
  overflow: hidden;
  pointer-events: none;
  background-image: linear-gradient(to right, var(--grid-pulse-line) 1px, transparent 1px), linear-gradient(to bottom, var(--grid-pulse-line) 1px, transparent 1px);
  background-size: var(--grid-pulse-cell) var(--grid-pulse-cell);
  -webkit-mask-image: linear-gradient(to bottom, #000 92%, transparent);
  mask-image: linear-gradient(to bottom, #000 92%, transparent);
}
.grid-pulse__canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
</style>
