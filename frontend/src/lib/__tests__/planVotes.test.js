// lib/planVotes.js: what the votes in a slot make of its places, and a plan with the signed-in person's own vote set or taken back. Pure.
import { describe, expect, it } from 'vitest'
import { tallyOptions, withMyVote } from '../planVotes.js'

const nameOf = (id) => id.toUpperCase()
const option = (id) => ({ id, venue: { id }, votes: 0, voters: [] })

describe('tallyOptions', () => {
  it('counts, names the voters, finds the leader and says what the person voted', () => {
    const t = tallyOptions({ options: [option('a'), option('b')], votes: { ian: 'a', faith: 'a', nic: 'b' }, nameOf, me: 'ian' })
    expect(t.options.map((o) => [o.id, o.votes, o.voters.map((v) => v.name)])).toEqual([['a', 2, ['IAN', 'FAITH']], ['b', 1, ['NIC']]])
    expect(t).toMatchObject({ leader: 'a', topVotes: 2, tied: [], totalVotes: 3, myVote: 'a' })
  })

  it('has no leader on a tie, lists the tied places, and counts nothing for a place that is not offered', () => {
    const t = tallyOptions({ options: [option('a'), option('b')], votes: { ian: 'a', faith: 'b', nic: 'gone' }, nameOf, me: 'nic' })
    expect(t).toMatchObject({ leader: null, topVotes: 1, tied: ['a', 'b'], totalVotes: 2, myVote: null })
  })

  it('is empty with no votes', () => {
    expect(tallyOptions({ options: [option('a')], votes: undefined, nameOf, me: 'x' })).toMatchObject({ leader: null, topVotes: 0, tied: [], totalVotes: 0, myVote: null })
  })
})

describe('withMyVote', () => {
  const plan = () => {
    const slot = { id: 's1', category: 'eat', ...tallyOptions({ options: [option('a'), option('b')], votes: { faith: 'a' }, nameOf: (id) => (id === 'faith' ? 'Faith' : id), me: 'ian' }) }
    return { remote: true, slots: [slot, { id: 's2', category: 'drink', ...tallyOptions({ options: [option('c')], votes: {}, nameOf, me: 'ian' }) }], voters: ['faith'] }
  }

  it('sets the person\'s vote, keeping the others\' names, and lists the voters across the plan', () => {
    const next = withMyVote(plan(), 's1', 'b', 'ian', 'Ian')
    const eat = next.slots[0]
    expect(eat.options.map((o) => [o.id, o.votes])).toEqual([['a', 1], ['b', 1]])
    expect(eat.options[0].voters).toEqual([{ id: 'faith', name: 'Faith' }])
    expect(eat.options[1].voters).toEqual([{ id: 'ian', name: 'Ian' }])
    expect(eat).toMatchObject({ myVote: 'b', tied: ['a', 'b'], leader: null, totalVotes: 2 })
    expect(next.voters.sort()).toEqual(['faith', 'ian'])
  })

  it('moves a vote and takes it back by voting for the same place again, without changing the plan given', () => {
    const before = plan()
    const voted = withMyVote(before, 's1', 'a', 'ian', 'Ian')
    expect(voted.slots[0]).toMatchObject({ leader: 'a', topVotes: 2, myVote: 'a' })
    const back = withMyVote(voted, 's1', 'a', 'ian', 'Ian')
    expect(back.slots[0]).toMatchObject({ myVote: null, totalVotes: 1 })
    expect(back.voters).toEqual(['faith'])
    expect(before.slots[0].totalVotes).toBe(1)
  })

  it('leaves a plan alone for a slot or place that is not there', () => {
    const before = plan()
    expect(withMyVote(before, 'nope', 'a', 'ian', 'Ian')).toBe(before)
    expect(withMyVote(before, 's1', 'nope', 'ian', 'Ian')).toBe(before)
    expect(withMyVote(null, 's1', 'a', 'ian', 'Ian')).toBeNull()
  })
})
