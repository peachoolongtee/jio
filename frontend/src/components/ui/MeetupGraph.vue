<script setup>
// Meetup frequency: a heat map that folds up into an isometric skyline, and back down again.
//   <MeetupGraph :history="[{ date: '2026-09-26', count: 1 }]" :planned="['2026-10-10']" />
// One scene, not two charts: every day is a box on a grid (weeks across, Monday to Sunday down). The flat view is
// the grid seen straight down; the 3D view is the same grid from a corner. Switching views swings one camera
// between the two while each week's bars rise (or settle) in a wave, oldest week first. The 3D view rises out of
// the flat one the first time the graph scrolls into sight.
// Shades of Rausch show how many meetups a day had; planned meetups are hatched in ink, and a ring marks today.
// Hover or tap a day for its count, arrow keys walk the grid, hover a legend swatch to pick out that level, and
// in 3D drag to turn it (the Reset view button, or a double-click, turns it back). The graph is one focusable,
// interactive element (role "application") that reads out the day the arrow keys land on.
// Clicking or tapping a day (or Enter on the day the arrow keys reached) picks it: the graph emits `select` with its date
// ('yyyy-MM-dd'), and again with null when the same day is picked a second time. The page that holds the graph filters by it
// and passes the day back as `selected`; when it clears the filter (selected becomes ''), the graph lets the day go too.
// Without motion, every change simply happens.
// The maths lives in lib/skyline.js.
import { computed, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { format } from 'date-fns'
import {
  ELEV_3D, ELEV_RANGE, YAW_3D, YAW_RANGE, barHeight, buildGrid, camera, computeStats, dayMs, easeInOutCubic,
  lerp, mixRGB, monthLabels, project, riseAt, smoothstep,
} from '@/lib/skyline.js'

const props = defineProps({
  history: { type: Array, default: () => [] },
  planned: { type: Array, default: () => [] },
  weeks: { type: Number, default: 26 },
  today: { type: Date, default: () => new Date() },
  defaultView: { type: String, default: '3d', validator: (v) => ['2d', '3d'].includes(v) },
  // The day the page is filtering by, or ''.
  selected: { type: String, default: '' },
})
const emit = defineEmits(['select'])

const DURATION = 1300
const EASE = 'cubic-bezier(0.65, 0, 0.35, 1)'
const LEVEL_NAMES = ['No meetups', '1 meetup', '2 meetups', '3 meetups', '4 or more']

const model = computed(() => {
  const grid = buildGrid({ history: props.history, planned: props.planned, today: props.today, weeks: props.weeks })
  return { ...grid, stats: computeStats(grid.cells), months: monthLabels(grid.cells, grid.weeks) }
})
const stats = computed(() => model.value.stats)
const months = computed(() => Math.round(props.weeks / 4.35))
const upcoming = computed(() => model.value.cells.filter((c) => c.planned).length)

const view = ref(props.defaultView)
const is3d = computed(() => view.value === '3d')
// The scene really is in 3D (it waits to rise until the graph is first seen): the corner stats follow this.
const scene3d = ref(false)
const width = ref(0)
const active = ref(-1)
const legendLevel = ref(-1)
const announce = ref('')
const swatches = ref([])

const root = ref(null)
const stage = ref(null)
const canvas = ref(null)
const tip = ref(null)

const meetups = (n) => (n === 1 ? 'meetup' : 'meetups')
const weeksWord = (n) => (n === 1 ? 'week' : 'weeks')
// A day is stored as midnight UTC. To print it, build the same calendar day in local time: the offset must be
// the one on that day (it changes with daylight saving), not today's.
const localDay = (d) => {
  const utc = new Date(dayMs(d))
  return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate())
}
const short = (d) => format(localDay(d), 'd MMM')
const long = (d) => format(localDay(d), 'EEE d MMM yyyy')
const range = (a, b) => (a && b ? `${short(a)} – ${short(b)}` : '–')
function describe(i) {
  const c = model.value.cells[i]
  if (!c) return ''
  if (c.planned) return `Meetup planned on ${long(c.date)}`
  return `${c.count ? `${c.count} ${meetups(c.count)}` : 'No meetups'} on ${long(c.date)}`
}

const statBlocks = computed(() => {
  const s = stats.value
  return [
    { label: `${months.value}-month total`, value: s.total, unit: meetups(s.total), sub: range(s.first, s.last) },
    { label: 'Busiest day', value: s.busiest.count, unit: meetups(s.busiest.count), sub: s.busiest.date ? short(s.busiest.date) : '–' },
    { label: 'Longest streak', value: s.longest.weeks, unit: weeksWord(s.longest.weeks), sub: range(s.longest.start, s.longest.end) },
    { label: 'Current streak', value: s.current.weeks, unit: weeksWord(s.current.weeks), sub: range(s.current.start, s.current.end) },
  ]
})
// Wide enough: in 3D the stats sit in the corners around the skyline; otherwise they are a row underneath.
const corners = computed(() => width.value >= 560)
const showRow = computed(() => !(scene3d.value && corners.value))
const bigSize = computed(() => Math.round(Math.max(28, Math.min(48, width.value * 0.058))))
// No "double-click" here: touch screens have none. The Reset view button does the same.
const hint = computed(() => (is3d.value ? 'Tap a day to show only that day below · drag to turn' : 'Tap a day to show only that day below · arrow keys to explore'))
const label = computed(() => `Meetups per day: ${stats.value.total} ${meetups(stats.value.total)} in the last ${months.value} months, shown as a ${is3d.value ? '3D skyline' : 'heat map'}`)
const hintId = `sky-hint-${useId()}`
const keysId = `sky-keys-${useId()}`
// Back to the first angle, when the skyline has been turned.
const resetView = () => engine?.reset()

