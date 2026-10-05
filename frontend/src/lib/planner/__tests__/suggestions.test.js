import { describe, expect, it } from 'vitest'
import { indoorSwap, moreOptions, rankForSlot, reconcileOptions, scoreVenue, LAST_STOP_MRT_WALK } from '../suggestions.js'
import { crowdLevel, crowdText } from '../crowd.js'
import { toMinutes } from '../format.js'
import { tripsHome, LONG_TRIP_MINUTES } from '../itinerary.js'
import { VENUES } from '../../mock/venues.js'
import { AREAS } from '../../mock/places.js'

const bishan = AREAS.find((a) => a.id === 'bishan')
const serangoon = AREAS.find((a) => a.id === 'serangoon')
const activity = { id: 'activity', category: 'activity', start: toMinutes('15:00'), duration: 120 }
const dinner = { id: 'eat', category: 'eat', start: toMinutes('18:30'), duration: 90 }

describe('crowd', () => {
  it('lowers a place in the ranking but never hides it', () => {
    const calm = rankForSlot(VENUES, { slot: activity, area: bishan })
    const crowded = rankForSlot(VENUES, { slot: activity, area: bishan, conditions: { crowd: true } })
    expect(crowded.options.map((o) => o.venue.id).sort()).toEqual(calm.options.map((o) => o.venue.id).sort())
    const venue = VENUES.find((v) => v.id === 'junction-8')
    const quiet = scoreVenue(venue, { slot: { ...activity, category: 'shop' }, area: bishan })
    const busy = scoreVenue(venue, { slot: { ...activity, category: 'shop' }, area: bishan, conditions: { crowd: true } })
    expect(busy.score).toBeLessThan(quiet.score)
  })

  it('gives every suggestion a level and labels it as an estimate', () => {
    const { options } = rankForSlot(VENUES, { slot: activity, area: bishan })
    for (const option of options) expect(['quiet', 'moderate', 'busy']).toContain(option.crowd)
    expect(crowdText('quiet')).toBe('Quiet · est.')
    expect(crowdLevel(VENUES[0], toMinutes('15:00'))).toMatch(/quiet|moderate|busy/)
  })
})

describe('weather', () => {
  it('warns about outdoor places in the rain, drops them and offers an indoor swap', () => {
    const dry = rankForSlot(VENUES, { slot: activity, area: bishan })
    const wet = rankForSlot(VENUES, { slot: activity, area: bishan, conditions: { rain: true } })
    const park = (r) => r.options.find((o) => o.venue.id === 'bishan-amk-park')
    expect(park(wet).warnings).toContain('rain')
    expect(park(dry).warnings).not.toContain('rain')
    expect(wet.options.indexOf(park(wet))).toBeGreaterThan(dry.options.indexOf(park(dry)))
    const swap = indoorSwap(wet.options, ['bishan-amk-park'])
    expect(swap.venue.indoor).toBe(true)
  })
})

describe('end location', () => {
  const homes = [
    { ...AREAS.find((a) => a.id === 'tiong-bahru'), id: 'ian', name: 'Ian' },
    { ...AREAS.find((a) => a.id === 'punggol'), id: 'faith', name: 'Faith' },
  ]

  it('keeps the last stop within a 10 minute walk of an MRT station', () => {
    const { options } = rankForSlot(VENUES, { slot: dinner, area: serangoon, isLast: true, homes })
    expect(options.length).toBeGreaterThan(0)
    for (const option of options) expect(option.venue.mrtWalk).toBeLessThanOrEqual(LAST_STOP_MRT_WALK)
    expect(options.map((o) => o.venue.id)).not.toContain('chomp-chomp')
  })

  it('ranks the last stop by how long everyone takes to get to their end location', () => {
    const near = { ...VENUES.find((v) => v.id === 'kopitiam-junction-8') }
    const far = { ...near, id: 'far', lat: 1.44, lng: 103.79 }
    const a = scoreVenue(near, { slot: dinner, area: bishan, isLast: true, homes })
    const b = scoreVenue(far, { slot: dinner, area: near, isLast: true, homes })
    expect(a.score).toBeGreaterThan(b.score)
  })

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

describe('nothing nearby', () => {
  it('widens the search once before giving up', () => {
    const woodlands = AREAS.find((a) => a.id === 'woodlands')
    const result = rankForSlot(VENUES, { slot: activity, area: woodlands })
    expect(result.widened).toBe(true)
    expect(result.options).toHaveLength(0)
  })

  it('does not widen when enough places fit nearby', () => {
    const result = rankForSlot(VENUES, { slot: { ...activity, category: 'shop' }, area: AREAS.find((a) => a.id === 'dhoby-ghaut') })
    expect(result.widened).toBe(false)
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

  it('gives each suggestion at most two reason tags', () => {
    const { options } = rankForSlot(VENUES, { slot: activity, area: bishan, conditions: { rain: true } })
    for (const option of options) expect(option.reasons.length).toBeLessThanOrEqual(2)
  })
})
