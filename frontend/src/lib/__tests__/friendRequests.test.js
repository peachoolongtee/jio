// Friend requests for the demo and local accounts: a request waits, then is accepted; signing out drops what is waiting (review of
// 1 November 2026: the acceptance would have run for whoever was signed in next). Plain functions with a stood-in clock. No network.
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cancelFriendRequests, sendFriendRequest, useFriendRequests } from '../friendRequests.js'

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
  cancelFriendRequests()
  vi.useRealTimers()
})

describe('a friend request', () => {
  it('waits, then is accepted, and says so', async () => {
    const setFriend = vi.fn().mockResolvedValue()
    const { requested, announcement } = useFriendRequests()
    const done = sendFriendRequest({ id: 'kai', name: 'Kai' }, setFriend, { after: 100 })
    expect(requested.value.has('kai')).toBe(true)
    expect(announcement.value).toBe('Friend request sent to Kai')
    await vi.advanceTimersByTimeAsync(100)
    await done
    expect(setFriend).toHaveBeenCalledWith('kai', true)
    expect(requested.value.has('kai')).toBe(false)
    expect(announcement.value).toBe('Kai accepted your friend request')
  })

  it('is dropped by a sign-out: nobody is made a friend, nothing waits, and the promise still finishes', async () => {
    const setFriend = vi.fn().mockResolvedValue()
    const onAccepted = vi.fn()
    const { requested, announcement } = useFriendRequests()
    const done = sendFriendRequest({ id: 'kai', name: 'Kai' }, setFriend, { after: 100, onAccepted })
    cancelFriendRequests()
    await done
    await vi.advanceTimersByTimeAsync(500)
    expect(setFriend).not.toHaveBeenCalled()
    expect(onAccepted).not.toHaveBeenCalled()
    expect(requested.value.size).toBe(0)
    expect(announcement.value).toBe('')
  })

  it('can be sent again after a sign-out', async () => {
    const setFriend = vi.fn().mockResolvedValue()
    sendFriendRequest({ id: 'kai', name: 'Kai' }, setFriend, { after: 100 })
    cancelFriendRequests()
    const again = sendFriendRequest({ id: 'kai', name: 'Kai' }, setFriend, { after: 100 })
    await vi.advanceTimersByTimeAsync(100)
    await again
    expect(setFriend).toHaveBeenCalledTimes(1)
  })
})

describe('signing out', () => {
  it('cancels the requests waiting, in the auth store', () => {
    const source = readFileSync(new URL('../../stores/auth.js', import.meta.url), 'utf8')
    // Plain sign-out, the session ending by itself, and starting over each drop them.
    expect(source.match(/cancelFriendRequests\(\)/g)).toHaveLength(3)
  })
})
