// The rain on the maps ("Layered drops"): the words on the chip for each source of forecast, the rainy places of an itinerary,
// the markup of one patch, the chip as a component, and the session map (PlannerMap, with Leaflet stood in for, since the suite has
// no browser) putting the rain in a pane of its own under the route and the markers, resizing it with the zoom, and leaving the
// tiles and the attribution alone. The look itself is checked by eye in a browser (see the report for this change).
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from './miniDom.js'
import RainChip from '../../components/weather/RainChip.vue'
import { MAX_RAIN_PATCHES, RAIN_STREAKS, itineraryRain, nextRainUid, rainChipText, rainPatchSvg, rainSpots } from '../rainLook.js'
import { homeRainText } from '../weatherText.js'
import { rainView } from '../homeRain.js'

// What Leaflet is asked to do, recorded. The fake is only as big as PlannerMap uses.
const calls = vi.hoisted(() => ({ panes: [], markers: [], tiles: [], handlers: {}, map: null }))
vi.mock('leaflet/dist/leaflet.css', () => ({}))
vi.mock('leaflet', () => {
  const group = () => {
    const g = { layers: [], addTo: () => g, clearLayers: () => { g.layers = [] }, addLayer: (l) => g.layers.push(l) }
    return g
  }
  const chain = () => {
    const o = { addTo: () => o, bindTooltip: () => o, on: () => o, getElement: () => null }
    return o
  }
  const L = {
    map: (_el, options) => {
      const zoom = { value: 15 }
      const map = {
        options,
        zoom,
        createPane: (name) => { const pane = { name, style: {} }; calls.panes.push(pane); return pane },
        getZoom: () => zoom.value,
        // The map's furthest-out zoom (syncMinZoom) and the shifted centre for the floating cards (viewInFree, 4 November 2026).
        getMinZoom: () => 10,
        setMinZoom: () => {},
        getBoundsZoom: () => 11,
        project: () => ({ add: () => ({}) }),
        unproject: () => [1.3, 103.8],
        getBounds: () => ({ pad: () => ({ contains: () => true }) }),
        fitBounds: () => {},
        setView: () => {},
        invalidateSize: () => {},
        latLngToContainerPoint: () => ({ x: 0, y: 0 }),
        on: (names, fn) => String(names).split(' ').forEach((n) => (calls.handlers[n] = [...(calls.handlers[n] || []), fn])),
        off: () => {},
        remove: () => {},
      }
      calls.map = map
      return map
    },
    control: { zoom: () => chain() },
    tileLayer: (url, options) => { calls.tiles.push({ url, options }); return chain() },
    layerGroup: () => group(),
    latLngBounds: () => ({}),
    // Leaflet keeps an icon's settings under `options`; the test reads the same fields straight off it.
    divIcon: (options) => ({ options, html: options.html, iconSize: options.iconSize }),
    polyline: () => chain(),
    circle: () => chain(),
    marker: (latlng, options) => {
      const marker = { latlng, options, icon: options.icon, addTo: (g) => { g?.layers.push(marker); return marker }, setIcon: (icon) => { marker.icon = icon; marker.options.icon = icon; marker.resized = (marker.resized || 0) + 1 }, getLatLng: () => ({ lat: latlng[0], lng: latlng[1] }), bindTooltip: () => marker, on: () => marker, getElement: () => marker.element || null }
      calls.markers.push(marker)
      return marker
    },
  }
  return { default: L }
})
vi.mock('../../components/map/retireMap.js', () => ({ retireMap: vi.fn() }))

const { default: PlannerMap } = await import('../../components/map/PlannerMap.vue')

const live = { source: 'live', basis: 'area', issuedAt: '2026-10-26T05:30:00+08:00', validUntil: '2026-10-26T07:30:00+08:00' }
// A moment inside that forecast's two hours, and one after it.
const DURING = new Date('2026-10-26T06:00:00+08:00')
const AFTER = new Date('2026-10-26T07:30:00+08:00')

