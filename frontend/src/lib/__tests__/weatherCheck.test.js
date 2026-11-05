// When the weather check on the day is made: once on opening, again after 30 minutes, never two at once, not on a focus
// change, paused while the page is hidden (one check when it is shown again), and never after the page is left. A fake clock.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { CHECK_EVERY_MS, createWeatherCheck } from '../weatherCheck.js'

const MINUTE = 60 * 1000

// A page whose visibility a test flips, and a counter of the listeners that are on it.
function fakePage() {
  const page = { hidden: false, listeners: new Set() }
  page.hide = () => { page.hidden = true; page.listeners.forEach((fn) => fn()) }
  page.show = () => { page.hidden = false; page.listeners.forEach((fn) => fn()) }
  page.options = { hidden: () => page.hidden, onVisibility: (fn) => { page.listeners.add(fn); return () => page.listeners.delete(fn) } }
  return page
}

// A check that takes `ms` to answer and counts how many are running.
function slowRun(ms) {
  const run = vi.fn(async () => {
    run.running += 1
    run.mostAtOnce = Math.max(run.mostAtOnce, run.running)
    await new Promise((resolve) => setTimeout(resolve, ms))
    run.running -= 1
  })
  run.running = 0
  run.mostAtOnce = 0
  return run
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the weather check on the day', () => {
  it('is every 30 minutes', () => {
    expect(CHECK_EVERY_MS).toBe(30 * MINUTE)
  })

  it('asks once when started, and again after 30 minutes, not before', async () => {
    const page = fakePage()
    const run = vi.fn(async () => {})
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(29 * MINUTE + 59 * 1000)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2000)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(30 * MINUTE)
    expect(run).toHaveBeenCalledTimes(3)
    check.stop()
  })

  it('starting twice does not ask twice', async () => {
    const page = fakePage()
    const run = vi.fn(async () => {})
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    expect(page.listeners.size).toBe(1)
    check.stop()
  })

  it('does not ask on a focus change, only on the page being shown after a check fell due', async () => {
    const page = fakePage()
    const run = vi.fn(async () => {})
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    // The window is blurred and focused again, and the page is hidden and shown, ten times over: nothing is due.
    const focus = vi.fn()
    for (let i = 0; i < 10; i++) {
      focus()
      page.hide()
      page.show()
    }
    await vi.advanceTimersByTimeAsync(5 * MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
    check.stop()
  })

  it('never has two checks at once, and a slow one does not pile checks up', async () => {
    const page = fakePage()
    const run = slowRun(40 * MINUTE)
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(31 * MINUTE)
    // 30 minutes passed while the first check was still running. There is no second one yet.
    expect(run).toHaveBeenCalledTimes(1)
    for (let i = 0; i < 5; i++) check.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    // The first ends; the pokes made while it ran count as one more.
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(run.mostAtOnce).toBe(1)
    expect(run.mock.calls.length).toBeGreaterThanOrEqual(2)
    expect(run.mock.calls.length).toBeLessThanOrEqual(2)
    check.stop()
  })

  it('plans the next check 30 minutes after the last one ended', async () => {
    const page = fakePage()
    const run = slowRun(5 * MINUTE)
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(34 * MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(run).toHaveBeenCalledTimes(2)
    check.stop()
  })

  it('asks for a check of its own accord when poked, and runs it after the one that is running', async () => {
    const page = fakePage()
    const run = slowRun(1000)
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(10)
    check.poke()
    await vi.advanceTimersByTimeAsync(2500)
    expect(run).toHaveBeenCalledTimes(2)
    expect(run.mostAtOnce).toBe(1)
    check.stop()
  })

  it('waits while the page is hidden, and asks once when it is shown, however long it was away', async () => {
    const page = fakePage()
    const run = vi.fn(async () => {})
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    page.hide()
    await vi.advanceTimersByTimeAsync(5 * 60 * MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
    page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    // And then on schedule from there.
    await vi.advanceTimersByTimeAsync(29 * MINUTE)
    expect(run).toHaveBeenCalledTimes(2)
    await vi.advanceTimersByTimeAsync(2 * MINUTE)
    expect(run).toHaveBeenCalledTimes(3)
    check.stop()
  })

  it('opened on a hidden page, asks when the page is first shown', async () => {
    const page = fakePage()
    page.hidden = true
    const run = vi.fn(async () => {})
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).not.toHaveBeenCalled()
    page.show()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
    check.stop()
  })

  it('stops for good when the page is left: no timer, no listener, no later check', async () => {
    const page = fakePage()
    const run = vi.fn(async () => {})
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(check.active()).toBe(true)
    check.stop()
    expect(check.active()).toBe(false)
    expect(page.listeners.size).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    page.show()
    check.poke()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('does not ask again after it was stopped while a check was running', async () => {
    const page = fakePage()
    const run = slowRun(1000)
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(10)
    check.poke()
    check.stop()
    await vi.advanceTimersByTimeAsync(10 * 60 * MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('can be started again after it was stopped', async () => {
    const page = fakePage()
    const run = vi.fn(async () => {})
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    check.stop()
    check.start()
    await vi.advanceTimersByTimeAsync(0)
    expect(run).toHaveBeenCalledTimes(2)
    check.stop()
  })

  it('keeps its schedule when a check fails: no early retry, no stop', async () => {
    const page = fakePage()
    const run = vi.fn(async () => {
      throw new Error('Cannot reach the Jio planner')
    })
    const check = createWeatherCheck({ run, ...page.options })
    check.start()
    await vi.advanceTimersByTimeAsync(10 * MINUTE)
    expect(run).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(21 * MINUTE)
    expect(run).toHaveBeenCalledTimes(2)
    expect(check.active()).toBe(true)
    check.stop()
  })
})
