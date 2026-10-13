// The frontend's call for "does this email have an account?": it posts to the backend's own route (never to the database),
// waits at most 5 seconds, and treats anything but a plain true or false as an error.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, emailRegistered } from '../plannerApi.js'

afterEach(() => vi.restoreAllMocks())

describe('emailRegistered', () => {
  it('posts the trimmed address to /api/accounts/email-check with a 5 second wait, and returns the answer', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { registered: true } }).mockResolvedValueOnce({ data: { registered: false } })
    expect(await emailRegistered('  sam@example.com ')).toBe(true)
    expect(await emailRegistered('new@example.com')).toBe(false)
    const [url, body, config] = post.mock.calls[0]
    expect(url).toBe('/api/accounts/email-check')
    expect(body).toEqual({ email: 'sam@example.com' })
    expect(config).toEqual({ timeout: 5000 })
  })

  it.each([
    ['nothing', { registered: undefined }],
    ['a string', { registered: 'true' }],
    ['a number', { registered: 1 }],
    ['no body', undefined],
  ])('is an error, never a guess, when the answer is %s', async (_name, data) => {
    vi.spyOn(api, 'post').mockResolvedValue({ data })
    await expect(emailRegistered('sam@example.com')).rejects.toThrow()
  })

  it('lets the failure through (429, 503, no connection) for the sign-up screen to carry on past', async () => {
    vi.spyOn(api, 'post').mockRejectedValue(new Error('Too many requests. Wait a few seconds and try again.'))
    await expect(emailRegistered('sam@example.com')).rejects.toThrow('Too many requests')
  })

  it('never asks Supabase: the request goes through the planner client only', async () => {
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: { registered: false } })
    await emailRegistered('sam@example.com')
    expect(post).toHaveBeenCalledTimes(1)
    expect(String(post.mock.calls[0][0])).not.toMatch(/supabase|rpc/i)
  })
})
