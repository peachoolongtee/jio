// A tiny stand-in for the browser's page, so a component can be rendered and clicked in a test that runs in Node (the
// suite has no DOM and no component-testing library; the test file must be listed under testTransformMode in vite.config.js). Vue's own custom renderer builds a tree of plain objects; this file
// reads it back as text and attributes and sends clicks to the handlers. Not a test file itself (no .test.js).
//   const page = mount(SpotList, { session }, [pinia])
//   page.button('Works for me').click()   page.text()   page.attr(el, 'aria-pressed')
import { createRenderer, nextTick } from 'vue'

const node = (type, tag = '') => ({ type, tag, props: {}, listeners: {}, children: [], parent: null, text: '' })

// How to call: const { createApp } = createRenderer(options) — the operations Vue needs to build and change a tree.
function operations(body) {
  return {
    // `style` is there for v-show, which sets style.display on the element itself.
    createElement: (tag) => ({ ...node('el', tag), style: {} }),
    createText: (text) => ({ ...node('text'), text }),
    createComment: () => node('comment'),
    setText: (n, text) => { n.text = text },
    setElementText: (n, text) => { n.children = text ? [{ ...node('text'), text, parent: n }] : [] },
    insert(child, parent, anchor) {
      if (child.parent) operations(body).remove(child)
      const at = anchor ? parent.children.indexOf(anchor) : -1
      if (at < 0) parent.children.push(child)
      else parent.children.splice(at, 0, child)
      child.parent = parent
    },
    remove(child) {
      const parent = child.parent
      if (!parent) return
      parent.children.splice(parent.children.indexOf(child), 1)
      child.parent = null
    },
    parentNode: (n) => n.parent,
    nextSibling: (n) => n.parent?.children[n.parent.children.indexOf(n) + 1] || null,
    querySelector: () => body,
    patchProp(el, key, prev, next) {
      if (/^on[A-Z]/.test(key)) el.listeners[key.slice(2).toLowerCase()] = next
      else if (next == null) delete el.props[key]
      else el.props[key] = next
    },
  }
}

const everyNode = (n) => [n, ...n.children.flatMap(everyNode)]
const textOf = (n) => (n.type === 'text' ? n.text : n.children.map(textOf).join(' '))
const squash = (s) => s.replace(/\s+/g, ' ').trim()

// Render a component with props and plugins (a pinia), and read it back.
// How to call: const page = mount(SpotList, { session }, [pinia]); await page.button('Suggest a spot').click()
export function mount(component, props = {}, plugins = []) {
  const root = node('el', 'root')
  const body = node('el', 'body')
  const { createApp } = createRenderer(operations(body))
  const app = createApp(component, props)
  for (const plugin of plugins) app.use(plugin)
  app.mount(root)
  const elements = () => everyNode(root).filter((n) => n.type === 'el')
  const page = {
    root,
    app,
    // All the text on the page, spaces squashed.
    text: () => squash(textOf(root)),
    textOf: (el) => squash(textOf(el)),
    // An attribute as text ('true', not true), or undefined.
    attr: (el, name) => (el.props[name] == null ? undefined : String(el.props[name])),
    // Every element whose tag is `tag` (any when omitted) and whose text contains `contains`.
    all: (tag = '', contains = '') => elements().filter((el) => (!tag || el.tag === tag) && squash(textOf(el)).includes(contains)),
    // The first button whose text contains `label`, or null. `.click()` presses it unless it is disabled.
    button(label) {
      const el = elements().find((n) => n.tag === 'button' && squash(textOf(n)).includes(label)) || null
      if (!el) return null
      return Object.assign(el, {
        async click() {
          if (el.props.disabled) return
          for (const fn of [].concat(el.listeners.click || [])) await fn({ pointerType: 'mouse', detail: 1, target: el })
          await new Promise((resolve) => setTimeout(resolve, 0))
          await nextTick()
        },
      })
    },
  }
  return page
}