let engine = null

onMounted(() => {
  const rootEl = root.value
  const stageEl = stage.value
  const cv = canvas.value
  const tipEl = tip.value
  const ctx = cv.getContext('2d')
  if (!ctx) return

  const reduceMq = window.matchMedia('(prefers-reduced-motion: reduce)')
  let reduced = reduceMq.matches

  // The morph: t runs 0 (flat) → 1 (3D); the camera eases it, the bars wave it.
  let t = 0
  let target = 0
  let entered = false
  // Orbit offsets, eased toward their goals.
  let yaw = 0
  let elev = 0
  let yawGoal = 0
  let elevGoal = 0
  // Layout.
  let W = 0
  let H2 = 0
  let H3 = 0
  let Hmax = 0
  let lastH = -1
  let dpr = 1
  let gutter = 30
  let labelW = 30
  let font = '10px sans-serif'
  // Colours, read from the tokens: [empty, 1, 2, 3, 4 or more] and ink, canvas, muted.
  let col = []
  let ink = [34, 34, 34]
  let bg = [255, 255, 255]
  let hatch = null
  // Cells.
  let n = 0
  let weeks = 0
  let cells = []
  let hgt = new Float32Array(0)
  let zs = new Float32Array(0)
  let hover = new Float32Array(0)
  let dim = new Float32Array(0)
  let polys = new Float32Array(0)
  let faces = new Uint8Array(0)
  let order = []
  let monthRows = []
  let weekdayRows = []
  // Interaction.
  let hovered = -1
  let pinned = -1
  let activeIdx = -1
  let tipW = 0
  let raf = 0
  let last = 0

  // Any CSS colour → [r, g, b], by letting the browser paint it.
  const probe = document.createElement('canvas').getContext('2d', { willReadFrequently: true })
  const toRGB = (color, fallback) => {
    if (!probe || !color) return fallback
    probe.clearRect(0, 0, 1, 1)
    probe.fillStyle = 'rgba(0,0,0,0)'
    probe.fillStyle = color
    probe.fillRect(0, 0, 1, 1)
    const d = probe.getImageData(0, 0, 1, 1).data
    return d[3] < 8 ? fallback : [d[0], d[1], d[2]]
  }
  const rgb = (c, f = 1, a = 1) => `rgba(${Math.round(c[0] * f)},${Math.round(c[1] * f)},${Math.round(c[2] * f)},${a})`

  function load() {
    const m = model.value
    cells = m.cells
    n = cells.length
    weeks = m.weeks
    if (hgt.length !== n) {
      hgt = new Float32Array(n)
      zs = new Float32Array(n)
      hover = new Float32Array(n)
      dim = new Float32Array(n)
      polys = new Float32Array(n * 24)
      faces = new Uint8Array(n)
      order = Array.from({ length: n }, (_, i) => i)
    }
    for (let i = 0; i < n; i++) hgt[i] = barHeight(cells[i].count, m.max)
    monthRows = m.months
    // Mon, Wed and Fri down the side, like GitHub.
    weekdayRows = [0, 2, 4].map((day) => ({ day, label: ['Mon', 'Wed', 'Fri'][day / 2] }))
    if (hovered >= n) hovered = -1
    if (pinned >= n) pinned = -1
  }

  // The colours come from the design tokens: four steps of Rausch, the same as before, on Surface Strong.
  function retheme() {
    const cs = getComputedStyle(rootEl)
    const v = (name) => cs.getPropertyValue(name).trim()
    ink = toRGB(v('--ink'), ink)
    bg = toRGB(v('--canvas'), bg)
    const primary = toRGB(v('--primary'), [255, 56, 92])
    col = [toRGB(v('--surface-strong'), [242, 242, 242]), toRGB(v('--primary-disabled'), [255, 209, 218]), mixRGB(bg, primary, 0.6), primary, toRGB(v('--primary-active'), [224, 11, 65])]
    font = `500 10px ${cs.fontFamily || 'sans-serif'}`
    // Planned: ink stripes on white, like a booked slot.
    const p = document.createElement('canvas')
    p.width = p.height = 6
    const pc = p.getContext('2d')
    pc.fillStyle = rgb(bg)
    pc.fillRect(0, 0, 6, 6)
    pc.strokeStyle = rgb(ink)
    pc.lineWidth = 1.2
    pc.beginPath()
    pc.moveTo(-1, 7)
    pc.lineTo(7, -1)
    pc.stroke()
    hatch = ctx.createPattern(p, 'repeat')
    ctx.font = font
    labelW = Math.ceil(Math.max(20, ...weekdayRows.map((r) => ctx.measureText(r.label).width))) + 8
    swatches.value = col.map((c) => rgb(c))
    kick()
  }

  // The scene's projected extent for camera e.
  function extent(cam, e, full) {
    const w = lerp(0.78, 0.9, e)
    const off = (1 - w) / 2
    let minx = Infinity
    let maxx = -Infinity
    let miny = Infinity
    let maxy = -Infinity
    const add = (x, y, z) => {
      const p = project(cam, x, y, z)
      if (p[0] < minx) minx = p[0]
      if (p[0] > maxx) maxx = p[0]
      if (p[1] < miny) miny = p[1]
      if (p[1] > maxy) maxy = p[1]
    }
    for (let i = 0; i < n; i++) {
      const x0 = cells[i].week + off
      const y0 = cells[i].day + off
      const z = full ? hgt[i] * e : zs[i]
      add(x0, y0, z)
      add(x0 + w, y0, z)
      add(x0, y0 + w, z)
      add(x0 + w, y0 + w, 0)
      add(x0, y0 + w, 0)
      add(x0 + w, y0, 0)
    }
    // Room for the month labels along the front edge in 3D.
    add(0, 7 + 1.5 * e, 0)
    add(weeks, 7 + 1.5 * e, 0)
    return { minx, maxx, miny, maxy }
  }

  function relayout() {
    const w = Math.round(stageEl.clientWidth)
    if (!w || !n) return
    W = w
    // Narrow cards give the weekday column to the grid: the rows get too tight to label.
    gutter = W < 420 ? 0 : labelW
    dpr = Math.min(2, window.devicePixelRatio || 1)
    const b2 = extent(camera(0), 0, true)
    H2 = 24 + ((b2.maxy - b2.miny) / (b2.maxx - b2.minx)) * (W - gutter - 4)
    const b3 = extent(camera(1), 1, true)
    const natural = ((b3.maxy - b3.miny) / (b3.maxx - b3.minx)) * (W - 40) + 40
    H3 = Math.max(Math.min(natural, W * 0.72, 520), Math.min(natural, 240))
    Hmax = Math.ceil(Math.max(H2, H3))
    cv.width = Math.round(W * dpr)
    cv.height = Math.round(Hmax * dpr)
    cv.style.width = `${W}px`
    cv.style.height = `${Hmax}px`
    lastH = -1
    width.value = W
    draw()
  }

  function quad(o, r) {
    if (r < 0.3) {
      ctx.moveTo(polys[o], polys[o + 1])
      ctx.lineTo(polys[o + 2], polys[o + 3])
      ctx.lineTo(polys[o + 4], polys[o + 5])
      ctx.lineTo(polys[o + 6], polys[o + 7])
      ctx.closePath()
      return
    }
    ctx.moveTo((polys[o + 6] + polys[o]) / 2, (polys[o + 7] + polys[o + 1]) / 2)
    for (let k = 0; k < 4; k++) {
      const b = (k + 1) % 4
      ctx.arcTo(polys[o + k * 2], polys[o + k * 2 + 1], polys[o + b * 2], polys[o + b * 2 + 1], r)
    }
    ctx.closePath()
  }

  function draw() {
    if (!W || !n) return
    const e = easeInOutCubic(t)
    const cam = camera(e, yaw, elev)
    const Hc = lerp(H2, H3, e)
    if (Math.abs(Hc - lastH) > 0.2) {
      stageEl.style.height = `${Hc.toFixed(1)}px`
      lastH = Hc
    }
    for (let i = 0; i < n; i++) zs[i] = riseAt(t, cells[i].week, weeks, cells[i].day) * hgt[i]
    const b = extent(cam, e, false)
    const pad = lerp(2, 20, e)
    const left = pad + gutter * (1 - e)
    const top = pad + 22 * (1 - e)
    const aw = W - left - pad
    const ah = Hc - top - pad
    const bw = Math.max(1e-6, b.maxx - b.minx)
    const bh = Math.max(1e-6, b.maxy - b.miny)
    const s = Math.min(aw / bw, ah / bh)
    const ox = left + (aw - bw * s) / 2 - b.minx * s
    const oy = top + (ah - bh * s) / 2 - b.miny * s
    const { cs, sn, se, ce } = cam
    const px = (x, y) => ox + (x * cs - y * sn) * s
    const py = (x, y, z) => oy + ((x * sn + y * cs) * se - z * ce) * s

    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    ctx.clearRect(0, 0, W, Hmax)
    // Painter's order: far boxes first.
    order.sort((a, c) => (cells[a].week + 0.5) * sn + (cells[a].day + 0.5) * cs - ((cells[c].week + 0.5) * sn + (cells[c].day + 0.5) * cs))

    const w = lerp(0.78, 0.9, e)
    const off = (1 - w) / 2
    // Round dots when flat (like the old graph's circles), crisp boxes in 3D.
    const radius = lerp(0.5, 0.04, e) * s * w
    const lift = 0.7 * e

    for (let k = 0; k < n; k++) {
      const i = order[k]
      const c = cells[i]
      const x0 = c.week + off
      const y0 = c.day + off
      const x1 = x0 + w
      const y1 = y0 + w
      const z = zs[i] + hover[i] * lift
      const o = i * 24
      polys[o] = px(x0, y0); polys[o + 1] = py(x0, y0, z)
      polys[o + 2] = px(x1, y0); polys[o + 3] = py(x1, y0, z)
      polys[o + 4] = px(x1, y1); polys[o + 5] = py(x1, y1, z)
      polys[o + 6] = px(x0, y1); polys[o + 7] = py(x0, y1, z)
      polys[o + 8] = px(x0, y1); polys[o + 9] = py(x0, y1, 0)
      polys[o + 10] = px(x1, y1); polys[o + 11] = py(x1, y1, 0)
      polys[o + 12] = polys[o + 4]; polys[o + 13] = polys[o + 5]
      polys[o + 14] = polys[o + 6]; polys[o + 15] = polys[o + 7]
      polys[o + 16] = px(x1, y0); polys[o + 17] = py(x1, y0, 0)
      polys[o + 18] = polys[o + 10]; polys[o + 19] = polys[o + 11]
      polys[o + 20] = polys[o + 4]; polys[o + 21] = polys[o + 5]
      polys[o + 22] = polys[o + 2]; polys[o + 23] = polys[o + 3]

      const tall = z * ce * s
      let f = 0
      if (tall > 0.35 && w * cs * s > 0.35) f |= 1
      if (tall > 0.35 && w * sn * s > 0.35) f |= 2
      faces[i] = f

      let colour = col[c.level]
      if (dim[i] > 0.002) colour = mixRGB(colour, col[0], 0.72 * dim[i])
      if (hover[i] > 0.002) colour = mixRGB(colour, ink, 0.16 * hover[i])
      // Days still to come fade back, unless a meetup is planned.
      const alpha = c.future && !c.planned ? 0.4 : 1

      if (f & 1) {
        ctx.beginPath()
        quad(o + 8, 0)
        ctx.fillStyle = rgb(colour, 0.84, alpha)
        ctx.fill()
      }
      if (f & 2) {
        ctx.beginPath()
        quad(o + 16, 0)
        ctx.fillStyle = rgb(colour, 0.68, alpha)
        ctx.fill()
      }
      ctx.beginPath()
      quad(o, radius)
      ctx.fillStyle = c.planned && hatch ? hatch : rgb(colour, 1, alpha)
      ctx.fill()
      if (c.planned) {
        ctx.strokeStyle = rgb(ink)
        ctx.lineWidth = 1
        ctx.stroke()
      }
      if (c.today) {
        ctx.strokeStyle = rgb(ink)
        ctx.lineWidth = 2
        ctx.stroke()
      }
      if (hover[i] > 0.02) {
        ctx.strokeStyle = rgb(ink, 1, 0.85 * hover[i])
        ctx.lineWidth = 1.5
        ctx.stroke()
      }
    }

    // Labels: along the top and left when flat, along the front edge in 3D. They fade, never pop.
    const muted = mixRGB(bg, ink, 0.55)
    ctx.font = font
    const a2 = 1 - smoothstep(0, 0.4, e)
    const a3 = smoothstep(0.62, 1, e)
    if (a2 > 0.004) {
      ctx.fillStyle = rgb(muted, 1, a2)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'bottom'
      let edge = -Infinity
      for (const m of monthRows) {
        const x = px(m.week + off, -0.3)
        const tw = ctx.measureText(m.label).width
        if (x < edge || x + tw > W) continue
        // A fixed 6px above the top row, not a share of the cell: on wide cards the cells are big, and a share of
        // one pushed the labels out past the 24px the frame keeps for them.
        ctx.fillText(m.label, x, py(m.week + off, off, 0) - 6)
        edge = x + tw + 6
      }
      ctx.textAlign = 'right'
      ctx.textBaseline = 'middle'
      if (gutter > 0) for (const r of weekdayRows) ctx.fillText(r.label, px(0, r.day + 0.5) - 6, py(0, r.day + 0.5, 0))
    }
    if (a3 > 0.004) {
      ctx.fillStyle = rgb(muted, 1, a3)
      ctx.textAlign = 'left'
      ctx.textBaseline = 'top'
      let edge = -Infinity
      for (const m of monthRows) {
        const x = px(m.week + 0.5, 7.3)
        const tw = ctx.measureText(m.label).width
        if (x < edge || x + tw > W) continue
        ctx.fillText(m.label, x, py(m.week + 0.5, 7.3, 0) + 2)
        edge = x + tw + 10
      }
    }

    // The tooltip rides the active day through morphs and turns.
    if (activeIdx >= 0 && activeIdx < n) {
      const i = activeIdx
      const c = cells[i]
      const z = zs[i] + hover[i] * lift
      const tx = px(c.week + 0.5, c.day + 0.5)
      const ty = Math.min(py(c.week + off, c.day + off, z), py(c.week + off + w, c.day + off, z), py(c.week + off, c.day + off + w, z))
      const half = tipW / 2
      const cx = Math.min(W - half - 2, Math.max(half + 2, tx))
      tipEl.style.transform = `translate(${(cx - half).toFixed(1)}px, ${(ty - 8).toFixed(1)}px) translateY(-100%)`
      tipEl.style.setProperty('--arrow', `${(tx - cx + half).toFixed(1)}px`)
    }
  }

  function tick(now) {
    raf = 0
    const dt = Math.min(0.05, Math.max(0, (now - last) / 1000))
    last = now
    let moving = false
    if (t !== target) {
      const step = reduced ? 1 : (dt * 1000) / DURATION
      t = target > t ? Math.min(target, t + step) : Math.max(target, t - step)
      moving = true
    }
    const ko = reduced ? 1 : 1 - Math.exp(-dt * 12)
    yaw += (yawGoal - yaw) * ko
    elev += (elevGoal - elev) * ko
    if (Math.abs(yawGoal - yaw) > 1e-4 || Math.abs(elevGoal - elev) > 1e-4) moving = true
    else {
      yaw = yawGoal
      elev = elevGoal
    }
    const kh = reduced ? 1 : 1 - Math.exp(-dt * 16)
    const kd = reduced ? 1 : 1 - Math.exp(-dt * 10)
    const leg = legendLevel.value
    for (let i = 0; i < n; i++) {
      const hg = i === activeIdx ? 1 : 0
      const dg = leg >= 0 && cells[i].level !== leg ? 1 : 0
      if (hover[i] !== hg) {
        hover[i] = Math.abs(hg - hover[i]) < 0.003 ? hg : hover[i] + (hg - hover[i]) * kh
        moving = true
      }
      if (dim[i] !== dg) {
        dim[i] = Math.abs(dg - dim[i]) < 0.003 ? dg : dim[i] + (dg - dim[i]) * kd
        moving = true
      }
    }
    draw()
    if (moving) raf = requestAnimationFrame(tick)
  }

  function kick() {
    if (raf) return
    last = performance.now()
    raf = requestAnimationFrame(tick)
  }

  // The active day is the hovered one, otherwise the pinned one (tap, click or keyboard).
  function refreshActive() {
    const next = hovered >= 0 ? hovered : pinned
    if (next === activeIdx) return
    activeIdx = next
    active.value = next
    kick()
  }

  function inQuad(o, x, y) {
    let sign = 0
    for (let k = 0; k < 4; k++) {
      const ax = polys[o + k * 2]
      const ay = polys[o + k * 2 + 1]
      const bx = polys[o + ((k + 1) % 4) * 2]
      const by = polys[o + ((k + 1) % 4) * 2 + 1]
      const cross = (bx - ax) * (y - ay) - (by - ay) * (x - ax)
      if (Math.abs(cross) < 1e-9) continue
      const sgn = cross > 0 ? 1 : -1
      if (sign === 0) sign = sgn
      else if (sgn !== sign) return false
    }
    return sign !== 0
  }
  function hit(x, y) {
    for (let k = n - 1; k >= 0; k--) {
      const i = order[k]
      const o = i * 24
      if (inQuad(o, x, y)) return i
      if (faces[i] & 1 && inQuad(o + 8, x, y)) return i
      if (faces[i] & 2 && inQuad(o + 16, x, y)) return i
    }
    return -1
  }
  const local = (ev) => {
    const r = cv.getBoundingClientRect()
    return [ev.clientX - r.left, ev.clientY - r.top]
  }

  let drag = null
  function onDown(ev) {
    if (ev.button !== 0) return
    const can = target === 1
    drag = { id: ev.pointerId, x: ev.clientX, y: ev.clientY, yaw: yawGoal, elev: elevGoal, moved: false, orbit: can, mouse: ev.pointerType === 'mouse' }
    if (can) {
      try {
        cv.setPointerCapture(ev.pointerId)
      } catch {
        // Capture is a nicety.
      }
    }
  }
  function onMove(ev) {
    if (drag && drag.orbit && ev.pointerId === drag.id) {
      const dx = ev.clientX - drag.x
      const dy = ev.clientY - drag.y
      if (drag.moved || Math.hypot(dx, dy) > 4) {
        drag.moved = true
        yawGoal = Math.min(YAW_RANGE[1] - YAW_3D, Math.max(YAW_RANGE[0] - YAW_3D, drag.yaw + dx * 0.006))
        if (drag.mouse) elevGoal = Math.min(ELEV_RANGE[1] - ELEV_3D, Math.max(ELEV_RANGE[0] - ELEV_3D, drag.elev + dy * 0.004))
        cv.style.cursor = 'grabbing'
        hovered = -1
        refreshActive()
        kick()
        return
      }
    }
    if (ev.pointerType !== 'mouse') return
    const [x, y] = local(ev)
    const i = hit(x, y)
    if (i !== hovered) {
      hovered = i
      refreshActive()
    }
    cv.style.cursor = target === 1 ? 'grab' : i >= 0 ? 'pointer' : 'default'
  }
  function onUp(ev) {
    if (!drag || ev.pointerId !== drag.id) return
    const moved = drag.moved
    drag = null
    if (cv.hasPointerCapture(ev.pointerId)) cv.releasePointerCapture(ev.pointerId)
    cv.style.cursor = target === 1 ? 'grab' : 'default'
    if (moved) return
    const [x, y] = local(ev)
    const i = hit(x, y)
    const again = i >= 0 && i === pinned
    pinned = again ? -1 : i
    if (ev.pointerType !== 'mouse') hovered = -1
    refreshActive()
    // A day picks it; the same day again lets it go. A click beside the days leaves the page's filter alone.
    if (i >= 0) emit('select', again ? null : cells[i].date)
  }
  const onCancel = () => {
    drag = null
  }
  function onLeave() {
    if (drag) return
    hovered = -1
    refreshActive()
  }
  function onDbl() {
    yawGoal = 0
    elevGoal = 0
    kick()
  }
  function onKey(ev) {
    const keys = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End', 'Escape', 'Enter', ' ']
    if (!keys.includes(ev.key) || !n) return
    ev.preventDefault()
    if (ev.key === 'Enter' || ev.key === ' ') {
      if (pinned >= 0) emit('select', cells[pinned].date === props.selected ? null : cells[pinned].date)
      return
    }
    if (ev.key === 'Escape') {
      pinned = -1
      hovered = -1
      refreshActive()
      return
    }
    let i = pinned >= 0 ? pinned : activeIdx >= 0 ? activeIdx : cells.findIndex((c) => c.today)
    if (pinned >= 0 || activeIdx >= 0) {
      if (ev.key === 'ArrowLeft') i -= 7
      if (ev.key === 'ArrowRight') i += 7
      if (ev.key === 'ArrowUp') i -= 1
      if (ev.key === 'ArrowDown') i += 1
      if (ev.key === 'Home') i = 0
      if (ev.key === 'End') i = n - 1
    }
    i = Math.max(0, Math.min(n - 1, i))
    pinned = i
    hovered = -1
    refreshActive()
    announce.value = describe(i)
  }
  function onBlur() {
    pinned = -1
    refreshActive()
  }

  function setTarget() {
    if (!entered) return
    const goal = view.value === '3d' ? 1 : 0
    if (goal === target) return
    target = goal
    scene3d.value = goal === 1
    if (goal === 0) {
      yawGoal = 0
      elevGoal = 0
    }
    cv.style.cursor = target === 1 ? 'grab' : 'default'
    kick()
  }

  load()
  retheme()
  relayout()

  // The 3D view rises out of the flat one the first time the graph is seen.
  const enter = () => {
    if (entered) return
    entered = true
    if (reduced) t = view.value === '3d' ? 1 : 0
    setTarget()
  }
  const io = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => {
      if (entries.some((en) => en.isIntersecting)) {
        enter()
        io.disconnect()
      }
    }, { threshold: 0.35 })
    : null
  if (io) io.observe(stageEl)
  else enter()

  const ro = new ResizeObserver(() => {
    if (Math.round(stageEl.clientWidth) !== W) relayout()
  })
  ro.observe(stageEl)
  const onReduce = () => {
    reduced = reduceMq.matches
    kick()
  }
  reduceMq.addEventListener('change', onReduce)

  cv.addEventListener('pointerdown', onDown)
  cv.addEventListener('pointermove', onMove)
  cv.addEventListener('pointerup', onUp)
  cv.addEventListener('pointercancel', onCancel)
  cv.addEventListener('pointerleave', onLeave)
  cv.addEventListener('dblclick', onDbl)
  cv.addEventListener('keydown', onKey)
  cv.addEventListener('blur', onBlur)

  engine = {
    // Choosing a view counts as seeing the graph.
    target: () => {
      entered = true
      setTarget()
      kick()
    },
    kick,
    reset: onDbl,
    // The page cleared its filter: let the picked day go.
    unpin: () => {
      pinned = -1
      refreshActive()
    },
    load: () => {
      load()
      relayout()
    },
    tipWidth: (w) => {
      tipW = w
      draw()
    },
    destroy: () => {
      if (raf) cancelAnimationFrame(raf)
      io?.disconnect()
      ro.disconnect()
      reduceMq.removeEventListener('change', onReduce)
      cv.removeEventListener('pointerdown', onDown)
      cv.removeEventListener('pointermove', onMove)
      cv.removeEventListener('pointerup', onUp)
      cv.removeEventListener('pointercancel', onCancel)
      cv.removeEventListener('pointerleave', onLeave)
      cv.removeEventListener('dblclick', onDbl)
      cv.removeEventListener('keydown', onKey)
      cv.removeEventListener('blur', onBlur)
    },
  }
})

