// Every date and time of a session is Singapore's, whatever the time zone of the browser (or of the machine these tests run on).
// Each case uses an explicit instant that is on a different day in UTC and in Singapore, so a function that reads the browser's clock
// instead of Singapore's fails in any zone but Singapore's own. Singapore is UTC+8 all year.
import { describe, expect, it } from 'vitest'
import { dayLabel, dayOf, whenLine } from '../homeMeetups.js'
import {
  defaultDate, defaultTimes, dueEnding, endHasPassed, overdueOuting, sessionEnd, singaporeDate, singaporeInstant, singaporeMinutes, singaporeTime,
  singaporeDayTime, startHasPassed, startsIn,
} from '../session.js'
import { todayWindow } from '../../tour/builders.js'

// 23:30 on the 10th in Singapore (15:30 UTC), and an hour later: 00:30 on the 11th there, still the 10th in UTC.
const LATE = new Date('2026-10-10T15:30:00Z')
const AFTER_MIDNIGHT = new Date('2026-10-10T16:30:00Z')

describe('the Singapore clock', () => {
  it('reads the date, the time and the minutes of an instant in Singapore', () => {
    expect([singaporeDate(LATE), singaporeTime(LATE), singaporeMinutes(LATE)]).toEqual(['2026-10-10', '23:30', 23 * 60 + 30])
    expect([singaporeDate(AFTER_MIDNIGHT), singaporeTime(AFTER_MIDNIGHT), singaporeMinutes(AFTER_MIDNIGHT)]).toEqual(['2026-10-11', '00:30', 30])
  })

  it('turns a Singapore date and time into the instant, and a missing or impossible one into null', () => {
    expect(singaporeInstant('2026-10-11', '00:30')).toEqual(AFTER_MIDNIGHT)
    expect(singaporeInstant('2026-10-10', '23:30')).toEqual(LATE)
    expect(singaporeInstant('', '10:00')).toBeNull()
    expect(singaporeInstant('2026-10-10', '')).toBeNull()
    expect(singaporeInstant('2026-02-30', '10:00')).toBeNull()
  })
})

describe('the create form\'s defaults', () => {
  it('starts at the next round hour in Singapore, and puts tomorrow in the day from 23:00 there', () => {
    expect(defaultTimes(LATE)).toEqual({ start: '00:00', end: '03:00' })
    expect(defaultDate(LATE)).toBe('2026-10-11')
    // Half an hour later it is the 11th in Singapore: the next round hour is 01:00 and the day is left to choose.
    expect(defaultTimes(AFTER_MIDNIGHT)).toEqual({ start: '01:00', end: '04:00' })
    expect(defaultDate(AFTER_MIDNIGHT)).toBe('')
  })

  it('refuses an end or a start that has passed on Singapore\'s today, and never on another day', () => {
    expect(endHasPassed('2026-10-11', '00:30', AFTER_MIDNIGHT)).toBe(true)
    expect(endHasPassed('2026-10-11', '00:31', AFTER_MIDNIGHT)).toBe(false)
    expect(endHasPassed('2026-10-10', '23:59', AFTER_MIDNIGHT)).toBe(false)
    expect(startHasPassed('2026-10-11', '00:15', AFTER_MIDNIGHT)).toBe(true)
    expect(startHasPassed('2026-10-11', '00:45', AFTER_MIDNIGHT)).toBe(false)
    expect(startHasPassed('2026-10-12', '00:15', AFTER_MIDNIGHT)).toBe(false)
  })
})

