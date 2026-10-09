import { describe, expect, it } from 'vitest'
import { startsIn } from '../session.js'

const session = { date: '2026-10-10', start: '15:00', end: '21:00', status: 'confirmed' }
const at = (iso) => new Date(iso)

describe('startsIn', () => {
  it('counts down in minutes in the last hour', () => {
    expect(startsIn(session, at('2026-10-10T14:10:00')).text).toBe('Starts in 50 min')
  })
  it('counts in hours on the day', () => {
    expect(startsIn(session, at('2026-10-10T12:00:00')).text).toBe('Starts in 3 h')
  })
  it('says tomorrow, then days', () => {
    expect(startsIn(session, at('2026-10-09T10:00:00')).text).toBe('Tomorrow, 15:00')
    expect(startsIn(session, at('2026-10-05T10:00:00')).text).toBe('In 5 days')
  })
  it('is live during the window and ended after it', () => {
    expect(startsIn(session, at('2026-10-10T16:00:00')).text).toBe('Live now')
    expect(startsIn(session, at('2026-10-10T21:30:00')).text).toBe('Ended')
  })
  it('shows nothing for completed or cancelled sessions', () => {
    expect(startsIn({ ...session, status: 'completed' })).toBeNull()
    expect(startsIn({ ...session, status: 'cancelled' })).toBeNull()
  })
  it('treats the demo session day as today', () => {
    expect(startsIn({ ...session, isToday: true }, at('2026-10-05T14:30:00')).text).toBe('Starts in 30 min')
  })
})
