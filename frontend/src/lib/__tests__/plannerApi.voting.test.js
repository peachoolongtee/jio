// The frontend's calls to the Jio server's voting routes of stage 4 (E3 to E9, E17 and E18 of the sessions design): each one's method,
// path and body, that ids are put in the path safely, the wait it allows, what it hands back, and that a refusal reaches the caller with
// the server's own code. The planner client's own adapter stands in for the server. No network.
import { afterEach, describe, expect, it } from 'vitest'
import {
  SESSION_TIMEOUT_MS,
  VENUES_PER_REQUEST,
  addSessionOption,
  api,
  deleteSessionSlot,
  moreSessionOptions,
  putSessionRadius,
  restoreSessionSlots,
  searchSessionSlot,
  swapSessionOption,
  syncSessionPlan,
  toSearchResult,
  venuesByIds,
} from '../plannerApi.js'

const ID = '3b1f5c2a-9d4e-4f6a-8b7c-1a2b3c4d5e6f'
const SLOT = '9a2c7e10-5b6d-4c3e-9f80-0d1e2f3a4b5c'

afterEach(() => {
  delete api.defaults.adapter
})

// Answer every request with `data` (or `make(config)`), keeping what was sent.
// How to call: const sent = answer({ planVersion: 2 })
function answer(data, status = 200) {
  const sent = []
  api.defaults.adapter = async (config) => {
    sent.push({ method: config.method, url: config.url, data: config.data ? JSON.parse(config.data) : undefined, params: config.params, timeout: config.timeout })
    const body = typeof data === 'function' ? data(config) : data
    if (status >= 400) {
      const { AxiosError } = await import('axios')
      throw new AxiosError('failed', 'ERR_BAD_REQUEST', config, {}, { data: body, status, statusText: '', headers: {}, config })
    }
    return { data: body, status, statusText: 'OK', headers: {}, config }
  }
  return sent
}