describe('when a session starts and ends', () => {
  const session = (over = {}) => ({ status: 'inviting', date: '2026-10-11', start: '08:30', end: '17:00', ...over })

  it('counts the countdown from Singapore\'s clock', () => {
    // 00:30 on the 11th: eight hours to a 08:30 start that day.
    expect(startsIn(session(), AFTER_MIDNIGHT)).toEqual({ text: 'Starts in 8 h', tone: 'soon' })
    expect(startsIn(session({ start: '00:45' }), AFTER_MIDNIGHT)).toEqual({ text: 'Starts in 15 min', tone: 'soon' })
    expect(startsIn(session({ start: '00:00', end: '17:00' }), AFTER_MIDNIGHT)).toEqual({ text: 'Happening now', tone: 'live' })
    expect(startsIn(session({ start: '00:00', end: '00:30' }), AFTER_MIDNIGHT)).toEqual({ text: 'Ended', tone: 'muted' })
  })

  it('counts whole days between Singapore dates: the 12th is tomorrow at 00:30 on the 11th, though it is the 10th in UTC', () => {
    expect(startsIn(session({ date: '2026-10-12', start: '09:00' }), AFTER_MIDNIGHT)).toEqual({ text: 'Tomorrow, 09:00', tone: 'later' })
    expect(startsIn(session({ date: '2026-10-12', start: '09:00' }), LATE)).toEqual({ text: 'In 2 days', tone: 'later' })
  })

  it('moves a session to Singapore\'s today when the demo\'s session-day switch is on', () => {
    expect(startsIn(session({ date: '2026-10-01', isToday: true }), AFTER_MIDNIGHT)).toEqual({ text: 'Starts in 8 h', tone: 'soon' })
    expect(dayOf({ date: '2026-10-01', isToday: true }, AFTER_MIDNIGHT)).toBe('2026-10-11')
  })

  it('reads a session\'s end as a Singapore time', () => {
    expect(sessionEnd({ date: '2026-10-10', end: '23:00' })).toEqual(new Date('2026-10-10T15:00:00Z'))
    expect(sessionEnd({ date: '2026-10-10', end: '' })).toBeNull()
    expect(sessionEnd(null)).toBeNull()
  })

  it('finishes a confirmed plan at its end in Singapore, never an hour or eight before', () => {
    const plan = { status: 'confirmed', date: '2026-10-10', end: '23:00' }
    expect(dueEnding(plan, new Date('2026-10-10T14:59:00Z'))).toBeNull() // 22:59 in Singapore
    expect(dueEnding(plan, new Date('2026-10-10T15:00:00Z'))).toBe('finish') // 23:00 in Singapore, before 23:00 in UTC
  })

  it('closes a session with no plan two days after its end in Singapore', () => {
    const open = { status: 'voting', date: '2026-10-10', end: '23:00' }
    expect(dueEnding(open, new Date('2026-10-12T14:59:00Z'))).toBeNull()
    expect(dueEnding(open, new Date('2026-10-12T15:00:00Z'))).toBe('close')
    expect(overdueOuting(open, new Date('2026-10-10T15:01:00Z'))).toEqual({ closesAt: new Date('2026-10-12T15:00:00Z') })
    expect(overdueOuting(open, new Date('2026-10-10T14:59:00Z'))).toBeNull()
  })
})

describe('where else the app says the day', () => {
  it('labels a meetup on Singapore\'s today as Today, and one the day after as a weekday', () => {
    expect(dayLabel({ date: '2026-10-11' }, AFTER_MIDNIGHT)).toBe('Today')
    expect(dayLabel({ date: '2026-10-12' }, AFTER_MIDNIGHT)).toBe('Mon')
    expect(dayLabel({ date: '2026-10-11' }, LATE)).toBe('Sun')
    expect(whenLine({ date: '2026-10-11', start: '08:30' }, AFTER_MIDNIGHT)).toBe('Sun 11 Oct · 08:30')
  })

  it('writes an instant as Singapore\'s wall clock says it, for the overdue banner', () => {
    expect(singaporeDayTime(new Date('2026-10-12T12:00:00Z'))).toBe('Mon 12 Oct, 20:00')
    expect(singaporeDayTime(AFTER_MIDNIGHT)).toBe('Sun 11 Oct, 00:30')
  })

  it('builds the demo\'s today window from Singapore\'s clock', () => {
    // 23:30 there: half an hour ago to the quarter hour, no later than 17:00 for the start, and the end no later than 23:45.
    expect(todayWindow(LATE)).toEqual({ start: '17:00', end: '23:00' })
    expect(todayWindow(AFTER_MIDNIGHT)).toEqual({ start: '07:00', end: '13:00' })
  })
})
