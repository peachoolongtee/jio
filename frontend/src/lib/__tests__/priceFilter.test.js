// The Vote page's price filter (lib/priceFilter.js): which prices pass "Up to $" and "Up to $$", and the note under a cut-down category.
import { describe, expect, it } from 'vitest'
import { PRICE_LIMITS, priceNote, tierOfPrice, withinPrice } from '../priceFilter.js'

describe('tierOfPrice', () => {
  it('uses the same tiers as the $ marks on the cards', () => {
    expect(tierOfPrice(0)).toBe(1)
    expect(tierOfPrice(9.5)).toBe(1)
    expect(tierOfPrice(10)).toBe(2)
    expect(tierOfPrice(25)).toBe(2)
    expect(tierOfPrice(25.5)).toBe(3)
  })

  it('is null when the price is not known', () => {
    expect(tierOfPrice(null)).toBeNull()
    expect(tierOfPrice(undefined)).toBeNull()
  })
})

describe('withinPrice', () => {
  it('lets everything through when there is no limit', () => {
    expect(withinPrice(60, 0)).toBe(true)
  })

  it('"$" keeps only places under SGD 10', () => {
    expect(withinPrice(8, 1)).toBe(true)
    expect(withinPrice(12, 1)).toBe(false)
  })

  it('"$$" keeps places up to SGD 25 and drops dearer ones', () => {
    expect(withinPrice(8, 2)).toBe(true)
    expect(withinPrice(25, 2)).toBe(true)
    expect(withinPrice(30, 2)).toBe(false)
  })

  it('keeps a place whose price is not known', () => {
    expect(withinPrice(null, 1)).toBe(true)
    expect(withinPrice(undefined, 2)).toBe(true)
  })
})

describe('the chips and the note', () => {
  it('offers the two limits that hide something', () => {
    expect(PRICE_LIMITS.map((p) => p.label)).toEqual(['$', '$$'])
  })

  it('says what is hidden, in the singular and the plural, and nothing when nothing is', () => {
    expect(priceNote(2, 3)).toBe('Only places up to SGD 25. 3 others are hidden.')
    expect(priceNote(1, 1)).toBe('Only places under SGD 10. 1 other is hidden.')
    expect(priceNote(1, 0)).toBe('')
    expect(priceNote(0, 4)).toBe('')
  })
})
