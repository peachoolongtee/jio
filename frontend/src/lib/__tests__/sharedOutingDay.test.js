// A shared outing is finished by its host, from its day on, and by no clock: lib/session.js on `remote` sessions. (The server refuses
// /complete before the day; that is tested with the backend in sharedPlan.test.js and backend/tests/sessions-plan.test.js.)
import { describe, expect, it } from 'vitest'
import { dueEnding, itineraryAction, overdueOuting, roamOpen } from '../session.js'

const shared = (extra = {}) => ({ id: 's', status: 'confirmed', date: '2026-10-10', start: '12:00', end: '20:00', remote: true, isToday: false, pastDay: false, ...extra })

describe('Finish outing on a shared outing', () => {
  it('is offered on the day, and after it (the host\'s only way to end it), and is "Save plan" before', () => {
    expect(itineraryAction(shared({ isToday: true }))).toBe('finish')
    expect(itineraryAction(shared({ pastDay: true }))).toBe('finish')
    expect(itineraryAction(shared())).toBe('save')
  })

  it('is not offered for a session that is not confirmed', () => {
    for (const status of ['voting', 'completed', 'cancelled']) expect(itineraryAction(shared({ status, pastDay: true }))).toBeNull()
  })

  it('does not open Roam after the day: places can be looked up only on it', () => {
    expect(roamOpen(shared({ isToday: true }))).toBe(true)
    expect(roamOpen(shared({ pastDay: true }))).toBe(false)
    expect(roamOpen(shared({ status: 'voting', isToday: true }))).toBe(false)
  })
})

describe('a shared outing past its end time', () => {
  const after = new Date('2026-10-11T09:00:00+08:00')

  it('is never finished or closed by a clock (nothing sweeps it): dueEnding says nothing', () => {
    expect(dueEnding(shared({ pastDay: true }), after)).toBeNull()
    expect(dueEnding(shared({ status: 'voting', pastDay: true }), new Date('2026-10-20T09:00:00+08:00'))).toBeNull()
    // A local outing still finishes by itself.
    expect(dueEnding(shared({ remote: false }), after)).toBe('finish')
  })

  it('is reminded of on Home, with no time it closes by itself', () => {
    expect(overdueOuting(shared(), after)).toEqual({ closesAt: null })
    expect(overdueOuting(shared({ remote: false }), after)).toEqual({ closesAt: expect.any(Date) })
  })
})
