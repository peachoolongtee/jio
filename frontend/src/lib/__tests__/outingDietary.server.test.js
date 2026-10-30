// Dietary needs for one outing on a real account (UAT of 29 October 2026, item 5): the Vote page's plan carries the outing's needs
// as the Jio server tells them (GET /api/sessions/:id/dietary), "Confirm dietary needs" and the chips write them to the server
// (PUT /api/sessions/:id/dietary) and read them back, nothing is kept in the browser, and only the host drops someone else's need.
// The server's two routes are stood in for here, on the contract: { dietary, others, mine, checked, dropped }. No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { AxiosError } from 'axios'
import { voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T10:00:00'))
})
afterEach(() => vi.unstubAllGlobals())
vi.setConfig({ testTimeout: 40000 })

// The server's side of the dietary routes for one outing, put in front of each app's adapter. `needs` is what each person's profile
// holds (by user id); a person's own needs for the outing start from it. Under three joined `others` is empty, as the server answers.
// How to call: const diet = standIn(w, [sam, kim, lee], { [sam.id]: ['halal'] }, sam.id)
function standIn(w, apps, profiles, hostId, { joined = 3, refuse = null } = {}) {
  const outing = { mine: {}, checked: {}, dropped: [] }
  const calls = []
  const answerFor = (user) => {
    const mineOf = (id) => outing.mine[id] ?? profiles[id] ?? []
    const everyone = Object.keys(profiles).slice(0, joined)
    const others = joined >= 3 ? [...new Set(everyone.filter((id) => id !== user).flatMap(mineOf))] : []
    const all = [...new Set(everyone.flatMap(mineOf))]
    return { dietary: all.filter((n) => !outing.dropped.includes(n)), others, mine: mineOf(user), checked: !!outing.checked[user], dropped: outing.dropped }
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
      if (refuse) return respond(refuse.status, { error: refuse.error, message: 'No.' })
      if (method === 'PUT') {
        if (body.dropped && user !== hostId) return respond(403, { error: 'host_only', message: 'Only the host can drop a need.' })
        if (body.mine) outing.mine[user] = body.mine
        if (body.checked) outing.checked[user] = true
        if (body.dropped) outing.dropped = body.dropped
      }
      return respond(200, answerFor(user))
    }
  }
  return { calls, outing }
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
    // The host sees the same for their own side: only their own.
    expect((await sam.api.getPlan(id)).dietary).toEqual(['halal'])
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
    expect(diet.calls.filter((c) => c.method === 'PUT')).toEqual([{ method: 'PUT', body: { mine: ['vegan'], checked: true }, as: kim.id }])
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
    expect(diet.calls.filter((c) => c.method === 'PUT').at(-1).body).toEqual({ mine: [], checked: true, dropped: ['halal'] })
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
    expect(diet.calls.filter((c) => c.method === 'PUT').at(-1).body).toEqual({ mine: ['vegan'], checked: true })
  })

  it('says it in words when the server refuses the drop, and when the outing is closed', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: [], [lee.id]: [] }, sam.id)
    await sam.api.getPlan(id)
    const refused = standIn(w, [sam], { [sam.id]: ['halal'] }, sam.id, { refuse: { status: 403, error: 'host_only' } })
    await expect(sam.api.confirmDiet(id, ['vegan'], undefined)).rejects.toThrow("Only the host can change someone else's need.")
    expect(refused.calls.length).toBeGreaterThan(0)
    standIn(w, [sam], { [sam.id]: ['halal'] }, sam.id, { refuse: { status: 409, error: 'session_closed' } })
    await expect(sam.api.confirmDiet(id, ['vegan'], undefined)).rejects.toThrow('Dietary needs can no longer change for this outing.')
  })

  it('tells the screens a real friend’s needs from the server, and the person’s own for this outing', async () => {
    const { w, sam, kim, lee, id } = await voting({ third: true })
    standIn(w, [sam, kim, lee], { [sam.id]: ['halal'], [kim.id]: ['vegan'], [lee.id]: [] }, sam.id)
    expect(await kim.api.outingDietary(id)).toEqual({ dietary: ['halal', 'vegan'], others: ['halal'], mine: ['vegan'], dropped: [] })
  })
})
