// Roam's small rules, which have no screen: what a place's card says and offers in each case, the proposed rows under the
// itinerary for the host and for everyone else, the words for the centre and the distance, when the page is open, Home's
// chip, and what the demo tools' friend does. The data layer's own rules are in roam.test.js.
import { describe, expect, it, vi } from 'vitest'
import { ROAM, centreLine, closedText, isProposal, placeAction, placeState, proposalsOf, proposeBlock, proposedRows, travelLine } from '../roam.js'
import { itineraryAction, roamOpen } from '../session.js'
import { nextStepFor } from '../homeMeetups.js'
import { friendProposes } from '../../components/dev/roamDemo.js'

const venue = (id, name = `Place ${id}`) => ({ id, name, category: 'eat', area: 'Bishan', price: 10 })

describe('what a place on the list offers', () => {
  const free = { id: 'v1', venue: venue('v1', 'Green Kitchen'), state: 'free', proposal: null }

  it('is "Propose" for a place nobody has put forward, named for a screen reader', () => {
    expect(placeAction(free, { myId: 'ian' })).toMatchObject({ kind: 'free', tag: '', button: 'Propose', label: 'Propose Green Kitchen as the next stop', disabled: false })
  })

  it('turns "Propose" off, not away, when the person cannot propose now', () => {
    expect(placeAction(free, { myId: 'ian', blocked: 'You have 3 places waiting. Take one back to propose another.' })).toMatchObject({ kind: 'free', button: 'Propose', disabled: true })
  })

  it('says "Proposed by you" with a way to take it back, for your own proposal', () => {
    const mine = { ...free, state: 'proposed', proposal: { id: 'pp1', by: 'ian', byName: 'Ian' } }
    expect(placeAction(mine, { myId: 'ian' })).toMatchObject({ kind: 'mine', tag: 'Proposed by you', button: 'Take back', label: 'Take back your proposal of Green Kitchen', disabled: false })
  })

  it('says who proposed it for someone else\'s, and offers nothing to press', () => {
    const theirs = { ...free, state: 'proposed', proposal: { id: 'pp1', by: 'faith', byName: 'Faith' } }
    expect(placeAction(theirs, { myId: 'ian' })).toMatchObject({ kind: 'theirs', tag: 'Proposed by Faith', button: '' })
    // A proposer whose name is missing is still someone.
    expect(placeAction({ ...theirs, proposal: { id: 'pp1', by: 'faith' } }, { myId: 'ian' }).tag).toBe('Proposed by a friend')
  })

  it('says a place already in the plan is in the plan, with nothing to press', () => {
    expect(placeAction({ ...free, state: 'stop' }, { myId: 'ian', blocked: 'x' })).toMatchObject({ kind: 'stop', tag: 'In the plan', button: '', disabled: false })
  })

  it('tells a stop, a proposal and a free place apart', () => {
    const proposals = [{ id: 'pp1', venueId: 'v2', by: 'faith' }]
    expect(placeState('v1', ['v1'], proposals).state).toBe('stop')
    expect(placeState('v2', ['v1'], proposals)).toEqual({ state: 'proposed', proposal: proposals[0] })
    expect(placeState('v3', ['v1'], proposals)).toEqual({ state: 'free', proposal: null })
    // A place in the plan is a stop even if it was proposed before.
    expect(placeState('v1', ['v1'], [{ id: 'pp9', venueId: 'v1', by: 'faith' }]).state).toBe('stop')
  })
})

