import { describe, expect, it } from 'vitest'
import { wrapTab } from '../useFocusTrap.js'

describe('wrapTab', () => {
  const panel = { name: 'panel' }
  const [a, b, c] = [{ name: 'a' }, { name: 'b' }, { name: 'c' }]
  const items = [a, b, c]

  it('wraps from the last item to the first on Tab', () => {
    expect(wrapTab(items, c, panel, false)).toBe(a)
  })

  it('wraps from the first item, or the panel itself, to the last on Shift+Tab', () => {
    expect(wrapTab(items, a, panel, true)).toBe(c)
    expect(wrapTab(items, panel, panel, true)).toBe(c)
  })

  it('leaves Tab alone in the middle of the panel', () => {
    expect(wrapTab(items, b, panel, false)).toBeNull()
    expect(wrapTab(items, b, panel, true)).toBeNull()
    expect(wrapTab(items, a, panel, false)).toBeNull()
  })

  it('does nothing when the panel has nothing to focus', () => {
    expect(wrapTab([], panel, panel, false)).toBeNull()
    expect(wrapTab([], panel, panel, true)).toBeNull()
  })

  it('keeps focus on a single control', () => {
    expect(wrapTab([a], a, panel, false)).toBe(a)
    expect(wrapTab([a], a, panel, true)).toBe(a)
  })
})
