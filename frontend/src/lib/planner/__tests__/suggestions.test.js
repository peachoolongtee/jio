// The ranking rules (rain, the last stop near an MRT, nothing nearby) moved to the backend planner and
// are tested there: backend/tests/options.test.js and slots.test.js. What stays here is the frontend's part.
import { describe, expect, it } from 'vitest'
import { moreOptions, reconcileOptions } from '../suggestions.js'
import { tripsHome, LONG_TRIP_MINUTES } from '../itinerary.js'
import { VENUES } from '../../mock/venues.js'
import { AREAS } from '../../mock/places.js'

describe('end location', () => {
  it('flags anyone whose trip home is over 60 minutes', () => {
    const last = VENUES.find((v) => v.id === 'nex')
    const trips = tripsHome(last, [
      { id: 'ian', name: 'Ian', end: { ...AREAS.find((a) => a.id === 'tiong-bahru'), name: 'Tiong Bahru' } },
      { id: 'jonathan', name: 'Jonathan', end: { ...AREAS.find((a) => a.id === 'tuas-link'), name: 'Tuas Link' } },
    ])
    expect(trips.find((t) => t.id === 'ian').long).toBe(false)
    const jonathan = trips.find((t) => t.id === 'jonathan')
    expect(jonathan.minutes).toBeGreaterThan(LONG_TRIP_MINUTES)
    expect(jonathan.long).toBe(true)
  })
})

describe('options per slot', () => {
  it('starts with three suggestions and keeps voted ones that still fit', () => {
    expect(reconcileOptions([], ['a', 'b', 'c', 'd'])).toEqual(['a', 'b', 'c'])
    expect(reconcileOptions(['d', 'x'], ['a', 'b', 'c', 'd'])).toEqual(['d', 'a', 'b'])
  })

  it('adds the next best places, up to six', () => {
    const ranked = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h']
    expect(moreOptions(['a', 'b', 'c'], ranked)).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(moreOptions(['a', 'b', 'c', 'd', 'e', 'f'], ranked)).toHaveLength(6)
  })
})
