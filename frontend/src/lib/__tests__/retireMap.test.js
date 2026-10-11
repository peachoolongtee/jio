// Taking a map down without the error Leaflet throws when its zoom timer finds the map gone (see components/map/retireMap.js).
import { describe, expect, it, vi } from 'vitest'
import { REMOVE_AFTER_MS, ZOOM_TIMER_MS, retireMap } from '../../components/map/retireMap.js'

// A map that notes what it was asked, and fails like Leaflet does when its pane is gone and a timer still runs.
function fakeMap() {
  const note = []
  let removed = false
  return {
    note,
    off: (events, handler) => note.push(['off', events, handler]),
    stop: () => note.push(['stop']),
    remove: () => { removed = true; note.push(['remove']) },
    // What Leaflet's own timer does 250 ms after a zoom starts.
    zoomTimer() {
      if (removed) throw new TypeError("Cannot read properties of undefined (reading '_leaflet_pos')")
    },
  }
}

describe('retireMap', () => {
  it('stops the map and lets go of the listener at once, and removes the map only after Leaflet\'s zoom timer has run', () => {
    vi.useFakeTimers()
    const map = fakeMap()
    const handler = () => {}
    // A zoom started just before the page was left: Leaflet's timer is due ZOOM_TIMER_MS from then.
    setTimeout(() => map.zoomTimer(), ZOOM_TIMER_MS)
    retireMap(map, 'move zoom', handler)
    expect(map.note).toEqual([['off', 'move zoom', handler], ['stop']])
    vi.advanceTimersByTime(ZOOM_TIMER_MS)
    expect(map.note).toEqual([['off', 'move zoom', handler], ['stop']])
    vi.advanceTimersByTime(REMOVE_AFTER_MS - ZOOM_TIMER_MS)
    expect(map.note.at(-1)).toEqual(['remove'])
    vi.useRealTimers()
  })

  it('would have thrown if the map had been removed first', () => {
    vi.useFakeTimers()
    const map = fakeMap()
    let thrown = null
    setTimeout(() => { try { map.zoomTimer() } catch (err) { thrown = err } }, ZOOM_TIMER_MS)
    map.remove()
    vi.advanceTimersByTime(ZOOM_TIMER_MS)
    expect(thrown).toBeInstanceOf(TypeError)
    vi.useRealTimers()
  })

  it('waits longer than Leaflet\'s timer, and takes the timer to wait with', () => {
    expect(REMOVE_AFTER_MS).toBeGreaterThan(ZOOM_TIMER_MS)
    const waits = []
    retireMap(fakeMap(), 'move', () => {}, (fn, ms) => waits.push(ms))
    expect(waits).toEqual([REMOVE_AFTER_MS])
  })
})
