// Dietary needs for one outing on a real account (UAT of 29 October 2026, item 5): the Vote page's plan carries the outing's needs
// as the Jio server tells them (GET /api/sessions/:id/dietary), "Confirm dietary needs" and the chips write them to the server
// (PUT /api/sessions/:id/dietary) and read them back, nothing is kept in the browser, and only the host drops someone else's need.
// The server's two routes are stood in for here, on the contract: { dietary, others, mine, checked, dropped }. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { locating, voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())
vi.setConfig({ testTimeout: 40000 })

// The server's side of the dietary routes for one outing, put in front of each app's adapter. `needs` is what each person's profile
// holds (by user id); a person's own needs for the outing start from it. As the server answers (backend/src/services/session-dietary.js):
// under three joined the answer is the caller's own needs alone (`others` and `dropped` empty), and a drop is in force only while a member
// other than the host has the need. `control.fail` ({ status, error }) makes the next reads (GET) fail until it is set to null.
// How to call: const diet = standIn(w, [sam, kim, lee], { [sam.id]: ['halal'] }, sam.id)
function standIn(w, apps, profiles, hostId, { joined = 3, refuse = null } = {}) {
  const outing = { mine: {}, checked: {}, dropped: [] }
  const calls = []
  const control = { fail: null }
  const answerFor = (user) => {
    const mineOf = (id) => outing.mine[id] ?? profiles[id] ?? []
    const everyone = Object.keys(profiles).slice(0, joined)
    if (joined < 3) return { dietary: mineOf(user), others: [], mine: mineOf(user), checked: !!outing.checked[user], dropped: [] }
    const others = [...new Set(everyone.filter((id) => id !== user).flatMap(mineOf))]
    const all = [...new Set(everyone.flatMap(mineOf))]
    const inForce = outing.dropped.filter((need) => everyone.some((id) => id !== hostId && mineOf(id).includes(need)))
    return { dietary: all.filter((n) => !inForce.includes(n)), others, mine: mineOf(user), checked: !!outing.checked[user], dropped: inForce }
  }
  for (const app of apps) {
    const before = app.api.api.defaults.adapter
    app.api.api.defaults.adapter = async (config) => {
      const path = String(config.url || '').replace(/^https?:\/\/[^/]+/, '').split('?')[0]
      if (!/^\/api\/sessions\/[^/]+\/dietary$/.test(path)) return before(config)
      const method = String(config.method).toUpperCase()
      const user = w.database.userForToken(String(config.headers?.get?.('Authorization') || '').replace(/^Bearer /, ''))
      const body = config.data ? JSON.parse(config.data) : {}
      calls.push({ method, body, as: user })
      const respond = (status, data) => {
        const response = { data, status, statusText: String(status), headers: {}, config, request: {} }
        if (status >= 400) throw new AxiosError(`Request failed with status code ${status}`, 'ERR_BAD_REQUEST', config, {}, response)
        return response
      }
      if (refuse && method === 'PUT') return respond(refuse.status, { error: refuse.error, message: 'No.' })
      if (control.fail && method === 'GET') return respond(control.fail.status, { error: control.fail.error, message: 'No.' })
      if (method === 'PUT') {
        // As the server: a member may lift a drop of a need of their own (kept in `mine`); any other change to the list is the host's.
        const ownLift = body.dropped && body.dropped.every((n) => outing.dropped.includes(n)) && outing.dropped.filter((n) => !body.dropped.includes(n)).every((n) => (body.mine ?? []).includes(n))
        if (body.dropped && user !== hostId && !ownLift) return respond(403, { error: 'host_only', message: 'Only the host can drop a need.' })
        if (body.mine) outing.mine[user] = body.mine
        if (body.checked) outing.checked[user] = true
        if (body.dropped) outing.dropped = body.dropped
      }
      return respond(200, { ...answerFor(user), planVersion: 1, repicked: method === 'PUT' })
    }
  }
  return { calls, outing, control }
}

