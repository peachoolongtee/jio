// "Places from a post" for a screen reader (review of 1 November 2026): each "Open in Google Maps" link names its place and says it opens a
// new tab, and the line about a video taking up to 40 seconds is not hidden from a screen reader with the grey rows. Drawn on the in-memory
// page (domless.js); the data layer's two calls are stood in for.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mountScreen, until } from './domless.js'

const held = vi.hoisted(() => ({ postReaderStatus: vi.fn(), placesFromPost: vi.fn() }))
vi.mock('../api.js', async (importOriginal) => ({ ...(await importOriginal()), ...held }))
vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
afterEach(() => vi.unstubAllGlobals())

const ANSWER = {
  status: 'ok',
  places: [
    { name: 'Starlight Cafe', nameEnglish: '', locationHint: 'Orchard', match: { placeId: 'abc', name: 'Starlight Cafe', address: '9 Example Road', rating: 4.5, ratingCount: 66, ambiguous: true, alternatives: [{ placeId: 'def', name: 'Starlight Cafe, Bugis', address: '1 Bugis Street' }] } },
    { name: 'Hidden Noodles', nameEnglish: 'Hidden Noodles', locationHint: 'Chinatown', match: null },
  ],
  notes: [],
  source: {},
}
const draw = async () => {
  held.postReaderStatus.mockResolvedValue({ enabled: true })
  const { default: View } = await import('@/views/PostPlacesView.vue')
  const { createRouter, createMemoryHistory } = await import('vue-router')
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  await router.push('/places/from-post')
  return mountScreen(View, { plugins: [router] })
}

describe('the places found', () => {
  it('names the place in each Maps link and says it opens in a new tab, and has a visible cue', async () => {
    held.placesFromPost.mockResolvedValue(ANSWER)
    const view = await draw()
    await until(() => view.has('[data-testid=post-link]'))
    view.type('input', 'https://www.youtube.com/watch?v=a1')
    await view.click(view.one('[data-testid=post-read]'))
    await until(() => view.has('[data-testid=post-places]'))
    const links = view.all('[data-testid=post-maps]')
    expect(links).toHaveLength(2)
    expect(view.text(links[0])).toBe('Open in Google Maps for Starlight Cafe, opens in a new tab')
    expect(view.text(links[1])).toBe('Search Google Maps for Hidden Noodles, opens in a new tab')
    for (const link of links) {
      expect(link.attrs.target).toBe('_blank')
      expect(link.attrs.rel).toContain('noopener')
      expect(link.querySelector('svg')).toBeTruthy()
    }
    // The other branches' links say which branch.
    const branch = view.all('a').find((a) => view.text(a).startsWith('Open Starlight Cafe, Bugis'))
    expect(view.text(branch)).toBe('Open Starlight Cafe, Bugis in Google Maps, opens in a new tab')
  })
})

describe('while a post is read', () => {
  it('says that a video can take 40 seconds where a screen reader can read it, and hides only the grey rows', async () => {
    held.placesFromPost.mockImplementation(() => new Promise(() => {}))
    const view = await draw()
    await until(() => view.has('[data-testid=post-link]'))
    view.type('input', 'https://www.youtube.com/watch?v=a1')
    await view.click(view.one('[data-testid=post-read]'))
    await until(() => view.has('[data-testid=post-reading]'))
    const hint = view.one('[data-testid=post-reading]')
    expect(view.text(hint)).toContain('A video can take up to 40 seconds.')
    for (let node = hint; node; node = node.parent) expect(node.attrs?.['aria-hidden']).toBeUndefined()
    expect(view.text('[role=status]')).toBe('Reading the post')
  })
})
