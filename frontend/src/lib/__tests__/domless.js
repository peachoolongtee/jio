// A tiny in-memory stand-in for the browser's page, so a test can draw a real screen (a .vue file), type into it, press
// its buttons and read what is on it, with no DOM in the test runner. It uses Vue's own custom renderer: the screens,
// stores and router are the real ones; only the page is made of plain objects. Not a test file itself.
//
// Vitest compiles every .vue file for server rendering (a template becomes `ssrRender`), which a client renderer cannot
// draw, and this project has no DOM library to switch that off. So the first thing mountScreen does is give each screen,
// and each component it imports, a client `render` function compiled from its own template (liven below). The script
// part is the one Vitest already loaded, so the screens' logic is exactly what runs in the browser.
//
// It is only as faithful as the screens need: elements, text, attributes, events that bubble, v-model on inputs, focus,
// and document.getElementById. It does no layout, so widths and tap sizes are measured in a browser, not here.
//
// How to call:
//   const view = await mountScreen(LoginView, { plugins: [pinia, router] })
//   view.type('#login-email', 'sam@example.com'); await view.click('button'); expect(view.text()).toContain('Log in')
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import * as Vue from 'vue'
import { createRenderer } from 'vue'
import { compileScript, compileTemplate, parse } from 'vue/compiler-sfc'
import { vi } from 'vitest'

// Transitions animate through browser calls (class lists, animation frames) that this page does not have; here a
// transition just shows its content, and what an animation looks like is not under test.
const PassThrough = { setup: (_props, { slots }) => () => slots.default?.() }
const PatchedVue = { ...Vue, Transition: PassThrough, TransitionGroup: PassThrough }
const SRC = fileURLToPath(new URL('../..', import.meta.url))
const livened = new WeakSet()

