// The maths behind MeetupGraph: meetups as a heat map that folds up into an isometric skyline.
// Dates, the grid of weeks, levels, stats, the camera and colour helpers. No DOM here, so it can be tested.
//
// The scene is one grid of boxes, a box per day (columns are weeks, rows are weekdays, Monday first). The flat
// view is that grid seen straight down; the 3D view is the same grid seen from a corner. Switching views swings
// one camera between the two while each week's bars rise (or settle) in a wave, oldest week first.

export const DAY_MS = 86400000

export const clamp01 = (v) => (v > 0 ? (v < 1 ? v : 1) : 0)
export const lerp = (a, b, t) => a + (b - a) * t
export const easeInOutCubic = (x) => {
  const t = clamp01(x)
  return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2
}
export const easeOutCubic = (x) => 1 - Math.pow(1 - clamp01(x), 3)
export const smoothstep = (a, b, x) => {
  const t = clamp01((x - a) / (b - a))
  return t * t * (3 - 2 * t)
}

// UTC midnight → "yyyy-MM-dd".
export const toKey = (ms) => new Date(ms).toISOString().slice(0, 10)

// Any date-ish value → UTC midnight of its calendar day. "yyyy-MM-dd" strings are read as written (no timezone
// drift), Date objects by their local day, numbers as UTC timestamps.
export function dayMs(v) {
  if (typeof v === 'number') return Math.floor(v / DAY_MS) * DAY_MS
  if (typeof v === 'string') {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(v)
    if (m) return Date.UTC(+m[1], +m[2] - 1, +m[3])
    v = new Date(v)
  }
  return Date.UTC(v.getFullYear(), v.getMonth(), v.getDate())
}

// A day's level, 0 to 4: simply how many meetups, up to 4. Meetups are few, so counts read better than shares.
export const levelOf = (count) => (count > 0 ? Math.min(4, count) : 0)

// The grid: `weeks` weeks up to and including this one, starting on `weekStart` (1 = Monday). It ends on the later
// of today and the last planned meetup (at most `ahead` weeks out). Cells: { date, count, level, week, day, planned, today, future }.
export function buildGrid({ history = [], planned = [], today, weeks = 26, ahead = 6, weekStart = 1 }) {
  const todayMs = dayMs(today)
  const todayKey = toKey(todayMs)
  const counts = new Map()
  for (const h of history) {
    if (!h || typeof h.date !== 'string' || !(h.count > 0)) continue
    const k = toKey(dayMs(h.date))
    counts.set(k, (counts.get(k) || 0) + h.count)
  }
  const plannedSet = new Set(planned.map((d) => toKey(dayMs(d))))
  const lastAllowed = todayMs + ahead * 7 * DAY_MS
  const furthest = [...plannedSet].map(dayMs).filter((ms) => ms > todayMs && ms <= lastAllowed).sort((a, b) => b - a)[0]
  const endMs = furthest || todayMs
  const thisWeek = todayMs - ((new Date(todayMs).getUTCDay() - weekStart + 7) % 7) * DAY_MS
  const start = thisWeek - (weeks - 1) * 7 * DAY_MS
  const cells = []
  for (let ms = start, i = 0; ms <= endMs; ms += DAY_MS, i++) {
    const date = toKey(ms)
    const count = counts.get(date) || 0
    cells.push({ date, count, level: levelOf(count), week: Math.floor(i / 7), day: i % 7, planned: plannedSet.has(date) && !count, today: date === todayKey, future: date > todayKey })
  }
  const max = cells.reduce((m, c) => Math.max(m, c.count), 0)
  return { cells, weeks: cells.length ? cells[cells.length - 1].week + 1 : 0, max }
}

