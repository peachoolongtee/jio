// How rain looks on a map, in one place, so Home's dotted map (SingaporeMap) and the session map (PlannerMap, Leaflet) draw the
// same rain. A feathered blue wash over the rainy area, and slanted streaks of rain falling through it, clipped by a feathered
// mask, so the rain has no hard edge. The colours are the tokens --rain-wash and --rain-streak (styles/tokens.css);
// the animation and reduced-motion rules are in styles/rain.css. DESIGN.md, "Weather", is the written form.
//
// Sizes are in "rain units": 1 unit is a pixel at the size the look was drawn for. A map that is drawn in other units gives a
// `scale` (SingaporeMap, whose units are about 110 m).
import { forecastIsCurrent, rainWindow } from './weatherText.js'

// The drops: thin streaks that fade in from the top, each with its own place, length, speed and strength, falling at a slant like
// wind-blown rain (Darius, 4 November 2026, after the "rain background" component; it was three repeating layers of drops). In rain
// units: `width` and `length` of a streak (a streak is 10 times as long as it is wide), `opacity`, the `seconds` a streak takes to fall
// through the patch, the wind's `angle` in degrees, and how many streaks a patch has for its area (`perArea` units squared each,
// between `min` and `max`).
export const RAIN_STREAKS = { width: [1.2, 2.2], length: 10, opacity: [0.45, 0.95], seconds: [0.55, 1.1], angle: 10, perArea: 1100, min: 40, max: 140 }

// A small seeded random number source, so a patch draws the same streaks every time it is drawn (a redraw, a zoom).
// How to call: const next = seeded(7); next() -> 0.27...
function seeded(seed) {
  let t = Math.floor(seed) >>> 0 || 1
  return () => {
    t = (t + 0x6d2b79f5) >>> 0
    let x = Math.imul(t ^ (t >>> 15), 1 | t)
    x = (x + Math.imul(x ^ (x >>> 7), 61 | x)) ^ x
    return ((x ^ (x >>> 14)) >>> 0) / 4294967296
  }
}

// The streaks of one patch `size` units across, in that patch's own units (scale: map units for each rain unit, as for SingaporeMap).
// Each is { x, length, width, opacity, seconds, delay, still }: it starts just above the patch at x, falls `travel` (the patch and its
// own length), starts `delay` seconds into its fall (negative, so the patch is full of rain at once) and, under reduced motion, stands
// `still` units down. `max` raises the cap on streaks, and `pace` keeps their speed for a bigger area (the seconds are for 240 rain units
// of fall, and grow with the fall), for rain over a whole map (SingaporeMap).
// How to call: rainStreaks({ size: 240, seed: 3 }) -> { travel: 260, drops: [{ x: 31.2, length: 14, ... }, ...] }
export function rainStreaks({ size, seed = 1, scale = 1, max = RAIN_STREAKS.max, pace = false }) {
  const S = RAIN_STREAKS
  const next = seeded(seed)
  const between = ([lo, hi]) => lo + next() * (hi - lo)
  const units = size / scale
  const count = Math.round(Math.min(max, Math.max(S.min, (units * units) / S.perArea)))
  const slow = pace ? Math.max(1, units / 240) : 1
  // The slant moves the streaks sideways as they fall, so they start across a wider band than the patch, and every part of it is rained on.
  const spread = size * 1.4
  const maxLength = S.width[1] * S.length * scale
  const travel = size + maxLength * 2
  const drops = []
  for (let i = 0; i < count; i++) {
    const width = between(S.width) * scale
    const seconds = between(S.seconds) * slow
    drops.push({
      x: num(size / 2 - spread / 2 + next() * spread),
      width: num(width),
      length: num(width * S.length),
      opacity: num(between(S.opacity)),
      seconds: num(seconds),
      delay: num(-next() * seconds),
      still: num(next() * travel),
    })
  }
  return { travel: num(travel), top: num(-maxLength), angle: S.angle, drops }
}

// A seed for a patch from where it is, so one place always has the same rain. How to call: rainSeed(1.35, 103.85) -> 1385
export const rainSeed = (lat, lng) => Math.round(Math.abs(lat * 10007 + lng * 7919) * 100)

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
// (lib/weatherText.js): the chip names the two-hour forecast only when that is where the rain comes from, by `rainWindow`.
//   live forecast, 2-hour area basis -> 'Rain likely · next 2 h'
//   live forecast, any other basis   -> 'Rain likely' (the 24-hour forecast makes no claim about two hours)
//   simulated forecast               -> '' (the demo's: no chip on the map, Darius, 4 November 2026; the page's "Simulated forecast"
//                                       note still says the weather is made up)
//   unavailable, outside the window, or no block -> '' (nothing is known, so nothing is claimed)
// How to call: rainChipText({ source: 'live', basis: 'area' }) -> 'Rain likely · next 2 h'
export function rainChipText(block) {
  const kind = rainWindow(block)
  if (kind === 'simulated') return ''
  if (kind === 'next2h') return 'Rain likely · next 2 h'
  return kind === 'live' ? 'Rain likely' : ''
}

