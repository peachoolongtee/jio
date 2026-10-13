// Which of the signed-in person's sessions the lists show. Home, Sessions and the Profile screen's list read the sessions
// through visibleSessions(), which hands them back as they are unless something has installed a filter. Only the demo tour
// does (tour/store.js), so that the eight saves of one outing do not show as eight meetups. A build with no tour never
// installs one, and the lists are exactly what the store holds.
//   const shown = computed(() => visibleSessions(events.sessions))
import { shallowRef } from 'vue'

const filter = shallowRef(null)

// Install a filter, a function from a list of sessions to the ones to show, or remove it with null. It is read inside the
// callers' computed values, so a change in what the filter reads (or swapping the filter) redraws them.
// How to call: setSessionFilter((sessions) => sessions.filter((s) => s.id !== 's3')) ... setSessionFilter(null)
export function setSessionFilter(fn) {
  filter.value = fn
}

// The sessions to show.
// How to call: visibleSessions(events.sessions)
export function visibleSessions(sessions) {
  return filter.value ? filter.value(sessions) : sessions
}
