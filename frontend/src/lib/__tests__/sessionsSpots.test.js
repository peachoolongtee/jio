// Stage 3 of moving sessions to the database: where people start, the meeting spots, "Works for me", the host's confirm and a known
// place, for a real account. Two or three people use their own copy of the app on ONE stand-in database (components/dev/
// fakeDatabase.js) and one stand-in Jio server (./fakeSessionsServer.js, an axios adapter on the real planner client), so what one
// does the others see, and the paths, bodies and login tokens are the real ones. No network.
//
// The rules that must hold are each a test: the group sees areas only and never another member's exact place; a late answer never
// undoes a confirmation; a failed write takes back only its own change; the demo account is not touched (its suites run unchanged).
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { OTHER, PROFILE, SESSION } from './authFixture.js'
import { SERVICE } from '../../components/dev/fakeDatabase.js'
import { tripMinutes } from './fakeSessionsServer.js'
import { nextStepFor } from '../homeMeetups.js'
import { KIM_PLACE, SAM_PLACE, THIRD, locating, world } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())

const rowsOf = (w, table) => w.database.tables[table]
const memberRow = (w, id, user) => rowsOf(w, 'session_members').find((m) => m.session_id === id && m.user_id === user)
const placeRow = (w, id, user) => rowsOf(w, 'session_member_places').find((p) => p.session_id === id && p.user_id === user)
const spotAreas = (session) => session.spots.list.map((s) => s.areaId)

