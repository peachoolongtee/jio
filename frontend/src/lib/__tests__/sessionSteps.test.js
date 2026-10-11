// The steps bar: which step a session has reached, which one is on screen, and which can be opened. Imported from the
// single-file component, like the other small pure functions.
import { describe, expect, it } from 'vitest'
import { reachedStep, stepsFor, viewingStep } from '../../components/event/SessionSteps.vue'

const session = (status, more = {}) => ({ id: 's1', status, hostId: 'ian', ...more })

describe('the step a session has reached', () => {
  it('is Create before the session exists, then one step per status', () => {
    expect(reachedStep(null)).toBe(0)
    expect(['inviting', 'locating', 'voting', 'confirmed', 'completed'].map((status) => reachedStep(session(status)))).toEqual([1, 2, 3, 4, 4])
  })

  it('stops where a cancelled session was called off', () => {
    expect(reachedStep(session('cancelled', { plan: {} }))).toBe(4)
    expect(reachedStep(session('cancelled', { meeting: {} }))).toBe(3)
    expect(reachedStep(session('cancelled', { activeIds: ['ian', 'faith'] }))).toBe(2)
    expect(reachedStep(session('cancelled', { activeIds: ['ian'] }))).toBe(1)
  })
})

describe('the step on screen', () => {
  it('follows the page: edit is Create, the invite page is Invite, plan is Vote, itinerary and its photos and map are Itinerary', () => {
    const voting = session('voting')
    expect(viewingStep(voting, '/edit')).toBe(0)
    expect(viewingStep(voting, '/invite')).toBe(1)
    expect(viewingStep(voting, '/plan')).toBe(3)
    expect(viewingStep(voting, '/itinerary')).toBe(4)
    expect(viewingStep(voting, '/photos')).toBe(4)
    expect(viewingStep(voting, '/map')).toBe(4)
  })

  it('reads the people page as Invite while inviting and as Locate after', () => {
    expect(viewingStep(session('inviting'), '')).toBe(1)
    expect(['locating', 'voting', 'confirmed'].map((status) => viewingStep(session(status), ''))).toEqual([2, 2, 2])
  })

  it('is correct from the first frame: it needs only the session already in the store and the address', () => {
    // Every screen of a voting session, as the bar of the next screen would draw it before anything has loaded.
    const here = (path) => stepsFor(session('voting'), path).findIndex((step) => step.here)
    expect([here('/sessions/s1'), here('/sessions/s1/plan'), here('/sessions/s1/edit')]).toEqual([2, 3, 0])
  })

  it('marks exactly one step, and none is current on the create page except Create', () => {
    for (const path of ['/sessions/s1', '/sessions/s1/plan', '/sessions/s1/itinerary', '/sessions/s1/photos', '/sessions/s1/invite', '/sessions/s1/edit']) {
      expect(stepsFor(session('confirmed'), path).filter((step) => step.here)).toHaveLength(1)
    }
    const create = stepsFor(null, '/sessions/new')
    expect(create.filter((step) => step.here).map((step) => step.key)).toEqual(['create'])
    expect(create.some((step) => step.open)).toBe(false)
  })
})

describe('what each step opens', () => {
  it('fills the steps reached and opens them, and leaves the later ones shut', () => {
    const steps = stepsFor(session('voting'), '/sessions/s1/plan')
    expect(steps.map((step) => step.done)).toEqual([true, true, true, true, false])
    expect(steps.map((step) => step.open)).toEqual([true, true, true, true, false])
    expect(steps.map((step) => step.to)).toEqual(['/sessions/s1/edit', '/sessions/s1', '/sessions/s1', '/sessions/s1/plan', '/sessions/s1/itinerary'])
  })

  it('does not link a step to the page it is on', () => {
    expect(stepsFor(session('voting'), '/sessions/s1/plan').find((step) => step.here).exact).toBe(true)
    expect(stepsFor(session('inviting'), '/sessions/s1/edit')[0]).toMatchObject({ here: true, exact: true })
    // The invite page is Invite's, but not at Invite's own address, so Invite still links to the people page.
    expect(stepsFor(session('inviting'), '/sessions/s1/invite')[1]).toMatchObject({ here: true, exact: false, open: true })
  })

  it('opens Create for the host of a session that is inviting', () => {
    expect(stepsFor(session('inviting'), '/sessions/s1/invite')[0]).toMatchObject({ open: true, locked: false, to: '/sessions/s1/edit' })
  })

  it('still opens Create once the session has started, but as locked, so the page says why', () => {
    for (const status of ['locating', 'voting', 'confirmed', 'completed', 'cancelled']) {
      expect(stepsFor(session(status), '/sessions/s1')[0]).toMatchObject({ open: true, locked: true })
    }
  })

  it('does not open Create for anyone but the host', () => {
    expect(stepsFor(session('inviting', { hostId: 'faith' }), '/sessions/s1', false)[0]).toMatchObject({ open: false, locked: false })
  })
})
