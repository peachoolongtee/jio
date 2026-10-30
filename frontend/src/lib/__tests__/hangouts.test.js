// Frequent hangouts and the outings-together count on the invite page (ticket #121): the order and the count come from completed
// outings only, and a person with no history sees one plain list.
import { describe, expect, it } from 'vitest'
import { FREQUENT_MAX, inviteGroups, isMilestone, milestoneText, ordinalWord, outingMilestones, outingsTogether, outingsWith, togetherLine, togetherText } from '../hangouts.js'

const member = (id, state = 'joined') => ({ id, role: id === 'ian' ? 'host' : 'guest', state })
const outing = (status, ids, more = {}) => ({ status, members: ids.map((x) => (typeof x === 'string' ? member(x) : member(...x))), ...more })
const friend = (id, name) => ({ id, name, username: id, isFriend: true })

describe('outings together', () => {
  it('counts the completed outings each person shared with me', () => {
    const sessions = [
      outing('completed', ['ian', 'faith', 'darius'], { endedBy: 'hand' }),
      outing('completed', ['ian', 'faith'], { endedBy: 'auto' }),
      outing('completed', ['ian', 'faith']),
    ]
    expect(outingsTogether(sessions, 'ian')).toEqual({ faith: 3, darius: 1 })
  })

  it('leaves out outings that did not happen: not completed, cancelled, or closed with no plan', () => {
    const sessions = ['inviting', 'locating', 'voting', 'confirmed', 'cancelled'].map((s) => outing(s, ['ian', 'faith']))
    sessions.push(outing('completed', ['ian', 'faith'], { endedBy: 'closed' }))
    expect(outingsTogether(sessions, 'ian')).toEqual({})
  })

  it('counts only people who were in it, with me in it too', () => {
    const sessions = [
      outing('completed', ['ian', ['faith', 'opted_out'], ['darius', 'invited'], 'nicole']),
      outing('completed', [['ian', 'opted_out'], 'faith']),
      outing('completed', ['faith', 'darius']),
    ]
    expect(outingsTogether(sessions, 'ian')).toEqual({ nicole: 1 })
  })

  it('says how many in words', () => {
    expect(togetherText(0)).toBe('')
    expect(togetherText(1)).toBe('1 outing together')
    expect(togetherText(4)).toBe('4 outings together')
  })
})

describe('the invite page\'s groups', () => {
  const friends = [friend('darius', 'Darius'), friend('faith', 'Faith'), friend('nicole', 'Nicole'), friend('jonathan', 'Jonathan')]

  it('puts the people I go out with most first, then everyone else by name', () => {
    const { frequent, all } = inviteGroups(friends, { faith: 2, nicole: 5, darius: 2 })
    expect(frequent.map((p) => [p.id, p.together])).toEqual([['nicole', 5], ['darius', 2], ['faith', 2]])
    expect(all.map((p) => [p.id, p.together])).toEqual([['jonathan', 0]])
  })

  it('is one plain list, by name, for a person with no history', () => {
    const { frequent, all } = inviteGroups(friends, {})
    expect(frequent).toEqual([])
    expect(all.map((p) => p.id)).toEqual(['darius', 'faith', 'jonathan', 'nicole'])
  })

  it('keeps the frequent group short; the rest stay under All friends with their count', () => {
    const many = Array.from({ length: FREQUENT_MAX + 2 }, (_, i) => friend(`p${i}`, `Person ${i}`))
    const counts = Object.fromEntries(many.map((p, i) => [p.id, i + 1]))
    const { frequent, all } = inviteGroups(many, counts)
    expect(frequent).toHaveLength(FREQUENT_MAX)
    expect(frequent[0].id).toBe(`p${FREQUENT_MAX + 1}`)
    expect(all.map((p) => p.together)).toEqual([1, 2])
  })

  it('builds the two groups from the counts of completed outings (the two helpers together; no screen is drawn)', () => {
    const sessions = [outing('completed', ['ian', 'faith']), outing('cancelled', ['ian', 'darius'])]
    const { frequent, all } = inviteGroups(friends, outingsTogether(sessions, 'ian'))
    expect(frequent.map((p) => p.id)).toEqual(['faith'])
    expect(all.map((p) => p.id)).toEqual(['darius', 'jonathan', 'nicole'])
  })
})

