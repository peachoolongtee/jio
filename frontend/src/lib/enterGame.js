// The "entering a game" move from Home's map pin into the create-session screen. A red circle bursts out of the
// pin and fills the screen, rings pulse out from it, the next screen is loaded underneath, and
// then the red dissolves into it. The cover lives on <body>, so it outlasts the screen that started it.
// Reduced motion just navigates. The styles are in styles/app.css (.enter-game).
//   await enterGame({ x: 200, y: 300, go: () => router.push('/sessions/new') })

const GROW = 650 // ms for the red to fill the screen
const HOLD = 350 // ms on full red, while the rings pulse, before the next screen
const FADE = 700 // ms for the red to dissolve into the next screen

const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

// x, y: where the circle starts, in viewport px (the pin's head). go: the navigation, may be async.
// How to call: await enterGame({ x, y, go: () => router.push('/sessions/new') })
export async function enterGame({ x, y, go }) {
  if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
    await go()
    return
  }
  const cover = document.createElement('div')
  cover.className = 'enter-game'
  cover.setAttribute('aria-hidden', 'true')
  cover.style.setProperty('--x', `${x}px`)
  cover.style.setProperty('--y', `${y}px`)
  // Big enough to reach the farthest corner from the start point.
  const reach = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y))
  cover.style.setProperty('--reach', `${Math.ceil(reach) + 20}px`)
  cover.innerHTML = '<span class="enter-game__ring"></span><span class="enter-game__ring"></span><span class="enter-game__ring"></span>'
  document.body.appendChild(cover)
  // One frame at size 0 first, so the growth animates.
  await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  cover.classList.add('is-growing')
  await pause(GROW + HOLD)
  try {
    await go()
  } finally {
    // Let the next screen draw under the red before it dissolves.
    await pause(60)
    cover.classList.add('is-leaving')
    await pause(FADE)
    cover.remove()
  }
}
