// The steps bar: which step a session has reached, which one is on screen, and which can be opened. Imported from the
// single-file component, like the other small pure functions.
import { beforeEach, describe, expect, it } from 'vitest'
import { backFor, reachedStep, stepsFor, viewingStep } from '../../components/event/SessionSteps.vue'
import { exitFor, forgetEntry, goBackIfBehind, isBehind, pathOf, rememberEntry } from '../stepNav.js'

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
    // "What next?" is part of the Itinerary step too.
    expect(viewingStep(voting, '/roam')).toBe(4)
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

describe('where the button at the top left goes', () => {
  const back = (status, path, mine = true, more = {}) => backFor(session(status, more), `/sessions/s1${path}`, mine)
  const home = { label: 'Back to Home', to: '/' }

  it('leaves for Home from the session page, Vote and the Itinerary, at every status', () => {
    for (const status of ['inviting', 'locating', 'voting', 'confirmed', 'completed']) {
      for (const path of ['', '/plan', '/itinerary']) expect(back(status, path)).toEqual(home)
    }
    expect(back('voting', '', false, { hostId: 'faith' })).toEqual(home)
  })

  it('goes from Invite to Create for the host, replacing it, and Home for a guest', () => {
    expect(back('inviting', '/invite')).toEqual({ label: 'Back to date and times', to: { path: '/sessions/s1/edit', replace: true } })
    expect(back('voting', '/invite')).toEqual({ label: 'Back to date and times', to: { path: '/sessions/s1/edit', replace: true } })
    expect(back('voting', '/invite', false, { hostId: 'faith' })).toEqual(home)
  })

  it('goes Home from Create, the first step', () => {
    expect(back('inviting', '/edit')).toEqual(home)
    expect(backFor(null, '/sessions/new')).toEqual(home)
  })

  it('takes the photos and the full map back to the Itinerary', () => {
    expect(back('completed', '/photos')).toEqual({ label: 'Back to Itinerary', to: '/sessions/s1/itinerary' })
    expect(back('confirmed', '/map')).toEqual({ label: 'Back to Itinerary', to: '/sessions/s1/itinerary' })
    expect(back('confirmed', '/roam')).toEqual({ label: 'Back to Itinerary', to: '/sessions/s1/itinerary' })
  })

  it('leaves to the screen the session was opened from, when told one', () => {
    const sessions = { label: 'Back to Sessions', to: '/sessions' }
    for (const path of ['', '/plan', '/itinerary']) expect(backFor(session('voting'), `/sessions/s1${path}`, true, sessions)).toEqual(sessions)
    // The forms leave to it too, where they used to go Home; the photos and the map still go to the Itinerary.
    expect(backFor(session('inviting'), '/sessions/s1/edit', true, sessions)).toEqual(sessions)
    expect(backFor(session('voting', { hostId: 'faith' }), '/sessions/s1/invite', false, sessions)).toEqual(sessions)
    expect(backFor(session('confirmed'), '/sessions/s1/photos', true, sessions).to).toBe('/sessions/s1/itinerary')
  })

  it('reaches Home in at most three presses from anywhere, without a loop', () => {
    for (const start of ['/photos', '/map', '/itinerary', '/plan', '', '/invite', '/edit']) {
      const seen = []
      let path = start
      for (let i = 0; i < 4 && path !== null; i++) {
        const next = back('confirmed', path)
        const to = typeof next.to === 'string' ? next.to : next.to.path
        seen.push(to)
        path = to === '/' ? null : to.replace('/sessions/s1', '')
      }
      expect(seen.at(-1)).toBe('/')
      expect(new Set(seen).size).toBe(seen.length)
    }
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

describe('the screen a session was opened from', () => {
  const tabs = (path, title, fullPath = path) => ({ path, fullPath, meta: { tabs: true, title } })
  const page = (path) => ({ path, fullPath: path, meta: {} })
  beforeEach(forgetEntry)

  it('is Home until a session is opened from somewhere', () => {
    expect(exitFor()).toEqual({ label: 'Back to Home', to: '/' })
  })

  it('remembers the tab-bar screen a session was opened from, with its query', () => {
    rememberEntry(page('/sessions/s1'), tabs('/sessions', 'Sessions'))
    expect(exitFor()).toEqual({ label: 'Back to Sessions', to: '/sessions' })
    rememberEntry(page('/sessions/s2/plan'), tabs('/', 'Home', '/?meetup=s2'))
    expect(exitFor()).toEqual({ label: 'Back to Home', to: '/?meetup=s2' })
  })

  it('keeps it while the person moves about inside the session, and to other pages without the tab bar', () => {
    rememberEntry(page('/sessions/s1'), tabs('/profile', 'Profile'))
    rememberEntry(page('/sessions/s1/plan'), page('/sessions/s1'))
    rememberEntry(page('/sessions/s1/itinerary'), page('/sessions/s1/plan'))
    rememberEntry(page('/people/faith'), page('/sessions/s1'))
    expect(exitFor()).toEqual({ label: 'Back to Profile', to: '/profile' })
  })

  it('does not take the Sessions list itself, or any other tab-bar screen, for a session', () => {
    rememberEntry(tabs('/sessions', 'Sessions'), tabs('/', 'Home'))
    rememberEntry(tabs('/leaderboard', 'Leaderboard'), tabs('/', 'Home'))
    expect(exitFor()).toEqual({ label: 'Back to Home', to: '/' })
  })

  it('forgets it when asked', () => {
    rememberEntry(page('/sessions/s1'), tabs('/sessions', 'Sessions'))
    forgetEntry()
    expect(exitFor().to).toBe('/')
  })
})
