// Home's places near the meeting point as one row that scrolls sideways (walkthrough, 30 October 2026), built in Vue from a card-carousel
// idea: PlaceCarousel (the row and its arrows) and PlaceTile (a card). Drawn on the in-memory page (domless.js), which has no layout, so
// the scrolling itself is checked in a browser; here, what is drawn and named.
import { describe, expect, it } from 'vitest'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { liven, mountScreen } from './domless.js'
import PlaceCarousel from '../../components/ui/PlaceCarousel.vue'
import PlaceTile from '../../components/event/PlaceTile.vue'

const place = (id, over = {}) => ({ id, name: `Place ${id}`, category: 'eat', area: 'Bugis', distanceKm: 0.3, price: 2, rating: 8.1, ...over })

// A carousel of `n` tiles, with a "Show more" card at the end when `more` is set.
// How to call: const view = await draw(3, true)
async function draw(n, more = false) {
  // The stand-in below has no file of its own, so the two real components are given their client render functions first.
  await liven(PlaceCarousel)
  await liven(PlaceTile)
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  const items = Array.from({ length: n }, (_, i) => place(`p${i + 1}`))
  const Demo = {
    render: () => h(PlaceCarousel, { items, label: 'Places near Bugis' }, {
      item: ({ item }) => h(PlaceTile, { place: item }),
      ...(more ? { end: () => h('button', { type: 'button', 'data-testid': 'more' }, 'Show more') } : {}),
    }),
  }
  return mountScreen(Demo, { plugins: [router] })
}

describe('the row of places', () => {
  it('is one labelled list, a card per place, with what follows at its end', async () => {
    const view = await draw(3, true)
    const list = view.one('[data-testid=carousel-track]')
    expect(list.tag).toBe('ul')
    expect(list.attrs['aria-label']).toBe('Places near Bugis')
    expect(view.all('article')).toHaveLength(3)
    expect(view.has('[data-testid=more]')).toBe(true)
    expect(view.errors).toEqual([])
  })

  it('names its arrows, and hides the one for going back at the start, out of the tab order', async () => {
    const view = await draw(3)
    const prev = view.one('[data-testid=carousel-prev]')
    expect(prev.attrs['aria-label']).toBe('Show earlier places')
    expect(prev.attrs['aria-hidden']).toBe('true')
    expect(String(prev.attrs.tabindex)).toBe('-1')
    expect(view.one('[data-testid=carousel-next]').attrs['aria-label']).toBe('Show more places')
    // A press with nothing to scroll does nothing and breaks nothing.
    await view.click('[data-testid=carousel-next]')
    expect(view.errors).toEqual([])
  })

  it('has no end card when there is nothing more', async () => {
    const view = await draw(2)
    expect(view.has('[data-testid=more]')).toBe(false)
  })
})

describe('a place card in the row', () => {
  it('says the category, the name, where and how far, the price and the rating, and is named for the place', async () => {
    const view = await draw(1)
    const card = view.one('article')
    expect(card.attrs['aria-label']).toBe('Place p1')
    const text = view.text(card)
    expect(text).toContain('Eat')
    expect(text).toContain('Place p1')
    expect(text).toContain('Bugis · 0.3 km')
    expect(text).toContain('8.1')
  })
})
