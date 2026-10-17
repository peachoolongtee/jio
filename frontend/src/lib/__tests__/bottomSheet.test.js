// The bottom sheet's drag to close (components/ui/BottomSheet.vue), drawn with the stand-in page (domless.js). A screen
// keeps one sheet mounted and flips `open`, so a sheet dragged closed must come back at rest the next time it opens.
// The page has no layout, so the size of the grab area is measured in a browser, not here.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { liven, mountScreen } from './domless.js'
import BottomSheet, { shouldClose } from '../../components/ui/BottomSheet.vue'

const phone = (matches = true) => vi.stubGlobal('window', { matchMedia: () => ({ matches }) })
beforeEach(() => phone())
afterEach(() => vi.unstubAllGlobals())

// A screen with one persistent sheet, as Home has: `open` is flipped, the sheet is never unmounted.
// How to call: const { view, state } = await screen({ title: 'Filter' }) -> state.open.value
async function screen(props = {}) {
  await liven(BottomSheet)
  const state = { open: ref(true) }
  const Host = defineComponent({
    setup: () => () => h(BottomSheet, { ...props, open: state.open.value, 'onUpdate:open': (v) => (state.open.value = v) }, { default: () => h('p', 'Body') }),
  })
  return { view: await mountScreen(Host), state }
}

// How to call: touch(view, 'pointermove', { y: 200, at: 100 })
const GRAB_TARGET = { closest: () => null }
const touch = (view, name, { y, at, target = GRAB_TARGET }) => view.one('.sheet__grab').dispatch(name, { pointerId: 1, button: 0, clientY: y, timeStamp: at, target })
const drag = (view, to, ms) => {
  touch(view, 'pointerdown', { y: 0, at: 0 })
  touch(view, 'pointermove', { y: to, at: ms / 2 })
  touch(view, 'pointerup', { y: to, at: ms })
}
const panel = (view) => view.one('.sheet__panel')

describe('shouldClose', () => {
  it('closes past 96px, or on a quick flick, and otherwise springs back', () => {
    expect(shouldClose(97, 2000)).toBe(true)
    expect(shouldClose(96, 2000)).toBe(false)
    expect(shouldClose(50, 2000)).toBe(false)
    expect(shouldClose(40, 50)).toBe(true)
    expect(shouldClose(20, 5)).toBe(false)
  })
})

describe('dragging the sheet down', () => {
  it('follows the finger while dragging', async () => {
    const { view } = await screen({ title: 'Filter' })
    touch(view, 'pointerdown', { y: 0, at: 0 })
    touch(view, 'pointermove', { y: 60, at: 100 })
    await view.tick()
    expect(panel(view).style.transform).toBe('translateY(60px)')
    expect(panel(view).attrs.class).toContain('is-dragging')
  })

  it('springs back to rest when let go short of the limit, and stays open', async () => {
    const { view, state } = await screen({ title: 'Filter' })
    drag(view, 50, 1000)
    await view.tick()
    expect(state.open.value).toBe(true)
    expect(panel(view).style.transform).toBeUndefined()
  })

  it('closes when dragged far enough', async () => {
    const { view, state } = await screen({ title: 'Filter' })
    drag(view, 150, 1000)
    await view.tick()
    expect(state.open.value).toBe(false)
    expect(view.has('.sheet__panel')).toBe(false)
  })

  it('opens at rest again after a drag closed it, with no leftover shift to override the enter animation', async () => {
    const { view, state } = await screen({ title: 'Filter' })
    drag(view, 150, 1000)
    await view.tick()
    expect(state.open.value).toBe(false)
    state.open.value = true
    await view.tick()
    expect(view.has('.sheet__panel')).toBe(true)
    expect(panel(view).style.transform).toBeUndefined()
    expect(panel(view).attrs.class).not.toContain('is-dragging')
  })

  it('stays at rest through a second drag-close and reopen', async () => {
    const { view, state } = await screen({ hideClose: true })
    for (let round = 0; round < 2; round += 1) {
      drag(view, 200, 150)
      await view.tick()
      expect(state.open.value).toBe(false)
      state.open.value = true
      await view.tick()
      expect(panel(view).style.transform).toBeUndefined()
    }
  })

  it('leaves a press on a button in the header alone', async () => {
    const { view } = await screen({ title: 'Filter' })
    touch(view, 'pointerdown', { y: 0, at: 0, target: { closest: () => ({}) } })
    touch(view, 'pointermove', { y: 200, at: 100 })
    await view.tick()
    expect(panel(view).style.transform).toBeUndefined()
  })

  it('does not drag on a desktop-width window', async () => {
    phone(false)
    const { view } = await screen({ title: 'Filter' })
    touch(view, 'pointerdown', { y: 0, at: 0 })
    touch(view, 'pointermove', { y: 200, at: 100 })
    await view.tick()
    expect(panel(view).style.transform).toBeUndefined()
  })
})
