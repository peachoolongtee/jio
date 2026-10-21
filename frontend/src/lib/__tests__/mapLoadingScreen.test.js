// The spinner on screen (components/map/MapLoading.vue), drawn for real (domless.js): it says "Loading…" over the Locate map
// only. While it holds the map still it takes the map's clicks, taps and scrolls; it never listens to the keyboard, so the rest
// of the page carries on as usual.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mountScreen } from './domless.js'

let lib
let listeners
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  lib = await import('../pageLoading.js')
  // The window's listeners, as a browser keeps them, to show the spinner adds none.
  listeners = new Map()
  vi.stubGlobal('window', {
    addEventListener: (name, fn, capture) => listeners.set(`${name}:${capture}`, fn),
    removeEventListener: (name, fn, capture) => listeners.get(`${name}:${capture}`) === fn && listeners.delete(`${name}:${capture}`),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// Draw the spinner, with the same copy of lib/pageLoading.js the test drives.
// How to call: const view = await draw()
async function draw() {
  const { default: MapLoading } = await import('@/components/map/MapLoading.vue')
  return mountScreen(MapLoading)
}

describe('the spinner over the map', () => {
  it('is not there until confirming has run for 600 ms, then says Loading… and holds the map', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS - 1)
    expect(view.has('[data-testid="map-loading"]')).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const wash = view.one('[data-testid="map-loading"]')
    expect(view.text(wash)).toBe('Loading…')
    expect(wash.attrs.class).toContain('is-blocking')
    expect(wash.attrs['aria-busy']).toBe('true')
    stop()
    await vi.advanceTimersByTimeAsync(lib.MIN_SHOWN_MS)
    expect(view.has('[data-testid="map-loading"]')).toBe(false)
    view.unmount()
  })

  it('never listens to the keyboard, so the rest of the page can still be used', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    expect(view.has('[data-testid="map-loading"]')).toBe(true)
    expect(listeners.size).toBe(0)
    stop()
    view.unmount()
  })

  it('lets the map be used again after 20 seconds, still showing the spinner', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS + lib.MAX_BLOCK_MS)
    const wash = view.one('[data-testid="map-loading"]')
    expect(wash.attrs.class || '').not.toContain('is-blocking')
    stop()
    view.unmount()
  })

  it('covers its map pane, not the whole page, and sits above the map’s own layers', () => {
    const css = readFileSync(fileURLToPath(new URL('../../components/map/MapLoading.vue', import.meta.url)), 'utf8')
    const rule = css.match(/\.map-loading \{([^}]*)\}/)[1]
    expect(rule).toMatch(/position: absolute;/)
    expect(rule).not.toMatch(/position: fixed;/)
    expect(Number(rule.match(/z-index: (\d+)/)[1])).toBeGreaterThan(1000)
  })

  it('is drawn on the Locate page inside the map pane, and nowhere else', () => {
    const read = (path) => readFileSync(fileURLToPath(new URL(path, import.meta.url)), 'utf8')
    const locate = read('../../views/GroupDetailView.vue')
    const mapSlot = locate.slice(locate.indexOf('<template #map>'), locate.indexOf('</template>', locate.indexOf('<template #map>')))
    expect(mapSlot).toContain('<MapLoading />')
    expect(read('../../App.vue')).not.toMatch(/Loading \/>/)
  })
})

describe('the spinner over the map, under stress', () => {
  it('never adds a listener and never stays behind, however often it shows and hides', async () => {
    const view = await draw()
    for (let round = 0; round < 50; round += 1) {
      const stops = Array.from({ length: 1 + (round % 5) }, () => lib.startLoading())
      await vi.advanceTimersByTimeAsync(round % 2 ? lib.SLOW_MS : lib.SLOW_MS - 1)
      for (const stop of stops) stop()
      await vi.advanceTimersByTimeAsync(lib.MIN_SHOWN_MS)
      expect(listeners.size).toBe(0)
    }
    expect(view.has('[data-testid="map-loading"]')).toBe(false)
    view.unmount()
  })
})
