<script setup>
// The photo viewer: a full-screen, swipeable carousel of a session's photos, like a social app.
//   <PhotoViewer ref="viewer" v-model:index="viewing" :photos="photos" :origin="tileImage" :place="placeOf"
//                :can-delete="(p) => p.personId === 'ian'" @delete="remove" />
//   viewer.value.open(3)   opens on the fourth photo, growing it out of its tile in the gallery
// `index` is the open photo, or -1 when closed. Setting it directly opens with a plain fade.
//
// Gestures:
//   - Swipe or drag sideways: the photo follows the finger. A short, slow drag springs back; a long one or a
//     quick flick moves on, finishing at the speed of the flick. Past the first or last photo it pulls like elastic.
//   - Drag down to close. Tap the photo to hide or show the controls; tap the space around it to close.
//   - Desktop: previous and next buttons, the arrow keys, and Escape.
// While dragging, positions go straight to CSS variables on the elements, never through Vue state.
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import IconButton from './IconButton.vue'
import UserAvatar from './UserAvatar.vue'
import { canViewTransition, withViewTransition } from '@/lib/viewTransition.js'

const index = defineModel('index', { type: Number, default: -1 })
const props = defineProps({
  photos: { type: Array, required: true },
  canDelete: { type: Function, default: () => false },
  // (index) => the gallery <img> of that photo, so the viewer can grow out of it and shrink back into it.
  origin: { type: Function, default: () => null },
  // (photo) => where it was taken, for example the stop on the itinerary at that time. Optional.
  place: { type: Function, default: () => '' },
})
const emit = defineEmits(['delete'])

// A drag further than this share of the screen, or a flick faster than this (px per ms) and at least
// FLICK_MIN px long, moves on. Speed is measured over the last FLICK_WINDOW ms, and is zero after a pause.
const SWIPE_DISTANCE = 0.2
const SWIPE_SPEED = 0.45
const FLICK_MIN = 24
const FLICK_WINDOW = 100
// Dragging down further than this (px), or flicking down, closes.
const CLOSE_DISTANCE = 120
const SLIDE_MS = 420

const root = ref(null)
const stage = ref(null)
const track = ref(null)
const chrome = ref(true)
// While a view transition grows the photo open or shrinks it closed, the plain fade is off,
// and `hero` is the slide whose photo carries the shared name.
const morphing = ref(false)
const hero = ref(-1)
let opener = null
let drag = null

const isOpen = computed(() => index.value >= 0 && index.value < props.photos.length)
const photo = computed(() => props.photos[index.value] || null)
const last = computed(() => props.photos.length - 1)
const where = computed(() => (photo.value ? props.place(photo.value) : ''))
const time = (at) => new Date(at).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false })
const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n))

function inView(el) {
  const r = el.getBoundingClientRect()
  return r.bottom > 0 && r.top < window.innerHeight && r.width > 0
}

async function open(i) {
  if (i < 0 || i >= props.photos.length || isOpen.value) return
  opener = document.activeElement
  const from = props.origin(i)
  if (!from || !canViewTransition() || !inView(from)) {
    index.value = i
    return
  }
  morphing.value = true
  from.style.viewTransitionName = 'photo-hero'
  await withViewTransition(() => {
    from.style.viewTransitionName = ''
    hero.value = i
    index.value = i
  })
  hero.value = -1
  morphing.value = false
}

async function close() {
  if (!isOpen.value || morphing.value) return
  const i = index.value
  const to = props.origin(i)
  if (!to || !canViewTransition() || !inView(to)) {
    index.value = -1
    return
  }
  morphing.value = true
  hero.value = i
  await nextTick()
  await withViewTransition(() => {
    hero.value = -1
    to.style.viewTransitionName = 'photo-hero'
    index.value = -1
  })
  to.style.viewTransitionName = ''
  morphing.value = false
}

defineExpose({ open, close })

// Moves one photo along. At either end the photo bumps and settles instead.
function go(step) {
  const next = clamp(index.value + step, 0, last.value)
  const el = track.value
  if (!el) return
  if (next === index.value) {
    el.style.setProperty('--slide-ms', '180ms')
    el.style.setProperty('--dx', `${-step * 28}px`)
    setTimeout(() => el.style.setProperty('--dx', '0px'), 180)
    return
  }
  el.style.setProperty('--slide-ms', `${SLIDE_MS}ms`)
  index.value = next
}

