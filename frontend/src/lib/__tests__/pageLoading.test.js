// The app-wide spinner: it shows only after 600 ms of unbroken loading, stays at least 400 ms, hides when the last piece of
// work ends, and holds the page still while it is up, for at most 20 seconds.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

let lib
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  lib = await import('../pageLoading.js')
})
afterEach(() => vi.useRealTimers())

// A promise the test settles by hand.
function deferred() {
  let resolve, reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

describe('when the spinner shows and hides', () => {
  const { SLOW_MS, MIN_SHOWN_MS } = { SLOW_MS: 600, MIN_SHOWN_MS: 400 }

  it('uses a 600 ms delay and a 400 ms minimum', () => {
    expect([lib.SLOW_MS, lib.MIN_SHOWN_MS]).toEqual([SLOW_MS, MIN_SHOWN_MS])
  })

  it('stays hidden for a quick load', () => {
    const stop = lib.startLoading()
    vi.advanceTimersByTime(SLOW_MS - 1)
    stop()
    vi.advanceTimersByTime(5000)
    expect(lib.pageSlow.value).toBe(false)
  })

  it('shows at the delay, and stays the minimum time when the load ends at once', () => {
    const stop = lib.startLoading()
    vi.advanceTimersByTime(SLOW_MS)
    expect(lib.pageSlow.value).toBe(true)
    vi.advanceTimersByTime(50)
    stop()
    expect(lib.pageSlow.value).toBe(true)
    vi.advanceTimersByTime(MIN_SHOWN_MS - 51)
    expect(lib.pageSlow.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect(lib.pageSlow.value).toBe(false)
  })

  it('hides at once when it has already been up for the minimum', () => {
    const stop = lib.startLoading()
    vi.advanceTimersByTime(SLOW_MS + MIN_SHOWN_MS)
    stop()
    expect(lib.pageSlow.value).toBe(false)
  })

  it('stays up without a flicker when new work starts during the minimum, then hides when it ends', () => {
    const a = lib.startLoading()
    vi.advanceTimersByTime(SLOW_MS)
    a()
    vi.advanceTimersByTime(100)
    const b = lib.startLoading()
    vi.advanceTimersByTime(MIN_SHOWN_MS)
    expect(lib.pageSlow.value).toBe(true)
    b()
    expect(lib.pageSlow.value).toBe(false)
  })

  it('stays up until the last of several loads ends, and a second stop is harmless', () => {
    const a = lib.startLoading()
    const b = lib.startLoading()
    vi.advanceTimersByTime(SLOW_MS + MIN_SHOWN_MS)
    a()
    a()
    expect(lib.pageSlow.value).toBe(true)
    b()
    expect(lib.pageSlow.value).toBe(false)
  })

  it('starts the delay again after a break', () => {
    lib.startLoading()()
    const stop = lib.startLoading()
    vi.advanceTimersByTime(SLOW_MS - 100)
    expect(lib.pageSlow.value).toBe(false)
    vi.advanceTimersByTime(100)
    expect(lib.pageSlow.value).toBe(true)
    stop()
  })

  it('counts a promise until it settles, rejected ones too', async () => {
    const work = deferred()
    const counted = lib.whileLoading(work.promise).catch((e) => e.message)
    vi.advanceTimersByTime(SLOW_MS)
    expect(lib.pageSlow.value).toBe(true)
    work.reject(new Error('no'))
    expect(await counted).toBe('no')
    vi.advanceTimersByTime(MIN_SHOWN_MS)
    expect(lib.pageSlow.value).toBe(false)
  })

  it('stands up to many overlapping loads that end in any order', () => {
    const stops = Array.from({ length: 500 }, () => lib.startLoading())
    vi.advanceTimersByTime(SLOW_MS + MIN_SHOWN_MS)
    for (let i = stops.length - 1; i >= 0; i -= 2) stops[i]()
    expect(lib.pageSlow.value).toBe(true)
    for (const stop of stops) stop()
    expect(lib.pageSlow.value).toBe(false)
    lib.startLoading()()
    vi.advanceTimersByTime(5000)
    expect(lib.pageSlow.value).toBe(false)
  })
})

describe('holding the page still while the spinner shows', () => {
  it('holds the page exactly while the spinner is up, and never before it shows', () => {
    const stop = lib.startLoading()
    vi.advanceTimersByTime(lib.SLOW_MS - 1)
    // Nothing on screen yet, so nothing is held: a person can still tap.
    expect(lib.pageBlocking.value).toBe(false)
    vi.advanceTimersByTime(1)
    expect([lib.pageSlow.value, lib.pageBlocking.value]).toEqual([true, true])
    stop()
    vi.advanceTimersByTime(lib.MIN_SHOWN_MS)
    expect([lib.pageSlow.value, lib.pageBlocking.value]).toEqual([false, false])
  })

  it('lets the page be used again after 20 seconds, while the spinner stays until the work ends', () => {
    expect(lib.MAX_BLOCK_MS).toBe(20000)
    const stop = lib.startLoading()
    vi.advanceTimersByTime(lib.SLOW_MS + lib.MAX_BLOCK_MS - 1)
    expect(lib.pageBlocking.value).toBe(true)
    vi.advanceTimersByTime(1)
    expect([lib.pageSlow.value, lib.pageBlocking.value]).toEqual([true, false])
    stop()
    expect(lib.pageSlow.value).toBe(false)
  })

  it('starts the 20 seconds again the next time the spinner shows', () => {
    const first = lib.startLoading()
    vi.advanceTimersByTime(lib.SLOW_MS + 15000)
    first()
    vi.advanceTimersByTime(lib.MIN_SHOWN_MS)
    const second = lib.startLoading()
    vi.advanceTimersByTime(lib.SLOW_MS + 15000)
    expect(lib.pageBlocking.value).toBe(true)
    second()
  })
})
