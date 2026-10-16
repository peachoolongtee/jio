// The spinner on screen (components/ui/PageLoading.vue), drawn for real (domless.js): it says "Loading…", and while it
// holds the page still it takes every click, tap and scroll and stops every key press before the page sees it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mountScreen } from './domless.js'

let lib
let listeners
beforeEach(async () => {
  vi.useFakeTimers()
  vi.resetModules()
  lib = await import('../pageLoading.js')
  // The window's key listeners, as a browser keeps them.
  listeners = new Map()
  vi.stubGlobal('window', {
    addEventListener: (name, fn, capture) => listeners.set(`${name}:${capture}`, fn),
    removeEventListener: (name, fn, capture) => listeners.get(`${name}:${capture}`) === fn && listeners.delete(`${name}:${capture}`),
  })
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

// Draw the spinner, with the same copy of lib/pageLoading.js the test drives.
// How to call: const view = await draw()
async function draw() {
  const { default: PageLoading } = await import('@/components/ui/PageLoading.vue')
  return mountScreen(PageLoading)
}
// A key press as the browser hands it to a listener, recording whether it was stopped.
// How to call: keyEvent({ key: 'r', ctrlKey: true })
const keyEvent = (fields = { key: 'a' }) => ({ ...fields, prevented: false, stopped: false, preventDefault() { this.prevented = true }, stopImmediatePropagation() { this.stopped = true } })

describe('the spinner on screen', () => {
  it('is not there until something has loaded for 600 ms, then says Loading… and holds the page', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS - 1)
    expect(view.has('[data-testid="page-loading"]')).toBe(false)
    expect(listeners.size).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    const wash = view.one('[data-testid="page-loading"]')
    expect(view.text(wash)).toBe('Loading…')
    expect(wash.attrs.class).toContain('is-blocking')
    expect(wash.attrs['aria-busy']).toBe('true')
    stop()
    view.unmount()
  })

  it('stops every key press before the page sees it, and lets keys through again once it goes', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    for (const name of ['keydown', 'keypress', 'keyup']) {
      const fn = listeners.get(`${name}:true`)
      expect(fn).toBeTypeOf('function')
      const event = keyEvent()
      fn(event)
      expect([event.prevented, event.stopped]).toEqual([true, true])
    }
    stop()
    await vi.advanceTimersByTimeAsync(lib.MIN_SHOWN_MS)
    expect(listeners.size).toBe(0)
    expect(view.has('[data-testid="page-loading"]')).toBe(false)
    view.unmount()
  })

  it('lets the page be used again after 20 seconds, still showing the spinner', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS + lib.MAX_BLOCK_MS)
    const wash = view.one('[data-testid="page-loading"]')
    expect(wash.attrs.class || '').not.toContain('is-blocking')
    expect(listeners.size).toBe(0)
    stop()
    view.unmount()
  })

  it('takes away its key listeners when it is closed', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    expect(listeners.size).toBe(3)
    view.unmount()
    expect(listeners.size).toBe(0)
    stop()
  })
})

describe('the spinner and the keyboard, under stress', () => {
  // Press `fields` through the spinner's listener for each kind of key event. Returns whether each one was stopped.
  // How to call: press({ key: 'Tab' }) -> [true, true, true]
  const press = (fields) =>
    ['keydown', 'keypress', 'keyup'].map((name) => {
      const event = keyEvent(fields)
      listeners.get(`${name}:true`)(event)
      return event.prevented && event.stopped
    })

  it('stops every key meant for the page: typing, Tab, Enter, Space, Escape and the arrows', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    for (const key of ['a', 'Z', '1', 'Tab', 'Enter', ' ', 'Escape', 'ArrowDown', 'ArrowLeft', 'Backspace', 'PageDown', 'End']) {
      expect(press({ key })).toEqual([true, true, true])
    }
    // Shift alone is still typing (capitals, Shift+Tab).
    expect(press({ key: 'Tab', shiftKey: true })).toEqual([true, true, true])
    stop()
    view.unmount()
  })

  it('lets the browser’s own shortcuts through: reload, zoom, tabs and the function keys', async () => {
    const view = await draw()
    const stop = lib.startLoading()
    await vi.advanceTimersByTimeAsync(lib.SLOW_MS)
    for (const fields of [{ key: 'r', ctrlKey: true }, { key: 'F5' }, { key: 'F12' }, { key: '+', metaKey: true }, { key: 'w', metaKey: true }, { key: 'ArrowLeft', altKey: true }, { key: 'Tab', ctrlKey: true }]) {
      expect(press(fields)).toEqual([false, false, false])
    }
    stop()
    view.unmount()
  })

  it('never leaves a key listener behind, however often it shows and hides', async () => {
    const view = await draw()
    for (let round = 0; round < 50; round += 1) {
      const stops = Array.from({ length: 1 + (round % 5) }, () => lib.startLoading())
      await vi.advanceTimersByTimeAsync(round % 2 ? lib.SLOW_MS : lib.SLOW_MS - 1)
      for (const stop of stops) stop()
      await vi.advanceTimersByTimeAsync(lib.MIN_SHOWN_MS)
      expect(listeners.size).toBe(0)
    }
    expect(view.has('[data-testid="page-loading"]')).toBe(false)
    view.unmount()
  })
})
