// The weather pieces as a person sees them, drawn with the tiny stand-in for the page (miniDom.js): the source line and its
// banner, the licence notice, the mark on a card, the stop card's mark, and the rain layer on Home's map. What decides the
// words is lib/weatherText.js (tested apart); these check the words reach the page, in the right place, once.
import { describe, expect, it } from 'vitest'
import { mount } from './miniDom.js'
import WeatherSource from '../../components/weather/WeatherSource.vue'
import WeatherMark from '../../components/weather/WeatherMark.vue'
import SuggestionCard from '../../components/event/SuggestionCard.vue'
import StopCard from '../../components/event/StopCard.vue'
import SingaporeMap from '../../components/ui/SingaporeMap.vue'
import { stopMark } from '../weatherText.js'

const LIVE = { source: 'live', basis: 'area', issuedAt: '2026-10-11T14:10:00+08:00' }

describe('the source line', () => {
  it('is one muted line: where the forecast came from and when', () => {
    const page = mount(WeatherSource, { block: LIVE })
    const line = page.all('', 'NEA forecast, 14:10')
    expect(line.length).toBeGreaterThan(0)
    expect(page.all('', 'Simulated')).toHaveLength(0)
    expect(page.all('p').filter((p) => (p.props.class || '').includes('text-muted'))).toHaveLength(1)
  })

  it('says a stop outside the forecast window is checked from the day before', () => {
    expect(mount(WeatherSource, { block: { source: 'none', basis: 'none', reason: 'outside_window' } }).text()).toContain('Weather is checked from the day before')
    expect(mount(WeatherSource, { block: null }).text()).toContain('Weather is checked from the day before')
  })

  it('says plainly when the forecast could not be fetched', () => {
    expect(mount(WeatherSource, { block: { source: 'unavailable', basis: 'none', reason: 'unavailable' } }).text()).toContain('Weather is not available right now')
  })

  it('says the last check did not work, beside the forecast it kept', () => {
    expect(mount(WeatherSource, { block: LIVE, refreshFailed: true }).text()).toContain('NEA forecast, 14:10 · could not check again')
  })

  it('opens the licence notice one tap away, from a button that says what it is, and closes it again', async () => {
    const page = mount(WeatherSource, { block: LIVE })
    expect(page.text()).not.toContain('Singapore Open Data Licence')
    const more = page.button('About this forecast')
    expect(page.attr(more, 'aria-expanded')).toBe('false')
    await more.click()
    expect(page.text()).toContain('Contains information from 2-hour Weather Forecast accessed on 11 Oct 2026 from data.gov.sg')
    expect(page.text()).toContain('Singapore Open Data Licence version 1.0')
    const link = page.all('a')[0]
    expect(page.attr(link, 'href')).toBe('https://data.gov.sg/open-data-licence')
    expect(page.attr(link, 'rel')).toContain('noopener')
    expect(page.attr(page.button('About this forecast'), 'aria-expanded')).toBe('true')
    await page.button('About this forecast').click()
    expect(page.text()).not.toContain('Singapore Open Data Licence')
  })

  it('has no notice for a forecast that is not NEA\'s', () => {
    for (const block of [{ source: 'simulated' }, { source: 'unavailable' }, { source: 'none', reason: 'outside_window' }, null]) {
      expect(mount(WeatherSource, { block }).button('About this forecast')).toBeNull()
    }
  })
})

