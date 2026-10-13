// Is the demo tour part of this build? It always is in development. A production build has it only when it was made with
// VITE_DEMO_TOUR=1 (see frontend/.env.example); without that flag nothing of the tour is in the bundle, and /demo is the
// "not found" page.
//
// The tour needs accounts that live in the browser (the demo account), so the flag REQUIRES VITE_ALLOW_LOCAL_ACCOUNTS=1; it
// does not switch local accounts on by itself. Turning on a mode that lets anyone sign up into a browser-only account is a
// separate decision that should be written down, not a side effect of another flag. A build with the tour and without local
// accounts refuses to start (tourMisconfigured, checked in main.js), the way a build with no Supabase settings does.
//
// TOUR_BUILT is written as one plain expression of build-time values so the bundler can drop everything behind it:
//   const TourStrip = TOUR_BUILT ? defineAsyncComponent(() => import('@/tour/TourStrip.vue')) : null
import { localAccountsAllowed } from './supabase.js'

export const TOUR_BUILT = !!import.meta.env.DEV || import.meta.env.VITE_DEMO_TOUR === '1'

// Does this build have the tour but no way to keep the demo account? True means it must refuse to start.
// How to call: tourMisconfigured({ DEV: false, VITE_DEMO_TOUR: '1' }) -> true;  tourMisconfigured({ DEV: false, VITE_DEMO_TOUR: '1', VITE_ALLOW_LOCAL_ACCOUNTS: '1' }) -> false
export function tourMisconfigured(env = import.meta.env) {
  return (!!env.DEV || env.VITE_DEMO_TOUR === '1') && !localAccountsAllowed(env)
}
