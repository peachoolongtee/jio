<script setup>
// A list whose items can be rearranged by dragging a handle, or with the keyboard.
//   <SortableList :items="stops" :item-key="(s) => s.id" :item-label="(s) => s.name" label="Stops" @move="(from, to) => ...">
//     <template #item="{ item, index, dragging, handle }">
//       ... <button v-bind="handle" class="my-handle"><AppIcon name="grip" /></button>
//     </template>
//   </SortableList>
// Pointer: press and drag the handle (mouse, pen or touch). The other items slide out of the way; drop to place.
// With `whole-item` the whole item drags too, not only its handle: a mouse or pen drags once it moves a few pixels, and a finger
// after a short press and hold, so a swipe still scrolls the page. A press on a button, link or field inside the item is left alone.
// Keyboard: focus the handle and press the up or down arrow to move the item one place. Escape cancels a drag.
// While it can be rearranged (not `disabled`, two items or more) a short hint above the list says how; pass `hint=""`
// to leave it out, or your own words to replace it. Each handle's name also says how, for screen readers.
// `dragging` is true while any item is being dragged, so the parent can hide things between items.
// Positions are written straight to each element's transform while dragging, not through reactive state.
import { computed, nextTick, onBeforeUnmount, onBeforeUpdate, ref, watch } from 'vue'

const props = defineProps({
  items: { type: Array, required: true },
  itemKey: { type: Function, required: true },
  itemLabel: { type: Function, default: (item) => String(item) },
  label: { type: String, required: true },
  disabled: { type: Boolean, default: false },
  wholeItem: { type: Boolean, default: false },
  hint: { type: String, default: '' },
})
// Whether the main pointer is a finger, so the hint speaks of pressing and holding instead of keys a phone does not have (a phone
// check of 3 November 2026). Read once: a screen that changes between touch and mouse mid-page is rare.
const touch = typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches
// The hint shown when none is passed: it names what can be dragged, and how, for a finger or for a mouse and keyboard.
const hintText = computed(() => {
  if (props.hint) return props.hint
  if (touch) return props.wholeItem ? 'Press and hold a stop, then drag it up or down to reorder.' : 'Press and hold the grip, then drag it up or down to reorder.'
  return props.wholeItem ? 'Drag a stop to reorder, or focus its grip and press the up or down arrow key.' : 'Drag the grip to reorder, or focus it and press the up or down arrow key.'
})
const emit = defineEmits(['move'])

const list = ref(null)
const dragging = ref(-1)
const announcement = ref('')
let els = []
let drag = null

onBeforeUpdate(() => {
  els = []
})

function setEl(el, i) {
  if (el) els[i] = el
}

// The words about a move are true for a moment: they are read out, then they go, and at once when the list gains or loses an item (a stop
// added, deleted or finished elsewhere), so no old position or count is left on the page.
let clearTimer = 0
const ANNOUNCEMENT_MS = 4000
function announce(index, to) {
  announcement.value = `${props.itemLabel(props.items[index])} moved to position ${to + 1} of ${props.items.length}.`
  clearTimeout(clearTimer)
  clearTimer = setTimeout(() => {
    announcement.value = ''
  }, ANNOUNCEMENT_MS)
}
watch(() => props.items.length, () => {
  clearTimeout(clearTimer)
  announcement.value = ''
})
onBeforeUnmount(() => clearTimeout(clearTimer))

async function onPointerDown(event, index) {
  if (props.disabled || event.button !== 0 || drag) return
  event.preventDefault()
  const handle = event.currentTarget
  // Keep receiving the pointer's moves even when it leaves the handle.
  try {
    handle.setPointerCapture(event.pointerId)
  } catch {
    // The pointer is already gone (or the browser has no pointer capture); moves on the handle still work.
  }
  await begin(index, event.clientY, event.pointerId, handle)
}

