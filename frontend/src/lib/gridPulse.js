// The colours of the grid behind Leaderboard, Rewards and Profile (components/ui/GridPulse.vue), kept apart so they are tested
// without a canvas. The spectrum runs down the field like a printed colour chart (yellow at the top, through orange, red, magenta and
// blue, to green), so a sweep reveals one band of colour, not confetti, and a few cells light on their own. It was muted to pale grey
// on 30 October 2026 and brought back by Darius on 4 November 2026; the grey paint (cellPaint) is kept for a calmer use.

// The defaults GridPulse takes: cell size (px), how far from the pointer a cell catches light (cells), how many cells light by
// themselves each beat (none), and the most cells lit at once.
export const GRID_PULSE = { cell: 24, reach: 2.6, ambient: 2, maxLit: 180 }

// Hue at the top of the field, and how far it turns by the bottom; each cell takes one of the lightnesses, so a sweep reads as a field
// of tints rather than one flat colour.
const HUE_TOP = 60
const HUE_SPAN = 270
const TINTS = [88, 80, 72, 64, 56]

// The paint for a lit cell in row `row` of `rows`, from one random number in [0, 1) for its tint: the row's place in the spectrum.
// How to call: spectrumPaint(0, 20, 0.5) -> { colour: 'hsl(60 94% 72%)', alpha: 1 }
export function spectrumPaint(row, rows, random) {
  const t = rows > 1 ? Math.min(1, row / (rows - 1)) : 0
  const hue = (((HUE_TOP - t * HUE_SPAN) % 360) + 360) % 360
  const tint = TINTS[Math.min(TINTS.length - 1, Math.floor(random * TINTS.length))]
  return { colour: `hsl(${Math.round(hue)} 94% ${tint}%)`, alpha: 1 }
}

// Grey lightnesses (%), so a sweep reads as a soft texture rather than one flat block.
const GREYS = [90, 92, 94]
// The share of lit cells that take the brand red, and how strongly it shows.
const RED_SHARE = 0.12
const RED_ALPHA = 0.16
const GREY_ALPHA = 0.7

// The paint for one lit cell, from one random number in [0, 1): a CSS colour and the most it may show (its alpha at full light).
// `red` is the brand red as the page has it (--primary).
// How to call: cellPaint(Math.random(), '#ff385c') -> { colour: 'hsl(0 0% 92%)', alpha: 0.7 }
export function cellPaint(random, red = '#ff385c') {
  if (random < RED_SHARE) return { colour: red, alpha: RED_ALPHA }
  const pick = Math.min(GREYS.length - 1, Math.floor(((random - RED_SHARE) / (1 - RED_SHARE)) * GREYS.length))
  return { colour: `hsl(0 0% ${GREYS[pick]}%)`, alpha: GREY_ALPHA }
}
