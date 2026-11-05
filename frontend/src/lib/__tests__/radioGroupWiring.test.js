// The v-radio-group directive's wiring (lib/radioGroup.js): the keydown handler, whether the arrows choose, and the Tab
// stop following the chips as Vue adds, removes, chooses and disables them. radioGroup.test.js covers the pure helpers.
// The suite has no DOM, and the plain stand-in page (domless.js) has no querySelectorAll, closest or MutationObserver, which
// the directive needs, so the directive is drawn here by Vue's own renderer into a small tree of plain objects that has
// just those (FakeEl below), with a MutationObserver that reports changes the way a browser does: once, in a microtask.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createRenderer, defineComponent, h, nextTick, ref, withDirectives } from 'vue'
import { vRadioGroup } from '../radioGroup.js'

// How to call: matchAttr('[role="radio"]') -> (el) => el.getAttribute('role') === 'radio'
const matchAttr = (selector) => {
  const [, name, value] = selector.match(/^\[([\w-]+)="([^"]*)"\]$/)
  return (el) => el.getAttribute(name) === value
}

const watchers = new Set()

// How to call: tell(el, 'attributes', 'aria-checked') after a change; the observers watching el's tree hear of it once.
function tell(el, type, name) {
  for (const watcher of watchers) {
    const inside = (node) => { for (let n = node; n; n = n.parent) if (n === watcher.target) return true; return false }
    if (!inside(el)) continue
    if (!watcher.options.subtree && el !== watcher.target) continue
    if (type === 'attributes' && !watcher.options.attributeFilter?.includes(name)) continue
    if (type === 'childList' && !watcher.options.childList) continue
    if (watcher.queued) continue
    watcher.queued = true
    queueMicrotask(() => { watcher.queued = false; watcher.callback([]) })
  }
}

class FakeObserver {
  constructor(callback) { this.callback = callback }
  observe(target, options) { Object.assign(this, { target, options, queued: false }); watchers.add(this) }
  disconnect() { watchers.delete(this) }
}

class FakeEl {
  constructor(tag) { this.tag = tag; this.attrs = {}; this.children = []; this.parent = null; this.listeners = {}; this.clicks = 0 }
  setAttribute(name, value) { this.attrs[name] = String(value); tell(this, 'attributes', name) }
  getAttribute(name) { return name in this.attrs ? this.attrs[name] : null }
  removeAttribute(name) { delete this.attrs[name]; tell(this, 'attributes', name) }
  get disabled() { return 'disabled' in this.attrs }
  set disabled(on) { if (on) this.setAttribute('disabled', '') ; else this.removeAttribute('disabled') }
  closest(selector) { const test = matchAttr(selector); for (let n = this; n; n = n.parent) if (n.tag !== 'root' && test(n)) return n; return null }
  querySelectorAll(selector) { const test = matchAttr(selector); const found = []; const walk = (n) => n.children.forEach((c) => { if (test(c)) found.push(c); walk(c) }); walk(this); return found }
  addEventListener(name, fn) { (this.listeners[name] ||= []).push(fn) }
  removeEventListener(name, fn) { this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn) }
  focus() { FakeEl.active = this }
  click() { this.clicks += 1 }
  // A key pressed with `this` focused: the handlers run on it and then its parents, as in a browser.
  press(key, extra = {}) {
    const event = { type: 'keydown', key, target: this, defaultPrevented: false, preventDefault() { this.defaultPrevented = true }, ...extra }
    for (let n = this; n; n = n.parent) for (const fn of [...(n.listeners.keydown || [])]) fn(event)
    return event
  }
}

function renderer() {
  const ops = {
    createElement: (tag) => new FakeEl(tag),
    createText: () => new FakeEl('#text'),
    createComment: () => new FakeEl('#comment'),
    setText: () => {},
    setElementText: () => {},
    insert(child, parent, anchor) {
      if (child.parent) ops.remove(child)
      const at = anchor ? parent.children.indexOf(anchor) : -1
      if (at < 0) parent.children.push(child)
      else parent.children.splice(at, 0, child)
      child.parent = parent
      tell(parent, 'childList')
    },
    remove(child) {
      const parent = child.parent
      if (!parent) return
      parent.children.splice(parent.children.indexOf(child), 1)
      child.parent = null
      tell(parent, 'childList')
    },
    parentNode: (n) => n.parent,
    nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
    patchProp(el, key, _prev, next) {
      if (/^on[A-Z]/.test(key)) el.addEventListener(key.slice(2).toLowerCase(), next)
      else if (key === 'disabled') el.disabled = !!next
      else if (next == null || next === false) el.removeAttribute(key)
      else el.setAttribute(key, next === true ? '' : next)
    },
  }
  return createRenderer(ops)
}

