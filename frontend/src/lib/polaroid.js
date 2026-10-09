// The physics behind PolaroidLine: prints pegged to a sagging string that slides when dragged, each print
// swinging on its peg with the speed it is given and settling back. No DOM here, so it can be tested.

export const clamp = (v, a, b) => Math.min(b, Math.max(a, v))

// Height of a string sagging by `sag` between (0, y0) and (w, y0), at x: a parabola.
export function stringY(x, w, y0, sag) {
  const t = clamp(x / w, 0, 1)
  return y0 + 4 * sag * t * (1 - t)
}

// One step of a critically damped spring toward `target`: no wobble at the end, just a smooth stop.
export function springStep(x, v, target, dt, k = 70) {
  const c = 2 * Math.sqrt(k)
  const nv = v + (k * (target - x) - c * v) * dt
  return [x + nv * dt, nv]
}

// One step of a print's swing (angle in radians). `lineVel` is how fast the prints move on screen (px/s,
// + = moving right): a print lags behind the motion, gravity pulls it back, and the air damps it.
export function swingStep(a, w, lineVel, dt, gain) {
  const nw = w + (-38 * a - 4.2 * w + lineVel * 0.0034 * gain) * dt
  return [clamp(a + nw * dt, -0.6, 0.6), nw]
}

// The print nearest the middle for a line offset.
export const nearestAt = (off, spacing, n) => clamp(Math.round(off / spacing), 0, Math.max(0, n - 1))

export const pad2 = (n) => (n < 10 ? `0${n}` : String(n))