describe('the proposed stops under the itinerary', () => {
  const session = (over = {}) => ({
    hostId: 'ian',
    hostName: 'Ian',
    proposals: [
      { id: 'pp1', venue: venue('v1', 'Green Kitchen'), by: 'faith', byName: 'Faith' },
      { id: 'pp2', venue: venue('v2', 'Corner Bowling'), by: 'ian', byName: 'Ian' },
    ],
    ...over,
  })

  it('gives the host "Add to plan" and "Not now" on every row, and who proposed it', () => {
    const rows = proposedRows(session(), 'ian')
    expect(rows.map((r) => [r.name, r.tag, r.canDecide, r.canTakeBack, r.waiting])).toEqual([
      ['Green Kitchen', 'Proposed by Faith', true, false, ''],
      ['Corner Bowling', 'Proposed by you', true, false, ''],
    ])
  })

  it('shows a guest who proposed it and that the host decides, with "Take back" only on their own', () => {
    const rows = proposedRows(session({ hostId: 'faith', hostName: 'Faith' }), 'ian')
    expect(rows[0]).toMatchObject({ tag: 'Proposed by Faith', canDecide: false, canTakeBack: false, waiting: 'Waiting for Faith to decide' })
    expect(rows[1]).toMatchObject({ tag: 'Proposed by you', canDecide: false, canTakeBack: true, waiting: 'Waiting for Faith to decide' })
  })

  it('has no rows when there are no proposals, or a session without the field', () => {
    expect(proposedRows(session({ proposals: [] }), 'ian')).toEqual([])
    expect(proposedRows({ hostId: 'ian' }, 'ian')).toEqual([])
    expect(proposedRows(null, 'ian')).toEqual([])
  })

  it('names the host in the waiting line, and says "the host" when the name is missing', () => {
    expect(proposedRows(session({ hostId: 'faith', hostName: '' }), 'ian')[0].waiting).toBe('Waiting for the host to decide')
  })
})

describe('the limits and their words', () => {
  it('are 3 for a member, 10 for a session, 8 stops and an hour for an added stop', () => {
    expect(ROAM).toEqual({ perMember: 3, perSession: 10, stops: 8, minutes: 60 })
  })

  it('say why a place cannot be proposed, the full plan first', () => {
    expect(proposeBlock({ stops: 2, mine: 0, total: 0 })).toBe('')
    expect(proposeBlock({ stops: 2, mine: 3, total: 3 })).toBe('You have 3 places waiting. Take one back to propose another.')
    expect(proposeBlock({ stops: 2, mine: 3, total: 3, you: false, name: 'Faith' })).toBe('Faith has 3 places waiting.')
    expect(proposeBlock({ stops: 2, mine: 1, total: 10 })).toBe('10 places are already waiting for the host.')
    expect(proposeBlock({ stops: 8, mine: 3, total: 10 })).toBe('The plan has 8 stops, the most it can hold.')
  })

  it('treat a missing or damaged list of proposals as the whole proposals in it', () => {
    expect(proposalsOf({})).toEqual([])
    expect(proposalsOf(null)).toEqual([])
    expect(proposalsOf({ proposals: 'x' })).toEqual([])
    expect(proposalsOf({ proposals: [{ id: 'a', venueId: 'v', by: 'ian' }, {}, null] })).toHaveLength(1)
    expect(isProposal({ id: 'a', venueId: 'v', by: 'ian' })).toBe(true)
    expect(isProposal({ id: 'a' })).toBe(false)
  })
})

describe('the words for where and how far', () => {
  it('names the meeting area, or the person\'s own area without saying where they are', () => {
    expect(centreLine('meeting', 'Bishan')).toBe('Near Bishan')
    expect(centreLine('area', 'Orchard')).toBe('Near Orchard')
    expect(centreLine('here', 'Toa Payoh')).toBe('Near you, in Toa Payoh')
    expect(centreLine('meeting', '')).toBe('')
  })

  it('says "about" for the time, never zero minutes, and the distance in m or km', () => {
    expect(travelLine({ travelMinutes: 4.4, distanceM: 250 })).toBe('about 4 min away · 250 m')
    expect(travelLine({ travelMinutes: 0, distanceM: 50 })).toBe('about 1 min away · 50 m')
    expect(travelLine({ travelMinutes: 12.6, distanceM: 1830 })).toBe('about 13 min away · 1.8 km')
    expect(travelLine({ distanceM: 400 })).toBe('400 m')
    expect(travelLine({})).toBe('')
  })
})

