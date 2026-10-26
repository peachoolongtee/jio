import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import UnavailableView from './views/UnavailableView.vue'
import router from './router'
import { mustRefuse } from './lib/supabase.js'
import { TOUR_BUILT, tourMisconfigured } from './lib/tourFlag.js'

// Design system: tokens first, then the base styles that use them.
import './styles/tokens.css'
import './styles/app.css'
import './styles/rain.css'

// A production build with no Supabase settings would let anyone "sign up" into an account that lives only in their
// browser. It shows a plain "not available" screen instead, with no router and so no way into the app; the one line for
// the developer goes to the console. VITE_ALLOW_LOCAL_ACCOUNTS=1 keeps local accounts on purpose (see .env.example).
if (mustRefuse()) {
  console.error('Jio: this build has no VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, so nobody can log in. Set them (see frontend/.env.example) and build again, or set VITE_ALLOW_LOCAL_ACCOUNTS=1 for a demo that keeps accounts in the browser.')
  createApp(UnavailableView).mount('#app')
} else if (TOUR_BUILT && tourMisconfigured()) {
  // The demo tour (VITE_DEMO_TOUR=1) signs in as an account that lives in the browser, which a production build refuses
  // unless it is told to keep them. Say so, loudly, instead of showing a tour that cannot work.
  console.error('Jio: this build has the demo tour (VITE_DEMO_TOUR=1) but not local accounts. The tour needs them: set VITE_ALLOW_LOCAL_ACCOUNTS=1 as well (see frontend/.env.example) and build again.')
  createApp(UnavailableView).mount('#app')
} else {
  // Not top-level await, which the build target may not allow: the app starts from a function.
  startApp()
}

// How to call: startApp() (builds the app and mounts it)
async function startApp() {
  // Development only: a script that drives several browsers at one stand-in database hands it over before the app starts.
  if (import.meta.env.DEV && globalThis.__jioStandInDatabase) {
    const { installForSharedDatabase } = await import('./components/dev/madeUpAccount.js')
    installForSharedDatabase()
  }
  const pinia = createPinia()
  const app = createApp(App).use(pinia).use(router)
  const start = () => app.mount('#app')
  if (TOUR_BUILT) {
    // The demo tour reads its saved state first, so the lists never flash all ten saves of the story.
    import('./tour/install.js').then(({ installTour }) => installTour(pinia)).catch((err) => console.error('Jio: the demo tour could not start.', err)).then(start)
  } else {
    start()
  }
}
