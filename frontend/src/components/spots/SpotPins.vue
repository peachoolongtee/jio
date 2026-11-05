<script setup>
// Real, focusable pins laid over the Locate screen's map, one per meeting spot, each with a small card of the spot's
// details that opens AT the pin. The same pins and card as Home's (MeetupPins), on a Leaflet map.
//   <PlannerMap ref="map" ... @view="pins.refresh()" />
//   <SpotPins ref="pins" :spots="spots" :session="session" :selected-id="shown" :project="(lat, lng) => map.project(lat, lng)"
//             :names="nameOf" my-id="ian" confirmed-id="bugis" @select="picked = $event" />
// Give it the same box as the map (it fills its parent, which must be positioned). Call refresh() whenever the map moves
// (PlannerMap's `view` event): a pin is placed from the map's own projection, so it stays on its area.
// spots: the session's spots as the screen lists them (spotsToShow). session: the session summary; with it the card has
// "Vote" while the group is choosing (SpotCard), without it the card only reads. project: (lat, lng) => { x, y } in px from the map's top-left, or null before the map exists.
// Each pin is a button with the spot's number in its head (the number on its row) and a name a screen reader can say.
// The selected pin is larger, filled red with a white head, and bobs; a click or Enter selects it (so does a row).
// The card (one at a time, never changes the selection):
//   a mouse      hover for 120 ms; stays while the pointer is on the pin or the card; closes 150 ms after leaving
//   a keyboard   focus on the pin (a mouse click does not count); Escape closes it and keeps focus on the pin
//   a touch      a tap selects the pin and opens its card; a tap elsewhere or on another pin closes or moves it
// It sits above the pin (below or beside when there is no room) and slides to stay in the map's box; on a phone, where the map
// is too short for it, it is pulled into the map and may cover its pin, since the map clips anything outside it (lib/homeMeetups.js placeCard), and is placed again when its own size changes (lib/sizeWatch.js). It is not a dialog: no backdrop, no focus trap. Its "Vote" sits
// inside the pin's wrapper, so pressing it neither closes a card a tap opened nor lets a hovered or focused one fade.
// Only areas are shown, never a member's exact place.
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useId, watch } from 'vue'
import { barHeights } from '@/lib/bars.js'
import { placeCard } from '@/lib/homeMeetups.js'
import { sizeWatch } from '@/lib/sizeWatch.js'
import SpotCard from './SpotCard.vue'
import { pinName } from './spotText.js'

const props = defineProps({
  spots: { type: Array, default: () => [] },
  // The session summary (lib/api.js), for the card's "Vote"; null leaves the card with no control.
  session: { type: Object, default: null },
  selectedId: { type: String, default: '' },
  project: { type: Function, required: true },
  // (id) => name, for the card.
  names: { type: Function, default: (id) => id },
  myId: { type: String, default: '' },
  // The area the host confirmed, or '': its pin and card say so.
  confirmedId: { type: String, default: '' },
  // The signed-in person is the host: the card also has "Confirm <area>" (SpotCard).
  isHost: { type: Boolean, default: false },
})
const emit = defineEmits(['select'])

const OPEN_DELAY = 120 // ms of hovering before the card opens, so crossing the map does not flicker
const CLOSE_DELAY = 150 // ms after leaving the pin and the card before it closes
const MARGIN = 8 // px the card keeps from the edge of the box
// How far a drawn pin reaches above its tip (the selected one is bigger and bobs) and to each side, in px.
const REACH = { selected: 90, rest: 70, halfWidth: 30 }

const uid = `spot-pins-${useId()}`
const layer = ref(null)
const cardId = (areaId) => `${uid}-card-${areaId}`

// Where each pin goes. `version` changes whenever the map moves, so the projection is asked again.
const version = ref(0)
let frame = 0
// Ask for the pins' places again at the next frame, however many times the map said it moved.
// How to call: refresh()
function refresh() {
  if (frame) return
  frame = requestAnimationFrame(() => {
    frame = 0
    version.value += 1
  })
}
const placed = computed(() => {
  void version.value
  return props.spots.flatMap((spot, i) => {
    const point = props.project(spot.area.lat, spot.area.lng)
    return point && Number.isFinite(point.x) && Number.isFinite(point.y) ? [{ spot, number: i + 1, style: { left: `${point.x}px`, top: `${point.y}px` } }] : []
  })
})
// A spot that is added or removed changes the pins before the map says anything.
watch(() => props.spots.map((s) => s.areaId).join(), refresh)
defineExpose({ refresh })

