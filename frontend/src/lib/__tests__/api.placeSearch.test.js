// searchPlaces in the data layer, with the backend's address search stood in for: the areas first and at once, the
// backend's results turned into rows with the nearest area, the 8 row cap, no call for a short query, the fallback when
// the backend is down, cancellation, and that a stored location gains nothing but the area and its own label.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadApi, stubPlanner, tomorrow } from './planFixture.js'
import { toSpotRows } from '../placeSearch.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn(), searchAddresses: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)

// Where OneMap puts them (real coordinates, rounded).
const TAMPINES_MALL = { name: 'TAMPINES MALL', address: '4 TAMPINES CENTRAL 5 TAMPINES MALL SINGAPORE 529510', postal: '529510', lat: 1.3525, lng: 103.9447 }
const TAMPINES_HUB = { name: 'OUR TAMPINES HUB', address: '1 TAMPINES WALK SINGAPORE 528523', postal: '528523', lat: 1.3532, lng: 103.9402 }
const TAMPINES_AVE = { name: 'TAMPINES AVENUE 5', address: 'TAMPINES AVENUE 5', postal: null, lat: 1.3731, lng: 103.9477 }
const BISHAN_MRT = { name: 'BISHAN MRT STATION', address: '200 BISHAN ROAD', postal: '579827', lat: 1.3509, lng: 103.8485 }
const BISHAN_PARK = { name: 'BISHAN-ANG MO KIO PARK', address: '1 BISHAN PARK', postal: '569843', lat: 1.3626, lng: 103.8447 }

let api
beforeEach(async () => {
  stubPlanner(planner)
  planner.searchAddresses.mockReset().mockResolvedValue([])
  api = await loadApi()
})

const labels = (out) => out.places.map((p) => p.label)

