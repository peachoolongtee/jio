// The session screens' small rules, written once in lib/session.js: what the itinerary's footer button does for each
// status, day and role; who may invite after the session has started; and the words for calling an outing off.
import { describe, expect, it } from 'vitest'
import { CANCEL_OUTING, inviteAccess, itineraryAction, locateNext } from '../session.js'

const session = (status, more = {}) => ({ id: 's1', status, hostId: 'ian', activeIds: ['ian', 'faith', 'darius'], isToday: false, ...more })

describe('the itinerary\'s main button', () => {
  it('is "save" before the session\'s day and "finish" on it, for a confirmed plan', () => {
    expect(itineraryAction(session('confirmed'))).toBe('save')
    expect(itineraryAction(session('confirmed', { isToday: true }))).toBe('finish')
  })

  it('is the same for a guest as for the host: the data layer lets any member finish', () => {
    // The rule reads the session, not the person.
    expect(itineraryAction(session('confirmed', { hostId: 'faith' }))).toBe('save')
    expect(itineraryAction(session('confirmed', { hostId: 'faith', isToday: true }))).toBe('finish')
  })

  it('is nothing for a session that is not confirmed: voting, completed, cancelled, or none', () => {
    for (const status of ['inviting', 'locating', 'voting', 'completed', 'cancelled']) {
      expect(itineraryAction(session(status))).toBeNull()
      expect(itineraryAction(session(status, { isToday: true }))).toBeNull()
    }
    expect(itineraryAction(null)).toBeNull()
  })
})

describe('who can invite once the session has started', () => {
  it('lets the host while inviting, locating and voting', () => {
    for (const status of ['inviting', 'locating', 'voting']) expect(inviteAccess(session(status), true)).toEqual({ open: true, text: '' })
  })

  it('lets the host of a confirmed plan only when too few people are left', () => {
    expect(inviteAccess(session('confirmed'), true)).toEqual({ open: false, text: 'The plan is confirmed, so invites are closed.' })
    expect(inviteAccess(session('confirmed', { activeIds: ['ian'] }), true).open).toBe(true)
  })

  it('is closed for a finished or cancelled session, and says why', () => {
    expect(inviteAccess(session('completed'), true)).toEqual({ open: false, text: 'The outing is over, so invites are closed.' })
    expect(inviteAccess(session('cancelled'), true)).toEqual({ open: false, text: 'The outing was cancelled, so invites are closed.' })
    // Not even a session that was paused when it was called off.
    expect(inviteAccess(session('cancelled', { activeIds: ['ian'] }), true).open).toBe(false)
  })

  it('is closed for a guest, and names the host', () => {
    expect(inviteAccess(session('locating', { hostId: 'faith' }), false, 'Faith')).toEqual({ open: false, text: 'Only Faith can invite people.' })
    expect(inviteAccess(session('inviting', { hostId: 'faith' }), false).text).toBe('Only the host can invite people.')
  })

  it('tells a guest the session is closed, not that they lack a right, when it is closed for everyone', () => {
    expect(inviteAccess(session('completed', { hostId: 'faith' }), false, 'Faith').text).toBe('The outing is over, so invites are closed.')
  })
})

describe('the words for calling an outing off', () => {
  it('say "outing", and the same thing everywhere', () => {
    expect(CANCEL_OUTING).toEqual({
      hold: 'Hold to cancel',
      action: 'Cancel outing',
      title: 'Cancel outing?',
      text: 'The outing is cancelled for everyone in it and moves to your past sessions. This cannot be undone.',
      keep: 'Keep outing',
      confirm: 'Cancel outing',
    })
  })

  it('keep the hold button\'s visible words inside its spoken name, as the accessibility rules need', () => {
    // HoldButton reads `${label} (${action}). Press and hold...`.
    expect(`${CANCEL_OUTING.hold} (${CANCEL_OUTING.action})`).toContain(CANCEL_OUTING.hold)
    expect(Object.values(CANCEL_OUTING).join(' ')).not.toMatch(/\bend\b/i)
  })
})

describe('the Locate page\'s main button once the spot is confirmed', () => {
  it('opens the Vote page while the group votes', () => {
    expect(locateNext({ id: 's1', status: 'voting' })).toEqual({ label: 'Choose places', to: '/sessions/s1/plan' })
  })

  it('opens the plan once it is confirmed, titled for today on the day', () => {
    expect(locateNext({ id: 's1', status: 'confirmed', isToday: true })).toEqual({ label: "Today's plan", to: '/sessions/s1/itinerary' })
    expect(locateNext({ id: 's1', status: 'confirmed', isToday: false })).toEqual({ label: 'See the plan', to: '/sessions/s1/itinerary' })
  })

  it('opens the plan of a finished outing, never as today\'s', () => {
    expect(locateNext({ id: 's1', status: 'completed', isToday: true })).toEqual({ label: 'See the plan', to: '/sessions/s1/itinerary' })
  })

  it('never says "Next"', () => {
    for (const status of ['voting', 'confirmed', 'completed']) expect(locateNext({ id: 's1', status }).label).not.toBe('Next')
  })
})
