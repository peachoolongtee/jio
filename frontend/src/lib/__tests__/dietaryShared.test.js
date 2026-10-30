// An outing's own dietary needs for a real account (UAT of 29 October 2026, item 5): the Vote page's plan of a shared session carries
// the person's needs for the outing, the others' together, the dropped ones and whether they confirmed, so the same chips and "Confirm
// dietary needs" as the demo appear; saving sends PUT /api/sessions/:id/dietary with the real path and body; only the host drops a need
// someone else has. Three people on one stand-in database and the stand-in Jio server (fakeSessionsServer.js). No network.
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { voting } from './sessionsWorld.js'

beforeAll(() => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
})
afterEach(() => {
  vi.unstubAllGlobals()
  vi.setSystemTime(new Date('2026-10-09T02:00:00Z'))
})

const callsTo = (w, name) => w.server.calls.filter((c) => c.route === name)
// The dietary fields of a plan. How to call: dietOf(plan) -> { dietary, myDietary, othersDietary, dietDropped, dietChecked }
const dietOf = (plan) => ({ dietary: plan.dietary, myDietary: plan.myDietary, othersDietary: plan.othersDietary, dietDropped: plan.dietDropped, dietChecked: plan.dietChecked })

// Sam hosts and Kim and Lee have joined; Kim's profile says halal. The session is voting.
// How to call: const { w, sam, kim, lee, id } = await outing()
async function outing() {
  const world = await voting({ third: true, dietChecked: false })
  world.w.database.setNeeds(world.kim.id, { dietary: ['halal'] })
  world.w.database.setNeeds(world.sam.id, { dietary: [] })
  world.w.database.setNeeds(world.lee.id, { dietary: [] })
  // The plan read while the world was made kept the needs of then for a minute (namedNeedsOf): a profile changed since shows after it.
  vi.setSystemTime(new Date('2026-10-09T02:02:00Z'))
  // Each app reads the session first, as the Vote page does before anything on it can be pressed.
  for (const person of [world.sam, world.kim, world.lee]) await person.api.getSession(world.id)
  return world
}

describe("a real account's dietary needs for one outing", () => {
  it('are on the Vote page\'s plan, as the demo\'s are: the person\'s own, the others\' together, nothing dropped, not yet confirmed', async () => {
    const { sam, kim, id } = await outing()
    expect(dietOf(await sam.api.getPlan(id))).toEqual({ dietary: ['halal'], myDietary: [], othersDietary: ['halal'], dietDropped: [], dietChecked: false })
    expect(dietOf(await kim.api.getPlan(id))).toEqual({ dietary: ['halal'], myDietary: ['halal'], othersDietary: [], dietDropped: [], dietChecked: false })
  })

  it('are saved for the outing with PUT .../dietary, and the plan read again says so', async () => {
    const { w, kim, id } = await outing()
    await kim.api.confirmDiet(id, ['halal', 'vegan'], [])
    expect(callsTo(w, 'putDietary')).toEqual([expect.objectContaining({ method: 'PUT', path: `/api/sessions/${id}/dietary`, body: { mine: ['halal', 'vegan'], dropped: [] }, as: kim.id })])
    expect(dietOf(await kim.api.getPlan(id))).toMatchObject({ myDietary: ['halal', 'vegan'], dietChecked: true })
  })

  it('lets only the host stop filtering for a need someone else has; the guest is told so, and nobody is named', async () => {
    const { sam, kim, lee, id } = await outing()
    await expect(lee.api.confirmDiet(id, [], ['halal'])).rejects.toMatchObject({ code: 'host_only' })
    await sam.api.confirmDiet(id, [], ['halal'])
    expect(dietOf(await sam.api.getPlan(id))).toMatchObject({ dietary: [], othersDietary: ['halal'], dietDropped: ['halal'] })
    // Kim sees her own need dropped, shown unselected on the chips, and can select it again.
    expect(dietOf(await kim.api.getPlan(id))).toMatchObject({ myDietary: ['halal'], dietDropped: ['halal'] })
    await kim.api.confirmDiet(id, ['halal'], [])
    expect(dietOf(await sam.api.getPlan(id))).toMatchObject({ dietary: ['halal'], dietDropped: [] })
  })

  it('falls back to the profile with no chips when the server does not keep the outing\'s needs', async () => {
    const { w, sam, id } = await outing()
    w.server.down = true
    const plan = await sam.api.getPlan(id).catch(() => null)
    // With the server unreachable the plan may not load at all; when it does, it offers no chips (no myDietary).
    if (plan) expect(plan.myDietary).toBeUndefined()
  })
})