// A set of radio chips inside a radiogroup carrying the directive, drawn from `state.items` (id, checked, disabled: 'aria' or
// 'native') so a test changes the set the way a screen does. `state.follow` is the directive's option.
// How to call: const { group, state } = await draw([{ id: 'a', checked: true }, { id: 'b' }])
async function draw(items, { follow = true } = {}) {
  const state = { items: ref(items), follow: ref(follow) }
  const chip = (item) => h('button', { key: item.id, role: 'radio', 'aria-checked': String(!!item.checked), 'aria-disabled': item.disabled === 'aria' ? 'true' : undefined, disabled: item.disabled === 'native', id: item.id })
  const Chips = defineComponent({
    setup: () => () => withDirectives(h('div', { role: 'radiogroup' }, state.items.value.map(chip)), [[vRadioGroup, { follow: state.follow.value }]]),
  })
  const root = new FakeEl('root')
  renderer().createApp(Chips).mount(root)
  await settle()
  const group = root.children[0]
  return { root, group, state, chips: () => group.children, tabs: () => group.children.map((c) => c.getAttribute('tabindex')), ids: () => group.children.map((c) => c.attrs.id) }
}

// Let Vue redraw and the observer report, as a browser would between a change and the next key.
const settle = async () => { await nextTick(); await Promise.resolve(); await Promise.resolve() }

beforeEach(() => vi.stubGlobal('MutationObserver', FakeObserver))
afterEach(() => { vi.unstubAllGlobals(); watchers.clear(); FakeEl.active = null })

describe('the keys', () => {
  it('move focus to the next enabled chip, skipping disabled ones, and wrap round', async () => {
    const { chips } = await draw([{ id: 'a', checked: true }, { id: 'b', disabled: 'native' }, { id: 'c', disabled: 'aria' }, { id: 'd' }])
    const [a, , , d] = chips()
    const event = a.press('ArrowRight')
    expect(FakeEl.active).toBe(d)
    expect(event.defaultPrevented).toBe(true)
    d.press('ArrowRight')
    expect(FakeEl.active).toBe(a)
    a.press('ArrowLeft')
    expect(FakeEl.active).toBe(d)
  })

  it('go to the first and last enabled chip on Home and End', async () => {
    const { chips } = await draw([{ id: 'a', disabled: 'native' }, { id: 'b', checked: true }, { id: 'c' }, { id: 'd', disabled: 'aria' }])
    const [, b, c] = chips()
    c.press('Home')
    expect(FakeEl.active).toBe(b)
    b.press('End')
    expect(FakeEl.active).toBe(c)
  })

  it('leave Tab, Space, Enter and keys with a modifier to the browser', async () => {
    const { chips } = await draw([{ id: 'a', checked: true }, { id: 'b' }])
    const [a, b] = chips()
    for (const key of ['Tab', ' ', 'Enter', 'a']) expect(a.press(key).defaultPrevented).toBe(false)
    for (const mod of ['altKey', 'ctrlKey', 'metaKey']) expect(a.press('ArrowRight', { [mod]: true }).defaultPrevented).toBe(false)
    expect(FakeEl.active).toBe(null)
    expect(b.clicks + a.clicks).toBe(0)
  })

  it('ignore a key pressed on something in the group that is not a radio', async () => {
    const { group } = await draw([{ id: 'a', checked: true }, { id: 'b' }])
    const other = new FakeEl('button')
    other.parent = group
    expect(other.press('ArrowRight').defaultPrevented).toBe(false)
    expect(FakeEl.active).toBe(null)
  })

  it('do nothing in a set with nothing enabled', async () => {
    const { chips } = await draw([{ id: 'a', disabled: 'aria' }, { id: 'b', disabled: 'aria' }])
    expect(chips()[0].press('ArrowRight').defaultPrevented).toBe(false)
  })
})

