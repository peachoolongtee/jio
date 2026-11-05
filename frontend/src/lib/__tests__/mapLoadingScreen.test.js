// The spinner on screen (components/map/MapLoading.vue), drawn for real (domless.js): it says "Loading…" over the Locate map only.
// A screen reader hears it through one status region that is always there, empty until the spinner shows; the wash itself is for
// the eye. While it holds the map still it takes the map's clicks, taps and scrolls, and it has no keyboard handling of its own, so
// the rest of the page carries on as usual.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { mountScreen } from './domless.js'

let lib
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  lib = await import('../pageLoading.js')
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const WASH = '[data-testid="map-loading"]'
const STATUS = '[data-testid="map-loading-status"]'

// Draw the spinner, with the same copy of lib/pageLoading.js the test drives.
// How to call: const view = await draw()
async function draw() {
  const { default: MapLoading } = await import('@/components/map/MapLoading.vue')
  return mountScreen(MapLoading)
}

// An element and every element inside it.
// How to call: within(view.one(WASH))
const within = (node) => [node, ...node.children.flatMap(within)].filter((n) => n.kind === 'el')

describe('the spinner over the map', () => {
  it('is not there until confirming has run for 600 ms, then holds the map', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS - 1)
    expect(view.has(WASH)).toBe(false)
    await vi.advanceTimersByTimeAsync(1)
    const wash = view.one(WASH)
    expect(view.text(wash)).toBe('Loading…')
    expect(wash.attrs.class).toContain('is-blocking')
    stop()
    await vi.advanceTimersByTimeAsync(lib.MIN_SHOWN_MS)
    expect(view.has(WASH)).toBe(false)
    view.unmount()
  })

  it('has one status region that is there before the spinner, empty, and says Loading… while it shows', async () => {
    const view = await draw()
    const region = view.one(STATUS)
    expect(region.attrs.role).toBe('status')
    expect(region.attrs['aria-live']).toBe('polite')
    expect(view.text(region)).toBe('')
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    // The same element, now filled: a region inserted already filled is often not announced.
    expect(view.one(STATUS)).toBe(region)
    expect(view.text(region)).toBe('Loading…')
    stop()
    await vi.advanceTimersByTimeAsync(lib.MIN_SHOWN_MS)
    expect(view.one(STATUS)).toBe(region)
    expect(view.text(region)).toBe('')
    view.unmount()
  })

  it('keeps the wash out of the accessibility tree and says nothing is busy on the live region', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    const wash = view.one(WASH)
    expect(wash.attrs['aria-hidden']).toBe('true')
    expect(wash.attrs.role).toBeUndefined()
    expect(view.one(STATUS).attrs['aria-busy']).toBeUndefined()
    expect(view.all('[aria-busy]')).toEqual([])
    stop()
    view.unmount()
  })

  it('takes no keyboard focus and handles no key, so the rest of the page can still be used', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    const wash = view.one(WASH)
    const nodes = within(wash)
    expect(nodes.length).toBeGreaterThan(2)
    for (const node of nodes) {
      expect(node.attrs.tabindex).toBeUndefined()
      expect(Object.keys(node.listeners).filter((name) => /^key|^focus/.test(name))).toEqual([])
      expect(['button', 'a', 'input']).not.toContain(node.tag)
    }
    stop()
    view.unmount()
  })

  it('lets the map be used again after 20 seconds, still showing the spinner', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS + lib.MAX_BLOCK_MS)
    const wash = view.one(WASH)
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
  it('never stays behind, and leaves its status region empty, however often it shows and hides', async () => {
    const view = await draw()
    const region = view.one(STATUS)
    for (let round = 0; round < 50; round += 1) {
      const stops = Array.from({ length: 1 + (round % 5) }, () => lib.startLoading())
      await vi.advanceTimersByTimeAsync(round % 2 ? lib.SLOW_MS : lib.SLOW_MS - 1)
      expect(view.text(region)).toBe(round % 2 ? 'Loading…' : '')
      for (const stop of stops) stop()
      await vi.advanceTimersByTimeAsync(lib.MIN_SHOWN_MS)
      expect(view.text(region)).toBe('')
    }
    expect(view.has(WASH)).toBe(false)
    expect(view.one(STATUS)).toBe(region)
    view.unmount()
  })
})
