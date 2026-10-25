<script setup>
// Every map in the app. Leaflet, on OneMap's base map from the Singapore Land Authority.
//   <PlannerMap :people="[{ id, name, lat, lng, minutes }]" :area="{ name, lat, lng }" spokes />
//   <PlannerMap :places="[{ id, name, lat, lng, label: '1' }]" route @select="open" />
// people     each person's start AREA (never an exact address), with their travel time when known
// area       the meeting area pin
// places     venues: numbered pins when `label` is set, otherwise category dots
// route      join the places in order with a line
// spokes     a dashed line from each person to the meeting area, in their colour, moving towards it
// finding    the meeting area is being worked out: a pulse between everyone instead of the area pin
// radius     metres: a circle around the meeting area showing how far suggestions may be; it grows or shrinks
//            smoothly to a new size
// keep       extra points ({ lat, lng }) the view must also show, drawn by something laid over the map (the Locate
//            screen's spot pins). Emits `view` whenever the map moves or resizes; project(lat, lng) says where a
//            point is, in px from the map's top-left (call it through the component's ref).
// rain       [{ lat, lng }] the places where rain is likely: the same "Layered drops" as Home's map (lib/rainLook.js, DESIGN.md
//            "Weather"), a feathered blue wash with three layers of drops over each, in a Leaflet pane of its own under the
//            route and the markers and above the tiles. It moves and zooms with the map (a Leaflet marker in that pane; it
//            scales with the zoom glide and is sized again when the zoom ends), takes no pointer events and leaves the tiles
//            and the attribution alone. Each rainy place keeps a patch of its own, so every rainy stop in view has rain round it.
// rainLabel  the chip's words ("Rain likely · next 2 h", from rainChipText); the chip is shown with the rain, is read by screen
//            readers as part of the map's region, and is empty when nothing is known about the forecast's source.
// Colour coding: each person in their own colour (lib/people.js, the same as their avatar) with their travel
// time coloured by length (short, medium, long), places and numbered stops by category,
// the leading place (highlight) ringed and labelled while the others (muted) fade back.
// Pins are focusable: Tab to a pin and press Enter to select it.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'
import { travelTone } from '@/lib/planner/travel.js'
import { CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { personIndex } from '@/lib/people.js'
import { retireMap } from './retireMap.js'
import RainChip from '../weather/RainChip.vue'
import { nextRainUid, rainPatchSvg } from '@/lib/rainLook.js'

// People who asked for less motion get a map that jumps to its new view instead of gliding there.
const reducedMotion = () => !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches

const props = defineProps({
  people: { type: Array, default: () => [] },
  area: { type: Object, default: null },
  places: { type: Array, default: () => [] },
  route: { type: Boolean, default: false },
  spokes: { type: Boolean, default: false },
  selected: { type: String, default: '' },
  label: { type: String, default: 'Map' },
  // What the view fits to: 'all' (default), or 'places' to frame the stops and the meeting area only.
  fitTo: { type: String, default: 'all' },
  zoomPosition: { type: String, default: 'topleft' },
  finding: { type: Boolean, default: false },
  radius: { type: Number, default: 0 },
  keep: { type: Array, default: () => [] },
  rain: { type: Array, default: () => [] },
  rainLabel: { type: String, default: '' },
})
const emit = defineEmits(['select', 'view'])

const TILES = 'https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png'
const ATTRIBUTION = '<a href="https://www.onemap.gov.sg/" target="_blank" rel="noopener noreferrer">OneMap</a> &copy; contributors &#124; <a href="https://www.sla.gov.sg/" target="_blank" rel="noopener noreferrer">Singapore Land Authority</a>'
const BOUNDS = [[1.13, 103.55], [1.5, 104.13]]
const SINGAPORE = [1.3521, 103.8198]

const el = ref(null)
let map = null
let layers = null
let observer = null
let fittedKey = ''

const esc = (text) => String(text).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])