describe('where a person starts', () => {
  it('saves the area on their member row and the label in their own place row, then asks the server once', async () => {
    const { w, sam, id } = await locating()
    const made = await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    expect(memberRow(w, id, sam.id)).toMatchObject({ start_area_id: 'tampines', end_area_id: null })
    // The exact place is a label only: no coordinate is ever written.
    expect(placeRow(w, id, sam.id)).toMatchObject({ start_label: SAM_PLACE.label, start_lat: null, start_lng: null, end_label: null })
    expect(w.server.calls.map((c) => [c.route, c.body, c.as])).toEqual([['meetingArea', { trigger: 'added' }, sam.id]])
    expect(made.locations[sam.id].start).toMatchObject({ areaId: 'tampines', name: 'Tampines', label: SAM_PLACE.label })

    // A change is a 'start', and an end is an 'end'.
    await sam.api.setLocation(id, sam.id, 'start', { areaId: 'bugis', label: 'Bugis Junction' })
    await sam.api.setLocation(id, sam.id, 'end', { areaId: 'orchard', label: 'Orchard Road' })
    expect(w.server.calls.map((c) => c.body.trigger)).toEqual(['added', 'start', 'end'])
    expect(memberRow(w, id, sam.id)).toMatchObject({ start_area_id: 'bugis', end_area_id: 'orchard' })
    expect(placeRow(w, id, sam.id)).toMatchObject({ start_label: 'Bugis Junction', end_label: 'Orchard Road' })
  })

  it('clears an end with null, and keeps the label as the area name when none is given', async () => {
    const { w, sam, id } = await locating()
    await sam.api.setLocation(id, sam.id, 'end', { areaId: 'orchard' })
    expect(placeRow(w, id, sam.id)).toMatchObject({ end_label: 'Orchard' })
    const cleared = await sam.api.setLocation(id, sam.id, 'end', null)
    expect(memberRow(w, id, sam.id).end_area_id).toBeNull()
    expect(cleared.locations[sam.id]?.end ?? null).toBeNull()
  })

  it('shows both devices the same three spots, with both people\'s minutes from the areas\' centres', async () => {
    const { sam, kim, id } = await locating({ places: true })
    const a = await sam.api.getSession(id)
    const b = await kim.api.getSession(id)
    expect(spotAreas(a)).toEqual(spotAreas(b))
    expect(a.spots.list).toHaveLength(3)
    for (const spot of a.spots.list) {
      expect(spot.by).toBe('app')
      expect(spot.times).toEqual({ [sam.id]: Math.round(tripMinutes('tampines', spot.areaId)), [kim.id]: Math.round(tripMinutes('bishan', spot.areaId)) })
      expect(spot.worstMinutes).toBe(Math.max(...Object.values(spot.times)))
      expect(spot.area.name).toBeTruthy()
    }
    expect(a.spots.appMethod).toBe('fairest')
    expect(b.spots.list.map((s) => s.times)).toEqual(a.spots.list.map((s) => s.times))
    // The list of sessions (Home) carries the same, so a refresh of it never blanks the Locate step.
    const [listed] = await kim.api.listSessions()
    expect(spotAreas(listed)).toEqual(spotAreas(a))
    expect(listed.spots.list.map((s) => s.times)).toEqual(a.spots.list.map((s) => s.times))
    expect(Object.keys(listed.locations).sort()).toEqual([sam.id, kim.id].sort())
    // The fairest first: the longest trip never gets longer down the list.
    const worst = a.spots.list.map((s) => s.worstMinutes)
    expect([...worst].sort((x, y) => x - y)).toEqual(worst)
  })

  it('says so, and changes nothing, for someone else\'s start or an area Jio does not know', async () => {
    const { w, sam, kim, id } = await locating()
    await expect(kim.api.setLocation(id, sam.id, 'start', SAM_PLACE)).rejects.toThrow("You can't do that in this session.")
    await expect(kim.api.setLocation(id, kim.id, 'start', { areaId: 'atlantis', label: 'x' })).rejects.toThrow('This area does not exist.')
    expect(rowsOf(w, 'session_members').every((m) => m.start_area_id === null)).toBe(true)
    expect(w.server.calls).toEqual([])
  })

  it('takes back only its own change when the server cannot be reached, and tells the person', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const kimBefore = { member: { ...memberRow(w, id, kim.id) }, place: { ...placeRow(w, id, kim.id) } }
    const spotsBefore = structuredClone(rowsOf(w, 'session_spots'))
    w.server.down = true
    await expect(sam.api.setLocation(id, sam.id, 'start', { areaId: 'jurong-east', label: 'Jurong East Mall' })).rejects.toThrow(/Cannot reach the Jio planner/)
    // Sam's start is back to what it was, in both places; Kim's is untouched; the spots are as they were.
    expect(memberRow(w, id, sam.id).start_area_id).toBe('tampines')
    expect(placeRow(w, id, sam.id).start_label).toBe(SAM_PLACE.label)
    expect(memberRow(w, id, kim.id)).toEqual(kimBefore.member)
    expect(placeRow(w, id, kim.id)).toEqual(kimBefore.place)
    expect(rowsOf(w, 'session_spots')).toEqual(spotsBefore)
  })

  it('takes a first start back to nothing, and the server\'s refusal in words', async () => {
    const { w, sam, id } = await locating()
    w.server.down = true
    await expect(sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)).rejects.toThrow(/Cannot reach the Jio planner/)
    expect(memberRow(w, id, sam.id).start_area_id).toBeNull()
    expect(placeRow(w, id, sam.id)).toMatchObject({ start_label: null })
    w.server.down = false
    // The session was cancelled meanwhile: the database refuses the write, and says it plainly.
    await sam.api.cancelSession(id)
    await expect(sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)).rejects.toThrow("You can't do that in this session.")
    expect(memberRow(w, id, sam.id).start_area_id).toBeNull()
    // Clearing a start has no place to write, so the member row's own refusal is the one heard.
    await expect(sam.api.setLocation(id, sam.id, 'start', null)).rejects.toThrow("Where you start can't be changed now.")
  })

  it('keeps what it saved when the host confirmed while the server was working, and applies nothing it worked out', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const first = (await sam.api.getSession(id)).spots.list[0].areaId
    // After the server has read the session and before it writes, the host confirms.
    w.server.after.meetingArea = async () => {
      delete w.server.after.meetingArea
      await sam.api.confirmSpot(id, first)
    }
    const spotsAtConfirm = () => structuredClone(rowsOf(w, 'session_spots'))
    const done = await kim.api.setLocation(id, kim.id, 'start', { areaId: 'jurong-east', label: 'Jurong East Mall' })
    // The write is kept (it only adds a travel time) and the person is not told off; the session is voting at the host's spot.
    expect(done.status).toBe('voting')
    expect(done.meeting.areaId).toBe(first)
    expect(memberRow(w, id, kim.id).start_area_id).toBe('jurong-east')
    expect(rowsOf(w, 'sessions')[0]).toMatchObject({ status: 'voting', meeting_area_id: first })
    // What the server worked out for the group as it was is not in the list: the spots are those the host confirmed from.
    const bishanTrips = rowsOf(w, 'session_spots').map((s) => Math.round(s.travel_minutes[kim.id]))
    expect(bishanTrips).toEqual(spotsAtConfirm().map((s) => Math.round(tripMinutes('bishan', s.area_id))))
  })

  it('never shows a session as locating again after a newer read saw it confirmed, whatever order the reads answer in', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const spot = (await sam.api.getSession(id)).spots.list[0].areaId
    // Kim's first read of the session is held after the database has answered it (it holds "locating").
    let release
    const blocked = new Promise((resolve) => { release = resolve })
    let held = false
    w.gate.hold = (op) => {
      if (!held && op.as === kim.id && op.table === 'sessions' && op.kind === 'select') {
        held = true
        return blocked
      }
    }
    const stale = kim.api.getSession(id)
    await vi.waitFor(() => expect(held).toBe(true))
    await sam.api.confirmSpot(id, spot)
    const fresh = await kim.api.getSession(id)
    expect(fresh.status).toBe('voting')
    release()
    const late = await stale
    expect(late.status).toBe('voting')
    expect(late.meeting.areaId).toBe(spot)
    // The same for the list of sessions that began before the confirm.
    const list = await kim.api.listSessions()
    expect(list[0].status).toBe('voting')
  })
})

