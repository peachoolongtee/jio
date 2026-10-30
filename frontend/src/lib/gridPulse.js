// The colours of the grid behind Leaderboard, Rewards and Profile (components/ui/GridPulse.vue), kept apart so they are tested
// without a canvas. The lead found the old spectrum (yellow through red and blue to green) too distracting at the walkthrough of
// 30 October 2026, so a lit cell is now a pale grey, and now and then a faint wash of the brand red. Nothing lights by itself, and
// the trail behind the pointer is short.

// The defaults GridPulse takes: cell size (px), how far from the pointer a cell catches light (cells), how many cells light by
// themselves each beat (none), and the most cells lit at once.
export const GRID_PULSE = { cell: 24, reach: 1.6, ambient: 0, maxLit: 40 }

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