// Open: lock the page behind, show the controls, take focus. Closed: give everything back.
watch(isOpen, async (now) => {
  if (now) {
    opener ??= document.activeElement
    document.documentElement.style.overflow = 'hidden'
    chrome.value = true
    await nextTick()
    root.value?.focus({ preventScroll: true })
  } else {
    document.documentElement.style.overflow = ''
    opener?.focus?.({ preventScroll: true })
    opener = null
  }
})
onBeforeUnmount(() => {
  document.documentElement.style.overflow = ''
})

// When someone posts or deletes a photo while the viewer is open, stay on the same photo.
watch(
  () => props.photos.map((p) => p.id),
  (ids, before) => {
    if (!isOpen.value || !before) return
    const id = before[index.value]
    const now = ids.indexOf(id)
    track.value?.style.setProperty('--slide-ms', '0ms')
    index.value = now >= 0 ? now : clamp(index.value, 0, ids.length - 1)
  },
)

// ── Gestures ───────────────────────────────────────────────────────────────

function onPointerDown(e) {
  if (drag || morphing.value || (e.pointerType === 'mouse' && e.button !== 0)) return
  if (e.target.closest('button, a')) return
  drag = { id: e.pointerId, x0: e.clientX, y0: e.clientY, axis: null, trail: [{ x: e.clientX, y: e.clientY, t: e.timeStamp }] }
}

// Speed over the last moments of the drag, in px per ms. A pause before letting go means no flick.
function speedOf(trail, now) {
  const recent = trail.filter((p) => now - p.t <= FLICK_WINDOW)
  if (recent.length < 2) return { vx: 0, vy: 0 }
  const a = recent[0]
  const b = recent[recent.length - 1]
  const dt = Math.max(1, b.t - a.t)
  return { vx: (b.x - a.x) / dt, vy: (b.y - a.y) / dt }
}

function onPointerMove(e) {
  if (!drag || e.pointerId !== drag.id) return
  const dx = e.clientX - drag.x0
  const dy = e.clientY - drag.y0
  drag.trail.push({ x: e.clientX, y: e.clientY, t: e.timeStamp })
  if (drag.trail.length > 12) drag.trail.shift()

  // Decide the direction once, after a few pixels, then stick to it.
  if (!drag.axis) {
    if (Math.hypot(dx, dy) < 8) return
    drag.axis = Math.abs(dx) >= Math.abs(dy) ? 'x' : dy > 0 ? 'y' : 'none'
    if (drag.axis === 'none') return
    try {
      stage.value.setPointerCapture(e.pointerId)
    } catch {
      // The pointer is already gone; the drag still works while it is over the stage.
    }
    if (drag.axis === 'x') track.value.classList.add('is-dragging')
    else root.value.classList.add('is-pulling')
  }

  if (drag.axis === 'x') {
    const atEdge = (index.value === 0 && dx > 0) || (index.value === last.value && dx < 0)
    track.value.style.setProperty('--dx', `${atEdge ? dx * 0.3 : dx}px`)
  } else if (drag.axis === 'y') {
    root.value.style.setProperty('--pull', String(Math.max(0, dy)))
  }
}

function onPointerUp(e) {
  if (!drag || e.pointerId !== drag.id) return
  const { axis, x0, y0, trail } = drag
  const dx = e.clientX - x0
  const dy = e.clientY - y0
  const { vx, vy } = speedOf(trail, e.timeStamp)
  drag = null
  const cancelled = e.type === 'pointercancel'

  if (axis === 'x') {
    const width = stage.value.clientWidth
    let step = 0
    const flick = Math.abs(dx) >= FLICK_MIN
    if (!cancelled && (dx < -width * SWIPE_DISTANCE || (flick && vx < -SWIPE_SPEED))) step = 1
    else if (!cancelled && (dx > width * SWIPE_DISTANCE || (flick && vx > SWIPE_SPEED))) step = -1
    const next = clamp(index.value + step, 0, last.value)
    // Momentum: finish at about the speed of the flick, within sensible bounds.
    const remaining = next === index.value ? Math.abs(dx) : width - Math.abs(dx)
    const speed = Math.abs(vx)
    const ms = speed > 0.2 ? clamp((remaining / speed) * 1.5, 200, SLIDE_MS) : SLIDE_MS
    const el = track.value
    el.style.setProperty('--slide-ms', `${Math.round(ms)}ms`)
    el.classList.remove('is-dragging')
    el.style.setProperty('--dx', '0px')
    index.value = next
  } else if (axis === 'y') {
    root.value.classList.remove('is-pulling')
    if (!cancelled && (dy > CLOSE_DISTANCE || (dy >= FLICK_MIN && vy > 0.6))) close()
    else root.value.style.setProperty('--pull', '0')
  } else if (!axis && !cancelled) {
    // A tap: on the photo it hides or shows the controls; on the space around it, it closes.
    if (e.target.closest('.viewer__img')) chrome.value = !chrome.value
    else close()
  }
}

