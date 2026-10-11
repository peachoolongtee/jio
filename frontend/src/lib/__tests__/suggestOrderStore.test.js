// The events store and the Confirm dialog's suggested order: one request per question, only the newest question's
// answer and loading state are kept, and a failure is not remembered. api.js is replaced; nothing is asked for real.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'

const listeners = vi.hoisted(() => [])
vi.mock('@/lib/api.js', async (importOriginal) => ({
  ...(await importOriginal()),
  subscribe: vi.fn((fn) => {
    listeners.push(fn)
    return () => {}
  }),
  suggestOrder: vi.fn(),
  listSessions: vi.fn(),
  getSession: vi.fn(),
}))
import * as api from '@/lib/api.js'
import { useEventsStore } from '@/stores/events.js'

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))
const deferred = () => {
  let resolve
  let reject
  const promise = new Promise((res, rej) => ((resolve = res), (reject = rej)))
  return { promise, resolve, reject }
}
const ANSWER = (reason) => ({ order: ['a', 'b'], stops: [], reason, source: 'ai' })

beforeEach(() => {
  listeners.length = 0
  vi.clearAllMocks()
  setActivePinia(createPinia())
  api.listSessions.mockResolvedValue([])
})

describe('events.suggestOrder', () => {
  it('asks once for two opens with the same question, and reuses the answer', async () => {
    const store = useEventsStore()
    api.suggestOrder.mockResolvedValue(ANSWER('one'))
    expect(await store.suggestOrder('s1', 'k1')).toEqual(ANSWER('one'))
    expect(await store.suggestOrder('s1', 'k1')).toEqual(ANSWER('one'))
    expect(api.suggestOrder).toHaveBeenCalledTimes(1)
    expect(store.orders.s1).toMatchObject({ key: 'k1', loading: false, answer: ANSWER('one') })
  })

  it('shares the request still running when the dialog is opened again', async () => {
    const store = useEventsStore()
    const slow = deferred()
    api.suggestOrder.mockReturnValue(slow.promise)
    const first = store.suggestOrder('s1', 'k1')
    const second = store.suggestOrder('s1', 'k1')
    expect(api.suggestOrder).toHaveBeenCalledTimes(1)
    expect(store.orders.s1.loading).toBe(true)
    slow.resolve(ANSWER('late'))
    expect(await first).toEqual(ANSWER('late'))
    expect(await second).toEqual(ANSWER('late'))
    expect(store.orders.s1.loading).toBe(false)
  })

  it('keeps a "no other order" answer too, so the dialog does not ask again for it', async () => {
    const store = useEventsStore()
    api.suggestOrder.mockResolvedValue(null)
    await store.suggestOrder('s1', 'k1')
    await store.suggestOrder('s1', 'k1')
    expect(api.suggestOrder).toHaveBeenCalledTimes(1)
    expect(store.orders.s1).toMatchObject({ loading: false, answer: null, failed: false })
  })

  it('asks again for a different question, or another session', async () => {
    const store = useEventsStore()
    api.suggestOrder.mockResolvedValue(ANSWER('x'))
    await store.suggestOrder('s1', 'k1')
    await store.suggestOrder('s1', 'k2')
    await store.suggestOrder('s2', 'k2')
    expect(api.suggestOrder).toHaveBeenCalledTimes(3)
    expect(store.orders.s1.key).toBe('k2')
  })

  it('ignores an older answer that arrives last', async () => {
    const store = useEventsStore()
    const older = deferred()
    const newer = deferred()
    api.suggestOrder.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const a = store.suggestOrder('s1', 'old')
    const b = store.suggestOrder('s1', 'new')
    newer.resolve(ANSWER('newer'))
    await b
    older.resolve(ANSWER('older'))
    await a
    await flush()
    expect(store.orders.s1).toMatchObject({ key: 'new', loading: false, answer: ANSWER('newer') })
  })

  it('keeps the loading state while the newest question is still running, whatever finishes first', async () => {
    const store = useEventsStore()
    const older = deferred()
    const newer = deferred()
    api.suggestOrder.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const a = store.suggestOrder('s1', 'old')
    const b = store.suggestOrder('s1', 'new')
    older.resolve(ANSWER('older'))
    await a
    await flush()
    // The older request has finished; the newer one is what the dialog is waiting for.
    expect(store.orders.s1).toMatchObject({ key: 'new', loading: true, answer: null })
    newer.resolve(ANSWER('newer'))
    await b
    expect(store.orders.s1).toMatchObject({ key: 'new', loading: false, answer: ANSWER('newer') })
  })

  it('does not let an older failure end the newer question', async () => {
    const store = useEventsStore()
    const older = deferred()
    const newer = deferred()
    api.suggestOrder.mockReturnValueOnce(older.promise).mockReturnValueOnce(newer.promise)
    const a = store.suggestOrder('s1', 'old')
    store.suggestOrder('s1', 'new')
    older.reject(new Error('timeout of 10000ms exceeded'))
    expect(await a).toBeNull()
    expect(store.orders.s1).toMatchObject({ key: 'new', loading: true, failed: false })
  })

  it('never rejects, shows a failure as no answer, and asks again the next time', async () => {
    const store = useEventsStore()
    api.suggestOrder.mockRejectedValueOnce(new Error('timeout of 10000ms exceeded'))
    expect(await store.suggestOrder('s1', 'k1')).toBeNull()
    expect(store.orders.s1).toMatchObject({ loading: false, answer: null, failed: true })
    api.suggestOrder.mockResolvedValueOnce(ANSWER('second try'))
    expect(await store.suggestOrder('s1', 'k1')).toEqual(ANSWER('second try'))
    expect(api.suggestOrder).toHaveBeenCalledTimes(2)
    expect(store.orders.s1).toMatchObject({ loading: false, answer: ANSWER('second try'), failed: false })
  })

  it('forgets answers when the demo data is reset, including one still on its way', async () => {
    const store = useEventsStore()
    const slow = deferred()
    api.suggestOrder.mockReturnValue(slow.promise)
    const pending = store.suggestOrder('s1', 'k1')
    listeners.forEach((fn) => fn({ type: 'reset' }))
    await flush()
    expect(store.orders).toEqual({})
    slow.resolve(ANSWER('from before the reset'))
    await pending
    expect(store.orders).toEqual({})
  })
})
