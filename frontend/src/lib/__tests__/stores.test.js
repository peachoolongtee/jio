// The planner and events stores against a stand-in for api.js: which events reload a plan, what happens when
// the planner is down, and how a failed or late itinerary load is handled.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const listeners = vi.hoisted(() => [])
// Only what the tests drive is replaced; the stores read other functions from api.js when they are created.
vi.mock('@/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribe: vi.fn((fn) => {
    listeners.push(fn)
    return () => {}
  }),
  getPlan: vi.fn(),
  getConditions: vi.fn(),
  getItinerary: vi.fn(),
  getSession: vi.fn(),
  listSessions: vi.fn(),
  reorderStops: vi.fn(),
  getPhotos: vi.fn(),
}))
import * as api from '@/lib/api.js'
import { useEventsStore } from '@/stores/events.js'
import { usePlannerStore } from '@/stores/planner.js'

const emit = (event) => listeners.forEach((fn) => fn(event))
// Let promises that are already settled run their continuations.
const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}

beforeEach(() => {
  listeners.length = 0
  vi.clearAllMocks()
  setActivePinia(createPinia())
  api.getConditions.mockResolvedValue({ rain: false, routing: true, sessionDay: false })
  api.getPlan.mockResolvedValue({ slots: [] })
})

describe('the planner store', () => {
  async function loaded() {
    const store = usePlannerStore()
    await store.loadPlan('s1')
    api.getPlan.mockClear()
    return store
  }

  it.each([['photos'], ['plan']])('does not reload a plan for a %s event', async (type) => {
    await loaded()
    emit({ type, sessionId: 's1' })
    await flush()
    expect(api.getPlan).not.toHaveBeenCalled()
  })

  it.each([['vote'], ['prefs'], ['options'], ['slots'], ['session'], ['location'], ['optout']])('reloads a plan for a %s event', async (type) => {
    await loaded()
    emit({ type, sessionId: 's1' })
    await flush()
    expect(api.getPlan).toHaveBeenCalledTimes(1)
  })

  it('does not reload the plan of another session, or one that was never opened', async () => {
    await loaded()
    emit({ type: 'vote', sessionId: 's2' })
    await flush()
    expect(api.getPlan).not.toHaveBeenCalled()
  })

  it('still reloads every plan when the weather changes', async () => {
    await loaded()
    emit({ type: 'conditions' })
    await flush()
    expect(api.getPlan).toHaveBeenCalledTimes(1)
  })

  it('has a conditions object without a crowd key', () => {
    expect(Object.keys(usePlannerStore().conditions).sort()).toEqual(['rain', 'routing', 'sessionDay'])
  })

  describe('when the planner is down', () => {
    it('stops loading, keeps the message, and still throws', async () => {
      const store = usePlannerStore()
      api.getPlan.mockRejectedValue(new Error('Cannot reach the Jio planner.'))
      await expect(store.loadPlan('s1')).rejects.toThrow('Cannot reach the Jio planner.')
      expect(store.loading.s1).toBe(false)
      expect(store.errors.s1).toBe('Cannot reach the Jio planner.')
    })

    it('clears the message after a load that works', async () => {
      const store = usePlannerStore()
      api.getPlan.mockRejectedValueOnce(new Error('down'))
      await expect(store.loadPlan('s1')).rejects.toThrow('down')
      await store.loadPlan('s1')
      expect(store.errors.s1).toBe('')
      expect(store.plans.s1).toEqual({ slots: [] })
    })

    it('does not leave a live reload as an unhandled rejection', async () => {
      const store = await loaded()
      api.getPlan.mockRejectedValue(new Error('down'))
      const unhandled = vi.fn()
      process.on('unhandledRejection', unhandled)
      emit({ type: 'vote', sessionId: 's1' })
      await flush()
      process.off('unhandledRejection', unhandled)
      expect(unhandled).not.toHaveBeenCalled()
      expect(store.errors.s1).toBe('down')
      expect(store.plans.s1).toEqual({ slots: [] })
    })

    it('keeps the spinner while a newer load is still running', async () => {
      const store = usePlannerStore()
      const first = deferred()
      const second = deferred()
      api.getPlan.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
      const a = store.loadPlan('s1')
      const b = store.loadPlan('s1')
      first.reject(new Error('old failure'))
      await expect(a).rejects.toThrow('old failure')
      expect(store.loading.s1).toBe(true)
      expect(store.errors.s1 || '').toBe('')
      second.resolve({ slots: [1] })
      await b
      expect(store.loading.s1).toBe(false)
      expect(store.plans.s1).toEqual({ slots: [1] })
    })
  })
})