describe('the words on the rain chip', () => {
  it('names the two hours only for the live two-hour forecast', () => {
    expect(rainChipText(live)).toBe('Rain likely · next 2 h')
  })

  it('makes no claim about two hours for the live 24-hour or mixed forecast', () => {
    expect(rainChipText({ ...live, basis: 'regional' })).toBe('Rain likely')
    expect(rainChipText({ ...live, basis: 'mixed' })).toBe('Rain likely')
  })

  // The demo's simulated rain has no chip on the map (Darius, 4 November 2026); the page's "Simulated forecast" note still says so.
  it('shows no chip for the demo\'s simulated rain', () => {
    expect(rainChipText({ source: 'simulated', basis: 'simulated' })).toBe('')
  })

  it('leaves the chip out when nothing is known about where the forecast came from', () => {
    expect(rainChipText({ source: 'unavailable', reason: 'unavailable' })).toBe('')
    expect(rainChipText({ source: 'none', reason: 'outside_window' })).toBe('')
    expect(rainChipText(null)).toBe('')
    expect(rainChipText(undefined)).toBe('')
  })

  const outing = { area: { id: 'bishan', name: 'Bishan', lat: 1.35, lng: 103.85 } }
  const answer = (weather) => ({ stops: { bishan: { rainLikely: true } }, weather })

  it('reads Home\'s answer: the block of the planner\'s reply decides the words', () => {
    expect(rainChipText(rainView([outing], answer(live), DURING).block)).toBe('Rain likely · next 2 h')
    expect(rainChipText(rainView([outing], answer({ source: 'simulated' }), DURING).block)).toBe('')
    expect(rainView([outing], answer(undefined), DURING)).toBeNull()
  })

  // Home's only words for a screen reader are the line; the chip is hidden from it. They must never disagree about the source. The
  // demo's simulated rain has no chip at all, and its line still says it is simulated.
  it('is worded the same way by Home\'s line and by the chip, for every source', () => {
    const cases = [
      ['live, two hours', live, { chip: 'Rain likely · next 2 h', line: 'Rain likely around Bishan in the next two hours' }],
      ['live, 24 hours', { ...live, basis: 'regional' }, { chip: 'Rain likely', line: 'Rain likely around Bishan' }],
      ['live, mixed', { ...live, basis: 'mixed' }, { chip: 'Rain likely', line: 'Rain likely around Bishan' }],
      ['simulated', { source: 'simulated', basis: 'simulated' }, { chip: '', line: 'Simulated rain around Bishan' }],
    ]
    for (const [name, block, words] of cases) {
      const view = rainView([outing], answer(block), DURING)
      expect(rainChipText(view.block), name).toBe(words.chip)
      expect(view.text, name).toBe(words.line)
      expect(homeRainText(['Bishan'], block), name).toBe(words.line)
      // "two hours" is claimed by both or by neither.
      expect(/next 2 h/.test(rainChipText(block)), name).toBe(/two hours/.test(view.text))
      // A chip never claims rain is real when the line says it is simulated (the simulated rain has no chip at all).
      if (rainChipText(block)) expect(/imulated/.test(rainChipText(block)), name).toBe(/imulated/.test(view.text))
    }
    // With nothing known about the source there is no chip, no line and no rain.
    for (const block of [null, { source: 'unavailable', reason: 'unavailable' }, { source: 'none', reason: 'outside_window' }]) {
      expect(rainChipText(block)).toBe('')
      expect(rainView([outing], answer(block), DURING)).toBeNull()
    }
  })
})

describe('the chip, as a component', () => {
  it('is a plain chip with the icon and the words, not a button', () => {
    const page = mount(RainChip, { text: 'Rain likely · next 2 h' })
    expect(page.text()).toBe('Rain likely · next 2 h')
    expect(page.all('button')).toHaveLength(0)
    expect(page.all('a')).toHaveLength(0)
    const chip = page.all('span').find((s) => s.props['data-testid'] === 'rain-chip')
    expect(chip).toBeTruthy()
    expect(chip.props.tabindex).toBeUndefined()
  })

  it('draws nothing without words', () => {
    expect(mount(RainChip, { text: '' }).all('span').filter((s) => s.props['data-testid'] === 'rain-chip')).toHaveLength(0)
    expect(mount(RainChip).text()).toBe('')
  })
})