// A new id prefix for each patch drawn, shared by every map on the page, so no two patches ever share a gradient or mask id.
// How to call: nextRainUid() -> 'rain-1'
let uidSeq = 0
export const nextRainUid = () => `rain-${++uidSeq}`

// One rain patch as SVG markup, in its own coordinates (for Leaflet, which takes an icon as HTML): a square `size` units
// across, the wash and the streaks centred in it. `uid` makes its ids unique on the page; `fade` adds the 900 ms fade-in (left
// off when a patch is only being resized); `seed` picks its streaks (rainSeed). Only numbers and the ids go into the markup, never
// text from outside. How to call: rainPatchSvg({ size: 240, uid: 'rain-1', fade: true, seed: 1385 }) -> '<svg ...>...</svg>'
export function rainPatchSvg({ size, uid, fade = false, seed = 1 }) {
  const r = size / 2
  const maskR = r * DROPS_SHARE
  const stops = (list, cls) => list.map(([o, a]) => `<stop offset="${o}" class="${cls}" stop-opacity="${a}"/>`).join('')
  const white = (list) => list.map(([o, a]) => `<stop offset="${o}" class="rain-feather" stop-opacity="${a}"/>`).join('')
  const rain = rainStreaks({ size, seed })
  const drops = rain.drops.map((d) => `<rect class="rain-streak" style="--rain-s:${d.seconds}s;--rain-d:${d.delay}s;--rain-still:${d.still}px" x="${d.x}" y="${rain.top}" width="${d.width}" height="${d.length}" rx="${d.width}" opacity="${d.opacity}" fill="url(#${uid}-streak)"/>`).join('')
  return (
    `<svg class="rain-patch${fade ? ' rain-in' : ''}" width="${size}" height="${size}" viewBox="0 0 ${size} ${size}" aria-hidden="true" focusable="false">` +
    `<defs><radialGradient id="${uid}-wash">${stops(WASH_STOPS, 'rain-wash')}</radialGradient>` +
    `<radialGradient id="${uid}-feather">${white(FEATHER_STOPS)}</radialGradient>` +
    `<linearGradient id="${uid}-streak" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="rain-streak-stop" stop-opacity="0"/><stop offset="1" class="rain-streak-stop" stop-opacity="1"/></linearGradient>` +
    `<mask id="${uid}-mask" maskUnits="userSpaceOnUse" x="0" y="0" width="${size}" height="${size}"><circle cx="${r}" cy="${r}" r="${num(maskR)}" fill="url(#${uid}-feather)"/></mask></defs>` +
    `<circle cx="${r}" cy="${r}" r="${r}" fill="url(#${uid}-wash)"/>` +
    `<g mask="url(#${uid}-mask)"><g class="rain-wind" style="--rain-travel:${rain.travel}px" transform="rotate(${rain.angle} ${r} ${r})">${drops}</g></g></svg>`
  )
}

// The most patches one map draws: each has its own animated streaks, so the cost grows with their number.
export const MAX_RAIN_PATCHES = 6

// The rainy places of a map, with places in the same spot made one: two stops in one building would draw one wash over another,
// darker and heavier. A point within `within` metres of one already kept is dropped, and no more than MAX_RAIN_PATCHES are kept.
// Stops in different places each keep their own patch, so every rainy stop in view has rain round it.
// How to call: rainSpots([{ lat: 1.35, lng: 103.85 }, { lat: 1.3502, lng: 103.8503 }]) -> [{ lat: 1.35, lng: 103.85 }]
export function rainSpots(points, within = 150) {
  const kept = []
  for (const p of points || []) {
    if (kept.length >= MAX_RAIN_PATCHES) break
    if (!Number.isFinite(p?.lat) || !Number.isFinite(p?.lng)) continue
    // Metres on the ground at Singapore's latitude: a degree of latitude is 111 km, a degree of longitude 111 km times cos(1.35 degrees).
    const near = kept.some((k) => Math.hypot((k.lat - p.lat) * 111320, (k.lng - p.lng) * 111320 * Math.cos((p.lat * Math.PI) / 180)) < within)
    if (!near) kept.push({ lat: p.lat, lng: p.lng })
  }
  return kept
}

// The rain on an itinerary map: where it is likely (the stops whose weather says so, while that forecast is current), and the words
// for the chip. A stop's weather is `weatherOf(stop)` ({ rainLikely, source, validUntil, issuedAt, ... }, lib/weatherText.js); the block is
// the one the screen's source line reads, and gives the times a stop's weather lacks. Nothing is drawn for a forecast that is neither
// live nor simulated, or that has run out (a forecast stored at confirm time is not current hours later); `now` is the clock.
// How to call: itineraryRain(itinerary.stops, weatherOf, weatherBlock, new Date()) -> { places: [{ lat, lng }], text: 'Rain likely' }
export function itineraryRain(stops, weatherOf, block, now = new Date()) {
  const places = rainSpots(
    (stops || [])
      .filter((s) => {
        const w = weatherOf(s)
        return w?.rainLikely === true && forecastIsCurrent(w, block, now)
      })
      .map((s) => ({ lat: s.venue?.lat, lng: s.venue?.lng })),
  )
  return { places, text: places.length ? rainChipText(block) : '' }
}
