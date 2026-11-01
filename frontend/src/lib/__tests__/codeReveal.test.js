// The voucher code under its peel-off sticker (review of 1 November 2026): the code stays on screen and selectable after the peel and
// after a copy, "Copied" is a brief note beside it, what is announced is outside the buttons, and the keyboard goes sticker, then Copy.
// Drawn for real on the in-memory page (domless.js). No network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mountScreen, until } from './domless.js'
import CodeReveal from '../../components/ui/CodeReveal.vue'

vi.setConfig({ testTimeout: 20000 })
afterEach(() => vi.unstubAllGlobals())

const props = { code: 'JIO-AAAA-BBBB', front: 'Show code', back: 'Peel to see your code', label: 'SGD 3 off any coffee' }
const draw = () => mountScreen(CodeReveal, { props })

describe('before the peel', () => {
  it('is one button named for the voucher, with the code nowhere on the page', async () => {
    const view = await draw()
    expect(view.one('[data-testid=code-peel]').attrs['aria-label']).toBe('Show code: SGD 3 off any coffee')
    expect(view.text()).not.toContain('JIO-AAAA-BBBB')
    expect(view.has('[data-testid=code-copy]')).toBe(false)
  })
})

describe('after the peel', () => {
  it('shows the code as text that a person can select, and a Copy button beside it', async () => {
    const view = await draw()
    await view.click('[data-testid=code-peel]')
    expect(view.text('[data-testid=code-text]')).toBe('JIO-AAAA-BBBB')
    expect(view.one('[data-testid=code-copy]').attrs['aria-label']).toBe('Copy code JIO-AAAA-BBBB, SGD 3 off any coffee')
    // The sticker is out of the accessibility tree and cannot be pressed again.
    expect(view.one('[data-testid=code-peel]').attrs['aria-hidden']).toBe('true')
    const source = readFileSync(new URL('../../components/ui/CodeReveal.vue', import.meta.url), 'utf8')
    expect(source.match(/\.reveal__code \{[^}]*\}/)[0]).toMatch(/user-select: all/)
    expect(source).not.toMatch(/\.reveal \{[^}]*user-select: none/)
  })

  it('keeps the code on screen when it is copied, says "Copied" beside it for a moment, then takes the note away', async () => {
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = await draw()
    await view.click('[data-testid=code-peel]')
    await view.click('[data-testid=code-copy]')
    expect(writeText).toHaveBeenCalledWith('JIO-AAAA-BBBB')
    expect(view.text('[data-testid=code-text]')).toBe('JIO-AAAA-BBBB')
    expect(view.text('[data-testid=code-copied]')).toBe('Copied')
    expect(view.text('[role=status]')).toBe('Copied')
    await until(() => !view.has('[data-testid=code-copied]'), 4000)
    expect(view.text('[data-testid=code-text]')).toBe('JIO-AAAA-BBBB')
    // A second copy works.
    await view.click('[data-testid=code-copy]')
    expect(writeText).toHaveBeenCalledTimes(2)
  })

  it('says to copy by hand when the browser refuses, and still shows the code', async () => {
    vi.stubGlobal('navigator', { clipboard: { writeText: vi.fn().mockRejectedValue(new Error('no')) } })
    const view = await draw()
    await view.click('[data-testid=code-peel]')
    await view.click('[data-testid=code-copy]')
    expect(view.text('[role=status]')).toContain('copy it by hand')
    expect(view.text('[data-testid=code-text]')).toBe('JIO-AAAA-BBBB')
    expect(view.has('[data-testid=code-copied]')).toBe(false)
  })

  it('has the live region outside both buttons, and never a button inside a button', async () => {
    const view = await draw()
    await view.click('[data-testid=code-peel]')
    const inside = (node, tag) => !!node && (node.tag === tag || inside(node.parent, tag))
    expect(inside(view.one('[role=status]'), 'button')).toBe(false)
    expect(view.all('button').filter((b) => inside(b.parent, 'button'))).toEqual([])
    expect(view.errors).toEqual([])
  })
})