// A compact pill: the person's initial and their travel time. The full text is the marker's title.
function personIcon(person) {
  const minutes = person.minutes != null ? `<span class="pm-person__min">${person.minutes} min</span>` : ''
  const tone = person.minutes != null && !props.finding ? ` pm-person--${travelTone(person.minutes)}` : ''
  return L.divIcon({
    className: 'pm pm--auto',
    html: `<span class="pm-person pm-c-${personIndex(person.id)}${tone}"><span class="pm-person__dot">${esc(person.name.charAt(0))}</span>${minutes}</span>`,
    iconSize: null,
    iconAnchor: [14, 14],
  })
}

function areaIcon() {
  return L.divIcon({
    className: 'pm',
    html: '<span class="pm-area"><svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.75"><path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14Z"/><circle cx="8" cy="6.5" r="1.5"/></svg></span>',
    iconSize: [40, 40],
    iconAnchor: [20, 20],
  })
}

// A place's name as a screen reader hears it, with its stop number and category, since the pins' colours alone
// do not tell Eat from Activity for everyone.
// How to call: placeName({ name: 'Maxwell Food Centre', category: 'eat', label: '1' }) -> 'Stop 1, Eat: Maxwell Food Centre'
function placeName(place) {
  const kind = CATEGORY_LABELS[place.category]
  const text = kind ? `${kind}: ${place.name}` : place.name
  return place.label ? `Stop ${place.label}, ${text}` : text
}