describe('what the group sees of a start', () => {
  it('is the area, never another member\'s exact place: not in what they read, not in what they ask for', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const seenBySam = JSON.stringify([await sam.api.getSession(id), await sam.api.listSessions()])
    expect(seenBySam).toContain(SAM_PLACE.label)
    expect(seenBySam).not.toContain('Blk 123')
    expect(seenBySam).not.toContain(KIM_PLACE.label)
    const kimsStart = (await sam.api.getSession(id)).locations[kim.id].start
    expect(kimsStart).toMatchObject({ areaId: 'bishan', name: 'Bishan' })
    expect(kimsStart).not.toHaveProperty('label')
    // Kim sees her own address, and Sam's as an area.
    const seenByKim = await kim.api.getSession(id)
    expect(seenByKim.locations[kim.id].start.label).toBe(KIM_PLACE.label)
    expect(seenByKim.locations[sam.id].start).not.toHaveProperty('label')
    expect(JSON.stringify(seenByKim)).not.toContain(SAM_PLACE.label)
  })

  it('asks the database only for the person\'s own labels, with their own id, and never for a coordinate', async () => {
    const { w, sam, id } = await locating({ places: true })
    w.ops.length = 0
    await sam.api.getSession(id)
    await sam.api.listSessions()
    const placeReads = w.ops.filter((op) => op.table === 'session_member_places')
    expect(placeReads.length).toBeGreaterThan(0)
    for (const op of placeReads) {
      expect(op.kind).toBe('select')
      expect(op.as).toBe(sam.id)
      expect(op.filters).toContainEqual({ col: 'user_id', op: 'eq', value: sam.id })
      expect(op.columns).toBe('session_id, start_label, end_label')
    }
    // The database itself gives a person only their own row, whatever is asked.
    const everything = await w.database.run({ as: sam.id, kind: 'select', table: 'session_member_places', columns: '*', filters: [] })
    expect(everything.data.map((p) => p.user_id)).toEqual([sam.id])
  })

  it('is not listened to: the exact places, the spot list and the suggestions raise no live update, and the marks do', async () => {
    const { w, sam } = await locating({ places: true })
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(w.subscriptions.some((s) => s.table === 'spot_approvals')).toBe(true))
    const tables = new Set(w.subscriptions.map((s) => s.table))
    expect(tables.has('spot_approvals')).toBe(true)
    for (const table of ['session_member_places', 'session_spots', 'spot_suggestions']) expect(tables.has(table)).toBe(false)
    stop()
  })
})