describe('outings with one person', () => {
  const sessions = [
    outing('completed', ['ian', 'faith'], { date: '2026-10-05' }),
    outing('completed', ['ian', 'faith', 'darius'], { date: '2026-10-12' }),
    outing('completed', ['ian', 'faith'], { date: '2026-09-20' }),
  ]

  it('counts them and gives the day of the latest, whatever order they come in', () => {
    expect(outingsWith(sessions, 'ian', 'faith')).toEqual({ count: 3, last: '2026-10-12' })
    expect(outingsWith(sessions, 'ian', 'darius')).toEqual({ count: 1, last: '2026-10-12' })
  })

  it('is empty with no outings together', () => {
    expect(outingsWith(sessions, 'ian', 'nicole')).toEqual({ count: 0, last: null })
    expect(outingsWith([], 'ian', 'faith')).toEqual({ count: 0, last: null })
    expect(outingsWith(undefined, 'ian', 'faith')).toEqual({ count: 0, last: null })
  })

  it('leaves out what did not happen, as the count on the invite page does', () => {
    const not = [
      outing('cancelled', ['ian', 'faith'], { date: '2026-10-20' }),
      outing('completed', ['ian', 'faith'], { date: '2026-10-21', endedBy: 'closed' }),
      outing('completed', ['ian', ['faith', 'opted_out']], { date: '2026-10-22' }),
      outing('completed', [['ian', 'opted_out'], 'faith'], { date: '2026-10-23' }),
      outing('completed', ['ian', 'faith'], { date: '2026-10-01' }),
    ]
    expect(outingsWith(not, 'ian', 'faith')).toEqual({ count: 1, last: '2026-10-01' })
    // The same people the count on the invite page names.
    expect(outingsTogether(not, 'ian').faith).toBe(1)
  })

  it('writes the profile line, or nothing', () => {
    expect(togetherLine(3, '12 Oct 2026')).toBe('3 outings together · last on 12 Oct 2026')
    expect(togetherLine(1, '12 Oct 2026')).toBe('1 outing together · last on 12 Oct 2026')
    expect(togetherLine(2, '')).toBe('2 outings together')
    expect(togetherLine(0, '12 Oct 2026')).toBe('')
  })
})

