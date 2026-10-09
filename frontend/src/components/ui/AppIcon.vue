<script>
// Kept outside <script setup> so the prop validator below can use it.
const ICONS = {
  back: { body: '<path d="M10 3 5 8l5 5"/>', stroke: 2 },
  close: { body: '<path d="M4 4l8 8M12 4l-8 8"/>', stroke: 2 },
  plus: { body: '<path d="M8 3v10M3 8h10"/>', stroke: 1.75 },
  minus: { body: '<path d="M4 8h8"/>' },
  check: { body: '<path d="m3.5 8.5 3 3 6-7"/>', stroke: 2 },
  'chevron-down': { body: '<path d="m4 6 4 4 4-4"/>', stroke: 2 },
  search: { body: '<circle cx="7" cy="7" r="4.5"/><path d="M10.5 10.5 14 14"/>', stroke: 2 },
  calendar: { body: '<rect x="2.5" y="3.5" width="11" height="10" rx="1.5"/><path d="M2.5 6.5h11M5.5 2v3M10.5 2v3"/>' },
  bell: { body: '<path d="M4 7a4 4 0 0 1 8 0c0 3 1.25 4 1.25 4H2.75S4 10 4 7Z"/><path d="M6.75 13.25a1.5 1.5 0 0 0 2.5 0"/>' },
  heart: { body: '<path d="M8 13.5S2 10 2 6.2A3.2 3.2 0 0 1 8 4.6a3.2 3.2 0 0 1 6 1.6C14 10 8 13.5 8 13.5Z"/>' },
  comment: { body: '<path d="M2.5 3.5h11v7.5H7l-3 2.5V11H2.5Z"/>' },
  bookmark: { body: '<path d="M4 2.5h8v11L8 10.5 4 13.5Z"/>' },
  lock: { body: '<rect x="3" y="7" width="10" height="7" rx="1.5"/><path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2"/>' },
  clock: { body: '<circle cx="8" cy="8" r="6"/><path d="M8 4.75V8l2.25 1.5"/>' },
  vote: { body: '<path d="M3 13V8.5M8 13V3M13 13V6"/>' },
  swap: { body: '<path d="M3 6h9.5M10 3.5 12.5 6 10 8.5M13 10.5H3.5M6 8 3.5 10.5 6 13"/>' },
  rain: { body: '<path d="M5 10a3 3 0 0 1 .4-5.95 4 4 0 0 1 7.6 1.2A2.4 2.4 0 0 1 12.5 10ZM6 12l-.75 1.75M9 12l-.75 1.75M12 12l-.75 1.75"/>' },
  warning: { body: '<path d="M8 2.5 14 13H2Z"/><path d="M8 6.5v3M8 11.25v.01"/>' },
  link: { body: '<path d="M6.75 9.25a3 3 0 0 0 4.25 0l2-2A3 3 0 0 0 8.75 3l-.75.75M9.25 6.75a3 3 0 0 0-4.25 0l-2 2A3 3 0 0 0 7.25 13l.75-.75"/>' },
  camera: { body: '<path d="M2 5.5h2.5l1-1.75h5l1 1.75H14v7H2Z"/><circle cx="8" cy="8.75" r="2.25"/>' },
  grip: { body: '<circle cx="5.5" cy="3.5" r="1.25"/><circle cx="10.5" cy="3.5" r="1.25"/><circle cx="5.5" cy="8" r="1.25"/><circle cx="10.5" cy="8" r="1.25"/><circle cx="5.5" cy="12.5" r="1.25"/><circle cx="10.5" cy="12.5" r="1.25"/>', filled: true },
  star: { body: '<path d="M6 .8l1.6 3.3 3.6.5-2.6 2.5.6 3.6L6 9l-3.2 1.7.6-3.6L.8 4.6l3.6-.5z"/>', box: 12, filled: true },
  'chevron-right': { body: '<path d="m6 4 4 4-4 4"/>', stroke: 2 },
  home: { body: '<path d="M2.5 7.5 8 3l5.5 4.5v6H10V10H6v3.5H2.5Z"/>' },
  filter: { body: '<path d="M2.5 4h11M4.5 8h7M6.5 12h3"/>', stroke: 1.75 },
  crown: { body: '<path d="M2.75 12.5h10.5M3.25 10.5 2.25 4.75 5.5 7.5 8 3.25l2.5 4.25 3.25-2.75-1 5.75Z"/>' },
  coin: { body: '<circle cx="8" cy="8" r="6"/><path d="M9.25 5.25v3.5a1.75 1.75 0 0 1-3.5 0"/>' },
  sparkle: { body: '<path d="M8 2.5 9.2 6.8 13.5 8 9.2 9.2 8 13.5 6.8 9.2 2.5 8 6.8 6.8Z"/>' },
  map: { body: '<path d="M2 4 6 2.5l4 1.5 4-1.5v9.5L10 13.5 6 12l-4 1.5Z"/><path d="M6 2.5V12M10 4v9.5"/>' },
  pin: { body: '<path d="M8 14s4.5-4.2 4.5-7.5a4.5 4.5 0 0 0-9 0C3.5 9.8 8 14 8 14Z"/><circle cx="8" cy="6.5" r="1.5"/>' },
  flag: { body: '<path d="M4 14V2.5M4 3h8l-1.75 2.75L12 8.5H4"/>' },
  trash: { body: '<path d="M3 4.5h10M6.5 4.5V3h3v1.5M4.5 4.5l.6 9h5.8l.6-9M6.75 7v4M9.25 7v4"/>' },
  edit: { body: '<path d="M10.5 2.5 13.5 5.5 6 13H3v-3Z"/>' },
  more: { body: '<circle cx="3.5" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="12.5" cy="8" r="1.25"/>', filled: true },
  locate: { body: '<circle cx="8" cy="8" r="4"/><circle cx="8" cy="8" r="1"/><path d="M8 1.5V4M8 12v2.5M1.5 8H4M12 8h2.5"/>' },
  people: { body: '<circle cx="6" cy="5.5" r="2.25"/><path d="M2 13a4 4 0 0 1 8 0M10.5 3.5a2.25 2.25 0 0 1 0 4.25M12 9.5a4 4 0 0 1 2 3.5"/>' },
  'user-plus': { body: '<circle cx="6.5" cy="5.5" r="2.5"/><path d="M2 13.5a4.5 4.5 0 0 1 9 0M12.5 5v4M10.5 7h4"/>' },
  gift: { body: '<rect x="2.5" y="6" width="11" height="3" rx=".5"/><path d="M3.5 9v4.5h9V9M8 6v7.5M8 6S6.75 2.75 5 3.25 5.5 6 8 6Zm0 0s1.25-3.25 3-2.75S10.5 6 8 6Z"/>' },
  trophy: { body: '<path d="M5 2.5h6V6a3 3 0 0 1-6 0Z"/><path d="M5 3.5H3a2 2 0 0 0 2 2.5M11 3.5h2a2 2 0 0 1-2 2.5M8 9v3M5.5 13.5h5"/>' },
  expand: { body: '<path d="M9.5 2.5h4v4M13.5 2.5 9 7M6.5 13.5h-4v-4M2.5 13.5 7 9"/>' },
  collapse: { body: '<path d="M13.5 2.5 9.5 6.5M9.5 3v3.5H13M2.5 13.5l4-4M6.5 13V9.5H3"/>' },
  layers: { body: '<path d="M8 2.5 14 5.5 8 8.5 2 5.5Z"/><path d="M2 9l6 3 6-3"/>' },
  route: { body: '<circle cx="4" cy="12" r="1.5"/><circle cx="12" cy="4" r="1.5"/><path d="M5.5 12h4a2.25 2.25 0 0 0 0-4.5h-3a2.25 2.25 0 0 1 0-4.5h4"/>' },
  info: { body: '<circle cx="8" cy="8" r="6"/><path d="M8 7.25V11M8 5v.01"/>' },
  logout: { body: '<path d="M6.5 2.5h-3v11h3M10 5l3 3-3 3M13 8H6"/>' },
  // Stop categories
  eat: { body: '<path d="M4.5 2v4.5a1.5 1.5 0 0 0 3 0V2M6 8v6M11 14V2c-1.2 1-1.75 2.5-1.75 4.5V8H11"/>' },
  drink: { body: '<path d="M3 5h8v4.5A3.5 3.5 0 0 1 7.5 13h-1A3.5 3.5 0 0 1 3 9.5ZM11 6.5h1a1.75 1.75 0 0 1 0 3.5h-1M5.5 1.75v1.5M8.5 1.75v1.5"/>' },
  activity: { body: '<path d="M2.5 5h11v2a1.5 1.5 0 0 0 0 3v2h-11v-2a1.5 1.5 0 0 0 0-3ZM9.5 5v7"/>' },
  shop: { body: '<path d="M3.5 5.5h9l-.75 8h-7.5ZM5.75 5.5v-1a2.25 2.25 0 0 1 4.5 0v1"/>' },
  // Travel modes
  walk: { body: '<path d="M8.75 3.25a.75.75 0 1 0 0-.01M8.5 5.5 6.25 7.75M8.5 5.5V9l2 4.5M8.5 9 6 13.5M8.5 6.5 11 8"/>' },
  mrt: { body: '<path d="M4.5 2.5h7a1 1 0 0 1 1 1V10a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 10V3.5a1 1 0 0 1 1-1ZM3.5 7h9M6 9.25v.01M10 9.25v.01M5.5 11.5 4 14M10.5 11.5 12 14"/>' },
  car: { body: '<path d="M2.5 9.5 4 5.5a1 1 0 0 1 1-.75h6a1 1 0 0 1 1 .75l1.5 4v3h-11ZM2.5 9.5h11M5 12.5v1.25M11 12.5v1.25"/>' },
  // Tab bar (24px grid)
  'tab-feed': { body: '<path d="M4 10.5 12 4l8 6.5V20h-5.5v-5.5h-5V20H4Z"/>', box: 24, stroke: 1.75 },
  'tab-lists': { body: '<path d="M8 6.5h12M8 12h12M8 17.5h12"/><path d="M4 6.5h.01M4 12h.01M4 17.5h.01"/>', box: 24, stroke: 1.75 },
  'tab-plus': { body: '<path d="M12 5.5v13M5.5 12h13"/>', box: 24, stroke: 2 },
  'tab-board': { body: '<path d="M5 20v-6M12 20V5M19 20v-9"/>', box: 24, stroke: 1.75 },
  'tab-profile': { body: '<circle cx="12" cy="8.5" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>', box: 24, stroke: 1.75 },
  'tab-trophy': { body: '<path d="M7 4h10v5a5 5 0 0 1-10 0Z"/><path d="M7 5.5H4.75a2.25 2.25 0 0 0 2.5 4M17 5.5h2.25a2.25 2.25 0 0 1-2.5 4M12 14v3.5M9 17.5h6M7.5 20.5h9"/>', box: 24, stroke: 1.75 },
}
</script>

