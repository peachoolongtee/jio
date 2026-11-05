// The liquid metal button (review of 1 November 2026): a short visible caption besides its accessible name, and a shader that starts
// when the browser is idle, not while the page is first drawn. Drawn on the in-memory page (domless.js); the shader library is stood in for.
import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountScreen } from './domless.js'
import LiquidMetalButton from '../../components/ui/LiquidMetalButton.vue'

const shader = vi.hoisted(() => ({ made: vi.fn() }))
vi.mock('@paper-design/shaders', () => ({
  ShaderMount: class {
    constructor(...args) { shader.made(...args) }
    setSpeed() {}
    dispose() {}
  },
  liquidMetalFragmentShader: 'frag',
  LiquidMetalShapes: { circle: 1 },
  ShaderFitOptions: { contain: 1 },
  emptyPixel: {},
}))
afterEach(() => {
  vi.unstubAllGlobals()
  shader.made.mockClear()
})

describe('the caption', () => {
  it('shows a short word under the circle and keeps the full name for a screen reader', async () => {
    const view = await mountScreen(LiquidMetalButton, { props: { label: 'Find places from a post', caption: 'From a post' } })
    const button = view.one('button')
    expect(button.attrs['aria-label']).toBe('Find places from a post')
    expect(view.text('.lm__caption')).toBe('From a post')
    // The visible words are inside the name, so a voice user who says them reaches it.
    expect(button.attrs['aria-label'].toLowerCase()).toContain(view.text('.lm__caption').toLowerCase())
    // The caption is not read a second time, and the circle is only a picture.
    expect(view.one('.lm__caption').attrs['aria-hidden']).toBe('true')
    expect(view.one('.lm').attrs['aria-hidden']).toBe('true')
  })

  it('has no caption unless asked for one', async () => {
    const view = await mountScreen(LiquidMetalButton, { props: { label: 'Surprise me' } })
    expect(view.has('.lm__caption')).toBe(false)
  })

  // Darius, 4 November 2026: Home and the top bar now use RainbowButton for "Find places from a post", still named and with no caption,
  // and (#238) shown only where the server can read posts (offerPosts, lib/usePostReader.js).
  it('the post link on Home and in the top bar is named, goes to the post page, has no caption, and shows only where posts can be read', () => {
    // Read from the source: Home is too big a screen to draw for one attribute.
    const home = readFileSync(new URL('../../views/LandingView.vue', import.meta.url), 'utf8')
    const bar = readFileSync(new URL('../../components/ui/TabBar.vue', import.meta.url), 'utf8')
    for (const source of [home, bar]) expect(source).toMatch(/<RainbowButton v-if="offerPosts" label="Find places from a post" to="\/places\/from-post"/)
    expect(home).not.toMatch(/caption="From a post"/)
  })
})

describe('the shader', () => {
  it('does not start while the page is drawn, but when the browser is idle', async () => {
    const idle = []
    vi.stubGlobal('window', { requestIdleCallback: (fn) => (idle.push(fn), idle.length), cancelIdleCallback() {}, matchMedia: () => ({ matches: false }) })
    const view = await mountScreen(LiquidMetalButton, { props: { label: 'Find places from a post' } })
    await view.tick()
    expect(shader.made).not.toHaveBeenCalled()
    expect(idle).toHaveLength(1)
    await idle[0]()
    await view.tick()
    expect(shader.made).toHaveBeenCalledTimes(1)
  })

  it('stops it moving while the button is off screen and starts it again in view', () => {
    const source = readFileSync(new URL('../../components/ui/LiquidMetalButton.vue', import.meta.url), 'utf8')
    expect(source).toContain('IntersectionObserver')
    expect(source).toMatch(/setSpeed\?\.\(visible \? \(hovered \? SPEED\.hover : SPEED\.rest\) : 0\)/)
  })
})
