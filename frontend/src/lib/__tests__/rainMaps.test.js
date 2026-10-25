// The rain on the maps ("Layered drops"): the words on the chip for each source of forecast, the rainy places of an itinerary,
// the markup of one patch, the chip as a component, and the session map (PlannerMap, with Leaflet stood in for, since the suite has
// no browser) putting the rain in a pane of its own under the route and the markers, resizing it with the zoom, and leaving the
// tiles and the attribution alone. The look itself is checked by eye in a browser (see the report for this change).
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount } from './miniDom.js'
import RainChip from '../../components/weather/RainChip.vue'
import { itineraryRain, rainChipText, rainPatchSvg, rainSpots } from '../rainLook.js'
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
      const marker = { latlng, options, icon: options.icon, addTo: (g) => { g?.layers.push(marker); return marker }, setIcon: (icon) => { marker.icon = icon; marker.options.icon = icon; marker.resized = (marker.resized || 0) + 1 }, getLatLng: () => ({ lat: latlng[0], lng: latlng[1] }), bindTooltip: () => marker, on: () => marker, getElement: () => null }
      calls.markers.push(marker)
      return marker
    },
  }
  return { default: L }
})
vi.mock('../../components/map/retireMap.js', () => ({ retireMap: vi.fn() }))

const { default: PlannerMap } = await import('../../components/map/PlannerMap.vue')

const live = { source: 'live', basis: 'area', issuedAt: '2026-10-26T05:30:00+08:00' }

describe('the words on the rain chip', () => {
  it('names the two hours only for the live two-hour forecast', () => {
    expect(rainChipText(live)).toBe('Rain likely · next 2 h')
  })

  it('makes no claim about two hours for the live 24-hour or mixed forecast', () => {
    expect(rainChipText({ ...live, basis: 'regional' })).toBe('Rain likely')
    expect(rainChipText({ ...live, basis: 'mixed' })).toBe('Rain likely')
  })

  it('says the rain is simulated when it is the demo\'s', () => {
    expect(rainChipText({ source: 'simulated', basis: 'simulated' })).toBe('Simulated rain')
  })

  it('leaves the chip out when nothing is known about where the forecast came from', () => {
    expect(rainChipText({ source: 'unavailable', reason: 'unavailable' })).toBe('')
    expect(rainChipText({ source: 'none', reason: 'outside_window' })).toBe('')
    expect(rainChipText(null)).toBe('')
    expect(rainChipText(undefined)).toBe('')
  })

  it('reads Home\'s answer: the block of the planner\'s reply decides the words', () => {
    const outing = { area: { id: 'bishan', name: 'Bishan', lat: 1.35, lng: 103.85 } }
    const answer = (weather) => ({ stops: { bishan: { rainLikely: true } }, weather })
    expect(rainChipText(rainView([outing], answer(live)).block)).toBe('Rain likely · next 2 h')
    expect(rainChipText(rainView([outing], answer({ source: 'simulated' })).block)).toBe('Simulated rain')
    expect(rainChipText(rainView([outing], answer(undefined)).block)).toBe('')
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
  const stops = [stop('a', 1.3, 103.8), stop('b', 1.3001, 103.8001), stop('c', 1.35, 103.9), stop('d', 1.4, 103.7)]

  it('is a patch for each stop where rain is likely, with stops in one area made one', () => {
    const weather = { a: { rainLikely: true, source: 'live' }, b: { rainLikely: true, source: 'live' }, c: { rainLikely: true, source: 'live' }, d: { rainLikely: false, source: 'live' } }
    const rain = itineraryRain(stops, (s) => weather[s.slotId], live)
    expect(rain.places).toEqual([{ lat: 1.3, lng: 103.8 }, { lat: 1.35, lng: 103.9 }])
    expect(rain.text).toBe('Rain likely · next 2 h')
  })

  it('draws nothing for a forecast that is not live or simulated, or for a stop with no weather', () => {
    const weather = { a: { rainLikely: true, source: 'none' }, b: { rainLikely: true, source: 'unavailable' }, c: undefined, d: { rainLikely: true } }
    expect(itineraryRain(stops, (s) => weather[s.slotId], null)).toEqual({ places: [], text: '' })
    expect(itineraryRain(undefined, () => null, null)).toEqual({ places: [], text: '' })
  })

  it('says "Simulated rain" for the demo\'s forecast', () => {
    const rain = itineraryRain([stop('a', 1.3, 103.8)], () => ({ rainLikely: true, source: 'simulated' }), { source: 'simulated', basis: 'simulated' })
    expect(rain.places).toHaveLength(1)
    expect(rain.text).toBe('Simulated rain')
  })

  it('keeps places more than 1.2 km apart and skips points that are not places', () => {
    expect(rainSpots([{ lat: 1.3, lng: 103.8 }, { lat: 1.3, lng: 103.8115 }])).toHaveLength(2)
    expect(rainSpots([{ lat: 1.3, lng: 103.8 }, { lat: 1.3, lng: 103.8095 }])).toHaveLength(1)
    expect(rainSpots([{ lat: NaN, lng: 1 }, null, undefined, {}])).toEqual([])
  })
})

describe('one patch of rain as markup', () => {
  const svg = rainPatchSvg({ size: 240, uid: 'u1', fade: true })

  it('has a feathered wash, a feathered mask and three layers of drops, each on a pattern of its own', () => {
    expect(svg).toContain('<radialGradient id="u1-wash">')
    expect(svg).toContain('<mask id="u1-mask"')
    for (const name of ['far', 'mid', 'near']) {
      expect(svg).toContain(`<pattern id="u1-${name}"`)
      expect(svg).toContain(`class="rain-fall rain-fall--${name}"`)
    }
    expect(svg.match(/<rect /g)).toHaveLength(3)
    // The drops stay inside the wash, so they fade out before the tint does.
    expect(svg).toContain('r="110" fill="url(#u1-feather)"')
    expect(svg).toContain('r="120" fill="url(#u1-wash)"')
  })

  it('is hidden from screen readers, and fades in only when asked', () => {
    expect(svg).toContain('aria-hidden="true"')
    expect(svg).toContain('class="rain-patch rain-in"')
    expect(rainPatchSvg({ size: 240, uid: 'u2' })).toContain('class="rain-patch"')
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
      expect(marker.icon.html).toContain('rain-fall--near')
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
    expect(first).toBe(480)
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

  it('is on the itinerary\'s map and the full-screen map, from the stops\' weather', () => {
    for (const file of ['../../views/EventView.vue', '../../views/SessionMapView.vue']) {
      const source = read(file)
      expect(source, file).toMatch(/<PlannerMap[^>]*:rain="[\w.]+\.places"[^>]*:rain-label="[\w.]+\.text"/)
      expect(source, file).toContain("import { itineraryRain } from '@/lib/rainLook.js'")
    }
  })

  it('is on Home\'s map with its chip, hidden from screen readers because the line under the greeting says the same', () => {
    const home = read('../../views/LandingView.vue')
    expect(home).toContain(':rain="rain.view.value?.places || []"')
    expect(home).toMatch(/<RainChip v-if="rainChip" :text="rainChip" class="hero__rain-chip" aria-hidden="true" \/>/)
    expect(home).toContain('role="status"')
  })
})
