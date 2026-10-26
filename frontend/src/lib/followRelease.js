// Every session screen follows the host's change of the meeting place. When a session that was voting or confirmed goes back to locating (the
// host released the meeting area), a guest on Vote, Itinerary, What next?, the map or the photos is taken to Locate, where the host's notice is.
// For "We already know where" the session is locating for a moment and then voting at the new area (two writes on the server), so the move waits
// briefly and looks again: if the session is voting at the new area by then the guest goes to the Vote screen (where the notice is) rather than
// Locate; if it is still locating they go to Locate. A session that comes back to voting with that notice while a guest is on another screen
// (the Itinerary) goes to Vote at once.
// It is called once, by the app frame, so it applies to every session screen there is and will be. It acts on screens only, never on the session's
// own page (Locate), the host's change page, or the pages of a session that is not being watched.
//   useFollowRelease()
import { computed, onBeforeUnmount, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { useEventsStore } from '@/stores/events.js'

// The screens of a session that need the meeting area: their last path segment.
const SCREENS = ['plan', 'itinerary', 'roam', 'map', 'photos']
// How long a guest waits on a screen after the session went back to locating before it is moved (the known place follows within it).
export const FOLLOW_WAIT_MS = 2000

// How to call: useFollowRelease() inside the app frame's setup
export function useFollowRelease({ wait = FOLLOW_WAIT_MS } = {}) {
  const route = useRoute()
  const router = useRouter()
  const events = useEventsStore()
  const here = computed(() => {
    const m = /^\/sessions\/([^/]+)\/([^/]+)\/?$/.exec(route.path)
    return m && SCREENS.includes(m[2]) ? { id: decodeURIComponent(m[1]), screen: m[2] } : null
  })
  const session = computed(() => (here.value ? events.byId[here.value.id] : undefined))
  let timer = null

  // Look at the session now and go where it is: Locate while it is locating, Vote while it is voting (unless already there).
  // How to call: settle('s1')
  function settle(id) {
    if (here.value?.id !== id) return
    const status = events.byId[id]?.status
    if (status === 'locating') router.replace(`/sessions/${id}`)
    else if (status === 'voting' && here.value.screen !== 'plan') router.replace(`/sessions/${id}/plan`)
  }

  watch([() => here.value?.id, () => session.value?.status], ([id, now], [before, was]) => {
    if (!id) {
      clearTimeout(timer)
      return
    }
    // A new page, not a change of the same session's status.
    if (id !== before) return
    if (now === 'locating' && ['voting', 'confirmed'].includes(was)) {
      clearTimeout(timer)
      timer = setTimeout(() => settle(id), wait)
    } else if (now === 'voting' && ['locating', 'confirmed'].includes(was) && session.value?.banner?.released) {
      clearTimeout(timer)
      settle(id)
    }
  })
  onBeforeUnmount(() => clearTimeout(timer))
}
