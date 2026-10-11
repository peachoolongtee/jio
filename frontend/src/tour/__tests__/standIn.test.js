// The stand-in planner as the tour keeps it on (tour/standIn.js, components/dev/offlinePlanner.js): it answers all five requests
// the screens make, only when the backend gave no answer of its own, gives up on a sleeping backend, leaves it alone for a
// while, and never hides the backend's own answer or error. Plus the flag that puts the tour in a build (lib/tourFlag.js) and
// the hook the lists read (lib/sessionFilter.js).
import axios from 'axios'
import { describe, expect, it } from 'vitest'
import { standInArrange, standInPlaces, standInSearch, useOfflinePlanner } from '../../components/dev/offlinePlanner.js'
import { tourMisconfigured } from '../../lib/tourFlag.js'
import { setSessionFilter, visibleSessions } from '../../lib/sessionFilter.js'
import { COOL_DOWN_MS, GIVE_UP_MS, standInOn, startStandIn, stopStandIn } from '../standIn.js'

const ok = (config, data = { real: true }) => ({ data, status: 200, statusText: 'OK', headers: {}, config })
const silent = () => Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })

// A client whose backend is `behave(config, calls)`, remembering what it was asked.
// How to call: const { client, calls } = backend((config) => { throw silent() })
function backend(behave) {
  const calls = []
  const client = axios.create({ baseURL: 'http://backend.test', timeout: 15000, adapter: async (config) => (calls.push(config), behave(config, calls.length)) })
  return { client, calls }
}

describe('the stand-in with the backend not answering', () => {
  it('answers each of the five requests, in the backend\'s shape', async () => {
    const { client } = backend(() => { throw silent() })
    useOfflinePlanner(client, { everything: true })
    const members = [{ id: 'a', start: { lat: 1.3, lng: 103.8 } }, { id: 'b', start: { lat: 1.35, lng: 103.9 } }]
    const centre = { lat: 1.3, lng: 103.85 }
    expect((await client.post('/api/meeting-area', { members })).data.area.id).toBeTruthy()
    expect((await client.post('/api/converge', { centre, dateTime: '2026-10-17T12:00', categories: ['eat'] })).data.status).toBe('ok')
    expect((await client.post('/api/search', { query: 'market', centre, dateTime: '2026-10-17T12:00', categories: ['eat'] })).data.results.length).toBeGreaterThan(0)
    expect((await client.post('/api/itinerary/arrange', { stops: [], includeCurrent: true })).data.status).toBe('ok')
    expect((await client.get('/api/places/search', { params: { q: 'junction 8' } })).data.results[0]).toMatchObject({ postal: '579837' })
  })

  it('leaves the showcase\'s default as it was: the two requests it needs, and no more', async () => {
    const { client } = backend(() => { throw silent() })
    useOfflinePlanner(client)
    await expect(client.post('/api/search', {})).rejects.toThrow()
    await expect(client.post('/api/itinerary/arrange', {})).rejects.toThrow()
    await expect(client.get('/api/places/search')).rejects.toThrow()
  })

  it('does not answer a request it has no stand-in for', async () => {
    const { client } = backend(() => { throw silent() })
    useOfflinePlanner(client, { everything: true })
    await expect(client.get('/api/weather')).rejects.toThrow()
  })

  it('counts a proxy\'s bare 5xx as no answer, and the backend\'s own error as an answer', async () => {
    const bare = backend((config) => { throw Object.assign(new Error('bad gateway'), { response: { status: 502, data: '<html>', config } }) })
    useOfflinePlanner(bare.client, { everything: true })
    await expect(bare.client.post('/api/search', { centre: { lat: 1.3, lng: 103.8 }, dateTime: '2026-10-17T12:00' })).resolves.toBeTruthy()
    const own = backend((config) => { throw Object.assign(new Error('bad request'), { response: { status: 400, data: { error: 'invalid_input' }, config } }) })
    useOfflinePlanner(own.client, { everything: true })
    await expect(own.client.post('/api/search', {})).rejects.toThrow('bad request')
  })

  it('uses the backend\'s answer when it gives one, and says which answered', async () => {
    const seen = []
    const { client } = backend((config) => ok(config, { area: { id: 'real' } }))
    useOfflinePlanner(client, { everything: true, onAnswer: (source) => seen.push(source) })
    expect((await client.post('/api/meeting-area', {})).data.area.id).toBe('real')
    expect(seen).toEqual(['backend'])
  })
})

