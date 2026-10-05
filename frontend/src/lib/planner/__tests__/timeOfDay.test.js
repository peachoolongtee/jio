import { describe, expect, it } from 'vitest'
import { fitsMealWindow, isOpenDuring, mealWindow } from '../timeOfDay.js'
import { rankForSlot } from '../suggestions.js'
import { toMinutes } from '../format.js'
import { VENUES } from '../../mock/venues.js'
import { AREAS } from '../../mock/places.js'

const at = (t) => toMinutes(t)

describe('meal windows', () => {
  it('maps times to the right window', () => {
    expect(mealWindow(at('07:00'))).toBe('breakfast')
    expect(mealWindow(at('10:29'))).toBe('breakfast')
    expect(mealWindow(at('11:00'))).toBe('lunch')
    expect(mealWindow(at('14:29'))).toBe('lunch')
    expect(mealWindow(at('14:30'))).toBe('tea')
    expect(mealWindow(at('15:00'))).toBe('tea')
    expect(mealWindow(at('17:30'))).toBe('dinner')
    expect(mealWindow(at('20:59'))).toBe('dinner')
    expect(mealWindow(at('21:00'))).toBe('supper')
    expect(mealWindow(at('23:30'))).toBe('supper')
  })

  it('shows cafés and dessert at 15:00, not lunch places', () => {
    const lunchPlace = { category: 'eat', serves: ['lunch', 'dinner'] }
    const dessert = { category: 'eat', serves: ['tea', 'supper'] }
    expect(fitsMealWindow(lunchPlace, at('15:00'), 'eat')).toBe(false)
    expect(fitsMealWindow(dessert, at('15:00'), 'eat')).toBe(true)
  })

  it('never puts a lunch place in a 15:00 Eat slot, anywhere in the data', () => {
    for (const area of AREAS) {
      const slot = { id: 'eat', category: 'eat', start: at('15:00'), duration: 90 }
      const { options } = rankForSlot(VENUES, { slot, area })
      for (const option of options) {
        expect(option.venue.serves).toContain('tea')
        expect(['dessert', 'cafe', 'hawker', 'restaurant']).toContain(option.venue.kind)
      }
      const names = options.map((o) => o.venue.name)
      expect(names).not.toContain('Ming Kee Chicken Rice')
      expect(names).not.toContain("Loo's Hainanese Curry Rice")
    }
  })
})

describe('opening hours', () => {
  const venue = { hours: ['11:00-14:30', '17:00-22:00'] }
  it('needs the place open for the whole slot', () => {
    expect(isOpenDuring(venue, at('11:30'), at('13:00'))).toBe(true)
    expect(isOpenDuring(venue, at('14:00'), at('15:00'))).toBe(false)
    expect(isOpenDuring(venue, at('15:00'), at('16:30'))).toBe(false)
    expect(isOpenDuring(venue, at('18:30'), at('20:00'))).toBe(true)
  })

  it('handles places that close after midnight', () => {
    const late = { hours: ['17:00-02:00'] }
    expect(isOpenDuring(late, at('22:00'), at('23:30'))).toBe(true)
    expect(isOpenDuring(late, at('23:30'), at('25:00') )).toBe(true)
    expect(isOpenDuring(late, at('15:00'), at('16:00'))).toBe(false)
  })

  it('never suggests a place that is closed during its slot', () => {
    const bishan = AREAS.find((a) => a.id === 'bishan')
    const slot = { id: 'eat', category: 'eat', start: at('14:00'), duration: 90 }
    const { options } = rankForSlot(VENUES, { slot, area: bishan })
    for (const option of options) expect(isOpenDuring(option.venue, slot.start, slot.start + slot.duration)).toBe(true)
  })
})
