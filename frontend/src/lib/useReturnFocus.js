// Gives focus back to the button that started a request when a dialog opened by its answer closes. A button that is natively
// disabled while the request runs (Next, Join, Rejoin) drops focus, so the dialog's own focus trap has nothing to return to. This
// remembers the button when it is pressed and focuses it again once the dialog is closed (and the button is enabled again).
//   const { remember } = useReturnFocus(showClash)
//   <AppButton @click="remember($event); join()">Join</AppButton>
import { nextTick, watch } from 'vue'

export function useReturnFocus(open) {
  let opener = null

  // How to call: remember($event) (the click that starts the request)
  function remember(event) {
    opener = event?.currentTarget ?? null
  }

  watch(open, async (isOpen) => {
    if (isOpen) return
    const target = opener
    opener = null
    // After the dialog's own trap has run, and the page has drawn the button enabled again.
    await nextTick()
    if (target && target.isConnected && !target.disabled && typeof target.focus === 'function') target.focus({ preventScroll: true })
  })

  return { remember }
}
