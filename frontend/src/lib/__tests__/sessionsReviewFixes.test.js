// Fixes from the review of the browser half of stage 3, on the stand-in database and the stand-in Jio server (sessionsWorld.js):
// which of two reads of a session is the newer, and an "Updating travel times" notice that must not outlive the call that raised it.
// No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { locating } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

describe('which read of a session is the newer', () => {
  // The version comes first: a read that began earlier but holds a newer version is newer than a later one with an older version
  // (a lagging copy of the data), and the order the reads began in decides only between reads of the same version.
  it('keeps a read of a higher version even though it began before the one that answered first', async () => {
    const { w, sam, id } = await locating({ places: true })
    const base = (await sam.api.getSession(id)).planVersion
    const row = w.database.tables.sessions.find((s) => s.id === id)
    row.plan_version = base + 1
    let release
    const held = new Promise((resolve) => { release = resolve })
    let held1 = false
    w.gate.hold = (op) => {
      if (held1 || op.table !== 'sessions' || op.kind !== 'select') return null
      held1 = true
      return held
    }
    // The first read began first, saw version base + 1, and is slow to answer.
    const early = sam.api.getSession(id)
    await vi.waitFor(() => expect(held1).toBe(true))
    // A lagging copy then answers a later read with the older version.
    row.plan_version = base
    expect((await sam.api.getSession(id)).planVersion).toBe(base)
    release()
    expect((await early).planVersion).toBe(base + 1)
    // The next read of the lagging copy does not put the old version back over the newer one handed out.
    expect((await sam.api.getSession(id)).planVersion).toBe(base + 1)
  })

  it('lets the later read win between reads of the same version', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const before = await sam.api.getSession(id)
    await w.database.run({ as: kim.id, kind: 'update', table: 'session_members', values: { start_area_id: 'woodlands' }, filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'user_id', op: 'eq', value: kim.id }] })
    const after = await sam.api.getSession(id)
    expect(after.planVersion).toBe(before.planVersion)
    expect(after.locations[kim.id].start.areaId).toBe('woodlands')
  })
})

describe('the "Updating travel times" notice', () => {
  // Opens the stores for the person the modules are signed in as (the last app opened).
  // How to call: const events = await openStore()
  async function openStore() {
    const pinia = createPinia()
    setActivePinia(pinia)
    const { useAuthStore } = await import('@/stores/auth.js')
    await useAuthStore().init()
    return (await import('@/stores/events.js')).useEventsStore()
  }

  it('is cleared on screen when the call fails without writing anything', async () => {
    const { w, id } = await locating({ places: true })
    const events = await openStore()
    await events.loadSession(id)
    expect(events.byId[id].spots.list.length).toBeGreaterThan(0)
    // The server holds the call for a while, as it does when it routes trips, and then fails it.
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.server.after.putSpot = async () => {
      await held
      throw new Error('The stand-in server fell over.')
    }
    const call = events.suggestMySpot(id, 'orchard')
    const failed = expect(call).rejects.toThrow()
    // The notice is on screen while the call runs...
    await vi.waitFor(() => expect(events.byId[id].findingSpots).toBe(true))
    release()
    await failed
    // ...and is off again once it has failed, with nothing written for a read to find.
    await vi.waitFor(() => expect(events.byId[id].findingSpots).toBe(false))
    expect(w.database.tables.spot_suggestions).toHaveLength(0)
  })
})
