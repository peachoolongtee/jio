<script setup>
// Every map in the app. Leaflet, on OneMap's base map from the Singapore Land Authority.
//   <PlannerMap :people="[{ id, name, lat, lng, minutes }]" :area="{ name, lat, lng }" spokes />
//   <PlannerMap :places="[{ id, name, lat, lng, label: '1' }]" route :heat="showHeat" :heat-points="points" @select="open" />
// people     each person's start AREA (never an exact address), with their travel time when known
// area       the meeting area pin
// places     venues: numbered pins when `label` is set, otherwise category dots
// route      join the places in order with a line
// spokes     a thin line from each person to the meeting area
// heat       show the crowd heat layer; heatPoints are { lat, lng, level: quiet | moderate | busy }
// Pins are focusable: Tab to a pin and press Enter to select it.
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import L from 'leaflet'
import 'leaflet/dist/leaflet.css'

const props = defineProps({
  people: { type: Array, default: () => [] },
  area: { type: Object, default: null },
  places: { type: Array, default: () => [] },
  route: { type: Boolean, default: false },
  spokes: { type: Boolean, default: false },
  heat: { type: Boolean, default: false },
  heatPoints: { type: Array, default: () => [] },
  selected: { type: String, default: '' },
  label: { type: String, default: 'Map' },
  // What the view fits to: 'all' (default), or 'places' to frame the stops and the meeting area only.
  fitTo: { type: String, default: 'all' },
  zoomPosition: { type: String, default: 'topleft' },
})
const emit = defineEmits(['select'])

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
  return L.divIcon({
    className: 'pm pm--auto',
    html: `<span class="pm-person"><span class="pm-person__dot">${esc(person.name.charAt(0))}</span>${minutes}</span>`,
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

function placeIcon(place) {
  const selected = place.id === props.selected
  const inner = place.label ? esc(place.label) : ''
  const cls = place.label ? 'pm-stop' : `pm-venue pm-venue--${place.category || 'eat'}`
  return L.divIcon({
    className: 'pm',
    html: `<span class="${cls}${selected ? ' is-selected' : ''}${place.highlight ? ' is-highlight' : ''}">${inner}</span>`,
    iconSize: [32, 32],
    iconAnchor: [16, 16],
  })
}

function draw() {
  if (!map) return
  layers.base.clearLayers()
  const points = []
  const focus = []

  if (props.area && props.spokes) {
    for (const person of props.people) {
      L.polyline([[person.lat, person.lng], [props.area.lat, props.area.lng]], { className: 'pm-spoke', interactive: false }).addTo(layers.base)
    }
  }

  if (props.route && props.places.length > 1) {
    L.polyline(props.places.map((p) => [p.lat, p.lng]), { className: 'pm-route', interactive: false }).addTo(layers.base)
  }

  for (const person of props.people) {
    const text = `${person.name}${person.areaName ? ', from ' + person.areaName : ''}${person.minutes != null ? ', ' + person.minutes + ' min' : ''}`
    L.marker([person.lat, person.lng], { icon: personIcon(person), title: text, alt: text, keyboard: true, zIndexOffset: 100 }).addTo(layers.base)
    points.push([person.lat, person.lng])
  }

  if (props.area) {
    L.marker([props.area.lat, props.area.lng], { icon: areaIcon(), title: `Meeting area: ${props.area.name}`, alt: `Meeting area: ${props.area.name}`, keyboard: true, zIndexOffset: 500 })
      .bindTooltip(esc(props.area.name), { permanent: true, direction: 'bottom', offset: [0, 18], className: 'pm-tip pm-tip--area' })
      .addTo(layers.base)
    points.push([props.area.lat, props.area.lng])
    focus.push([props.area.lat, props.area.lng])
  }

  for (const place of props.places) {
    const marker = L.marker([place.lat, place.lng], { icon: placeIcon(place), title: place.name, alt: place.name, keyboard: true, riseOnHover: true, zIndexOffset: place.id === props.selected ? 1000 : 300 })
    marker.on('click', () => emit('select', place.id))
    marker.on('keypress', (event) => {
      if (event.originalEvent.key === 'Enter' || event.originalEvent.key === ' ') emit('select', place.id)
    })
    marker.addTo(layers.base)
    points.push([place.lat, place.lng])
    focus.push([place.lat, place.lng])
  }

  drawHeat()

  // Fit the view when the set of things on the map changes, not on every small update.
  const frame = props.fitTo === 'places' && focus.length ? focus : points
  const key = frame.map((p) => p.join(',')).sort().join('|')
  if (key !== fittedKey) {
    fittedKey = key
    if (frame.length > 1) map.fitBounds(L.latLngBounds(frame), { padding: [64, 64], maxZoom: 16 })
    else if (frame.length === 1) map.setView(frame[0], 15)
    else map.setView(SINGAPORE, 11)
  }
}

function drawHeat() {
  layers.heat.clearLayers()
  if (!props.heat) return
  const radius = { quiet: 160, moderate: 260, busy: 380 }
  for (const point of props.heatPoints) {
    for (const scale of [1, 0.6]) {
      L.circle([point.lat, point.lng], { radius: radius[point.level] * scale, className: `pm-heat pm-heat--${point.level}`, interactive: false }).addTo(layers.heat)
    }
  }
}

onMounted(() => {
  // OneMap serves zoom 11 and up; below that, Leaflet scales the zoom 11 tiles so a phone can see the whole island.
  map = L.map(el.value, { center: SINGAPORE, zoom: 11, minZoom: 10, maxZoom: 18, zoomSnap: 0.25, zoomControl: false, maxBounds: BOUNDS })
  L.control.zoom({ position: props.zoomPosition }).addTo(map)
  L.tileLayer(TILES, { attribution: ATTRIBUTION, minZoom: 10, minNativeZoom: 11, maxZoom: 19, bounds: BOUNDS }).addTo(map)
  layers = { base: L.layerGroup().addTo(map), heat: L.layerGroup().addTo(map) }
  draw()
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

onBeforeUnmount(() => {
  observer?.disconnect()
  map?.remove()
  map = null
})

watch(() => [props.people, props.area, props.places, props.route, props.spokes, props.selected], draw, { deep: true })
watch(() => [props.heat, props.heatPoints], () => map && drawHeat(), { deep: true })

// Called by a parent after the map container becomes visible.
function refit() {
  fittedKey = ''
  map?.invalidateSize()
  draw()
}
defineExpose({ refit })
</script>

<template>
  <div ref="el" class="planner-map" role="region" :aria-label="label" />
</template>

<style scoped>
/* Its own stacking context, so Leaflet's pane layers never cover cards placed over the map. */
.planner-map { isolation: isolate; width: 100%; height: 100%; min-height: 240px; background: var(--surface-strong); }
</style>

<style>
/* Leaflet draws markers outside Vue's scope, so these styles are global. All values come from tokens. */
.leaflet-container { font: var(--text-caption-sm); }
.leaflet-container a { color: var(--ink); }
.leaflet-bar a { width: 36px; height: 36px; line-height: 36px; color: var(--ink); }
.leaflet-control-zoom a:focus-visible, .leaflet-marker-icon:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.pm { background: transparent; border: 0; }
.pm-person, .pm-area, .pm-stop, .pm-venue { display: flex; align-items: center; justify-content: center; width: 100%; height: 100%; border-radius: var(--rounded-full); box-shadow: var(--shadow-float); font: var(--text-micro-label); }
.pm--auto { width: auto !important; height: auto !important; }
.pm-person { display: inline-flex; gap: var(--spacing-xs); width: auto; height: 28px; padding: 2px var(--spacing-sm) 2px 2px; background: var(--canvas); color: var(--ink); white-space: nowrap; }
.pm-person__dot { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: var(--rounded-full); background: var(--ink); color: var(--on-dark); }
.pm-person__min { font: var(--text-caption-sm); }
.pm-person:not(:has(.pm-person__min)) { padding-right: 2px; }
/* The meeting area is the Rausch marker. Stops and places are white markers with ink, like Airbnb's map pins;
   the leading or selected one flips to ink. */
.pm-area { border: 3px solid var(--canvas); background: var(--primary); color: var(--on-primary); }
.pm-stop { border: 1px solid var(--hairline); background: var(--canvas); color: var(--ink); font: var(--text-caption); font-weight: 700; }
.pm-venue { border: 4px solid var(--canvas); background: var(--border-strong); }
.pm-venue.is-highlight { background: var(--ink); }
.pm-stop.is-selected, .pm-venue.is-selected { transform: scale(1.2); border-color: var(--ink); background: var(--ink); color: var(--on-dark); }
.pm-tip { padding: var(--spacing-xxs) var(--spacing-sm); border: 0; border-radius: var(--rounded-full); background: var(--canvas); box-shadow: var(--shadow-float); color: var(--ink); font: var(--text-caption-sm); white-space: nowrap; }
.pm-tip::before { display: none; }
.pm-tip--area { font: var(--text-caption); font-weight: 600; }
.pm-route { stroke: var(--ink); stroke-width: 3; fill: none; stroke-linecap: round; stroke-linejoin: round; }
.pm-spoke { stroke: var(--ink); stroke-width: 1.5; stroke-dasharray: 4 6; fill: none; opacity: 0.6; }
/* Crowd heat: Rausch, stronger as it gets busier. */
.pm-heat { stroke: none; fill: var(--primary); }
.pm-heat--quiet { fill-opacity: 0.08; }
.pm-heat--moderate { fill-opacity: 0.16; }
.pm-heat--busy { fill-opacity: 0.3; }
</style>
