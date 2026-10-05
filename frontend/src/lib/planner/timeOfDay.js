// Time of day: suggestions must fit the time of their slot.
//
// Meal windows: breakfast 07:00 to 10:30, lunch 11:00 to 14:30, tea 14:30 to 17:30,
// dinner 17:30 to 21:00, supper after 21:00.
// A slot at 15:00 is tea: cafés and dessert, not lunch places.
// A place that is closed at any point during its slot is never suggested.
import { toMinutes } from './format.js'

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

// Opening hours are strings such as "07:30-20:00". A closing time before the opening time runs past midnight.
function ranges(venue) {
  return (venue.hours || []).map((text) => {
    const [open, close] = text.split('-').map(toMinutes)
    return { open, close: close <= open ? close + 1440 : close }
  })
}

// Is the venue open for the whole of [start, end) (minutes after midnight)?
export function isOpenDuring(venue, start, end) {
  return ranges(venue).some((r) => {
    // Try the slot as it is, and shifted by a day for places that open late and close after midnight.
    return [0, 1440].some((shift) => start + shift >= r.open && end + shift <= r.close)
  })
}

// Does the venue fit the time of day of the slot?
// Food and drink must serve the meal window the slot starts in; Shop and Activity only need to be open.
export function fitsMealWindow(venue, slotStart, category) {
  if (category !== 'eat' && category !== 'drink') return true
  return (venue.serves || []).includes(mealWindow(slotStart))
}
