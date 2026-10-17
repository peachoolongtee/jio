<script>
// How far, or how fast, a drag down must go for the sheet to close. Kept outside <script setup> so a test can call it.
// How to call: shouldClose(120, 300) -> true (dragged 120px in 300ms)
export function shouldClose(distance, ms) {
  return distance > 96 || (distance > 24 && distance / Math.max(ms, 1) > 0.5)
}
</script>

<script setup>
// A sheet that slides up from the bottom over a dimmed backdrop.
//   <BottomSheet v-model:open="showSheet" title="Add a stop"> ... </BottomSheet>
// On desktop (1128px and up) the same content opens as a centred dialog, or as a side panel with `side`.
// It is never a full-width sheet on desktop.
// It closes on the backdrop, the close button and the Escape key.
// Use the `footer` slot for a button that stays in view while the content scrolls.
// On phones and tablets it can be dragged down by its handle or header to close, like a native sheet.
import { ref, useId, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import IconButton from './IconButton.vue'
import { useFocusTrap } from '@/lib/useFocusTrap.js'

const open = defineModel('open', { type: Boolean, default: false })
defineProps({
  title: { type: String, default: '' },
  // Hide the close button when the sheet has its own "Not now" or "Cancel" action.
  hideClose: { type: Boolean, default: false },
  // A tall sheet takes most of the screen, for lists and search.
  tall: { type: Boolean, default: false },
  // On desktop, open as a panel on the right instead of a centred dialog.
  side: { type: Boolean, default: false },
})
const emit = defineEmits(['close'])

const titleId = `sheet-${useId()}`
const panel = ref(null)

function close() {
  open.value = false
  emit('close')
}

// Focus moves into the sheet when it opens, Tab stays inside it, and focus goes back to the opener on close.
const { onKeydown: trap } = useFocusTrap(open, panel)

// Dragging down: the sheet follows the finger, and closes when let go far enough down or with a quick flick.
const drag = ref(null)
const offset = ref(0)

// The panel stays mounted between openings (a screen keeps one sheet and flips `open`), so a drag that closed it must not
// leave it shifted down. The offset is reset when `open` turns true, before the panel is drawn, and not when it turns
// false: the sheet leaves from where the finger let go, and a reset then would make it jump back up as it fades.
watch(open, (isOpen) => {
  if (!isOpen) return
  drag.value = null
  offset.value = 0
})

// How to call: <div @pointerdown="dragStart"> (on the handle and header; a press on a button there is left alone)
function dragStart(event) {
  if (event.button > 0 || event.target.closest('button, a, input')) return
  if (!window.matchMedia('(max-width: 1127.98px)').matches) return
  drag.value = { id: event.pointerId, y: event.clientY, at: event.timeStamp }
  // Keep the moves coming when the finger leaves the header. Capture can fail for a pointer that is already gone.
  try {
    event.currentTarget.setPointerCapture(event.pointerId)
  } catch {
    // The drag still works while the pointer stays over the header.
  }
}

// How to call: <div @pointermove="dragMove">
function dragMove(event) {
  if (!drag.value || event.pointerId !== drag.value.id) return
  offset.value = Math.max(0, event.clientY - drag.value.y)
}

// How to call: <div @pointerup="dragEnd" @pointercancel="dragEnd">
function dragEnd(event) {
  if (!drag.value || event.pointerId !== drag.value.id) return
  const letGo = event.type === 'pointerup' && shouldClose(offset.value, event.timeStamp - drag.value.at)
  drag.value = null
  if (letGo) close()
  else offset.value = 0
}
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet" :class="{ 'sheet--side': side }" @keydown.esc="close" @keydown="trap">
        <button class="sheet__scrim" type="button" tabindex="-1" aria-label="Close" @click="close" />
        <section
          ref="panel"
          class="sheet__panel"
          :class="{ 'sheet__panel--tall': tall, 'is-dragging': drag }"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          tabindex="-1"
          :style="offset ? { transform: `translateY(${offset}px)` } : undefined"
        >
          <div class="sheet__grab" @pointerdown="dragStart" @pointermove="dragMove" @pointerup="dragEnd" @pointercancel="dragEnd">
            <span class="sheet__handle" aria-hidden="true" />
            <header v-if="title || !hideClose" class="sheet__head">
              <h2 v-if="title" :id="titleId" class="display-sm">{{ title }}</h2>
              <span v-else />
              <IconButton v-if="!hideClose" label="Close" @click="close"><AppIcon name="close" /></IconButton>
            </header>
          </div>
          <div class="sheet__body"><slot /></div>
          <footer v-if="$slots.footer" class="sheet__foot"><slot name="footer" /></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.sheet { position: fixed; inset: 0; z-index: 30; display: flex; align-items: flex-end; justify-content: center; }
.sheet__scrim { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: var(--scrim); opacity: 0.5; cursor: default; }
.sheet__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  max-height: 90dvh;
  border-radius: var(--rounded-lg) var(--rounded-lg) 0 0;
  background: var(--canvas);
  outline: none;
  transition: transform var(--motion-fast) var(--ease-out);
}
.sheet__panel.is-dragging { transition: none; }
/* The handle and header take the drag; the browser does not scroll the page from them. */
.sheet__grab { position: relative; flex-shrink: 0; display: flex; flex-direction: column; touch-action: none; cursor: grab; }
/* A sheet with no header has only the 12px handle to grab. Its hit area grows to the 44px minimum upwards, over the
   backdrop, so nothing inside the sheet moves and the handle looks the same. */