// Lift an item: measure every item, then follow the pointer. `handle` is the element holding the pointer, or null when the window's
// listeners follow it (a whole-item drag). How to call: await begin(2, event.clientY, event.pointerId, handle)
async function begin(index, startY, pointerId, handle) {
  dragging.value = index
  // Let the parent hide anything between items before measuring.
  await nextTick()
  const rects = els.map((el) => el.getBoundingClientRect())
  const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0
  drag = { from: index, target: index, startY, rects, gap, handle, pointerId }
  els[index]?.classList.add('is-dragging')
}

// ── Dragging the whole item ──
// A press on the item waits to see what it is: a mouse that moves a few pixels, or a finger that holds still for a moment, lifts the item;
// anything else (a click, a swipe that scrolls) is left to the browser.
const MOVE_PX = 6
const HOLD_MS = 350
let pending = null
// A click that ends a drag is not a click on whatever is under the pointer.
let swallowClick = false

// How to call: onItemPointerDown(event, 1) (from the item's pointerdown)
function onItemPointerDown(event, index) {
  if (!props.wholeItem || props.disabled || event.button !== 0 || drag || pending) return
  if (event.target.closest?.('button, a, input, select, textarea, label, [role=button], [role=radio], [role=switch]')) return
  const touch = event.pointerType === 'touch'
  pending = { index, x: event.clientX, y: event.clientY, pointerId: event.pointerId, touch, timer: 0 }
  if (touch) pending.timer = setTimeout(() => lift(pending.y), HOLD_MS)
  window.addEventListener('pointermove', onWindowMove)
  window.addEventListener('pointerup', onWindowUp)
  window.addEventListener('pointercancel', onWindowCancel)
}
// How to call: lift(event.clientY)
function lift(y) {
  if (!pending) return
  const { index, pointerId, touch } = pending
  clearTimeout(pending.timer)
  pending = null
  // A finger that is now dragging must not scroll the page under it.
  if (touch) window.addEventListener('touchmove', holdScroll, { passive: false })
  begin(index, y, pointerId, null)
}
function holdScroll(event) {
  if (drag || dragging.value >= 0) event.preventDefault()
}
function onWindowMove(event) {
  if (pending && event.pointerId === pending.pointerId) {
    const moved = Math.hypot(event.clientX - pending.x, event.clientY - pending.y)
    // A finger that moves before the hold is a scroll; a mouse that moves far enough is a drag.
    if (pending.touch) {
      if (moved > MOVE_PX) stopWatching()
    } else if (moved > MOVE_PX) {
      lift(pending.y)
    }
    return
  }
  onPointerMove(event)
}
function onWindowUp() {
  const wasDragging = !!drag
  stopWatching()
  if (wasDragging) {
    swallowClick = true
    setTimeout(() => { swallowClick = false }, 0)
    finish(true)
  }
}
function onWindowCancel() {
  stopWatching()
  finish(false)
}
// How to call: stopWatching() (ends a press that never became a drag, and a whole-item drag's listeners)
function stopWatching() {
  if (pending) clearTimeout(pending.timer)
  pending = null
  window.removeEventListener('pointermove', onWindowMove)
  window.removeEventListener('pointerup', onWindowUp)
  window.removeEventListener('pointercancel', onWindowCancel)
  window.removeEventListener('touchmove', holdScroll)
}
function onItemClick(event) {
  if (!swallowClick) return
  event.preventDefault()
  event.stopPropagation()
}
onBeforeUnmount(stopWatching)

function onPointerMove(event) {
  if (!drag || event.pointerId !== drag.pointerId) return
  const { from, rects, gap } = drag
  const dy = event.clientY - drag.startY
  const self = rects[from]
  els[from].style.transform = `translateY(${dy}px)`
  // Where the dragged item's middle now sits, compared with the middle of each other item.
  const middle = self.top + self.height / 2 + dy
  let target = from
  rects.forEach((r, i) => {
    const m = r.top + r.height / 2
    if (i < from && middle < m) target = Math.min(target, i)
    if (i > from && middle > m) target = Math.max(target, i)
  })
  const shift = self.height + gap
  els.forEach((el, i) => {
    if (i === from) return
    let offset = 0
    if (from < target && i > from && i <= target) offset = -shift
    if (target < from && i >= target && i < from) offset = shift
    el.style.transform = offset ? `translateY(${offset}px)` : ''
  })
  drag.target = target
}