describe('suggesting a spot', () => {
  it('lists it for both people with everyone\'s minutes, marks "here already", and says who suggested it', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const made = await kim.api.suggestSpot(id, kim.id, 'orchard', { here: true })
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'putSpot', body: { areaId: 'orchard', here: true }, as: kim.id })
    const orchard = made.spots.list.find((s) => s.areaId === 'orchard')
    expect(orchard).toMatchObject({ by: kim.id, byName: 'Kim', here: true })
    expect(orchard.times).toEqual({ [sam.id]: Math.round(tripMinutes('tampines', 'orchard')), [kim.id]: Math.round(tripMinutes('bishan', 'orchard')) })
    expect(made.spots.suggestions[kim.id]).toEqual({ areaId: 'orchard', here: true })
    // Sam sees the same, with the app's spots first.
    const seen = await sam.api.getSession(id)
    expect(spotAreas(seen).at(-1)).toBe('orchard')
    expect(seen.spots.list.slice(0, 3).every((s) => s.by === 'app')).toBe(true)
  })

  it('replaces the earlier suggestion, takes its approvals with it and leaves a banner that says so', async () => {
    const { sam, kim, id } = await locating({ places: true })
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    await sam.api.approveSpot(id, sam.id, 'orchard', true)
    expect((await kim.api.getSession(id)).spots.list.find((s) => s.areaId === 'orchard').approvalCount).toBe(1)
    const after = await kim.api.suggestSpot(id, kim.id, 'punggol')
    expect(spotAreas(after)).not.toContain('orchard')
    expect(spotAreas(after)).toContain('punggol')
    const seenBySam = await sam.api.getSession(id)
    expect(seenBySam.spots.approvals[sam.id] ?? []).not.toContain('orchard')
    expect(seenBySam.banner).toMatchObject({ approvalsRemoved: true })
    expect(seenBySam.banner.text).toContain('approvals for it were removed')
  })

  it('withdraws it, and withdrawing again is a quiet no-op', async () => {
    const { sam, kim, id } = await locating({ places: true })
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    const after = await kim.api.withdrawSpot(id, kim.id)
    expect(spotAreas(after)).not.toContain('orchard')
    expect(after.spots.suggestions[kim.id]).toBeUndefined()
    await expect(kim.api.withdrawSpot(id, kim.id)).resolves.toMatchObject({ status: 'locating' })
    expect(spotAreas(await sam.api.getSession(id))).not.toContain('orchard')
  })

  it('does not list an area twice when a member suggests one the app already lists', async () => {
    const { kim, id } = await locating({ places: true })
    const [first] = (await kim.api.getSession(id)).spots.list
    const after = await kim.api.suggestSpot(id, kim.id, first.areaId, { here: true })
    expect(after.spots.list.filter((s) => s.areaId === first.areaId)).toHaveLength(1)
    expect(after.spots.list.find((s) => s.areaId === first.areaId)).toMatchObject({ by: 'app', here: true })
    expect(after.spots.list).toHaveLength(3)
  })

  it('says why not, in words, for each refusal', async () => {
    const { w, sam, kim, id } = await locating()
    // Two starts are needed first.
    await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    await expect(sam.api.suggestSpot(id, sam.id, 'orchard')).rejects.toMatchObject({ message: 'Spots open once two people have shared where they start.', code: 'no_spots' })
    await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
    await expect(sam.api.suggestSpot(id, sam.id, 'atlantis')).rejects.toThrow('This area does not exist.')
    await expect(kim.api.suggestSpot(id, sam.id, 'orchard')).rejects.toThrow("You can't do that in this session.")
    // Eight different areas are the most; Sam is one more.
    const { token } = await sam.api.makeInviteLink(id)
    const names = ['orchard', 'bugis', 'punggol', 'woodlands', 'clementi', 'jurong-east', 'toa-payoh', 'novena']
    for (const [i, area] of names.entries()) {
      const user = `00000000-0000-4000-8000-0000000003${String(i).padStart(2, '0')}`
      w.database.setProfile(user, { username: `g${i}`, display_name: `G${i}`, avatar_url: null })
      await w.database.run({ as: user, kind: 'rpc', fn: 'join_session', args: { invite_token: token } })
      await w.database.run({ as: SERVICE, kind: 'insert', table: 'spot_suggestions', values: { session_id: id, user_id: user, area_id: area } })
    }
    await expect(sam.api.suggestSpot(id, sam.id, 'changi-airport')).rejects.toMatchObject({ code: 'too_many_spots', message: 'The group can suggest up to 8 different spots. Ask someone to withdraw theirs first.' })
    // And after the host confirms, the group is not choosing any more.
    await sam.api.confirmSpot(id, (await sam.api.getSession(id)).spots.list[0].areaId)
    await expect(kim.api.suggestSpot(id, kim.id, 'orchard')).rejects.toThrow('Spots can only change while the group is choosing where to meet.')
    await expect(kim.api.withdrawSpot(id, kim.id)).rejects.toThrow('Spots can only change while the group is choosing where to meet.')
  })
})

