// Stage 4 of moving sessions to the database: voting on places, for a real account. Two or three people use their own copy of the app on ONE
// stand-in database and one stand-in Jio server, so what one does the others see, and the paths, bodies and login tokens are the real ones.
// The rules that must hold are each a test: a vote is a direct write that asks the planner for nothing; a reload shows the same places
// with no planner call; one person's vote shows on the other device; a late answer never goes over a newer state; a failed write takes
// back only its own change; another member's exact place is nowhere. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { createSessionsRemote } from '../sessionsRemote.js'
import { KIM_PLACE, SAM_PLACE, THIRD, voting } from './sessionsWorld.js'
import { SESSION } from './authFixture.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const eq = (col, value) => ({ col, op: 'eq', value })
const rowsOf = (w, table) => w.database.tables[table]
const idsOf = (slot) => slot.options.map((o) => o.id)
const bySlot = (plan, category) => plan.slots.find((s) => s.category === category)

describe('what the server makes when the host confirms the spot', () => {
  it('gives both people the same four categories with the same places, read from the database with no planner call', async () => {
    const { w, sam, kim, id, plan } = await voting()
    expect(plan.slots.map((s) => s.category).sort()).toEqual(['activity', 'drink', 'eat', 'shop'])
    for (const slot of plan.slots) {
      expect(slot.options.length).toBeGreaterThan(0)
      expect(slot.options.length).toBeLessThanOrEqual(3)
      expect(slot).toMatchObject({ leader: null, totalVotes: 0, myVote: null, tied: [] })
      for (const option of slot.options) expect(option.venue.name).toBeTruthy()
    }
    const seen = await kim.api.getPlan(id)
    expect(seen.slots.map((s) => [s.id, idsOf(s)])).toEqual(plan.slots.map((s) => [s.id, idsOf(s)]))
    expect(seen).toMatchObject({ remote: true, radius: null, area: { id: (await sam.api.getSession(id)).meeting.areaId } })
    // Reading it again, as a reload does, asks the planner for nothing: the server was not called at all.
    w.server.calls.length = 0
    await sam.api.getPlan(id)
    await kim.api.getPlan(id)
    expect(w.server.calls.filter((c) => c.route !== 'venues')).toEqual([])
    expect(w.server.calls.every((c) => c.route === 'venues')).toBe(true)
  })

  it('asks for the cards\' places once, and not again for a place already known', async () => {
    const { w, sam, id } = await voting()
    w.server.calls.length = 0
    await sam.api.getPlan(id)
    await sam.api.getPlan(id)
    expect(w.server.calls).toEqual([])
  })

  it('keeps what the planner said of each slot and place for the cards: the notice, the weather, the reasons and the walk', async () => {
    const { plan } = await voting()
    expect(plan.weather).toMatchObject({ source: 'live' })
    const option = plan.slots[0].options[0]
    expect(option).toMatchObject({ walk: expect.any(Number), distanceM: expect.any(Number), reasons: expect.any(Array), warnings: [], swap: null, approximate: true })
    expect(plan.slots[0].canAddMore).toBe(true)
    // Best first: the planner's score is a penalty.
    const scores = plan.slots[0].options.map((o) => o.score)
    expect([...scores].sort((a, b) => a - b)).toEqual(scores)
  })

  it('makes the slots a session\'s summary can show on Home: the voted ones only, with their place counts', async () => {
    const { sam, kim, id, slot } = await voting()
    expect((await sam.api.getSession(id)).slots).toEqual([])
    await kim.api.vote(id, slot.id, kim.id, slot.options[0].id)
    const read = await sam.api.getSession(id)
    expect(read.slots).toEqual([expect.objectContaining({ id: slot.id, category: slot.category, optionCount: slot.options.length })])
    expect(read.votes).toEqual({ [slot.id]: { [kim.id]: slot.options[0].id } })
    expect(read.options[slot.id]).toEqual(idsOf(slot))
    // Neither the rows nor the places' details are on the session a screen is handed.
    expect(read.slotRows).toBeUndefined()
    expect(read.optionRows).toBeUndefined()
  })
})

