import { describe, expect, it } from 'vitest'
import { buildSlots, groupStayUntil, stayOptions } from '../slots.js'
import { toMinutes } from '../format.js'
import { FRIEND_PICKS } from '../../mock/people.js'

const window = { windowStart: toMinutes('15:00'), windowEnd: toMinutes('21:00') }

describe('slots', () => {
  it('turns the most picked categories into ordered slots inside the window', () => {
    const slots = buildSlots({ prefs: FRIEND_PICKS, ...window })
    expect(slots.map((s) => `${s.time} ${s.category}`)).toEqual(['15:00 activity', '17:00 shop', '18:30 eat'])
  })

  it('leaves out a category fewer than half the group picked', () => {
    const slots = buildSlots({ prefs: FRIEND_PICKS, ...window })
    expect(slots.map((s) => s.category)).not.toContain('drink')
  })

  it('requires at least half of the responders to pick a category', () => {
    const prefs = {
      a: { categories: ['eat'] }, b: { categories: ['drink'] },
      c: { categories: ['shop'] }, d: { categories: ['activity'] },
    }
    expect(buildSlots({ prefs, windowStart: 600, windowEnd: 1200 })).toEqual([])
  })

  it('moves the other slots when one is deleted, and keeps it deleted', () => {
    const slots = buildSlots({ prefs: FRIEND_PICKS, ...window, deleted: ['shop'] })
    expect(slots.map((s) => s.category)).toEqual(['activity', 'eat'])
    expect(slots.find((s) => s.category === 'eat').time).toBe('18:30')
  })

  it('has no slots until someone picks a category', () => {
    expect(buildSlots({ prefs: {}, ...window })).toEqual([])
    expect(buildSlots({ prefs: { ian: { categories: [], until: null } }, ...window })).toEqual([])
  })

  it('ends the plan when at least half the group can still stay', () => {
    const prefs = {
      a: { categories: ['eat'], until: toMinutes('18:00') },
      b: { categories: ['eat'], until: toMinutes('19:00') },
      c: { categories: ['eat'], until: null },
    }
    expect(groupStayUntil(prefs, window.windowEnd)).toBe(toMinutes('19:00'))
    const slots = buildSlots({ prefs, ...window })
    const last = slots[slots.length - 1]
    expect(last.start + last.duration).toBeLessThanOrEqual(toMinutes('19:00'))
  })

  it('places Eat near lunch in a morning window', () => {
    const prefs = { a: { categories: ['activity', 'eat', 'shop'], until: null } }
    const slots = buildSlots({ prefs, windowStart: toMinutes('10:00'), windowEnd: toMinutes('16:00') })
    expect(slots.find((s) => s.category === 'eat').time).toBe('12:00')
  })

  it('offers stay times from two hours in, up to the end', () => {
    expect(stayOptions(window.windowStart, window.windowEnd)).toEqual([17, 18, 19, 20, 21].map((h) => h * 60))
  })
})
