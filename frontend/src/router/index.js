import { createRouter, createWebHistory } from 'vue-router'
// First, on purpose: this module creates the Supabase client and then takes a reset link's tokens out of the address, and
// that must happen before createWebHistory below copies the address (lib/authLink.js says why).
import '@/lib/supabase.js'
import { installGuard } from './guard.js'
import { routes } from './routes.js'
import { rememberEntry } from '@/lib/stepNav.js'
import { installPageTransitions } from '@/lib/viewTransition.js'

const router = createRouter({
  history: createWebHistory(import.meta.env.BASE_URL),
  routes,
  scrollBehavior: (to, from, saved) => {
    // Only the query changed on the same screen, such as a place opening over Home (?place=…): stay put.
    if (to.path === from.path && to.hash === from.hash) return false
    // Between the steps of one session, with the steps bar still on screen: stay put, so the bar a person just
    // pressed does not jump to the top of the window. Otherwise (the bar scrolled away) a new screen starts at the top.
    if (!saved && !to.hash && to.params.id && to.params.id === from.params.id) {
      const bar = document.querySelector('.steps')?.getBoundingClientRect()
      if (bar && bar.bottom > 0 && bar.top < window.innerHeight) return false
    }
    if (saved) return saved
    // A link to a section, such as /sessions/s1#photos: give the screen a moment to draw it, then scroll there
    // (without gliding, for people who asked for less motion).
    if (to.hash) {
      const behavior = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
      return new Promise((resolve) => setTimeout(() => resolve({ el: to.hash, top: 16, behavior }), 300))
    }
    return { top: 0 }
  },
})

// Who may open what, and where a visitor is sent instead (router/guard.js).
installGuard(router)

router.afterEach((to, from) => {
  document.title = to.meta.title ? `${to.meta.title} · Jio` : 'Jio'
  // Remember the screen a session was opened from, for the button at its top left (lib/stepNav.js).
  rememberEntry(to, from)
})

// Moving between screens cross-fades instead of jumping (lib/viewTransition.js).
installPageTransitions(router)

export default router
