// The text on the light grey cards (the spot cards and the people card on Locate, walkthrough of 1 November 2026) and on the status
// badges, held to 4.5:1 (WCAG 1.4.3), worked out from the tokens in styles/tokens.css the way friendPickContrast.test.js does. The
// travel times on the people card were 4.48:1 (short) and 4.31:1 (long) on Surface Strong. No network.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8')
const tokens = read('../../styles/tokens.css')

// A token's colour, following var() references. How to call: token('--travel-short') -> '#157a38'
function token(name) {
  const value = tokens.match(new RegExp(`${name}:\\s*(#[0-9a-fA-F]{6}|var\\((--[a-z-]+)\\))`))
  if (!value) throw new Error(`No token ${name}`)
  return value[2] ? token(value[2]) : value[1]
}
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
// How to call: ratio('#222222', '#ffffff') -> 15.9
const ratio = (a, b) => {
  const [la, lb] = [luminance(rgb(a)), luminance(rgb(b))]
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05)
}

// The greys a card can be: the people card and the spot cards (Surface Strong), what a spot card turns on hover (Hairline Soft), and
// the quiet panel grey (Surface Soft), and white.
const GREYS = ['--surface-strong', '--hairline-soft', '--surface-soft', '--canvas']
// The text colours used on them: the grey words, the body words, the error words, and the travel times (short, middling, long).
const TEXT = ['--ink', '--body', '--muted', '--primary-error-text', '--travel-short', '--travel-medium-text', '--travel-long']

describe('text on the grey cards', () => {
  for (const grey of GREYS) {
    for (const text of TEXT) {
      it(`${text} on ${grey} is at least 4.5:1`, () => {
        expect(ratio(token(text), token(grey))).toBeGreaterThanOrEqual(4.5)
      })
    }
  }

  it('the people card and the spot cards are the grey these were worked out for, and the travel times use these tokens', () => {
    expect(read('../../views/GroupDetailView.vue')).toMatch(/\.people-card \{ background: var\(--surface-strong\)/)
    expect(read('../../components/spots/SpotRow.vue')).toMatch(/\.spot \{[^}]*background: var\(--surface-strong\)/)
    const list = read('../../components/group/MemberList.vue')
    for (const name of ['--travel-short', '--travel-medium-text', '--travel-long']) expect(list).toContain(`var(${name})`)
  })
})

describe('the status badges', () => {
  const states = [...tokens.matchAll(/--status-([a-z]+)-bg:/g)].map((m) => m[1])

  it('has the states the screens use', () => {
    expect(states).toEqual(expect.arrayContaining(['turn', 'voting', 'ready', 'planning', 'done', 'waiting', 'cancelled']))
  })

  for (const state of states) {
    it(`${state}: its words on its ground are at least 4.5:1`, () => {
      expect(ratio(token(`--status-${state}-fg`), token(`--status-${state}-bg`))).toBeGreaterThanOrEqual(4.5)
    })
  }
})
