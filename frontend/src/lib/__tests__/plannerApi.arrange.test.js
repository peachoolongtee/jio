// The frontend's call for a suggested order: it posts what the route expects and gives up on a slow answer after
// 10 seconds, so the Confirm dialog is never kept waiting by it.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { ARRANGE_TIMEOUT_MS, api, arrangeItinerary } from '../plannerApi.js'

afterEach(() => vi.restoreAllMocks())

describe('arrangeItinerary', () => {
  it('posts the stops and the times with a 10 second timeout, and returns the answer', async () => {
    const answer = { status: 'ok', order: ['a'], stops: [], reason: 'x', source: 'rules' }
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: answer })
    const stops = [{ id: 'a', name: 'A', category: 'eat', lat: 1.3, lng: 103.8, duration: 60, hours: [] }]
    expect(await arrangeItinerary({ stops, startAt: 600, endAt: 1020, includeCurrent: true })).toBe(answer)
    const [url, body, config] = post.mock.calls[0]
    expect(url).toBe('/api/itinerary/arrange')
    expect(body).toEqual({ stops, startAt: 600, endAt: 1020, shown: [], rain: false, includeCurrent: true })
    expect(config.timeout).toBe(10000)
    expect(ARRANGE_TIMEOUT_MS).toBe(10000)
  })

  it('lets the failure through, for the store to treat as no suggestion', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(Object.assign(new Error('timeout of 10000ms exceeded'), { code: 'ECONNABORTED' }))
    await expect(arrangeItinerary({ stops: [], startAt: 600, endAt: 1020 })).rejects.toThrow('timeout of 10000ms exceeded')
  })
})