function finish(commit) {
  if (!drag) {
    dragging.value = -1
    return
  }
  const { from, target, handle, pointerId } = drag
  drag = null
  if (handle?.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
  // Snap, don't slide: the list re-renders in its new order in the same frame.
  list.value?.classList.remove('is-sorting')
  els.forEach((el) => {
    el.style.transform = ''
    el.classList.remove('is-dragging')
  })
  dragging.value = -1
  if (commit && target !== from) {
    emit('move', from, target)
    announce(from, target)
  }
}

async function onKeydown(event, index) {
  if (event.key === 'Escape' && drag) {
    finish(false)
    return
  }
  const to = event.key === 'ArrowUp' ? index - 1 : event.key === 'ArrowDown' ? index + 1 : null
  if (to == null || props.disabled) return
  event.preventDefault()
  if (to < 0 || to >= props.items.length) return
  emit('move', index, to)
  announce(index, to)
  // Keep focus on the moved item's handle in its new place.
  await nextTick()
  list.value?.querySelectorAll('[data-sortable-handle]')[to]?.focus()
}

// What the parent binds to its handle element.
function handleProps(index) {
  return {
    'data-sortable-handle': '',
    type: 'button',
    'aria-label': `Move ${props.itemLabel(props.items[index])}. Use the up and down arrow keys.`,
    'aria-keyshortcuts': 'ArrowUp ArrowDown',
    title: 'Drag, or use the up and down arrow keys',
    onPointerdown: (e) => onPointerDown(e, index),
    onPointermove: onPointerMove,
    onPointerup: () => finish(true),
    onPointercancel: () => finish(false),
    onLostpointercapture: () => finish(true),
    onKeydown: (e) => onKeydown(e, index),
  }
}
</script>

<template>
  <p v-if="hintText && !disabled && items.length > 1" class="sortable__hint sr-only">{{ hintText }}</p>
  <ol ref="list" class="sortable" :class="{ 'is-sorting': dragging >= 0, 'sortable--whole': wholeItem && !disabled && items.length > 1 }" :aria-label="label">
    <li v-for="(item, i) in items" :key="itemKey(item)" :ref="(el) => setEl(el, i)" class="sortable__item" @pointerdown="onItemPointerDown($event, i)" @click.capture="onItemClick">
      <slot name="item" :item="item" :index="i" :dragging="dragging >= 0" :lifted="dragging === i" :handle="handleProps(i)" />
    </li>
  </ol>
  <p class="sr-only" aria-live="polite">{{ announcement }}</p>
</template>

<style scoped>
.sortable__hint { margin-bottom: var(--spacing-sm); }
.sortable { position: relative; display: flex; flex-direction: column; }
.sortable__item { position: relative; }
/* A whole item drags: it says so to a mouse, and a press and hold on a phone opens no menu and selects no text. */
.sortable--whole .sortable__item { cursor: grab; user-select: none; -webkit-user-select: none; -webkit-touch-callout: none; }
.sortable--whole.is-sorting .sortable__item { cursor: grabbing; }
.sortable.is-sorting .sortable__item { transition: transform var(--motion-fast) var(--ease-out); user-select: none; }
/* The dragged card floats: the one shadow tier, above its neighbours, following the pointer exactly. */
.sortable .sortable__item.is-dragging { z-index: 2; margin-inline: calc(var(--spacing-sm) * -1); padding-inline: var(--spacing-sm); transition: none; border-radius: var(--rounded-sm); background: var(--canvas); box-shadow: var(--shadow-float); }
@media (prefers-reduced-motion: reduce) { .sortable.is-sorting .sortable__item { transition: none; } }
</style>
