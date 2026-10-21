// The loading spinner over the Locate map (components/map/MapLoading.vue). It is used for one thing: confirming the meeting spot on
// Locate (the host confirms a spot, names a place the group already has, or takes the meeting area), which sets the
// spot and then ranks the places for the vote. Those actions in stores/events.js count themselves in with whileLoading.
// Nothing else shows it: changes of screen, other loads and planner requests have their own placeholders.
// The spinner shows only once something has been running for SLOW_MS without a break, so a quick confirm never flashes it.
// Once shown it stays for at least MIN_SHOWN_MS, so a load that ends just after it appears does not flash it either.
// While it is on screen the map cannot be used (pageBlocking): no clicks, taps or scrolling reach it; the rest of the page
// and the keyboard carry on. If the work
// is still running after MAX_BLOCK_MS, the map can be used again and the spinner stays until the work ends, so a load
// that hangs never traps anyone.
import { readonly, ref } from 'vue'

// How long the page may load before the spinner shows: past the point where most screens are on, before people start
// to wonder whether their tap worked (about a second).
export const SLOW_MS = 600

// The shortest time the spinner stays once shown.
export const MIN_SHOWN_MS = 400

// The longest the spinner holds the map still. Every planner request gives up after 15 seconds, so only a load that
// hangs gets this far.
export const MAX_BLOCK_MS = 20000

const running = ref(0)
const slow = ref(false)
const blocking = ref(false)
let showTimer = 0
let hideTimer = 0
let blockTimer = 0
let shownAt = 0

// True while the spinner should be on screen. Read-only: count work in with startLoading or whileLoading.
// How to call: if (pageSlow.value) …
export const pageSlow = readonly(slow)

// True while the spinner holds the map still: from when it shows until it hides, or until MAX_BLOCK_MS have passed.
// How to call: if (pageBlocking.value) …
export const pageBlocking = readonly(blocking)

// Put the spinner up, holding the map still for at most MAX_BLOCK_MS.
function show() {
  slow.value = true
  blocking.value = true
  shownAt = Date.now()
  clearTimeout(blockTimer)
  blockTimer = setTimeout(() => { blocking.value = false }, MAX_BLOCK_MS)
}

// Take the spinner down, and let the map be used again.
function hide() {
  slow.value = false
  blocking.value = false
  clearTimeout(blockTimer)
}

// Counts one piece of work in. Returns the function that counts it out again; calling that twice is harmless.
// How to call: const stop = startLoading(); try { … } finally { stop() }
export function startLoading() {
  running.value += 1
  if (running.value === 1) {
    // New work while the spinner is still held up for its minimum: it simply stays.
    clearTimeout(hideTimer)
    if (!slow.value) showTimer = setTimeout(show, SLOW_MS)
  }
  let stopped = false
  return () => {
    if (stopped) return
    stopped = true
    running.value -= 1
    if (running.value > 0) return
    clearTimeout(showTimer)
    if (!slow.value) return
    const left = MIN_SHOWN_MS - (Date.now() - shownAt)
    if (left > 0) hideTimer = setTimeout(hide, left)
    else hide()
  }
}

// Counts a promise in until it settles, and hands it back unchanged.
// How to call: const data = await whileLoading(fetchSomething())
export function whileLoading(promise) {
  const stop = startLoading()
  return Promise.resolve(promise).finally(stop)
}