describe('the rain of an itinerary', () => {
  const stop = (id, lat, lng) => ({ slotId: id, venue: { id, lat, lng } })
  const stops = [stop('a', 1.3, 103.8), stop('b', 1.3001, 103.8001), stop('c', 1.31, 103.8), stop('d', 1.4, 103.7)]
  const weather = { a: { rainLikely: true, source: 'live' }, b: { rainLikely: true, source: 'live' }, c: { rainLikely: true, source: 'live' }, d: { rainLikely: false, source: 'live' } }
  const of = (s) => weather[s.slotId]

  it('is a patch of its own for each stop where rain is likely, and one for stops in the same spot', () => {
    const rain = itineraryRain(stops, of, live, DURING)
    // a and b are about 15 m apart: one patch. c is a kilometre away: its own, so it has rain round it when zoomed in.
    expect(rain.places).toEqual([{ lat: 1.3, lng: 103.8 }, { lat: 1.31, lng: 103.8 }])
    expect(rain.text).toBe('Rain likely · next 2 h')
  })

  it('draws no more patches than the limit', () => {
    const many = Array.from({ length: 12 }, (_, i) => stop(`s${i}`, 1.3 + i * 0.01, 103.8))
    expect(itineraryRain(many, () => ({ rainLikely: true, source: 'live' }), live, DURING).places).toHaveLength(MAX_RAIN_PATCHES)
  })

  it('draws nothing for a forecast that is not live or simulated, or for a stop with no weather', () => {
    const bad = { a: { rainLikely: true, source: 'none' }, b: { rainLikely: true, source: 'unavailable' }, c: undefined, d: { rainLikely: true } }
    expect(itineraryRain(stops, (s) => bad[s.slotId], null, DURING)).toEqual({ places: [], text: '' })
    expect(itineraryRain(undefined, () => null, null, DURING)).toEqual({ places: [], text: '' })
  })

  it('draws nothing once the forecast has run out: a forecast kept at confirm time is not current hours later', () => {
    expect(itineraryRain(stops, of, live, DURING).places).toHaveLength(2)
    expect(itineraryRain(stops, of, live, AFTER)).toEqual({ places: [], text: '' })
    // With no end time, two hours from when it was issued.
    const issued = { source: 'live', basis: 'area', issuedAt: live.issuedAt }
    expect(itineraryRain(stops, of, issued, DURING).places).toHaveLength(2)
    expect(itineraryRain(stops, of, issued, AFTER)).toEqual({ places: [], text: '' })
    // A stop's own times win over the block's.
    const own = (s) => ({ rainLikely: true, source: 'live', validUntil: '2026-10-26T12:00:00+08:00' })
    expect(itineraryRain(stops, own, live, AFTER).places.length).toBeGreaterThan(0)
  })

  it('draws the demo\'s simulated rain with no chip, and never lets it run out', () => {
    const rain = itineraryRain([stop('a', 1.3, 103.8)], () => ({ rainLikely: true, source: 'simulated' }), { source: 'simulated', basis: 'simulated' }, new Date('2031-01-01T00:00:00Z'))
    expect(rain.places).toHaveLength(1)
    expect(rain.text).toBe('')
  })

  it('keeps places more than 150 m apart and skips points that are not places', () => {
    expect(rainSpots([{ lat: 1.3, lng: 103.8 }, { lat: 1.3, lng: 103.8015 }])).toHaveLength(2)
    expect(rainSpots([{ lat: 1.3, lng: 103.8 }, { lat: 1.3, lng: 103.8012 }])).toHaveLength(1)
    expect(rainSpots([{ lat: NaN, lng: 1 }, null, undefined, {}])).toEqual([])
  })
})

