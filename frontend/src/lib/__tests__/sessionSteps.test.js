// The steps bar: which step a session has reached, which one is on screen, and which can be opened. Imported from the
// single-file component, like the other small pure functions.
import { describe, expect, it } from 'vitest'
import { backFor, reachedStep, stepsFor, viewingStep } from '../../components/event/SessionSteps.vue'
import { goBackIfBehind, isBehind, pathOf } from '../stepNav.js'

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
    // Every step has a page of its own: Invite is no longer the session page, so it can be opened once the session started.
    expect(steps.map((step) => step.to)).toEqual(['/sessions/s1/edit', '/sessions/s1/invite', '/sessions/s1', '/sessions/s1/plan', '/sessions/s1/itinerary'])
  })

  it('opens every step the session has reached, for each status, and no later one', () => {
    const opened = (status, more) => stepsFor(session(status, more), '/sessions/s1').map((step) => step.open)
    expect(opened('inviting')).toEqual([true, true, false, false, false])
    expect(opened('locating')).toEqual([true, true, true, false, false])
    expect(opened('voting')).toEqual([true, true, true, true, false])
    expect(opened('confirmed')).toEqual([true, true, true, true, true])
    expect(opened('completed')).toEqual([true, true, true, true, true])
    // A session called off keeps the steps it reached.
    expect(opened('cancelled', { meeting: {} })).toEqual([true, true, true, true, false])
  })

  it('gives a guest the same links but never Create', () => {
    const guest = (status) => stepsFor(session(status, { hostId: 'faith' }), '/sessions/s1/itinerary', false).map((step) => step.open)
    expect(guest('inviting')).toEqual([false, true, false, false, false])
    expect(guest('confirmed')).toEqual([false, true, true, true, true])
    expect(stepsFor(session('confirmed', { hostId: 'faith' }), '/sessions/s1', false)[1].to).toBe('/sessions/s1/invite')
  })

  it('does not link a step to the page it is on', () => {
    expect(stepsFor(session('voting'), '/sessions/s1/plan').find((step) => step.here).exact).toBe(true)
    expect(stepsFor(session('inviting'), '/sessions/s1/edit')[0]).toMatchObject({ here: true, exact: true })
    // The invite page is Invite's own page.
    expect(stepsFor(session('inviting'), '/sessions/s1/invite')[1]).toMatchObject({ here: true, exact: true, open: true })
    // The lobby (the session page while inviting) is also the Invite step, but not at Invite's address, so Invite links on.
    expect(stepsFor(session('inviting'), '/sessions/s1')[1]).toMatchObject({ here: true, exact: false, open: true, to: '/sessions/s1/invite' })
    // Once the session has started the session page is Locate, and Invite is a link to its page.
    expect(stepsFor(session('locating'), '/sessions/s1')[2]).toMatchObject({ here: true, exact: true })
    expect(stepsFor(session('locating'), '/sessions/s1')[1]).toMatchObject({ here: false, open: true })
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

describe('where the back arrow goes', () => {
  const back = (status, path, mine = true, more = {}) => backFor(session(status, more), `/sessions/s1${path}`, mine)

  it('goes to the step before, among those the session has reached', () => {
    expect(back('confirmed', '/itinerary')).toEqual({ label: 'Back to Vote', to: '/sessions/s1/plan' })
    expect(back('voting', '/plan')).toEqual({ label: 'Back to Locate', to: '/sessions/s1' })
    expect(back('locating', '')).toEqual({ label: 'Back to Invite', to: '/sessions/s1/invite' })
  })

  it('goes from Invite to Create for the host, replacing it, and Home for a guest', () => {
    expect(back('inviting', '/invite')).toEqual({ label: 'Back to date and times', to: { path: '/sessions/s1/edit', replace: true } })
    expect(back('voting', '/invite')).toEqual({ label: 'Back to date and times', to: { path: '/sessions/s1/edit', replace: true } })
    expect(back('voting', '/invite', false, { hostId: 'faith' })).toEqual({ label: 'Back to Home', to: '/' })
  })

  it('goes Home from Create, the first step', () => {
    expect(back('inviting', '/edit')).toEqual({ label: 'Back to Home', to: '/' })
    expect(backFor(null, '/sessions/new')).toEqual({ label: 'Back to Home', to: '/' })
  })

  it('reads the lobby of a session that is inviting as the Invite step', () => {
    expect(back('inviting', '')).toEqual({ label: 'Back to date and times', to: '/sessions/s1/edit' })
    expect(back('inviting', '', false, { hostId: 'faith' })).toEqual({ label: 'Back to Home', to: '/' })
  })

  it('takes the photos and the full map back to the Itinerary', () => {
    expect(back('completed', '/photos')).toEqual({ label: 'Back to Itinerary', to: '/sessions/s1/itinerary' })
    expect(back('confirmed', '/map')).toEqual({ label: 'Back to Itinerary', to: '/sessions/s1/itinerary' })
  })

  it('never goes to a step the session has not reached, whatever the address', () => {
    // The plan page of a session still inviting: its step is not reached, so the arrow lands on the last one that is.
    expect(back('inviting', '/plan')).toEqual({ label: 'Back to Invite', to: '/sessions/s1/invite' })
    expect(back('locating', '/itinerary')).toEqual({ label: 'Back to Locate', to: '/sessions/s1' })
  })

  it('has every step of the chain, from the itinerary to Home, without a loop', () => {
    const chain = []
    let path = '/itinerary'
    for (let i = 0; i < 8; i++) {
      const next = back('confirmed', path)
      chain.push(next.label)
      const to = typeof next.to === 'string' ? next.to : next.to.path
      if (to === '/') break
      path = to.replace('/sessions/s1', '')
    }
    expect(chain).toEqual(['Back to Vote', 'Back to Locate', 'Back to Invite', 'Back to date and times', 'Back to Home'])
  })
})

describe('going back instead of adding a page', () => {
  const click = (extra = {}) => ({ defaultPrevented: false, button: 0, preventDefault() { this.defaultPrevented = true }, ...extra })
  const router = () => ({ calls: 0, back() { this.calls += 1 } })

  it('reads the page behind this one from the browser state, without a query', () => {
    expect(pathOf({ path: '/sessions/s1/plan', replace: true })).toBe('/sessions/s1/plan')
    expect(pathOf('/sessions/s1?x=1#top')).toBe('/sessions/s1')
    expect(isBehind('/sessions/s1', { back: '/sessions/s1?x=1' })).toBe(true)
    expect(isBehind('/sessions/s1', { back: '/' })).toBe(false)
    expect(isBehind('/sessions/s1', {})).toBe(false)
    expect(isBehind('/sessions/s1', null)).toBe(false)
  })

  it('goes Back for a plain click on the step it came from, and stops the link from adding a page', () => {
    const event = click()
    const r = router()
    expect(goBackIfBehind(event, r, '/sessions/s1', { back: '/sessions/s1' })).toBe(true)
    expect(event.defaultPrevented).toBe(true)
    expect(r.calls).toBe(1)
  })

  it('leaves a link to somewhere new, and a click that opens a new tab, to the link', () => {
    const r = router()
    expect(goBackIfBehind(click(), r, '/sessions/s1/plan', { back: '/sessions/s1' })).toBe(false)
    for (const extra of [{ metaKey: true }, { ctrlKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
      const event = click(extra)
      expect(goBackIfBehind(event, r, '/sessions/s1', { back: '/sessions/s1' })).toBe(false)
      expect(event.defaultPrevented).toBe(false)
    }
    expect(r.calls).toBe(0)
  })
})
