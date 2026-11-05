// The one way to confirm a meeting spot from the Locate screen, shared by the footer's button (SpotConfirm) and the host's button on a
// pin's card on the map (SpotCard), so the phone path, where the map's button is the near one, warns just as the footer does. When some
// people have not shared where they start, a press asks "Confirm <area> without everyone?" first, naming them; the question is held in
// the events store (`confirmAsk`) and shown by SpotConfirm, which stays on the page when a card closes. Otherwise the spot is confirmed at once.
import { computed, ref } from 'vue'
import { useEventsStore, waitingFor } from '@/stores/events.js'

// The sentence that names the people the host would be going without.
// How to call: missingSentence(['Faith', 'Nicole']) -> 'Faith and Nicole have'
export function missingSentence(list) {
  if (list.length <= 2) return `${list.join(' and ')} ${list.length === 1 ? 'has' : 'have'}`
  return `${list.slice(0, 2).join(', ')} and ${list.length - 2} ${list.length - 2 === 1 ? 'other' : 'others'} have`
}

// The confirm, as the host.
// How to call: const { saving, press, confirm } = useSpotConfirm(); const message = await press(session, 'bugis', (id) => name)
export function useSpotConfirm() {
  const events = useEventsStore()
  const working = ref(false)
  // A confirm is running, started here or anywhere else on the screen.
  const saving = computed(() => working.value || events.confirming)

  // Settle on a spot. Resolves to '' when it was saved, to the data layer's message when it was refused (nothing was saved), and to
  // undefined when it was not run because a confirm is already running.
  // How to call: const message = await confirm('s1', 'bugis')
  async function confirm(sessionId, areaId) {
    events.confirmAsk = null
    if (saving.value) return undefined
    working.value = true
    try {
      await events.confirmSpot(sessionId, areaId)
      return ''
    } catch (e) {
      return e?.message || 'Could not confirm. Try again.'
    } finally {
      working.value = false
    }
  }

  // The button: ask first when anyone has not shared a start (and resolve to undefined, nothing having been saved), otherwise confirm.
  // How to call: const message = await press(session, 'bugis', (id) => 'Faith')
  async function press(session, areaId, names = (id) => id) {
    if (!areaId || saving.value) return undefined
    const missing = waitingFor(session).map((id) => names(id))
    if (missing.length) {
      events.confirmAsk = { sessionId: session.id, areaId, text: missingSentence(missing) }
      return undefined
    }
    return confirm(session.id, areaId)
  }

  return { saving, working, confirm, press }
}
