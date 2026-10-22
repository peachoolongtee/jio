// The planner store's handling of a person's own vote in a shared session (stage 4): it shows at once, it is taken back only when the
// database proves it refused the vote and nothing has replaced the plan since, and a failure that proves nothing leaves what is shown.
// A local session waits for its own answer, as before. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const eq = (col, value) => ({ col, op: 'eq', value })

// The planner store of the app opened last (Kim's), with her plan loaded.
// How to call: const { planner, w, sam, kim, id, slot } = await storeFor()
async function storeFor() {
  const world = await voting()
  setActivePinia(createPinia())
  const { useAuthStore } = await import('@/stores/auth.js')
  await useAuthStore().init()
  const { usePlannerStore } = await import('@/stores/planner.js')
  const planner = usePlannerStore()
  await planner.loadPlan(world.id)
  return { ...world, planner }
}
const slotOf = (planner, id, slotId) => planner.plans[id].slots.find((s) => s.id === slotId)

describe('a vote in a shared session', () => {
  it('shows at once, before the database has answered, with the person\'s name, and keeps it when it is saved', async () => {
    const { planner, w, kim, id, slot } = await storeFor()
    const a = slot.options[0].id
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.kind === 'insert' && op.table === 'votes' ? held : null)
    const pending = planner.vote(id, slot.id, a)
    await vi.waitFor(() => expect(slotOf(planner, id, slot.id)).toMatchObject({ myVote: a, totalVotes: 1, leader: a }))
    expect(slotOf(planner, id, slot.id).options.find((o) => o.id === a).voters).toEqual([{ id: kim.id, name: 'Kim' }])
    expect(planner.plans[id].voters).toEqual([kim.id])
    w.gate.hold = null
    release()
    await pending
    await vi.waitFor(() => expect(w.database.tables.votes).toHaveLength(1))
    expect(slotOf(planner, id, slot.id).myVote).toBe(a)
  })

  it('takes the vote back when the database refuses it, and the plan shows what the database holds', async () => {
    const { planner, w, id, slot } = await storeFor()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    await expect(planner.vote(id, slot.id, slot.options[0].id)).rejects.toMatchObject({ code: 'wrong_status', message: 'Votes are read-only once the plan is confirmed.' })
    expect(slotOf(planner, id, slot.id)).toMatchObject({ myVote: null, totalVotes: 0 })
    expect(w.database.tables.votes).toEqual([])
  })

  it('does not put an older plan back over a newer one that arrived while the vote was out', async () => {
    const { planner, w, sam, id, slot } = await storeFor()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    let release
    const held = new Promise((resolve) => { release = resolve })
    let reached = false
    w.gate.hold = (op) => {
      if (op.kind !== 'insert' || op.table !== 'votes') return null
      reached = true
      return held
    }
    const pending = planner.vote(id, slot.id, slot.options[0].id).catch((e) => e)
    await vi.waitFor(() => expect(reached).toBe(true))
    expect(slotOf(planner, id, slot.id).myVote).toBe(slot.options[0].id)
    // Sam's vote arrives and a newer plan is read meanwhile (a live update): it is the plan that stays.
    w.gate.hold = null
    w.database.tables.votes.push({ slot_id: slot.id, user_id: sam.id, venue_id: slot.options[1].id, created_at: 'x', updated_at: 'x' })
    await planner.loadPlan(id)
    expect(slotOf(planner, id, slot.id).totalVotes).toBe(1)
    // The refusal arrives, and the read that follows it fails: nothing may put the plan from before Sam's vote back.
    // (Only the read of the places fails, which the reload needs; the reads that find out why the vote was refused still answer.)
    const original = w.database.run
    w.database.run = (op) => {
      if (op.table === 'slot_options') throw new Error('Failed to fetch')
      return original(op)
    }
    release()
    const err = await pending
    expect(err).toMatchObject({ code: 'wrong_status' })
    await new Promise((resolve) => setTimeout(resolve, 20))
    w.database.run = original
    expect(slotOf(planner, id, slot.id)).toMatchObject({ totalVotes: 1, myVote: null })
  })

  it('leaves the vote shown, and says so, when the failure proves nothing (no connection)', async () => {
    const { planner, w, id, slot } = await storeFor()
    const original = w.database.run
    w.database.run = () => { throw new Error('Failed to fetch') }
    const err = await planner.vote(id, slot.id, slot.options[0].id).catch((e) => e)
    expect(err.message).toMatch(/Failed to fetch|could not be reached/)
    await new Promise((resolve) => setTimeout(resolve, 20))
    // The read to find out failed too, so what is shown stays: the vote was not proved refused.
    expect(slotOf(planner, id, slot.id).myVote).toBe(slot.options[0].id)
    w.database.run = original
    await planner.loadPlan(id)
    expect(slotOf(planner, id, slot.id).myVote).toBeNull()
  })

  it('reads every held plan again when the channel connects or the tab comes back', async () => {
    const { planner, sam, id, slot } = await storeFor()
    await sam.api.vote(id, slot.id, sam.id, slot.options[0].id)
    expect(slotOf(planner, id, slot.id).totalVotes).toBe(0)
    // Kim's copy of the app connects its channel: everything is read again, and the vote Sam cast while nobody listened is there.
    const kim = await import('@/lib/api.js')
    kim.sessionsWatch.graceMs = 0
    const stop = kim.watchSessions()
    await vi.waitFor(() => expect(slotOf(planner, id, slot.id).totalVotes).toBe(1))
    stop()
  })
})
