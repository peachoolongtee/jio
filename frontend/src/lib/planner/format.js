// Small formatting helpers shared by the planner and the screens.

// "15:00" -> 900 (minutes after midnight).
export function toMinutes(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number)
  return h * 60 + (m || 0)
}

// 900 -> "15:00". Wraps past midnight: 1500 -> "01:00".
export function fromMinutes(minutes) {
  const m = ((Math.round(minutes) % 1440) + 1440) % 1440
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`
}

// Price per person as a tier: $ under SGD 10, $$ SGD 10 to 25, $$$ above SGD 25.
export function priceTier(price) {
  if (price < 10) return '$'
  if (price <= 25) return '$$'
  return '$$$'
}

export function priceTierLabel(price) {
  const tier = priceTier(price)
  if (tier === '$') return 'Price $: under SGD 10 per person'
  if (tier === '$$') return 'Price $$: SGD 10 to 25 per person'
  return 'Price $$$: above SGD 25 per person'
}

// 45 -> "45 min", 120 -> "2 h", 90 -> "1 h 30 min".
export function durationLabel(minutes) {
  const m = Math.round(minutes)
  if (m < 60) return `${m} min`
  const h = Math.floor(m / 60)
  const rest = m % 60
  return rest ? `${h} h ${rest} min` : `${h} h`
}

// The time and the duration on one line: "15:00 · 45 min".
export function timeAndDuration(start, minutes) {
  const time = typeof start === 'number' ? fromMinutes(start) : start
  return `${time} · ${durationLabel(minutes)}`
}

export function minutesLabel(minutes) {
  return `${Math.round(minutes)} min`
}

// A distance for a card: metres under 1 km (to the nearest 10), then kilometres with one decimal.
export function distanceText(metres) {
  if (metres == null) return ''
  if (metres < 1000) return `${Math.max(10, Math.round(metres / 10) * 10)} m`
  return `${(metres / 1000).toFixed(1)} km`
}
