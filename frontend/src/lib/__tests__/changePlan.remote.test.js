// The host changes the meeting place, for a real account: two people use their own copy of the app on ONE stand-in database and one stand-in Jio
// server (components/dev/fakeDatabase.js, ./fakeSessionsServer.js), so what the host does the guest sees, and the path, body and login token are
// the real ones. The data layer sends ONE request and then reads the session again (it keeps nothing the server answered), the guest sees the
// session back on Locate with the host's notice, and the stand-in's refusals are worded for the screens. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { confirmed, voted, voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
})

const rowsOf = (w, table) => w.database.tables[table]
const sessionRow = (w, id) => rowsOf(w, 'sessions').find((s) => s.id === id)
const callsTo = (w, name) => w.server.calls.filter((c) => c.route === name)

describe('"fairest"', () => {
  it('sends one request, and both people read the session back on Locate with the host\'s notice and their starts kept', async () => {
    const { w, sam, kim, id } = await voted()
    w.server.calls.length = 0
    const after = await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    expect(after).toMatchObject({ status: 'locating', meetBy: 'fairest' })
    expect(callsTo(w, 'changeMeetingPlace')).toEqual([expect.objectContaining({ method: 'POST', path: `/api/sessions/${id}/change-meeting-place`, body: { meetBy: 'fairest', planVersion: expect.any(Number) }, as: sam.id })])
    const theirs = await kim.api.getSession(id)
    expect(theirs).toMatchObject({ status: 'locating', meetBy: 'fairest', meeting: null })
    expect(theirs.banner).toMatchObject({ text: 'Sam changed the meeting place, so the votes were cleared.', released: true })
    expect(theirs.votes).toEqual({})
    // The starts were kept, so the spots are there without anyone sharing again.
    expect(Object.values(theirs.locations).filter((place) => place.start)).toHaveLength(2)
    expect(theirs.spots.list.length).toBeGreaterThan(0)
    expect(rowsOf(w, 'slots').filter((s) => s.session_id === id)).toEqual([])
    expect(rowsOf(w, 'votes')).toEqual([])
  })

  it('from a confirmed plan, the stops go with it and the notice says the plan was cleared', async () => {
    const { w, sam, kim, id } = await confirmed()
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    expect(rowsOf(w, 'stops').filter((s) => s.session_id === id)).toEqual([])
    const theirs = await kim.api.getSession(id)
    expect(theirs).toMatchObject({ status: 'locating', plan: null })
    expect(theirs.banner.text).toBe('Sam changed the meeting place, so the votes and the plan were cleared.')
    expect(sessionRow(w, id)).toMatchObject({ order_reason: null, plan_start_minute: null, weather_kept: null, meeting_area_id: null })
  })

  it('names the host and nobody else, and the host\'s exact place is nowhere in what the guest reads (her own stays hers)', async () => {
    const { sam, kim, id } = await voted()
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    const theirs = await kim.api.getSession(id)
    expect(theirs.banner.text).not.toMatch(/Kim/)
    expect(JSON.stringify(theirs)).not.toContain('Tampines Mall')
  })
})

