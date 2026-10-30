// The colours of the friend pick list and of a pending row, held to 4.5:1 (WCAG 1.4.3), worked out from the tokens in styles/tokens.css
// and read from the styles of the components, so a change to either is caught. No network.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8')
const tokens = read('../../styles/tokens.css')
const token = (name) => tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6})`))[1]

// How to call: rgb('#ff385c') -> [255, 56, 92]
const rgb = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))
// How to call: luminance([255, 255, 255]) -> 1
const luminance = (c) => {
  const [r, g, b] = c.map((v) => {
    const x = v / 255
    return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * r + 0.7152 * g + 0.0722 * b
}
// How to call: ratio(rgb('#222222'), [255, 255, 255]) -> 15.9
const ratio = (a, b) => (Math.max(luminance(a), luminance(b)) + 0.05) / (Math.min(luminance(a), luminance(b)) + 0.05)
// color-mix(in srgb, A p%, white): how to call: tint(rgb('#ff385c'), 0.1)
const tint = (c, p) => c.map((v) => Math.round(v * p + 255 * (1 - p)))

describe('contrast on the invite screens', () => {
  const badge = read('../../components/group/OutingsTogether.vue')

  it("the outings-together pill's text reaches 4.5:1 on its 10% tint", () => {
    const rule = badge.match(/\.together \{[^}]*\}/)[0]
    expect(rule).toContain('color-mix(in srgb, var(--primary) 10%, var(--canvas))')
    const colour = rule.match(/color: var\((--[a-z-]+)\)/)[1]
    expect(ratio(rgb(token(colour)), tint(rgb(token('--primary')), 0.1))).toBeGreaterThanOrEqual(4.5)
  })

  it('a pending row keeps its text colours at full strength, and fades only the picture', () => {
    const lobby = read('../../views/GroupDetailView.vue')
    const rules = lobby.match(/\.lobby__row\.is-pending[^{]*\{[^}]*\}/g).join('\n')
    expect(rules).not.toMatch(/\.lobby__who[^{]*\{[^}]*opacity/)
    expect(ratio(rgb(token('--muted')), [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
    expect(ratio(rgb(token('--body')), [255, 255, 255])).toBeGreaterThanOrEqual(4.5)
  })
})
