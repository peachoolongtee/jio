// What the weather pieces' stylesheets promise, read from the files themselves because the suite has no browser: the rain on
// Home's map stands still under reduced motion and takes no pointer events, and uses ink alone. The looks are checked by eye
// in a browser (see the report for this change); these keep the promises from being edited away.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')
const MAP = read('../../components/ui/SingaporeMap.vue')

const RAIN = read('../../styles/rain.css')
const TOKENS = read('../../styles/tokens.css')
const CHIP = read('../../components/weather/RainChip.vue')
const PLANNER_MAP = read('../../components/map/PlannerMap.vue')

describe('the rain on the maps, in its stylesheets', () => {
  it('takes no pointer events, so it never blocks pressing a pin', () => {
    expect(MAP).toMatch(/\.sgmap \{[^}]*pointer-events: none/)
    expect(RAIN).toMatch(/\.rain-patch \{[^}]*pointer-events: none/)
    expect(PLANNER_MAP).toMatch(/\.pm-rain \{[^}]*pointer-events: none/)
    expect(CHIP).toMatch(/\.rain-chip \{[^}]*pointer-events: none/)
  })

  it('moves only by transform and opacity, and both animations are switched off under reduced motion', () => {
    const keyframes = RAIN.match(/@keyframes [\w-]+ \{[^\n]*\}/g)
    expect(keyframes).toHaveLength(2)
    for (const frame of keyframes) expect(frame).toMatch(/^@keyframes [\w-]+ \{ (from \{ opacity: 0; \} to \{ opacity: 1; \}|to \{ transform: translateY\(var\(--rain-h, 0px\)\); \}) \}$/)
    const reduced = RAIN.slice(RAIN.indexOf('@media (prefers-reduced-motion: reduce)'))
    expect(reduced).toMatch(/\.rain-in, \.rain-fall \{ animation: none; \}/)
    expect(CHIP.slice(CHIP.indexOf('@media (prefers-reduced-motion: reduce)'))).toMatch(/\.rain-chip-in \{ animation: none; \}/)
  })

  it('leaves the wash and the drops themselves still', () => {
    expect(RAIN).not.toMatch(/\.rain-wash[^{]*\{[^}]*animation/)
    expect(RAIN).not.toMatch(/\.rain-drop[^{]*\{[^}]*animation/)
    expect(MAP).not.toMatch(/sgmap-fall|sgmap__drift|sgmap__wash|sgmap__stroke/)
  })

  it('draws with the three rain tokens and no colour written out', () => {
    expect(RAIN).toContain('var(--rain-wash)')
    expect(RAIN).toContain('var(--rain-streak)')
    expect(RAIN).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    expect(CHIP.split('<style')[1]).toContain('var(--rain-text)')
    expect(CHIP.split('<style')[1]).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    expect(TOKENS).toMatch(/--rain-wash: #4f7aa6;/)
    expect(TOKENS).toMatch(/--rain-streak: #6f9bc8;/)
    expect(TOKENS).toMatch(/--rain-text: #2a4866;/)
  })

  it('loops each layer by exactly one tile of its pattern, so there is no seam', async () => {
    const { RAIN_LAYERS } = await import('../rainLook.js')
    for (const layer of RAIN_LAYERS) expect(layer.travel).toBe(layer.tile[1])
    expect(RAIN_LAYERS.map((l) => [l.name, l.seconds, l.travel])).toEqual([['far', 1.7, 12], ['mid', 1.1, 20], ['near', 0.65, 34]])
    for (const [name, seconds] of [['far', '1.7s'], ['mid', '1.1s'], ['near', '0.65s']]) expect(RAIN).toContain(`.rain-fall--${name} { --rain-s: ${seconds}; }`)
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