onBeforeUnmount(() => engine?.destroy())
watch(view, () => engine?.target())
watch(legendLevel, () => engine?.kick())
watch(() => props.selected, (day) => { if (!day) engine?.unpin() })
watch(model, () => engine?.load())
// The tooltip's width keeps it inside the card; measure it whenever its text changes.
watch(active, async () => {
  await Promise.resolve()
  if (tip.value && active.value >= 0) engine?.tipWidth(tip.value.offsetWidth)
}, { flush: 'post' })
</script>

<template>
  <figure ref="root" class="sky">
    <figcaption class="sky__head">
      <span class="sky__title">
        <strong class="tnum">{{ stats.total }}</strong> {{ meetups(stats.total) }} in the last {{ months }} months<template v-if="upcoming"> · {{ upcoming }} planned</template>
      </span>
      <div class="sky__toggle" role="group" aria-label="Chart view">
        <span class="sky__thumb" :class="{ 'is-3d': is3d }" aria-hidden="true" />
        <button type="button" class="sky__view" :class="{ 'is-on': !is3d }" :aria-pressed="String(!is3d)" aria-label="Flat heat map" title="Flat heat map" @click="view = '2d'">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="1.5" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" /><rect x="9" y="1.5" width="5.5" height="5.5" rx="1" fill="currentColor" /><rect x="1.5" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" /><rect x="9" y="9" width="5.5" height="5.5" rx="1" fill="currentColor" /></svg>
        </button>
        <button type="button" class="sky__view" :class="{ 'is-on': is3d }" :aria-pressed="String(is3d)" aria-label="3D skyline" title="3D skyline" @click="view = '3d'">
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M8 1.2 14.2 4.6v6.8L8 14.8 1.8 11.4V4.6Z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /><path d="M1.8 4.6 8 8l6.2-3.4M8 8v6.8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" /></svg>
        </button>
      </div>
    </figcaption>

    <div class="sky__frame">
      <div class="sky__wrap">
        <div ref="stage" class="sky__stage">
          <canvas ref="canvas" class="sky__canvas" tabindex="0" role="application" aria-roledescription="interactive graph" :aria-label="label" :aria-describedby="`${keysId} ${hintId}`" :style="{ touchAction: is3d ? 'pan-y' : 'auto' }" />
          <template v-if="corners">
            <div class="sky__corner sky__corner--top" :class="{ 'is-shown': scene3d }" :aria-hidden="String(!scene3d)" :style="{ transitionDelay: scene3d ? `${Math.round(DURATION * 0.55)}ms` : '0ms' }">
              <div v-for="b in statBlocks.slice(0, 2)" :key="b.label" class="stat stat--end">
                <span class="stat__label">{{ b.label }}</span>
                <span class="stat__line"><span class="stat__value tnum" :style="{ fontSize: `${bigSize}px` }">{{ b.value }}</span><span class="stat__unit">{{ b.unit }}<span class="stat__sub">{{ b.sub }}</span></span></span>
              </div>
            </div>
            <div class="sky__corner sky__corner--bottom" :class="{ 'is-shown': scene3d }" :aria-hidden="String(!scene3d)" :style="{ transitionDelay: scene3d ? `${Math.round(DURATION * 0.65)}ms` : '0ms' }">
              <div v-for="b in statBlocks.slice(2)" :key="b.label" class="stat">
                <span class="stat__label">{{ b.label }}</span>
                <span class="stat__line"><span class="stat__value tnum" :style="{ fontSize: `${bigSize}px` }">{{ b.value }}</span><span class="stat__unit">{{ b.unit }}<span class="stat__sub">{{ b.sub }}</span></span></span>
              </div>
            </div>
          </template>
        </div>

        <div ref="tip" class="sky__tip" role="tooltip" :aria-hidden="String(active < 0)" :class="{ 'is-shown': active >= 0 }">
          <template v-if="active >= 0 && model.cells[active]">
            <strong>{{ model.cells[active].planned ? 'Meetup planned' : model.cells[active].count ? `${model.cells[active].count} ${meetups(model.cells[active].count)}` : 'No meetups' }}</strong>
            <span class="sky__tip-date"> on {{ long(model.cells[active].date) }}</span>
          </template>
          <span class="sky__tip-arrow" aria-hidden="true" />
        </div>
      </div>

      <div class="sky__row" :class="{ 'is-shown': showRow }" :aria-hidden="String(!showRow)" :style="{ transitionDuration: `${DURATION}ms` }">
        <div class="sky__row-inner">
          <div class="sky__stats">
            <div v-for="b in statBlocks" :key="b.label" class="stat stat--stack">
              <span class="stat__label">{{ b.label }}</span>
              <span class="stat__line"><span class="stat__value tnum">{{ b.value }}</span><span class="stat__unit">{{ b.unit }}</span></span>
              <span class="stat__sub">{{ b.sub }}</span>
            </div>
          </div>
        </div>
      </div>

      <div class="sky__foot">
        <span class="sky__notes">
          <span :id="hintId" class="sky__hint">{{ hint }}</span>
          <button v-if="scene3d" type="button" class="sky__reset" @click="resetView">Reset view</button>
        </span>
        <span :id="keysId" class="sr-only">Use the left and right arrow keys to move a week, the up and down arrow keys to move a day, Home and End for the first and last day, Enter to show only that day below, and Escape to clear.</span>
        <div class="sky__legend" @mouseleave="legendLevel = -1">
          <span>Less</span>
          <button
            v-for="(c, i) in swatches"
            :key="i"
            type="button"
            class="sky__swatch"
            :style="{ backgroundColor: c }"
            :aria-label="`Pick out days with ${LEVEL_NAMES[i].toLowerCase()}`"
            :aria-pressed="String(legendLevel === i)"
            :title="LEVEL_NAMES[i]"
            @mouseenter="legendLevel = i"
            @focus="legendLevel = i"
            @blur="legendLevel = -1"
            @click="legendLevel = legendLevel === i ? -1 : i"
          />
          <span>More</span>
          <span class="sky__swatch sky__swatch--planned" aria-hidden="true" />
          <span>Planned</span>
        </div>
      </div>
    </div>

    <p class="sr-only" aria-live="polite">{{ announce }}</p>
  </figure>
