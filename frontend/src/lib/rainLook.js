// How rain looks on a map, in one place, so Home's dotted map (SingaporeMap) and the session map (PlannerMap, Leaflet) draw the
// same rain: "Layered drops". A feathered blue wash over the rainy area, and three layers of drops (far, middle, near) clipped
// by a feathered mask, so the rain has no hard edge. The colours are the tokens --rain-wash and --rain-streak (styles/tokens.css);
// the animation and reduced-motion rules are in styles/rain.css. DESIGN.md, "Weather", is the written form.
//
// Sizes are in "rain units": 1 unit is a pixel at the size the look was drawn for. A map that is drawn in other units gives a
// `scale` (SingaporeMap, whose units are about 110 m).
import { sourceLine } from './weatherText.js'

// The three layers of drops, far to near. `tile` is the repeating pattern; its height equals `travel`, the distance the layer
// falls in `seconds`, so the loop has no seam. `d` is one drop, `width` its stroke and `opacity` how strong the layer is.
export const RAIN_LAYERS = [
  { name: 'far', tile: [9, 12], d: 'M5 1 4.2 4', width: 0.8, opacity: 0.38, seconds: 1.7, travel: 12 },
  { name: 'mid', tile: [14, 20], d: 'M9 2 7.4 8', width: 1, opacity: 0.6, seconds: 1.1, travel: 20 },
  { name: 'near', tile: [22, 34], d: 'M14 3 10.8 13', width: 1.5, opacity: 0.85, seconds: 0.65, travel: 34 },
]

// The wash fades from its centre to nothing at the edge: [offset, opacity], the opacity running from 40% down to 0. The feather
// that masks the drops is white, opaque at the middle and clear at the edge.
export const WASH_STOPS = [[0, 0.4], [0.5, 0.28], [0.8, 0.1], [1, 0]]
export const FEATHER_STOPS = [[0, 1], [0.55, 0.85], [0.82, 0.3], [1, 0]]
// The drops stop a little inside the wash (66 of 72 in the design), so they end before the tint does.
export const DROPS_SHARE = 66 / 72
// How long the whole layer takes to fade in when it first appears.
export const FADE_IN_MS = 900

// A number as short text for markup. How to call: num(0.4800000001) -> '0.48'
export const num = (n) => String(Math.round(n * 1000) / 1000)

// The words on the chip for the rain on a map, or '' when there should be no chip. The block is a weather block
// (lib/weatherText.js): the chip names the two-hour forecast only when that is where the rain comes from.
//   live forecast, 2-hour area basis -> 'Rain likely · next 2 h'
//   live forecast, any other basis   -> 'Rain likely' (the 24-hour forecast makes no claim about two hours)
//   simulated forecast               -> 'Simulated rain' (the demo's, never the real forecast)
//   unavailable, outside the window, or no block -> '' (nothing is known, so nothing is claimed)
// How to call: rainChipText({ source: 'live', basis: 'area' }) -> 'Rain likely · next 2 h'
export function rainChipText(block) {
  const kind = block ? sourceLine(block).kind : ''
  if (kind === 'simulated') return 'Simulated rain'
  if (kind === 'live') return block.basis === 'area' ? 'Rain likely · next 2 h' : 'Rain likely'
  return ''
}

// One rain patch as SVG markup, in its own coordinates (for Leaflet, which takes an icon as HTML): a square `size` units
// across, the wash and the drops centred in it. `uid` makes its ids unique on the page; `fade` adds the 900 ms fade-in (left
// off when a patch is only being resized). Only numbers and the ids go into the markup, never text from outside.
// How to call: rainPatchSvg({ size: 240, uid: 'rain-1', fade: true }) -> '<svg ...>...</svg>'
export function rainPatchSvg({ size, uid, fade = false }) {
  const r = size / 2
  const maskR = r * DROPS_SHARE
  const stops = (list, cls) => list.map(([o, a]) => `<stop offset="${o}" class="${cls}" stop-opacity="${a}"/>`).join('')
  const white = (list) => list.map(([o, a]) => `<stop offset="${o}" class="rain-feather" stop-opacity="${a}"/>`).join('')
  const patterns = RAIN_LAYERS.map((l) => `<pattern id="${uid}-${l.name}" width="${l.tile[0]}" height="${l.tile[1]}" patternUnits="userSpaceOnUse"><path class="rain-drop" stroke-width="${l.width}" opacity="${l.opacity}" d="${l.d}"/></pattern>`).join('')
  const falls = RAIN_LAYERS.map((l) => `<rect class="rain-fall rain-fall--${l.name}" style="--rain-h:${l.travel}px" x="0" y="${-l.travel}" width="${size}" height="${size + l.travel}" fill="url(#${uid}-${l.name})"/>`).join('')
  return (
    `<svg class="rain-patch${fade ? ' rain-in' : ''}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">` +
    `<defs><radialGradient id="${uid}-wash">${stops(WASH_STOPS, 'rain-wash')}</radialGradient>` +
    `<radialGradient id="${uid}-feather">${white(FEATHER_STOPS)}</radialGradient>` +
    `<mask id="${uid}-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${num(maskR)}" fill="url(#${uid}-feather)"/></mask>` +
    `${patterns}</defs>` +
    `<circle cx="${r}" cy="${r}" r="${r}" fill="url(#${uid}-wash)"/>` +
    `<g mask="url(#${uid}-mask)">${falls}</g></svg>`
  )
}

// The rainy places of a session map, with places close together made one: several stops in the same forecast area would draw
// one wash over another, darker and heavier. A point within `within` metres of one already kept is dropped.
// How to call: rainSpots([{ lat: 1.35, lng: 103.85 }, { lat: 1.3502, lng: 103.8503 }]) -> [{ lat: 1.35, lng: 103.85 }]
export function rainSpots(points, within = 1200) {
  const kept = []
  for (const p of points || []) {
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue
    // Metres on the ground at Singapore's latitude: a degree of latitude is 111 km, a degree of longitude 111 km times cos(1.35 degrees).
    const near = kept.some((k) => Math.hypot((k.lat - p.lat) * 111320, (k.lng - p.lng) * 111320 * Math.cos((p.lat * Math.PI) / 180)) < within)
    if (!near) kept.push({ lat: p.lat, lng: p.lng })
  }
  return kept
}

// The rain on an itinerary map: where it is likely (the stops whose weather says so), and the words for the chip. A stop's
// weather is `weatherOf(stop)` ({ rainLikely, source, ... }, lib/weatherText.js); the block is the one the screen's source
// line reads. Nothing is drawn for a forecast that is neither live nor simulated, and the chip is empty when the block's source is not known.
// How to call: itineraryRain(itinerary.stops, weatherOf, weatherBlock) -> { places: [{ lat, lng }], text: 'Rain likely' }
export function itineraryRain(stops, weatherOf, block) {
  const places = rainSpots(
    (stops || [])
      .filter((s) => {
        const w = weatherOf(s)
        return w?.rainLikely === true && (w.source === 'live' || w.source === 'simulated')
      })
      .map((s) => ({ lat: s.venue?.lat, lng: s.venue?.lng })),
  )
  return { places, text: places.length ? rainChipText(block) : '' }
}
