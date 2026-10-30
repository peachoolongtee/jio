// Friend requests for the demo and local accounts (walkthrough, 30 October 2026): "Add friend" sends a request, which the other person
// accepts after FRIEND_ACCEPT_MS, and only then are they a friend. The sample people cannot answer, so the answer is simulated. One set
// of requests for the whole app, so a request sent from Home's "Add friends" sheet reads "Requested" on the profile's Suggested too,
// and the other way round, and one polite line of words for screen readers ("Friend request sent to Kai", then "Kai accepted your
// friend request"). The acceptance happens even if the screen that sent it has closed.
import { ref } from 'vue'

// How long the other person takes to accept, in ms.
export const FRIEND_ACCEPT_MS = 2000

// The people with a request waiting, by id, and the words a status line says.
const requested = ref(new Set())
const announcement = ref('')

// Sends a friend request to `person` ({ id, name }). After `after` ms it is accepted: `setFriend(id, true)` makes them a friend (the
// groups store's), then `onAccepted(id)` runs; if that write fails, `onFailed(message)` does. A second request to someone waiting is
// ignored. Resolves once the request is answered.
// How to call: await sendFriendRequest({ id: 'kai', name: 'Kai' }, groups.setFriend, { onAccepted: (id) => added.add(id) })
export function sendFriendRequest(person, setFriend, { after = FRIEND_ACCEPT_MS, onAccepted = () => {}, onFailed = () => {} } = {}) {
  if (requested.value.has(person.id)) return Promise.resolve()
  requested.value = new Set([...requested.value, person.id])
  announcement.value = `Friend request sent to ${person.name}`
  return new Promise((resolve) => {
    setTimeout(async () => {
      try {
        await setFriend(person.id, true)
        announcement.value = `${person.name} accepted your friend request`
        onAccepted(person.id)
      } catch (e) {
        onFailed(e?.message || 'Could not add them. Try again.')
      } finally {
        const left = new Set(requested.value)
        left.delete(person.id)
        requested.value = left
        resolve()
      }
    }, after)
  })
}

// The requests waiting and the status line's words, for a screen to show.
// How to call: const { requested, announcement } = useFriendRequests()
export function useFriendRequests() {
  return { requested, announcement }
}