describe('voting', () => {
  it('is a write by the person to the votes table, and asks the planner and the Jio server for nothing', async () => {
    const { w, sam, kim, id, slot } = await voting()
    w.ops.length = 0
    const done = await sam.api.vote(id, slot.id, sam.id, slot.options[0].id)
    expect(done).toMatchObject({ myVote: slot.options[0].id })
    expect(rowsOf(w, 'votes')).toMatchObject([{ slot_id: slot.id, user_id: sam.id, venue_id: slot.options[0].id }])
    expect(w.server.calls).toEqual([])
    expect(w.ops.filter((op) => op.kind !== 'select').map((op) => [op.kind, op.table, op.as])).toEqual([['insert', 'votes', sam.id]])
    const seen = await kim.api.getPlan(id)
    const card = bySlot(seen, slot.category).options.find((o) => o.id === slot.options[0].id)
    expect(card).toMatchObject({ votes: 1, voters: [{ id: sam.id, name: 'Sam' }] })
    expect(bySlot(seen, slot.category)).toMatchObject({ leader: slot.options[0].id, totalVotes: 1, myVote: null })
    expect(seen.voters).toEqual([sam.id])
  })

  it('counts the requests of one round of voting: both vote in every category, move one vote, take one back, and the server hears nothing', async () => {
    const { w, sam, kim, id, plan } = await voting()
    for (const slot of plan.slots) {
      await sam.api.vote(id, slot.id, sam.id, slot.options[0].id)
      await kim.api.vote(id, slot.id, kim.id, slot.options[slot.options.length - 1].id)
    }
    const first = plan.slots[0]
    await kim.api.vote(id, first.id, kim.id, first.options[0].id)
    await sam.api.vote(id, first.id, sam.id, first.options[0].id)
    expect(w.server.calls).toEqual([])
    expect(rowsOf(w, 'votes')).toHaveLength(plan.slots.length * 2 - 1)
    const after = await sam.api.getPlan(id)
    expect(bySlot(after, first.category)).toMatchObject({ myVote: null, totalVotes: 1, leader: first.options[0].id })
    expect(after.voters.sort()).toEqual([sam.id, kim.id].sort())
  })

  it('moves a vote to another place and takes it back by voting for the same place again', async () => {
    const { w, sam, id, slot } = await voting()
    const [a, b] = idsOf(slot)
    await sam.api.vote(id, slot.id, sam.id, a)
    expect((await sam.api.vote(id, slot.id, sam.id, b)).myVote).toBe(b)
    expect(rowsOf(w, 'votes')).toMatchObject([{ venue_id: b }])
    expect((await sam.api.vote(id, slot.id, sam.id, b)).myVote).toBeNull()
    expect(rowsOf(w, 'votes')).toEqual([])
  })

  it('makes the leader, the tie and the counts the same way the local plan does', async () => {
    const { sam, kim, id, slot } = await voting({ third: true })
    const [a, b] = idsOf(slot)
    await sam.api.vote(id, slot.id, sam.id, a)
    await kim.api.vote(id, slot.id, kim.id, b)
    expect(bySlot(await sam.api.getPlan(id), slot.category)).toMatchObject({ leader: null, topVotes: 1, tied: [a, b], totalVotes: 2 })
  })

  it('says why a vote was refused, and writes nothing: a place that is no longer offered, a session that is over, a person who is out', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const [a] = idsOf(slot)
    await expect(sam.api.vote(id, slot.id, sam.id, 'nowhere')).rejects.toMatchObject({ message: 'That place is no longer an option.', code: 'option_not_found' })
    await expect(sam.api.vote(id, slot.id, kim.id, a)).rejects.toThrow("You can't do that in this session.")
    await kim.api.optOut(id, kim.id)
    await expect(kim.api.vote(id, slot.id, kim.id, a)).rejects.toMatchObject({ message: 'Only people in this session can do that.', code: 'not_joined' })
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    await expect(sam.api.vote(id, slot.id, sam.id, a)).rejects.toMatchObject({ message: 'Votes are read-only once the plan is confirmed.', code: 'wrong_status' })
    expect(rowsOf(w, 'votes')).toEqual([])
  })

  it('tells a person who cannot be reached so, and keeps the vote only if it was made', async () => {
    const { w, sam, id, slot } = await voting()
    const a = idsOf(slot)[0]
    const original = w.database.run
    // The connection drops before the write arrives: a plain failure that says nothing was saved is not claimed.
    w.database.run = () => { throw new Error('Failed to fetch') }
    const err = await sam.api.vote(id, slot.id, sam.id, a).catch((e) => e)
    w.database.run = original
    expect(err.message).toMatch(/Failed to fetch|could not be reached/)
    expect(rowsOf(w, 'votes')).toEqual([])
  })

  // Another copy of the app for the same person (a second device), over the same database: a direct caller of the data layer.
  const otherDevice = (person) => createSessionsRemote({ client: () => person.fake.client, me: () => person.id })

  it('treats two taps from two devices of one person as one person\'s vote, never two, and the one written second stands', async () => {
    const { w, sam, id, slot } = await voting()
    const [a, b] = idsOf(slot)
    // Both devices read "no vote" first: each read is really held until both have been made, then both go on.
    const releases = []
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'votes' ? new Promise((resolve) => releases.push(resolve)) : null)
    const first = sam.api.vote(id, slot.id, sam.id, a)
    await vi.waitFor(() => expect(releases).toHaveLength(1))
    const second = otherDevice(sam).castVote(id, slot.id, b)
    await vi.waitFor(() => expect(releases).toHaveLength(2))
    // Neither has written anything yet: both saw "no vote".
    expect(rowsOf(w, 'votes')).toEqual([])
    w.gate.hold = null
    // The first goes on and writes; then the second goes on, with a read that said "no vote" that is no longer so.
    releases[0]()
    await vi.waitFor(() => expect(rowsOf(w, 'votes')).toHaveLength(1))
    releases[1]()
    const [firstDone, secondDone] = await Promise.all([first, second])
    // The first wrote its insert; the second's insert met it (a vote already there), so it moved that vote. One row, and it is the second's.
    expect(rowsOf(w, 'votes')).toHaveLength(1)
    expect(rowsOf(w, 'votes')[0]).toMatchObject({ user_id: sam.id, venue_id: b })
    expect(firstDone.myVote).toBe(a)
    expect(secondDone).toBe(b)
  })

  it('runs two quick taps of one person on one slot one after the other, so the last tap wins', async () => {
    const { w, sam, id, slot } = await voting()
    const [a, b] = idsOf(slot)
    w.ops.length = 0
    // The first tap's read of the person's own vote is held. The second tap must not start its own meanwhile.
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'votes' && !release.used ? ((release.used = true), held) : null)
    const first = sam.api.vote(id, slot.id, sam.id, a)
    const second = sam.api.vote(id, slot.id, sam.id, b)
    await vi.waitFor(() => expect(release.used).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 30))
    // Only the first tap has asked anything of the database so far.
    expect(w.ops.filter((op) => op.table === 'votes' && op.as === sam.id)).toHaveLength(1)
    release()
    const [one, two] = await Promise.all([first, second])
    expect([one.myVote, two.myVote]).toEqual([a, b])
    expect(rowsOf(w, 'votes')).toMatchObject([{ user_id: sam.id, venue_id: b }])
  })

  it('takes a vote back when the same place is tapped twice quickly', async () => {
    const { w, sam, id, slot } = await voting()
    const [a] = idsOf(slot)
    const [one, two] = await Promise.all([sam.api.vote(id, slot.id, sam.id, a), sam.api.vote(id, slot.id, sam.id, a)])
    expect([one.myVote, two.myVote]).toEqual([a, null])
    expect(rowsOf(w, 'votes')).toEqual([])
  })

  it('does not hold up a tap in another slot, or another person\'s', async () => {
    const { w, sam, kim, id, plan } = await voting()
    const [first, second] = plan.slots
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'votes' && op.as === sam.id && !release.used ? ((release.used = true), held) : null)
    const slow = sam.api.vote(id, first.id, sam.id, first.options[0].id)
    await vi.waitFor(() => expect(release.used).toBe(true))
    await sam.api.vote(id, second.id, sam.id, second.options[0].id)
    await kim.api.vote(id, first.id, kim.id, first.options[0].id)
    expect(rowsOf(w, 'votes')).toHaveLength(2)
    release()
    await slow
    expect(rowsOf(w, 'votes')).toHaveLength(3)
  })
})

