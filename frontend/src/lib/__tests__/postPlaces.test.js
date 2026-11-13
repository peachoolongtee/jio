// "Places from a post": the link check before sending, the card's lines from the link reader's answer, and the two client calls.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { api, postReaderCapabilities, readPost } from '../plannerApi.js'
import { mapsUrl, matchQuestion, placeAddress, placeNotes, postLinkProblem, ratingLine, readErrorText, sourceNote, unreadableText } from '../postPlaces.js'

afterEach(() => vi.restoreAllMocks())

describe('postLinkProblem', () => {
  it.each([
    'https://www.youtube.com/watch?v=abc',
    'https://youtu.be/abc',
    'https://vt.tiktok.com/ZS123/',
    '  https://www.tiktok.com/@a/video/1  ',
  ])('lets %s through', (link) => {
    expect(postLinkProblem(link)).toBe('')
  })

  it('asks for a link when there is none', () => {
    expect(postLinkProblem('   ')).toBe('Paste a link to a post.')
  })

  it.each(['tiktok.com/@a/video/1', 'not a link', 'http://www.tiktok.com/@a/video/1'])('asks for the whole https link for %s', (link) => {
    expect(postLinkProblem(link)).toBe('Paste the whole link, starting with https://')
  })

  it.each(['https://example.com/x', 'https://faketiktok.com/a', 'https://tiktok.com.evil.example/a'])('names the supported sites for %s', (link) => {
    expect(postLinkProblem(link)).toBe('Only YouTube and TikTok links can be read.')
  })

  // The deployed server cannot read these without the development tools, so the screen turns them away before sending.
  it.each(['https://www.instagram.com/p/abc/', 'https://xhslink.com/o/abc', 'https://www.xiaohongshu.com/explore/abc'])('turns away %s, which the live app cannot read', (link) => {
    expect(postLinkProblem(link)).toBe('Only YouTube and TikTok links can be read.')
  })

  it('refuses a link longer than the server reads', () => {
    expect(postLinkProblem(`https://youtu.be/${'a'.repeat(600)}`)).toBe('That link is too long to be a post.')
  })
})

describe('ratingLine', () => {
  it('shows stars and the count, dimmed under 10 ratings', () => {
    expect(ratingLine({ rating: 4.5, ratingCount: 66 })).toEqual({ text: '4.5 ★ (66)', label: 'Rated 4.5 by 66 people on Google', dim: false })
    expect(ratingLine({ rating: 5, ratingCount: 3 }).dim).toBe(true)
    expect(ratingLine({ rating: 5, ratingCount: 1 }).label).toBe('Rated 5.0 by 1 person on Google')
  })

  it('says New for a matched place with no rating, and nothing at all without a match', () => {
    expect(ratingLine({ rating: null, ratingCount: null }).text).toBe('New')
    expect(ratingLine(null)).toBeNull()
  })
})