// ── The card ──
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
// Close the open card at once and forget what was holding it open.
// How to call: hide()
function hide() {
  clearTimers()
  openId.value = ''
  hoverId = focusId = tapId = ''
}
// Close the open card shortly, unless the pointer, focus or a tap still holds it.
// How to call: settle()
function settle() {
  clearTimeout(closeTimer)
  closeTimer = setTimeout(() => {
    const id = openId.value
    if (id && hoverId !== id && focusId !== id && tapId !== id) openId.value = ''
  }, CLOSE_DELAY)
}
// How to call: @pointerenter="onEnter(spot.areaId, $event)"
function onEnter(id, event) {
  if (event.pointerType !== 'mouse') return
  hoverId = id
  if (openId.value === id) return clearTimeout(closeTimer)
  clearTimeout(openTimer)
  openTimer = setTimeout(() => { if (hoverId === id) openId.value = id }, OPEN_DELAY)
}
// The pointer left a pin or its card: close the card shortly, unless something else holds it.
// How to call: @pointerleave="onLeave(spot.areaId, $event)"
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
// Focus left the pin and its card (moving between the two does not count): close the card shortly.
// How to call: @focusout="onFocusOut(spot.areaId, $event)"
function onFocusOut(id, event) {
  if (event.currentTarget.contains(event.relatedTarget)) return
  if (focusId === id) focusId = ''
  settle()
}
// Escape closes the open card and keeps focus on the pin.
// How to call: @keydown="onKeydown"
function onKeydown(event) {
  if (event.key !== 'Escape' || !openId.value) return
  hide()
  // Back to the pin without reopening the card that focus would otherwise open.
  quiet = true
  event.currentTarget.querySelector('.spin')?.focus({ preventScroll: true })
  quiet = false
}
// A click selects. A tap (or any click where nothing hovers) also opens, moves or closes the card.
function onPinClick(areaId, event) {
  emit('select', areaId)
  const touch = event.pointerType === 'touch' || event.pointerType === 'pen' || !canHover()
  if (!touch) return
  const closing = openId.value === areaId && tapId === areaId
  hide()
  if (!closing) {
    tapId = areaId
    openId.value = areaId
  }
}
// A press anywhere that is not a pin closes a card a tap opened.
// How to call: document.addEventListener('pointerdown', onOutside)
function onOutside(event) {
  if (tapId && !event.target.closest?.('.swrap')) hide()
}

// The box the card may use: the map's, less the bars, in viewport px. The map's frame clips what spills out of it, so the card
// never borrows the rest of the screen: on a phone, where the map is too short for the card above or below a pin, it is pulled
// into the map's box and may cover its pin rather than be cut off (lib/homeMeetups.js placeCard, "nowhere fits").
// The screen's sticky footer (Locate's Confirm) counts as a bar too, so the card's own buttons are never under it.
// How to call: boxes() -> { map: { left, right, top, bottom } }
function boxes() {
  const area = layer.value.getBoundingClientRect()
  const bars = barHeights()
  const left = Math.max(area.left, 0) + MARGIN
  const right = Math.min(area.right, document.documentElement.clientWidth) - MARGIN
  const top = bars.top + MARGIN
  const footer = layer.value.closest('.screen')?.querySelector(':scope > .screen__footer')?.getBoundingClientRect()
  const floor = footer && footer.height > 0 && footer.top < window.innerHeight ? footer.top : window.innerHeight - bars.bottom
  const bottom = floor - MARGIN
  return { map: { left, right, top: Math.max(area.top, top), bottom: Math.min(area.bottom, bottom) } }
}
// Measure the card once it is in the page and put it by its pin. The wrapper has no size: its corner is the pin's tip.
let placedFor = ''
// The open card's size is watched, so a new error line or a changed "works for" count places it again and it never runs past the
// map's edge. The same card placed again keeps showing while it moves.
const resized = sizeWatch(() => place(openId.value))
// When the part of the map in view is too short for a card a tap opened (the page was scrolled so the map sits under the footer or
// off the top), the map is brought into view first, once, and the card is placed again. A hovered card never scrolls the page.
// How to call: await place('bugis') (or place('') to clear)
async function place(id, scrolled = false) {
  // The same card placed again (its pin was selected and grew) keeps showing while it moves; a new one starts hidden.
  if (id !== placedFor) placement.value = null
  placedFor = id
  if (!id) return resized.stop()
  await nextTick()
  const card = layer.value?.querySelector(`[id="${cardId(id)}"]`)
  const anchor = card?.parentElement
  if (!anchor) return
  resized.watch(card)
  const tip = { x: anchor.getBoundingClientRect().x, y: anchor.getBoundingClientRect().y }
  const { map } = boxes()
  const reach = id === props.selectedId ? REACH.selected : REACH.rest
  const spot = placeCard({ tip, pin: { height: reach, halfWidth: REACH.halfWidth }, size: { w: card.offsetWidth, h: card.offsetHeight }, bounds: map })
  const frame = layer.value?.closest('.split__map') || layer.value
  if (!spot.inside && !scrolled && tapId === id && frame?.scrollIntoView) {
    frame.scrollIntoView({ block: 'center', behavior: 'instant' })
    await new Promise((resolve) => requestAnimationFrame(resolve))
    return place(id, true)
  }
  placement.value = { side: spot.side, left: spot.left - tip.x, top: spot.top - tip.y, caret: spot.caret }
}
// Again when the pin's selection changes (a selected pin is bigger, so its card must clear it) or the map moves under it.
watch([openId, () => props.selectedId, version], () => place(openId.value))
// A pin that goes away takes its card with it.
watch(placed, (list) => { if (openId.value && !list.some((p) => p.spot.areaId === openId.value)) hide() })
const cardStyle = computed(() => (placement.value ? { left: `${placement.value.left}px`, top: `${placement.value.top}px`, '--caret': `${placement.value.caret}px` } : { visibility: 'hidden' }))