describe('following', () => {
  it('chooses the chip the arrow lands on, by clicking it, in a filter', async () => {
    const { chips } = await draw([{ id: 'a', checked: true }, { id: 'b' }, { id: 'c' }])
    const [a, b, c] = chips()
    a.press('ArrowRight')
    expect([a.clicks, b.clicks, c.clicks]).toEqual([0, 1, 0])
    a.press('End')
    expect(c.clicks).toBe(1)
  })

  it('does not click when there is nowhere else to go', async () => {
    const { chips } = await draw([{ id: 'a', checked: true }, { id: 'b', disabled: 'native' }])
    const [a] = chips()
    a.press('ArrowRight')
    expect(FakeEl.active).toBe(a)
    expect(a.clicks).toBe(0)
  })

  it('never chooses with follow: false, so the arrows only move focus and never vote', async () => {
    const { chips } = await draw([{ id: 'a', checked: true }, { id: 'b' }, { id: 'c' }], { follow: false })
    const [a, b, c] = chips()
    a.press('ArrowRight')
    expect(FakeEl.active).toBe(b)
    b.press('End')
    expect(FakeEl.active).toBe(c)
    c.press('Home')
    a.press('ArrowLeft')
    expect(chips().reduce((n, chip) => n + chip.clicks, 0)).toBe(0)
  })

  it('takes a change of the option while it is on the page', async () => {
    const { chips, state } = await draw([{ id: 'a', checked: true }, { id: 'b' }], { follow: false })
    const [a, b] = chips()
    a.press('ArrowRight')
    expect(b.clicks).toBe(0)
    state.follow.value = true
    await settle()
    a.press('ArrowRight')
    expect(b.clicks).toBe(1)
  })
})

describe('the Tab stop', () => {
  it('is the chosen chip, and the others are out of the Tab order', async () => {
    const { tabs } = await draw([{ id: 'a' }, { id: 'b', checked: true }, { id: 'c' }])
    expect(tabs()).toEqual(['-1', '0', '-1'])
  })

  it('is the first enabled chip when none is chosen', async () => {
    const { tabs } = await draw([{ id: 'a', disabled: 'native' }, { id: 'b' }, { id: 'c' }])
    expect(tabs()).toEqual(['-1', '0', '-1'])
  })

  it('follows a new choice', async () => {
    const { tabs, state } = await draw([{ id: 'a', checked: true }, { id: 'b' }, { id: 'c' }])
    state.items.value = [{ id: 'a' }, { id: 'b' }, { id: 'c', checked: true }]
    await settle()
    expect(tabs()).toEqual(['-1', '-1', '0'])
  })

  it('moves when a chip is added in front of the stop, with none chosen', async () => {
    const { tabs, ids, state } = await draw([{ id: 'b' }, { id: 'c' }])
    expect(tabs()).toEqual(['0', '-1'])
    state.items.value = [{ id: 'a' }, ...state.items.value]
    await settle()
    expect(ids()).toEqual(['a', 'b', 'c'])
    expect(tabs()).toEqual(['0', '-1', '-1'])
  })

  it('keeps a chosen chip as the stop when others are added around it', async () => {
    const { tabs, state } = await draw([{ id: 'b', checked: true }])
    state.items.value = [{ id: 'a' }, { id: 'b', checked: true }, { id: 'c' }]
    await settle()
    expect(tabs()).toEqual(['-1', '0', '-1'])
  })

  it('passes to another chip when the one that held it is removed', async () => {
    const { tabs, ids, state } = await draw([{ id: 'a', checked: true }, { id: 'b' }, { id: 'c' }])
    state.items.value = state.items.value.slice(1)
    await settle()
    expect(ids()).toEqual(['b', 'c'])
    expect(tabs()).toEqual(['0', '-1'])
  })

  it('passes to the next enabled chip when the stop is disabled, and does not wait for a click to do it', async () => {
    const { tabs, state } = await draw([{ id: 'a' }, { id: 'b' }, { id: 'c' }])
    expect(tabs()).toEqual(['0', '-1', '-1'])
    state.items.value = [{ id: 'a', disabled: 'native' }, { id: 'b' }, { id: 'c' }]
    await settle()
    expect(tabs()).toEqual(['-1', '0', '-1'])
  })

  it('stays on the chosen chip while it is aria-disabled (a request is running), and returns when it is enabled again', async () => {
    const { tabs, state } = await draw([{ id: 'a' }, { id: 'b', checked: true }])
    state.items.value = [{ id: 'a' }, { id: 'b', checked: true, disabled: 'aria' }]
    await settle()
    expect(tabs()).toEqual(['-1', '0'])
    state.items.value = [{ id: 'a' }, { id: 'b', checked: true }]
    await settle()
    expect(tabs()).toEqual(['-1', '0'])
  })

  it('leaves a natively disabled chosen chip, which cannot take focus, for the first enabled one', async () => {
    const { tabs, state } = await draw([{ id: 'a' }, { id: 'b', checked: true }, { id: 'c' }])
    state.items.value = [{ id: 'a' }, { id: 'b', checked: true, disabled: 'native' }, { id: 'c' }]
    await settle()
    expect(tabs()).toEqual(['0', '-1', '-1'])
  })

  it('is one chip when exactly one stop is wanted, however the set changes', async () => {
    const { tabs, state } = await draw([{ id: 'a' }, { id: 'b' }])
    for (const items of [[{ id: 'a', disabled: 'aria' }, { id: 'b', disabled: 'aria' }, { id: 'c' }], [{ id: 'c' }], [{ id: 'a' }, { id: 'c', checked: true }, { id: 'd' }]]) {
      state.items.value = items
      await settle()
      expect(tabs().filter((t) => t === '0')).toHaveLength(1)
    }
  })
})

