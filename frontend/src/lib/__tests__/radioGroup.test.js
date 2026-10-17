import { describe, expect, it } from 'vitest'
import { moveIndex, tabStopIndex } from '../radioGroup.js'

describe('moveIndex', () => {
  const three = [{}, {}, {}]

  it('moves forward with Right and Down, and back with Left and Up', () => {
    expect(moveIndex(three, 0, 'ArrowRight')).toBe(1)
    expect(moveIndex(three, 0, 'ArrowDown')).toBe(1)
    expect(moveIndex(three, 2, 'ArrowLeft')).toBe(1)
    expect(moveIndex(three, 2, 'ArrowUp')).toBe(1)
  })

  it('wraps round at either end', () => {
    expect(moveIndex(three, 2, 'ArrowRight')).toBe(0)
    expect(moveIndex(three, 0, 'ArrowLeft')).toBe(2)
  })

  it('skips disabled radios, natively or with aria-disabled', () => {
    const items = [{}, { disabled: true }, { ariaDisabled: true }, {}]
    expect(moveIndex(items, 0, 'ArrowRight')).toBe(3)
    expect(moveIndex(items, 3, 'ArrowRight')).toBe(0)
    expect(moveIndex(items, 0, 'ArrowLeft')).toBe(3)
  })

  it('goes to the first and last enabled radios on Home and End', () => {
    const items = [{ disabled: true }, {}, {}, { ariaDisabled: true }]
    expect(moveIndex(items, 2, 'Home')).toBe(1)
    expect(moveIndex(items, 1, 'End')).toBe(2)
  })

  it('leaves other keys, and sets with nothing enabled, alone', () => {
    expect(moveIndex(three, 0, 'Tab')).toBe(-1)
    expect(moveIndex(three, 0, ' ')).toBe(-1)
    expect(moveIndex([{ disabled: true }, { ariaDisabled: true }], 0, 'ArrowRight')).toBe(-1)
  })

  it('moves from a disabled radio that has focus', () => {
    expect(moveIndex([{ ariaDisabled: true }, {}], 0, 'ArrowRight')).toBe(1)
  })
})

describe('tabStopIndex', () => {
  it('is the chosen radio', () => {
    expect(tabStopIndex([{ checked: false }, { checked: true }, { checked: false }])).toBe(1)
  })

  it('stays on the chosen radio while it is disabled, so focus is not lost during a request', () => {
    expect(tabStopIndex([{ ariaDisabled: true }, { checked: true, ariaDisabled: true }])).toBe(1)
  })

  it('is the first enabled radio when none is chosen', () => {
    expect(tabStopIndex([{ disabled: true }, {}, {}])).toBe(1)
  })

  it('is the first radio when none is chosen or enabled, and none for an empty set', () => {
    expect(tabStopIndex([{ disabled: true }, { ariaDisabled: true }])).toBe(0)
    expect(tabStopIndex([])).toBe(-1)
  })
})
