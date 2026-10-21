// The toast sits above the bottom edge by its offset plus the home indicator's inset, so it clears the tab bar pill, which
// rises by the same inset (components/ui/ToastMessage.vue). Drawn with the stand-in page (miniDom.js).
import { describe, expect, it } from 'vitest'
import { mount } from './miniDom.js'
import ToastMessage from '../../components/ui/ToastMessage.vue'

const toast = (props = {}) => mount(ToastMessage, { show: true, text: 'Link copied', duration: 0, ...props }).all('div')[0]

describe('the toast', () => {
  it('adds the bottom inset to its default offset', () => {
    expect(toast().props.style.bottom).toBe('calc(96px + env(safe-area-inset-bottom, 0px))')
  })

  it('adds the bottom inset to an offset it is given', () => {
    expect(toast({ offset: 120 }).props.style.bottom).toBe('calc(120px + env(safe-area-inset-bottom, 0px))')
  })

  it('is a polite status, not an alert', () => {
    expect(toast().props.role).toBe('status')
  })
})