describe('the Vote page of a real account', () => {
  it('carries the outing’s needs as the server tells them, with no names, so the chips and the question can show', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: ['vegetarian'], [lee.id]: [] }, sam.id)
    const plan = await kim.api.getPlan(id)
    expect(plan.myDietary).toEqual(['vegetarian'])
    expect(plan.othersDietary).toEqual(['halal'])
    expect(plan.dietary).toEqual(['halal', 'vegetarian'])
    expect(plan.dietDropped).toEqual([])
    expect(plan.dietChecked).toBe(false)
  })

  it('names nobody else’s need while fewer than three have joined', async () => {
    const { w, sam, kim, id } = await voting()
    standIn(w, [sam, kim], { [sam.id]: ['halal'], [kim.id]: [] }, sam.id, { joined: 2 })
    const plan = await kim.api.getPlan(id)
    expect(plan.othersDietary).toEqual([])
    expect(plan.dietary).toEqual([])
    expect(plan.myDietary).toEqual([])
    // The host sees the same for their own side: only their own, and Kim, who has none, learns nothing of the host's.
    expect((await sam.api.getPlan(id)).dietary).toEqual(['halal'])
    expect(JSON.stringify(plan.dietary) + JSON.stringify(plan.dietDropped)).not.toContain('halal')
  })

  it('shows no dietary chips when the server cannot say (an older server, or no answer)', async () => {
    // The stand-in server has no dietary route, so the read answers 404 and the plan is the plain one.
    const { kim, id } = await voting()
    const plan = await kim.api.getPlan(id)
    expect(plan.myDietary).toBeUndefined()
    expect(plan.dietChecked).toBeUndefined()
    expect(plan.slots.length).toBeGreaterThan(0)
  })
})