describe('when "What next?" is open', () => {
  const session = (status, isToday) => ({ status, isToday })

  it('is open for a confirmed plan on its day: the moment the footer says "Finish outing"', () => {
    expect(roamOpen(session('confirmed', true))).toBe(true)
    expect(itineraryAction(session('confirmed', true))).toBe('finish')
    for (const s of [session('confirmed', false), session('voting', true), session('locating', true), session('completed', true), session('cancelled', true)]) expect(roamOpen(s)).toBe(false)
    expect(roamOpen(null)).toBe(false)
  })

  it('says why not on the page when it is opened by its address too early or too late', () => {
    expect(closedText(session('confirmed', true))).toBe('')
    expect(closedText(session('confirmed', false))).toBe('What next? opens on the day of the outing.')
    expect(closedText(session('voting', true))).toBe('What next? opens once the plan is confirmed.')
    expect(closedText(session('completed', true))).toBe('This outing is over.')
    expect(closedText(session('cancelled', false))).toBe('This outing was cancelled.')
  })
})

describe('Home\'s chip for a plan with a proposal waiting', () => {
  const base = { id: 's1', hostId: 'ian', status: 'confirmed', activeIds: ['ian', 'faith'], members: [], isToday: true, replan: null, locations: {}, votes: {} }
  const waiting = [{ id: 'pp1', venueId: 'v1', by: 'faith' }]

  it('asks the host to review it', () => {
    expect(nextStepFor({ ...base, proposals: waiting }, 'ian')).toEqual({ label: 'Review a proposal', tone: 'action', to: '/sessions/s1/itinerary' })
  })

  it('says nothing new to everyone else', () => {
    expect(nextStepFor({ ...base, proposals: waiting }, 'faith')).toEqual({ label: "Today's plan", tone: 'done', to: '/sessions/s1/itinerary' })
  })

  it('changes no existing answer: no proposals, the old save without the field, a re-plan to review, and the day before', () => {
    expect(nextStepFor({ ...base, proposals: [] }, 'ian').label).toBe("Today's plan")
    expect(nextStepFor(base, 'ian').label).toBe("Today's plan")
    expect(nextStepFor({ ...base, isToday: false }, 'ian').label).toBe('See the plan')
    expect(nextStepFor({ ...base, proposals: waiting, replan: { reason: 'moved' } }, 'ian').label).toBe('Review the re-plan')
    expect(nextStepFor({ ...base, status: 'voting', proposals: waiting }, 'ian').label).toBe('Vote')
  })
})

describe('the demo tools\' friend', () => {
  const places = [{ id: 'v1', state: 'stop', venue: venue('v1') }, { id: 'v2', state: 'proposed', venue: venue('v2') }, { id: 'v3', state: 'free', venue: venue('v3', 'Corner Bowling') }]
  const api = (list = places) => ({ roamNearby: vi.fn().mockResolvedValue({ places: list }), proposeStop: vi.fn().mockResolvedValue({}) })

  it('proposes the best place that is free, as the friend with the fewest waiting', async () => {
    const stand = api()
    const session = { id: 's1', proposals: [{ by: 'faith' }] }
    const said = await friendProposes(stand, session, ['faith', 'jonathan'])
    expect(stand.proposeStop).toHaveBeenCalledWith('s1', 'jonathan', 'v3')
    expect(said).toBe('Jonathan proposed Corner Bowling.')
  })

  it('says so when there is nobody to propose, nothing free, or the friend is at the limit', async () => {
    expect(await friendProposes(api(), { id: 's1' }, [])).toBe('Invite a friend first.')
    const none = api([places[0]])
    expect(await friendProposes(none, { id: 's1' }, ['faith'])).toBe('Nothing nearby is free to propose.')
    expect(none.proposeStop).not.toHaveBeenCalled()
    const full = api()
    expect(await friendProposes(full, { id: 's1', proposals: [{ by: 'faith' }, { by: 'faith' }, { by: 'faith' }] }, ['faith'])).toBe('Faith already has 3 places waiting.')
    expect(full.roamNearby).not.toHaveBeenCalled()
  })
})