.sheet__grab:not(:has(.sheet__head))::before { content: ''; position: absolute; top: calc(12px - var(--tap-min)); right: 0; left: 0; height: var(--tap-min); }
.sheet__panel.is-dragging .sheet__grab { cursor: grabbing; }
.sheet__panel--tall { height: 75dvh; }
.sheet__handle { flex-shrink: 0; align-self: center; width: 36px; height: var(--spacing-xs); margin-top: var(--spacing-sm); border-radius: var(--rounded-full); background: var(--border-strong); }
.sheet__head { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-base) 0 var(--spacing-lg); }
.sheet__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--spacing-base); padding: var(--spacing-base) var(--spacing-lg) calc(var(--spacing-lg) + env(safe-area-inset-bottom, 0px)); }
.sheet__foot { flex-shrink: 0; display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base) var(--spacing-lg) calc(var(--spacing-lg) + env(safe-area-inset-bottom, 0px)); }
/* With a footer, the footer sits on the home indicator's inset instead of the body. */
.sheet__body:has(+ .sheet__foot) { padding-bottom: var(--spacing-lg); }

/* Tablet: still a bottom sheet, but not wider than a comfortable reading width. */
@media (min-width: 744px) {
  .sheet__panel { max-width: var(--sheet-max-width); }
}

/* Desktop: a centred dialog, or a panel on the right. Never a full-width sheet. */
@media (min-width: 1128px) {
  .sheet { align-items: center; padding: var(--spacing-xl); }
  .sheet__panel { max-width: var(--dialog-max-width); max-height: calc(100dvh - var(--spacing-xl) * 2); border-radius: var(--rounded-lg); }
  .sheet__panel--tall { height: min(720px, calc(100dvh - var(--spacing-xl) * 2)); }
  .sheet__handle { display: none; }
  .sheet__grab { touch-action: auto; cursor: auto; }
  .sheet__grab::before { display: none; }
  .sheet__head { padding-top: var(--spacing-base); }
  .sheet--side { justify-content: flex-end; align-items: stretch; padding: 0; }
  .sheet--side .sheet__panel { width: var(--side-panel-width); max-width: 100%; height: 100dvh; max-height: none; border-radius: var(--rounded-lg) 0 0 var(--rounded-lg); }
}

/* The backdrop fades and the sheet glides up on the native sheet curve. Leaving is quicker than arriving. */
.sheet-enter-active { transition: opacity var(--motion-fast) var(--ease-out); }
.sheet-leave-active { transition: opacity 160ms var(--ease-out); }
.sheet-enter-active .sheet__panel { transition: transform var(--motion-medium) var(--ease-sheet); }
.sheet-leave-active .sheet__panel { transition: transform 160ms var(--ease-out); }
.sheet-enter-from, .sheet-leave-to { opacity: 0; }
.sheet-enter-from .sheet__panel { transform: translateY(48px); }
.sheet-leave-to .sheet__panel { transform: translateY(24px); }
@media (min-width: 1128px) {
  .sheet:not(.sheet--side).sheet-enter-from .sheet__panel { transform: translateY(12px) scale(0.98); }
  .sheet:not(.sheet--side).sheet-leave-to .sheet__panel { transform: translateY(6px); }
}
@media (min-width: 1128px) {
  .sheet--side.sheet-enter-from .sheet__panel, .sheet--side.sheet-leave-to .sheet__panel { transform: translateX(24px); }
}
</style>