describe('live', () => {
  const listen = (app) => {
    const heard = []
    app.api.subscribe((event) => heard.push(event))
    return heard
  }

  it('shows A\'s vote on B\'s device without a reload, and takes it away again', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    const { w, sam, kim, id, slot } = await voting()
    // Kim's is the app opened last, so the stores below are hers.
    setActivePinia(createPinia())
    const { usePlannerStore } = await import('@/stores/planner.js')
    const planner = usePlannerStore()
    await planner.loadPlan(id)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.some((s) => s.table === 'votes')).toBe(true))
    expect(planner.plans[id].slots[0].totalVotes).toBe(0)
    const a = idsOf(slot)[0]
    await sam.api.vote(id, slot.id, sam.id, a)
    await vi.waitFor(() => expect(planner.plans[id].slots.find((s) => s.id === slot.id).options.find((o) => o.id === a).votes).toBe(1))
    expect(planner.plans[id].slots.find((s) => s.id === slot.id).options.find((o) => o.id === a).voters).toEqual([{ id: sam.id, name: 'Sam' }])
    await sam.api.vote(id, slot.id, sam.id, a)
    await vi.waitFor(() => expect(planner.plans[id].slots.find((s) => s.id === slot.id).totalVotes).toBe(0))
    stop()
  })

  it('hears a vote as a change to the votes of its session, and ignores a vote on a slot it has not read', async () => {
    const { w, sam, kim, id, slot } = await voting()
    await sam.api.getSession(id)
    const heard = listen(sam)
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    heard.length = 0
    await kim.api.vote(id, slot.id, kim.id, idsOf(slot)[0])
    await vi.waitFor(() => expect(heard.some((e) => e.type === 'votes' && e.sessionId === id)).toBe(true))
    // Only the votes changed: the whole session is not announced as changed.
    expect(heard.some((e) => e.type === 'session')).toBe(false)
    stop()
  })

  it('ignores the delete of a real vote in a session this account never read: it reaches the handler, and nothing is read for it', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    // Another outing, between Kim and Lee. Sam is not in it, and the browser he listens in has never read it.
    const other = await kim.api.createSession({ ...SESSION, title: 'Not Sam\'s' })
    await lee.api.joinWithLink((await kim.api.makeInviteLink(other.id)).token)
    await kim.api.startSession(other.id)
    await kim.api.setLocation(other.id, kim.id, 'start', KIM_PLACE)
    await lee.api.setLocation(other.id, lee.id, 'start', { areaId: 'woodlands', label: 'Causeway Point' })
    await kim.api.useMeetingArea(other.id)
    const theirs = (await kim.api.getPlan(other.id)).slots[0]
    await lee.api.vote(other.id, theirs.id, lee.id, theirs.options[0].id)
    expect(rowsOf(w, 'votes').some((v) => v.slot_id === theirs.id)).toBe(true)
    await sam.api.getSession(id)
    const heard = []
    sam.api.subscribe((event) => heard.push(event))
    // The raw frames Sam's own channel is given, to prove the delete does arrive.
    const frames = []
    w.database.subscribe({ as: sam.id, table: 'votes', event: 'DELETE' }, (p) => frames.push(p))
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    heard.length = 0
    w.ops.length = 0
    await w.database.run({ as: SERVICE, kind: 'delete', table: 'votes', filters: [eq('slot_id', theirs.id)] })
    await vi.waitFor(() => expect(frames).toHaveLength(1))
    expect(frames[0].old).toMatchObject({ slot_id: theirs.id })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(heard.filter((e) => e.type === 'session' || e.type === 'votes')).toEqual([])
    expect(w.ops.filter((op) => op.as === sam.id && op.kind === 'select')).toEqual([])
    stop()
  })

  it('reads the plan again for a change the server makes (a place added), through the session\'s version', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    const { w, sam, kim, id, slot } = await voting()
    setActivePinia(createPinia())
    const { usePlannerStore } = await import('@/stores/planner.js')
    const planner = usePlannerStore()
    await planner.loadPlan(id)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.some((s) => s.table === 'sessions')).toBe(true))
    const before = planner.plans[id].slots.find((s) => s.id === slot.id).options.length
    await sam.api.addMoreOptions(id, slot.id)
    await vi.waitFor(() => expect(planner.plans[id].slots.find((s) => s.id === slot.id).options.length).toBeGreaterThan(before))
    stop()
  })

  it('reads the plan again when the connection comes back, for the votes it missed while it was away', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    const { sam, kim, id, slot } = await voting()
    setActivePinia(createPinia())
    const { usePlannerStore } = await import('@/stores/planner.js')
    const planner = usePlannerStore()
    await planner.loadPlan(id)
    kim.api.sessionsWatch.graceMs = 0
    let stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(kim.fake.state.dataClient.getChannels()).toHaveLength(1))
    stop()
    await vi.waitFor(() => expect(kim.fake.state.dataClient.getChannels()).toHaveLength(0))
    await sam.api.vote(id, slot.id, sam.id, idsOf(slot)[0])
    expect(planner.plans[id].slots.find((s) => s.id === slot.id).totalVotes).toBe(0)
    stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(planner.plans[id].slots.find((s) => s.id === slot.id).totalVotes).toBe(1))
    stop()
  })
})