function onKeydown(e) {
  if (e.key === 'Escape') {
    e.preventDefault()
    close()
  } else if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
    e.preventDefault()
    chrome.value = true
    go(e.key === 'ArrowRight' ? 1 : -1)
  } else if (e.key === 'Tab') {
    // Keep focus inside the viewer.
    const items = [...root.value.querySelectorAll('button:not([disabled])')].filter((b) => b.offsetParent)
    if (!items.length) return
    const first = items[0]
    const end = items[items.length - 1]
    if (e.shiftKey && (document.activeElement === first || document.activeElement === root.value)) {
      e.preventDefault()
      end.focus()
    } else if (!e.shiftKey && document.activeElement === end) {
      e.preventDefault()
      first.focus()
    }
  }
}
</script>

<template>
  <Teleport to="body">
    <Transition name="viewer" :css="!morphing">
      <div
        v-if="isOpen"
        ref="root"
        class="viewer"
        role="dialog"
        aria-modal="true"
        aria-roledescription="carousel"
        :aria-label="`Photos, ${index + 1} of ${photos.length}`"
        tabindex="-1"
        @keydown="onKeydown"
      >
        <!-- The current photo, blurred and dimmed, fills the background. -->
        <div class="viewer__backdrop" aria-hidden="true">
          <Transition name="ambient">
            <img :key="photo.id" class="viewer__ambient" :src="photo.src" alt="" />
          </Transition>
        </div>

        <div
          ref="stage"
          class="viewer__stage"
          @pointerdown="onPointerDown"
          @pointermove="onPointerMove"
          @pointerup="onPointerUp"
          @pointercancel="onPointerUp"
        >
          <div ref="track" class="viewer__track" :style="{ '--index': index }">
            <figure
              v-for="(p, i) in photos"
              :key="p.id"
              class="viewer__slide"
              :class="{ 'is-current': i === index }"
              role="group"
              aria-roledescription="slide"
              :aria-label="`${i + 1} of ${photos.length}`"
              :inert="i !== index"
            >
              <img
                v-if="Math.abs(i - index) <= 2"
                class="viewer__img"
                :style="i === hero ? { viewTransitionName: 'photo-hero' } : null"
                :src="p.src"
                :alt="`Photo by ${p.name}, ${time(p.at)}`"
                draggable="false"
              />
            </figure>
          </div>
        </div>

        <div class="viewer__chrome" :class="{ 'is-hidden': !chrome }">
          <header class="viewer__top">
            <IconButton label="Close" class="viewer__btn" @click="close"><AppIcon name="close" /></IconButton>
            <span class="viewer__count caption tnum" aria-live="polite">{{ index + 1 }} / {{ photos.length }}</span>
            <IconButton v-if="canDelete(photo)" label="Delete photo" class="viewer__btn" @click="emit('delete', photo)"><AppIcon name="trash" /></IconButton>
            <span v-else class="viewer__spacer" />
          </header>

          <IconButton v-if="index > 0" label="Previous photo" class="viewer__btn viewer__nav viewer__nav--prev" @click="go(-1)"><AppIcon name="back" /></IconButton>
          <IconButton v-if="index < last" label="Next photo" class="viewer__btn viewer__nav viewer__nav--next" @click="go(1)"><AppIcon name="chevron-right" /></IconButton>

          <footer class="viewer__meta">
            <UserAvatar :name="photo.name" :person="photo.personId" :size="36" />
            <span class="viewer__who">
              <span class="title-sm">{{ photo.name }}</span>
              <span class="caption-sm viewer__soft truncate"><span class="tnum">{{ time(photo.at) }}</span><template v-if="where"> · {{ where }}</template></span>
            </span>
          </footer>
        </div>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.viewer { position: fixed; inset: 0; z-index: 40; overflow: hidden; color: var(--on-dark); outline: none; overscroll-behavior: contain; }

/* Dim and blur the page, and wash it with the photo's own colours. Dragging down fades it out. */
.viewer__backdrop { position: absolute; inset: 0; overflow: hidden; background: color-mix(in srgb, var(--scrim) 86%, transparent); -webkit-backdrop-filter: blur(24px); backdrop-filter: blur(24px); opacity: calc(1 - var(--pull, 0) / 420); }
.viewer__ambient { position: absolute; inset: -15%; width: 130%; height: 130%; object-fit: cover; filter: blur(64px) saturate(1.5); opacity: 0.4; }
.ambient-enter-active, .ambient-leave-active { transition: opacity 600ms var(--ease-out); }
.ambient-enter-from, .ambient-leave-to { opacity: 0; }

