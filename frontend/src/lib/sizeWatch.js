// Tells a screen when an element's size changes, for a floating card that was placed once and must be placed again when its
// content grows (an error line appears, a count changes). Calls `onChange` only when the width or height differs from the last
// one seen, so the observer's first report, and a change that is only a move, do nothing. Where the page has no ResizeObserver
// (the tests' stand-in page, an old browser) it does nothing and `stop` is safe to call.
// How to call: const watcher = sizeWatch(() => place(id)); watcher.watch(card); watcher.stop()
export function sizeWatch(onChange) {
  let observer = null
  let element = null
  let size = ''
  const sizeOf = (el) => `${el.offsetWidth}x${el.offsetHeight}`

  // Start watching this element, and stop watching the one before it. The same element again changes nothing.
  // How to call: watcher.watch(card)
  function watch(el) {
    if (el === element) return
    stop()
    if (!el || typeof ResizeObserver !== 'function') return
    element = el
    size = sizeOf(el)
    observer = new ResizeObserver(() => {
      if (!element) return
      const now = sizeOf(element)
      if (now === size) return
      size = now
      onChange()
    })
    observer.observe(el)
  }

  // Stop watching.
  // How to call: watcher.stop()
  function stop() {
    observer?.disconnect()
    observer = null
    element = null
    size = ''
  }

  return { watch, stop }
}
