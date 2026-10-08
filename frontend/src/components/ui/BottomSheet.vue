<script setup>
// A sheet that slides up from the bottom over a dimmed backdrop.
//   <BottomSheet v-model:open="showSheet" title="Add a stop"> ... </BottomSheet>
// On desktop (1128px and up) the same content opens as a centred dialog, or as a side panel with `side`.
// It is never a full-width sheet on desktop.
// It closes on the backdrop, the close button and the Escape key.
// Use the `footer` slot for a button that stays in view while the content scrolls.
import { nextTick, ref, useId, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import IconButton from './IconButton.vue'

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
let opener = null

function close() {
  open.value = false
  emit('close')
}

// Keep Tab inside the sheet while it is open.
function trap(event) {
  if (event.key !== 'Tab' || !panel.value) return
  const items = [...panel.value.querySelectorAll('a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])')]
  if (!items.length) return
  const first = items[0]
  const last = items[items.length - 1]
  if (event.shiftKey && (document.activeElement === first || document.activeElement === panel.value)) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

// Move focus into the sheet when it opens, and back to where it was when it closes.
watch(open, async (isOpen) => {
  if (isOpen) {
    opener = document.activeElement
    await nextTick()
    panel.value?.focus()
  } else if (opener && typeof opener.focus === 'function') {
    opener.focus()
    opener = null
  }
})
</script>

<template>
  <Teleport to="body">
    <Transition name="sheet">
      <div v-if="open" class="sheet" :class="{ 'sheet--side': side }" @keydown.esc="close" @keydown="trap">
        <button class="sheet__scrim" type="button" tabindex="-1" aria-label="Close" @click="close" />
        <section
          ref="panel"
          class="sheet__panel"
          :class="{ 'sheet__panel--tall': tall }"
          role="dialog"
          aria-modal="true"
          :aria-labelledby="title ? titleId : undefined"
          tabindex="-1"
        >
          <span class="sheet__handle" aria-hidden="true" />
          <header v-if="title || !hideClose" class="sheet__head">
            <h2 v-if="title" :id="titleId" class="display-sm">{{ title }}</h2>
            <span v-else />
            <IconButton v-if="!hideClose" label="Close" @click="close"><AppIcon name="close" /></IconButton>
          </header>
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
}
.sheet__panel--tall { height: 75dvh; }
.sheet__handle { flex-shrink: 0; align-self: center; width: 36px; height: var(--spacing-xs); margin-top: var(--spacing-sm); border-radius: var(--rounded-full); background: var(--border-strong); }
.sheet__head { flex-shrink: 0; display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-base) 0 var(--spacing-lg); }
.sheet__body { flex: 1 1 auto; min-height: 0; overflow-y: auto; display: flex; flex-direction: column; gap: var(--spacing-base); padding: var(--spacing-base) var(--spacing-lg) var(--spacing-lg); }
.sheet__foot { flex-shrink: 0; display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base) var(--spacing-lg) var(--spacing-lg); border-top: 1px solid var(--hairline); }

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
