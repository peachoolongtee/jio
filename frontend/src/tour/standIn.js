// The stand-in planner for the tour (components/dev/offlinePlanner.js), kept on for as long as the tour is. A deployed demo may
// be opened while its backend is asleep, and the tour must still work: whenever the real planner gives no answer of its own
// (no response, or a proxy's bare 5xx) the stand-in answers every request the screens make, deterministically and roughly.
// When the real backend answers, its answer is used. Nothing here runs for a real account: the tour store only starts it for
// the demo account.
//   startStandIn(api.api, (source) => (last = source))   ...   stopStandIn()
import { useOfflinePlanner } from '@/components/dev/offlinePlanner.js'

// How long to wait for a backend that may be asleep, and how long to leave it alone after it gave no answer.
export const GIVE_UP_MS = 8000
export const COOL_DOWN_MS = 45000

let installed = null

// Is the stand-in on? How to call: standInOn() -> true
export const standInOn = () => installed !== null

// Install it on the planner's client. Starting it twice keeps the first. `backend: false` is for a build that has no backend
// address: the stand-in answers at once and the client's guard against calling the page's own host does not get in the way.
// How to call: startStandIn(client, (source) => (lastSource.value = source), { backend: !!client.defaults.baseURL })
export function startStandIn(client, onAnswer, { backend = true, now } = {}) {
  if (installed) return installed
  const noAddress = !backend && !client.defaults.baseURL
  const previousBase = client.defaults.baseURL
  // The client refuses a request with no base address in a production build, before it reaches any adapter. A placeholder
  // address gets it through; the stand-in answers without sending anything.
  if (noAddress) client.defaults.baseURL = 'http://planner.invalid'
  const offline = useOfflinePlanner(client, { everything: true, backend, giveUpMs: GIVE_UP_MS, coolDownMs: COOL_DOWN_MS, onAnswer, now })
  installed = {
    offline,
    stop() {
      offline.restore()
      if (noAddress) client.defaults.baseURL = previousBase
    },
  }
  return installed
}

// Take it off. Safe when it is not on.
// How to call: stopStandIn()
export function stopStandIn() {
  installed?.stop()
  installed = null
}
