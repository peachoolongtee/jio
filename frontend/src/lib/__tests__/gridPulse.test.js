// The calmer grid behind Leaderboard, Rewards and Profile (walkthrough, 30 October 2026): pale greys and a faint red, nothing that
// lights by itself, and a short trail. The canvas itself needs a browser; its colours and defaults are tested here.
import { describe, expect, it } from 'vitest'
import { GRID_PULSE, cellPaint } from '../gridPulse.js'

describe('the grid behind Leaderboard, Rewards and Profile', () => {
  it('lights nothing by itself and keeps the trail short', () => {
    expect(GRID_PULSE.ambient).toBe(0)
    expect(GRID_PULSE.reach).toBeLessThan(2)
    expect(GRID_PULSE.maxLit).toBeLessThanOrEqual(40)
  })

  it('paints a cell a pale grey, or now and then the brand red at a faint strength', () => {
    const paints = Array.from({ length: 200 }, (_, i) => cellPaint(i / 200, '#ff385c'))
    const reds = paints.filter((p) => p.colour === '#ff385c')
    const greys = paints.filter((p) => p.colour !== '#ff385c')
    expect(reds.length).toBeGreaterThan(0)
    expect(reds.length / paints.length).toBeLessThan(0.2)
    expect(reds.every((p) => p.alpha <= 0.2)).toBe(true)
    for (const p of greys) {
      const [, saturation, lightness] = p.colour.match(/^hsl\(0 (\d+)% (\d+)%\)$/).map(Number)
      expect(saturation).toBe(0)
      expect(lightness).toBeGreaterThanOrEqual(88)
    }
  })

  it('stays in range at the ends of the random number', () => {
    expect(cellPaint(0).colour).toBe('#ff385c')
    expect(cellPaint(0.999999).colour).toMatch(/^hsl\(0 0% \d+%\)$/)
  })
})