describe('the card lines', () => {
  it('takes the address from Google, else from the post', () => {
    expect(placeAddress({ match: { address: '9 Example Road' }, locationHint: 'Orchard' })).toBe('9 Example Road')
    expect(placeAddress({ match: null, locationHint: 'Orchard' })).toBe('Orchard')
    expect(placeAddress({ match: null })).toBe('')
  })

  it('links a match by its place id and an unmatched place by a search for its name in Singapore', () => {
    expect(mapsUrl({ name: 'S', match: { placeId: 'abc', name: 'Starlight', address: '9 Example Road' } })).toBe(
      'https://www.google.com/maps/search/?api=1&query=Starlight%209%20Example%20Road&query_place_id=abc',
    )
    expect(mapsUrl({ name: 'Kopi Spot', locationHint: 'Tampines', match: null })).toBe(
      'https://www.google.com/maps/search/?api=1&query=Kopi%20Spot%20Tampines%20Singapore',
    )
  })

  it('lists a closed place, an old post and a viewer note once each', () => {
    const place = {
      availability: { usableNow: false, line: 'Ended on 1 Oct.' },
      freshness: { warning: 'From a post over a year ago: its details may have changed.' },
      commentNote: 'it moved',
    }
    expect(placeNotes(place)).toEqual(['Ended on 1 Oct.', 'From a post over a year ago: its details may have changed.', 'A viewer says: it moved'])
    expect(placeNotes({ availability: { usableNow: true, line: '' } })).toEqual([])
    expect(placeNotes({ availability: { usableNow: false, line: '' } })).toEqual(['May not be open now.'])
  })

  it('leaves out a place warning the whole post already shows, and never says "a viewer says" twice', () => {
    const old = 'From a post over a year ago: its details may have changed.'
    expect(placeNotes({ freshness: { warning: old } }, old)).toEqual([])
    expect(placeNotes({ commentNote: 'A viewer says the queue is long.' })).toEqual(['A viewer says the queue is long.'])
  })

  it('asks the person to check a match with another name or several branches', () => {
    expect(matchQuestion({ nameMatches: true })).toBe('')
    expect(matchQuestion({ nameMatches: false })).toBe('Google lists it under another name. Is this it?')
    expect(matchQuestion({ ambiguous: true, nameMatches: true })).toBe('One of several branches. Check it is the right one.')
    expect(matchQuestion(null)).toBe('')
  })

  it('says when only the caption was read', () => {
    expect(sourceNote({ how: 'caption' })).toMatch(/caption only/)
    expect(sourceNote({ how: 'youtube' })).toBe('')
  })

  it('words each unreadable reason and each failure', () => {
    expect(unreadableText({ reason: 'busy' })).toMatch(/other posts/)
    expect(unreadableText({ reason: 'something_new' })).toBe('This post could not be read.')
    expect(readErrorText(Object.assign(new Error('x'), { code: 'rate_limited' }))).toBe('You can read 3 posts a minute. Try again in a minute.')
    expect(readErrorText(Object.assign(new Error('x'), { code: 'link_reader_unavailable' }))).toBe('Reading posts is not available right now.')
    expect(readErrorText(new Error('Cannot reach the Jio planner right now.'))).toBe('Cannot reach the Jio planner right now.')
  })
})

describe('postReaderCapabilities', () => {
  it('returns what the server can read', async () => {
    vi.spyOn(api, 'get').mockResolvedValue({ data: { enabled: true, tiktok: { caption: true } } })
    expect(await postReaderCapabilities()).toEqual({ enabled: true, tiktok: { caption: true } })
  })

  it('takes a 404 (the reader is off) as an answer, not a failure', async () => {
    vi.spyOn(api, 'get').mockRejectedValue(Object.assign(new Error('x'), { code: 'not_found', status: 404 }))
    expect(await postReaderCapabilities()).toEqual({ enabled: false })
  })

  it('lets any other failure through, and refuses an answer that is not one', async () => {
    vi.spyOn(api, 'get').mockRejectedValueOnce(new Error('Cannot reach')).mockResolvedValueOnce({ data: {} })
    await expect(postReaderCapabilities()).rejects.toThrow('Cannot reach')
    await expect(postReaderCapabilities()).rejects.toThrow()
  })
})

describe('readPost', () => {
  it('posts the link to /api/links/read with a long wait and returns the answer', async () => {
    const answer = { status: 'ok', source: { platform: 'tiktok' }, places: [], notes: [] }
    const post = vi.spyOn(api, 'post').mockResolvedValue({ data: answer })
    expect(await readPost('https://vt.tiktok.com/ZS1/')).toBe(answer)
    const [url, body, config] = post.mock.calls[0]
    expect(url).toBe('/api/links/read')
    expect(body).toEqual({ url: 'https://vt.tiktok.com/ZS1/' })
    expect(config.timeout).toBeGreaterThanOrEqual(60000)
  })

  it('returns an unreadable answer for the screen to word', async () => {
    vi.spyOn(api, 'post').mockResolvedValue({ data: { status: 'unreadable', reason: 'busy', retryable: true, notes: [] } })
    expect((await readPost('https://youtu.be/a')).reason).toBe('busy')
  })

  it('refuses an answer of another shape', async () => {
    vi.spyOn(api, 'post').mockResolvedValueOnce({ data: { status: 'ok' } }).mockResolvedValueOnce({ data: { status: 'maybe' } })
    await expect(readPost('https://youtu.be/a')).rejects.toThrow()
    await expect(readPost('https://youtu.be/a')).rejects.toThrow()
  })

  it('says a cancelled read is an AbortError', async () => {
    const controller = new AbortController()
    vi.spyOn(api, 'post').mockImplementation(() => {
      controller.abort()
      return Promise.reject(new Error('canceled'))
    })
    await expect(readPost('https://youtu.be/a', { signal: controller.signal })).rejects.toMatchObject({ name: 'AbortError' })
  })
})
