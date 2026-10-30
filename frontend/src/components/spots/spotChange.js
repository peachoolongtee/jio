// The one way to change the meeting spots as the signed-in person, shared by the list (SpotList) and the map's card
// (SpotCard): the same events store actions, and one "saving" flag for both, so a press on the map never overlaps a change
// started in the list, or a confirm from anywhere on the screen.
import { computed, ref } from 'vue'
import { useEventsStore } from '@/stores/events.js'

// A change of the spots is being saved, from the list or from the map. One flag for every list and card on the page.
const changing = ref(false)

// The saving flag and the changes, as the signed-in person.
// How to call: const { busy, changing, run, approve } = useSpotChange()
export function useSpotChange() {
  const events = useEventsStore()
  // A change of the spots, or a confirm from anywhere, is being saved.
  const busy = computed(() => changing.value || events.confirming)

  // Run a change. Resolves to '' when it was saved, to the data layer's message when it was refused (the write has rolled
  // back), and to undefined when it was not run because another change is still being saved.
  // How to call: const message = await run(() => events.withdrawMySpot('s1'))
  async function run(fn) {
    if (busy.value) return undefined
    changing.value = true
    try {
      await fn()
      return ''
    } catch (e) {
      return e.message
    } finally {
      changing.value = false
    }
  }

  // "Works for me" on a spot, or taking it back.
  // How to call: const message = await approve('s1', 'bugis', true)
  const approve = (sessionId, areaId, on) => run(() => events.approveMySpot(sessionId, areaId, on))

  return { busy, changing, run, approve }
}