describe('"Works for me"', () => {
  it('is the person\'s own row in the database, with no call to the server, and works with the server down', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const spots = (await kim.api.getSession(id)).spots.list.map((s) => s.areaId)
    w.server.calls.length = 0
    w.server.down = true
    await kim.api.approveSpot(id, kim.id, spots[0], true)
    await kim.api.approveSpot(id, kim.id, spots[1], true)
    expect(w.server.calls).toEqual([])
    expect(rowsOf(w, 'spot_approvals').map((a) => [a.area_id, a.user_id])).toEqual([[spots[0], kim.id], [spots[1], kim.id]])
    w.server.down = false
    // Any number of spots per person; Sam sees who, by name.
    const seen = await sam.api.getSession(id)
    const first = seen.spots.list.find((s) => s.areaId === spots[0])
    expect(first.approvalCount).toBe(1)
    expect(first.approvedBy).toEqual([{ id: kim.id, name: 'Kim' }])
    expect(seen.spots.approvals[kim.id]).toEqual([spots[0], spots[1]])
  })

  it('counts approving twice as one, and takes it back with on: false', async () => {
    const { w, kim, id } = await locating({ places: true })
    const [spot] = (await kim.api.getSession(id)).spots.list
    await kim.api.approveSpot(id, kim.id, spot.areaId, true)
    const again = await kim.api.approveSpot(id, kim.id, spot.areaId, true)
    expect(rowsOf(w, 'spot_approvals')).toHaveLength(1)
    expect(again.spots.list[0].approvalCount).toBe(1)
    const off = await kim.api.approveSpot(id, kim.id, spot.areaId, false)
    expect(rowsOf(w, 'spot_approvals')).toHaveLength(0)
    expect(off.spots.list[0].approvalCount).toBe(0)
    await expect(kim.api.approveSpot(id, kim.id, spot.areaId, false)).resolves.toBeTruthy()
  })

  it('refuses a spot that is not on the list, someone else\'s approval, and any change once the host confirmed', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const [spot] = (await kim.api.getSession(id)).spots.list
    await expect(kim.api.approveSpot(id, kim.id, 'woodlands', true)).rejects.toMatchObject({ message: 'That spot is not on the list any more.', code: 'spot_not_found' })
    await expect(kim.api.approveSpot(id, sam.id, spot.areaId, true)).rejects.toThrow("You can't do that in this session.")
    // Even asked directly, the database refuses to put a mark in another person's name.
    const forged = await w.database.run({ as: kim.id, kind: 'insert', table: 'spot_approvals', values: { session_id: id, area_id: spot.areaId, user_id: sam.id } })
    expect(forged.error).toMatchObject({ code: '42501' })
    await sam.api.confirmSpot(id, spot.areaId)
    await expect(kim.api.approveSpot(id, kim.id, spot.areaId, true)).rejects.toMatchObject({ message: 'Spots can only change while the group is choosing where to meet.', code: 'wrong_status' })
    expect(rowsOf(w, 'spot_approvals')).toHaveLength(0)
  })

  it('preselects the most approved spot for the host, and a tie goes to the shortest longest trip before rounding', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const list = (await sam.api.getSession(id)).spots.list
    expect(list.length).toBeGreaterThanOrEqual(3)
    // No approvals: the app's own first spot.
    expect((await sam.api.getSession(id)).spots.preselectedAreaId).toBe(list[0].areaId)
    await kim.api.approveSpot(id, kim.id, list[2].areaId, true)
    expect((await sam.api.getSession(id)).spots.preselectedAreaId).toBe(list[2].areaId)
    // Two spots with one approval each whose longest trips both round to 20: the exact one decides, not the list's order.
    for (const [i, spot] of list.slice(0, 2).entries()) {
      const worst = i === 0 ? 20.4 : 20.2
      const travel = { [sam.id]: worst, [kim.id]: 10 }
      await w.database.run({ as: SERVICE, kind: 'update', table: 'session_spots', values: { worst_minutes: worst, mean_minutes: 15, travel_minutes: travel }, filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'area_id', op: 'eq', value: spot.areaId }] })
    }
    await w.database.run({ as: kim.id, kind: 'delete', table: 'spot_approvals', filters: [{ col: 'area_id', op: 'eq', value: list[2].areaId }] })
    await sam.api.approveSpot(id, sam.id, list[0].areaId, true)
    await kim.api.approveSpot(id, kim.id, list[1].areaId, true)
    const seen = await sam.api.getSession(id)
    expect(seen.spots.list.slice(0, 2).map((s) => s.worstMinutes)).toEqual([20, 20])
    expect(seen.spots.preselectedAreaId).toBe(list[1].areaId)
  })
})

describe('the host confirms', () => {
  it('confirms the chosen spot: the session is voting for everyone, with the meeting area and each trip', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const [first, second] = (await sam.api.getSession(id)).spots.list
    await kim.api.approveSpot(id, kim.id, second.areaId, true)
    const done = await sam.api.confirmSpot(id, second.areaId)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'confirm', body: { areaId: second.areaId }, as: sam.id })
    expect(done.status).toBe('voting')
    expect(done.meeting).toMatchObject({ areaId: second.areaId, method: 'voted', times: second.times, maxMinutes: second.worstMinutes, count: 2 })
    expect(done.area.name).toBe(second.area.name)
    const theirs = await kim.api.getSession(id)
    expect(theirs.status).toBe('voting')
    expect(theirs.meeting.areaId).toBe(second.areaId)
    // The other spots stay listed as the record, with the confirmed one first.
    expect(spotAreas(theirs)).toContain(first.areaId)
  })

  it('takes the preselected spot when asked for the meeting area', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const list = (await sam.api.getSession(id)).spots.list
    await kim.api.approveSpot(id, kim.id, list[1].areaId, true)
    const done = await sam.api.useMeetingArea(id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'confirm', body: {} })
    expect(done.meeting.areaId).toBe(list[1].areaId)
    expect(done.meeting.method).toBe('voted')
  })

  it('lets only the host confirm, and says so', async () => {
    const { w, kim, id } = await locating({ places: true })
    const [spot] = (await kim.api.getSession(id)).spots.list
    await expect(kim.api.confirmSpot(id, spot.areaId)).rejects.toMatchObject({ message: 'Only the host can confirm a spot.', code: 'host_only' })
    await expect(kim.api.useMeetingArea(id)).rejects.toThrow('Only the host can confirm a spot.')
    expect(rowsOf(w, 'sessions')[0].status).toBe('locating')
  })

  it('says why not: no spots yet, a spot that is gone, a session that has moved on', async () => {
    const { sam, kim, id } = await locating()
    await expect(sam.api.useMeetingArea(id)).rejects.toMatchObject({ message: 'Spots open once two people have shared where they start.', code: 'no_spots' })
    await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
    await expect(sam.api.confirmSpot(id, 'woodlands')).rejects.toMatchObject({ message: 'That spot is not on the list any more.', code: 'spot_not_found' })
    await sam.api.useMeetingArea(id)
    await expect(sam.api.useMeetingArea(id)).rejects.toThrow('Spots can only change while the group is choosing where to meet.')
  })

  it('never lets a pending answer for the group as it was undo the confirmation (a recompute that was worked out before it)', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const spot = (await sam.api.getSession(id)).spots.list[0].areaId
    // Kim suggests an area; after the server has read the group, the host confirms. The suggestion is not applied.
    w.server.after.putSpot = async () => {
      delete w.server.after.putSpot
      await sam.api.confirmSpot(id, spot)
    }
    await expect(kim.api.suggestSpot(id, kim.id, 'orchard')).rejects.toThrow('Spots can only change while the group is choosing where to meet.')
    expect(rowsOf(w, 'sessions')[0]).toMatchObject({ status: 'voting', meeting_area_id: spot })
    expect(rowsOf(w, 'spot_suggestions')).toHaveLength(0)
    expect(rowsOf(w, 'session_spots').map((s) => s.area_id)).not.toContain('orchard')
  })
})

