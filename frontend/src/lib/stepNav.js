// Moving between a session's steps without piling up the browser's history. A link to the page just behind this one in
// history (the step you came from) is a way back, not a new place, so it goes Back instead of adding an entry. Without
// this, Locate, Vote, back arrow, Vote would leave a trail of repeated pages that the browser's Back had to walk through.
// No DOM of its own: the event, the router and the history state come in, so it can be tested on its own.

// The page a person was on when they opened a session: Home, Sessions, their profile. The button at the top left of a
// session goes back there, so it means "back" and not always "Home". Kept in memory only: after a reload it is Home.
const HOME = { label: 'Back to Home', to: '/' }
let entry = null

// Called by the router after every move. Coming into a session's pages from a screen with the tab bar remembers that
// screen (with its query, so Home opens on the same meetup); moving about inside the session leaves it alone.
// How to call: router.afterEach((to, from) => rememberEntry(to, from))
export function rememberEntry(to, from) {
  if (!to?.path?.startsWith('/sessions/') || !from?.meta?.tabs) return
  entry = { label: from.meta.title ? `Back to ${from.meta.title}` : 'Back', to: from.fullPath || from.path }
}

// Where the button at the top left of a session leaves to: the remembered screen, or Home.
// How to call: exitFor() -> { label: 'Back to Sessions', to: '/sessions' }
export const exitFor = () => entry || HOME

// Forget the remembered screen (between tests).
// How to call: forgetEntry()
export function forgetEntry() {
  entry = null
}

// The path of a location given as a string or as { path }, without a query or hash.
// How to call: pathOf({ path: '/sessions/s1/plan', replace: true }) -> '/sessions/s1/plan'
export function pathOf(to) {
  const raw = typeof to === 'string' ? to : to?.path || ''
  return raw.split(/[?#]/)[0]
}

// Is the page behind this one in the browser's history at `to`?
// How to call: isBehind('/sessions/s1', { back: '/sessions/s1' }) -> true
export function isBehind(to, state = globalThis.history?.state) {
  const behind = typeof state?.back === 'string' ? pathOf(state.back) : ''
  return !!behind && behind === pathOf(to)
}

// Called first on a click on a link (as a capture listener, so it runs before the router's own handler, which leaves a
// click alone once it has been prevented). A plain left click on a link to the page behind this one goes Back; any other
// click (a new tab, a modifier key, a link to somewhere new) is left to the link.
// How to call: <RouterLink :to="to" @click.capture="goBackIfBehind($event, router, to)">
export function goBackIfBehind(event, router, to, state = globalThis.history?.state) {
  if (event.defaultPrevented || event.button || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return false
  if (!isBehind(to, state)) return false
  event.preventDefault()
  router.back()
  return true
}