describe('one patch of rain as markup', () => {
  const svg = rainPatchSvg({ size: 240, uid: 'u1', fade: true })

  // Slanted streaks that fade in (4 November 2026), in place of the three patterned layers of drops.
  it('has a feathered wash, a feathered mask and slanted streaks that fall inside it', () => {
    expect(svg).toContain('<radialGradient id="u1-wash">')
    expect(svg).toContain('<mask id="u1-mask"')
    expect(svg).toContain('<linearGradient id="u1-streak"')
    expect(svg).toContain(`<g class="rain-wind" style="--rain-travel:`)
    expect(svg).toContain(`transform="rotate(${RAIN_STREAKS.angle} 120 120)"`)
    const streaks = svg.match(/<rect class="rain-streak"/g) || []
    expect(streaks.length).toBeGreaterThanOrEqual(RAIN_STREAKS.min)
    expect(streaks.length).toBeLessThanOrEqual(RAIN_STREAKS.max)
    // The same seed draws the same streaks, so a redraw or a zoom does not reshuffle them.
    expect(rainPatchSvg({ size: 240, uid: 'u1', fade: true })).toBe(svg)
    // The drops stay inside the wash, so they fade out before the tint does.
    expect(svg).toContain('r="110" fill="url(#u1-feather)"')
    expect(svg).toContain('r="120" fill="url(#u1-wash)"')
  })

  it('is hidden from screen readers, and fades in only when asked', () => {
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).toContain('class="rain-patch rain-in"')
    expect(rainPatchSvg({ size: 240, uid: 'u2' })).toContain('class="rain-patch"')
  })

  it('never gives two patches the same ids, however many maps are on the page', () => {
    const ids = Array.from({ length: 50 }, () => nextRainUid())
    expect(new Set(ids).size).toBe(50)
    const a = rainPatchSvg({ size: 200, uid: nextRainUid() }).match(/id="[^"]+"/g)
    const b = rainPatchSvg({ size: 200, uid: nextRainUid() }).match(/id="[^"]+"/g)
    expect(a.filter((id) => b.includes(id))).toEqual([])
  })

  it('writes only the look\'s own numbers and ids: no colour, no outside text', () => {
    expect(svg).not.toMatch(/#[0-9a-f]{3,6}\b/i)
    expect(svg).not.toMatch(/<script|javascript:|onload/i)
  })
})