</template>

<style scoped>
.sky { display: flex; flex-direction: column; gap: var(--spacing-md); margin: 0; color: var(--ink); }
.sky__head { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-sm) var(--spacing-base); }
.sky__title { font: var(--text-body-sm); }
.sky__title strong { font-weight: 600; }
/* 2D / 3D: an ink thumb slides between the two. */
.sky__toggle { position: relative; display: inline-flex; padding: 2px; border: 1px solid var(--hairline); border-radius: var(--rounded-sm); }
.sky__thumb { position: absolute; top: 2px; bottom: 2px; left: 2px; width: var(--tap-min); border-radius: 6px; background: var(--ink); transition: transform 500ms cubic-bezier(0.65, 0, 0.35, 1); }
.sky__thumb.is-3d { transform: translateX(100%); }
.sky__view { position: relative; z-index: 1; display: grid; place-items: center; width: var(--tap-min); height: 28px; padding: 0; border: 0; border-radius: 6px; background: transparent; color: var(--muted); cursor: pointer; transition: color 500ms; }
/* The button looks 44 by 28; its tap area reaches 44px tall. */
.sky__view::after { content: ""; position: absolute; inset: -8px 0; }
.sky__view.is-on { color: var(--on-dark); }
.sky__view:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }

.sky__frame { position: relative; border: 1px solid var(--hairline); border-radius: var(--rounded-md); }
.sky__wrap { position: relative; padding: var(--spacing-md) var(--spacing-md) 0; }
.sky__stage { position: relative; width: 100%; height: 150px; overflow: hidden; border-radius: var(--rounded-sm); }
.sky__stage:has(:focus-visible) { outline: 2px solid var(--ink); outline-offset: 4px; }
.sky__canvas { position: absolute; top: 0; left: 0; display: block; max-width: none; outline: none; }