describe('which slots a live vote may name (a vote carries a slot, not a session)', () => {
  // The slot of a category is deleted and made again with a new id, as the server does when a day no longer fits a slot and later does
  // again, and a vote is put on the new one. The old slot's places and votes go with it.
  // How to call: const fresh = replaceSlot(w, id, slot, venueId, userId) -> { id: '9a2c...' } (and a vote by that person on that place)
  function replaceSlot(w, id, slot, venueId, userId) {
    const was = rowsOf(w, 'slots').find((x) => x.id === slot.id)
    w.database.run({ as: SERVICE, kind: 'delete', table: 'slots', filters: [eq('id', slot.id)] })
    const made = w.database.run({ as: SERVICE, kind: 'insert', table: 'slots', values: { session_id: id, category: was.category, start_minute: was.start_minute, duration_minutes: was.duration_minutes, picks: was.picks, is_last: was.is_last }, returning: true, columns: 'id' }).data[0]
    w.database.run({ as: SERVICE, kind: 'insert', table: 'slot_options', values: { slot_id: made.id, venue_id: venueId, rank: 1, score: 1 } })
    w.database.run({ as: SERVICE, kind: 'insert', table: 'votes', values: { slot_id: made.id, user_id: userId, venue_id: venueId } })
    rowsOf(w, 'sessions').find((x) => x.id === id).plan_version += 1
    return made
  }
  const listen = (app) => {
    const heard = []
    app.api.subscribe((event) => heard.push(event))
    return heard
  }
  const holdFirst = (w, table) => {
    let release
    const held = new Promise((resolve) => { release = resolve })
    let reached = false
    w.gate.hold = (op) => {
      if (reached || op.kind !== 'select' || op.table !== table) return null
      reached = true
      return held
    }
    return { release: () => release(), reached: () => reached }
  }

  it('is not changed by a plan read that began earlier and answers after a newer one', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const venue = idsOf(slot)[0]
    await kim.api.getPlan(id)
    // An older read of Kim's plan has read the slots (and the places) and its answer to the last read is held.
    const hold = holdFirst(w, 'votes')
    const old = kim.api.getPlan(id)
    await vi.waitFor(() => expect(hold.reached()).toBe(true))
    // The slot is replaced by one with a new id, and a newer read finds it: that is the slot a vote may name now.
    const fresh = replaceSlot(w, id, slot, venue, sam.id)
    w.gate.hold = null
    await kim.api.getPlan(id)
    hold.release()
    await old
    const heard = listen(kim)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    heard.length = 0
    // A vote on the new slot is heard as a change to the votes of the session: the older read did not put the old slot back in its place.
    w.database.run({ as: SERVICE, kind: 'delete', table: 'votes', filters: [eq('slot_id', fresh.id)] })
    await vi.waitFor(() => expect(heard.some((e) => e.type === 'votes' && e.sessionId === id)).toBe(true))
    stop()
  })

  it('is not changed by a list that began earlier and answers after a newer read of the session', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const venue = idsOf(slot)[0]
    await kim.api.getSession(id)
    const hold = holdFirst(w, 'votes')
    const old = kim.api.listSessions()
    await vi.waitFor(() => expect(hold.reached()).toBe(true))
    const fresh = replaceSlot(w, id, slot, venue, sam.id)
    w.gate.hold = null
    await kim.api.getSession(id)
    hold.release()
    await old
    const heard = listen(kim)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    heard.length = 0
    w.database.run({ as: SERVICE, kind: 'delete', table: 'votes', filters: [eq('slot_id', fresh.id)] })
    await vi.waitFor(() => expect(heard.some((e) => e.type === 'votes' && e.sessionId === id)).toBe(true))
    stop()
  })

  it('does not remember the slots of a plan that was read for the account before', async () => {
    const { w, sam, kim, id, slot } = await voting()
    await sam.api.vote(id, slot.id, sam.id, idsOf(slot)[0])
    // Kim's plan read is out, its places not yet answered, when she signs out and someone else signs in on the same copy of the app.
    const hold = holdFirst(w, 'slot_options')
    const pending = kim.api.getPlan(id).catch((e) => e)
    await vi.waitFor(() => expect(hold.reached()).toBe(true))
    await kim.api.signOut()
    await kim.api.signUp({ ...THIRD })
    w.gate.hold = null
    hold.release()
    expect(await pending).toBeInstanceOf(Error)
    const heard = listen(kim)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    heard.length = 0
    // A vote taken away in the session Kim was in (a delete reaches every listener) is nothing to the account that is signed in now.
    w.database.run({ as: SERVICE, kind: 'delete', table: 'votes', filters: [eq('slot_id', slot.id)] })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(heard.filter((e) => e.type === 'votes' || e.type === 'session')).toEqual([])
    stop()
  })

  it('forgets the slots of a session the person is no longer in', async () => {
    const { w, sam, kim, id, slot } = await voting()
    await sam.api.vote(id, slot.id, sam.id, idsOf(slot)[0])
    await kim.api.getPlan(id)
    const heard = listen(kim)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    // Kim's membership is deleted (the host removed her): the channel tells her, and the session is gone from her.
    w.database.run({ as: SERVICE, kind: 'delete', table: 'session_members', filters: [eq('session_id', id), eq('user_id', kim.id)] })
    await vi.waitFor(() => expect(heard.some((e) => e.type === 'session-gone' && e.sessionId === id)).toBe(true))
    heard.length = 0
    // A vote taken back in that session now reaches her only as a bare delete: she has no slot of it to name.
    w.database.run({ as: SERVICE, kind: 'delete', table: 'votes', filters: [eq('slot_id', slot.id)] })
    await new Promise((resolve) => setTimeout(resolve, 80))
    expect(heard.filter((e) => e.type === 'votes' || e.type === 'session')).toEqual([])
    stop()
  })
})