<script setup>
// Line icons on a 16px grid (tab-bar icons use a 24px grid). They take the text colour around them.
// Usage: <AppIcon name="back" /> or <AppIcon name="search" :size="20" />
import { computed } from 'vue'

const props = defineProps({
  name: { type: String, required: true, validator: (v) => v in ICONS },
  size: { type: [Number, String], default: null },
  // Fill the shape with the text colour, for example a saved bookmark.
  solid: { type: Boolean, default: false },
  // Give the icon a name for screen readers. Leave it empty when text beside it says the same thing.
  label: { type: String, default: '' },
})

const icon = computed(() => ICONS[props.name])
const box = computed(() => icon.value.box || 16)
const px = computed(() => props.size || box.value)
const filled = computed(() => icon.value.filled || props.solid)
</script>

<template>
  <!-- The icon bodies are fixed strings from the table above, never user input. -->
  <svg
    :viewBox="`0 0 ${box} ${box}`"
    :width="px"
    :height="px"
    :fill="filled ? 'currentColor' : 'none'"
    :stroke="icon.filled ? 'none' : 'currentColor'"
    :stroke-width="icon.stroke || 1.5"
    stroke-linecap="round"
    stroke-linejoin="round"
    :role="label ? 'img' : undefined"
    :aria-label="label || undefined"
    :aria-hidden="label ? undefined : 'true'"
    v-html="icon.body"
  />
</template>
