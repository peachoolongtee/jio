// The voucher code under Your vouchers: the code stays on screen and selectable after a copy, "Copied" is a brief note beside it, and what is
// announced is outside the button. Drawn for real on the in-memory page (domless.js). No network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { mountScreen, until } from './domless.js'
import CopyCode from '../../components/ui/CopyCode.vue'

vi.setConfig({ testTimeout: 20000 })
afterEach(() => vi.unstubAllGlobals())

const draw = () => mountScreen(CopyCode, { props: { code: 'JIO-AAAA-BBBB', label: 'SGD 3 off any coffee' } })

describe('a code to copy', () => {
  it('shows the code as text that a person can select, and a Copy button named for the voucher', async () => {
    const view = await draw()
    expect(view.text('[data-testid=code-text]')).toBe('JIO-AAAA-BBBB')
    expect(view.one('[data-testid=code-copy]').attrs['aria-label']).toBe('Copy code JIO-AAAA-BBBB, SGD 3 off any coffee')
    const source = readFileSync(new URL('../../components/ui/CopyCode.vue', import.meta.url), 'utf8')
    expect(source.match(/\.copy-code__text \{[^}]*\}/)[0]).toMatch(/user-select: all/)
  })

  it('keeps the code on screen when it is copied, says "Copied" beside it for a moment, then takes the note away', async () => {
    const writeText = vi.fn().mockResolvedValue()
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    const view = await draw()
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
    await view.click('[data-testid=code-copy]')
    expect(view.text('[role=status]')).toContain('copy it by hand')
    expect(view.text('[data-testid=code-text]')).toBe('JIO-AAAA-BBBB')
    expect(view.has('[data-testid=code-copied]')).toBe(false)
  })

  it('has the live region outside the button', async () => {
    const view = await draw()
    const inside = (node, tag) => !!node && (node.tag === tag || inside(node.parent, tag))
    expect(inside(view.one('[role=status]'), 'button')).toBe(false)
    expect(view.errors).toEqual([])
  })
})
