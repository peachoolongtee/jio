// The schedule of the weather check on the day: ask when a screen opens, and again every 30 minutes while it stays open.
// It knows nothing of weather or Vue; it only decides when `run` is called, so it can be tested with a fake clock.
//   - One check at a time. A check asked for while another is running waits for it and runs once more afterwards.
//   - The next check is 30 minutes after the last one finished, so a slow answer never piles checks up.
//   - A hidden page does not check. When the 30 minutes pass while it is hidden, one check is made as it becomes visible
//     again, however long it was away. Switching windows (focus and blur) does nothing.
//   - `stop()` ends it for good: no timer, no listener, no later check.
// A `run` that throws is not retried early: the caller keeps its last answer, and the next check is on schedule.

export const CHECK_EVERY_MS = 30 * 60 * 1000

// Is the page hidden right now? In a browser, the Page Visibility API; with no document (a test), never.
// How to call: pageHidden() -> false
export const pageHidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden'

// Call `listener` whenever the page is shown or hidden. Returns a function that stops listening.
// How to call: const off = onVisibility(() => {}); off()
export function onVisibility(listener) {
  if (typeof document === 'undefined') return () => {}
  document.addEventListener('visibilitychange', listener)
  return () => document.removeEventListener('visibilitychange', listener)
}

// Options:
//   run          async () => {}: makes one check. Required.
//   every        ms between the end of one check and the start of the next (30 minutes).
//   hidden       () => boolean: is the page hidden? (pageHidden)
//   onVisibility (listener) => stop: tells it when the page is shown or hidden (the document's).
// Returns { start, stop, poke, active }.
//   start()  begins: checks now (or when the page is next visible) and then on schedule. Does nothing if already started.
//   poke()   asks for a check now, for a reason of the screen's own (the simulated rain went on). Runs after the check
//            that is running, if one is.
//   stop()   ends it.
//   active() is it started?
// How to call:
//   const check = createWeatherCheck({ run: () => events.checkWeather(id) })
//   check.start()   // when the itinerary opens on its day
//   check.stop()    // when the page is left
export function createWeatherCheck({ run, every = CHECK_EVERY_MS, hidden = pageHidden, onVisibility: listen = onVisibility }) {
  let on = false
  let timer = null
  let running = false
  let again = false
  let due = false
  let unlisten = () => {}

  // Make one check, then plan the next. A request made while one is running runs once more afterwards.
  // How to call: await go()
  async function go() {
    if (!on) return
    if (running) {
      again = true
      return
    }
    running = true
    due = false
    again = false
    clearTimeout(timer)
    try {
      await run()
    } catch {
      // The caller keeps the last answer; the next check is on schedule.
    }
    running = false
    if (!on) return
    if (again) return go()
    timer = setTimeout(tick, every)
  }

  // The 30 minutes are up: check now, or when the page is next visible.
  // How to call: tick()
  function tick() {
    if (!on) return
    if (hidden()) due = true
    else go()
  }

  // The page was shown or hidden. A check that fell due while it was hidden is made now, once.
  // How to call: seen()
  function seen() {
    if (on && due && !hidden()) go()
  }

  return {
    start() {
      if (on) return
      on = true
      unlisten = listen(seen)
      tick()
    },
    poke() {
      if (on) tick()
    },
    stop() {
      on = false
      due = false
      again = false
      clearTimeout(timer)
      timer = null
      unlisten()
      unlisten = () => {}
    },
    active: () => on,
  }
}