// Total, the busiest day, and streaks counted in weeks (a week with at least one meetup keeps it going).
// The current streak may end last week: this week is not over yet.
export function computeStats(cells) {
  const past = cells.filter((c) => !c.future)
  let total = 0
  const busiest = { count: 0, date: null }
  const byWeek = new Map()
  for (const c of past) {
    total += c.count
    if (c.count > busiest.count) {
      busiest.count = c.count
      busiest.date = c.date
    }
    const w = byWeek.get(c.week) || { count: 0, start: c.date, end: c.date }
    w.count += c.count
    w.end = c.date
    byWeek.set(c.week, w)
  }
  const list = [...byWeek.values()]
  let run = 0
  let runStart = null
  let longest = { weeks: 0, start: null, end: null }
  for (const w of list) {
    if (w.count > 0) {
      if (run === 0) runStart = w.start
      run++
      if (run > longest.weeks) longest = { weeks: run, start: runStart, end: w.end }
    } else run = 0
  }
  let j = list.length - 1
  if (j >= 0 && list[j].count === 0) j--
  const endAt = j
  while (j >= 0 && list[j].count > 0) j--
  const n = endAt - j
  const current = n > 0 ? { weeks: n, start: list[j + 1].start, end: list[endAt].end } : { weeks: 0, start: null, end: null }
  return { total, first: past[0]?.date || null, last: past[past.length - 1]?.date || null, busiest, longest, current }
}

// A label on each week whose first day starts a new month; a cramped first label is dropped.
// Short English month names ("Sep", not "Sept").
export function monthLabels(cells, weeks, locale = 'en-US') {
  const fmt = new Intl.DateTimeFormat(locale, { month: 'short', timeZone: 'UTC' })
  const out = []
  let prev = -1
  for (let w = 0; w < weeks; w++) {
    const c = cells[w * 7]
    if (!c) break
    const m = +c.date.slice(5, 7)
    if (m !== prev) out.push({ week: w, label: fmt.format(dayMs(c.date)) })
    prev = m
  }
  if (out.length > 1 && out[1].week - out[0].week < 3) out.shift()
  return out
}

// Box height in grid units. Empty days are thin slabs. `max` has a floor of 3, so one meetup never towers.
export const barHeight = (count, max, scale = 1) => (count > 0 ? 0.4 + Math.pow(count / Math.max(3, max), 0.85) * 6.4 * scale : 0.2)

// The share of the morph each bar spends waiting: the wave sweeps from the oldest week to the newest.
export const WAVE = 0.42

// 0 → 1 as a bar rises during the morph. Every bar is flat at t = 0 and fully up at t = 1.
export function riseAt(t, week, weeks, day) {
  const d = (weeks > 1 ? week / (weeks - 1) : 0) * 0.36 + (day / 6) * 0.06
  return easeOutCubic((t - d) / (1 - WAVE))
}

export const YAW_3D = Math.PI / 4
export const ELEV_3D = (34 * Math.PI) / 180
export const YAW_RANGE = [(8 * Math.PI) / 180, (82 * Math.PI) / 180]
export const ELEV_RANGE = [(18 * Math.PI) / 180, (62 * Math.PI) / 180]

// e = 0 looks straight down (a plain heat map, heights invisible); e = 1 is the corner view. Orbit offsets apply
// only in proportion to e, so the flat view never tilts.
export function camera(e, dYaw = 0, dElev = 0) {
  const yaw = Math.min(YAW_RANGE[1], Math.max(0, lerp(0, YAW_3D + dYaw, e)))
  const elev = lerp(Math.PI / 2, Math.min(ELEV_RANGE[1], Math.max(ELEV_RANGE[0], ELEV_3D + dElev)), e)
  return { cs: Math.cos(yaw), sn: Math.sin(yaw), se: Math.sin(elev), ce: Math.cos(elev) }
}

// World (x = week, y = weekday, z = up) → screen, before scale and offset.
export const project = (c, x, y, z) => [x * c.cs - y * c.sn, (x * c.sn + y * c.cs) * c.se - z * c.ce]

export const mixRGB = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t]
