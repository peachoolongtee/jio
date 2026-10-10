<script setup>
// Real, focusable pins laid over Home's dotted map, one per meetup that has a meeting point, each with a small
// popover of the meetup's details that opens at the pin.
//   <MeetupPins class="hero__pins" :pins="pins" :meetups="meetups" my-id="ian" :names="nameOf" :selected-id="selected.id"
//               :center="MEET" :span="[340, 260]" @select="select" />
// Give it the same box as the SingaporeMap under it, and the same center and span: a pin is placed with the map's own
// projection and view box, so it sits on its meeting point at any size. The map is decoration and hidden from screen
// readers; these buttons are the way in.
// pins: [{ id, lat, lng, offset: { x, y }, label, name }] (lib/homeMeetups.js pinsFor, with a label and a name added).
// label: the short word on the pin ("Sat"). name: what a screen reader says (title, area and date).
// The selected pin is bigger, filled red, white inside and bobbing, so it differs from the rest by more than colour.
// A pin stays inside the box (its tip is moved in from the edge if its area is near it).
// The popover (MeetupSummary, compact), one at a time, never changes the selection (clicking a pin does):
//   a mouse      hover for 120 ms; it stays while the pointer is on the pin or the card, and closes 150 ms after leaving
//   a keyboard   focus on the pin (a mouse click does not count); Tab goes on into the card's link, Escape closes it
//                and keeps focus on the pin
//   a touch      a tap selects the pin and opens its card; a tap elsewhere or on another pin closes or moves it
// It sits above the pin (below, or beside it, when there is no room), slides along to stay in the map's box, and on a
// phone, where the box is too short, may use the viewport (lib/homeMeetups.js placeCard). It is not a dialog: no
// backdrop, no focus trap. The pin is aria-describedby the card while it is open.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import MeetupSummary from './MeetupSummary.vue'
import { placeCard } from '@/lib/homeMeetups.js'
import { project } from '@/lib/singaporeDots.js'

const props = defineProps({
  pins: { type: Array, required: true },
  meetups: { type: Array, default: () => [] },
  myId: { type: String, default: '' },
  // (id) => name, for the avatars in the card.
  names: { type: Function, default: (id) => id },
  selectedId: { type: String, default: '' },
  center: { type: Object, required: true },
  span: { type: Array, required: true },
})
const emit = defineEmits(['select'])

const OPEN_DELAY = 120 // ms of hovering before the card opens, so crossing the map does not flicker
const CLOSE_DELAY = 150 // ms after leaving the pin and the card before it closes
const MARGIN = 8 // px the card keeps from the edge of the box
// How far a drawn pin reaches above its tip (the selected one is bigger and bobs) and to each side, in px.
const REACH = { selected: 90, rest: 70, halfWidth: 30 }

const uid = `pins-${useId()}`
const layer = ref(null)
const cardId = (id) => `${uid}-card-${id}`
const byId = computed(() => Object.fromEntries(props.meetups.map((m) => [m.id, m])))

// Where each pin is, in map units from the center (the map scale is worked out in CSS from the box's size).
const placed = computed(() => {
  const c = project(props.center.lat, props.center.lng)
  return props.pins
    .filter((pin) => byId.value[pin.id])
    .map((pin) => {
      const p = project(pin.lat, pin.lng)
      return { ...pin, style: { '--dx': p.x - c.x, '--dy': p.y - c.y, '--ox': pin.offset?.x || 0, '--oy': pin.offset?.y || 0 } }
    })
})
const frame = computed(() => ({ '--w': props.span[0], '--h': props.span[1] }))

// ── The popover ──
const openId = ref('')
const placement = ref(null)
let hoverId = ''
let focusId = ''
let tapId = ''
let openTimer = 0
let closeTimer = 0
let quiet = false

