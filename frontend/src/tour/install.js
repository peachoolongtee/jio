// Start the demo tour's part of the app, before the first screen is drawn: read the saved tour, check it against the data, put
// the lists' filter in place. Loaded by main.js only in a build that has the tour (lib/tourFlag.js).
// How to call: await installTour(pinia)
import { useTourStore } from './store.js'

export async function installTour(pinia) {
  await useTourStore(pinia).attach()
}
