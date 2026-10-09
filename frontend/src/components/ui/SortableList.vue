<script setup>
// A list whose items can be rearranged by dragging a handle, or with the keyboard.
//   <SortableList :items="stops" :item-key="(s) => s.id" :item-label="(s) => s.name" label="Stops" @move="(from, to) => ...">
//     <template #item="{ item, index, dragging, handle }">
//       ... <button v-bind="handle" class="my-handle"><AppIcon name="grip" /></button>
//     </template>
//   </SortableList>
// Pointer: press and drag the handle (mouse, pen or touch). The other items slide out of the way; drop to place.
// Keyboard: focus the handle and press the up or down arrow to move the item one place. Escape cancels a drag.
// While it can be rearranged (not `disabled`, two items or more) a short hint above the list says how; pass `hint=""`
// to leave it out, or your own words to replace it. Each handle's name also says how, for screen readers.
// `dragging` is true while any item is being dragged, so the parent can hide things between items.
// Positions are written straight to each element's transform while dragging, not through reactive state.
import { nextTick, onBeforeUpdate, ref } from 'vue'

const props = defineProps({
  items: { type: Array, required: true },
  itemKey: { type: Function, required: true },
  itemLabel: { type: Function, default: (item) => String(item) },
  label: { type: String, required: true },
  disabled: { type: Boolean, default: false },
  hint: { type: String, default: 'Drag the grip to reorder, or focus it and press the up or down arrow key.' },
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

function announce(index, to) {
  announcement.value = `${props.itemLabel(props.items[index])} moved to position ${to + 1} of ${props.items.length}.`
}

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
  dragging.value = index
  // Let the parent hide anything between items before measuring.
  await nextTick()
  const rects = els.map((el) => el.getBoundingClientRect())
  const gap = rects.length > 1 ? Math.max(0, rects[1].top - rects[0].bottom) : 0
  drag = { from: index, target: index, startY: event.clientY, rects, gap, handle, pointerId: event.pointerId }
  els[index]?.classList.add('is-dragging')
}

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
  if (handle.hasPointerCapture?.(pointerId)) handle.releasePointerCapture(pointerId)
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
  <p v-if="hint && !disabled && items.length > 1" class="sortable__hint caption-sm text-muted">{{ hint }}</p>
  <ol ref="list" class="sortable" :class="{ 'is-sorting': dragging >= 0 }" :aria-label="label">
    <li v-for="(item, i) in items" :key="itemKey(item)" :ref="(el) => setEl(el, i)" class="sortable__item">
      <slot name="item" :item="item" :index="i" :dragging="dragging >= 0" :lifted="dragging === i" :handle="handleProps(i)" />
    </li>
  </ol>
  <p class="sr-only" aria-live="polite">{{ announcement }}</p>
</template>

<style scoped>
.sortable__hint { margin-bottom: var(--spacing-sm); }
.sortable { position: relative; display: flex; flex-direction: column; }
.sortable__item { position: relative; }
.sortable.is-sorting .sortable__item { transition: transform var(--motion-fast) var(--ease-out); user-select: none; }
/* The dragged card floats: the one shadow tier, above its neighbours, following the pointer exactly. */
.sortable .sortable__item.is-dragging { z-index: 2; margin-inline: calc(var(--spacing-sm) * -1); padding-inline: var(--spacing-sm); transition: none; border-radius: var(--rounded-sm); background: var(--canvas); box-shadow: var(--shadow-float); }
@media (prefers-reduced-motion: reduce) { .sortable.is-sorting .sortable__item { transition: none; } }
</style>