describe('a simulated forecast', () => {
  const SIM = { source: 'simulated', basis: 'simulated' }

  it('is said in the line, as a tag with a sentence, and not muted', () => {
    const page = mount(WeatherSource, { block: SIM })
    expect(page.text()).toContain('Simulated forecast')
    expect(page.text()).toContain('made up for the demo')
    expect(page.all('p').filter((p) => (p.props.class || '').includes('text-muted'))).toHaveLength(0)
    expect(page.all('', 'NEA forecast')).toHaveLength(0)
  })

  it('is also a banner at the top of the screen, and the banner is only for a simulated forecast', () => {
    const banner = mount(WeatherSource, { block: SIM, banner: true })
    expect(banner.all('', 'Simulated forecast.').length).toBeGreaterThan(0)
    expect(banner.all('div').some((d) => d.props['data-testid'] === 'weather-simulated-banner')).toBe(true)
    expect(banner.attr(banner.all('div').find((d) => d.props['data-testid'] === 'weather-simulated-banner'), 'role')).toBe('status')
    // No banner, and no line either, for any other forecast.
    for (const block of [LIVE, null, { source: 'unavailable' }, { source: 'none' }]) expect(mount(WeatherSource, { block, banner: true }).text()).toBe('')
  })
})

describe('the mark on a stop and on a card', () => {
  it('is words with an icon, and the words are on the page', () => {
    const page = mount(WeatherMark, { mark: stopMark({ state: 'dry', rainLikely: false }, {}) })
    expect(page.text()).toContain('Dry')
    expect(page.all('svg').length).toBeGreaterThan(0)
  })

  it('has NEA\'s phrase in words for a screen reader only', () => {
    const page = mount(WeatherMark, { mark: stopMark({ state: 'showers', phrase: 'Light Showers', rainLikely: true }, { exposed: true }) })
    const hidden = page.all('span').filter((s) => (s.props.class || '').includes('sr-only'))
    expect(hidden).toHaveLength(1)
    expect(page.textOf(hidden[0])).toContain('NEA says Light Showers')
    expect(page.all('span').filter((s) => (s.props.class || '').includes('tag--warning') || (s.props.class || '').includes('tag')).length).toBeGreaterThan(0)
  })

  it('is shown on a stop card under the place, and not at all without one', () => {
    const props = { time: '15:00', duration: 60, name: 'East Coast Park', category: 'activity', price: 0, number: 2 }
    const marked = mount(StopCard, { ...props, mark: stopMark({ state: 'thundery', rainLikely: true }, { exposed: true }) })
    expect(marked.text()).toContain('Outdoor, thundery showers')
    expect(mount(StopCard, props).all('', 'Outdoor').length).toBe(0)
    expect(mount(StopCard, props).all('', 'Not known').length).toBe(0)
  })
})

describe('the voting card\'s rain mark', () => {
  const VENUE = { id: 'park', name: 'East Coast Park', kind: 'park', category: 'activity', area: 'Marine Parade', price: 0, hours: ['00:00-24:00'], rating: 8 }
  const option = (over = {}) => ({ id: VENUE.id, venue: VENUE, walk: 3, distanceM: 200, reasons: [], warnings: ['rain'], votes: 0, voters: [], swap: null, ...over })
  const text = (props) => mount(SuggestionCard, { option: option(props), outing: [], friends: [] }).text()
  const count = (words, over) => text(over).split(words).length - 1

  it('uses the weather state: "Outdoor, showers" and "Outdoor, thundery showers"', () => {
    expect(text({ weather: { state: 'showers', rainLikely: true } })).toContain('Outdoor, showers')
    expect(text({ weather: { state: 'thundery', rainLikely: true } })).toContain('Outdoor, thundery showers')
  })

  it('is one label, not a second beside the old one', () => {
    const t = text({ weather: { state: 'showers', rainLikely: true } })
    expect(t).not.toContain('rain expected')
    expect((t.match(/Outdoor,/g) || []).length).toBe(1)
    expect(count('Outdoor,', { weather: undefined })).toBe(1)
  })

  it('keeps the old words for an option from before states', () => {
    expect(text({})).toContain('Outdoor, rain expected')
  })

  it('shows nothing for an option with no rain warning, even where rain is likely', () => {
    const t = text({ warnings: [], weather: { state: 'showers', rainLikely: true } })
    expect(t).not.toContain('Outdoor')
    expect(t).not.toContain('Showers')
  })

  it('keeps the swap button where it was', () => {
    const t = text({ weather: { state: 'showers', rainLikely: true }, swap: { id: 'x', name: 'Toa Payoh Public Library' } })
    expect(t).toContain('Swap for Toa Payoh Public Library')
  })
})