describe('a place the group already knows', () => {
  it('goes straight to voting from inviting, with one spot and no trips when nobody has started', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    const done = await sam.api.setKnownPlace(id, 'bugis')
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'knownPlace', body: { areaId: 'bugis' }, as: sam.id })
    expect(done.status).toBe('voting')
    expect(done.meeting).toMatchObject({ areaId: 'bugis', method: 'chosen' })
    expect(done.spots.list).toHaveLength(1)
    expect(done.spots.list[0]).toMatchObject({ areaId: 'bugis', worstMinutes: null, meanMinutes: null, times: {} })
    expect((await kim.api.getSession(id)).meeting.areaId).toBe('bugis')
  })

  it('replaces the list from locating, with trips from the areas people started in', async () => {
    const { sam, kim, id } = await locating({ places: true })
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    await kim.api.approveSpot(id, kim.id, 'orchard', true)
    const done = await sam.api.setKnownPlace(id, 'woodlands')
    expect(done.status).toBe('voting')
    expect(spotAreas(done)).toEqual(['woodlands'])
    expect(done.spots.suggestions).toEqual({})
    expect(done.spots.approvals).toEqual({})
    expect(done.spots.list[0].times).toEqual({ [sam.id]: Math.round(tripMinutes('tampines', 'woodlands')), [kim.id]: Math.round(tripMinutes('bishan', 'woodlands')) })
    expect(done.meeting.method).toBe('chosen')
  })

  it('says why not: one person, not the host, an unknown area, a session past choosing', async () => {
    const w = world()
    const sam = await w.open(PROFILE)
    const kim = await w.open(OTHER)
    const { id } = await sam.api.createSession({ ...SESSION })
    await expect(sam.api.setKnownPlace(id, 'bugis')).rejects.toMatchObject({ message: 'A session needs at least 2 people.', code: 'needs_two_people' })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    await expect(kim.api.setKnownPlace(id, 'bugis')).rejects.toMatchObject({ message: 'Only the host can set a known place.', code: 'host_only' })
    await expect(sam.api.setKnownPlace(id, 'atlantis')).rejects.toThrow('This area does not exist.')
    expect(rowsOf(w, 'sessions')[0].status).toBe('inviting')
    await sam.api.setKnownPlace(id, 'bugis')
    await expect(sam.api.setKnownPlace(id, 'orchard')).rejects.toThrow('A known place can only be set before the group votes on places.')
  })
})

describe('opting out, rejoining, leaving and removing', () => {
  it('opts a guest out: their marks and suggestion go, the spots are worked out again, and they can come back', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    await kim.api.approveSpot(id, kim.id, 'orchard', true)
    const out = await kim.api.optOut(id, kim.id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'optOut', as: kim.id })
    expect(out.members.find((m) => m.id === kim.id).state).toBe('opted_out')
    expect(rowsOf(w, 'spot_approvals')).toHaveLength(0)
    expect(rowsOf(w, 'spot_suggestions')).toHaveLength(0)
    // One start left: nothing to compare.
    expect((await sam.api.getSession(id)).spots.list).toEqual([])
    expect((await sam.api.getSession(id)).activeIds).toEqual([sam.id])
    const back = await kim.api.rejoinSession(id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'rejoin', as: kim.id })
    expect(back.members.find((m) => m.id === kim.id).state).toBe('joined')
    expect((await sam.api.getSession(id)).spots.list).toHaveLength(3)
  })

  it('does not let the host opt out, and a person opting out of a finished session is told', async () => {
    const { sam, kim, id } = await locating({ places: true })
    await expect(sam.api.optOut(id, sam.id)).rejects.toMatchObject({ message: 'The host cannot opt out.', code: 'host_cannot_opt_out' })
    await sam.api.useMeetingArea(id)
    await expect(kim.api.optOut(id, kim.id)).rejects.toThrow('This session has ended.')
    await expect(kim.api.rejoinSession(id)).resolves.toBeTruthy()
  })

  it('has the host carry on without someone by taking them out of the session', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const after = await sam.api.optOut(id, kim.id)
    expect(w.server.calls.at(-1)).toMatchObject({ route: 'removeMember', path: `/api/sessions/${id}/members/${kim.id}`, as: sam.id })
    expect(after.members.map((m) => m.id)).toEqual([sam.id])
    await expect(kim.api.getSession(id)).rejects.toMatchObject({ code: 'not_found' })
    expect(rowsOf(w, 'session_member_places').map((p) => p.user_id)).toEqual([sam.id])
    expect(after.spots.list).toEqual([])
  })

  it('lets a guest leave while the group is choosing where to meet, taking their marks and place with them', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    await kim.api.approveSpot(id, kim.id, (await kim.api.getSession(id)).spots.list[0].areaId, true)
    await kim.api.leaveSession(id)
    expect(rowsOf(w, 'session_members').map((m) => m.user_id)).toEqual([sam.id])
    expect(rowsOf(w, 'spot_approvals')).toHaveLength(0)
    expect(rowsOf(w, 'session_member_places').map((p) => p.user_id)).toEqual([sam.id])
    expect((await sam.api.getSession(id)).spots.list).toEqual([])
  })
})

