// Time of day: the meal window a slot falls in, for the screens.
// Whether a place is open and serves that meal is checked by the backend planner.
//
// Meal windows: breakfast 07:00 to 10:30, lunch 11:00 to 14:30, tea 14:30 to 17:30,
// dinner 17:30 to 21:00, supper after 21:00.

export const MEAL_WINDOWS = [
  { id: 'breakfast', label: 'Breakfast', from: 7 * 60, to: 10 * 60 + 30 },
  { id: 'lunch', label: 'Lunch', from: 11 * 60, to: 14 * 60 + 30 },
  { id: 'tea', label: 'Tea', from: 14 * 60 + 30, to: 17 * 60 + 30 },
  { id: 'dinner', label: 'Dinner', from: 17 * 60 + 30, to: 21 * 60 },
  { id: 'supper', label: 'Supper', from: 21 * 60, to: 27 * 60 },
]

// The meal window a minute of the day falls in.
// 10:30 to 11:00 counts as lunch (the next meal), and 03:00 to 07:00 as breakfast.
export function mealWindow(minute) {
  const m = ((minute % 1440) + 1440) % 1440
  if (m < 3 * 60) return 'supper'
  if (m < 7 * 60) return 'breakfast'
  const found = MEAL_WINDOWS.find((w) => m >= w.from && m < w.to)
  return found ? found.id : 'lunch'
}
