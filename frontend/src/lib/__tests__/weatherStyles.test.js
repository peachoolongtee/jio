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
    for (const frame of keyframes) expect(frame).toMatch(/^@keyframes [\w-]+ \{ (from \{ opacity: 0; \} to \{ opacity: 1; \}|from \{ transform: translateY\(0\); \} to \{ transform: translateY\(var\(--rain-travel, 0px\)\); \}) \}$/)
    const reduced = RAIN.slice(RAIN.indexOf('@media (prefers-reduced-motion: reduce)'))
    // Under reduced motion the fade and the fall stop, and each streak stands still at its own point in the patch.
    expect(reduced).toMatch(/\.rain-in \{ animation: none; \}/)
    expect(reduced).toMatch(/\.rain-streak \{ animation: none; transform: translateY\(var\(--rain-still, 0px\)\); \}/)
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

  // The streaks (4 November 2026) replaced the three patterned layers: each falls through the whole patch, from above its top to below
  // its bottom, so it never pops in or out inside the rain.
  it('lets every streak fall from above the patch to below it, at a speed within the look\'s range', async () => {
    const { RAIN_STREAKS, rainStreaks } = await import('../rainLook.js')
    const rain = rainStreaks({ size: 240, seed: 7 })
    expect(Number(rain.top)).toBeLessThan(0)
    expect(Number(rain.travel)).toBeGreaterThan(240)
    for (const d of rain.drops) {
      expect(Number(d.seconds)).toBeGreaterThanOrEqual(RAIN_STREAKS.seconds[0])
      expect(Number(d.seconds)).toBeLessThanOrEqual(RAIN_STREAKS.seconds[1])
      expect(Number(d.delay)).toBeLessThanOrEqual(0)
    }
    expect(RAIN).toContain('animation: rain-streak var(--rain-s, 1s) linear var(--rain-d, 0s) infinite')
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