onMounted(() => {
  document.addEventListener('pointerdown', onOutside)
  window.addEventListener('resize', hide)
  refresh()
})
onBeforeUnmount(() => {
  clearTimers()
  resized.stop()
  cancelAnimationFrame(frame)
  document.removeEventListener('pointerdown', onOutside)
  window.removeEventListener('resize', hide)
})
</script>

<template>
  <div ref="layer" class="spins" role="group" aria-label="Meeting spots on the map">
    <!-- Each wrapper is a point (the pin's tip) that holds the pin and, while open, its card, so the card follows the pin in the tab order. -->
    <div
      v-for="pin in placed"
      :key="pin.spot.areaId"
      class="swrap"
      :class="{ 'is-selected': pin.spot.areaId === selectedId, 'is-open': pin.spot.areaId === openId }"
      :style="pin.style"
      @pointerenter="onEnter(pin.spot.areaId, $event)"
      @pointerleave="onLeave(pin.spot.areaId, $event)"
      @focusin="onFocusIn(pin.spot.areaId, $event)"
      @focusout="onFocusOut(pin.spot.areaId, $event)"
      @keydown="onKeydown"
    >
      <button
        type="button"
        class="spin"
        :aria-label="pinName(pin.spot, pin.number, myId, pin.spot.areaId === confirmedId)"
        :aria-pressed="pin.spot.areaId === selectedId"
        :aria-describedby="pin.spot.areaId === openId ? cardId(pin.spot.areaId) : undefined"
        @click="onPinClick(pin.spot.areaId, $event)"
      >
        <span class="spin__body">
          <span class="spin__bob">
            <svg class="spin__shape" viewBox="0 0 100 128" aria-hidden="true" focusable="false">
              <path d="M50 125C50 125 5 77 5 47a45 45 0 0 1 90 0c0 30-45 78-45 78Z" />
              <circle cx="50" cy="47" r="36" />
            </svg>
            <span class="spin__num tnum" aria-hidden="true">{{ pin.number }}</span>
          </span>
        </span>
        <span class="spin__shadow" aria-hidden="true" />
      </button>
      <Transition name="scard">
        <div v-if="pin.spot.areaId === openId" :id="cardId(pin.spot.areaId)" class="scard" :data-side="placement?.side" :style="cardStyle">
          <SpotCard :spot="pin.spot" :session="session" :my-id="myId" :confirmed="pin.spot.areaId === confirmedId" :is-host="isHost" :names="names" />
        </div>
      </Transition>
    </div>
  </div>
</template>

<style scoped>
/* Fills the map's box; only the pins and the open card take the pointer, so the map still pans and zooms under it. */
.spins { position: absolute; inset: 0; z-index: 5; pointer-events: none; }
/* A point at the pin's tip. The pin and its card are placed from it. */
.swrap { position: absolute; z-index: 1; width: 0; height: 0; }
.swrap.is-selected { z-index: 3; }
.swrap:focus-within { z-index: 2; }
.swrap.is-selected:focus-within { z-index: 3; }
/* An open card is above every pin. */
.swrap.is-open, .swrap.is-open:focus-within { z-index: 6; }
.spin {
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
.spin__body { position: relative; display: block; width: 100%; height: 100%; transform-origin: 50% 100%; transition: transform var(--motion-fast) var(--ease-spring); }
.is-selected .spin .spin__body { transform: scale(1.2); }
.spin__bob { position: relative; display: block; width: 100%; height: 100%; }
.spin__shape { position: absolute; inset: 0; width: 100%; height: 100%; overflow: visible; }
/* At rest: a white pin with an ink line and a pale head. */
.spin__shape path { fill: var(--canvas); stroke: var(--ink); stroke-width: 5; transition: fill var(--motion-fast) var(--ease-out); }
.spin__shape circle { fill: var(--surface-strong); }
/* Selected: the red pin, as on Home, with a white head for the number. */
.is-selected .spin .spin__shape path { fill: var(--primary); stroke: var(--canvas); stroke-width: 3; }
.is-selected .spin .spin__shape { filter: drop-shadow(0 6px 10px color-mix(in srgb, var(--primary) 45%, transparent)); }
.is-selected .spin .spin__shape circle { fill: var(--canvas); }
/* The number sits in the round head, whose centre is 47/128 of the way down. */
.spin__num { position: absolute; left: 0; right: 0; top: 36.7%; transform: translateY(-50%); color: var(--ink); font: var(--text-badge); font-weight: 700; line-height: 1; text-align: center; }
.spin__shadow { position: absolute; left: 50%; bottom: -3px; z-index: -1; width: 22px; height: 6px; border-radius: 50%; background: color-mix(in srgb, var(--ink) 22%, transparent); transform: translateX(-50%); filter: blur(2px); }
/* Only the selected pin bobs: it rises and its shadow shrinks. */
.is-selected .spin .spin__bob { animation: spot-pin-bob 2.8s ease-in-out infinite; }
.is-selected .spin .spin__shadow { animation: spot-pin-bob-shadow 2.8s ease-in-out infinite; }
@keyframes spot-pin-bob { 50% { transform: translateY(-10px); } }
@keyframes spot-pin-bob-shadow { 50% { transform: translateX(-50%) scale(0.75); opacity: 0.55; } }
@media (hover: hover) {
  .swrap:not(.is-selected) .spin:hover .spin__body { transform: translateY(-3px) scale(1.06); }
}
.swrap:not(.is-selected) .spin:active .spin__body { transform: scale(0.96); }

/* The card: white, flat with the float shadow, a small caret toward the pin. Its side and place come from placeCard. */
.scard { position: absolute; z-index: 1; display: flex; flex-direction: column; gap: var(--spacing-xs); width: 264px; max-width: calc(100vw - 16px); padding: var(--spacing-md) var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); color: var(--ink); text-align: left; pointer-events: auto; }
.scard::before { content: ""; position: absolute; width: 10px; height: 10px; border: 1px solid var(--hairline); background: var(--canvas); transform: rotate(45deg); }
.scard[data-side="above"]::before { bottom: -6px; left: calc(var(--caret) - 5px); border-top-color: transparent; border-left-color: transparent; }
.scard[data-side="below"]::before { top: -6px; left: calc(var(--caret) - 5px); border-right-color: transparent; border-bottom-color: transparent; }
.scard[data-side="right"]::before { left: -6px; top: calc(var(--caret) - 5px); border-top-color: transparent; border-right-color: transparent; }
.scard[data-side="left"]::before { right: -6px; top: calc(var(--caret) - 5px); border-left-color: transparent; border-bottom-color: transparent; }
/* In: a short fade and a 5px rise. Out: a quicker fade. */
.scard-enter-active { transition: opacity 160ms var(--ease-out), transform 160ms var(--ease-out); }
.scard-leave-active { transition: opacity 100ms var(--ease-out); }
.scard-enter-from { opacity: 0; transform: translateY(5px); }
.scard-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .scard-enter-active, .scard-leave-active { transition: none; }
  .spin__body, .spin__shape path { transition: none; }
  .is-selected .spin .spin__bob, .is-selected .spin .spin__shadow { animation: none; }
}
</style>