describe('milestones', () => {
  it('marks the 1st, the 5th, the 10th and every 10th after', () => {
    const marked = [0, 1, 2, 3, 4, 5, 6, 9, 10, 11, 15, 20, 30, 100].filter(isMilestone)
    expect(marked).toEqual([1, 5, 10, 20, 30, 100])
  })

  it('says the ordinals in words', () => {
    expect([1, 2, 3, 5, 10, 11, 12, 13, 20, 21, 22, 100].map(ordinalWord)).toEqual(['first', '2nd', '3rd', '5th', '10th', '11th', '12th', '13th', '20th', '21st', '22nd', '100th'])
  })

  // `n` earlier outings with each id, then the one just finished (the last in the list).
  const history = (ids, n, more = {}) => Array.from({ length: n }, (_, i) => ({ id: `old-${ids.join('')}-${i}`, ...outing('completed', ['ian', ...ids]), date: '2026-09-01', completedAt: 1000 + i, ...more }))
  const finished = (ids, more = {}) => ({ id: 'now', ...outing('completed', ['ian', ...ids]), date: '2026-10-30', completedAt: 9e12, ...more })
  const milestonesAfter = (before, session) => outingMilestones([...before, session], 'ian', session)

  it.each([
    [0, 1],
    [1, null],
    [4, 5],
    [8, null],
    [9, 10],
    [19, 20],
  ])('with %i earlier outings the one just finished is %s', (earlier, milestone) => {
    const got = milestonesAfter(history(['faith'], earlier), finished(['faith']))
    expect(got).toEqual(milestone ? [{ id: 'faith', n: milestone }] : [])
  })

  it('counts the outing just finished even when the list does not hold it yet', () => {
    expect(outingMilestones(history(['faith'], 4), 'ian', finished(['faith']))).toEqual([{ id: 'faith', n: 5 }])
  })

  it('does not change when later outings are added', () => {
    const session = finished(['faith'], { completedAt: 5000 })
    const sessions = [...history(['faith'], 4), session, { id: 'later', ...outing('completed', ['ian', 'faith']), date: '2026-10-31', completedAt: 6000 }]
    expect(outingMilestones(sessions, 'ian', session)).toEqual([{ id: 'faith', n: 5 }])
  })

  it('names nobody for a cancelled outing, a closed one, or one I was not in', () => {
    const before = history(['faith'], 4)
    expect(milestonesAfter(before, finished(['faith'], { status: 'cancelled' }))).toEqual([])
    expect(milestonesAfter(before, finished(['faith'], { endedBy: 'closed' }))).toEqual([])
    expect(milestonesAfter(before, finished([['faith', 'joined']], { members: [member('faith'), member('darius')] }))).toEqual([])
    expect(outingMilestones(before, 'ian', null)).toEqual([])
  })

  it('does not count an opted-out friend, nor earlier outings they left or that closed', () => {
    const before = [...history(['faith'], 3), ...history(['faith'], 2, { endedBy: 'closed' }), ...history(['faith'], 2, { status: 'cancelled' })]
    // Faith's 4th real outing: no milestone. An opted-out Darius is not named even at his first.
    expect(milestonesAfter(before, finished(['faith', ['darius', 'opted_out']]))).toEqual([])
    expect(milestonesAfter(history(['faith'], 4), finished([['faith', 'opted_out'], 'darius']))).toEqual([{ id: 'darius', n: 1 }])
  })

  it('leaves out friends who are not at a milestone', () => {
    const before = [...history(['faith'], 4), ...history(['darius'], 2)]
    expect(milestonesAfter(before, finished(['faith', 'darius']))).toEqual([{ id: 'faith', n: 5 }])
  })

  describe('the sentence', () => {
    const nameOf = (id) => ({ faith: 'Faith', darius: 'Darius', nicole: 'Nicole', jonathan: 'Jonathan' })[id]
    it('is empty with none', () => {
      expect(milestoneText([], nameOf)).toBe('')
      expect(milestoneText(undefined, nameOf)).toBe('')
    })
    it('names one friend', () => {
      expect(milestoneText([{ id: 'faith', n: 5 }], nameOf)).toBe("That's your 5th outing with Faith.")
      expect(milestoneText([{ id: 'faith', n: 1 }], nameOf)).toBe("That's your first outing with Faith.")
    })
    it('names two friends at the same number together', () => {
      expect(milestoneText([{ id: 'faith', n: 5 }, { id: 'darius', n: 5 }], nameOf)).toBe("That's your 5th outing with Faith and Darius.")
    })
    it('names two and counts the rest', () => {
      const three = ['faith', 'darius', 'nicole'].map((id) => ({ id, n: 10 }))
      expect(milestoneText(three, nameOf)).toBe("That's your 10th outing with Faith, Darius and 1 other.")
      expect(milestoneText([...three, { id: 'jonathan', n: 10 }], nameOf)).toBe("That's your 10th outing with Faith, Darius and 2 others.")
    })
    it('gives one sentence for each number, the biggest first, and at most two', () => {
      expect(milestoneText([{ id: 'faith', n: 5 }, { id: 'darius', n: 10 }], nameOf)).toBe("That's your 10th outing with Darius. That's your 5th outing with Faith.")
      const mixed = [{ id: 'faith', n: 1 }, { id: 'darius', n: 5 }, { id: 'nicole', n: 10 }]
      expect(milestoneText(mixed, nameOf)).toBe("That's your 10th outing with Nicole. That's your 5th outing with Darius.")
    })
    it('does not lose a friend whose name is not known', () => {
      expect(milestoneText([{ id: 'x', n: 5 }], () => '')).toBe("That's your 5th outing with a friend.")
    })
  })
})
