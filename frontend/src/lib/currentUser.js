// Who is signed in, as one id that anything can ask for. This is the one source: a screen, a store, a component and the
// data layer all read the person from here (or from `auth.user.id` / `auth.myId` in a component, which follows the same
// account reactively), and none of them holds an id of its own.
//
// It has no imports on purpose. lib/api.js owns the account (the saved copy, switching between accounts), so it hands
// this file a reader once, when it loads. The stores and helpers import this file and never lib/api.js's internals, and
// lib/api.js never imports a Pinia store, so neither depends on the other for a test.
//
// The demo account and a local account are the sample person (the id in lib/mock/people.js), so the demo data, the
// showcase and the tour read as they always did. A real account is its own Supabase user id.
// How to call: const me = currentUserId() -> 'ian' for the demo account, '7f3c...' (a uuid) for a real one, '' for nobody

let read = () => ''

// Give this file the function that says who is signed in. lib/api.js does this when it loads; a test may do it too.
// How to call: bindCurrentUser(() => db.user?.id ?? '')
export function bindCurrentUser(fn) {
  read = typeof fn === 'function' ? fn : () => ''
}

// The signed-in person's id, or '' when nobody is signed in. Never throws, and is always a string.
// How to call: const mine = sessions.filter((s) => s.hostId === currentUserId())
export function currentUserId() {
  const id = read()
  return typeof id === 'string' ? id : ''
}