describe('the session map\'s rain', () => {
  beforeEach(() => {
    calls.panes.length = 0
    calls.markers.length = 0
    calls.tiles.length = 0
    calls.handlers = {}
    // The map asks the page about reduced motion and watches its box; the suite has neither, so both are stood in for.
    globalThis.window = { matchMedia: () => ({ matches: false }) }
    globalThis.ResizeObserver = class { observe() {} disconnect() {} }
    globalThis.cancelAnimationFrame = () => {}
    globalThis.requestAnimationFrame = () => 0
  })
  afterEach(() => {
    delete globalThis.window
    delete globalThis.ResizeObserver
    delete globalThis.cancelAnimationFrame
    delete globalThis.requestAnimationFrame
  })
  const places = [{ id: 'a', name: 'A', lat: 1.3, lng: 103.8, label: '1', category: 'eat' }]
  const rainMarkers = () => calls.markers.filter((m) => m.options.pane === 'rain')

  it('puts a patch under each rainy place, in a pane of its own between the tiles and the route', () => {
    mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }, { lat: 1.35, lng: 103.9 }], rainLabel: 'Rain likely' })
    const pane = calls.panes.find((p) => p.name === 'rain')
    // Leaflet's tile pane is 200, the route's overlay pane 400 and the marker pane 600.
    expect(pane.style.zIndex).toBeGreaterThan(200)
    expect(pane.style.zIndex).toBeLessThan(400)
    expect(rainMarkers()).toHaveLength(2)
    for (const marker of rainMarkers()) {
      expect(marker.options.interactive).toBe(false)
      expect(marker.options.keyboard).toBe(false)
      expect(marker.icon.html).toContain('class="rain-streak"')
      expect(marker.icon.html).toContain('rain-in')
    }
    // The other markers stay in Leaflet's own marker pane.
    expect(calls.markers.filter((m) => m.options.pane !== 'rain').length).toBeGreaterThan(0)
  })

  it('draws no rain without rainy places', () => {
    const page = mount(PlannerMap, { places })
    expect(calls.panes.some((p) => p.name === 'rain')).toBe(true)
    expect(rainMarkers()).toHaveLength(0)
    expect(page.all('span').some((s) => s.props['data-testid'] === 'rain-chip')).toBe(false)
  })

  it('shows the chip inside the map\'s region, so a screen reader reads it with the map', () => {
    const page = mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }], rainLabel: 'Rain likely · next 2 h', label: 'Itinerary map' })
    const region = page.all('div').find((d) => d.props.role === 'region')
    expect(page.attr(region, 'aria-label')).toBe('Itinerary map')
    expect(page.textOf(region)).toContain('Rain likely · next 2 h')
  })

  it('has no chip when rain is drawn but nothing is known about the forecast\'s source', () => {
    const page = mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }], rainLabel: '' })
    expect(rainMarkers()).toHaveLength(1)
    expect(page.all('span').some((s) => s.props['data-testid'] === 'rain-chip')).toBe(false)
  })

  it('sizes each patch for the zoom when a zoom ends, and does not fade it in again', () => {
    mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }] })
    const [marker] = rainMarkers()
    const first = marker.icon.iconSize[0]
    expect(first).toBe(419)
    calls.map.zoom.value = 12
    for (const fn of calls.handlers.zoomend) fn()
    expect(marker.resized).toBe(1)
    expect(marker.icon.iconSize[0]).toBeLessThan(first)
    expect(marker.icon.iconSize[0]).toBeGreaterThanOrEqual(170)
    expect(marker.icon.html).not.toContain('rain-in')
    // The same zoom again changes nothing.
    for (const fn of calls.handlers.zoomend) fn()
    expect(marker.resized).toBe(1)
  })

  it('scales each patch with the zoom glide, so it does not wait for the zoom to end', () => {
    mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }] })
    const [marker] = rainMarkers()
    const svg = { style: {} }
    marker.element = { firstElementChild: svg }
    expect(marker.icon.iconSize[0]).toBe(419)
    // A glide out to zoom 14 makes the patch half as wide.
    for (const fn of calls.handlers.zoomanim) fn({ zoom: 14, center: {} })
    expect(svg.style.transition).toContain('250ms')
    expect(Number(svg.style.transform.match(/scale\(([\d.]+)\)/)[1])).toBeCloseTo(0.5, 1)
    // The zoom ends: the patch is made at its size and the glide's transform is dropped with the old element.
    calls.map.zoom.value = 14
    for (const fn of calls.handlers.zoomend) fn()
    expect(marker.icon.iconSize[0]).toBe(209)
  })

  it('gives every rainy stop its own patch, at every zoom', () => {
    const stops = [{ lat: 1.3, lng: 103.8 }, { lat: 1.31, lng: 103.8 }, { lat: 1.32, lng: 103.8 }]
    mount(PlannerMap, { places, rain: stops })
    expect(rainMarkers().map((m) => m.latlng)).toEqual([[1.3, 103.8], [1.31, 103.8], [1.32, 103.8]])
    calls.map.zoom.value = 17
    for (const fn of calls.handlers.zoomend) fn()
    expect(rainMarkers()).toHaveLength(3)
    for (const marker of rainMarkers()) expect(marker.icon.iconSize[0]).toBe(480)
  })

  it('does not share an id between the patches of two maps', () => {
    mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }] })
    mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }] })
    const ids = rainMarkers().flatMap((m) => m.icon.html.match(/id="[^"]+"/g))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('leaves the tiles and the attribution as they were', () => {
    mount(PlannerMap, { places, rain: [{ lat: 1.3, lng: 103.8 }] })
    expect(calls.tiles).toHaveLength(1)
    expect(calls.tiles[0].url).toBe('https://www.onemap.gov.sg/maps/tiles/Default/{z}/{x}/{y}.png')
    expect(calls.tiles[0].options.attribution).toContain('OneMap')
    expect(calls.tiles[0].options.attribution).toContain('Singapore Land Authority')
  })
})

describe('where the rain is wired in', () => {
  const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8')

  // The itinerary's map and the full-screen map are checked by mounting them (weatherDayScreen.test.js); Home's page is too large to
  // mount here, so its template is checked for the pieces that decide what a screen reader hears.
  it('is on Home\'s map with its chip hidden from screen readers, because the line under the greeting says the same', () => {
    const home = read('../../views/LandingView.vue')
    expect(home).toContain(':rain="rain.view.value?.places || []"')
    expect(home).toMatch(/<div v-if="rainChip && rainChipFrame" class="hero__rain"[^>]*aria-hidden="true"><RainChip :text="rainChip"/)
    expect(home).toMatch(/<p class="home__rain-line caption" role="status">[^<]*<AppIcon name="rain" :size="16" \/>\{\{ rain\.view\.value\.text \}\}<\/p>/)
  })
})
