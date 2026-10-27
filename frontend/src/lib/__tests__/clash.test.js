// The rule that one person cannot be in two meetups at once (lib/clash.js).
import { describe, expect, it } from 'vitest'
import { ClashError, findClash, overlaps } from '../clash.js'

const mine = (extra = {}) => ({
  id: 's1', title: 'Dinner', date: '2026-10-28', start: '19:00', end: '21:00', status: 'confirmed',
  members: [{ id: 'me', state: 'joined' }, { id: 'ann', state: 'joined' }], ...extra,
})
const ask = (sessions, over = {}) => findClash(sessions, { me: 'me', date: '2026-10-28', start: '20:00', end: '22:00', ...over })

describe('overlaps', () => {
  it('is true when the times share any minute', () => {
    expect(overlaps('19:00', '21:00', '20:00', '22:00')).toBe(true)
    expect(overlaps('19:00', '21:00', '19:30', '20:00')).toBe(true)
    expect(overlaps('19:00', '21:00', '18:00', '22:00')).toBe(true)
  })
  it('is false back to back or apart', () => {
    expect(overlaps('19:00', '21:00', '21:00', '23:00')).toBe(false)
    expect(overlaps('19:00', '21:00', '17:00', '19:00')).toBe(false)
    expect(overlaps('19:00', '21:00', '22:00', '23:00')).toBe(false)
  })
})

describe('findClash', () => {
  it('names the meetup in the way', () => {
    expect(ask([mine()])).toEqual({ id: 's1', title: 'Dinner', date: '2026-10-28', start: '19:00', end: '21:00' })
  })
  it('lets a different day or a back to back time through', () => {
    expect(ask([mine()], { date: '2026-10-29' })).toBeNull()
    expect(ask([mine()], { start: '21:00', end: '23:00' })).toBeNull()
  })
  it('counts every state that still holds the time, and none that has ended', () => {
    for (const status of ['inviting', 'locating', 'voting', 'confirmed']) expect(ask([mine({ status })])).not.toBeNull()
    for (const status of ['completed', 'cancelled']) expect(ask([mine({ status })])).toBeNull()
  })
  it('counts only meetups the person has joined', () => {
    expect(ask([mine({ members: [{ id: 'me', state: 'invited' }] })])).toBeNull()
    expect(ask([mine({ members: [{ id: 'me', state: 'opted_out' }] })])).toBeNull()
    expect(ask([mine({ members: [{ id: 'ann', state: 'joined' }] })])).toBeNull()
  })
  it('leaves out the meetup being edited and the demo showcase', () => {
    expect(ask([mine()], { excludeId: 's1' })).toBeNull()
    expect(ask([mine({ keepOpen: true })])).toBeNull()
  })
})

describe('ClashError', () => {
  it('carries the meetup and a code the screens recognise', () => {
    const err = new ClashError({ id: 's1', title: 'Dinner', date: '2026-10-28', start: '19:00', end: '21:00' })
    expect(err.code).toBe('schedule_clash')
    expect(err.message).toContain('Dinner')
    expect(err.clash.id).toBe('s1')
  })
})