describe('the calls', () => {
  it('syncs the plan: POST plan/sync', async () => {
    const sent = answer({ planVersion: 3, changed: false })
    expect(await syncSessionPlan(ID)).toEqual({ planVersion: 3, changed: false })
    expect([sent[0].method, sent[0].url, sent[0].data, sent[0].timeout]).toEqual(['post', `/api/sessions/${ID}/plan/sync`, {}, SESSION_TIMEOUT_MS])
  })

  it('sets the radius: PUT radius with metres, or null for Auto', async () => {
    const sent = answer({ planVersion: 4, radiusMeters: 1000 })
    expect(await putSessionRadius(ID, 1000)).toMatchObject({ radiusMeters: 1000 })
    await putSessionRadius(ID, null)
    expect(sent.map((c) => [c.method, c.url, c.data])).toEqual([
      ['put', `/api/sessions/${ID}/radius`, { radiusMeters: 1000 }],
      ['put', `/api/sessions/${ID}/radius`, { radiusMeters: null }],
    ])
  })

  it('removes and restores slots: DELETE slots/:id, POST slots/restore with one id or none', async () => {
    const sent = answer({ planVersion: 5 })
    await deleteSessionSlot(ID, SLOT)
    await restoreSessionSlots(ID, SLOT)
    await restoreSessionSlots(ID)
    expect(sent.map((c) => [c.method, c.url, c.data])).toEqual([
      ['delete', `/api/sessions/${ID}/slots/${SLOT}`, undefined],
      ['post', `/api/sessions/${ID}/slots/restore`, { slotId: SLOT }],
      ['post', `/api/sessions/${ID}/slots/restore`, {}],
    ])
  })

  it('adds, asks for more, and swaps places', async () => {
    const sent = answer({ planVersion: 6, added: true, swapped: true })
    expect(await addSessionOption(ID, SLOT, 'v25')).toMatchObject({ added: true })
    await moreSessionOptions(ID, SLOT, 3)
    expect(await swapSessionOption(ID, SLOT, 'east coast/park', 'toa-payoh-library')).toMatchObject({ swapped: true })
    expect(sent.map((c) => [c.method, c.url, c.data])).toEqual([
      ['post', `/api/sessions/${ID}/slots/${SLOT}/options`, { venueId: 'v25' }],
      ['post', `/api/sessions/${ID}/slots/${SLOT}/options/more`, { have: 3 }],
      ['post', `/api/sessions/${ID}/slots/${SLOT}/options/east%20coast%2Fpark/swap`, { toVenueId: 'toa-payoh-library' }],
    ])
  })

  it('puts the session id in the path safely', async () => {
    const sent = answer({ planVersion: 1 })
    await syncSessionPlan('a/b?c')
    expect(sent[0].url).toBe('/api/sessions/a%2Fb%3Fc/plan/sync')
  })

  it('searches places for a slot: GET venue-search with the words, mapped as the search sheet reads them, with "added"', async () => {
    const sent = answer({
      results: [
        { venueId: 'v1', name: 'Gem Cafe', area: 'Bishan', category: 'eat', walkMinutes: 4, unfit: [], added: true },
        { venueId: 'v2', name: 'Late Bar', area: 'Bishan', category: 'drink', walkMinutes: 9, unfit: ['meal_period', 'closed'] },
      ],
    })
    expect(await searchSessionSlot(ID, SLOT, 'cafe')).toEqual([
      { id: 'v1', name: 'Gem Cafe', area: 'Bishan', category: 'eat', walk: 4, unfit: '', added: true },
      { id: 'v2', name: 'Late Bar', area: 'Bishan', category: 'drink', walk: 9, unfit: 'meal', added: false },
    ])
    expect([sent[0].method, sent[0].url, sent[0].params, sent[0].timeout]).toEqual(['get', `/api/sessions/${ID}/slots/${SLOT}/venue-search`, { q: 'cafe' }, 8000])
    expect(toSearchResult({ venueId: 'x', name: 'X', area: 'A', category: 'eat', walkMinutes: 1 }).unfit).toBe('')
    answer({ nothing: true })
    await expect(searchSessionSlot(ID, SLOT, 'x')).rejects.toThrow()
  })

  it('asks for places by id, in lots of 50, as the cards read them, leaving out what is not sent', async () => {
    const ids = Array.from({ length: 120 }, (_, i) => `v${i}`)
    const sent = answer((config) => ({ venues: String(config.params.ids).split(',').slice(0, 2).map((id) => ({ id, name: id, category: 'eat', avgPricePerPerson: 9, setting: 'indoor', nearestMrt: 'Bishan', mrtWalkMinutes: 3, rating: 4, openingHours: [['09:00', '21:00']], mealPeriods: ['lunch'], tags: [], cdcAccepted: true })) }))
    const venues = await venuesByIds([...ids, 'v0', ''])
    expect(sent.map((c) => c.params.ids.split(',').length)).toEqual([VENUES_PER_REQUEST, VENUES_PER_REQUEST, 20])
    expect(venues).toHaveLength(6)
    expect(venues[0]).toMatchObject({ id: 'v0', price: 9, indoor: true, mrt: 'Bishan', mrtWalk: 3, rating: 8, hours: ['09:00-21:00'], serves: ['lunch'], tags: ['cdc'] })
    sent.length = 0
    expect(await venuesByIds([])).toEqual([])
    expect(sent).toEqual([])
  })

  it('passes the server\'s own code and status on a refusal', async () => {
    answer({ error: 'slot_full', message: 'Full.' }, 409)
    await expect(addSessionOption(ID, SLOT, 'v1')).rejects.toMatchObject({ code: 'slot_full', status: 409 })
    answer({ error: 'host_only', message: 'No.' }, 403)
    await expect(putSessionRadius(ID, 100)).rejects.toMatchObject({ code: 'host_only', status: 403 })
  })
})
