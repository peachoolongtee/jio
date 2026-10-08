// Smooth changes between two states of the page, using the browser's View Transitions API.
// The browser takes a picture of the page, runs the update, then animates from the picture to the new page:
// a cross-fade by default, and a move for any element given a `view-transition-name` on both sides
// (the session tab underline, a photo opening from the gallery). The styles are in styles/app.css.
// Browsers without the API, reduced motion and background tabs just run the update.
import { nextTick } from 'vue'

export function canViewTransition() {
  if (typeof document === 'undefined' || typeof document.startViewTransition !== 'function') return false
  if (document.visibilityState !== 'visible') return false
  return !window.matchMedia?.('(prefers-reduced-motion: reduce)').matches
}

// Runs `update` (it may be async) as a view transition. Resolves once the animation has finished.
//   await withViewTransition(() => { open.value = true })
export async function withViewTransition(update) {
  if (!canViewTransition()) {
    await update()
    return
  }
  const transition = document.startViewTransition(async () => {
    await update()
    await nextTick()
  })
  // A skipped transition (another one started, or the tab was hidden) is fine: the update still ran.
  transition.ready.catch(() => {})
  await transition.finished.catch(() => {})
}

// Page changes: hold the navigation until the browser has its picture of the old page, then let the
// router render the new one and finish the transition once Vue has drawn it.
export function installPageTransitions(router) {
  let finish = null
  const done = () => {
    finish?.()
    finish = null
  }

  router.beforeResolve((to, from) => {
    // Not on the first load, and not when only the query or hash changes.
    if (!from.matched.length || to.path === from.path || !canViewTransition()) return true
    done()
    return new Promise((resolve) => {
      let started = false
      const transition = document.startViewTransition(
        () =>
          new Promise((resolveUpdate) => {
            // The navigation already went ahead without the transition: nothing to wait for.
            if (started) return resolveUpdate()
            started = true
            finish = resolveUpdate
            resolve(true)
            // The page is frozen until the update finishes, so never wait long for afterEach.
            setTimeout(() => finish === resolveUpdate && done(), 1000)
          }),
      )
      transition.ready.catch(() => {})
      transition.finished.catch(() => {})
      // If the browser is slow to start the transition, carry on with the navigation without it.
      setTimeout(() => {
        if (started) return
        started = true
        resolve(true)
      }, 300)
    })
  })

  router.afterEach(async () => {
    if (!finish) return
    await nextTick()
    done()
  })
}
