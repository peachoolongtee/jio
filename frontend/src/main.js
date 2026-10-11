import { createApp } from 'vue'
import { createPinia } from 'pinia'
import App from './App.vue'
import UnavailableView from './views/UnavailableView.vue'
import router from './router'
import { mustRefuse } from './lib/supabase.js'

// Design system: tokens first, then the base styles that use them.
import './styles/tokens.css'
import './styles/app.css'

// A production build with no Supabase settings would let anyone "sign up" into an account that lives only in their
// browser. It shows a plain "not available" screen instead, with no router and so no way into the app; the one line for
// the developer goes to the console. VITE_ALLOW_LOCAL_ACCOUNTS=1 keeps local accounts on purpose (see .env.example).
if (mustRefuse()) {
  console.error('Jio: this build has no VITE_SUPABASE_URL and VITE_SUPABASE_ANON_KEY, so nobody can log in. Set them (see frontend/.env.example) and build again, or set VITE_ALLOW_LOCAL_ACCOUNTS=1 for a demo that keeps accounts in the browser.')
  createApp(UnavailableView).mount('#app')
} else {
  createApp(App).use(createPinia()).use(router).mount('#app')
}