describe('confirming and changing needs on a real account', () => {
  it('writes the person’s own needs to the server, reads them back, and keeps nothing in the browser', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: [], [lee.id]: [] }, sam.id)
    await kim.api.getPlan(id)
    await kim.api.confirmDiet(id, ['vegan'])
    const puts = diet.calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(1)
    // The version the page saw rides along, so a write over a newer outing is refused.
    expect(puts[0]).toMatchObject({ body: { mine: ['vegan'], checked: true, planVersion: expect.any(Number) }, as: kim.id })
    const plan = await kim.api.getPlan(id)
    expect(plan.myDietary).toEqual(['vegan'])
    expect(plan.dietChecked).toBe(true)
    expect(plan.dietary).toEqual(['halal', 'vegan'])
    // The profile is the standing setting: the outing's picks do not touch it.
    expect((await kim.api.getUser()).dietary ?? []).toEqual([])
    // Another person's page learns it from the server on its next read.
    expect((await sam.api.getPlan(id)).dietary).toEqual(['halal', 'vegan'])
  })

  it('confirms the needs as they are with one write', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: [], [lee.id]: [] }, sam.id)
    await kim.api.getPlan(id)
    await kim.api.confirmDiet(id, [], [])
    expect(diet.calls.filter((c) => c.method === 'PUT')).toHaveLength(1)
    expect((await kim.api.getPlan(id)).dietChecked).toBe(true)
  })

  it('lets the host drop someone else’s need and bring it back, and sends the drop to the server', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: ['halal'], [lee.id]: [] }, sam.id)
    await sam.api.getPlan(id)
    await sam.api.confirmDiet(id, [], ['halal'])
    expect(diet.calls.filter((c) => c.method === 'PUT').at(-1).body).toMatchObject({ mine: [], checked: true, dropped: ['halal'] })
    const plan = await sam.api.getPlan(id)
    expect(plan.dietDropped).toEqual(['halal'])
    expect(plan.dietary).toEqual([])
    expect(plan.othersDietary).toEqual(['halal'])
    await sam.api.confirmDiet(id, [], [])
    expect((await sam.api.getPlan(id)).dietDropped).toEqual([])
  })

  it('refuses a guest’s drop before asking the server, in words, and still lets them change their own', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: [], [lee.id]: [] }, sam.id)
    await kim.api.getPlan(id)
    await expect(kim.api.confirmDiet(id, [], ['halal'])).rejects.toThrow("Only the host can change someone else's need.")
    expect(diet.calls.filter((c) => c.method === 'PUT')).toEqual([])
    // Sending back the list the outing already has is not a drop.
    await expect(kim.api.confirmDiet(id, ['vegan'], [])).resolves.toBeTruthy()
    expect(diet.calls.filter((c) => c.method === 'PUT').at(-1).body).toMatchObject({ mine: ['vegan'], checked: true })
    expect(diet.calls.filter((c) => c.method === 'PUT').at(-1).body.dropped).toBeUndefined()
  })

  it('saves a chip tap without confirming the outing for the person', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: [], [lee.id]: [] }, sam.id)
    await kim.api.getPlan(id)
    await kim.api.confirmDiet(id, ['vegetarian'], [], { confirmed: false })
    expect(diet.calls.filter((c) => c.method === 'PUT').at(-1).body.checked).toBeUndefined()
    const plan = await kim.api.getPlan(id)
    expect(plan.myDietary).toEqual(['vegetarian'])
    expect(plan.dietChecked).toBe(false)
  })

  it('reads the outing again and says why when the server finds the page out of date', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: [], [lee.id]: [] }, sam.id)
    await kim.api.getPlan(id)
    standIn(w, [kim], { [kim.id]: [] }, sam.id, { refuse: { status: 409, error: 'stale_plan' } })
    // The screens are told the outing changed (they read the plan again), and the session itself is read again from the database.
    const told = []
    const stop = kim.api.subscribe((event) => told.push(event))
    const sessionReads = () => w.ops.filter((op) => op.kind === 'select' && op.table === 'sessions').length
    const before = sessionReads()
    await expect(kim.api.confirmDiet(id, ['vegan'])).rejects.toThrow('The outing changed while you were looking. It is up to date now; try again.')
    stop?.()
    expect(told.filter((e) => e.type === 'diet' && e.sessionId === id)).toHaveLength(1)
    expect(sessionReads()).toBeGreaterThan(before)
    expect(diet.calls.filter((c) => c.method === 'PUT')).toEqual([])
  })

  it('says it in words when the server refuses the drop, and when the outing is closed', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: [], [lee.id]: [] }, sam.id)
    await sam.api.getPlan(id)
    const refused = standIn(w, [sam], { [sam.id]: ['halal'] }, sam.id, { refuse: { status: 403, error: 'host_only' } })
    await expect(sam.api.confirmDiet(id, ['vegan'], undefined)).rejects.toThrow("Only the host can change someone else's need.")
    expect(refused.calls.length).toBeGreaterThan(0)
    standIn(w, [sam], { [sam.id]: ['halal'] }, sam.id, { refuse: { status: 409, error: 'session_closed' } })
    await expect(sam.api.confirmDiet(id, ['vegan'], undefined)).rejects.toThrow('This session has ended.')
    standIn(w, [sam], { [sam.id]: ['halal'] }, sam.id, { refuse: { status: 409, error: 'wrong_status' } })
    await expect(sam.api.confirmDiet(id, ['vegan'], undefined)).rejects.toThrow('Dietary needs can only change while the group is voting.')
    standIn(w, [sam], { [sam.id]: ['halal'] }, sam.id, { refuse: { status: 409, error: 'needs_three_people' } })
    await expect(sam.api.confirmDiet(id, ['vegan'], undefined)).rejects.toThrow('Someone else\'s need can be changed once three people have joined.')
  })

  it('tells the screens a real friend’s needs from the server, and the person’s own for this outing', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: ['vegan'], [lee.id]: [] }, sam.id)
    expect(await kim.api.outingDietary(id)).toEqual({ dietary: ['halal', 'vegan'], others: ['halal'], mine: ['vegan'], dropped: [] })
  })
})

