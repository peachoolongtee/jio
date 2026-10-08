// A burst of confetti across the screen, for a moment worth celebrating (the plan is confirmed).
// One canvas over everything that ignores the pointer, removed when the last piece has fallen.
// Nothing happens when the person prefers reduced motion.
//   confetti()

// The app's own colours, read from the tokens so the confetti matches the categories and people.
const COLOURS = ['--primary', '--cat-eat-fg', '--cat-drink-fg', '--cat-shop-fg', '--cat-activity-fg', '--person-1', '--person-4', '--scale-middle']
const COUNT = 160
const GRAVITY = 0.32
const DRAG = 0.985
const LIFE_MS = 3200

export function confetti() {
  if (typeof window === 'undefined' || window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) return
  const styles = getComputedStyle(document.documentElement)
  const colours = COLOURS.map((name) => styles.getPropertyValue(name).trim()).filter(Boolean)

  const canvas = document.createElement('canvas')
  const ratio = window.devicePixelRatio || 1
  const width = window.innerWidth
  const height = window.innerHeight
  canvas.width = width * ratio
  canvas.height = height * ratio
  Object.assign(canvas.style, { position: 'fixed', inset: '0', width: '100%', height: '100%', pointerEvents: 'none', zIndex: '60' })
  canvas.setAttribute('aria-hidden', 'true')
  document.body.appendChild(canvas)
  const ctx = canvas.getContext('2d')
  ctx.scale(ratio, ratio)

  // Two cannons, one at each bottom corner, firing up and inwards.
  const pieces = Array.from({ length: COUNT }, (_, i) => {
    const left = i % 2 === 0
    const angle = (left ? -60 : -120) + (Math.random() * 40 - 20)
    const speed = 13 + Math.random() * 11
    return {
      x: left ? width * 0.05 : width * 0.95,
      y: height * 0.95,
      vx: Math.cos((angle * Math.PI) / 180) * speed,
      vy: Math.sin((angle * Math.PI) / 180) * speed,
      size: 6 + Math.random() * 6,
      spin: Math.random() * Math.PI,
      turn: (Math.random() - 0.5) * 0.3,
      wobble: Math.random() * 10,
      colour: colours[i % colours.length],
      round: Math.random() < 0.3,
    }
  })

  const start = performance.now()
  function frame(now) {
    const t = now - start
    ctx.clearRect(0, 0, width, height)
    // The last half second fades everything out.
    ctx.globalAlpha = Math.max(0, Math.min(1, (LIFE_MS - t) / 500))
    for (const p of pieces) {
      p.vx *= DRAG
      p.vy = p.vy * DRAG + GRAVITY
      p.x += p.vx + Math.sin((t / 200) + p.wobble) * 0.6
      p.y += p.vy
      p.spin += p.turn
      ctx.save()
      ctx.translate(p.x, p.y)
      ctx.rotate(p.spin)
      ctx.fillStyle = p.colour
      if (p.round) {
        ctx.beginPath()
        ctx.arc(0, 0, p.size / 2.4, 0, Math.PI * 2)
        ctx.fill()
      } else {
        // A strip that flips as it turns, like paper.
        ctx.fillRect(-p.size / 2, -p.size / 4, p.size, (p.size / 2) * Math.abs(Math.cos(p.spin * 2)) + 1)
      }
      ctx.restore()
    }
    if (t < LIFE_MS) requestAnimationFrame(frame)
    else canvas.remove()
  }
  requestAnimationFrame(frame)
}
