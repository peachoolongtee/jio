// The bar heights a hover card is clamped to (lib/bars.js): the real ones, which include the safe-area inset, and the
// plain ones when the real ones cannot be read.
import { describe, expect, it } from 'vitest'
import { barHeights } from '../bars.js'

const styleOf = (values) => ({ getPropertyValue: (name) => values[name] ?? '' })

describe('barHeights', () => {
  it('reads the real heights, with the inset in them', () => {
    const style = styleOf({ '--topbar-real-height': '72px', '--tabbar-real-height': '122px', '--topbar-height': '72px', '--tabbar-height': '88px' })
    expect(barHeights(style)).toEqual({ top: 72, bottom: 122 })
  })

  it('reads a top inset on a phone, where the top bar itself is 0', () => {
    expect(barHeights(styleOf({ '--topbar-real-height': '47px', '--tabbar-real-height': '122px' }))).toEqual({ top: 47, bottom: 122 })
  })

  it('reads fractions', () => {
    expect(barHeights(styleOf({ '--topbar-real-height': ' 72.5px', '--tabbar-real-height': '0px' }))).toEqual({ top: 72.5, bottom: 0 })
  })

  it('falls back to the plain heights when the real ones read back as text, not px', () => {
    const style = styleOf({ '--topbar-real-height': 'calc(72px + env(safe-area-inset-top, 0px))', '--tabbar-real-height': '', '--topbar-height': '72px', '--tabbar-height': '88px' })
    expect(barHeights(style)).toEqual({ top: 72, bottom: 88 })
  })

  it('is 0 when nothing can be read', () => {
    expect(barHeights(styleOf({}))).toEqual({ top: 0, bottom: 0 })
  })
})
