// Taking a Leaflet map down without the error "Cannot read properties of undefined (reading '_leaflet_pos')".
//
// Leaflet ends a zoom animation with a timer it cannot cancel: 250 ms after the zoom starts it moves the map to its final view,
// which reads the map pane. Removing the map before then deletes the pane, and the timer throws. Leaving a page while the map
// is still gliding (a page that fits the view as it opens, then is left at once) does exactly that. So a map that is leaving
// stops moving and lets go of our listeners at once, and is removed only after the longest timer Leaflet may still hold.

// Leaflet's own timer for the end of a zoom (src/map/Map.js), and a little more.
export const ZOOM_TIMER_MS = 250
export const REMOVE_AFTER_MS = ZOOM_TIMER_MS + 50

// Stop the map, stop listening to it, and remove it once Leaflet's timers have run. `wait` is setTimeout (a test passes its own).
// How to call: retireMap(map, 'move zoom moveend zoomend resize', onView)
export function retireMap(map, events, handler, wait = setTimeout) {
  map.off(events, handler)
  map.stop()
  wait(() => map.remove(), REMOVE_AFTER_MS)
}