// Give `component` (a loaded .vue file) a client render function, and do the same for every .vue file it imports.
// A component without a file (a test's own stand-in) is left as it is.
// How to call: await liven(LoginView)
export async function liven(component) {
  const file = component?.__file
  if (!file || livened.has(component)) return
  livened.add(component)
  const { descriptor } = parse(readFileSync(file, 'utf8'), { filename: file })
  if (descriptor.template) {
    const id = file
    const script = descriptor.script || descriptor.scriptSetup ? compileScript(descriptor, { id }) : null
    const out = compileTemplate({
      source: descriptor.template.content,
      filename: file,
      id,
      compilerOptions: { mode: 'module', bindingMetadata: script?.bindings },
    })
    if (out.errors.length) throw new Error(`${file}: ${out.errors.join('; ')}`)
    // The compiled module imports from 'vue' and exports `render`; run it with Vue handed in.
    const body = out.code
      .replace(/import\s*\{([^}]*)\}\s*from\s*["']vue["']/, (_m, names) => `const {${names.replace(/ as /g, ': ')}} = Vue`)
      .replace(/export function render/, 'function render')
    component.render = new Function('Vue', body + '; return render')(PatchedVue)
  }
  // Follow the imports of the screen's script to the components it draws.
  const code = [descriptor.script?.content, descriptor.scriptSetup?.content].filter(Boolean).join(String.fromCharCode(10))
  for (const [, spec] of code.matchAll(/^\s*import\s+[\w$]+\s+from\s+['"]([^'"]+\.vue)['"]/gm)) {
    const target = spec.startsWith('@/') ? resolve(SRC, spec.slice(2)) : resolve(dirname(file), spec)
    await liven((await import(/* @vite-ignore */ target.split(String.fromCharCode(92)).join('/'))).default)
  }
}

class Node_ {
  constructor(kind, tag = '') {
    this.kind = kind // 'el', 'text' or 'comment'
    this.tag = tag
    this.text = ''
    this.parent = null
    this.children = []
    this.attrs = {}
    this.listeners = {}
    this.value = ''
    this.style = {}
    this.disabled = false
  }
  get type() {
    return this.attrs.type
  }
  get id() {
    return this.attrs.id
  }
  // A <select>'s <option> elements, however deep, which Vue's v-model reads to mark the chosen one (the sign-up screen's
  // last question for a real account is a select, and so are the edit-profile page's).
  get options() {
    if (this.tag !== 'select') return undefined
    const found = []
    walk(this, (n) => n !== this && n.kind === 'el' && n.tag === 'option' && found.push(n))
    return found
  }
  addEventListener(name, fn) {
    ;(this.listeners[name] ||= []).push(fn)
  }
  removeEventListener(name, fn) {
    this.listeners[name] = (this.listeners[name] || []).filter((f) => f !== fn)
  }
  focus() {
    documentStub.activeElement = this
  }
  // Vue's v-model asks where the input lives to learn whether it has focus.
  getRootNode() {
    return documentStub
  }
  // The elements inside this one that match a simple selector (see `matches`), in page order, and the first of them.
  querySelectorAll(selector) {
    const found = []
    walk(this, (n) => n !== this && matches(n, selector) && found.push(n))
    return found
  }
  querySelector(selector) {
    return this.querySelectorAll(selector)[0] ?? null
  }
  // This element, or the nearest one above it, that matches a simple selector; null when none does.
  closest(selector) {
    for (let node = this; node; node = node.parent) if (matches(node, selector)) return node
    return null
  }
  // Run the handlers for an event, then its parents', as a browser does until a handler stops it.
  dispatch(name, extra = {}) {
    const event = { type: name, target: this, preventDefault() { this.defaultPrevented = true }, stopPropagation() { this.stopped = true }, ...extra }
    for (let node = this; node && !event.stopped; node = node.parent) {
      event.currentTarget = node
      for (const fn of [...(node.listeners[name] || [])]) fn(event)
    }
    return event
  }
}

class DocumentStub {
  constructor() {
    this.activeElement = null
    this.title = ''
  }
  getElementById() {
    return null
  }
  querySelector() {
    return null
  }
  // Listeners on the whole page (a click or key outside a popover) are taken and never called: nothing here clicks
  // outside a component.
  addEventListener() {}
  removeEventListener() {}
}
class ShadowRootStub {}
const documentStub = new DocumentStub()

function nodeOps() {
  const ops = {
    createElement: (tag) => new Node_('el', tag),
    createText: (text) => Object.assign(new Node_('text'), { text }),
    createComment: (text) => Object.assign(new Node_('comment'), { text }),
    setText: (node, text) => (node.text = text),
    setElementText: (el, text) => {
      el.children.forEach((c) => (c.parent = null))
      el.children = text === '' ? [] : [Object.assign(new Node_('text'), { text, parent: el })]
    },
    insert: (child, parent, anchor) => {
      if (child.parent) ops.remove(child)
      child.parent = parent
      const at = anchor ? parent.children.indexOf(anchor) : -1
      if (at < 0) parent.children.push(child)
      else parent.children.splice(at, 0, child)
    },
    remove: (child) => {
      if (!child.parent) return
      child.parent.children = child.parent.children.filter((c) => c !== child)
      child.parent = null
    },
    parentNode: (node) => node.parent,
    nextSibling: (node) => {
      const list = node.parent?.children || []
      return list[list.indexOf(node) + 1] || null
    },
    querySelector: () => bodyStub,
    setScopeId: () => {},
    // Large static stretches of a template are compiled to one string; they carry no text a test reads.
    insertStaticContent: (content, parent, anchor) => {
      const node = Object.assign(new Node_('comment'), { text: 'static' })
      ops.insert(node, parent, anchor)
      return [node, node]
    },
    patchProp: (el, key, prev, next) => {
      if (/^on[A-Z]/.test(key)) {
        const name = key.slice(2).toLowerCase()
        if (prev) el.removeEventListener(name, prev)
        if (next) el.addEventListener(name, next)
      } else if (key === 'value') {
        el.value = next ?? ''
      } else if (key === 'disabled') {
        el.disabled = !!next
        if (next) el.attrs.disabled = ''
        else delete el.attrs.disabled
      } else if (key === 'style') {
        el.style = next || {}
      } else if (next === null || next === undefined || next === false) {
        delete el.attrs[key]
      } else {
        el.attrs[key] = next === true ? '' : String(next)
      }
    },
  }
  return ops
}

const bodyStub = new Node_('el', 'body')

const walk = (node, visit) => {
  visit(node)
  node.children.forEach((c) => walk(c, visit))
}

// The text a person would read, with a space between pieces.
const textOf = (node) => {
  if (node.kind === 'text') return node.text
  if (node.kind === 'comment') return ''
  return node.children.map(textOf).join('')
}

// A selector: '#id', '[data-testid="x"]', 'tag', '.class', or 'tag[attr=value]' (the few forms the screens need).
function matches(node, selector) {
  if (node.kind !== 'el') return false
  const parts = selector.match(/^([a-z0-9-]*)(?:#([\w-]+))?(?:\.([\w-]+))?(?:\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\])?$/i)
  if (!parts) throw new Error(`Unsupported selector: ${selector}`)
  const [, tag, id, cls, attr, attrValue] = parts
  if (tag && node.tag !== tag) return false
  if (id && node.attrs.id !== id) return false
  if (cls && !(node.attrs.class || '').split(/\s+/).includes(cls)) return false
  if (attr && !(attr in node.attrs)) return false
  if (attr && attrValue !== undefined && node.attrs[attr] !== attrValue) return false
  return true
}

// Draw `component` and return a handle to it. `plugins` are installed in order (Pinia, the router).
// How to call: const view = await mountScreen(LoginView, { plugins: [pinia, router] })
export async function mountScreen(component, { plugins = [], props = {} } = {}) {
  await liven(component)
  const errors = []
  const warnings = []
  const root = new Node_('el', 'root')
  bodyStub.children = []
  documentStub.activeElement = null
  documentStub.getElementById = (id) => {
    let found = null
    walk(root, (n) => {
      if (!found && n.kind === 'el' && n.attrs.id === id) found = n
    })
    return found
  }
  vi.stubGlobal('document', documentStub)
  vi.stubGlobal('Document', DocumentStub)
  vi.stubGlobal('ShadowRoot', ShadowRootStub)
  const { createApp } = createRenderer(nodeOps())
  const app = createApp(component, props)
  // The server-compiled script of each .vue file asks for an SSR context to note its module in; an empty one will do.
  app.provide(Vue.ssrContextKey, {})
  app.config.errorHandler = (err) => errors.push(err)
  app.config.warnHandler = (msg) => warnings.push(msg)
  plugins.forEach((p) => app.use(p))
  app.mount(root)

  const all = (selector) => {
    const hits = []
    // The page body holds what a component teleports there (a dialog).
    for (const top of [root, bodyStub]) walk(top, (n) => matches(n, selector) && hits.push(n))
    return hits
  }
  const one = (selector) => {
    const hit = all(selector)[0]
    if (!hit) throw new Error(`Nothing on screen matches ${selector}`)
    return hit
  }
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0))
  return {
    root,
    errors,
    warnings,
    all,
    one,
    has: (selector) => all(selector).length > 0,
    text: (selector) => textOf(!selector ? root : typeof selector === 'string' ? one(selector) : selector).replace(/\s+/g, ' ').trim(),
    // The element that has focus.
    focused: () => documentStub.activeElement,
    // Type into an input, as the keyboard does.
    type(selector, value) {
      const el = one(selector)
      el.value = value
      el.dispatch('input')
    },
    // Press a control. A submit button also submits its form (the one named by its form attribute, else the one it is in).
    async click(selector) {
      // The page redraws after typing, before a person can press anything.
      await tick()
      const el = typeof selector === 'string' ? one(selector) : selector
      if (el.disabled) return
      el.dispatch('click')
      if (el.tag === 'button' && el.attrs.type === 'submit') {
        let form = el.attrs.form ? all(`form#${el.attrs.form}`)[0] : null
        for (let n = el.parent; !form && n; n = n.parent) if (n.tag === 'form') form = n
        form?.dispatch('submit')
      }
      await tick()
    },
    // Submit a form by pressing Enter in one of its fields.
    async enter(selector) {
      await tick()
      let form = one(selector)
      while (form && form.tag !== 'form') form = form.parent
      form.dispatch('submit')
      await tick()
    },
    tick,
    unmount: () => app.unmount(),
  }
}

// Wait until a check passes, polling the event loop (the data layer waits a few milliseconds on purpose).
// How to call: await until(() => view.has('[data-testid="check-email"]'))
export async function until(check, ms = 8000) {
  // Counted in turns, not read from the clock: some tests freeze the date.
  for (let turns = 0; !check(); turns += 1) {
    if (turns * 5 > ms) throw new Error('Timed out waiting for the screen')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}