/* In 3D the stats sit in the corners around the skyline, arriving once it has risen. */
.sky__corner { position: absolute; display: flex; flex-direction: column; gap: var(--spacing-base); pointer-events: none; opacity: 0; transition: opacity 300ms, transform 300ms; transition-timing-function: cubic-bezier(0.65, 0, 0.35, 1); }
.sky__corner--top { top: 4px; right: 4px; align-items: flex-end; transform: translateY(-10px); }
.sky__corner--bottom { bottom: 4px; left: 4px; align-items: flex-start; transform: translateY(10px); }
.sky__corner.is-shown { opacity: 1; transform: none; transition-duration: 600ms; }

.stat { display: flex; flex-direction: column; min-width: 0; }
.stat--end { align-items: flex-end; text-align: right; }
.stat__label { color: var(--muted); font: var(--text-caption-sm); }
.stat__line { display: flex; align-items: flex-end; gap: 6px; }
.stat--end .stat__line { flex-direction: row; }
.stat__value { color: var(--primary); font-weight: 600; line-height: 0.95; letter-spacing: -0.02em; font-size: 26px; }
.stat__unit { display: flex; flex-direction: column; padding-bottom: 0.1em; font: var(--text-caption); text-align: left; }
.stat__sub { color: var(--muted); font: var(--text-caption-sm); white-space: nowrap; }
.stat--stack .stat__line { align-items: baseline; margin-top: var(--spacing-xxs); }
.stat--stack .stat__unit { display: inline; }
.stat--stack .stat__sub { overflow: hidden; text-overflow: ellipsis; }

