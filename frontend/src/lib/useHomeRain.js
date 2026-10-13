// Home's rain, kept: asks the planner about the outings within two hours, and again every 30 minutes while there still is one.
// With no outing within two hours it does nothing at all: no request, no timer, no layer.
//   const rain = useHomeRain({ meetups, now, simulated, ask: api.weatherAt })
//   rain.view.value   // null, or { places, text, block } (lib/homeRain.js rainView)
// `meetups` is a ref of the going meetups (soonest first), `now` the shared clock (lib/useNow.js), `simulated` a ref of the demo's
// rain switch (a flip asks again at once), `ask(stops)` the data layer's weatherAt. The schedule is lib/weatherCheck.js: one
// request at a time, paused while the page is hidden, not renewed by focus changes. A failed request keeps the last answer.
// `check` (optional) is passed to the schedule, for a test that has no page to hide (`{ hidden, onVisibility, every }`).
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import { createWeatherCheck } from './weatherCheck.js'
import { outingsSoon, rainView, stopsFor } from './homeRain.js'

// How to call: const { view, failed } = useHomeRain({ meetups, now, simulated, ask })
export function useHomeRain({ meetups, now, simulated, ask, check = {} }) {
  const outings = computed(() => outingsSoon(meetups.value, now.value))
  // What a request would ask: it changes only when the places or the times do, not as the clock ticks.
  const key = computed(() => JSON.stringify(stopsFor(outings.value, now.value)))
  const answer = ref(null)
  const failed = ref(false)

  // One request for the outings now within two hours. The answer is kept only if the outings have not changed meanwhile.
  // How to call: await run()
  async function run() {
    const asked = key.value
    const stops = stopsFor(outings.value, now.value)
    if (!stops.length) return
    try {
      const result = await ask(stops)
      if (asked === key.value) answer.value = result
      failed.value = false
    } catch {
      failed.value = true
    }
  }

  const schedule = createWeatherCheck({ run, ...check })
  // What the check was last asked for, so a request made as the outing comes within two hours is not made twice.
  let askedFor = ''
  watch(
    () => outings.value.length > 0,
    (soon) => {
      if (soon) {
        askedFor = key.value
        return schedule.start()
      }
      schedule.stop()
      answer.value = null
      failed.value = false
    },
    { immediate: true },
  )
  // A different place or time, or the demo's rain switch, asks again at once.
  watch([key, simulated], ([asking, rain], [, was]) => {
    if (!schedule.active() || (asking === askedFor && rain === was)) return
    askedFor = asking
    schedule.poke()
  })
  onBeforeUnmount(() => schedule.stop())

  return { view: computed(() => (outings.value.length ? rainView(outings.value, answer.value) : null)), failed }
}