describe('the banner', () => {
  it('is the group\'s, and dismissing it is the person\'s alone, until a newer one comes', async () => {
    const { sam, kim, id } = await locating({ places: true })
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    await sam.api.approveSpot(id, sam.id, 'orchard', true)
    await kim.api.withdrawSpot(id, kim.id)
    const seen = await sam.api.getSession(id)
    expect(seen.banner).toMatchObject({ approvalsRemoved: true })
    expect((await kim.api.getSession(id)).banner).toBeTruthy()
    const dismissed = await sam.api.dismissBanner(id)
    expect(dismissed.banner).toBeNull()
    expect((await sam.api.getSession(id)).banner).toBeNull()
    expect((await sam.api.listSessions())[0].banner).toBeNull()
    expect((await kim.api.getSession(id)).banner).toBeTruthy()
    // Another banner, from a later change, shows again.
    await kim.api.suggestSpot(id, kim.id, 'punggol')
    await sam.api.approveSpot(id, sam.id, 'punggol', true)
    await kim.api.withdrawSpot(id, kim.id)
    expect((await sam.api.getSession(id)).banner).toMatchObject({ approvalsRemoved: true })
  })
})

describe('a start that was saved but never priced', () => {
  it('is priced when the session is opened, once, quietly, and not by the reads that follow a live update', async () => {
    const { w, sam, kim, lee, id } = await locating({ places: true, third: true })
    // Kim's second start is written straight to the database later in the day, and the call to the server never comes.
    vi.setSystemTime(new Date('2026-10-09T10:05:00'))
    await w.database.run({ as: kim.id, kind: 'update', table: 'session_members', values: { start_area_id: 'jurong-east' }, filters: [{ col: 'session_id', op: 'eq', value: id }, { col: 'user_id', op: 'eq', value: kim.id }] })
    w.server.calls.length = 0
    // Sam has the session open already: his reads are live updates, and ask nothing.
    await sam.api.getSession(id)
    await sam.api.getSession(id)
    expect(w.server.calls).toEqual([])
    // Lee opens it. The spots are still the old ones when it is handed to him, and are priced again behind his back.
    const stale = await lee.api.getSession(id)
    expect(stale.spots.list[0].times[kim.id]).toBe(Math.round(tripMinutes('bishan', stale.spots.list[0].areaId)))
    await vi.waitFor(() => expect(w.server.calls.map((c) => [c.route, c.as])).toEqual([['meetingArea', lee.id]]))
    await vi.waitFor(async () => {
      const fresh = await lee.api.getSession(id)
      expect(fresh.spots.list[0].times[kim.id]).toBe(Math.round(tripMinutes('jurong-east', fresh.spots.list[0].areaId)))
    })
    // Once for each gap: reading it again asks nothing.
    await lee.api.getSession(id)
    expect(w.server.calls.map((c) => c.route)).toEqual(['meetingArea'])
    vi.setSystemTime(new Date('2026-10-09T10:00:00'))
  })

  it('is left alone when nothing is waiting to be priced', async () => {
    const { w, lee, id } = await locating({ places: true, third: true })
    w.server.calls.length = 0
    await lee.api.getSession(id)
    expect(w.server.calls).toEqual([])
  })
})