describe('"known"', () => {
  it('sends the area, and the guest reads the session voting at it with a notice that names the host and the area', async () => {
    const { w, sam, kim, id } = await voted()
    w.server.calls.length = 0
    const after = await sam.api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'orchard' })
    expect(after).toMatchObject({ status: 'voting', meetBy: 'known' })
    expect(callsTo(w, 'changeMeetingPlace')[0].body).toEqual({ meetBy: 'known', areaId: 'orchard', planVersion: expect.any(Number) })
    const theirs = await kim.api.getSession(id)
    expect(theirs).toMatchObject({ status: 'voting', meetBy: 'known' })
    expect(theirs.meeting).toMatchObject({ areaId: 'orchard', method: 'chosen' })
    expect(theirs.banner).toMatchObject({ text: 'Sam changed the meeting place to Orchard, so the votes were cleared.', released: true, votesCleared: true })
    expect(rowsOf(w, 'votes')).toEqual([])
    expect(rowsOf(w, 'slots').filter((s) => s.session_id === id).length).toBeGreaterThan(0)
  })

  it('when naming the area fails, the session is read again on Locate with the choice recorded, and the error reaches the screen', async () => {
    const { w, sam, kim, id } = await voted()
    w.server.after.knownPlace = () => {
      throw new Error('The stand-in server went away.')
    }
    await expect(sam.api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'orchard' })).rejects.toMatchObject({ released: true })
    delete w.server.after.knownPlace
    const mine = await sam.api.getSession(id)
    expect(mine).toMatchObject({ status: 'locating', meetBy: 'known' })
    expect(mine.banner.text).toBe('Sam changed the meeting place, so the votes were cleared.')
    expect((await kim.api.getSession(id)).status).toBe('locating')
    // The host finishes it with the known place that already exists.
    expect(await sam.api.setKnownPlace(id, 'orchard')).toMatchObject({ status: 'voting' })
  })
})

describe('a retry, and the spots after a release', () => {
  it('sends the version it last read, and a version that is out of date is refused in words with nothing wiped', async () => {
    const { w, sam, id } = await voted()
    await sam.api.getSession(id)
    sessionRow(w, id).plan_version += 1
    await expect(sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })).rejects.toMatchObject({ code: 'stale_plan', status: 409, message: expect.stringContaining('Look at it again') })
    expect(sessionRow(w, id).status).toBe('voting')
    expect(rowsOf(w, 'votes').length).toBeGreaterThan(0)
  })

  it('a repeat of "known" for the area the session is voting at, with no vote cast, answers 200 and writes nothing', async () => {
    const { w, sam, id } = await voting()
    await sam.api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'orchard' })
    const version = sessionRow(w, id).plan_version
    expect(await sam.api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'orchard' })).toMatchObject({ status: 'voting', meetBy: 'known' })
    expect(sessionRow(w, id).plan_version).toBe(version)
  })

  it('leaves the spots fresh: no member row is newer than the spots, so no page asks for them again', async () => {
    const { w, sam, kim, id } = await voted()
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    const newest = (rows, field) => Math.max(0, ...rows.map((x) => Date.parse(x[field]) || 0))
    const members = rowsOf(w, 'session_members').filter((m) => m.session_id === id && m.start_area_id)
    const spots = rowsOf(w, 'session_spots').filter((s) => s.session_id === id)
    expect(spots.length).toBeGreaterThan(0)
    expect(newest(members, 'updated_at')).toBeLessThanOrEqual(newest(spots, 'computed_at'))
    w.server.calls.length = 0
    await kim.api.getSession(id)
    await sam.api.getSession(id)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(callsTo(w, 'meetingArea')).toEqual([])
  })
})

describe('who may, and when', () => {
  it('is the host\'s alone, in words', async () => {
    const { kim, id } = await voted()
    await expect(kim.api.changeMeetingPlace(id, { meetBy: 'fairest' })).rejects.toMatchObject({ message: 'Only the host can change the meeting place.', code: 'host_only' })
  })

  it('is refused while the session is locating, in words', async () => {
    const { w, sam, id } = await voted()
    await sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })
    w.server.calls.length = 0
    await expect(sam.api.changeMeetingPlace(id, { meetBy: 'fairest' })).rejects.toMatchObject({ code: 'wrong_status', message: 'The meeting place can only be changed while the group is voting on places or has a plan.' })
  })

  it('does not ask the server about a way or an area it can tell is wrong', async () => {
    const { w, sam, id } = await voted()
    w.server.calls.length = 0
    await expect(sam.api.changeMeetingPlace(id, { meetBy: 'sometimes' })).rejects.toThrow('Choose how to pick the meeting point.')
    await expect(sam.api.changeMeetingPlace(id, { meetBy: 'known', areaId: 'atlantis' })).rejects.toThrow()
    expect(callsTo(w, 'changeMeetingPlace')).toEqual([])
  })
})