const canHover = () => typeof matchMedia === 'function' && matchMedia('(hover: hover)').matches
const clearTimers = () => { clearTimeout(openTimer); clearTimeout(closeTimer) }
function hide() {
  clearTimers()
  openId.value = ''
  hoverId = focusId = tapId = ''
}
// Close the open card shortly, unless the pointer, focus or a tap still holds it.
function settle() {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    const id = openId.value
    if (id && hoverId !== id && focusId !== id && tapId !== id) openId.value = ''
  }, CLOSE_DELAY)
}
// How to call: @pointerenter="onEnter(pin.id, $event)"
function onEnter(id, event) {
  if (event.pointerType !== 'mouse') return
  hoverId = id
  if (openId.value === id) return clearTimeout(closeTimer)
  clearTimeout(openTimer)
  openTimer = setTimeout(() => { if (hoverId === id) openId.value = id }, OPEN_DELAY)
}
function onLeave(id, event) {
  if (event.pointerType !== 'mouse') return
  if (hoverId === id) hoverId = ''
  clearTimeout(openTimer)
  settle()
}
// Keyboard focus only: a mouse click on a pin focuses it too, and must not hold the card open.
function onFocusIn(id, event) {
  if (quiet || !event.target.matches(':focus-visible')) return
  clearTimers()
  focusId = id
  openId.value = id
}
function onFocusOut(id, event) {
  if (event.currentTarget.contains(event.relatedTarget)) return
  if (focusId === id) focusId = ''
  settle()
}
function onKeydown(event) {
  if (event.key !== 'Escape' || !openId.value) return
  hide()
  // Back to the pin without reopening the card that focus would otherwise open.
  quiet = true
  event.currentTarget.querySelector('.mpin').focus({ preventScroll: true })
  quiet = false
}
// A click selects, as it always has. A tap (or any click where nothing hovers) also opens, moves or closes the card.
function onPinClick(pin, event) {
  emit('select', pin.id)
  const touch = event.pointerType === 'touch' || event.pointerType === 'pen' || !canHover()
  if (!touch) return
  const closing = openId.value === pin.id && tapId === pin.id
  hide()
  if (!closing) {
    tapId = pin.id
    openId.value = pin.id
  }
}
function onOutside(event) {
  if (tapId && !event.target.closest?.('.mwrap')) hide()
}

// The box the card may use: the map's, less the bars; and the viewport, less the bars, for a phone where the map is
// too short. Everything in viewport px.
function boxes() {
  const area = layer.value.getBoundingClientRect()
  const root = getComputedStyle(document.documentElement)
  const bar = (name) => parseFloat(root.getPropertyValue(name)) || 0
  const left = Math.max(area.left, 0) + MARGIN
  const right = Math.min(area.right, document.documentElement.clientWidth) - MARGIN
  const top = bar('--topbar-height') + MARGIN
  const bottom = window.innerHeight - bar('--tabbar-height') - MARGIN
  return {
    map: { left, right, top: Math.max(area.top, top), bottom: Math.min(area.bottom, bottom) },
    viewport: { left, right, top, bottom },
  }
}
// Measure the card once it is in the page and put it by its pin. The wrapper has no size: its corner is the pin's tip.
let placedFor = ''
async function place(id) {
  // The same card placed again (its pin was selected and grew) keeps showing while it moves; a new one starts hidden.
  if (id !== placedFor) placement.value = null
  placedFor = id
  if (!id) return
  await nextTick()
  const card = layer.value?.querySelector(`[id="${cardId(id)}"]`)
  const anchor = card?.parentElement
  if (!anchor) return
  const tip = { x: anchor.getBoundingClientRect().x, y: anchor.getBoundingClientRect().y }
  const { map, viewport } = boxes()
  const reach = id === props.selectedId ? REACH.selected : REACH.rest
  const spot = placeCard({ tip, pin: { height: reach, halfWidth: REACH.halfWidth }, size: { w: card.offsetWidth, h: card.offsetHeight }, bounds: map, fallback: viewport })
  placement.value = { side: spot.side, left: spot.left - tip.x, top: spot.top - tip.y, caret: spot.caret }
}
// Again when the pin's selection changes: a selected pin is bigger, so its card must clear it.
watch([openId, () => props.selectedId], ([id]) => place(id))
// A pin that goes away (the meetup finished) takes its card with it.
watch(placed, (list) => { if (openId.value && !list.some((p) => p.id === openId.value)) hide() })
const cardStyle = computed(() => (placement.value ? { left: `${placement.value.left}px`, top: `${placement.value.top}px`, '--caret': `${placement.value.caret}px` } : { visibility: 'hidden' }))

