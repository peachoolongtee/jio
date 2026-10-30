// The card on the Locate map is placed again when its own size changes (a new error line, a changed count), through sizeWatch.
// The suite has no browser, so a stand-in ResizeObserver is driven by hand; the pieces that cannot be run here (the card's
// placement on a real map, the busy look of the chip) are read from the files so they cannot be edited away.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sizeWatch } from '../sizeWatch.js'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

// A stand-in for ResizeObserver that keeps its instances, so a test can report a resize.
const seen = []
class FakeObserver {
  constructor(callback) {
    this.callback = callback
    this.observed = []
    this.disconnected = false
    seen.push(this)
  }
  observe(el) { this.observed.push(el) }
  disconnect() { this.disconnected = true }
}
const box = (w, h) => ({ offsetWidth: w, offsetHeight: h })

afterEach(() => {
  seen.length = 0
  vi.unstubAllGlobals()
})

describe('sizeWatch', () => {
  it('calls back when the element grows or shrinks, and not for the first report or a report of the same size', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    const onChange = vi.fn()
    const card = box(264, 120)
    sizeWatch(onChange).watch(card)
    expect(seen[0].observed).toEqual([card])
    seen[0].callback()
    expect(onChange).not.toHaveBeenCalled()
    card.offsetHeight = 148
    seen[0].callback()
    expect(onChange).toHaveBeenCalledTimes(1)
    seen[0].callback()
    expect(onChange).toHaveBeenCalledTimes(1)
    card.offsetHeight = 120
    seen[0].callback()
    expect(onChange).toHaveBeenCalledTimes(2)
  })

  it('watches one element at a time, keeps watching the same one, and lets go on stop', () => {
    vi.stubGlobal('ResizeObserver', FakeObserver)
    const watcher = sizeWatch(vi.fn())
    const first = box(264, 100)
    const second = box(264, 100)
    watcher.watch(first)
    watcher.watch(first)
    expect(seen).toHaveLength(1)
    watcher.watch(second)
    expect(seen[0].disconnected).toBe(true)
    expect(seen[1].observed).toEqual([second])
    watcher.stop()
    expect(seen[1].disconnected).toBe(true)
    watcher.stop()
  })

  it('does nothing where the page has no ResizeObserver, and for no element', () => {
    vi.stubGlobal('ResizeObserver', undefined)
    const watcher = sizeWatch(vi.fn())
    expect(() => { watcher.watch(box(1, 1)); watcher.watch(null); watcher.stop() }).not.toThrow()
    vi.stubGlobal('ResizeObserver', FakeObserver)
    sizeWatch(vi.fn()).watch(null)
    expect(seen).toHaveLength(0)
  })
})

describe('the map pin\'s card and its chip, in their files', () => {
  it('places the open card again whenever its size changes, and stops watching when it closes or the screen goes', () => {
    const pins = read('../../components/spots/SpotPins.vue')
    expect(pins).toMatch(/const resized = sizeWatch\(\(\) => place\(openId\.value\)\)/)
    expect(pins).toMatch(/resized\.watch\(card\)/)
    expect(pins).toMatch(/if \(!id\) return resized\.stop\(\)/)
    expect(pins).toMatch(/onBeforeUnmount\(\(\) => \{[^}]*resized\.stop\(\)/)
  })

  it('dims a chip that is saving, for the list\'s toggle and the card\'s alike', () => {
    const chip = read('../../components/ui/ChipButton.vue')
    expect(chip).toMatch(/\.chip\[aria-busy="true"\] \.chip__pill \{ opacity: 0\.6; \}/)
    expect(chip).toMatch(/\.chip\[aria-busy="true"\] \{ cursor: progress; \}/)
    expect(read('../../components/spots/SpotCard.vue')).toMatch(/:aria-busy="busy \? 'true' : undefined"/)
  })
})