describe('live', () => {
  // Collect the events a copy of the app tells its screens.
  // How to call: const heard = listen(app)
  function listen(app) {
    const heard = []
    app.api.subscribe((event) => heard.push(event))
    return heard
  }
  const sessionEvents = (heard, id) => heard.filter((e) => e.type === 'session' && e.sessionId === id)

  it('tells the other device when someone says a spot works for them, takes it back, or suggests one', async () => {
    const { sam, kim, id } = await locating({ places: true })
    await sam.api.getSession(id)
    const heard = listen(sam)
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(heard.map((e) => e.type)).toContain('resync'))
    const spot = (await sam.api.getSession(id)).spots.list[0].areaId

    heard.length = 0
    await kim.api.approveSpot(id, kim.id, spot, true)
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    expect((await sam.api.getSession(id)).spots.list[0].approvalCount).toBe(1)

    heard.length = 0
    await kim.api.approveSpot(id, kim.id, spot, false)
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    expect((await sam.api.getSession(id)).spots.list[0].approvalCount).toBe(0)

    // A suggestion is the server's write: it raises the session's version, which is what is heard.
    heard.length = 0
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    await vi.waitFor(() => expect(sessionEvents(heard, id).length).toBeGreaterThan(0))
    expect(spotAreas(await sam.api.getSession(id))).toContain('orchard')
    stop()
  })

  it('shows the host the confirmation on the other device through the store, without a reload', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    const w = world()
    const kim = await w.open(OTHER)
    const sam = await w.open(PROFILE)
    const { id } = await sam.api.createSession({ ...SESSION })
    await kim.api.joinWithLink((await sam.api.makeInviteLink(id)).token)
    await sam.api.startSession(id)
    await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
    setActivePinia(createPinia())
    const { useEventsStore } = await import('@/stores/events.js')
    const events = useEventsStore()
    await events.loadSession(id)
    const stop = sam.api.watchSessions()
    await vi.waitFor(() => expect(events.byId[id].spots.list).toHaveLength(3))

    // Kim's mark and suggestion appear on Sam's store with no call from Sam.
    const first = events.byId[id].spots.list[0].areaId
    await kim.api.approveSpot(id, kim.id, first, true)
    await vi.waitFor(() => expect(events.byId[id].spots.list[0].approvalCount).toBe(1))
    await kim.api.suggestSpot(id, kim.id, 'orchard')
    await vi.waitFor(() => expect(events.byId[id].spots.list.map((s) => s.areaId)).toContain('orchard'))
    stop()
  })

  it('reads everything again when the connection comes back, for what it missed while it was away', async () => {
    const { setActivePinia, createPinia } = await import('pinia')
    const { w, sam, kim, id } = await locating({ places: true })
    // Kim's is the app opened last, so the store below is hers.
    setActivePinia(createPinia())
    const { useEventsStore } = await import('@/stores/events.js')
    const events = useEventsStore()
    await events.loadSession(id)
    kim.api.sessionsWatch.graceMs = 0
    let stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(events.byId[id].spots.list).toHaveLength(3))
    stop()
    await vi.waitFor(() => expect(kim.fake.state.dataClient.getChannels()).toHaveLength(0))
    // While the channel is closed, Sam says a spot works for him and the server adds a suggestion: nothing is heard.
    const first = events.byId[id].spots.list[0].areaId
    await sam.api.approveSpot(id, sam.id, first, true)
    await sam.api.suggestSpot(id, sam.id, 'orchard')
    expect(events.byId[id].spots.list.map((s) => s.areaId)).not.toContain('orchard')
    // The channel opens again: it connects, and everything is read again.
    stop = kim.api.watchSessions()
    await vi.waitFor(() => expect(events.byId[id].spots.list.map((s) => s.areaId)).toContain('orchard'))
    expect(events.byId[id].spots.list[0].approvalCount).toBe(1)
    expect(w.database.tables.spot_approvals).toHaveLength(1)
    stop()
  })
})

describe('what Home says for a shared session', () => {
  it('asks each person for the next thing, from the server\'s rows', async () => {
    const { sam, kim, id } = await locating()
    await sam.api.setLocation(id, sam.id, 'start', SAM_PLACE)
    expect(nextStepFor(await kim.api.getSession(id), kim.id)).toMatchObject({ label: 'Share your start', tone: 'action', to: `/sessions/${id}` })
    expect(nextStepFor(await sam.api.getSession(id), sam.id)).toMatchObject({ label: 'Waiting for others', tone: 'wait' })
    await kim.api.setLocation(id, kim.id, 'start', KIM_PLACE)
    expect(nextStepFor(await sam.api.getSession(id), sam.id)).toMatchObject({ label: 'Confirm the spot', tone: 'action' })
    expect(nextStepFor(await kim.api.getSession(id), kim.id)).toMatchObject({ label: 'Pick your spots', tone: 'action' })
    const [spot] = (await kim.api.getSession(id)).spots.list
    await kim.api.approveSpot(id, kim.id, spot.areaId, true)
    expect(nextStepFor(await kim.api.getSession(id), kim.id)).toMatchObject({ label: 'Waiting for the host', tone: 'wait' })
  })

  it('does not ask anyone to vote while voting with friends is not ready', async () => {
    const { sam, kim, id } = await locating({ places: true })
    await sam.api.useMeetingArea(id)
    for (const person of [sam, kim]) expect(nextStepFor(await person.api.getSession(id), person.id)).toMatchObject({ label: 'Open meetup', tone: 'done' })
  })
})