describe('searchPlaces', () => {
  it('lists the areas that match first, and hands them over before the backend has answered', async () => {
    let release
    planner.searchAddresses.mockReturnValue(new Promise((resolve) => { release = resolve }))
    const early = []
    const pending = api.searchPlaces('bishan', { onBuiltIn: (rows) => early.push(...rows.map((r) => r.label)) })
    await Promise.resolve()
    expect(early).toEqual(['Bishan'])
    release([BISHAN_PARK])
    const out = await pending
    expect(labels(out)).toEqual(['Bishan', 'Bishan-Ang Mo Kio Park'])
    expect(out.unavailable).toBe(false)
  })

  it('still finds a built-in area with the backend off', async () => {
    planner.searchAddresses.mockRejectedValue(new Error('Cannot reach the Jio planner right now.'))
    const out = await api.searchPlaces('bishan')
    expect(out.places[0]).toMatchObject({ label: 'Bishan', areaId: 'bishan', sub: 'MRT station and area' })
    expect(out.unavailable).toBe(true)
  })

  it('turns a backend result into a row: the building, its postal code and area, and the nearest area', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL, BISHAN_MRT])
    const out = await api.searchPlaces('tampines mall')
    expect(planner.searchAddresses).toHaveBeenCalledWith('tampines mall', { signal: undefined })
    expect(out.places[0]).toMatchObject({ label: 'Tampines Mall', sub: 'Singapore 529510 · Tampines', areaId: 'tampines', areaName: 'Tampines' })
    expect(out.places[1]).toMatchObject({ label: 'Bishan MRT Station', areaId: 'bishan' })
  })

  it('uses the rule behind "Use current location" to choose the area', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_HUB, BISHAN_PARK])
    const out = await api.searchPlaces('hub')
    for (const [row, result] of out.places.map((p, i) => [p, [TAMPINES_HUB, BISHAN_PARK][i]])) {
      expect(row.areaId).toBe((await api.placeFromCoords(result.lat, result.lng)).areaId)
    }
  })

  it('leaves out the coordinates and the full address', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL])
    const text = JSON.stringify(await api.searchPlaces('tampines mall'))
    expect(text).not.toMatch(/1\.3525|103\.9447|lat|lng|CENTRAL 5/)
  })

  it('drops a backend result that repeats a built-in area, however the station is spelt', async () => {
    planner.searchAddresses.mockResolvedValue([{ ...BISHAN_MRT, name: 'BISHAN' }, BISHAN_MRT, BISHAN_PARK])
    const out = await api.searchPlaces('bishan')
    expect(labels(out)).toEqual(['Bishan', 'Bishan-Ang Mo Kio Park'])
  })

  it('drops results that repeat each other, have no name, or are not in Singapore', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL, { ...TAMPINES_MALL }, { ...TAMPINES_MALL, name: '' }, { ...TAMPINES_HUB, lat: 3.1, lng: 101.7 }, { ...TAMPINES_HUB, lat: null }])
    expect(labels(await api.searchPlaces('mall'))).toEqual(['Tampines Mall'])
  })

  it('returns at most 8 rows, the areas ahead of the addresses', async () => {
    const many = Array.from({ length: 10 }, (_, i) => ({ ...TAMPINES_MALL, name: `TAMPINES PLACE ${i}`, postal: `52950${i}` }))
    planner.searchAddresses.mockResolvedValue(many)
    const out = await api.searchPlaces('tampines')
    expect(out.places).toHaveLength(8)
    expect(out.places[0].label).toBe('Tampines')
    expect(out.places[1].label).toBe('Tampines Place 0')
    expect(new Set(out.places.map((p) => p.id)).size).toBe(8)
  })

  it('makes no call for a query under 2 characters, an empty one, or one the backend would refuse as too long', async () => {
    expect((await api.searchPlaces('')).places).toEqual([])
    expect((await api.searchPlaces('   ')).places).toEqual([])
    const one = await api.searchPlaces(' b ')
    expect(one.unavailable).toBe(false)
    expect(one.places.length).toBeGreaterThan(0)
    const long = await api.searchPlaces('x'.repeat(81))
    expect(long).toEqual({ places: [], unavailable: false })
    expect(planner.searchAddresses).not.toHaveBeenCalled()
  })

  it('sends a 6 digit postal code, trimmed', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL])
    expect(labels(await api.searchPlaces(' 529510 '))).toEqual(['Tampines Mall'])
    expect(planner.searchAddresses).toHaveBeenCalledWith('529510', { signal: undefined })
  })

  it('lists the sample addresses only when the backend gave nothing', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_HUB])
    expect(labels(await api.searchPlaces('tampines'))).toEqual(['Tampines', 'Our Tampines Hub'])
    planner.searchAddresses.mockResolvedValue([])
    const none = await api.searchPlaces('tampines mall')
    expect(none.unavailable).toBe(false)
    expect(labels(none)).toEqual(['Tampines Mall, 4 Tampines Central 5'])
    expect(none.places[0].sub).toBe('Singapore 529510 · Tampines')
  })

  it('falls back to the areas and the sample addresses, flagged, when the backend is down or answers an error', async () => {
    for (const failure of [new Error('Address search is not available right now. Try again soon.'), new Error('Too many requests. Wait a few seconds and try again.')]) {
      planner.searchAddresses.mockRejectedValue(failure)
      const out = await api.searchPlaces('tampines mall')
      expect(out.unavailable).toBe(true)
      expect(labels(out)).toEqual(['Tampines Mall, 4 Tampines Central 5'])
    }
  })

  it('does not remember a failure, but does remember an answer', async () => {
    planner.searchAddresses.mockRejectedValueOnce(new Error('down')).mockResolvedValue([TAMPINES_MALL])
    expect((await api.searchPlaces('mall')).unavailable).toBe(true)
    expect((await api.searchPlaces('mall')).unavailable).toBe(false)
    await api.searchPlaces('MALL ')
    expect(planner.searchAddresses).toHaveBeenCalledTimes(2)
  })
})

