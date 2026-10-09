import { describe, expect, it } from 'vitest'
import { distanceText } from '../format.js'

describe('distanceText', () => {
  it('gives metres to the nearest 10 under 1 km', () => {
    expect(distanceText(184)).toBe('180 m')
    expect(distanceText(3)).toBe('10 m')
  })
  it('gives kilometres with one decimal from 1 km', () => {
    expect(distanceText(1000)).toBe('1.0 km')
    expect(distanceText(2460)).toBe('2.5 km')
  })
  it('is empty without a distance', () => {
    expect(distanceText(null)).toBe('')
  })
})
