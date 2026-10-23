import { describe, expect, it } from 'vitest'
import * as server from '../src/planner/slot-plan.js'
import * as browser from '../../frontend/src/lib/planner/slots.js'
import * as browserOptions from '../../frontend/src/lib/planner/suggestions.js'
import { fromMinutes as browserFromMinutes } from '../../frontend/src/lib/planner/format.js'

// The slot plan on the server (src/planner/slot-plan.js) is a port of the browser's rules. These tests hold the two together: the same
// picks and window give the same slots, and the same ranking gives the same options. The browser's file is read, not changed.

// The browser's slotsOf() (frontend/src/lib/api.js), with the people given as { categories, until } by id.
function browserSlotsOf(prefs, windowStart, windowEnd, deleted = []) {
  return browser.CATEGORIES.filter((c) => !deleted.includes(c)).flatMap((c) => {
    const everyone = Object.fromEntries(Object.entries(prefs).map(([id, p]) => [id, { categories: [c], until: p.until ?? null }]))
    return browser.buildSlots({ prefs: everyone, windowStart, windowEnd }).map((slot) => {
      if (c === 'eat') return slot
      const planEnd = browser.groupStayUntil(everyone, windowEnd)
      const start = windowStart + Math.floor((planEnd - windowStart - slot.duration) / 2 / 15) * 15
      return { ...slot, start, time: browserFromMinutes(start) }
    })
  })
}

const WINDOWS = [[600, 1200], [540, 1320], [600, 640], [600, 700], [600, 630], [660, 1439], [0, 1439], [1080, 1380], [600, 780]]
const PEOPLE = [
  { a: { categories: ['eat'], until: null } },
  { a: { categories: ['eat', 'drink'], until: null }, b: { categories: ['shop'], until: 900 } },
  { a: { categories: [], until: 700 }, b: { categories: ['activity'], until: null }, c: { categories: ['eat'], until: 1000 } },
  { a: { categories: ['eat', 'drink', 'shop', 'activity'], until: 1020 }, b: { categories: ['eat'], until: 640 }, c: { categories: ['drink'], until: null }, d: { categories: [], until: null } },
]

describe('the slot layout is the browser\'s', () => {
  it('lays out the same slots for the same picks and window', () => {
    for (const [windowStart, windowEnd] of WINDOWS) {
      for (const prefs of PEOPLE) {
        for (const deleted of [[], ['eat'], ['drink', 'activity']]) {
          const mine = server.layoutSlots({ members: Object.values(prefs), windowStart, windowEnd, removed: deleted })
          const theirs = browserSlotsOf(prefs, windowStart, windowEnd, deleted)
          expect(mine.map((s) => [s.category, s.start, s.time, s.duration]), JSON.stringify({ windowStart, windowEnd, prefs, deleted })).toEqual(
            theirs.map((s) => [s.category, s.start, s.time, s.duration]),
          )
        }
      }
    }
  })

  it('builds the same slots from picks (buildSlots), and the same time of day', () => {
    for (const [windowStart, windowEnd] of WINDOWS) {
      for (const prefs of PEOPLE) {
        const mine = server.buildSlots({ prefs, windowStart, windowEnd })
        const theirs = browser.buildSlots({ prefs, windowStart, windowEnd })
        expect(mine.map((s) => [s.category, s.start, s.duration, s.picks])).toEqual(theirs.map((s) => [s.category, s.start, s.duration, s.picks]))
      }
    }
    expect(server.fromMinutes(930)).toBe(browserFromMinutes(930))
    expect(server.fromMinutes(1500)).toBe('01:00')
    expect(server.toMinutes('15:30:00')).toBe(930)
    expect(server.toMinutes(null)).toBeNull()
  })

  it('says how many people picked each kind in the slot (the browser\'s own slot says how many are in)', () => {
    const slots = server.layoutSlots({ members: [{ categories: ['eat', 'drink'] }, { categories: ['eat'] }, { categories: [] }], windowStart: 600, windowEnd: 1200 })
    expect(Object.fromEntries(slots.map((s) => [s.category, s.picks]))).toEqual({ eat: 2, drink: 1, shop: 0, activity: 0 })
  })

  it('has a slot for every kind that has not been removed, and none when the day is shorter than half an hour', () => {
    const members = [{ categories: [], until: null }]
    expect(server.layoutSlots({ members, windowStart: 600, windowEnd: 1200 }).map((s) => s.category)).toEqual(['eat', 'drink', 'shop', 'activity'])
    expect(server.layoutSlots({ members, windowStart: 600, windowEnd: 1200, removed: ['shop'] }).map((s) => s.category)).toEqual(['eat', 'drink', 'activity'])
    expect(server.layoutSlots({ members, windowStart: 600, windowEnd: 620 })).toEqual([])
    // Everyone leaves before the day starts: nothing fits either.
    expect(server.layoutSlots({ members: [{ categories: [], until: 590 }], windowStart: 600, windowEnd: 1200 })).toEqual([])
  })

  it('keeps every slot inside what the database accepts (a start in the day, a length of 1 to 720 minutes)', () => {
    for (const [windowStart, windowEnd] of WINDOWS) {
      for (const prefs of PEOPLE) {
        for (const s of server.layoutSlots({ members: Object.values(prefs), windowStart, windowEnd })) {
          expect(s.start).toBeGreaterThanOrEqual(0)
          expect(s.start).toBeLessThanOrEqual(1439)
          expect(s.duration).toBeGreaterThanOrEqual(1)
          expect(s.duration).toBeLessThanOrEqual(720)
        }
      }
    }
  })
})

describe('the options are the browser\'s', () => {
  const RANKED = [['a', 'b', 'c', 'd', 'e', 'f', 'g'], ['c', 'x', 'a'], [], ['z']]
  const CURRENT = [[], ['a'], ['a', 'z'], ['z', 'y', 'x', 'a', 'b', 'c', 'd']]

  it('keeps options that still fit and tops up to three (reconcileOptions)', () => {
    for (const ranked of RANKED) for (const current of CURRENT) expect(server.reconcileOptions(current, ranked)).toEqual(browserOptions.reconcileOptions(current, ranked))
    expect(server.reconcileOptions(['a', 'z'], ['b', 'a', 'c', 'd'])).toEqual(['a', 'b', 'c'])
  })

  it('adds the next best places up to six (moreOptions)', () => {
    for (const ranked of RANKED) for (const current of CURRENT) expect(server.moreOptions(current, ranked)).toEqual(browserOptions.moreOptions(current, ranked))
    expect(server.moreOptions(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toEqual(['a', 'b', 'c', 'd', 'e', 'f'])
    expect(server.moreOptions(['a', 'b', 'c'], ['a', 'b', 'c', 'd', 'e', 'f', 'g'], { add: 1 })).toEqual(['a', 'b', 'c', 'd'])
    expect(server.OPTIONS_START).toBe(browserOptions.OPTIONS_START)
    expect(server.OPTIONS_MAX).toBe(browserOptions.OPTIONS_MAX)
  })
})
