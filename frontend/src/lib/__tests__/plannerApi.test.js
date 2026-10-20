// The frontend's side of the planner: what an error says, and what a ranking request carries.
import { AxiosError } from 'axios'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, lastWeather, meetingArea, plannerErrorMessage, rankSlot, toCardVenue } from '../plannerApi.js'

const HUB = { lat: 1.35, lng: 103.85 }
const SLOT = { start: 900, time: '15:00', duration: 90, category: 'eat' }
const ASK = { members: [], centre: HUB, date: '2026-10-10', slot: SLOT, lastStop: false }
const answer = (extra = {}) => ({ data: { status: 'ok', results: [], current: [], weather: { source: 'live' }, ...extra } })

afterEach(() => vi.restoreAllMocks())

describe('plannerErrorMessage', () => {
  it('tells the person to wait after a 429, in any build', () => {
    const err = { response: { status: 429, data: { error: 'rate_limited', message: 'Too many requests. Try again shortly.' } } }
    for (const dev of [true, false]) expect(plannerErrorMessage(err, { dev })).toBe('Too many requests. Wait a few seconds and try again.')
  })

  it('names the command and the variable only in development when the planner cannot be reached', () => {
    const dev = plannerErrorMessage({}, { dev: true, baseURL: 'http://localhost:3000' })
    expect(dev).toContain('pnpm dev:backend')
    expect(dev).toContain('FRONTEND_ORIGIN')
    expect(dev).toContain('http://localhost:3000')
    const prod = plannerErrorMessage({}, { dev: false, baseURL: 'http://localhost:3000' })
    expect(prod).toBe('Cannot reach the Jio planner right now. Check your connection and try again.')
    expect(prod).not.toMatch(/pnpm|FRONTEND_ORIGIN|localhost/)
  })

  it('shows request details only in development', () => {
    const err = { response: { status: 400, data: { issues: [{ path: 'members.0.start', message: 'required' }] } } }
    expect(plannerErrorMessage(err, { dev: true })).toBe('The planner could not use this request (members.0.start: required).')
    expect(plannerErrorMessage(err, { dev: false })).toBe('The planner could not use this request. Try again.')
  })

  it('uses the server message, and hides a route name in production', () => {
    const server = { response: { status: 500, data: { message: 'Something went wrong on the server.' } } }
    expect(plannerErrorMessage(server, { dev: false })).toBe('Something went wrong on the server.')
    const missing = { response: { status: 404, data: { message: 'There is no POST /api/x here.' } } }
    expect(plannerErrorMessage(missing, { dev: true })).toBe('There is no POST /api/x here.')
    expect(plannerErrorMessage(missing, { dev: false })).toBe('The planner had a problem. Try again.')
    expect(plannerErrorMessage({ response: { status: 502, data: {} } }, { dev: false })).toBe('The planner had a problem. Try again.')
  })
})

describe('plannerErrorMessage: slow, unreachable and refused', () => {
  const timeout = { code: 'ECONNABORTED', message: 'timeout of 15000ms exceeded' }
  const SLOW = 'The Jio planner is taking too long to answer. Try again in a moment.'
  const DOWN = 'Cannot reach the Jio planner right now. Check your connection and try again.'

  it('says a request that ran out of time is slow, not unreachable, in any build', () => {
    expect(plannerErrorMessage(timeout, { dev: false })).toBe(SLOW)
    expect(plannerErrorMessage({ ...timeout, code: 'ETIMEDOUT' }, { dev: false })).toBe(SLOW)
    expect(plannerErrorMessage(timeout, { dev: false })).not.toBe(plannerErrorMessage({}, { dev: false }))
  })

  it('adds the request detail to a timeout only in development', () => {
    expect(plannerErrorMessage(timeout, { dev: true })).toBe(`${SLOW} (timeout of 15000ms exceeded)`)
    expect(plannerErrorMessage(timeout, { dev: false })).not.toContain('15000')
  })

  it('still says unreachable when no answer came and it was not a timeout', () => {
    expect(plannerErrorMessage({ code: 'ERR_NETWORK', message: 'Network Error' }, { dev: false })).toBe(DOWN)
    expect(plannerErrorMessage(undefined, { dev: false })).toBe(DOWN)
  })

  it('says a refused request with no reason is a request the planner could not use, not a planner failure', () => {
    for (const status of [400, 422]) {
      expect(plannerErrorMessage({ response: { status, data: {} } }, { dev: false })).toBe('The planner could not use this request. Try again.')
    }
    expect(plannerErrorMessage({ response: { status: 500, data: {} } }, { dev: false })).toBe('The planner had a problem. Try again.')
    expect(plannerErrorMessage({ response: { status: 400, data: { message: 'Pick a date first.' } } }, { dev: false })).toBe('Pick a date first.')
  })

  it('reaches the screens as the Error message when the real client times out, and when nothing answers', async () => {
    const adapter = api.defaults.adapter
    try {
      api.defaults.adapter = async (config) => {
        throw new AxiosError('timeout of 15000ms exceeded', 'ECONNABORTED', config)
      }
      const slow = await meetingArea({ members: [] }).catch((e) => e)
      expect(slow.message).toContain('taking too long to answer')
      api.defaults.adapter = async (config) => {
        throw new AxiosError('Network Error', 'ERR_NETWORK', config)
      }
      const down = await meetingArea({ members: [] }).catch((e) => e)
      expect(down.message).toContain('Cannot reach the Jio planner')
      expect(down.message).not.toBe(slow.message)
    } finally {
      api.defaults.adapter = adapter
    }
  })
})