describe('a guest whose own need the host dropped', () => {
  it('is not locked out when the others no longer hold it: only the host ever sends a drop, and the comparison is with the list the screen shows', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    // Kim and Lee both have halal; the host drops it; Lee takes theirs off for this outing. The server still has it dropped, because Kim holds it.
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: ['halal'], [lee.id]: ['halal'] }, sam.id)
    await sam.api.getPlan(id)
    await sam.api.confirmDiet(id, [], ['halal'])
    await lee.api.getSession(id)
    await lee.api.getPlan(id)
    await lee.api.confirmDiet(id, [], undefined, { confirmed: false })
    const plan = await kim.api.getPlan(id)
    // Kim sees no one else with halal, and her own halal as dropped (her chip shows it as not filtered for).
    expect(plan.othersDietary).toEqual([])
    expect(plan.dietDropped).toEqual(['halal'])
    expect(plan.myDietary).toEqual(['halal'])
    diet.calls.length = 0
    // A chip tap and Confirm as the screen sends them: the person's own list and the dropped list the screen shows.
    await expect(kim.api.confirmDiet(id, ['halal'], plan.dietDropped, { confirmed: false })).resolves.toBeTruthy()
    await expect(kim.api.confirmDiet(id, [], plan.dietDropped)).resolves.toBeTruthy()
    const puts = diet.calls.filter((c) => c.method === 'PUT')
    expect(puts).toHaveLength(2)
    for (const put of puts) expect(put.body.dropped).toBeUndefined()
    expect(puts[1].body).toMatchObject({ mine: [], checked: true })
  })

  it('lifts the drop when she selects her own need again, and the group is filtered for it again', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: ['halal'], [lee.id]: [] }, sam.id)
    await sam.api.confirmDiet(id, [], ['halal'])
    await kim.api.getSession(id)
    let plan = await kim.api.getPlan(id)
    expect(plan.dietDropped).toEqual(['halal'])
    diet.calls.length = 0
    // Her chip's tap: her own list as it is, and the dropped list without halal.
    await kim.api.confirmDiet(id, ['halal'], [], { confirmed: false })
    const puts = diet.calls.filter((c) => c.method === 'PUT')
    expect(puts.map((c) => c.body.dropped)).toEqual([[]])
    plan = await kim.api.getPlan(id)
    expect(plan.dietDropped).toEqual([])
    expect(plan.dietary).toEqual(['halal'])
  })

  it('leaves a dropped need off the cards: no place says it is likely or not confirmed for it', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: ['vegetarian'], [lee.id]: ['halal'] }, sam.id)
    // The places as Lee's app receives them, with food places only likely to fit either need (the stand-in's own have no diet levels).
    const adapter = lee.api.api.defaults.adapter
    lee.api.api.defaults.adapter = async (config) => {
      const res = await adapter(config)
      if (String(config.url).includes('/api/venues')) {
        for (const v of res.data.venues) if (v.category === 'eat') v.diet = { halal: 'likely', vegetarian: 'likely', vegan: 'unknown' }
      }
      return res
    }
    const named = (plan, need) => plan.slots.flatMap((s) => s.options).filter((o) => [...(o.verify ?? []), ...(o.dietUnknown ?? [])].includes(need))
    await lee.api.getSession(id)
    const before = await lee.api.getPlan(id)
    expect(named(before, 'vegetarian').length).toBeGreaterThan(0)
    await sam.api.confirmDiet(id, [], ['vegetarian'])
    const after = await lee.api.getPlan(id)
    expect(after.dietDropped).toEqual(['vegetarian'])
    expect(named(after, 'vegetarian')).toEqual([])
    // Lee's own halal is still named.
    expect(named(after, 'halal').length).toBeGreaterThan(0)
  })

  it('still cannot change a drop the screen shows', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: ['halal'], [lee.id]: [] }, sam.id)
    await sam.api.confirmDiet(id, [], ['halal'])
    await lee.api.getSession(id)
    await lee.api.getPlan(id)
    await expect(lee.api.confirmDiet(id, [], [])).rejects.toThrow("Only the host can change someone else's need.")
    expect(diet.calls.filter((c) => c.method === 'PUT' && as(c, lee))).toEqual([])
  })
})

