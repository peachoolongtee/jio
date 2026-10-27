// A stop that ends after midnight reads as the next day, and a plan or a stop that ends after the session's end says so
// (lib/planner/format.js dayTime, lib/roam.js lateLine and acceptedTimes, the itinerary page and the stop card). Also the small
// rules for the time a stop added from Roam may start, and who may propose.
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { dayTime, fromMinutes, timeAndDuration } from '../planner/format.js'
import { acceptedTimes, isRoamStop, lateLine, memberBlock, nextStopStart } from '../roam.js'
import { buildItinerary } from '../planner/itinerary.js'

const here = { id: 'a', name: 'A', category: 'eat', lat: 1.35, lng: 103.85, mrt: 'Bishan', mrtWalk: 5 }
const there = { id: 'b', name: 'B', category: 'activity', lat: 1.3501, lng: 103.8501, mrt: 'Bishan', mrtWalk: 5 }

describe('a time of the day for people', () => {
  it('reads like the clock until midnight and says "tomorrow" after it', () => {
    expect(dayTime(0)).toBe('00:00')
    expect(dayTime(1290)).toBe('21:30')
    expect(dayTime(1439)).toBe('23:59')
    expect(dayTime(1440)).toBe('00:00 tomorrow')
    expect(dayTime(1530)).toBe('01:30 tomorrow')
    // fromMinutes alone wraps, which is why a stop ending at 25:30 looked like 01:30 the same day.
    expect(fromMinutes(1530)).toBe('01:30')
  })

  it('is what a stop card shows, with its length', () => {
    expect(timeAndDuration(1290, 60)).toBe('21:30 · 1 h')
    expect(timeAndDuration(1470, 90)).toBe('00:30 tomorrow · 1 h 30 min')
    expect(timeAndDuration('15:00', 45)).toBe('15:00 · 45 min')
  })

  it('is used wherever the itinerary page shows a stop\'s time', () => {
    const page = readFileSync(new URL('../../views/EventView.vue', import.meta.url), 'utf8')
    expect(page).toContain('Ends {{ dayTime(lastStop.end) }}')
    expect(page).toContain('starting ${dayTime(stops[0].start)}')
    expect(page).not.toMatch(/fromMinutes/)
    const map = readFileSync(new URL('../../views/SessionMapView.vue', import.meta.url), 'utf8')
    expect(map).toContain('timeAndDuration(card.start, card.duration)')
  })
})

describe('a plan or a stop that ends after the session\'s end', () => {
  it('says so, with the session\'s end, and says nothing at or before it', () => {
    expect(lateLine(1311, '21:30')).toBe('Ends after the session\'s end, 21:30')
    expect(lateLine(1290, '21:30')).toBe('')
    expect(lateLine(600, '21:30')).toBe('')
    expect(lateLine(1311, '')).toBe('')
    expect(lateLine(undefined, '21:30')).toBe('')
  })

  it('says it as "would end" before a stop is added, and reads the next day', () => {
    expect(lateLine(1311, '21:30', { would: true })).toBe('Would end at 21:51, after the session\'s end, 21:30')
    expect(lateLine(1530, '21:30', { would: true })).toBe('Would end at 01:30 tomorrow, after the session\'s end, 21:30')
  })

  it('is on the itinerary page, under the end of the plan, for a confirmed plan that runs over', () => {
    const page = readFileSync(new URL('../../views/EventView.vue', import.meta.url), 'utf8')
    expect(page).toContain('lateLine(lastStop.value.end, session.value?.end)')
    expect(page).toContain('data-testid="plan-late"')
    expect(page.indexOf('data-testid="plan-late"')).toBeGreaterThan(page.indexOf('Ends {{ dayTime(lastStop.end) }}'))
    expect(page).toContain(':itinerary="itinerary"')
  })
})

describe('when a stop added from Roam may start', () => {
  it('is when the last stop ends, or now when that has passed', () => {
    expect(nextStopStart(960, 1200)).toBe(1200)
    expect(nextStopStart(960, 600)).toBe(960)
    expect(nextStopStart(undefined, 600)).toBe(600)
    // Not cut at midnight: a plan that runs to 25:00 lets the next stop start then.
    expect(nextStopStart(1500, 1380)).toBe(1500)
  })

  it('is what the itinerary lays out: after the last stop and the way to it, and not before the time it was ranked for', () => {
    const lastStop = { venue: here, end: 960 }
    const soon = acceptedTimes({ lastStop, venue: there, nowMinutes: 600 })
    const stop = { venue: there, plannedStart: 960, duration: 60, notBefore: nextStopStart(960, 600) }
    const timed = buildItinerary([{ venue: here, plannedStart: 900, duration: 60 }, stop], [], 900).stops[1]
    expect(soon).toEqual({ start: timed.start, end: timed.end })
    const late = acceptedTimes({ lastStop, venue: there, nowMinutes: 1200 })
    expect(late).toEqual({ start: 1200, end: 1260 })
    expect(acceptedTimes({ lastStop: null, venue: there, nowMinutes: 1200 })).toBeNull()
  })

  it('knows a stop added from a proposal by its slot', () => {
    expect(isRoamStop({ slotId: 'roam-pp7' })).toBe(true)
    expect(isRoamStop({ slotId: 'eat' })).toBe(false)
    expect(isRoamStop(null)).toBe(false)
  })
})

describe('who may propose', () => {
  const session = { activeIds: ['ian', 'faith'], members: [{ id: 'ian', state: 'joined' }, { id: 'faith', state: 'joined' }, { id: 'jo', state: 'opted_out' }] }
  it('is a person in the meetup, and says why for someone who opted out or was never in it', () => {
    expect(memberBlock(session, 'ian')).toBe('')
    expect(memberBlock(session, 'jo')).toBe('You opted out of this meetup, so you cannot propose places.')
    expect(memberBlock(session, 'stranger')).toBe('Only people in this meetup can propose places.')
    expect(memberBlock(null, 'ian')).toBe('')
  })
})