describe('the rain on Home\'s map', () => {
  const layers = (page) => page.all('g').filter((g) => g.props['data-testid'] === 'map-rain')
  const falls = (page) => page.all('rect').filter((r) => (r.props.class || '').includes('rain-fall'))

  it('is not there without rain: no layer, no drops', () => {
    const page = mount(SingaporeMap, { routes: [] })
    expect(layers(page)).toHaveLength(0)
    expect(falls(page)).toHaveLength(0)
    expect(mount(SingaporeMap, { routes: [], rain: [] }).all('g').some((g) => g.props['data-testid'] === 'map-rain')).toBe(false)
  })

  it('is one patch for each place where rain is likely: a feathered wash and three layers of drops under a feathered mask, under the routes', () => {
    const page = mount(SingaporeMap, {
      routes: [{ from: { lat: 1.33, lng: 103.74 }, to: { lat: 1.35, lng: 103.85 } }],
      rain: [{ lat: 1.3508, lng: 103.8485 }, { lat: 1.3496, lng: 103.9568 }],
    })
    expect(layers(page)).toHaveLength(1)
    expect(page.all('g').filter((g) => g.props['data-testid'] === 'map-rain-patch')).toHaveLength(2)
    // Three layers of drops in each patch, far to near, each falling by one tile of its pattern.
    expect(falls(page)).toHaveLength(6)
    expect(falls(page).slice(0, 3).map((r) => r.props.class.split(' ').pop())).toEqual(['rain-fall--far', 'rain-fall--mid', 'rain-fall--near'])
    // A soft edge, not a hard circle: a mask for each patch, no clip path, and the old wash and strokes are gone.
    expect(page.all('mask')).toHaveLength(2)
    expect(page.all('clipPath')).toHaveLength(0)
    expect(page.all('rect').some((r) => (r.props.class || '').includes('sgmap__drift'))).toBe(false)
    // It is drawn before the first route, so the routes and the meeting point stay on top of it.
    const order = page.all('g')
    const rainAt = order.findIndex((g) => g.props['data-testid'] === 'map-rain')
    const routeAt = order.findIndex((g) => (g.props.style || g.props['style']) !== undefined && g !== order[rainAt] && g.children.some((c) => (c.props.class || '').includes('sgmap__route')))
    expect(rainAt).toBeGreaterThan(-1)
    expect(routeAt).toBeGreaterThan(rainAt)
  })

  it('fades in, unless told not to: a map drawn again for the same rain does not fade it out and in', () => {
    const fades = (page) => page.all('g').filter((g) => g.props['data-testid'] === 'map-rain-patch').map((g) => (g.props.class || '').includes('rain-in'))
    const rain = [{ lat: 1.35, lng: 103.85 }, { lat: 1.36, lng: 103.9 }]
    expect(fades(mount(SingaporeMap, { routes: [], rain }))).toEqual([true, true])
    expect(fades(mount(SingaporeMap, { routes: [], rain, fadeRain: false }))).toEqual([false, false])
  })

  it('draws no more patches than the limit', () => {
    const rain = Array.from({ length: 12 }, (_, i) => ({ lat: 1.3 + i * 0.01, lng: 103.85 }))
    expect(mount(SingaporeMap, { routes: [], rain }).all('g').filter((g) => g.props['data-testid'] === 'map-rain-patch')).toHaveLength(6)
  })

  it('is inside a map that is hidden from screen readers: the words for it are on the page, not here', () => {
    const page = mount(SingaporeMap, { routes: [], rain: [{ lat: 1.35, lng: 103.85 }] })
    const root = page.all('div').find((d) => (d.props.class || '').includes('sgmap'))
    expect(page.attr(root, 'aria-hidden')).toBe('true')
  })
})