describe('rankSlot', () => {
  it('sends no weather case unless the rain switch is on', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(answer())
    await rankSlot({ ...ASK, conditions: { rain: false } })
    await rankSlot({ ...ASK })
    for (const [, body] of post.mock.calls) expect(body).not.toHaveProperty('weatherCase')
    await rankSlot({ ...ASK, conditions: { rain: true } })
    expect(post.mock.calls[2][1].weatherCase).toBe('rain')
  })

  it('never sends crowd weights', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue(answer())
    await rankSlot({ ...ASK, conditions: { rain: true, crowd: true } })
    expect(post.mock.calls[0][1]).not.toHaveProperty('weights')
  })

  it('passes the weather through, and remembers the last answer', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce(answer({ weather: { source: 'live', simulationIgnored: true } }))
    const result = await rankSlot({ ...ASK, conditions: { rain: true } })
    expect(result.weather).toEqual({ source: 'live', simulationIgnored: true })
    expect(lastWeather.value.simulationIgnored).toBe(true)
    vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { status: 'empty', reason: 'none', weather: { source: 'unavailable' } } })
    const empty = await rankSlot({ ...ASK })
    expect(empty.weather).toEqual({ source: 'unavailable' })
    expect(lastWeather.value).toEqual({ source: 'unavailable' })
  })

  it('gives options no crowd field', async () => {
    const venue = { id: 'v', name: 'V', category: 'eat', avgPricePerPerson: 8, setting: 'indoor', rating: 4.2 }
    vi.spyOn(api, 'post').mockResolvedValue(answer({ results: [{ venue, rank: 1, score: 3, walkMinutes: 4, crowd: 'busy', reasons: [], warnings: [] }] }))
    const { options } = await rankSlot({ ...ASK })
    expect(options[0]).not.toHaveProperty('crowd')
    expect(options[0].venue.rating).toBeCloseTo(8.4)
  })
})

describe('meetingArea', () => {
  const members = [{ id: 'ian', name: 'Ian', start: HUB, end: HUB }]

  it('posts exactly the body it always did when asked without the new arguments', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: {} })
    await meetingArea({ members })
    await meetingArea({ members, routing: false })
    await meetingArea({ members, alternatives: undefined, include: [] })
    expect(post.mock.calls[0]).toEqual(['/api/meeting-area', { members, method: 'station' }])
    expect(post.mock.calls[1]).toEqual(['/api/meeting-area', { members, method: 'centroid' }])
    // An empty include is the same as none.
    expect(post.mock.calls[2]).toEqual(['/api/meeting-area', { members, method: 'station' }])
    expect(Object.keys(post.mock.calls[0][1])).toEqual(['members', 'method'])
  })

  it('adds the runners-up and the areas to include only when asked', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { candidates: [] } })
    await meetingArea({ members, alternatives: 2, include: ['bugis', 'novena'] })
    await meetingArea({ members, include: ['bugis'] })
    await meetingArea({ members, alternatives: 0 })
    expect(post.mock.calls[0][1]).toEqual({ members, method: 'station', alternatives: 2, include: ['bugis', 'novena'] })
    expect(post.mock.calls[1][1]).toEqual({ members, method: 'station', include: ['bugis'] })
    expect(post.mock.calls[2][1]).toEqual({ members, method: 'station', alternatives: 0 })
  })

  it('answers what the backend answers, candidates included', async () => {
    const data = { area: { id: 'bugis' }, candidates: [{ area: { id: 'bugis' }, source: 'ranked' }] }
    vi.spyOn(api, 'post').mockResolvedValue({ data })
    expect(await meetingArea({ members, alternatives: 2 })).toBe(data)
  })
})

describe('toCardVenue', () => {
  it('maps the backend fields to what the cards read', () => {
    const v = toCardVenue({ id: 'v', avgPricePerPerson: 12, setting: 'outdoor', nearestMrt: 'Bishan', mrtWalkMinutes: 5, rating: null, openingHours: [['09:00', '17:00']], cdcAccepted: true })
    expect(v).toMatchObject({ price: 12, indoor: false, mrt: 'Bishan', mrtWalk: 5, rating: null, hours: ['09:00-17:00'], tags: ['cdc'] })
  })
})