describe('a backend that is asleep', () => {
  it('is waited for only so long, and then left alone for a while', async () => {
    let clock = 1_000_000
    const { client, calls } = backend(() => { throw silent() })
    useOfflinePlanner(client, { everything: true, giveUpMs: 8000, coolDownMs: 45000, now: () => clock })
    const body = { centre: { lat: 1.3, lng: 103.8 }, dateTime: '2026-10-17T12:00' }
    await client.post('/api/search', body)
    expect(calls).toHaveLength(1)
    // The wait was cut to the give-up time, below the client's own 15 seconds; a shorter timeout is kept.
    expect(calls[0].timeout).toBe(8000)
    await client.post('/api/search', body)
    await client.post('/api/converge', { ...body, categories: ['eat'] })
    expect(calls, 'not asked again during the cool-down').toHaveLength(1)
    clock += 45001
    await client.post('/api/search', body)
    expect(calls, 'asked again after it').toHaveLength(2)
    await client.post('/api/search', body, { timeout: 3000 })
    expect(calls).toHaveLength(2)
  })

  it('is asked again at once when it answered, and keeps a shorter timeout', async () => {
    const { client, calls } = backend((config) => ok(config))
    useOfflinePlanner(client, { everything: true, giveUpMs: 8000, coolDownMs: 45000 })
    await client.post('/api/converge', {}, { timeout: 3000 })
    await client.post('/api/converge', {})
    expect(calls.map((c) => c.timeout)).toEqual([3000, 8000])
  })

  it('never asks a backend that does not exist', async () => {
    const { client, calls } = backend((config) => ok(config))
    useOfflinePlanner(client, { everything: true, backend: false })
    const { data } = await client.post('/api/search', { centre: { lat: 1.3, lng: 103.8 }, dateTime: '2026-10-17T12:00' })
    expect(data.results.length).toBeGreaterThan(0)
    expect(calls).toHaveLength(0)
  })

  it('is taken off without taking something put on top of it off too', async () => {
    const { client, calls } = backend((config) => ok(config))
    const first = useOfflinePlanner(client, { everything: true, backend: false })
    const second = useOfflinePlanner(client)
    const top = client.defaults.adapter
    first.restore()
    expect(client.defaults.adapter).toBe(top)
    // The first no longer answers: the request goes through to the backend.
    await client.post('/api/search', {})
    expect(calls).toHaveLength(1)
    second.restore()
  })
})

describe('what each answer is', () => {
  const centre = { lat: 1.3, lng: 103.85 }

  it('finds places by words in the name, lists the ones that are not open and says so', () => {
    const open = standInSearch({ query: 'market', categories: ['eat'], centre, dateTime: '2026-10-17T12:00', durationMinutes: 60 }).results
    expect(open.length).toBeGreaterThan(0)
    expect(open.every((r) => r.category === 'eat' && r.name.toLowerCase().includes('market'))).toBe(true)
    expect(open.every((r) => r.unfit.length === 0 && Number.isFinite(r.walkMinutes))).toBe(true)
    const night = standInSearch({ query: 'market', categories: ['eat'], centre, dateTime: '2026-10-17T03:00', durationMinutes: 60 }).results
    expect(night.every((r) => r.unfit.length === 1)).toBe(true)
  })

  it('keeps the voted order, one stop after another, and has no other order to offer', () => {
    const stops = [{ id: 'eat', duration: 90, start: 720 }, { id: 'shop', duration: 60, start: 700 }]
    const answer = standInArrange({ stops, startAt: 720, includeCurrent: true })
    expect(answer.order).toEqual(['eat', 'shop'])
    expect(answer.stops).toEqual([{ id: 'eat', start: 720, end: 810 }, { id: 'shop', start: 810, end: 870 }])
    expect(standInArrange({ stops, startAt: 720 }).status).toBe('no_other_order')
  })

  it('answers addresses from the sample list, and none for nothing typed', () => {
    expect(standInPlaces({ q: 'bugis' }).results.map((r) => r.postal)).toEqual(['188021'])
    expect(standInPlaces({ q: '' }).results).toEqual([])
    expect(standInPlaces({ q: '529510' }).results[0].name).toBe('TAMPINES MALL')
  })
})

describe('starting and stopping it for the tour', () => {
  it('is one stand-in however many times it is started, and off after it is stopped', () => {
    const { client } = backend((config) => ok(config))
    expect(standInOn()).toBe(false)
    const a = startStandIn(client, () => {})
    expect(startStandIn(client, () => {})).toBe(a)
    expect(standInOn()).toBe(true)
    stopStandIn()
    expect(standInOn()).toBe(false)
    stopStandIn()
  })

  it('lets a build with no backend address through the client\'s own guard, and puts the address back', () => {
    const client = axios.create({ adapter: async (config) => ok(config) })
    startStandIn(client, () => {}, { backend: false })
    expect(client.defaults.baseURL).toBe('http://planner.invalid')
    stopStandIn()
    expect(client.defaults.baseURL).toBeUndefined()
  })

  it('gives up on a sleeping backend after eight seconds and waits 45 seconds before asking again', () => {
    expect(GIVE_UP_MS).toBe(8000)
    expect(COOL_DOWN_MS).toBe(45000)
  })
})

describe('the flag', () => {
  it('needs local accounts: a build with the tour and without them must refuse to start', () => {
    expect(tourMisconfigured({ DEV: false, VITE_DEMO_TOUR: '1' })).toBe(true)
    expect(tourMisconfigured({ DEV: false, VITE_DEMO_TOUR: '1', VITE_ALLOW_LOCAL_ACCOUNTS: '1' })).toBe(false)
  })
  it('does not care about local accounts in a build without the tour, or in development', () => {
    expect(tourMisconfigured({ DEV: false })).toBe(false)
    expect(tourMisconfigured({ DEV: false, VITE_DEMO_TOUR: '' })).toBe(false)
    expect(tourMisconfigured({ DEV: false, VITE_DEMO_TOUR: '0' })).toBe(false)
    expect(tourMisconfigured({ DEV: true })).toBe(false)
  })
})

describe('the lists\' hook', () => {
  it('hands the sessions back as they are until a filter is installed', () => {
    const sessions = [{ id: 's1' }, { id: 's2' }]
    expect(visibleSessions(sessions)).toBe(sessions)
    setSessionFilter((list) => list.filter((s) => s.id === 's2'))
    expect(visibleSessions(sessions)).toEqual([{ id: 's2' }])
    setSessionFilter(null)
    expect(visibleSessions(sessions)).toBe(sessions)
  })
})
