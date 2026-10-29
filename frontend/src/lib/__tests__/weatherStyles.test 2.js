// What the weather pieces' stylesheets promise, read from the files themselves because the suite has no browser: the rain on
// Home's map stands still under reduced motion and takes no pointer events, and uses ink alone. The looks are checked by eye
// in a browser (see the report for this change); these keep the promises from being edited away.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const MAP = read('../../components/ui/SingaporeMap.vue')

describe('the rain on Home\'s map, in its stylesheet', () => {
  it('takes no pointer events, so it never blocks pressing a pin', () => {
    expect(MAP).toMatch(/\.sgmap \{[^}]*pointer-events: none/)
  })

  it('moves only by one animation, and that one is switched off under reduced motion', () => {
    expect(MAP.match(/animation:[^;]*sgmap-fall/g)).toHaveLength(1)
    const reduced = MAP.slice(MAP.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.sgmap__drift \{ animation: none; \}/)
  })

  it('leaves the wash and the strokes themselves still', () => {
    expect(MAP).not.toMatch(/\.sgmap__wash[^{]*\{[^}]*animation/)
    expect(MAP).not.toMatch(/\.sgmap__stroke[^{]*\{[^}]*animation/)
  })

  it('draws in ink alone, so it adds no colour that means something else', () => {
    const rule = MAP.slice(MAP.indexOf('/* Rain: ink'), MAP.indexOf('/* Where someone starts'))
    expect(rule).toContain('var(--ink)')
    expect(rule).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    expect(rule).not.toMatch(/--cat-|--primary|--person-/)
  })

  it('loops the strokes by exactly one tile, so there is no seam', () => {
    const tile = Number(MAP.match(/const RAIN_TILE = (\d+)/)[1])
    expect(MAP).toContain(`@keyframes sgmap-fall { to { transform: translateY(${tile}px); } }`)
  })
})

describe('the weather source line and the rain banners, in their stylesheets', () => {
  it('use the design system\'s tokens: no colour written out', () => {
    for (const file of ['../../components/weather/WeatherSource.vue', '../../components/weather/RainBanners.vue', '../../components/weather/WeatherMark.vue']) {
      const css = read(file).split('<style')[1] || ''
      expect(css, file).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    }
  })
})
