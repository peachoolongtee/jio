// Opening hours and meal periods are checked by the backend planner (backend/tests/geo-filters.test.js,
// slots.test.js). The screens still name the meal window a slot falls in.
import { describe, expect, it } from 'vitest'
import { mealWindow } from '../timeOfDay.js'
import { toMinutes } from '../format.js'

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
})