onMounted(() => {
  document.addEventListener('pointerdown', onOutside)
  window.addEventListener('resize', hide)
})
onBeforeUnmount(() => {
  clearTimers()
  document.removeEventListener('pointerdown', onOutside)
  window.removeEventListener('resize', hide)
})
</script>

<template>
  <div ref="layer" class="pins" :style="frame" role="group" aria-label="Meetups on the map">
    <!-- Each wrapper is a point (the pin's tip) that holds the pin and, while open, its card, so the card follows the pin in the tab order. -->
    <div
      v-for="pin in placed"
      :key="pin.id"
      class="mwrap"
      :class="{ 'is-selected': pin.id === selectedId, 'is-open': pin.id === openId }"
      :style="pin.style"
      @pointerenter="onEnter(pin.id, $event)"
      @pointerleave="onLeave(pin.id, $event)"
      @focusin="onFocusIn(pin.id, $event)"
      @focusout="onFocusOut(pin.id, $event)"
      @keydown="onKeydown"
    >
      <button
        type="button"
        class="mpin"
        :aria-label="pin.name"
        :aria-pressed="pin.id === selectedId"
        :aria-describedby="pin.id === openId ? cardId(pin.id) : undefined"
        @click="onPinClick(pin, $event)"
      >
        <span class="mpin__body">
          <span class="mpin__bob">
            <svg class="mpin__shape" viewBox="0 0 100 128" aria-hidden="true" focusable="false">
              <path d="M50 125C50 125 5 77 5 47a45 45 0 0 1 90 0c0 30-45 78-45 78Z" />
              <circle cx="50" cy="47" r="36" />
            </svg>
            <span class="mpin__day" aria-hidden="true">{{ pin.label }}</span>
          </span>
        </span>
        <span class="mpin__shadow" aria-hidden="true" />
      </button>
      <Transition name="mcard">
        <div v-if="pin.id === openId" :id="cardId(pin.id)" class="mcard" :data-side="placement?.side" :style="cardStyle">
          <MeetupSummary compact :meetup="byId[pin.id]" :my-id="myId" :names="names" />
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* The box is a size container, so a pin can read its width and height (cqw, cqh) to scale map units to px the way the
   map's `meet` fit does: the smaller of box width / view width and box height / view height. */
.pins { container-type: size; pointer-events: none; }
/* A point at the pin's tip: the meeting point plus the fan-out. The clamps keep the whole pin, and the selected
   one's growth and bob, inside the box. The pin and its card are placed from it. */
.mwrap {
  --k: min(100cqw / var(--w), 100cqh / var(--h));
  position: absolute;
  left: clamp(34px, calc(50cqw + var(--dx) * var(--k) + var(--ox) * 1px), calc(100cqw - 34px));
  top: clamp(90px, calc(50cqh + var(--dy) * var(--k) + var(--oy) * 1px), calc(100cqh - 4px));
  z-index: 1;
  width: 0;
  height: 0;
}
.mwrap.is-selected { z-index: 3; }
.mwrap:focus-within { z-index: 2; }
.mwrap.is-selected:focus-within { z-index: 3; }
/* An open card is above every pin. */
.mwrap.is-open, .mwrap.is-open:focus-within { z-index: 6; }
.mpin {
  position: absolute;
  left: 0;
  top: 0;
  width: 50px;
  height: 64px;
  padding: 0;
  border: 0;
  border-radius: var(--rounded-md);
  background: none;
  color: var(--ink);
  cursor: pointer;
  pointer-events: auto;
  transform: translate(-50%, -100%);
  -webkit-tap-highlight-color: transparent;
}
.mpin__body { position: relative; display: block; width: 100%; height: 100%; transform-origin: 50% 100%; transition: transform var(--motion-fast) var(--ease-spring); }
.is-selected .mpin .mpin__body { transform: scale(1.2); }
.mpin__bob { position: relative; display: block; width: 100%; height: 100%; }
.mpin__shape { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
/* At rest: a white pin with an ink line and a pale head. */
.mpin__shape path { fill: var(--canvas); stroke: var(--ink); stroke-width: 5; transition: fill var(--motion-fast) var(--ease-out); }
.mpin__shape circle { fill: var(--surface-strong); }
/* Selected: the red pin, as on the main button, with a white head for the day. */
.is-selected .mpin .mpin__shape path { fill: var(--primary); stroke: var(--canvas); stroke-width: 3; }
.is-selected .mpin .mpin__shape { filter: drop-shadow(0 6px 10px color-mix(in srgb, var(--primary) 45%, transparent)); }
.is-selected .mpin .mpin__shape circle { fill: var(--canvas); }
/* The day sits in the round head, whose centre is 47/128 of the way down. */
.mpin__day { position: absolute; left: 0; right: 0; top: 36.7%; transform: translateY(-50%); color: var(--ink); font: var(--text-badge); font-weight: 700; line-height: 1; text-align: center; white-space: nowrap; }
.mpin__shadow { position: absolute; left: 50%; bottom: -3px; z-index: -1; width: 22px; height: 6px; border-radius: 50%; background: color-mix(in srgb, var(--ink) 22%, transparent); transform: translateX(-50%); filter: blur(2px); }
/* Only the selected pin bobs, as the main button does: it rises and its shadow shrinks. */
.is-selected .mpin .mpin__bob { animation: meetup-pin-bob 2.8s ease-in-out infinite; }
.is-selected .mpin .mpin__shadow { animation: meetup-pin-bob-shadow 2.8s ease-in-out infinite; }
@keyframes meetup-pin-bob { 50% { transform: translateY(-10px); } }
@keyframes meetup-pin-bob-shadow { 50% { transform: translateX(-50%) scale(0.75); opacity: 0.55; } }
@media (hover: hover) {
  .mwrap:not(.is-selected) .mpin:hover .mpin__body { transform: translateY(-3px) scale(1.06); }
}
.mwrap:not(.is-selected) .mpin:active .mpin__body { transform: scale(0.96); }

/* The card: white, flat with the float shadow, a small caret toward the pin. Its side and place come from placeCard. */
.mcard { position: absolute; z-index: 1; width: 264px; max-width: calc(100vw - 16px); padding: var(--spacing-md) var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); color: var(--ink); text-align: left; pointer-events: auto; }
.mcard::before { content: ""; position: absolute; width: 10px; height: 10px; border: 1px solid var(--hairline); background: var(--canvas); transform: rotate(45deg); }
.mcard[data-side="above"]::before { bottom: -6px; left: calc(var(--caret) - 5px); border-top-color: transparent; border-left-color: transparent; }
.mcard[data-side="below"]::before { top: -6px; left: calc(var(--caret) - 5px); border-right-color: transparent; border-bottom-color: transparent; }
.mcard[data-side="right"]::before { left: -6px; top: calc(var(--caret) - 5px); border-top-color: transparent; border-right-color: transparent; }
.mcard[data-side="left"]::before { right: -6px; top: calc(var(--caret) - 5px); border-left-color: transparent; border-bottom-color: transparent; }
/* In: a short fade and a 5px rise. Out: a quicker fade. */
.mcard-enter-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
.mcard-leave-active { transition: opacity 100ms var(--ease-out); }
.mcard-enter-from { opacity: 0; transform: translateY(5px); }
.mcard-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .mcard-enter-active, .mcard-leave-active { transition: none; }
  .mpin__body, .mpin__shape path { transition: none; }
  .is-selected .mpin .mpin__bob, .is-selected .mpin .mpin__shadow { animation: none; }
}
</style>
