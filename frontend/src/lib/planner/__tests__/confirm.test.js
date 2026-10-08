import { describe, expect, it } from 'vitest'
import { canConfirm, leader, pickWinner, voters } from '../confirm.js'
import { buildItinerary } from '../itinerary.js'
import { VENUES } from '../../mock/venues.js'
import { priceTier, timeAndDuration } from '../format.js'

describe('confirm', () => {
  it('gives each slot to the most voted place', () => {
    expect(pickWinner(['a', 'b', 'c'], { ian: 'b', darius: 'b', nicole: 'a' })).toBe('b')
  })

  it('breaks a tie with the better planner score', () => {
    expect(pickWinner(['a', 'b'], { ian: 'a', darius: 'b' }, { a: 7.1, b: 8.2 })).toBe('b')
  })

  it('needs at least 2 people to have voted', () => {
    const active = ['ian', 'darius', 'nicole']
    expect(canConfirm({ eat: { ian: 'a' } }, active)).toBe(false)
    expect(canConfirm({ eat: { ian: 'a' }, shop: { darius: 'x' } }, active)).toBe(true)
    expect(voters({ eat: { ian: 'a', faith: 'b' } }, active)).toEqual(['ian'])
  })

  it('highlights a leader only when one option is ahead', () => {
    expect(leader(['a', 'b'], { ian: 'a', darius: 'b' })).toBeNull()
    expect(leader(['a', 'b'], { ian: 'a' })).toBe('a')
    expect(leader(['a', 'b'], {})).toBeNull()
  })
})

describe('itinerary', () => {
  const v = (id) => VENUES.find((x) => x.id === id)
  const stops = [
    { venue: v('bishan-library'), plannedStart: 900, duration: 120 },
    { venue: v('junction-8'), plannedStart: 1020, duration: 90 },
    { venue: v('lorong-8-toa-payoh'), plannedStart: 1110, duration: 90 },
  ]

  it('changing a travel mode moves every later stop', () => {
    const walk = buildItinerary(stops, ['walk', 'walk'])
    const car = buildItinerary(stops, ['walk', 'car'])
    expect(car.stops[1].start).toBe(walk.stops[1].start)
    expect(car.stops[2].start).not.toBe(walk.stops[2].start)
    const mrt = buildItinerary(stops, ['mrt', 'walk'])
    expect(mrt.stops[1].start).toBe(stops[0].plannedStart + 120 + mrt.legs[0].options.mrt)
    expect(mrt.stops[2].start).toBe(mrt.stops[1].end + mrt.legs[1].options.walk)
  })

  it('gives every leg a time for Walk, MRT and Car', () => {
    const { legs } = buildItinerary(stops)
    for (const leg of legs) expect(Object.keys(leg.options).sort()).toEqual(['car', 'mrt', 'walk'])
  })

  it('falls back to the default mode for a plan saved with a mode that no longer exists', () => {
    const saved = buildItinerary(stops, ['grab', 'grab'])
    const fresh = buildItinerary(stops)
    expect(saved.legs.map((l) => l.mode)).toEqual(fresh.legs.map((l) => l.mode))
    expect(saved.stops.every((s) => Number.isFinite(s.start))).toBe(true)
  })
})

describe('format', () => {
  it('shows price as a tier', () => {
    expect(priceTier(0)).toBe('$')
    expect(priceTier(9.9)).toBe('$')
    expect(priceTier(10)).toBe('$$')
    expect(priceTier(25)).toBe('$$')
    expect(priceTier(25.5)).toBe('$$$')
  })

  it('puts the duration beside the time', () => {
    expect(timeAndDuration('15:00', 45)).toBe('15:00 · 45 min')
    expect(timeAndDuration(900, 120)).toBe('15:00 · 2 h')
  })
})
