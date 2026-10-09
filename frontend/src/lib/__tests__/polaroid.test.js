import { describe, expect, it } from 'vitest'
import { nearestAt, pad2, springStep, stringY, swingStep } from '../polaroid.js'

describe('stringY', () => {
  it('sags most in the middle and not at all at the ends', () => {
    expect(stringY(0, 1000, 100, 40)).toBe(100)
    expect(stringY(1000, 1000, 100, 40)).toBe(100)
    expect(stringY(500, 1000, 100, 40)).toBe(140)
  })
})

describe('springStep', () => {
  it('settles on the target without overshooting', () => {
    let x = 0
    let v = 0
    let peak = 0
    for (let i = 0; i < 240; i++) {
      ;[x, v] = springStep(x, v, 100, 1 / 60)
      peak = Math.max(peak, x)
    }
    expect(x).toBeCloseTo(100, 1)
    expect(peak).toBeLessThan(100.5)
  })
})

describe('swingStep', () => {
  it('swings a print against the motion, then lets it come back to rest', () => {
    let a = 0
    let w = 0
    ;[a, w] = swingStep(a, w, 2000, 1 / 60, 1)
    expect(a).toBeGreaterThan(0)
    for (let i = 0; i < 600; i++) [a, w] = swingStep(a, w, 0, 1 / 60, 1)
    expect(Math.abs(a)).toBeLessThan(0.001)
  })
  it('never swings past its limit', () => {
    const [a] = swingStep(0.59, 50, 1e6, 0.05, 1)
    expect(a).toBeLessThanOrEqual(0.6)
  })
})

describe('nearestAt', () => {
  it('picks the print nearest the middle, within the line', () => {
    expect(nearestAt(310, 300, 5)).toBe(1)
    expect(nearestAt(-200, 300, 5)).toBe(0)
    expect(nearestAt(9999, 300, 5)).toBe(4)
  })
})

describe('pad2', () => {
  it('pads single digits for the counter', () => {
    expect([pad2(3), pad2(12)]).toEqual(['03', '12'])
  })
})
