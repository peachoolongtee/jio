import { describe, expect, it } from 'vitest'
import * as server from '../src/planner/itinerary.js'
import * as browserItinerary from '../../frontend/src/lib/planner/itinerary.js'
import * as browserTravel from '../../frontend/src/lib/planner/travel.js'

// The timing of an itinerary on the server (src/planner/itinerary.js) is a port of the browser's rules (frontend/src/lib/planner/travel.js
// and itinerary.js). These tests hold the two together: the same two places give the same minutes by walking, the MRT and a car, the same
// default mode, and the same start for every stop. The browser's files are read, not changed.

// A small deterministic generator, so the points are the same on every run.
function rng(seed) {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const random = rng(20261023)
const point = () => ({ lat: 1.22 + random() * 0.22, lng: 103.62 + random() * 0.4 })
const PAIRS = Array.from({ length: 300 }, () => [point(), point()])
// Places that are the same, a few metres apart, and across the island.
const SPECIAL = [
  [{ lat: 1.3, lng: 103.85 }, { lat: 1.3, lng: 103.85 }],
  [{ lat: 1.3, lng: 103.85 }, { lat: 1.30003, lng: 103.85 }],
  [{ lat: 1.23, lng: 103.62 }, { lat: 1.44, lng: 104.03 }],
]

describe('the travel times are the browser\'s', () => {
  it('gives the same minutes by walking, the MRT and a car for any two places', () => {
    for (const [a, b] of [...PAIRS, ...SPECIAL]) {
      expect(server.legOptions(a, b), JSON.stringify([a, b])).toEqual(browserTravel.legOptions(a, b))
    }
  })

  it('starts a leg in the same mode', () => {
    for (const [a, b] of [...PAIRS, ...SPECIAL]) {
      const options = server.legOptions(a, b)
      expect(server.defaultMode(options)).toBe(browserTravel.defaultMode(options))
    }
  })
})

describe('the start of every stop is the browser\'s', () => {
  const venues = Array.from({ length: 6 }, () => point())

  it('times a plan the same way with the default modes, with chosen modes and with earliest starts', () => {
    const rows = venues.map((venue, i) => ({ venue, plannedStart: 600 + i * 120, duration: 60 + i * 15, ...(i % 2 === 1 ? { notBefore: 700 + i * 130 } : {}) }))
    for (const modes of [[], ['car', undefined, 'walk', 'mrt'], [null, 'car', 'grab', 'walk', 'mrt'], ['walk', 'walk', 'walk', 'walk', 'walk']]) {
      for (const startAt of [null, 540, 900]) {
        const mine = server.buildItinerary(rows, modes, startAt)
        const theirs = browserItinerary.buildItinerary(rows, modes, startAt)
        expect(mine.stops.map((s) => [s.start, s.end])).toEqual(theirs.stops.map((s) => [s.start, s.end]))
        expect(mine.legs.map((l) => [l.index, l.mode, l.minutes, l.options])).toEqual(theirs.legs.map((l) => [l.index, l.mode, l.minutes, l.options]))
      }
    }
  })

  it('never starts a stop before its earliest start, and lets the first stop start at the plan\'s start', () => {
    const rows = [
      { venue: venues[0], plannedStart: 600, duration: 60 },
      { venue: venues[1], plannedStart: 700, duration: 60, notBefore: 1200 },
    ]
    const { stops } = server.buildItinerary(rows, [], 615)
    expect(stops[0].start).toBe(615)
    expect(stops[1].start).toBe(1200)
  })

  it('treats a missing or unknown mode as the default', () => {
    const rows = [{ venue: venues[0], plannedStart: 600, duration: 60 }, { venue: venues[1], plannedStart: 700, duration: 60 }]
    const normal = server.buildItinerary(rows, [])
    expect(server.buildItinerary(rows, ['grab']).legs[0].mode).toBe(normal.legs[0].mode)
    expect(server.buildItinerary(rows, [null]).stops[1].start).toBe(normal.stops[1].start)
  })
})
