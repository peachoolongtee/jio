// Page transitions: the marker that tells app.css a page is changing must outlive a transition that a newer one skipped.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { installPageTransitions } from '../viewTransition.js'

// A browser with just enough of the View Transitions API: each transition's `finished` is settled by the test.
function fakeBrowser() {
  const root = { dataset: {} }
  const transitions = []
  vi.stubGlobal('document', {
    documentElement: root,
    visibilityState: 'visible',
    startViewTransition: vi.fn((update) => {
      let finish
      const transition = { ready: Promise.resolve(), finished: new Promise((resolve) => (finish = resolve)), finish }
      transitions.push(transition)
      Promise.resolve().then(update)
      return transition
    }),
  })
  vi.stubGlobal('window', { matchMedia: () => ({ matches: false }) })
  let resolveGuard
  let after
  const router = { beforeResolve: (fn) => (resolveGuard = fn), afterEach: (fn) => (after = fn) }
  installPageTransitions(router)
  const page = (path) => ({ path, matched: [1] })
  // One navigation: the guard runs (and waits for the old page to be captured), then the new page is drawn.
  const navigate = async (from, to) => {
    await resolveGuard(page(to), page(from))
    await after()
  }
  return { root, transitions, navigate }
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('the page transition marker', () => {
  it('is set while a page changes and cleared when the transition finishes', async () => {
    const { root, transitions, navigate } = fakeBrowser()
    await navigate('/sessions/s1', '/sessions/s1/plan')
    expect(root.dataset.vt).toBe('page')
    transitions[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.dataset.vt).toBeUndefined()
  })

  it('stays while the newer transition runs, when a second navigation skips the first', async () => {
    const { root, transitions, navigate } = fakeBrowser()
    await navigate('/sessions/s1', '/sessions/s1/plan')
    await navigate('/sessions/s1/plan', '/sessions/s1/itinerary')
    expect(transitions).toHaveLength(2)
    // The browser settles the skipped first transition as the second starts.
    transitions[0].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.dataset.vt).toBe('page')
    transitions[1].finish()
    await vi.advanceTimersByTimeAsync(0)
    expect(root.dataset.vt).toBeUndefined()
  })

  it('is not set for a change of query on the same page', async () => {
    const { root, transitions, navigate } = fakeBrowser()
    await navigate('/', '/')
    expect(transitions).toHaveLength(0)
    expect(root.dataset.vt).toBeUndefined()
  })
})