describe('reading only what a live vote changed', () => {
  const tablesRead = (w, person) => [...new Set(w.ops.filter((op) => op.as === person.id && op.kind === 'select').map((op) => op.table))].sort()

  it('reads the votes of the plan and nothing else, and shows the new vote', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const a = idsOf(slot)[0]
    await kim.api.getPlan(id)
    await sam.api.vote(id, slot.id, sam.id, a)
    w.ops.length = 0
    w.server.calls.length = 0
    const plan = await kim.api.getPlan(id, { votesOnly: true })
    expect(tablesRead(w, kim)).toEqual(['votes'])
    expect(w.server.calls).toEqual([])
    expect(bySlot(plan, slot.category)).toMatchObject({ totalVotes: 1, leader: a })
    expect(plan.voters).toEqual([sam.id])
    // The rest is what the full read had: the same places, in the same order.
    expect(plan.slots.map((s) => [s.id, idsOf(s)])).toEqual((await kim.api.getPlan(id)).slots.map((s) => [s.id, idsOf(s)]))
  })

  it('reads the votes of the session and nothing else, and counts the new vote in its slots', async () => {
    const { w, sam, kim, id, slot } = await voting()
    await kim.api.getSession(id)
    await sam.api.vote(id, slot.id, sam.id, idsOf(slot)[0])
    w.ops.length = 0
    const session = await kim.api.getSession(id, { votesOnly: true })
    expect(tablesRead(w, kim)).toEqual(['votes'])
    expect(session.votes).toEqual({ [slot.id]: { [sam.id]: idsOf(slot)[0] } })
    expect(session.slots.map((x) => x.id)).toEqual([slot.id])
    // Nothing else of the session changed.
    const whole = await kim.api.getSession(id)
    expect(session).toEqual(whole)
  })

  it('reads the session whole when it has never been read, or has no slot to read votes for', async () => {
    const { w, kim, id } = await voting()
    w.ops.length = 0
    const session = await kim.api.getSession(id, { votesOnly: true })
    expect(tablesRead(w, kim)).toEqual(expect.arrayContaining(['sessions', 'session_members', 'slots', 'votes']))
    expect(session.id).toBe(id)
    w.ops.length = 0
    const plan = await kim.api.getPlan(id, { votesOnly: true })
    expect(tablesRead(w, kim)).toEqual(expect.arrayContaining(['sessions', 'slots', 'slot_options', 'votes']))
    expect(plan.slots.length).toBeGreaterThan(0)
  })

  it('is what a live vote does on the other device: its stores read the votes alone', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    const { w, sam, kim, id, slot } = await voting()
    setActivePinia(createPinia())
    const { usePlannerStore } = await import('@/stores/planner.js')
    const { useEventsStore } = await import('@/stores/events.js')
    const planner = usePlannerStore()
    const events = useEventsStore()
    await events.loadSession(id)
    await planner.loadPlan(id)
    const stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.some((x) => x.table === 'votes')).toBe(true))
    await new Promise((resolve) => setTimeout(resolve, 60))
    w.ops.length = 0
    await sam.api.vote(id, slot.id, sam.id, idsOf(slot)[0])
    await vi.waitFor(() => expect(planner.plans[id].slots.find((x) => x.id === slot.id).totalVotes).toBe(1))
    await vi.waitFor(() => expect(events.byId[id].votes[slot.id]).toEqual({ [sam.id]: idsOf(slot)[0] }))
    // Everything Kim's device read for it was the votes.
    expect(tablesRead(w, kim)).toEqual(['votes'])
    stop()
  })
})

