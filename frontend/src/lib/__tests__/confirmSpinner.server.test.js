// The busy state of confirming the meeting spot for a real account, whose sessions are on the server (lib/api.js `onServer`, then
// lib/sessionsRemote.js): the real data layer and events store, the real planner client on the stand-in Jio server
// (./fakeSessionsServer.js) and the stand-in database, with no network. The server's answer is held by hand, on a fake clock, so the
// 600 ms threshold is exact: the store's `confirming` flag is up from the press, the spinner from 600 ms, and both are gone when the
// server answers, refuses or cannot be reached. The local path of a demo account is in confirmSpinner.test.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { OTHER, PROFILE, SESSION } from './authFixture.js'
import { KIM_PLACE, SAM_PLACE, world } from './sessionsWorld.js'

beforeEach(() => vi.setConfig({ testTimeout: 30000 }))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// Move the fake clock on, letting every promise that waits on it run.
// How to call: await tick(599)
const NOW = '2026-10-09T10:00:00+08:00'
const tick = (ms) => vi.advanceTimersByTimeAsync(ms)

// Hold the server's answer to a route until `release()`; the server has read the session and not yet written.
// How to call: const hold = holdServer(w, 'confirm'); ...; hold.release()
function holdServer(w, route) {
  const hold = { release: () => {} }
  w.server.after[route] = () => new Promise((resolve) => { hold.release = resolve })
  return hold
}

// Sam hosts a session in Locating with Kim, both with a start. Kim is opened first so the modules belong to Sam, the host, whose
// events store the test uses (the last app opened owns the modules).
// The date is fixed (the session is for the next day); the clock's timers are faked once everything is built.
// How to call: const { w, sam, id, events, spinner } = await locating()
async function locating() {
  vi.useFakeTimers({ toFake: ['Date'], now: new Date(NOW) })
  const w = world()
  const kim = await w.open(OTHER)
  const sam = await w.open(PROFILE)
  const { id } = await sam.api.createSession({ ...SESSION })
  await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
  await sam.api.startSession(id)
  await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
  await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
  setActivePinia(createPinia())
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { useEventsStore } = await import('@/stores/events.js')
  const spinner = await import('../pageLoading.js')
  const events = useEventsStore()
  await events.loadSession(id)
  vi.useRealTimers()
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'], now: new Date(NOW) })
  return { w, sam, kim, id, events, spinner }
}

describe('confirming a spot on the server', () => {
  it('is busy from the press, shows the spinner at 600 ms, and drops both when the server has answered', async () => {
    const { w, id, events, spinner } = await locating()
    const hold = holdServer(w, 'confirm')
    const spot = events.byId[id].spots.list[0].areaId
    const confirming = events.confirmSpot(id, spot)
    await tick(spinner.SLOW_MS - 1)
    expect([events.confirming, spinner.pageSlow.value]).toEqual([true, false])
    await tick(1)
    expect([events.confirming, spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([true, true, true])
    expect(w.database.tables.sessions[0].status).toBe('locating')
    hold.release()
    await tick(50)
    await confirming
    expect(events.confirming).toBe(false)
    expect(events.byId[id].status).toBe('voting')
    await tick(spinner.MIN_SHOWN_MS)
    expect([spinner.pageSlow.value, spinner.pageBlocking.value]).toEqual([false, false])
  })

  it('is busy and never shows the spinner when the server is quick', async () => {
    const { id, events, spinner } = await locating()
    const seen = vi.fn()
    const { watch } = await import('vue')
    watch(spinner.pageSlow, seen, { flush: 'sync' })
    const confirming = events.confirmSpot(id, events.byId[id].spots.list[0].areaId)
    expect(events.confirming).toBe(true)
    await tick(50)
    await confirming
    await tick(spinner.SLOW_MS + spinner.MIN_SHOWN_MS)
    expect(seen).not.toHaveBeenCalled()
    expect(events.confirming).toBe(false)
  })

  it('names a known place the same way', async () => {
    const { w, id, events, spinner } = await locating()
    const hold = holdServer(w, 'knownPlace')
    const placing = events.setKnownPlace(id, 'bugis')
    await tick(spinner.SLOW_MS)
    expect([events.confirming, spinner.pageSlow.value]).toEqual([true, true])
    hold.release()
    await tick(50)
    await placing
    await tick(spinner.MIN_SHOWN_MS)
    expect([events.confirming, spinner.pageSlow.value, events.byId[id].status]).toEqual([false, false, 'voting'])
  })

  it('takes the meeting area the same way', async () => {
    const { w, id, events, spinner } = await locating()
    const hold = holdServer(w, 'confirm')
    const using = events.useArea(id)
    await tick(spinner.SLOW_MS)
    expect([events.confirming, spinner.pageSlow.value]).toEqual([true, true])
    hold.release()
    await tick(50)
    await using
    await tick(spinner.MIN_SHOWN_MS)
    expect([events.confirming, spinner.pageSlow.value, events.byId[id].status]).toEqual([false, false, 'voting'])
  })

  it('drops both when the server turns the confirm away, and when it cannot be reached', async () => {
    const { w, kim, id, events, spinner } = await locating()
    const hold = holdServer(w, 'confirm')
    const spot = events.byId[id].spots.list[0].areaId
    const refused = events.confirmSpot(id, spot).catch((e) => e)
    await tick(spinner.SLOW_MS)
    expect(spinner.pageSlow.value).toBe(true)
    // Another change lands first: the server answers 409 and writes nothing.
    w.database.tables.sessions[0].plan_version += 1
    hold.release()
    await tick(50)
    expect(await refused).toBeInstanceOf(Error)
    expect(w.database.tables.sessions[0].status).toBe('locating')
    expect(events.confirming).toBe(false)
    await tick(spinner.MIN_SHOWN_MS)
    expect(spinner.pageSlow.value).toBe(false)

    delete w.server.after.confirm
    w.server.down = true
    const lost = events.confirmSpot(id, spot).catch((e) => e)
    expect(events.confirming).toBe(true)
    await tick(50)
    expect(await lost).toBeInstanceOf(Error)
    expect(events.confirming).toBe(false)
    expect(kim.id).toBeTruthy()
  })
})