const as = (call, app) => call.as === app.id

describe('when the server cannot say what the outing needs', () => {
  it('keeps the last good answer and says so, after a failure or the limit, and the cards do not fall back to the profile’s needs', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: ['vegetarian'], [lee.id]: [] }, sam.id)
    const good = await kim.api.getPlan(id)
    expect(good.dietUnavailable).toBeUndefined()
    expect(good.dietary).toEqual(['halal', 'vegetarian'])
    for (const fail of [{ status: 500, error: 'server_error' }, { status: 429, error: 'rate_limited' }]) {
      diet.control.fail = fail
      const kept = await kim.api.getPlan(id)
      expect(kept.dietUnavailable, String(fail.status)).toBe(true)
      expect(kept).toMatchObject({ dietary: ['halal', 'vegetarian'], myDietary: ['vegetarian'], othersDietary: ['halal'], dietChecked: false })
      // The cards read as they did: the places and what is said of each need are the same.
      expect(JSON.stringify(kept.slots)).toBe(JSON.stringify(good.slots))
    }
    // Back to normal: the line goes.
    diet.control.fail = null
    expect((await kim.api.getPlan(id)).dietUnavailable).toBeUndefined()
  })

  it('says so with no answer to keep when the very first ask fails, and shows no chips', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    const diet = standIn(w, [sam, kim, lee], { [sam.id]: [], [kim.id]: [], [lee.id]: [] }, sam.id)
    diet.control.fail = { status: 500, error: 'server_error' }
    const plan = await kim.api.getPlan(id)
    expect(plan.dietUnavailable).toBe(true)
    expect(plan.myDietary).toBeUndefined()
    expect(plan.slots.length).toBeGreaterThan(0)
  })
})

describe('how many times the outing’s needs are read', () => {
  const reads = (diet) => diet.calls.filter((c) => c.method === 'GET').length

  it('asks only while the session is voting, and not again for a plan read of another state', async () => {
    const { w, sam, kim, id } = await locating({ places: true })
    const diet = standIn(w, [sam, kim], { [sam.id]: [], [kim.id]: [] }, sam.id, { joined: 2 })
    // Known to be locating: nothing is asked.
    await kim.api.getSession(id)
    await kim.api.getPlan(id)
    expect(reads(diet)).toBe(0)
    // It becomes voting without this page reading the session: the rows say so, and then the needs are asked, once.
    await sam.api.useMeetingArea(id)
    const plan = await kim.api.getPlan(id)
    expect(reads(diet)).toBe(1)
    expect(plan.myDietary).toEqual([])
    // Known to be voting: one ask per full read, and none for a read of the votes alone.
    await kim.api.getSession(id)
    await kim.api.getPlan(id)
    await kim.api.getPlan(id, { votesOnly: true })
    expect(reads(diet)).toBe(2)
  })

  it('asks while the rows are read, not after them', async () => {
    const { w, sam, kim, id } = await voting()
    const diet = standIn(w, [sam, kim], { [sam.id]: [], [kim.id]: [] }, sam.id, { joined: 2 })
    await kim.api.getSession(id)
    diet.calls.length = 0
    // The database answers nothing until the server has been asked for the needs.
    let release
    const held = new Promise((resolve) => { release = resolve })
    w.gate.hold = (op) => (op.table === 'slots' ? held : null)
    const reading = kim.api.getPlan(id)
    await new Promise((resolve) => setTimeout(resolve, 30))
    expect(reads(diet)).toBe(1)
    release()
    await reading
    w.gate.hold = null
  })
})