/* Below the graph when flat (or narrow): a row of four that folds away as the corner stats arrive. */
.sky__row { display: grid; grid-template-rows: 0fr; opacity: 0; transition-property: grid-template-rows, opacity; transition-timing-function: cubic-bezier(0.65, 0, 0.35, 1); }
.sky__row.is-shown { grid-template-rows: 1fr; opacity: 1; }
.sky__row-inner { min-height: 0; overflow: hidden; }
.sky__stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-base); padding: var(--spacing-base) var(--spacing-md) var(--spacing-xxs); }
@media (min-width: 744px) { .sky__stats { grid-template-columns: repeat(4, minmax(0, 1fr)); } }

.sky__tip { position: absolute; top: var(--spacing-md); left: var(--spacing-md); z-index: 2; padding: 6px 10px; border-radius: var(--rounded-sm); background: var(--ink); box-shadow: var(--shadow-float); color: var(--on-dark); font: var(--text-caption-sm); line-height: 1; white-space: nowrap; pointer-events: none; opacity: 0; transition: opacity 150ms; }
.sky__tip.is-shown { opacity: 1; }
.sky__tip strong { font-weight: 600; }
.sky__tip-date { opacity: 0.75; }
.sky__tip-arrow { position: absolute; top: 100%; left: var(--arrow, 50%); width: 0; height: 0; margin-left: -5px; border-left: 5px solid transparent; border-right: 5px solid transparent; border-top: 5px solid var(--ink); }

