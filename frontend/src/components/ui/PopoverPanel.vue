<script setup>
// A small card that pops out right beside the button that opened it, over the page, with no dimmed backdrop.
// For quick picks started from a + or a small button: inviting friends, setting a location, adding a place.
//   <PopoverPanel v-model:open="inviteOpen" title="Invite friends"> ...body... <template #footer>...</template></PopoverPanel>
// It finds its button by itself (the control last pressed), opens under it (or above, when there is more room
// there), keeps inside the window, and follows the button while the page scrolls. On phones it spans the width.
// It closes on Escape, the close button, and a press anywhere outside it. Focus moves in, stays in, and goes back.
// The body scrolls inside the card, so a footer (a Send button) stays in view.
import { nextTick, onBeforeUnmount, ref, useId, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import { useFocusTrap } from '@/lib/useFocusTrap.js'

const open = defineModel('open', { type: Boolean, default: false })
const props = defineProps({
  title: { type: String, default: '' },
  // The card's width in px on wider screens.
  width: { type: Number, default: 380 },
  // The tallest the card may be, in px; it is never taller than the room beside its button.
  maxHeight: { type: Number, default: 560 },
})
const emit = defineEmits(['close'])

const GAP = 8 // px between the button and the card
const EDGE = 12 // px the card keeps from the window's edges
const PHONE = 560 // below this window width the card spans the window

const titleId = `pop-${useId()}`
const panel = ref(null)
const place = ref({})
let anchor = null

function close() {
  open.value = false
  emit('close')
}

// Where the card goes: under its button when it fits, otherwise on whichever side has more room.
// How to call: position()
function position() {
  const rect = anchor?.isConnected ? anchor.getBoundingClientRect() : null
  const vw = window.innerWidth
  const vh = window.innerHeight
  const width = vw < PHONE ? vw - EDGE * 2 : Math.min(props.width, vw - EDGE * 2)
  if (!rect) {
    place.value = { left: `${(vw - width) / 2}px`, top: `${EDGE * 6}px`, width: `${width}px`, maxHeight: `${Math.min(props.maxHeight, vh - EDGE * 12)}px`, origin: 'top center' }
    return
  }
  const below = vh - rect.bottom - GAP - EDGE
  const above = rect.top - GAP - EDGE
  const down = below >= Math.min(props.maxHeight, 320) || below >= above
  // Line up with the button's right edge when it sits on the right half of the window, else its left edge.
  const onRight = rect.left + rect.width / 2 > vw / 2
  let left = onRight ? rect.right - width : rect.left
  left = Math.max(EDGE, Math.min(left, vw - width - EDGE))
  place.value = {
    left: `${left}px`,
    width: `${width}px`,
    ...(down ? { top: `${rect.bottom + GAP}px` } : { bottom: `${vh - rect.top + GAP}px` }),
    maxHeight: `${Math.min(props.maxHeight, down ? below : above)}px`,
    origin: `${down ? 'top' : 'bottom'} ${onRight ? 'right' : 'left'}`,
  }
}

// A press outside the card closes it. The button that opened it is left to toggle it itself.
function onPressOutside(event) {
  if (!open.value || panel.value?.contains(event.target) || anchor?.contains(event.target)) return
  close()
}
const follow = () => open.value && position()

function listen(on) {
  const act = on ? 'addEventListener' : 'removeEventListener'
  document[act]('pointerdown', onPressOutside, true)
  window[act]('resize', follow)
  window[act]('scroll', follow, true)
}

watch(open, async (isOpen) => {
  if (isOpen) {
    anchor = lastPressed || document.activeElement
    position()
    listen(true)
    await nextTick()
    position()
  } else listen(false)
})
onBeforeUnmount(() => listen(false))

const { onKeydown: trap } = useFocusTrap(open, panel)
</script>

<script>
// The control last pressed anywhere on the page: the button a popover opens beside. Kept for every popover.
let lastPressed = null
if (typeof document !== 'undefined') {
  document.addEventListener('pointerdown', (event) => {
    lastPressed = event.target.closest?.('button, a, [role="button"]') || null
  }, true)
  document.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') lastPressed = document.activeElement
  }, true)
}
</script>

<template>
  <Teleport to="body">
    <Transition name="pop">
      <section
        v-if="open"
        ref="panel"
        class="pop"
        :style="{ left: place.left, top: place.top, bottom: place.bottom, width: place.width, maxHeight: place.maxHeight, transformOrigin: place.origin }"
        role="dialog"
        :aria-labelledby="title ? titleId : undefined"
        tabindex="-1"
        @keydown.esc="close"
        @keydown="trap"
      >
        <header class="pop__head">
          <h2 v-if="title" :id="titleId" class="title-md">{{ title }}</h2>
          <button type="button" class="pop__close" aria-label="Close" @click="close"><AppIcon name="close" :size="16" /></button>
        </header>
        <div class="pop__body"><slot /></div>
        <footer v-if="$slots.footer" class="pop__foot"><slot name="footer" /></footer>
      </section>
    </Transition>
  </Teleport>
</template>

<style scoped>
.pop { position: fixed; z-index: 30; display: flex; flex-direction: column; min-height: 0; border: 1px solid var(--hairline); border-radius: var(--rounded-lg); background: var(--canvas); box-shadow: 0 18px 40px -12px rgb(0 0 0 / 0.22), 0 2px 6px rgb(0 0 0 / 0.06); outline: none; }
.pop__head { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); padding: var(--spacing-md) var(--spacing-sm) 0 var(--spacing-base); }
.pop__head h2 { margin: 0; }
.pop__close { display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; margin-left: auto; border: 0; border-radius: var(--rounded-full); background: transparent; color: var(--muted); cursor: pointer; }
@media (hover: hover) { .pop__close:hover { background: var(--surface-soft); color: var(--ink); } }
.pop__close:focus-visible { outline: 2px solid var(--ink); outline-offset: 1px; }
.pop__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-base) var(--spacing-base); }
.pop__foot { flex-shrink: 0; display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-base) var(--spacing-base); }

/* It grows out of its button: a quick scale and fade from the corner nearest the button. */
.pop-enter-active { transition: opacity 140ms var(--ease-out), transform 220ms var(--ease-spring); }
.pop-leave-active { transition: opacity 110ms var(--ease-out), transform 110ms var(--ease-out); }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: scale(0.94); }
@media (prefers-reduced-motion: reduce) { .pop-enter-active, .pop-leave-active { transition: opacity 100ms linear; } .pop-enter-from, .pop-leave-to { transform: none; } }
</style>