describe('the radius, and adding, searching, swapping and asking for more places', () => {
  it('lets only the host set the radius; places outside it go with their votes and the banner says so', async () => {
    const { w, sam, kim, id, plan } = await voting()
    await expect(kim.api.setRadius(id, 250)).rejects.toMatchObject({ message: 'Only the host can change how far to search.', code: 'host_only' })
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'radius', body: { radiusMeters: 250 }, as: kim.id })
    for (const s of plan.slots) await kim.api.vote(id, s.id, kim.id, s.options[0].id)
    const before = rowsOf(w, 'votes').length
    await sam.api.setRadius(id, 100)
    const after = await kim.api.getPlan(id)
    expect(after.radius).toBe(100)
    expect(rowsOf(w, 'votes').length).toBeLessThan(before)
    // A dropped place took its vote; a place still offered keeps its own.
    const offered = new Set(after.slots.flatMap((s) => idsOf(s)))
    for (const v of rowsOf(w, 'votes')) expect(offered.has(v.venue_id)).toBe(true)
    expect((await kim.api.getSession(id)).banner).toMatchObject({ votesCleared: true, byRadius: true })
    await sam.api.setRadius(id, null)
    expect((await kim.api.getPlan(id)).radius).toBeNull()
  })

  it('refuses a radius outside 100 m to 3 km before asking', async () => {
    const { w, sam, id } = await voting()
    await expect(sam.api.setRadius(id, 50)).rejects.toThrow('Pick a radius from 100 m to 3 km.')
    expect(w.server.calls).toEqual([])
  })

  it('shows B a place A adds from a search, with the votes it gets, and refuses a seventh, a place that does not fit and a repeat', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const found = await kim.api.searchVenuesForSlot(id, slot.id, 'a')
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'venueSearch', query: { q: 'a' } })
    const addable = found.filter((r) => !r.unfit && !r.added)
    expect(addable.length).toBeGreaterThan(0)
    await kim.api.addOption(id, slot.id, addable[0].id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'addOption', body: { venueId: addable[0].id } })
    const seen = await sam.api.getPlan(id)
    const added = bySlot(seen, slot.category).options.find((o) => o.id === addable[0].id)
    expect(added).toBeTruthy()
    expect(rowsOf(w, 'slot_options').find((o) => o.venue_id === addable[0].id)).toMatchObject({ source: 'member', added_by: kim.id })
    await sam.api.vote(id, slot.id, sam.id, addable[0].id)
    expect(bySlot(await kim.api.getPlan(id), slot.category).options.find((o) => o.id === addable[0].id).votes).toBe(1)
    // The same place again is not a second one.
    await kim.api.addOption(id, slot.id, addable[0].id)
    expect(rowsOf(w, 'slot_options').filter((o) => o.slot_id === slot.id && o.venue_id === addable[0].id)).toHaveLength(1)
    // A place that is not of this category does not fit, and says which place.
    const other = (await kim.api.searchVenuesForSlot(id, slot.id, 'a')).find((r) => r.unfit)
    if (other) await expect(kim.api.addOption(id, slot.id, other.id)).rejects.toThrow(`${other.name} does not fit this slot.`)
    await expect(kim.api.addOption(id, slot.id, 'no-such-place')).rejects.toMatchObject({ message: 'That place could not be found.', code: 'venue_not_found' })
  })

  it('refuses a seventh place in a category, and never offers more than six by asking for more', async () => {
    const { w, kim, id, slot } = await voting()
    const count = () => rowsOf(w, 'slot_options').filter((o) => o.slot_id === slot.id).length
    for (let i = 0; i < 4 && count() < 6; i += 1) await kim.api.addMoreOptions(id, slot.id)
    // Make up the six with places of the category the server did not offer, so the next one is a seventh.
    const offered = new Set(rowsOf(w, 'slot_options').filter((o) => o.slot_id === slot.id).map((o) => o.venue_id))
    const spare = (await kim.api.searchVenuesForSlot(id, slot.id, 'a')).filter((r) => !r.unfit && !offered.has(r.id))
    for (const r of spare) {
      if (count() >= 6) break
      await kim.api.addOption(id, slot.id, r.id)
    }
    expect(count()).toBe(6)
    const extra = (await kim.api.searchVenuesForSlot(id, slot.id, 'a')).find((r) => !r.unfit && !r.added)
    expect(extra).toBeTruthy()
    await expect(kim.api.addOption(id, slot.id, extra.id)).rejects.toMatchObject({ message: 'A category holds up to 6 places.', code: 'slot_full' })
    await kim.api.addMoreOptions(id, slot.id)
    expect(count()).toBe(6)
    expect(bySlot(await kim.api.getPlan(id), slot.category)).toMatchObject({ canAddMore: false })
  })

  it('asks for more places with the number it shows, so asking twice adds them once', async () => {
    const { w, sam, id, slot } = await voting()
    const shown = slot.options.length
    await sam.api.addMoreOptions(id, slot.id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'moreOptions', body: { have: shown } })
    const grown = bySlot(await sam.api.getPlan(id), slot.category).options.length
    expect(grown).toBeGreaterThanOrEqual(shown)
    expect(grown).toBeLessThanOrEqual(6)
    // The same ask again, with the number the person was looking at, adds nothing more.
    const again = w.server.calls.length
    await sam.api.addMoreOptions(id, slot.id)
    expect(w.server.calls.slice(again).find((c) => c.route === 'moreOptions').body.have).toBe(grown)
  })

  it('swaps a place for another and the votes for it follow', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const from = idsOf(slot)[0]
    const to = (await kim.api.searchVenuesForSlot(id, slot.id, 'a')).find((r) => !r.unfit && !r.added)
    await sam.api.vote(id, slot.id, sam.id, from)
    await kim.api.swapOption(id, slot.id, from, to.id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'swapOption', path: `/api/sessions/${id}/slots/${slot.id}/options/${from}/swap`, body: { toVenueId: to.id } })
    const seen = await sam.api.getPlan(id)
    const card = bySlot(seen, slot.category)
    expect(idsOf(card)).toContain(to.id)
    expect(idsOf(card)).not.toContain(from)
    expect(card).toMatchObject({ myVote: to.id })
    expect(rowsOf(w, 'votes')).toMatchObject([{ venue_id: to.id }])
    await expect(kim.api.swapOption(id, slot.id, 'gone', 'also-gone')).rejects.toMatchObject({ code: 'option_not_found', message: 'That place is no longer an option.' })
    // A repeat of the swap that was made is a no-op, not an error.
    await expect(kim.api.swapOption(id, slot.id, from, to.id)).resolves.toBeTruthy()
  })

  it('lets the host remove a category and bring it back, with its places and votes, and nobody else', async () => {
    const { w, sam, kim, id, slot } = await voting()
    await sam.api.vote(id, slot.id, sam.id, idsOf(slot)[0])
    await expect(kim.api.deleteSlot(id, slot.id)).rejects.toMatchObject({ message: 'Only the host can remove or bring back a category.', code: 'host_only' })
    await sam.api.deleteSlot(id, slot.id)
    const gone = await kim.api.getPlan(id)
    expect(gone.slots.map((s) => s.id)).not.toContain(slot.id)
    expect(gone.deletedSlots).toEqual([slot.category])
    expect(rowsOf(w, 'votes')).toEqual([])
    await expect(kim.api.restoreSlots(id)).rejects.toMatchObject({ code: 'host_only' })
    await sam.api.restoreSlots(id)
    const back = await kim.api.getPlan(id)
    expect(back.slots.map((s) => s.id)).toContain(slot.id)
    expect(bySlot(back, slot.category).options.length).toBeGreaterThan(0)
  })

  it('says what is wrong in plain words when the session is no longer voting, and the group moved on', async () => {
    const { w, sam, id, slot } = await voting()
    await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    await expect(sam.api.setRadius(id, 500)).rejects.toMatchObject({ message: 'Places can only change while the group is voting.', code: 'wrong_status' })
    await expect(sam.api.addMoreOptions(id, slot.id)).rejects.toMatchObject({ message: 'Places can only change while the group is voting.' })
  })

  it('words a busy server and keeps nothing changed here', async () => {
    const { w, sam, id, slot } = await voting()
    w.server.after.addOption = async () => {
      delete w.server.after.addOption
      rowsOf(w, 'sessions').find((x) => x.id === id).plan_version += 1
    }
    const spare = (await sam.api.searchVenuesForSlot(id, slot.id, 'a')).find((r) => !r.unfit && !r.added)
    await expect(sam.api.addOption(id, slot.id, spare.id)).rejects.toMatchObject({ code: 'plan_busy', message: 'Jio is busy with another change to this session. Try again in a moment.' })
    expect(rowsOf(w, 'slot_options').some((o) => o.venue_id === spare.id)).toBe(false)
  })
})