.sky__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-sm) var(--spacing-base); padding: var(--spacing-md); color: var(--muted); font: var(--text-caption-sm); }
.sky__notes { display: inline-flex; flex-wrap: wrap; align-items: center; gap: 0 var(--spacing-md); }
/* Text button; its tap area is 44px tall, and the negative margin keeps the footer from growing. */
.sky__reset { min-height: var(--tap-min); margin-block: -14px; padding: 0 var(--spacing-xs); border: 0; background: transparent; color: var(--ink); font: inherit; font-weight: 600; text-decoration: underline; cursor: pointer; }
.sky__reset:focus-visible { outline: 2px solid var(--ink); outline-offset: 0; }
.sky__legend { display: flex; flex-wrap: wrap; align-items: center; }
/* A swatch looks 11px; the button around it is 24px, and the swatches are 24px apart, so each is an easy target. */
.sky__swatch { position: relative; width: 24px; height: 24px; padding: 6.5px; border: 0; background-clip: content-box; background-color: transparent; cursor: pointer; transition: transform 200ms var(--ease-out); }
.sky__swatch::after { content: ""; position: absolute; inset: 6.5px; border-radius: 3px; box-shadow: inset 0 0 0 1px rgb(0 0 0 / 0.06); }
.sky__swatch:hover { transform: scale(1.25); }
.sky__swatch:focus-visible { outline: 2px solid var(--ink); outline-offset: -2px; }
.sky__swatch--planned { width: 11px; height: 11px; padding: 0; margin-inline: var(--spacing-sm) var(--spacing-xs); border-radius: 3px; background: repeating-linear-gradient(-45deg, var(--ink) 0 1.2px, var(--canvas) 1.2px 4px); box-shadow: inset 0 0 0 1px var(--ink); cursor: default; }
.sky__swatch--planned::after { display: none; }
.sky__swatch--planned:hover { transform: none; }

@media (prefers-reduced-motion: reduce) {
  .sky__thumb, .sky__view, .sky__corner, .sky__row, .sky__tip, .sky__swatch { transition: none; }
}
</style>