describe('a cancelled search', () => {
  it('rejects with an AbortError and asks nothing when it was cancelled before it began', async () => {
    const controller = new AbortController()
    controller.abort()
    await expect(api.searchPlaces('bishan', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
    expect(planner.searchAddresses).not.toHaveBeenCalled()
  })

  it('rejects with an AbortError when cancelled while the backend works, and does not say the backend is down', async () => {
    const controller = new AbortController()
    planner.searchAddresses.mockImplementation((q, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(Object.assign(new Error('The search was cancelled.'), { name: 'AbortError' })))
    }))
    const pending = api.searchPlaces('tampines', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('never resolves with rows after being cancelled, even when the backend answers anyway (the answer that came is kept for next time)', async () => {
    const controller = new AbortController()
    let release
    planner.searchAddresses.mockReturnValueOnce(new Promise((resolve) => { release = resolve }))
    const pending = api.searchPlaces('tampines mall', { signal: controller.signal })
    controller.abort()
    release([TAMPINES_MALL])
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(labels(await api.searchPlaces('tampines mall'))).toEqual(['Tampines Mall'])
    expect(planner.searchAddresses).toHaveBeenCalledTimes(1)
  })
})

describe('one row per area, for "Suggest a spot"', () => {
  it('shows the area with the place searched, and each area once', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL, TAMPINES_HUB, TAMPINES_AVE])
    const rows = toSpotRows((await api.searchPlaces('tampines')).places)
    expect(rows).toEqual([
      { id: 'spot-tampines', label: 'Tampines', sub: 'MRT station and area', areaId: 'tampines' },
      { id: 'spot-pasir-ris', label: 'Pasir Ris', sub: 'Near Tampines Avenue 5', areaId: 'pasir-ris' },
    ])
  })

  it('names the place searched when no area row is ahead of it', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL, TAMPINES_HUB])
    expect(toSpotRows((await api.searchPlaces('mall')).places)).toEqual([
      { id: 'spot-tampines', label: 'Tampines', sub: 'Near Tampines Mall', areaId: 'tampines' },
    ])
  })
})

describe('placeFromCoords', () => {
  it('still names the nearest area, and nothing outside Singapore', async () => {
    expect(await api.placeFromCoords(1.3525, 103.9447)).toEqual({ id: 'here-tampines', label: 'Current location', sub: 'Tampines', areaId: 'tampines' })
    expect(await api.placeFromCoords(0, 0)).toBeNull()
  })
})

describe('what a stored location carries', () => {
  const PROFILE = { email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' }

  async function startedSession() {
    await api.signUp(PROFILE)
    const { id } = await api.createSession({ title: 'Saturday', date: tomorrow(), start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['jonathan'])
    await api.startSession(id)
    return id
  }

  it('is the area and the label, and nothing else of the row or the result', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL])
    const id = await startedSession()
    const [row] = (await api.searchPlaces('tampines mall')).places
    await api.setLocation(id, 'ian', 'start', { ...row, lat: TAMPINES_MALL.lat, lng: TAMPINES_MALL.lng, postal: '529510' })
    const saved = JSON.parse(api.storage.store['jio-demo-v1'])
    const stored = saved.sessions.find((s) => s.id === id).locations.ian
    expect(stored).toEqual({ start: { areaId: 'tampines', label: 'Tampines Mall' }, end: null })
    expect(api.storage.store['jio-demo-v1']).not.toMatch(/529510|103\.9447|1\.3525|Singapore 5/)
  })

  it('shows the label to its owner only: another member\'s label is in no answer, and nobody sees a point inside the area', async () => {
    planner.searchAddresses.mockResolvedValue([TAMPINES_MALL])
    const id = await startedSession()
    await api.setLocation(id, 'jonathan', 'start', { areaId: 'tampines', label: 'Jonathan\'s secret flat' })
    await api.setLocation(id, 'ian', 'start', { areaId: 'tampines', label: 'Tampines Mall' })
    const session = await api.getSession(id)
    expect(JSON.stringify(session)).not.toContain('secret flat')
    expect(session.locations.jonathan.start).toEqual({ areaId: 'tampines', name: 'Tampines', lat: expect.any(Number), lng: expect.any(Number) })
    const area = (await api.listAreas()).find((a) => a.id === 'tampines')
    expect(session.locations.jonathan.start).toMatchObject({ lat: area.lat, lng: area.lng })
    expect(session.locations.ian.start.label).toBe('Tampines Mall')
    expect(JSON.stringify(session)).not.toMatch(/103\.9447|1\.3525/)
  })
})