describe('the events store', () => {
  const itinerary = (...names) => ({ stops: names.map((name, index) => ({ index, name })) })

  it('puts the old order back, reloads the itinerary and throws when a reorder fails', async () => {
    const store = useEventsStore()
    api.getItinerary.mockResolvedValue(itinerary('a', 'b', 'c'))
    await store.loadItinerary('s1')
    api.getItinerary.mockClear()
    api.reorderStops.mockRejectedValue(new Error('Only a confirmed plan can be rearranged.'))
    const moving = store.reorderStops('s1', 0, 2)
    // The stop moves on screen straight away.
    expect(store.itineraries.s1.stops.map((s) => s.name)).toEqual(['b', 'c', 'a'])
    await expect(moving).rejects.toThrow('Only a confirmed plan can be rearranged.')
    expect(store.itineraries.s1.stops.map((s) => s.name)).toEqual(['a', 'b', 'c'])
    expect(api.getItinerary).toHaveBeenCalledTimes(1)
  })

  it('restores the order even when reloading the itinerary fails too, and reports the first error', async () => {
    const store = useEventsStore()
    api.getItinerary.mockResolvedValueOnce(itinerary('a', 'b'))
    await store.loadItinerary('s1')
    api.getItinerary.mockRejectedValue(new Error('reload failed'))
    api.reorderStops.mockRejectedValue(new Error('save failed'))
    await expect(store.reorderStops('s1', 0, 1)).rejects.toThrow('save failed')
    expect(store.itineraries.s1.stops.map((s) => s.name)).toEqual(['a', 'b'])
  })

  it('keeps the new order when the reorder works', async () => {
    const store = useEventsStore()
    api.getItinerary.mockResolvedValueOnce(itinerary('a', 'b', 'c')).mockResolvedValue(itinerary('b', 'c', 'a'))
    await store.loadItinerary('s1')
    api.reorderStops.mockResolvedValue({ id: 's1', status: 'confirmed' })
    await store.reorderStops('s1', 0, 2)
    expect(store.itineraries.s1.stops.map((s) => s.name)).toEqual(['b', 'c', 'a'])
  })

  it('lets an older itinerary load finish without overwriting a newer one', async () => {
    const store = useEventsStore()
    const older = deferred()
    api.getItinerary.mockReturnValueOnce(older.promise).mockResolvedValueOnce(itinerary('new'))
    const first = store.loadItinerary('s1')
    await store.loadItinerary('s1')
    older.resolve(itinerary('old'))
    await first
    expect(store.itineraries.s1.stops.map((s) => s.name)).toEqual(['new'])
  })

  it('does not let a load that started before a move put the old order back over it', async () => {
    const store = useEventsStore()
    api.getItinerary.mockResolvedValueOnce(itinerary('a', 'b'))
    await store.loadItinerary('s1')
    const stale = deferred()
    api.getItinerary.mockReturnValueOnce(stale.promise).mockResolvedValue(itinerary('b', 'a'))
    const earlier = store.loadItinerary('s1')
    api.reorderStops.mockResolvedValue({ id: 's1' })
    const moving = store.reorderStops('s1', 0, 1)
    stale.resolve(itinerary('a', 'b'))
    await earlier
    await moving
    expect(store.itineraries.s1.stops.map((s) => s.name)).toEqual(['b', 'a'])
  })

  it('keeps photos apart from sessions and reloads them on a photos event', async () => {
    const store = useEventsStore()
    api.getSession.mockResolvedValue({ id: 's1', photoCount: 1 })
    api.getPhotos.mockResolvedValue([{ id: 'p1' }])
    await store.loadPhotos('s1')
    expect(store.photos.s1).toEqual([{ id: 'p1' }])
    api.getPhotos.mockResolvedValue([{ id: 'p1' }, { id: 'p2' }])
    emit({ type: 'photos', sessionId: 's1' })
    await flush()
    await flush()
    expect(store.photos.s1).toHaveLength(2)
  })
})