function placeIcon(place) {
  const selected = place.id === props.selected
  const inner = place.label ? esc(place.label) : ''
  const cls = place.label ? `pm-stop pm-stop--${place.category || 'eat'}` : `pm-venue pm-venue--${place.category || 'eat'}`
  return L.divIcon({
    className: 'pm',
    html: `<span class="${cls}${selected ? ' is-selected' : ''}${place.highlight ? ' is-highlight' : ''}${place.muted ? ' is-muted' : ''}">${inner}</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  })
}

// A gentle arc from a person to the hub, as points for a polyline, so the lines read as people heading in rather
// than as the map's own straight transit lines. Every arc bows the same way round, so they fan in neatly.
// How to call: arc({ lat, lng }, { lat, lng }) -> [[lat, lng], ...]
function arc(from, to, steps = 32) {
  const dLat = to.lat - from.lat
  const dLng = to.lng - from.lng
  // The control point: off the middle of the straight line, sideways by a fifth of its length.
  const c = { lat: from.lat + dLat / 2 - dLng * 0.2, lng: from.lng + dLng / 2 + dLat * 0.2 }
  const points = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const u = 1 - t
    points.push([u * u * from.lat + 2 * u * t * c.lat + t * t * to.lat, u * u * from.lng + 2 * u * t * c.lng + t * t * to.lng])
  }
  return points
}

function draw() {
  if (!map) return
  layers.base.clearLayers()
  const points = []
  const focus = []

  // While the meeting area is being found: a pulse in the middle of everyone, and moving lines towards it.
  const middle = props.finding && props.people.length
    ? { lat: props.people.reduce((s, p) => s + p.lat, 0) / props.people.length, lng: props.people.reduce((s, p) => s + p.lng, 0) / props.people.length }
    : null
  const hub = middle || (props.spokes ? props.area : null)
  if (hub) {
    props.people.forEach((person, i) => {
      // Three strokes on one arc: a white casing that lifts it off the map, the line in the person's colour, and a
      // short streak of light that glides along it to the hub.
      const tone = `pm-c-${personIndex(person.id)}${middle ? ' pm-spoke--finding' : ''}`
      const path = arc(person, hub)
      L.polyline(path, { className: 'pm-spoke-casing', interactive: false }).addTo(layers.base)
      L.polyline(path, { className: `pm-spoke ${tone}`, interactive: false }).addTo(layers.base)
      const comet = L.polyline(path, { className: `pm-spoke-comet ${tone}`, interactive: false }).addTo(layers.base)
      const el = comet.getElement()
      if (el) {
        // Measured along the line as 0 to 1, so the streak is the same share of every line, long or short.
        el.setAttribute('pathLength', '1')
        el.style.setProperty('--i', i)
      }
    })
  }
  if (middle) {
    const icon = L.divIcon({ className: 'pm', html: '<span class="pm-finding"><span></span><span></span><span></span></span>', iconSize: [96, 96], iconAnchor: [48, 48] })
    L.marker([middle.lat, middle.lng], { icon, interactive: false, keyboard: false, zIndexOffset: 400 }).addTo(layers.base)
  }

  // The search radius is drawn, and kept in view, by drawRadius.

  if (props.route && props.places.length > 1) {
    L.polyline(props.places.map((p) => [p.lat, p.lng]), { className: 'pm-route', interactive: false }).addTo(layers.base)
  }

  for (const person of props.people) {
    const text = `${person.name}${person.areaName ? ', from ' + person.areaName : ''}${person.minutes != null ? ', ' + person.minutes + ' min' : ''}`
    L.marker([person.lat, person.lng], { icon: personIcon(person), title: text, alt: text, keyboard: true, zIndexOffset: 100 }).addTo(layers.base)
    points.push([person.lat, person.lng])
  }

  if (props.area && !middle) {
    L.marker([props.area.lat, props.area.lng], { icon: areaIcon(), title: `Meeting area: ${props.area.name}`, alt: `Meeting area: ${props.area.name}`, keyboard: true, zIndexOffset: 500 })
      .bindTooltip(esc(props.area.name), { permanent: true, direction: 'bottom', offset: [0, 18], className: 'pm-tip pm-tip--area' })
      .addTo(layers.base)
    points.push([props.area.lat, props.area.lng])
    focus.push([props.area.lat, props.area.lng])
  }

  for (const place of props.places) {
    const marker = L.marker([place.lat, place.lng], { icon: placeIcon(place), title: placeName(place), alt: placeName(place), keyboard: true, riseOnHover: true, zIndexOffset: place.id === props.selected ? 1000 : 300 })
    if (place.highlight) marker.bindTooltip('Leading', { permanent: true, direction: 'top', offset: [0, -18], className: 'pm-tip pm-tip--lead' })
    marker.on('click', () => emit('select', place.id))
    marker.on('keypress', (event) => {
      if (event.originalEvent.key === 'Enter' || event.originalEvent.key === ' ') emit('select', place.id)
    })
    marker.addTo(layers.base)
    points.push([place.lat, place.lng])
    focus.push([place.lat, place.lng])
  }

  // Fit the view when the set of things on the map changes, not on every small update.
  for (const p of props.keep) points.push([p.lat, p.lng])
  const frame = props.fitTo === 'places' && focus.length ? focus : points
  const key = frame.map((p) => p.join(',')).sort().join('|')
  if (key !== fittedKey) {
    fittedKey = key
    if (frame.length > 1) map.fitBounds(L.latLngBounds(frame), { padding: [64, 64], maxZoom: 16, animate: !reducedMotion() })
    else if (frame.length === 1) map.setView(frame[0], 15, reducedMotion() ? { animate: false } : undefined)
    else map.setView(SINGAPORE, 11, reducedMotion() ? { animate: false } : undefined)
  }
}

// The rain: one marker for each rainy place, in the pane `rain` (z-index 350: above the tiles, below the route at 400 and the markers
// at 600). A marker, because Leaflet already moves and glides a marker with the map. Its icon is the shared rain patch (lib/rainLook.js)
// sized to cover about RAIN_M metres round the place at the current zoom, between RAIN_MIN and RAIN_MAX pixels across so it is neither a
// speck at the island's scale nor a huge element close in. While a zoom glides the patch scales to the size it will have, over the
// same time and curve as Leaflet's own zoom glide, and is sized again when the zoom ends (without the fade-in).
const RAIN_M = 1000
const RAIN_MIN = 170
const RAIN_MAX = 480
const ZOOM_GLIDE = 'transform 250ms cubic-bezier(0, 0, 0.25, 1)'
let rainMarkers = []
// How wide a patch is, in px, for a place at this zoom. How to call: rainSize(1.35, 15) -> 480
function rainSize(lat, zoom) {
  const metresPerPixel = (156543.03 * Math.cos((lat * Math.PI) / 180)) / 2 ** zoom
  return Math.round(Math.min(RAIN_MAX, Math.max(RAIN_MIN, (RAIN_M * 2) / metresPerPixel)))
}
// The icon for a patch of that size. How to call: rainIcon(392, true)
function rainIcon(size, fade) {
  return L.divIcon({ className: 'pm-rain', html: rainPatchSvg({ size, uid: nextRainUid(), fade }), iconSize: [size, size], iconAnchor: [size / 2, size / 2] })
}
// Draw the rain again for the current places. How to call: drawRain()
function drawRain() {
  if (!map) return
  layers.rain.clearLayers()
  rainMarkers = props.rain.map((p) => {
    const marker = L.marker([p.lat, p.lng], { icon: rainIcon(rainSize(p.lat, map.getZoom()), true), pane: 'rain', interactive: false, keyboard: false })
    marker.addTo(layers.rain)
    return marker
  })
}
// A zoom is gliding to `event.zoom`: each patch scales to the size it will have there, in step with the markers' glide.
// How to call: map.on('zoomanim', glideRain)
function glideRain(event) {
  rainMarkers.forEach((marker) => {
    const now = marker.options.icon.options.iconSize[0]
    const svg = marker.getElement()?.firstElementChild
    if (!svg) return
    svg.style.transition = ZOOM_GLIDE
    svg.style.transform = `scale(${rainSize(marker.getLatLng().lat, event.zoom) / now})`
  })
}
// The zoom ended: each patch takes the size for it. How to call: map.on('zoomend', sizeRain)
function sizeRain() {
  if (!map) return
  rainMarkers.forEach((marker) => {
    const size = rainSize(marker.getLatLng().lat, map.getZoom())
    if (marker.options.icon.options.iconSize[0] !== size) marker.setIcon(rainIcon(size, false))
    else {
      // A glide that ended at the same size (a clamped one): put the patch back as it was.
      const svg = marker.getElement()?.firstElementChild
      if (svg) { svg.style.transition = ''; svg.style.transform = '' }
    }
  })
}

// The search radius: a dashed circle around the meeting area, labelled at its top edge. A new radius grows or
// shrinks the circle to it instead of jumping; a new meeting area starts it again.
let circle = null
let circleLabel = null
let circleArea = ''
let shownRadius = 0
let tween = 0
const RADIUS_MS = 480
const easeOut = (t) => 1 - (1 - t) ** 3
const radiusText = (m) => (m >= 1000 ? `${m / 1000} km` : `${m} m`)
const topOf = (area, metres) => [area.lat + metres / 111320, area.lng]

function drawRadius() {
  cancelAnimationFrame(tween)
  const area = props.area
  const target = area && props.radius && !props.finding ? props.radius : 0
  const key = area ? `${area.lat},${area.lng}` : ''
  if (!target || key !== circleArea) {
    layers.radius.clearLayers()
    circle = null
    circleLabel = null
    shownRadius = 0
    circleArea = key
  }
  if (!target) return
  if (!circle) {
    circle = L.circle([area.lat, area.lng], { radius: target, className: 'pm-radius', interactive: false }).addTo(layers.radius)
    const icon = L.divIcon({ className: 'pm pm--auto', html: '<span class="pm-radius-label"></span>', iconSize: null, iconAnchor: [24, 12] })
    circleLabel = L.marker(topOf(area, target), { icon, interactive: false, keyboard: false }).addTo(layers.radius)
  }
  const label = circleLabel.getElement()?.querySelector('.pm-radius-label')
  if (label) label.textContent = radiusText(target)
  const from = shownRadius || target * 0.85
  const set = (r) => {
    shownRadius = r
    circle.setRadius(r)
    circleLabel.setLatLng(topOf(area, r))
  }
  if (reducedMotion() || from === target) {
    set(target)
    return keepInView()
  }
  const start = performance.now()
  const step = (now) => {
    const t = Math.min(1, (now - start) / RADIUS_MS)
    set(from + (target - from) * easeOut(t))
    if (t < 1) tween = requestAnimationFrame(step)
    else keepInView()
  }
  tween = requestAnimationFrame(step)
}

// Once the circle has its new size: if it spills out of view, zoom out just enough to show it all.
// A smaller circle never zooms the map in, so changing your mind does not throw the map around.
function keepInView() {
  if (!circle || !map) return
  const bounds = circle.getBounds()
  if (map.getBounds().pad(-0.05).contains(bounds)) return
  map.fitBounds(bounds.extend(map.getBounds()), { padding: [24, 24], maxZoom: 16, animate: !reducedMotion() })
}

// The map moved or changed size: tell the parent, which lays things over it (the Locate screen's spot pins).
// How to call: map.on(VIEW_EVENTS, onView)
const VIEW_EVENTS = 'move zoom moveend zoomend resize'
const onView = () => emit('view')

onMounted(() => {
  // OneMap serves zoom 11 and up; below that, Leaflet scales the zoom 11 tiles so a phone can see the whole island.
  map = L.map(el.value, { center: SINGAPORE, zoom: 11, minZoom: 10, maxZoom: 18, zoomSnap: 0.25, zoomControl: false, maxBounds: BOUNDS, zoomAnimation: !reducedMotion(), fadeAnimation: !reducedMotion(), markerZoomAnimation: !reducedMotion() })
  L.control.zoom({ position: props.zoomPosition }).addTo(map)
  L.tileLayer(TILES, { attribution: ATTRIBUTION, minZoom: 10, minNativeZoom: 11, maxZoom: 19, bounds: BOUNDS }).addTo(map)
  // The rain has a pane between the tiles (200) and the route (400), so it lies on the map and under everything drawn on it.
  map.createPane('rain').style.zIndex = 350
  layers = { rain: L.layerGroup().addTo(map), base: L.layerGroup().addTo(map), radius: L.layerGroup().addTo(map) }
  draw()
  drawRadius()
  drawRain()
  map.on('zoomanim', glideRain)
  map.on('zoomend', sizeRain)
  map.on(VIEW_EVENTS, onView)
  emit('view')
  // The map can start hidden (the List / Map switch on phones). Re-measure whenever its box changes.
  let lastWidth = el.value.clientWidth
  observer = new ResizeObserver(() => {
    const width = el.value?.clientWidth || 0
    map.invalidateSize()
    // Shown for the first time (it was 0 wide): fit the view again now that it has a size.
    if (!lastWidth && width) {
      fittedKey = ''
      draw()
    }
    lastWidth = width
  })
  observer.observe(el.value)
})

// Leaving: the map stops moving and is removed once Leaflet's own zoom timer has run (see retireMap.js), so a page left
// while the map is still gliding does not end in an error.
onBeforeUnmount(() => {
  cancelAnimationFrame(tween)
  observer?.disconnect()
  if (map) retireMap(map, VIEW_EVENTS, onView)
  map = null
})

watch(() => [props.people, props.area, props.places, props.route, props.spokes, props.selected, props.finding, props.radius, props.keep], draw, { deep: true })
watch(() => [props.area?.lat, props.area?.lng, props.radius, props.finding], () => map && drawRadius())
// Only a change of place redraws the rain, not a new array with the same places (a parent computes it again on every update).
watch(() => props.rain.map((p) => `${p.lat},${p.lng}`).join('|'), drawRain)

// Called by a parent after the map container becomes visible.
function refit() {
  fittedKey = ''
  map?.invalidateSize()
  draw()
}
// Where a point is on the map, in px from its top-left corner; null before the map exists.
// How to call: mapRef.value.project(1.3521, 103.8198) -> { x: 120, y: 80 }
function project(lat, lng) {
  if (!map) return null
  const point = map.latLngToContainerPoint([lat, lng])
  return { x: point.x, y: point.y }
}
defineExpose({ refit, project })
</script>

<template>
  <div ref="el" class="planner-map" role="region" :aria-label="label">
    <RainChip v-if="rain.length && rainLabel" :text="rainLabel" class="pm-rain-chip" />
  </div>
</template>

<style scoped>
/* Its own stacking context, so Leaflet's pane layers never cover cards placed over the map. */
.planner-map { isolation: isolate; width: 100%; height: 100%; min-height: 240px; background: var(--surface-strong); }
/* The rain chip, over the top middle of the map and below the row of buttons that sit at the top (the zoom buttons at the left, "View map"
   or "Expand map" at the right: 12px and 44px, so the chip starts at 64px). Above the panes (the map pane is 400), under the controls
   (800 and up). A screen that lays a bar over the top of the map sets --pm-rain-top to clear it. */
.pm-rain-chip { position: absolute; z-index: 500; top: var(--pm-rain-top, calc(var(--spacing-md) + var(--tap-min) + var(--spacing-sm))); left: 50%; translate: -50% 0; }
</style>

<style>
/* Leaflet draws markers outside Vue's scope, so these styles are global. All values come from tokens. */
.leaflet-container { font: var(--text-caption-sm); }
.leaflet-container a { color: var(--ink); }
/* The zoom buttons are 44px, on touch screens too (Leaflet's own touch rule is more specific, so it is matched). */
.leaflet-container .leaflet-bar a, .leaflet-container.leaflet-touch .leaflet-bar a { width: var(--tap-min); height: var(--tap-min); line-height: var(--tap-min); color: var(--ink); }
.leaflet-control-zoom a:focus-visible, .leaflet-marker-icon:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.pm { background: transparent; border: 0; }
.pm-person, .pm-area, .pm-stop, .pm-venue { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: var(--rounded-full); box-shadow: var(--shadow-float); font: var(--text-micro-label); }
.pm--auto { width: auto !important; height: auto !important; }
/* The rain: a patch in its own pane (lib/rainLook.js, styles/rain.css), plain and out of the way of the pointer. */
.pm-rain { background: transparent; border: 0; pointer-events: none; }
.pm-rain > svg { transform-origin: 50% 50%; }
.pm-person { display: inline-flex; gap: var(--spacing-xs); width: auto; height: 28px; padding: 2px var(--spacing-sm) 2px 2px; background: var(--canvas); color: var(--ink); white-space: nowrap; }
.pm-person__dot { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: var(--rounded-full); background: var(--pc, var(--ink)); color: var(--on-dark); }
/* Each person's colour, on their pin and their line to the meeting area (lib/people.js). */
.pm-c-1 { --pc: var(--person-1); } .pm-c-2 { --pc: var(--person-2); } .pm-c-3 { --pc: var(--person-3); } .pm-c-4 { --pc: var(--person-4); }
.pm-c-5 { --pc: var(--person-5); } .pm-c-6 { --pc: var(--person-6); } .pm-c-7 { --pc: var(--person-7); } .pm-c-8 { --pc: var(--person-8); }
.pm-person__min { font: var(--text-caption-sm); }
.pm-person:not(:has(.pm-person__min)) { padding-right: 2px; }
/* The meeting area is the Rausch marker. Stops and places are pins in their category colour with a white rim;
   the leader gets an ink ring and a "Leading" label, and the selected one flips to ink. */
.pm-area { border: 3px solid var(--canvas); background: var(--primary); color: var(--on-primary); }
.pm-stop { border: 2px solid var(--canvas); background: var(--ink); color: var(--on-dark); font: var(--text-caption); font-weight: 700; }
.pm-venue { border: 4px solid var(--canvas); background: var(--border-strong); }
.pm-venue--eat { background: var(--cat-eat-fg); }
.pm-venue--drink { background: var(--cat-drink-fg); }
.pm-venue--shop { background: var(--cat-shop-fg); }
.pm-venue--activity { background: var(--cat-activity-fg); }
.pm-venue.is-highlight { box-shadow: 0 0 0 2px var(--ink), var(--shadow-float); }
.pm-tip { padding: var(--spacing-xxs) var(--spacing-sm); border: 0; border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); color: var(--ink); font: var(--text-caption-sm); white-space: nowrap; }
.pm-tip::before { display: none; }
.pm-tip--area { font: var(--text-caption); font-weight: 600; }
.pm-route { stroke: var(--ink); stroke-width: 3; fill: none; stroke-linecap: round; stroke-linejoin: round; }
/* Each person's way in: a smooth arc, solid in their colour on a white casing, so it never reads as one of the
   map's dashed transit lines. A streak of light glides along it to the meeting point, each on its own beat. */
.pm-spoke-casing { stroke: var(--canvas); stroke-width: 6; stroke-linecap: round; stroke-linejoin: round; fill: none; opacity: 0.9; }
.pm-spoke { stroke: var(--pc, var(--ink)); stroke-width: 2.5; stroke-linecap: round; stroke-linejoin: round; fill: none; opacity: 0.9; }
.pm-spoke-comet { stroke: var(--canvas); stroke-width: 2.5; stroke-linecap: round; fill: none; stroke-dasharray: 0.06 2; stroke-dashoffset: 0.06; opacity: 0; animation: pm-comet 3s cubic-bezier(0.45, 0, 0.25, 1) infinite; animation-delay: calc(var(--i, 0) * 0.45s); }
@keyframes pm-comet {
  0% { stroke-dashoffset: 0.06; opacity: 0; }
  10% { opacity: 0.95; }
  70% { stroke-dashoffset: -0.94; opacity: 0.95; }
  80%, 100% { stroke-dashoffset: -0.94; opacity: 0; }
}
/* Travel time: the minutes in their travel colour; a long trip also rings the pin. */
.pm-person--short .pm-person__min { color: var(--travel-short); font-weight: 600; }
.pm-person--medium .pm-person__min { color: var(--travel-medium-text); font-weight: 600; }
.pm-person--long .pm-person__min { color: var(--travel-long); font-weight: 600; }
.pm-person--long { box-shadow: 0 0 0 2px var(--travel-long), var(--shadow-float); }
/* Numbered stops in their category colour, matching the stop numbers on the itinerary. */
.pm-stop--eat { background: var(--cat-eat-fg); }
.pm-stop--drink { background: var(--cat-drink-fg); }
.pm-stop--shop { background: var(--cat-shop-fg); }
.pm-stop--activity { background: var(--cat-activity-fg); }
/* Voting: the leader is ringed and labelled, the others step back. */
.pm-venue.is-muted, .pm-stop.is-muted { opacity: 0.55; }
.pm-stop.is-selected, .pm-venue.is-selected { transform: scale(1.2); border-color: var(--ink); background: var(--ink); color: var(--on-dark); }
.pm-tip--lead { background: var(--ink); color: var(--on-dark); font: var(--text-caption); font-weight: 600; }
/* The chosen search radius. */
.pm-radius { stroke: var(--primary); stroke-width: 2; stroke-dasharray: 6 6; fill: var(--primary); fill-opacity: 0.06; }
.pm-radius-label { display: inline-block; padding: var(--spacing-xxs) var(--spacing-sm); border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); font: var(--text-caption-sm); white-space: nowrap; }
/* Finding the meeting area: rings pulse out from the middle of everyone, and the lines march towards it. */
.pm-finding { position: relative; display: block; width: 96px; height: 96px; }
.pm-finding > span { position: absolute; inset: 0; border: 3px solid var(--primary); border-radius: var(--rounded-full); opacity: 0; animation: pm-pulse 1.8s ease-out infinite; }
.pm-finding > span:nth-child(2) { animation-delay: 0.6s; }
.pm-finding > span:nth-child(3) { animation-delay: 1.2s; }
.pm-finding::after { content: ""; position: absolute; left: 50%; top: 50%; width: 16px; height: 16px; margin: -8px 0 0 -8px; border: 3px solid var(--canvas); border-radius: var(--rounded-full); background: var(--primary); box-shadow: var(--shadow-float); }
.pm-spoke-comet.pm-spoke--finding { animation-duration: 1.2s; }
@keyframes pm-pulse { 0% { transform: scale(0.2); opacity: 0.9; } 100% { transform: scale(1); opacity: 0; } }
@media (prefers-reduced-motion: reduce) {
  .pm-finding > span { animation: none; }
  .pm-spoke-comet { display: none; }
  .pm-finding > span:first-child { opacity: 0.5; transform: scale(0.7); }
}
</style>