describe('when a start changes while the group is voting', () => {
  it('moves an unpinned area and clears the votes, with a banner; the places are made again around the new area', async () => {
    const { w, sam, kim, id, plan } = await voting()
    rowsOf(w, 'sessions').find((s) => s.id === id).meeting_method = 'fairest'
    for (const s of plan.slots) await sam.api.vote(id, s.id, sam.id, s.options[0].id)
    const was = (await kim.api.getSession(id)).meeting.areaId
    await kim.api.setLocation(id, kim.id, 'start', { areaId: 'woodlands', label: 'Causeway Point' })
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'meetingArea', body: { trigger: 'start' } })
    const after = await sam.api.getSession(id)
    expect(after.meeting.areaId).not.toBe(was)
    expect(after.status).toBe('voting')
    expect(rowsOf(w, 'votes')).toEqual([])
    expect(after.banner).toMatchObject({ votesCleared: true })
    expect(after.banner.text).toContain('Votes for places were cleared.')
    const again = await kim.api.getPlan(id)
    expect(again.area.id).toBe(after.meeting.areaId)
    expect(again.slots.every((s) => s.options.length > 0)).toBe(true)
    expect(again.voters).toEqual([])
  })

  it('keeps a pinned area and its votes and changes the travel times only', async () => {
    const { w, sam, kim, id, plan } = await voting()
    expect(rowsOf(w, 'sessions').find((s) => s.id === id).meeting_method).toBe('chosen')
    await sam.api.vote(id, plan.slots[0].id, sam.id, plan.slots[0].options[0].id)
    const before = await kim.api.getSession(id)
    await kim.api.setLocation(id, kim.id, 'start', { areaId: 'woodlands', label: 'Causeway Point' })
    const after = await sam.api.getSession(id)
    expect(after.meeting.areaId).toBe(before.meeting.areaId)
    expect(after.meeting.times[kim.id]).not.toBe(before.meeting.times[kim.id])
    expect(rowsOf(w, 'votes')).toHaveLength(1)
    expect(after.banner).toBeNull()
  })

  it('keeps the start and does not fail when the server has nothing to do for it (an older server answers not_yet)', async () => {
    const { w, kim, id } = await voting()
    w.server.after.meetingArea = async () => {}
    const was = rowsOf(w, 'session_members').find((m) => m.user_id === kim.id).start_area_id
    await kim.api.setLocation(id, kim.id, 'start', { areaId: 'clementi', label: 'Clementi Mall' })
    expect(rowsOf(w, 'session_members').find((m) => m.user_id === kim.id).start_area_id).toBe('clementi')
    expect(was).not.toBe('clementi')
  })
})

describe('opting out and rejoining while voting', () => {
  it('takes the person\'s votes when they opt out, and the group sees it; they cannot vote until they rejoin', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const a = idsOf(slot)[0]
    await kim.api.vote(id, slot.id, kim.id, a)
    await sam.api.vote(id, slot.id, sam.id, a)
    await kim.api.optOut(id, kim.id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'optOut', as: kim.id })
    expect(rowsOf(w, 'votes').map((v) => v.user_id)).toEqual([sam.id])
    const seen = await sam.api.getPlan(id)
    expect(seen.voters).toEqual([sam.id])
    expect((await sam.api.getSession(id)).activeIds).toEqual([sam.id])
    await expect(kim.api.vote(id, slot.id, kim.id, a)).rejects.toMatchObject({ code: 'not_joined' })
    await kim.api.rejoinSession(id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'rejoin', as: kim.id })
    await kim.api.vote(id, slot.id, kim.id, a)
    expect(rowsOf(w, 'votes')).toHaveLength(2)
  })

  it('does not count a vote of someone who is out, even if a row is left behind', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const a = idsOf(slot)[0]
    await kim.api.vote(id, slot.id, kim.id, a)
    await w.database.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('user_id', kim.id)] })
    const seen = await sam.api.getPlan(id)
    expect(bySlot(seen, slot.category)).toMatchObject({ totalVotes: 0 })
    expect(seen.voters).toEqual([])
  })

  it('counts it nowhere else either: not in the session Home reads, its slots, or the votes-only reads (the accepted race: a vote cast as the person opted out)', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const a = idsOf(slot)[0]
    await kim.api.vote(id, slot.id, kim.id, a)
    await sam.api.getSession(id)
    await sam.api.getPlan(id)
    expect((await sam.api.getSession(id)).slots.map((x) => x.id)).toEqual([slot.id])
    // Kim opts out, and a row of hers is left behind (the vote and the opt-out crossed). Nothing reads it as a vote.
    await w.database.run({ as: SERVICE, kind: 'update', table: 'session_members', values: { state: 'opted_out' }, filters: [eq('user_id', kim.id)] })
    expect(rowsOf(w, 'votes')).toHaveLength(1)
    for (const read of [await sam.api.getSession(id), await sam.api.getSession(id, { votesOnly: true }), (await sam.api.listSessions()).find((x) => x.id === id)]) {
      expect(read.votes).toEqual({})
      expect(read.slots).toEqual([])
    }
    // (A change of who is in the session is heard as a change to the session, which reads the plan whole; the votes-only read that
    // follows a vote uses who was in it then.)
    expect(bySlot(await sam.api.getPlan(id), slot.category)).toMatchObject({ totalVotes: 0 })
    const plan = await sam.api.getPlan(id, { votesOnly: true })
    expect(bySlot(plan, slot.category)).toMatchObject({ totalVotes: 0 })
    expect(plan.voters).toEqual([])
    expect(plan.planned).toEqual([])
  })
})

