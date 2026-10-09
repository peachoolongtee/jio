// Choosing the meeting area moved to the backend planner (backend/tests/slots.test.js and stress.test.js).
// The whole flow, frontend and backend together, is in lib/__tests__/api.backend.test.js.
import { describe, expect, it } from 'vitest'
import { meetingResultLine } from '../meetingArea.js'

describe('meeting area result line', () => {
  it('says nobody travels more than the longest trip', () => {
    expect(meetingResultLine({ method: 'fairest', maxMinutes: 32, count: 6 }, 'Bishan')).toBe('Fairest for 6 people: nobody travels more than about 32 minutes.')
  })

  it('says when routing is unavailable and the area is the geographic centre', () => {
    expect(meetingResultLine({ method: 'centre', maxMinutes: 40, count: 3 }, 'Toa Payoh')).toMatch(/^Routing is unavailable, so Toa Payoh is the geographic centre/)
  })

  it('names the shared place when everyone starts there', () => {
    expect(meetingResultLine({ method: 'same', maxMinutes: 0, count: 3 }, 'Novena')).toBe('Fairest for 3 people: everyone starts from Novena.')
  })

  it('is empty before there is a meeting area', () => {
    expect(meetingResultLine(null, '')).toBe('')
  })
})