describe('nested groups', () => {
  // An outer set whose last chip is followed by an inner radiogroup of its own, as a filter might hold a sub-filter.
  async function nested() {
    const outer = ['o1', 'o2']
    const inner = ['i1', 'i2', 'i3']
    const chip = (id, checked) => h('button', { role: 'radio', 'aria-checked': String(!!checked), id })
    const Page = defineComponent({
      setup: () => () => withDirectives(h('div', { role: 'radiogroup', id: 'outer' }, [
        ...outer.map((id) => chip(id, id === 'o1')),
        withDirectives(h('div', { role: 'radiogroup', id: 'inner' }, inner.map((id) => chip(id, id === 'i2'))), [[vRadioGroup]]),
      ]), [[vRadioGroup]]),
    })
    const root = new FakeEl('root')
    renderer().createApp(Page).mount(root)
    await settle()
    const [outerGroup] = root.children
    const innerGroup = outerGroup.children[2]
    return { outerGroup, innerGroup, byId: (id) => [...outerGroup.children, ...innerGroup.children].find((c) => c.attrs.id === id) }
  }

  it('gives each group its own Tab stop, and the outer set does not count the inner chips', async () => {
    const { outerGroup, innerGroup } = await nested()
    expect(outerGroup.children.slice(0, 2).map((c) => c.getAttribute('tabindex'))).toEqual(['0', '-1'])
    expect(innerGroup.children.map((c) => c.getAttribute('tabindex'))).toEqual(['-1', '0', '-1'])
  })

  it('moves inside the inner group only, and the outer group leaves the same key alone', async () => {
    const { byId } = await nested()
    const event = byId('i3').press('ArrowRight')
    expect(event.defaultPrevented).toBe(true)
    expect(FakeEl.active).toBe(byId('i1'))
    expect(byId('i1').clicks).toBe(1)
    expect(byId('o1').clicks + byId('o2').clicks).toBe(0)
  })

  it('moves inside the outer group without entering the inner one', async () => {
    const { byId } = await nested()
    byId('o2').press('ArrowRight')
    expect(FakeEl.active).toBe(byId('o1'))
    byId('o1').press('End')
    expect(FakeEl.active).toBe(byId('o2'))
    expect(['i1', 'i2', 'i3'].reduce((n, id) => n + byId(id).clicks, 0)).toBe(0)
  })
})

describe('leaving the page', () => {
  it('stops listening for keys and stops watching the chips when the group is removed', async () => {
    const shown = ref(true)
    const Page = defineComponent({
      setup: () => () => h('div', {}, shown.value ? [withDirectives(h('div', { role: 'radiogroup' }, [h('button', { role: 'radio', 'aria-checked': 'true' }), h('button', { role: 'radio', 'aria-checked': 'false' })]), [[vRadioGroup]])] : []),
    })
    const root = new FakeEl('root')
    renderer().createApp(Page).mount(root)
    await settle()
    const group = root.children[0].children[0]
    const [a] = group.children
    expect(watchers.size).toBe(1)
    expect(group.listeners.keydown).toHaveLength(1)
    shown.value = false
    await settle()
    expect(watchers.size).toBe(0)
    expect(group.listeners.keydown).toHaveLength(0)
    expect(a.press('ArrowRight').defaultPrevented).toBe(false)
  })

  it('does nothing in a page without MutationObserver or querySelectorAll (the stand-in page of the screen tests)', async () => {
    vi.stubGlobal('MutationObserver', undefined)
    const { group, tabs } = await draw([{ id: 'a', checked: true }, { id: 'b' }])
    expect(group.listeners.keydown).toBeUndefined()
    expect(tabs()).toEqual([null, null])
    const bare = { addEventListener: vi.fn() }
    vRadioGroup.mounted(bare, { value: undefined })
    expect(bare.addEventListener).not.toHaveBeenCalled()
  })
})