describe('a late answer never goes over a newer state', () => {
  it('hands back the newer plan when an older read answers after it', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const a = idsOf(slot)[0]
    // The first read goes all the way to the votes (none yet), and the answer to that last read is held. A vote and a second read go
    // through; then the first answers, with the votes it saw before the vote was cast.
    let release
    const held = new Promise((resolve) => { release = resolve })
    let first = true
    w.gate.hold = (op) => {
      if (first && op.kind === 'select' && op.table === 'votes') {
        first = false
        return held
      }
      return null
    }
    const old = sam.api.getPlan(id)
    await vi.waitFor(() => expect(first).toBe(false))
    await kim.api.vote(id, slot.id, kim.id, a)
    const fresh = await sam.api.getPlan(id)
    expect(bySlot(fresh, slot.category).totalVotes).toBe(1)
    release()
    const late = await old
    // The old read began before the vote, but what it hands back is the newer plan.
    expect(bySlot(late, slot.category).totalVotes).toBe(1)
    expect(late.voters).toEqual([kim.id])
    w.gate.hold = null
  })

  it('drops a plan read for the account before when the signed-in person changes while it is out', async () => {
    const { w, sam, id } = await voting()
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.kind === 'select' && op.table === 'slots' ? held : null)
    const pending = sam.api.getPlan(id).catch((e) => e)
    await new Promise((resolve) => setTimeout(resolve, 10))
    await sam.api.signOut()
    w.gate.hold = null
    release()
    const result = await pending
    expect(result).toBeInstanceOf(Error)
  })

  it('a planner answer worked out for a session that has since moved on is refused by the server and applied nowhere', async () => {
    const { w, sam, id } = await voting()
    w.server.after.moreOptions = async () => {}
    w.server.after.radius = async () => {
      delete w.server.after.radius
      await w.database.run({ as: SERVICE, kind: 'update', table: 'sessions', values: { status: 'confirmed' }, filters: [eq('id', id)] })
    }
    await expect(sam.api.setRadius(id, 500)).rejects.toMatchObject({ code: 'wrong_status' })
    expect(rowsOf(w, 'sessions').find((s) => s.id === id).radius_meters).toBeNull()
  })
})

describe('picks for the plan', () => {
  it('writes the person\'s categories and stay, then asks the server to sync, and shows the picks', async () => {
    const { w, kim, id } = await voting()
    const done = await kim.api.setPreferences(id, kim.id, { categories: ['eat', 'drink'], until: 17 * 60 })
    expect(rowsOf(w, 'session_members').find((m) => m.user_id === kim.id)).toMatchObject({ categories: ['eat', 'drink'], stay_until: '17:00:00' })
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'syncPlan', as: kim.id })
    expect(done.prefs[kim.id]).toEqual({ categories: ['eat', 'drink'], until: 1020 })
    expect((await kim.api.getPlan(id)).counts).toMatchObject({ eat: 1, drink: 1, shop: 0 })
  })

  it('puts the picks back, only where they still stand, when the server turns the request away', async () => {
    const { w, kim, id } = await voting()
    await kim.api.setPreferences(id, kim.id, { categories: ['shop'], until: null })
    w.server.after.syncPlan = async () => {
      delete w.server.after.syncPlan
      rowsOf(w, 'sessions').find((s) => s.id === id).plan_version += 1
    }
    await expect(kim.api.setPreferences(id, kim.id, { categories: ['eat'], until: 900 })).rejects.toMatchObject({ code: 'plan_busy' })
    expect(rowsOf(w, 'session_members').find((m) => m.user_id === kim.id)).toMatchObject({ categories: ['shop'], stay_until: null })
  })

  it('keeps the picks, and says so, when the server cannot be reached', async () => {
    const { w, kim, id } = await voting()
    w.server.down = true
    await expect(kim.api.setPreferences(id, kim.id, { categories: ['eat'], until: null })).rejects.toMatchObject({ code: 'saved_not_synced', message: 'Your choices are saved. The places may take a moment to update.' })
    expect(rowsOf(w, 'session_members').find((m) => m.user_id === kim.id).categories).toEqual(['eat'])
  })

  it('does not write for someone else', async () => {
    const { w, sam, kim, id } = await voting()
    await expect(kim.api.setPreferences(id, sam.id, { categories: ['eat'], until: null })).rejects.toThrow("You can't do that in this session.")
    expect(rowsOf(w, 'session_members').every((m) => m.categories.length === 0)).toBe(true)
  })
})

describe('what no one else sees', () => {
  it('shows no one another member\'s exact place: not in the plan, the session, the live frames or the requests', async () => {
    const { w, sam, kim, id, slot } = await voting()
    const heard = []
    sam.api.subscribe((event) => heard.push(event))
    const frames = []
    w.database.subscribe({ as: sam.id, table: 'sessions', event: '*' }, (p) => frames.push(p))
    w.database.subscribe({ as: sam.id, table: 'votes', event: '*' }, (p) => frames.push(p))
    w.database.subscribe({ as: sam.id, table: 'session_members', event: '*' }, (p) => frames.push(p))
    await kim.api.vote(id, slot.id, kim.id, idsOf(slot)[0])
    await kim.api.setLocation(id, kim.id, 'end', { areaId: 'bishan', label: 'Blk 123 Bishan St 12, #05-67' })
    const everything = JSON.stringify([await sam.api.getPlan(id), await sam.api.getSession(id), await sam.api.listSessions(), heard, frames, w.server.calls.filter((c) => c.as === sam.id)])
    expect(everything).not.toContain('Blk 123')
    expect(everything).not.toContain(KIM_PLACE.label)
    // Sam's own label is his to see, and nobody else's: the reads name Sam's id for the places table.
    const placeReads = w.ops.filter((op) => op.table === 'session_member_places' && op.as === sam.id && op.kind === 'select')
    expect(placeReads.length).toBeGreaterThan(0)
    for (const op of placeReads) expect(op.filters).toContainEqual({ col: 'user_id', op: 'eq', value: sam.id })
    expect(JSON.stringify(await sam.api.getSession(id))).toContain(SAM_PLACE.label)
    // The plan read asks for no place at all.
    w.ops.length = 0
    await sam.api.getPlan(id)
    expect(new Set(w.ops.map((op) => op.table))).toEqual(new Set(['sessions', 'session_members', 'slots', 'slot_options', 'votes']))
    expect(w.ops.find((op) => op.table === 'session_members').columns).not.toMatch(/area_id|label/)
  })
})
