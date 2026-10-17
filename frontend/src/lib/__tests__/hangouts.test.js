// Frequent hangouts and the Jio streak on the invite page (ticket #121): the order and the count come from completed
// outings only, and a person with no history sees one plain list.
import { describe, expect, it } from 'vitest'
import { FREQUENT_MAX, inviteGroups, outingsTogether, streakText } from '../hangouts.js'

const member = (id, state = 'joined') => ({ id, role: id === 'ian' ? 'host' : 'guest', state })
const outing = (status, ids, more = {}) => ({ status, members: ids.map((x) => (typeof x === 'string' ? member(x) : member(...x))), ...more })
const friend = (id, name) => ({ id, name, username: id, isFriend: true })

describe('the Jio streak', () => {
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
    expect(streakText(0)).toBe('')
    expect(streakText(1)).toBe('1 outing together')
    expect(streakText(4)).toBe('4 outings together')
  })
})

describe('the invite page\'s groups', () => {
  const friends = [friend('darius', 'Darius'), friend('faith', 'Faith'), friend('nicole', 'Nicole'), friend('jonathan', 'Jonathan')]

  it('puts the people I go out with most first, then everyone else by name', () => {
    const { frequent, all } = inviteGroups(friends, { faith: 2, nicole: 5, darius: 2 })
    expect(frequent.map((p) => [p.id, p.streak])).toEqual([['nicole', 5], ['darius', 2], ['faith', 2]])
    expect(all.map((p) => [p.id, p.streak])).toEqual([['jonathan', 0]])
  })

  it('is one plain list, by name, for a person with no history', () => {
    const { frequent, all } = inviteGroups(friends, {})
    expect(frequent).toEqual([])
    expect(all.map((p) => p.id)).toEqual(['darius', 'faith', 'jonathan', 'nicole'])
  })

  it('keeps the frequent group short; the rest stay under All friends with their streak', () => {
    const many = Array.from({ length: FREQUENT_MAX + 2 }, (_, i) => friend(`p${i}`, `Person ${i}`))
    const counts = Object.fromEntries(many.map((p, i) => [p.id, i + 1]))
    const { frequent, all } = inviteGroups(many, counts)
    expect(frequent).toHaveLength(FREQUENT_MAX)
    expect(frequent[0].id).toBe(`p${FREQUENT_MAX + 1}`)
    expect(all.map((p) => p.streak)).toEqual([1, 2])
  })

  it('reads the counts from completed outings end to end', () => {
    const sessions = [outing('completed', ['ian', 'faith']), outing('cancelled', ['ian', 'darius'])]
    const { frequent, all } = inviteGroups(friends, outingsTogether(sessions, 'ian'))
    expect(frequent.map((p) => p.id)).toEqual(['faith'])
    expect(all.map((p) => p.id)).toEqual(['darius', 'jonathan', 'nicole'])
  })
})
