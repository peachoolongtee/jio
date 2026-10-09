// Other people on Jio: they review places alongside Ian's friends, and join his leaderboard once he adds them.
import { describe, expect, it } from 'vitest'
import * as api from '../api.js'
import { COMMUNITY, isCommunity } from '../mock/people.js'
import { reviewsFor } from '../mock/reviews.js'
import { VENUES } from '../mock/venues.js'

describe('other people on Jio', () => {
  it('review places alongside friends', () => {
    for (const venue of VENUES.slice(0, 20)) {
      const reviews = reviewsFor(venue)
      expect(reviews.some((r) => isCommunity(r.personId))).toBe(true)
      expect(reviews.some((r) => !isCommunity(r.personId))).toBe(true)
      expect(new Set(reviews.map((r) => r.personId)).size).toBe(reviews.length)
    }
  })

  it('join the leaderboard once added as a friend, with no ties', async () => {
    await api.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', homeAreaId: 'bishan', friends: ['darius', 'jonathan', 'nicole', 'faith', 'darryl'] })
    const before = await api.getLeaderboard()
    expect(before.some((r) => isCommunity(r.id))).toBe(false)
    expect((await api.listPeople()).find((p) => p.id === 'meiling').isFriend).toBe(false)

    for (const p of COMMUNITY) await api.setFriend(p.id, true)
    const after = await api.getLeaderboard()
    expect(after).toHaveLength(before.length + COMMUNITY.length)
    expect(new Set(after.map((r) => r.rank)).size).toBe(after.length)
  })
})
