// Focus handling for dialogs: focus moves into the panel when it opens, Tab and Shift+Tab stay inside it,
// and focus goes back to the control that opened it when it closes.
import { nextTick, onBeforeUnmount, watch } from 'vue'

export const FOCUSABLE = 'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

// Which element Tab should move to so focus stays in the panel, or null to let the browser carry on.
// `items` are the panel's focusable elements in order, `active` is the focused element.
// How to call: const next = wrapTab(items, document.activeElement, panel, event.shiftKey)
export function wrapTab(items, active, panel, shift) {
  if (!items.length) return null
  const first = items[0]
  const last = items[items.length - 1]
  if (shift && (active === first || active === panel)) return last
  if (!shift && active === last) return first
  return null
}

// Traps focus in `panel` (a ref to its element) while `open` (a ref to a boolean) is true.
// Bind the returned onKeydown on an element around the panel; closing on Escape stays with the dialog.
// A view that is created when it opens and destroyed when it closes (no `open` that turns false) passes
// `restoreOnUnmount`, with `open` as ref(true): focus goes back to the opener when the view is removed.
// How to call: const { onKeydown } = useFocusTrap(open, panel)   then   <div @keydown="onKeydown">
export function useFocusTrap(open, panel, { restoreOnUnmount = false } = {}) {
  let opener = null

  function onKeydown(event) {
    if (event.key !== 'Tab' || !panel.value) return
    const next = wrapTab([...panel.value.querySelectorAll(FOCUSABLE)], document.activeElement, panel.value, event.shiftKey)
    if (!next) return
    event.preventDefault()
    next.focus()
  }

  function restore() {
    if (opener && typeof opener.focus === 'function' && opener.isConnected !== false) opener.focus({ preventScroll: true })
    opener = null
  }

  // Move focus into the panel when it opens, and back to where it was when it closes.
  watch(
    open,
    async (isOpen) => {
      if (isOpen) {
        opener = document.activeElement
        await nextTick()
        panel.value?.focus({ preventScroll: true })
      } else restore()
    },
    { immediate: restoreOnUnmount },
  )
  if (restoreOnUnmount) onBeforeUnmount(restore)

  return { onKeydown }
}