/* The stage takes every gesture; touch-action stops the browser scrolling or zooming under the finger. */
.viewer__stage { position: absolute; inset: 0; touch-action: none; user-select: none; cursor: grab; }
.viewer__track { display: flex; height: 100%; transform: translate3d(calc(var(--index) * -100% + var(--dx, 0px)), 0, 0); transition: transform var(--slide-ms, 420ms) var(--ease-out); will-change: transform; }
.viewer__track.is-dragging { transition: none; cursor: grabbing; }
.viewer__slide { flex: 0 0 100%; display: flex; align-items: center; justify-content: center; height: 100%; margin: 0; padding: 72px var(--spacing-base) 104px; }
@media (min-width: 744px) { .viewer__slide { padding: 80px 96px 112px; } }
.viewer__slide.is-current { transform: translate3d(0, calc(var(--pull, 0) * 1px), 0) scale(calc(1 - var(--pull, 0) / 1600)); transition: transform var(--motion-medium) var(--ease-out); }
.viewer.is-pulling .viewer__slide.is-current { transition: none; }
.viewer__img { display: block; max-width: 100%; max-height: 100%; min-width: 0; min-height: 0; border-radius: var(--rounded-lg); object-fit: contain; -webkit-user-drag: none; pointer-events: auto; }

/* The controls stay quiet so the photo leads. They fade out while the photo is pulled down, or on a tap. */
.viewer__chrome { position: absolute; inset: 0; pointer-events: none; opacity: calc(1 - var(--pull, 0) / 140); transition: opacity var(--motion-fast) var(--ease-out); }
.viewer__chrome.is-hidden { opacity: 0; }
.viewer__chrome.is-hidden :deep(button) { pointer-events: none; }
.viewer__chrome :deep(button) { pointer-events: auto; }
.viewer__top { position: absolute; top: 0; left: 0; right: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: calc(var(--spacing-md) + env(safe-area-inset-top, 0px)) var(--spacing-base) var(--spacing-md); }
.viewer__count { padding: 6px 12px; border-radius: var(--rounded-full); background: color-mix(in srgb, var(--on-dark) 14%, transparent); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.viewer__spacer { width: var(--tap-min); }
.viewer__btn { background: color-mix(in srgb, var(--on-dark) 14%, transparent); color: var(--on-dark); -webkit-backdrop-filter: blur(12px); backdrop-filter: blur(12px); }
.viewer__btn:not(:disabled):active { background: color-mix(in srgb, var(--on-dark) 30%, transparent); }
@media (hover: hover) { .viewer__btn:not(:disabled):hover { background: color-mix(in srgb, var(--on-dark) 24%, transparent); } }
.viewer__btn:focus-visible { outline-color: var(--on-dark); }

/* Previous and next: on screens with a mouse only. Touch screens swipe. */
.viewer__nav { position: absolute; top: 50%; display: none; width: 48px; height: 48px; margin-top: -24px; }
.viewer__nav--prev { left: var(--spacing-lg); }
.viewer__nav--next { right: var(--spacing-lg); }
@media (hover: hover) and (min-width: 744px) { .viewer__nav { display: inline-flex; } }

.viewer__meta { position: absolute; left: 0; right: 0; bottom: 0; display: flex; align-items: center; gap: var(--spacing-md); padding: var(--spacing-base) var(--spacing-lg) calc(var(--spacing-lg) + env(safe-area-inset-bottom, 0px)); }
@media (min-width: 744px) { .viewer__meta { justify-content: center; } }
.viewer__who { display: flex; flex-direction: column; min-width: 0; }
.viewer__soft { color: color-mix(in srgb, var(--on-dark) 72%, transparent); }

/* Without the grow-from-tile (older browsers, or opened from code): fade in and settle. */
.viewer-enter-active { transition: opacity var(--motion-fast) var(--ease-out); }
.viewer-enter-active .viewer__stage { transition: transform var(--motion-medium) var(--ease-out); }
.viewer-leave-active { transition: opacity 180ms var(--ease-out); }
.viewer-enter-from, .viewer-leave-to { opacity: 0; }
.viewer-enter-from .viewer__stage { transform: scale(0.96); }
</style>
