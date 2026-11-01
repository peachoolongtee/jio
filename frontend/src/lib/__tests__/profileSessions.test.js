import { describe, expect, it } from 'vitest'
import { EMPTY_TEXT, SESSION_FILTERS, profileSessions, upcomingSessions } from '../profileSessions.js'

// Friday 30 October 2026, 10:00 in Singapore.
const NOW = new Date('2026-10-30T10:00:00+08:00')

// A session summary with only the fields the list reads.
const make = (id, over = {}) => ({ id, status: 'locating', date: '2026-11-02', start: '19:00', end: '22:00', createdAt: 1, ...over })

const ids = (list) => list.map((s) => s.id)

describe('the time chips on the profile', () => {
  it('are All, Upcoming and Completed, each with words for when it is empty', () => {
    expect(SESSION_FILTERS.map((f) => f.label)).toEqual(['All', 'Upcoming', 'Completed'])
    for (const f of SESSION_FILTERS) expect(EMPTY_TEXT[f.id]).toBeTruthy()
  })
})

describe('Upcoming', () => {
  it('lists every session still going, soonest first, and leaves out finished and cancelled ones', () => {
    const sessions = [
      make('later', { date: '2026-11-07' }),
      make('done', { status: 'completed', date: '2026-10-20' }),
      make('soon', { status: 'voting', date: '2026-11-01' }),
      make('off', { status: 'cancelled', date: '2026-10-31' }),
      make('invite', { status: 'inviting', date: '2026-11-01', start: '09:00' }),
    ]
    expect(ids(profileSessions(sessions, 'upcoming', NOW))).toEqual(['invite', 'soon', 'later'])
  })

  it('pins a live session at the top, and puts one from an earlier day still waiting to finish after the ones to come', () => {
    const sessions = [
      make('overdue', { status: 'confirmed', date: '2026-10-28' }),
      make('tomorrow', { status: 'confirmed', date: '2026-10-31' }),
      make('live', { status: 'confirmed', date: '2026-10-30', start: '09:00', end: '13:00' }),
    ]
    expect(ids(upcomingSessions(sessions, NOW))).toEqual(['live', 'tomorrow', 'overdue'])
  })
})

describe('Completed', () => {
  it('lists the finished outings only, the latest first', () => {
    const sessions = [
      make('a', { status: 'completed', date: '2026-10-01' }),
      make('b', { status: 'completed', date: '2026-10-20' }),
      make('c', { status: 'confirmed', date: '2026-10-31' }),
      make('d', { status: 'cancelled', date: '2026-10-25' }),
    ]
    expect(ids(profileSessions(sessions, 'completed', NOW))).toEqual(['b', 'a'])
  })
})

describe('All', () => {
  it('is Upcoming, then Completed, then the cancelled ones, and an unknown filter is All', () => {
    const sessions = [
      make('done', { status: 'completed', date: '2026-10-20' }),
      make('off', { status: 'cancelled', date: '2026-10-31' }),
      make('next', { status: 'voting', date: '2026-11-01' }),
      make('live', { status: 'confirmed', date: '2026-10-30', start: '09:00', end: '13:00' }),
    ]
    expect(ids(profileSessions(sessions, 'all', NOW))).toEqual(['live', 'next', 'done', 'off'])
    expect(ids(profileSessions(sessions, 'odd', NOW))).toEqual(['live', 'next', 'done', 'off'])
  })

  it('is empty, not a crash, with no sessions', () => {
    expect(profileSessions(undefined, 'all', NOW)).toEqual([])
  })
})
