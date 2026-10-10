// The ring of the time picker: how far it reaches, and how far the page scrolls to keep it clear of a sticky footer.
import { describe, expect, it } from 'vitest'
import { RING_REACH, ringScroll } from '../../components/ui/RadialTimePicker.vue'

describe('the ring', () => {
  it('reaches 141px above and below the middle of the time: the lowest button sits 113px out and is 56px tall', () => {
    expect(RING_REACH).toBe(141)
  })
})

describe('scrolling the ring clear of the bars over the page', () => {
  const view = { top: 0, bottom: 712 } // a sticky footer starting 712px down
  it('does nothing when the ring and a 12px gap fit', () => {
    expect(ringScroll(400, RING_REACH, view)).toBe(0)
    // Exactly at the limit: 559 + 141 + 12 = 712.
    expect(ringScroll(559, RING_REACH, view)).toBe(0)
  })

  it('scrolls down by what the ring pokes under the footer, plus the gap', () => {
    expect(ringScroll(700, RING_REACH, view)).toBe(141)
    expect(ringScroll(560, RING_REACH, view)).toBe(1)
  })

  it('scrolls up when the ring pokes above the top', () => {
    expect(ringScroll(100, RING_REACH, view)).toBe(-53)
    expect(ringScroll(100, RING_REACH, { top: 72, bottom: 712 })).toBe(-125)
  })

  it('lines the top of a ring that is too tall for the space up instead of the bottom', () => {
    // 282px of ring in a 300px strip with a 12px gap each side: it does not fit, so its top (159) goes to 162.
    expect(ringScroll(300, RING_REACH, { top: 150, bottom: 450 })).toBe(-3)
  })

  it('has no footer to avoid when the footer is below the window: the window itself is the limit', () => {
    expect(ringScroll(600, RING_REACH, { top: 0, bottom: 800 })).toBe(0)
    expect(ringScroll(700, RING_REACH, { top: 0, bottom: 800 })).toBe(53)
  })
})
