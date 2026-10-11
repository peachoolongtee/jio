// The frontend's call for the backend's address search: its request, its 6 second limit, and what a cancelled or failed
// request looks like to the caller.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PLACE_SEARCH_TIMEOUT_MS, api, searchAddresses } from '../plannerApi.js'

afterEach(() => vi.restoreAllMocks())

describe('searchAddresses', () => {
  it('asks GET /api/places/search with the text, a 6 second limit and the cancel signal, and returns the results', async () => {
    const results = [{ name: 'TAMPINES MALL', address: '4 TAMPINES CENTRAL 5', postal: '529510', lat: 1.3525, lng: 103.9447 }]
    const get = vi.spyOn(api, 'get').mockResolvedValue({ data: { results } })
    const controller = new AbortController()
    expect(await searchAddresses('tampines mall', { signal: controller.signal })).toBe(results)
    const [url, config] = get.mock.calls[0]
    expect(url).toBe('/api/places/search')
    expect(config.params).toEqual({ q: 'tampines mall' })
    expect(config.timeout).toBe(6000)
    expect(PLACE_SEARCH_TIMEOUT_MS).toBe(6000)
    expect(config.signal).toBe(controller.signal)
  })

  it('works without a signal', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { results: [] } })
    expect(await searchAddresses('520201')).toEqual([])
  })

  it('lets the client\'s error through when the backend cannot answer', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(new Error('Address search is not available right now. Try again soon.'))
    await expect(searchAddresses('bishan')).rejects.toThrow('Address search is not available right now. Try again soon.')
  })

  it('rejects with an AbortError, not the client\'s generic message, when the signal aborted the request', async () => {
    const controller = new AbortController()
    vi.spyOn(api, 'get').mockImplementation(async () => {
      controller.abort()
      throw new Error('Cannot reach the Jio planner right now. Check your connection and try again.')
    })
    await expect(searchAddresses('bishan', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })

  it('rejects an answer without a results list instead of reading it as no places', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { error: 'x' } })
    await expect(searchAddresses('bishan')).rejects.toThrow()
  })
})
