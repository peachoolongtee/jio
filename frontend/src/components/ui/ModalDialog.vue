<script setup>
// A small dialog in the middle of the screen, for a decision such as "Confirm plan?".
//   <ModalDialog v-model:open="showConfirm" title="Confirm plan?">
//     <AppButton block @click="confirm">Confirm plan</AppButton>
//     <AppButton block variant="secondary" @click="showConfirm = false">Not yet</AppButton>
//   </ModalDialog>
// Put the safer choice first. It closes on the backdrop and the Escape key, and keeps Tab inside while it is open. A dialog with
// `text` is described by it (aria-describedby), so a screen reader reads the sentence after the title.
import { ref, useId } from 'vue'
import { useFocusTrap } from '@/lib/useFocusTrap.js'

const open = defineModel('open', { type: Boolean, default: false })
defineProps({
  title: { type: String, required: true },
  text: { type: String, default: '' },
})
const emit = defineEmits(['close'])

const titleId = `modal-${useId()}`
const textId = `${titleId}-text`
const panel = ref(null)

function close() {
  open.value = false
  emit('close')
}

// Focus moves into the dialog when it opens, Tab stays inside it, and focus goes back to the opener on close.
const { onKeydown } = useFocusTrap(open, panel)
</script>

<template>
  <Teleport to="body">
  <Transition name="modal">
    <div v-if="open" class="modal" @keydown.esc="close" @keydown="onKeydown">
      <button class="modal__scrim" type="button" tabindex="-1" aria-label="Close" @click="close" />
      <section ref="panel" class="modal__panel" role="dialog" aria-modal="true" :aria-labelledby="titleId" :aria-describedby="text ? textId : undefined" tabindex="-1">
        <div class="modal__text">
          <h2 :id="titleId" class="display-sm">{{ title }}</h2>
          <p v-if="text" :id="textId" class="body-md text-muted">{{ text }}</p>
        </div>
        <slot name="content" />
        <div class="modal__actions"><slot /></div>
      </section>
    </div>
  </Transition>
  </Teleport>
</template>

<style scoped>
/* Above the photo viewer (40), so a question about a photo can be asked on top of it. */
.modal { position: fixed; inset: 0; z-index: 50; display: flex; align-items: center; justify-content: center; padding: var(--spacing-lg); }
.modal__scrim { position: absolute; inset: 0; width: 100%; height: 100%; padding: 0; border: 0; background: var(--scrim); opacity: 0.5; cursor: default; }
.modal__panel {
  position: relative;
  display: flex;
  flex-direction: column;
  gap: var(--spacing-base);
  width: 100%;
  max-width: var(--dialog-max-width);
  padding: var(--spacing-lg);
  border-radius: var(--rounded-lg);
  background: var(--canvas);
  outline: none;
}
.modal__text { display: flex; flex-direction: column; gap: var(--spacing-sm); }
/* A long title in the text (a meetup's name) wraps instead of pushing the dialog wider. */
.modal__text > * { overflow-wrap: anywhere; }
.modal__actions { display: flex; flex-direction: column; gap: var(--spacing-md); }
.modal { overflow-y: auto; }
.modal__panel { max-height: calc(100dvh - var(--spacing-lg) * 2); overflow-y: auto; }

/* The backdrop fades; the dialog rises 12px and settles. Leaving is quicker than arriving. */
.modal-enter-active { transition: opacity var(--motion-fast) var(--ease-out); }
.modal-leave-active { transition: opacity 150ms var(--ease-out); }
.modal-enter-active .modal__panel { transition: transform var(--motion-medium) var(--ease-sheet); }
.modal-leave-active .modal__panel { transition: transform 150ms var(--ease-out); }
.modal-enter-from, .modal-leave-to { opacity: 0; }
.modal-enter-from .modal__panel { transform: translateY(12px) scale(0.98); }
.modal-leave-to .modal__panel { transform: translateY(6px); }
</style>
