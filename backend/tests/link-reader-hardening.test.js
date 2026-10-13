// The link reader after its security review: a switch of its own, a share of the Google budget, limits per caller, nothing
// gathered before a budget is checked, links that cannot be used answered 400, no media kept, the browser tool's guards, and
// what is sent to the AI. Nothing touches the network or runs a program: every service, tool and browser is a fake.
import { once } from 'node:events'
import { readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { createApp } from '../src/app.js'
import { ExternalApiError } from '../src/services/errors.js'
import { createGooglePlaces, GoogleUnavailableError, PLACE_CACHE_MS } from '../src/services/google-places.js'
import { createHttp } from '../src/services/http.js'
import { createBrowserReader, fetchChecked, resolvesPublic } from '../src/services/link-browser.js'
import { createLinkReader, LinkReaderError, readLinkReaderSettings, readPlaces, setUpLinkReader, MAX_GOOGLE_CALLS } from '../src/services/link-reader.js'
import { allowedBrowserUrl, isPublicAddress, LinkToolError, onSupportedSite, parseLink, toolEnvironment, withoutHandles, withoutLinks } from '../src/services/link-source.js'
import { createYtDlp } from '../src/services/link-tools.js'
import { createCache } from '../src/services/cache.js'

const NOW = Date.parse('2026-10-12T04:00:00Z') // noon in Singapore
const FRONTEND = 'http://localhost:5173'

// ---------------------------------------------------------------- fakes

const place = (name, extra = {}) => ({ name, name_english: name, location_hint: '1 Example Rd', has_address: true, tip: 'Try it.', status: 'open', opens_on: '', closes_on: '', availability_note: '', comment_note: '', source: 'caption', confidence: 0.8, ...extra })
const geminiAnswer = (places) => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ places }) }] } }] })
const failure = (status, service = 'gemini') => new ExternalApiError(`${service} answered ${status}`, { service, status, url: 'u' })
const video = (n) => `https://www.youtube.com/watch?v=aaaaaaaaa${String(n).padStart(2, '0')}` // an eleven-character id
const TT = (n) => `https://www.tiktok.com/@a/video/76907569625516${String(n).padStart(5, '0')}`

// A fake HTTP helper. `gemini(body, count)` answers (or throws) for each Gemini call; YouTube answers with one comment that has an
// author and a handle in it.
function world({ gemini = () => geminiAnswer([place('Soft Order')]), comment = '@someone_sg the queue is long, said @Another.User' } = {}) {
  let geminiCalls = 0
  const http = {
    postJson: vi.fn(async (url, body) => {
      if (!url.includes('generativelanguage.googleapis.com')) throw new Error(`unexpected POST ${url}`)
      geminiCalls += 1
      return gemini(body, geminiCalls, url)
    }),
    getJson: vi.fn(async (url) => {
      if (url.includes('/youtube/v3/videos')) return { items: [{ snippet: { title: 'Cafes', description: 'Soft Order on Henderson Rd.', publishedAt: '2026-09-20T08:30:00Z' } }] }
      if (url.includes('/youtube/v3/commentThreads')) return { items: [{ snippet: { topLevelComment: { snippet: { textDisplay: comment, authorDisplayName: 'Jane Tan', authorChannelUrl: 'https://www.youtube.com/channel/UCjanetan' } } } }] }
      if (url.includes('tiktok.com/oembed')) return { title: 'Best laksa' }
      throw new Error(`unexpected GET ${url}`)
    }),
  }
  return { http, geminiCalls: () => geminiCalls, questions: () => http.postJson.mock.calls.map((c) => c[1].contents[0].parts.at(-1).text) }
}

const clock = { t: NOW }
const reader = (w, extra = {}) => createLinkReader({ http: w.http, geminiKey: 'test-gemini-key', now: () => clock.t, warn: () => {}, ...extra })

// A fake Google (what createLinkReader needs): every search answers with nothing unless told.
const fakeGoogle = (answer = () => []) => ({ enabled: true, searchText: vi.fn(async (q) => answer(q)), details: vi.fn(async (id) => ({ id, displayName: { text: 'Soft Order' }, formattedAddress: '1 Example Rd', rating: 4.5, userRatingCount: 66, businessStatus: 'OPERATIONAL' })) })

afterEach(() => {
  clock.t = NOW
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------- S5: a switch of its own

describe('the link reader is off unless LINK_READER=1', () => {
  const unknown = async (base) => (await fetch(`${base}/api/nothing/here`)).json()
  const serve = async (options) => {
    const server = createApp({ frontendOrigin: FRONTEND, ...options }).listen(0)
    await once(server, 'listening')
    return { server, base: `http://127.0.0.1:${server.address().port}` }
  }

  it('answers 404 for all three routes, exactly as for an unknown address', async () => {
    const { server, base } = await serve({ stub: true })
    try {
      const nothing = await unknown(base)
      expect(nothing).toEqual({ error: 'not_found', message: 'There is no GET /api/nothing/here here.' })
      for (const [method, path] of [['GET', '/api/links/capabilities'], ['POST', '/api/links/read'], ['POST', '/api/links/refresh']]) {
        const res = await fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json' }, body: method === 'POST' ? '{"url":"https://www.youtube.com/watch?v=dQw4w9WgXcQ"}' : undefined })
        expect(res.status).toBe(404)
        expect(await res.json()).toEqual({ error: 'not_found', message: `There is no ${method} ${path} here.` })
      }
    } finally {
      server.close()
    }
  })

  it('builds nothing, schedules nothing and calls nothing at start-up', () => {
    vi.useFakeTimers()
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
    const http = { getJson: vi.fn(), postJson: vi.fn() }
    const places = { enabled: true, searchText: vi.fn(), details: vi.fn(), lane: vi.fn() }
    const makeYtDlp = vi.fn()
    const makeBrowser = vi.fn()
    const timersBefore = vi.getTimerCount()
    // Everything else the link reader reads is set, but LINK_READER is not.
    const env = { GEMINI_API_KEY: 'k', YOUTUBE_API_KEY: 'k', LINK_READER_YTDLP: '1', LINK_READER_BROWSER: '1', LINK_READER_COMMENTS: '1', NODE_ENV: 'development' }
    const made = setUpLinkReader({ env, http, places, makeYtDlp, makeBrowser })
    createApp({ frontendOrigin: FRONTEND, stub: true, http, places, linkReader: made.reader })
    expect(made.reader).toBeNull()
    expect(made.warnings).toEqual([])
    expect(makeYtDlp).not.toHaveBeenCalled()
    expect(makeBrowser).not.toHaveBeenCalled()
    expect(places.lane).not.toHaveBeenCalled()
    expect(http.getJson).not.toHaveBeenCalled()
    expect(http.postJson).not.toHaveBeenCalled()
    expect(fetchSpy).not.toHaveBeenCalled()
    expect(vi.getTimerCount()).toBe(timersBefore)
  })

  it('with LINK_READER=1 but no Gemini key, read and refresh answer 503 and capabilities say it is off', async () => {
    const made = setUpLinkReader({ env: { LINK_READER: '1' }, http: { getJson: vi.fn(), postJson: vi.fn() }, places: null })
    expect(made.reader.enabled).toBe(false)
    const { server, base } = await serve({ stub: true, linkReader: made.reader })
    try {
      for (const path of ['/api/links/read', '/api/links/refresh']) {
        const res = await fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', placeIds: ['abc'] }) })
        expect(res.status).toBe(503)
        const body = await res.json()
        expect(body.error).toBe('link_reader_unavailable')
        expect(body.message).toContain('GEMINI_API_KEY')
      }
      expect(await (await fetch(`${base}/api/links/capabilities`)).json()).toMatchObject({ enabled: false })
    } finally {
      server.close()
    }
  })

  it('reads the new settings, and turns the development tools on only with NODE_ENV=development', () => {
    expect(readLinkReaderSettings({})).toMatchObject({ enabled: false, sendComments: false, perCaller: 3, callsPerMinute: 6, devTools: false })
    expect(readLinkReaderSettings({ LINK_READER: '1', LINK_READER_COMMENTS: '1', LINK_READER_PER_CALLER_PER_MINUTE: '5', NODE_ENV: 'development' })).toMatchObject({ enabled: true, sendComments: true, perCaller: 5, devTools: true })
    expect(readLinkReaderSettings({ LINK_READER: 'yes' }).enabled).toBe(false)
    expect(readLinkReaderSettings({ LINK_READER_PER_CALLER_PER_MINUTE: '0' }).warnings).toHaveLength(1)

    const http = { getJson: vi.fn(), postJson: vi.fn() }
    for (const [nodeEnv, expected] of [['production', 0], ['test', 0], [undefined, 0], ['development', 1]]) {
      const makeYtDlp = vi.fn(() => ({ download: vi.fn() }))
      const makeBrowser = vi.fn(() => ({ read: vi.fn() }))
      const env = { LINK_READER: '1', GEMINI_API_KEY: 'k', LINK_READER_YTDLP: '1', LINK_READER_BROWSER: '1', ...(nodeEnv && { NODE_ENV: nodeEnv }) }
      const made = setUpLinkReader({ env, http, places: null, makeYtDlp, makeBrowser })
      expect(makeYtDlp).toHaveBeenCalledTimes(expected)
      expect(makeBrowser).toHaveBeenCalledTimes(expected)
      expect(made.warnings.some((w) => w.includes('NODE_ENV=development'))).toBe(expected === 0)
    }
    // Never in stub mode, whatever NODE_ENV says.
    const makeYtDlp = vi.fn()
    setUpLinkReader({ env: { LINK_READER: '1', LINK_READER_YTDLP: '1', NODE_ENV: 'development' }, http, places: null, stub: true, makeYtDlp })
    expect(makeYtDlp).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------- S1: the Google budget

describe('the link reader cannot take the Google budget from the planner', () => {
  const textAnswer = { places: [] }
  const googleWorld = (callsPerMinute) => {
    const http = { postJson: vi.fn(async () => textAnswer), getJson: vi.fn(async (url) => ({ id: url.split('/').pop(), displayName: { text: 'X' } })) }
    const places = createGooglePlaces({ http, apiKey: 'test-google-key', callsPerMinute, now: () => clock.t, warn: () => {} })
    return { http, places }
  }
  const SG = { lat: 1.3, lng: 103.8 }

  it('holds the lane to a third of GOOGLE_CALLS_PER_MINUTE and leaves the rest to the planner', async () => {
    const { http, places } = googleWorld(30)
    const lane = places.lane()
    expect(lane.allowance.max).toBe(10)
    for (let i = 0; i < 10; i++) await lane.searchText(`place number ${i}`, SG)
    await expect(lane.searchText('one place too many', SG)).rejects.toBeInstanceOf(GoogleUnavailableError)
    await expect(lane.details('ChIJabc')).rejects.toMatchObject({ reason: 'budget_empty' })
    expect(http.postJson).toHaveBeenCalledTimes(10) // the refused calls made no request
    // The planner still has the other 20 calls, in the same minute.
    for (let i = 0; i < 20; i++) await places.searchText(`planner search ${i}`, SG)
    expect(http.postJson).toHaveBeenCalledTimes(30)
    // And after a minute the lane has its share again.
    clock.t += 61_000
    await expect(lane.searchText('after a minute', SG)).resolves.toEqual([])
  })

  it('charges the lane for paid calls only, not for an answer from a cache', async () => {
    const { http, places } = googleWorld(30)
    const lane = places.lane()
    for (let i = 0; i < 25; i++) await lane.searchText('the same words', SG)
    expect(http.postJson).toHaveBeenCalledTimes(1)
    expect(lane.allowance.used()).toBe(1)
  })

  it('refreshes at most three saved places, each once, and keeps each answer for as long as the place cache does', async () => {
    const google = fakeGoogle()
    const w = world()
    const rd = reader(w, { places: google })
    const first = await rd.refresh(['p1', 'p2', 'p3', 'p4', 'p5'])
    expect(first.places.map((p) => p.placeId)).toEqual(['p1', 'p2', 'p3'])
    expect(google.details).toHaveBeenCalledTimes(3)
    await rd.refresh(['p1', 'p2', 'p3'])
    expect(google.details).toHaveBeenCalledTimes(3) // all three from the reader's cache
    await rd.refresh(['p1', 'p1', 'p1'])
    expect(google.details).toHaveBeenCalledTimes(3)
    clock.t += PLACE_CACHE_MS + 1
    await rd.refresh(['p1'])
    expect(google.details).toHaveBeenCalledTimes(4)
  })

  it('does not keep or repeat a refresh while Google is down', async () => {
    const google = fakeGoogle()
    google.details.mockImplementation(async () => { throw failure(503, 'google') })
    const rd = reader(world(), { places: google })
    const out = await rd.refresh(['p1', 'p2', 'p3'])
    expect(out.google).toBe('unavailable')
    expect(out.places.map((p) => p.found)).toEqual([null, null, null])
    expect(google.details).toHaveBeenCalledTimes(1) // the ids after the first failure are not asked
    await rd.refresh(['p1'])
    expect(google.details).toHaveBeenCalledTimes(2) // a failure is not cached
  })

  it('does the Google matching once for a cached reading, and not again for a read that is a cache hit', async () => {
    const google = fakeGoogle()
    const w = world()
    const rd = reader(w, { places: google })
    const a = await rd.read(video(1))
    const calls = google.searchText.mock.calls.length
    expect(calls).toBeGreaterThan(0)
    const b = await rd.read(video(1))
    const c = await rd.read('https://youtu.be/aaaaaaaaa01?si=x', { centre: { lat: 1.31, lng: 103.9 } }) // another centre, same post
    expect(b.fromCache).toBe(true)
    expect(google.searchText.mock.calls.length).toBe(calls)
    expect(w.geminiCalls()).toBe(1)
    expect(c.places).toEqual(a.places.map((p) => ({ ...p })))
    // After as long as Google's own answers are kept, it is matched afresh (Google content is not held longer than that).
    clock.t += PLACE_CACHE_MS + 1
    await rd.read(video(1))
    expect(google.searchText.mock.calls.length).toBe(calls * 2)
  })

  it('shares one matching between two reads at once', async () => {
    const google = fakeGoogle()
    const rd = reader(world(), { places: google })
    await Promise.all([rd.read(video(2)), rd.read(video(2))])
    expect(google.searchText).toHaveBeenCalledTimes(1)
  })

  it('does not keep a matching that Google could not finish', async () => {
    const google = fakeGoogle()
    google.searchText.mockImplementationOnce(async () => { throw failure(503, 'google') })
    const rd = reader(world(), { places: google })
    expect((await rd.read(video(3))).google.source).toBe('unavailable')
    expect((await rd.read(video(3))).google.source).toBe('google') // tried again, without asking the AI again
  })

  it('makes at most 15 Google searches for one read, and gives every place its first before any its second', async () => {
    const many = Array.from({ length: 20 }, (_, i) => place(`Place ${i}`, { has_address: false, location_hint: '' }))
    const google = fakeGoogle()
    await reader(world({ gemini: () => geminiAnswer(many) }), { places: google }).read(video(4))
    expect(MAX_GOOGLE_CALLS).toBe(15)
    const asked = google.searchText.mock.calls.map((c) => c[0])
    expect(asked).toHaveLength(15)
    expect(new Set(asked.slice(0, 15)).size).toBe(15) // fifteen different places before any retry
    // A post with fewer places uses what is left of the 15 on retries.
    const few = fakeGoogle()
    await reader(world({ gemini: () => geminiAnswer(many.slice(0, 3)) }), { places: few }).read(video(5))
    expect(few.searchText.mock.calls.length).toBe(9) // the name and the hint, then a type word or two: three searches each
  })

  it('uses the lane when the places object has one, and never the whole budget directly', async () => {
    const laned = fakeGoogle()
    const places = { enabled: true, searchText: vi.fn(), details: vi.fn(), lane: vi.fn(() => laned) }
    await reader(world(), { places }).read(video(6))
    expect(places.lane).toHaveBeenCalledTimes(1)
    expect(laned.searchText).toHaveBeenCalled()
    expect(places.searchText).not.toHaveBeenCalled()
  })

  it('cannot take more than 20 of 60 Google calls a minute, however many posts are read', async () => {
    const { http, places } = googleWorld(60)
    // Each post names different places, so no search can be answered from a cache.
    const w = world({ gemini: (body, n) => geminiAnswer(Array.from({ length: 15 }, (_, i) => place(`Cafe ${n} ${i}`, { has_address: false }))) })
    const rd = reader(w, { places, callsPerMinute: 60 })
    const results = []
    for (let n = 10; n < 16; n++) results.push(await rd.read(video(n)))
    expect(http.postJson).toHaveBeenCalledTimes(20)
    expect(results.at(-1).google.source).toBe('unavailable')
  })
})

// ---------------------------------------------------------------- S2: failures that are the post's, not the service's

describe('only the AI service failing pauses the reader', () => {
  const junk = (status) => world({ gemini: () => { throw failure(status) } })

  it('answers a post the AI refuses, and counts it for nothing, however many there are', async () => {
    const w = world({ gemini: (body, n) => (n <= 8 ? (() => { throw failure(400) })() : geminiAnswer([place('Soft Order')])) })
    const rd = reader(w, { callsPerMinute: 60 })
    for (let n = 20; n < 28; n++) {
      const r = await rd.read(video(n))
      expect(r).toMatchObject({ status: 'unreadable', reason: 'post_unreadable', retryable: false })
      expect(r.notes.join(' ')).toContain('private, removed')
    }
    expect(w.geminiCalls()).toBe(8) // a 400 is not tried on the other models
    expect((await rd.read(video(29))).status).toBe('ok') // the reader was never paused
  })

  it('does not pause on answers that are not a list of places', async () => {
    const answers = [
      () => ({ candidates: [] }),
      () => ({ candidates: [{ content: { parts: [{ text: 'I cannot help with that.' }] } }] }),
      () => ({ promptFeedback: { blockReason: 'SAFETY' } }),
    ]
    const w = world({ gemini: (body, n) => (n <= 9 ? answers[(n - 1) % 3]() : geminiAnswer([place('Soft Order')])) })
    const rd = reader(w, { callsPerMinute: 60 })
    for (let n = 30; n < 33; n++) expect(await rd.read(video(n))).toMatchObject({ reason: 'post_unreadable' })
    expect((await rd.read(video(33))).status).toBe('ok')
  })

  it('does not pause on a rejected key (401, 403) or an unknown model (404), and tells the operator', async () => {
    const warn = vi.fn()
    for (const status of [401, 403, 404]) {
      const w = junk(status)
      const rd = reader(w, { callsPerMinute: 60, warn })
      for (let n = 40; n < 46; n++) expect(await rd.read(video(n))).toMatchObject({ reason: 'ai_unavailable', retryable: true })
      expect(w.geminiCalls()).toBe(18) // every read still asked: it was never paused
    }
    expect(warn).toHaveBeenCalled()
  })

  it('still pauses after three reads in a row fail because the service is unwell (5xx, 429, no answer)', async () => {
    for (const status of [500, 503, 429, null]) {
      const w = junk(status)
      const rd = reader(w, { callsPerMinute: 60 })
      for (let n = 50; n < 53; n++) expect(await rd.read(video(n))).toMatchObject({ reason: 'ai_unavailable' })
      const before = w.geminiCalls()
      expect(await rd.read(video(53))).toMatchObject({ reason: 'ai_unavailable' })
      expect(w.geminiCalls()).toBe(before) // paused: nothing asked
      clock.t += 61_000
      expect(w.geminiCalls()).toBe(before)
    }
  })

  it('cannot be paused by junk links mixed in with one failing read', async () => {
    // Two reads fail for the service's sake, then many refused posts, then one more failure: still only three in a row is
    // needed, and a refused post neither adds to the count nor clears it.
    let mode = 'down'
    const w = world({ gemini: () => { if (mode === 'down') throw failure(503); if (mode === 'junk') throw failure(400); return geminiAnswer([place('Soft Order')]) } })
    const rd = reader(w, { callsPerMinute: 60 })
    await rd.read(video(60)); await rd.read(video(61))
    mode = 'junk'
    for (let n = 62; n < 70; n++) await rd.read(video(n))
    mode = 'ok'
    expect((await rd.read(video(70))).status).toBe('ok') // two failures were counted, not three
  })

  it('takes one model call for each token, so a read that tries three models spends three', async () => {
    const w = world({ gemini: (body, n) => { if (n < 3) throw failure(503); return geminiAnswer([place('Soft Order')]) } })
    const rd = reader(w, { callsPerMinute: 3 })
    expect((await rd.read(video(80))).status).toBe('ok') // models one and two failed, the third answered: three tokens
    expect(w.geminiCalls()).toBe(3)
    expect(await rd.read(video(81))).toMatchObject({ reason: 'ai_unavailable' }) // none left, and nothing was asked
    expect(w.geminiCalls()).toBe(3)
    // A read that is answered by the first model takes one.
    const w2 = world()
    const rd2 = reader(w2, { callsPerMinute: 3 })
    for (let n = 82; n < 85; n++) expect((await rd2.read(video(n))).status).toBe('ok')
    expect(await rd2.read(video(85))).toMatchObject({ reason: 'ai_unavailable' })
  })
})

describe('one caller is held to a few reads and refreshes a minute', () => {
  const fakeReader = () => ({ enabled: true, capabilities: () => ({ enabled: true }), read: vi.fn(async () => ({ status: 'ok' })), refresh: vi.fn(async () => ({ google: 'google', places: [] })) })
  const serve = async (reader, options) => {
    const server = createApp({ frontendOrigin: FRONTEND, stub: true, linkReader: reader, ...options }).listen(0)
    await once(server, 'listening')
    const base = `http://127.0.0.1:${server.address().port}/api`
    const post = (path, body) => fetch(`${base}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    return { server, post }
  }

  it('answers 429 from the fourth read, without reading, and counts refreshes separately', async () => {
    const rd = fakeReader()
    const { server, post } = await serve(rd, { linkRateLimit: { windowMs: 60_000, read: 3, refresh: 3 } })
    try {
      const statuses = []
      for (let i = 0; i < 5; i++) statuses.push((await post('/links/read', { url: video(i) })).status)
      expect(statuses).toEqual([200, 200, 200, 429, 429])
      expect(rd.read).toHaveBeenCalledTimes(3) // the refused ones gathered nothing
      const refused = await post('/links/read', { url: video(9) })
      expect(await refused.json()).toMatchObject({ error: 'rate_limited' })
      expect(Number(refused.headers.get('retry-after'))).toBeGreaterThan(0)
      const refreshes = []
      for (let i = 0; i < 4; i++) refreshes.push((await post('/links/refresh', { placeIds: ['p1'] })).status)
      expect(refreshes).toEqual([200, 200, 200, 429])
      expect(rd.refresh).toHaveBeenCalledTimes(3)
    } finally {
      server.close()
    }
  })

  it('counts a request with a bad body too, so junk cannot be sent for free', async () => {
    const rd = fakeReader()
    const { server, post } = await serve(rd, { linkRateLimit: { windowMs: 60_000, read: 3, refresh: 3 } })
    try {
      const statuses = []
      for (let i = 0; i < 4; i++) statuses.push((await post('/links/read', { nonsense: true })).status)
      expect(statuses).toEqual([400, 400, 400, 429])
    } finally {
      server.close()
    }
  })

  it('has no limit unless one is given (as the planner routes)', async () => {
    const rd = fakeReader()
    const { server, post } = await serve(rd)
    try {
      for (let i = 0; i < 6; i++) expect((await post('/links/read', { url: video(i) })).status).toBe(200)
    } finally {
      server.close()
    }
  })
})

// ---------------------------------------------------------------- S3: nothing is gathered before a budget is checked

describe('nothing is gathered for a read the reader would refuse', () => {
  it('gathers nothing when the AI budget is empty', async () => {
    const w = world()
    const tools = { download: vi.fn(async () => ({ mime: 'video/mp4', data: 'QUJD', bytes: 3, caption: 'Soft Order', postDate: '' })) }
    const rd = reader(w, { youtubeKey: 'k', tools, callsPerMinute: 1 })
    expect((await rd.read(video(1))).status).toBe('ok')
    const getsBefore = w.http.getJson.mock.calls.length
    expect(await rd.read(video(2))).toMatchObject({ reason: 'ai_unavailable' })
    expect(await rd.read(TT(1))).toMatchObject({ reason: 'ai_unavailable' })
    expect(w.http.getJson.mock.calls.length).toBe(getsBefore) // no YouTube call, no TikTok caption call
    expect(tools.download).not.toHaveBeenCalled()
  })

  it('gathers nothing while the reader is paused', async () => {
    const w = world({ gemini: () => { throw failure(503) } })
    const tools = { download: vi.fn(async () => { throw new LinkToolError('failed', 'x') }) }
    const rd = reader(w, { youtubeKey: 'k', tools, callsPerMinute: 60 })
    for (let n = 1; n <= 3; n++) await rd.read(video(n))
    const gets = w.http.getJson.mock.calls.length
    const downloads = tools.download.mock.calls.length
    await rd.read(video(4))
    await rd.read(TT(4))
    expect(w.http.getJson.mock.calls.length).toBe(gets)
    expect(tools.download.mock.calls.length).toBe(downloads)
  })

  it('gathers at most two posts at once, and answers "busy" to a third without waiting', async () => {
    const w = world()
    const release = []
    const tools = { download: vi.fn(() => new Promise((resolve) => release.push(() => resolve({ mime: 'video/mp4', data: 'QUJD', bytes: 3, caption: 'Soft Order', postDate: '' })))) }
    const rd = reader(w, { tools, callsPerMinute: 60 })
    const reads = [rd.read(TT(1)), rd.read(TT(2))]
    await vi.waitFor(() => expect(tools.download).toHaveBeenCalledTimes(2))
    const third = await rd.read(TT(3))
    expect(third).toMatchObject({ status: 'unreadable', reason: 'busy', retryable: true })
    expect(tools.download).toHaveBeenCalledTimes(2)
    release.forEach((r) => r())
    expect((await Promise.all(reads)).map((r) => r.status)).toEqual(['ok', 'ok'])
    // The slots are free again.
    const again = rd.read(TT(3))
    await vi.waitFor(() => expect(tools.download).toHaveBeenCalledTimes(3))
    release.forEach((r) => r())
    expect((await again).status).toBe('ok')
  })

  it('counts the YouTube Data API calls on their own, twice the AI budget a minute', async () => {
    // Both reads pass the check (one AI token is left) and gather together; the YouTube allowance of two calls is then spent
    // by the first, and the second reads the video without a description.
    const w = world()
    const rd = reader(w, { youtubeKey: 'k', sendComments: true, callsPerMinute: 1 })
    const [a, b] = await Promise.all([rd.read(video(1)), rd.read(video(2))])
    const youtubeCalls = w.http.getJson.mock.calls.filter((c) => c[0].includes('/youtube/v3/'))
    expect(youtubeCalls.length).toBeLessThanOrEqual(2)
    expect([a, b].some((r) => /YouTube would not give|could not be read/.test(r.notes.join(' ')))).toBe(true)
  })

  it('gives up on gathering at its deadline, stops the tool, and answers from the caption', async () => {
    const w = world()
    let seenSignal = null
    const tools = { download: vi.fn((url, { signal }) => new Promise((resolve, reject) => { seenSignal = signal; signal.addEventListener('abort', () => reject(new LinkToolError('timed_out', 'stopped'))) })) }
    const browser = { read: vi.fn() }
    const started = Date.now()
    const r = await reader(w, { tools, browser, gatherDeadlineMs: 40 }).read(TT(1))
    expect(Date.now() - started).toBeLessThan(2000)
    expect(seenSignal.aborted).toBe(true)
    expect(browser.read).not.toHaveBeenCalled() // one deadline for both tools together, not one each
    expect(r).toMatchObject({ status: 'ok', source: { how: 'caption' } })
    expect(r.notes.join(' ')).toContain('took too long')
  })

  it('stops a browser that does not answer at the same deadline', async () => {
    const w = world()
    let seenSignal = null
    const browser = { read: vi.fn((url, { signal }) => new Promise(() => { seenSignal = signal })) } // never settles, and does not even listen
    const r = await reader(w, { browser, gatherDeadlineMs: 40 }).read('https://www.tiktok.com/@a/photo/7547966708431080724')
    expect(seenSignal.aborted).toBe(true)
    expect(r.status).toBe('ok')
    expect(r.notes.join(' ')).toContain('took too long')
  })
})

// ---------------------------------------------------------------- S4: links that cannot be used

describe('a link on a supported site that names no post is a 400, never a 500', () => {
  const unusable = [
    'https://www.youtube.com/', 'https://youtu.be/', 'https://youtu.be', 'https://www.youtube.com/watch', 'https://www.youtube.com/watch?v=short',
    'https://www.youtube.com/@somechannel', 'https://www.youtube.com/channel/UC1234567890', 'https://www.youtube.com/playlist?list=PL1234567890', 'https://www.youtube.com/results?search_query=cafes',
    'https://www.tiktok.com/', 'https://www.tiktok.com/@someone', 'https://www.tiktok.com/discover', 'https://www.tiktok.com/@a/video/', 'https://www.tiktok.com/@a/video/1234567',
    'https://www.tiktok.com/@a/video/99999999999999999999999', 'https://www.tiktok.com/@a/video/12345678901234567890', 'https://www.tiktok.com/@a/photo/00000000000000000000000000',
    'https://vt.tiktok.com/', 'https://vt.tiktok.com/a/', 'https://www.tiktok.com/ZSabc123/',
    'https://www.instagram.com/', 'https://www.instagram.com/someone/', 'https://www.instagram.com/explore/', 'https://www.instagram.com/stories/someone/123456789/', 'https://www.instagram.com/reels/', 'https://www.instagram.com/reels/audio/123',
    'https://www.xiaohongshu.com/', 'https://www.xiaohongshu.com/user/profile/5b1234567890abcdef123456', 'https://www.xiaohongshu.com/explore', 'https://www.xiaohongshu.com/explore/zz', 'https://xhslink.com/', 'https://xhslink.com/a/b/c/d',
  ]

  it.each(unusable)('refuses %s', (link) => {
    expect(parseLink(link)).toEqual({ ok: false, reason: 'not_a_link' })
  })

  it('throws the reader\'s own error for each, and never reaches a tool, a budget or an API', async () => {
    const w = world()
    const tools = { download: vi.fn() }
    const browser = { read: vi.fn() }
    const rd = reader(w, { tools, browser, youtubeKey: 'k' })
    for (const link of unusable) {
      await expect(rd.read(link)).rejects.toMatchObject({ name: 'LinkReaderError', code: 'not_a_link' })
    }
    expect(w.http.getJson).not.toHaveBeenCalled()
    expect(w.http.postJson).not.toHaveBeenCalled()
    expect(tools.download).not.toHaveBeenCalled()
    expect(browser.read).not.toHaveBeenCalled()
  })

  it('answers 400 not_a_link over HTTP', async () => {
    const http = createHttp({ stub: true })
    const linkReader = createLinkReader({ http, places: createGooglePlaces({ http, stub: true }), geminiKey: 'stub-key', youtubeKey: 'stub-key' })
    const server = createApp({ frontendOrigin: FRONTEND, stub: true, http, linkReader }).listen(0)
    await once(server, 'listening')
    try {
      for (const url of ['https://www.youtube.com/', 'https://youtu.be/', 'https://www.tiktok.com/@a/video/99999999999999999999999']) {
        const res = await fetch(`http://127.0.0.1:${server.address().port}/api/links/read`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url }) })
        expect(res.status).toBe(400)
        expect(await res.json()).toMatchObject({ error: 'not_a_link' })
      }
    } finally {
      server.close()
    }
  })

  it('reads a TikTok id of the longest real length (19 digits) without an invalid date', async () => {
    for (const id of ['7690756962551680276', '9999999999999999999', '9223372036854775807']) {
      const r = await reader(world()).read(`https://www.tiktok.com/@a/video/${id}`)
      expect(r.status).toBe('ok')
    }
  })

  it('still knows the real forms of a link, short links included', () => {
    expect(parseLink('https://youtu.be/dQw4w9WgXcQ?si=abc')).toMatchObject({ ok: true, key: 'youtube:dQw4w9WgXcQ' })
    expect(parseLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ&list=PLxyz&index=4')).toMatchObject({ ok: true, key: 'youtube:dQw4w9WgXcQ', url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' })
    expect(parseLink('https://www.youtube.com/live/dQw4w9WgXcQ?feature=share')).toMatchObject({ ok: true, key: 'youtube:dQw4w9WgXcQ' })
    expect(parseLink('https://www.tiktok.com/@a/video/7690756962551680276')).toMatchObject({ ok: true, key: 'tiktok:7690756962551680276', short: false })
    expect(parseLink('https://vm.tiktok.com/ZSabc123/')).toMatchObject({ ok: true, key: null, short: true })
    expect(parseLink('https://www.tiktok.com/t/ZSabc123/')).toMatchObject({ ok: true, key: null, short: true })
    expect(parseLink('https://www.instagram.com/someone/reel/Abc_123-xYZ/')).toMatchObject({ ok: true, key: 'instagram:Abc_123-xYZ', kind: 'video' })
    expect(parseLink('https://www.xiaohongshu.com/user/profile/5b1234567890abcdef123456/675061a600000000070315b4?xsec_token=x')).toMatchObject({ ok: true, key: 'xiaohongshu:675061a600000000070315b4' })
    expect(parseLink('https://xhslink.com/o/5WK1iVLdN9k')).toMatchObject({ ok: true, key: null, short: true })
  })

  it('takes only https on the default port', () => {
    expect(parseLink('http://www.youtube.com/watch?v=dQw4w9WgXcQ')).toEqual({ ok: false, reason: 'not_a_link' })
    expect(parseLink('https://www.youtube.com:443/watch?v=dQw4w9WgXcQ').ok).toBe(true) // 443 is the default and is dropped
    expect(parseLink('https://www.youtube.com:8443/watch?v=dQw4w9WgXcQ').ok).toBe(false)
    expect(parseLink('https://www.youtube.com:80/watch?v=dQw4w9WgXcQ').ok).toBe(false)
    expect(onSupportedSite('http://www.tiktok.com/@a/video/12345678')).toBe(false)
    expect(onSupportedSite('https://www.tiktok.com:8443/@a/video/12345678')).toBe(false)
    expect(onSupportedSite('https://user:pw@www.tiktok.com/@a/video/12345678')).toBe(false)
    expect(onSupportedSite('https://www.tiktok.com/@a/video/12345678')).toBe(true)
  })

  it('refuses the backslash, IDN and @ forms that point somewhere else', () => {
    const post = '/@a/video/7690756962551680276'
    // The host is what comes after a "@" or a backslash that ends the host, so these all lead off the supported sites.
    expect(parseLink(`https://evil.example\\@www.tiktok.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://evil.example\\.www.tiktok.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://www.tiktok.com@evil.example${post}`)).toEqual({ ok: false, reason: 'not_a_link' })
    expect(parseLink(`https://www.tiktok.com:pw@evil.example${post}`)).toEqual({ ok: false, reason: 'not_a_link' })
    expect(parseLink(`https://evil.example/@www.tiktok.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://evil.example#@www.tiktok.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    // Look-alike hosts: a Cyrillic letter, an accented one, a suffix that only looks like the domain.
    expect(parseLink(`https://www.tіktok.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://www.tiktök.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://xn--tktok-gta.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://www.tiktok.com.evil.example${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://eviltiktok.com${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    expect(parseLink(`https://www.tiktok.com.${post}`)).toEqual({ ok: false, reason: 'unsupported_site' })
    // A backslash that only ends the host's name leaves the real host, and the link is rebuilt from the host and the path alone.
    const same = parseLink(`https://www.tiktok.com\\@evil.example${post}`)
    expect(same.ok && new URL(same.url).hostname).toBe('www.tiktok.com')
    // Full-width letters are the real domain once normalised, and the link is rebuilt with the real host.
    const wide = parseLink(`https://ｗｗｗ.ｔｉｋｔｏｋ.com${post}`)
    expect(wide.ok && new URL(wide.url).hostname).toBe('www.tiktok.com')
  })
})

// ---------------------------------------------------------------- M1: what is kept

describe('the cache holds no media', () => {
  it('keeps the reading, and neither the video, the slides nor the comments', async () => {
    const cache = createCache({ ttlMs: 60_000 })
    const w = world()
    const tools = { download: vi.fn(async () => ({ mime: 'video/mp4', data: 'VIDEO-BYTES-MARKER', bytes: 18, caption: 'Soft Order', postDate: '' })) }
    const rd = reader(w, { tools, cache })
    const first = await rd.read(TT(1))
    expect(first.source.how).toBe('video')
    const entry = cache.get(parseLink(TT(1)).key)
    expect(entry).toBeDefined()
    const text = JSON.stringify(entry)
    expect(text).not.toContain('VIDEO-BYTES-MARKER')
    expect(text).not.toContain('mediaParts')
    expect(text).not.toContain('inline_data')
    expect(Object.keys(entry.post).sort()).toEqual(['caption', 'commentsUsed', 'how', 'notes', 'postDate'])
    // A second read is answered from it, whole.
    const second = await rd.read(TT(1))
    expect(second).toMatchObject({ fromCache: true, source: { how: 'video' } })
    expect(second.places).toEqual(first.places)
  })

  it('keeps no slides or comments either', async () => {
    const cache = createCache({ ttlMs: 60_000 })
    const browser = { read: vi.fn(async () => ({ caption: 'cafes', images: [{ mime: 'image/jpeg', data: 'SLIDE-BYTES-MARKER' }], video: null, total: 1 })) }
    await reader(world(), { browser, cache }).read('https://www.tiktok.com/@a/photo/7547966708431080724')
    const yt = world()
    await reader(yt, { youtubeKey: 'k', sendComments: true, cache }).read(video(1))
    const everything = JSON.stringify([cache.get(parseLink('https://www.tiktok.com/@a/photo/7547966708431080724').key), cache.get(parseLink(video(1)).key)])
    expect(everything).not.toContain('SLIDE-BYTES-MARKER')
    expect(everything).not.toContain('the queue is long')
    expect(everything).toContain('"commentsUsed":1')
  })
})

// ---------------------------------------------------------------- M2, M3, M4: the browser tool

describe('the browser tool', () => {
  const PHOTO = 'https://www.tiktok.com/@a/photo/7547966708431080724'
  const VIDEO = 'https://www.tiktok.com/@a/video/7547966708431080724'
  const publicLookup = vi.fn(async () => [{ address: '93.184.216.34', family: 4 }])
  const routeFor = (url, navigation = false) => ({ request: () => ({ url: () => url, isNavigationRequest: () => navigation }), continue: vi.fn(), abort: vi.fn() })
  const response = (url, type = 'video/mp4', status = 200) => ({ status: () => status, url: () => url, headers: () => ({ 'content-type': type }) })
  const answer = (status, body = 'x', headers = {}) => ({ status: () => status, ok: () => status >= 200 && status < 300, headers: () => headers, body: async () => Buffer.from(body) })

  // A fake Playwright. `onGoto(calls)` can make the page do something while it loads.
  function playwright({ finalUrl = PHOTO, slides = ['https://p16-sign.tiktokcdn.com/obj/slide-one.jpeg'], onGoto = async () => {}, get } = {}) {
    const calls = { launch: null, context: null, route: null, onResponse: null, evaluated: 0, waited: 0, closed: 0 }
    const page = {
      on: vi.fn((event, handler) => { if (event === 'response') calls.onResponse = handler }),
      goto: vi.fn(async () => { await onGoto(calls) }),
      url: vi.fn(() => finalUrl),
      waitForTimeout: vi.fn(async () => { calls.waited += 1 }),
      getByText: () => ({ click: async () => {} }),
      keyboard: { press: async () => {} },
      reload: async () => {},
      evaluate: vi.fn(async (fn) => {
        calls.evaluated += 1
        const text = String(fn)
        if (text.includes('og:description')) return 'cafes to try'
        if (text.includes('aria-label')) return true
        if (text.includes('scrollBy')) return false
        if (text.includes('.sort(')) return slides.map((src) => ({ src }))
        return null
      }),
    }
    const ctx = {
      route: vi.fn(async (pattern, handler) => { calls.route = handler }),
      newPage: async () => page,
      request: { get: vi.fn(get ?? (async () => answer(200, 'picture'))) },
    }
    const browser = { newContext: vi.fn(async (options) => { calls.context = options; return ctx }), close: vi.fn(async () => { calls.closed += 1 }) }
    const chromium = { launch: vi.fn(async (options) => { calls.launch = options; return browser }) }
    return { load: () => ({ chromium }), page, ctx, browser, calls }
  }
  // sips and ffmpeg are fakes that write the picture they were asked for.
  const fakeExec = () => vi.fn(async (cmd, args) => { const out = args[args.indexOf('--out') + 1] ?? args.at(-1); writeFileSync(out, 'jpeg') })
  const tool = (pw, extra = {}) => createBrowserReader({ load: pw.load, chrome: '/fake/chrome', exec: fakeExec(), lookup: publicLookup, ...extra })

  it('starts Chrome with its sandbox on and without the server\'s secrets', async () => {
    process.env.JIO_TEST_SERVICE_SECRET = 'not-a-real-secret'
    try {
      const pw = playwright()
      const exec = fakeExec()
      await tool(pw, { exec }).read(PHOTO)
      expect(pw.calls.launch).toMatchObject({ headless: true, chromiumSandbox: true, executablePath: '/fake/chrome' })
      expect(pw.calls.launch.env.PATH).toBeTruthy()
      expect(pw.calls.launch.env.JIO_TEST_SERVICE_SECRET).toBeUndefined()
      expect(Object.keys(pw.calls.launch.env).sort()).toEqual(Object.keys(toolEnvironment(process.env)).sort())
      expect(pw.calls.context).toMatchObject({ serviceWorkers: 'block', acceptDownloads: false })
      expect(exec).toHaveBeenCalled()
      for (const call of exec.mock.calls) expect(call[2].env.JIO_TEST_SERVICE_SECRET).toBeUndefined() // ffmpeg and sips too
    } finally {
      delete process.env.JIO_TEST_SERVICE_SECRET
    }
  })

  it('aborts every request that is not https to a supported site or one of their media hosts', async () => {
    const pw = playwright()
    await tool(pw).read(PHOTO)
    const handler = pw.calls.route
    for (const [url, allowed] of [
      [PHOTO, true], ['https://www.instagram.com/p/DYXCSftEgWR/', true], ['https://p16-sign.tiktokcdn.com/obj/a.jpeg', true], ['https://scontent.cdninstagram.com/v/a.jpg', true], ['https://sns-img-hw.xhscdn.com/a.jpg', true],
      ['http://www.tiktok.com/@a/video/12345678', false], ['https://www.tiktok.com:8443/x', false], ['https://evil.example/x', false], ['https://tiktok.com.evil.example/x', false], ['https://eviltiktok.com/x', false],
      ['https://169.254.169.254/latest/meta-data', false], ['https://127.0.0.1/', false], ['https://[::1]/', false], ['https://2130706433/', false], ['https://localhost/', false],
      ['https://metadata.google.internal/', false], ['https://printer.local/', false], ['ftp://www.tiktok.com/x', false], ['file:///etc/passwd', false], ['wss://evil.example/socket', false],
    ]) {
      const route = routeFor(url)
      await handler(route)
      expect(route.continue.mock.calls.length, url).toBe(allowed ? 1 : 0)
      expect(route.abort.mock.calls.length, url).toBe(allowed ? 0 : 1)
    }
    // Nothing is fetched for a page that stays inside the browser.
    const inline = routeFor('data:text/plain,hi')
    await handler(inline)
    expect(inline.continue).toHaveBeenCalled()
  })

  it('ends the read, before reading the page, when a navigation is refused', async () => {
    const pw = playwright({ onGoto: async (calls) => { await calls.route(routeFor('https://evil.example/landing', true)) } })
    await expect(tool(pw).read(PHOTO)).rejects.toMatchObject({ name: 'LinkToolError', code: 'blocked_site' })
    expect(pw.calls.evaluated).toBe(0) // nothing was read from the page
    expect(pw.calls.waited).toBe(0) // and it did not wait for it either
    expect(pw.calls.closed).toBe(1)
  })

  it('ends the read when the page ends up on another site after a redirect, before anything is read or waited for', async () => {
    const pw = playwright({ finalUrl: 'https://evil.example/landing' })
    await expect(tool(pw).read('https://vt.tiktok.com/ZSabc123/')).rejects.toMatchObject({ code: 'blocked_site' })
    expect(pw.calls.evaluated).toBe(0)
    expect(pw.calls.waited).toBe(0)
    // An http page on a supported host is off the list too.
    const plain = playwright({ finalUrl: 'http://www.tiktok.com/@a/photo/7547966708431080724' })
    await expect(tool(plain).read(PHOTO)).rejects.toMatchObject({ code: 'blocked_site' })
    expect(plain.calls.evaluated).toBe(0)
  })

  it('never fetches a video address from the page\'s network that is not allowed', async () => {
    const pw = playwright({ finalUrl: VIDEO, slides: [], onGoto: async (calls) => { calls.onResponse(response('https://evil.example/video.mp4')) } })
    await expect(tool(pw).read(VIDEO)).rejects.toMatchObject({ name: 'LinkToolError' }) // no slides and no video
    expect(pw.ctx.request.get).not.toHaveBeenCalled()
  })

  it('does not fetch an allowed name that resolves to a private address', async () => {
    const privateLookup = vi.fn(async () => [{ address: '10.0.0.8', family: 4 }])
    const pw = playwright({ finalUrl: VIDEO, slides: [], onGoto: async (calls) => { calls.onResponse(response('https://v16.tiktokcdn.com/video.mp4')) } })
    await expect(tool(pw, { lookup: privateLookup }).read(VIDEO)).rejects.toMatchObject({ name: 'LinkToolError' })
    expect(privateLookup).toHaveBeenCalled()
    expect(pw.ctx.request.get).not.toHaveBeenCalled()
    // Nor a slide on one.
    const slide = playwright()
    await expect(tool(slide, { lookup: privateLookup }).read(PHOTO)).rejects.toMatchObject({ name: 'LinkToolError' })
    expect(slide.ctx.request.get).not.toHaveBeenCalled()
  })

  it('fetches a slide on an allowed, public name, with its redirects off, and reads it', async () => {
    const pw = playwright()
    const got = await tool(pw).read(PHOTO)
    expect(got.images).toHaveLength(1)
    expect(pw.ctx.request.get).toHaveBeenCalledWith('https://p16-sign.tiktokcdn.com/obj/slide-one.jpeg', expect.objectContaining({ maxRedirects: 0 }))
  })

  it('follows a redirect by hand and checks each step', async () => {
    const ctx = { request: { get: vi.fn() } }
    ctx.request.get
      .mockResolvedValueOnce(answer(302, '', { location: 'https://p19.tiktokcdn.com/b.jpeg' }))
      .mockResolvedValueOnce(answer(200, 'picture'))
    const ok = await fetchChecked(ctx, 'https://p16.tiktokcdn.com/a.jpeg', { referer: PHOTO, timeout: 1000, lookup: publicLookup })
    expect(ok.status()).toBe(200)
    expect(ctx.request.get.mock.calls.map((c) => c[0])).toEqual(['https://p16.tiktokcdn.com/a.jpeg', 'https://p19.tiktokcdn.com/b.jpeg'])

    for (const to of ['https://evil.example/x', 'http://p19.tiktokcdn.com/x', 'https://169.254.169.254/latest', 'https://127.0.0.1/x', '/\\evil.example/x']) {
      const away = { request: { get: vi.fn(async () => answer(302, '', { location: to })) } }
      const res = await fetchChecked(away, 'https://p16.tiktokcdn.com/a.jpeg', { referer: PHOTO, timeout: 1000, lookup: publicLookup })
      expect(res, to).toBeNull()
      expect(away.request.get.mock.calls.length, to).toBe(1) // refused before a second request is made
    }
    // A redirect that never ends is dropped after three.
    const loop = { request: { get: vi.fn(async () => answer(302, '', { location: 'https://p16.tiktokcdn.com/again.jpeg' })) } }
    expect(await fetchChecked(loop, 'https://p16.tiktokcdn.com/a.jpeg', { referer: PHOTO, timeout: 1000, lookup: publicLookup })).toBeNull()
    expect(loop.request.get).toHaveBeenCalledTimes(4)
  })

  it('refuses a name unless every address it resolves to is public', async () => {
    const answers = (addresses) => async () => addresses.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))
    expect(await resolvesPublic('p16.tiktokcdn.com', answers(['93.184.216.34']))).toBe(true)
    expect(await resolvesPublic('p16.tiktokcdn.com', answers(['2606:4700::1111', '93.184.216.34']))).toBe(true)
    for (const bad of ['127.0.0.1', '10.1.2.3', '172.16.0.9', '192.168.1.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fe80::1', 'fd12:3456::1', '::ffff:127.0.0.1', '::ffff:10.0.0.1', '224.0.0.1']) {
      expect(await resolvesPublic('p16.tiktokcdn.com', answers(['93.184.216.34', bad])), bad).toBe(false) // one bad address among good ones is enough
    }
    expect(await resolvesPublic('x', async () => [])).toBe(false)
    expect(await resolvesPublic('x', async () => { throw new Error('ENOTFOUND') })).toBe(false)
    expect(isPublicAddress('93.184.216.34')).toBe(true)
    expect(isPublicAddress('not an address')).toBe(false)
  })

  it('knows which addresses the browser may load', () => {
    expect(allowedBrowserUrl('https://v16-webapp.tiktok.com/x.mp4')).toBe(true)
    expect(allowedBrowserUrl('https://evil.example/https://www.tiktok.com/')).toBe(false)
    expect(allowedBrowserUrl('https://www.tiktok.com@evil.example/')).toBe(false)
    expect(allowedBrowserUrl('not a url')).toBe(false)
  })

  it('closes the browser and says it took too long when it is stopped from outside', async () => {
    const controller = new AbortController()
    const pw = playwright({ onGoto: async () => { controller.abort() } })
    // A real Playwright call fails when the browser is closed under it; so does this fake page.
    pw.page.waitForTimeout = vi.fn(async () => { throw new Error('Target closed: the browser has been closed') })
    const err = await tool(pw).read(PHOTO, { signal: controller.signal }).catch((e) => e)
    expect(err).toBeInstanceOf(LinkToolError)
    expect(err.code).toBe('timed_out')
    expect(pw.calls.closed).toBeGreaterThanOrEqual(1)
    // Aborted before it began: Chrome is not even started.
    const late = playwright()
    const stopped = new AbortController()
    stopped.abort()
    await expect(tool(late).read(PHOTO, { signal: stopped.signal })).rejects.toMatchObject({ code: 'timed_out' })
    expect(late.calls.launch).toBeNull()
  })

  it('says a fixed sentence for what Playwright says, never its own message', async () => {
    const pw = playwright({ onGoto: async () => { throw new Error('page.goto: net::ERR_NAME_NOT_RESOLVED at https://www.tiktok.com/@a/photo/1?token=abcdefghijklmnopqrstuvwxyz0123456789 /Users/me/.env') } })
    const err = await tool(pw).read(PHOTO).catch((e) => e)
    expect(err).toBeInstanceOf(LinkToolError)
    expect(err.message).toBe('The page could not be opened in a browser.')
    expect(err.detail).toContain('net::ERR_NAME_NOT_RESOLVED') // kept for the server's log
  })
})

// ---------------------------------------------------------------- M4, M5: the download tool

describe('the download tool', () => {
  // Writes the video yt-dlp would save, then ends the way `exec` is told to.
  const download = async (url, { end = () => {} } = {}) => {
    const exec = vi.fn(async (cmd, args) => {
      const dir = join(args[args.indexOf('-o') + 1], '..')
      writeFileSync(join(dir, 'video.mp4'), 'mp4')
      writeFileSync(join(dir, 'video.info.json'), JSON.stringify({ description: 'Soft Order', upload_date: '20260930' }))
      end()
    })
    const got = await createYtDlp({ exec }).download(url)
    return { got, exec }
  }

  it('runs with the server\'s secrets left out', async () => {
    process.env.JIO_TEST_SERVICE_SECRET = 'not-a-real-secret'
    try {
      const { exec } = await download('https://www.tiktok.com/@a/video/12345678')
      const options = exec.mock.calls[0][2]
      expect(options.env.PATH).toBeTruthy()
      expect(options.env.JIO_TEST_SERVICE_SECRET).toBeUndefined()
      expect(Object.keys(options.env).sort()).toEqual(Object.keys(toolEnvironment(process.env)).sort())
    } finally {
      delete process.env.JIO_TEST_SERVICE_SECRET
    }
  })

  it('takes one video of one post, ignores config files, and puts the address after "--"', async () => {
    const { exec, got } = await download('https://www.tiktok.com/@a/video/12345678?lang=en#x')
    const args = exec.mock.calls[0][1]
    expect(args.slice(args.indexOf('--max-downloads'), args.indexOf('--max-downloads') + 2)).toEqual(['--max-downloads', '1'])
    expect(args.slice(args.indexOf('--playlist-items'), args.indexOf('--playlist-items') + 2)).toEqual(['--playlist-items', '1'])
    expect(args).toContain('--no-playlist')
    expect(args).toContain('--ignore-config')
    expect(args.slice(-2)).toEqual(['--', 'https://www.tiktok.com/@a/video/12345678']) // rebuilt, without the query
    expect(got).toMatchObject({ mime: 'video/mp4', caption: 'Soft Order', postDate: '2026-09-30' })
  })

  it('treats the exit yt-dlp makes when it has reached --max-downloads as a success', async () => {
    const { got } = await download('https://www.tiktok.com/@a/video/12345678', { end: () => { throw Object.assign(new Error('Command failed'), { code: 101 }) } })
    expect(got.mime).toBe('video/mp4')
  })

  it('refuses hostile arguments, profiles, feeds and other sites before it runs anything', async () => {
    for (const bad of [
      '--exec=touch /tmp/pwned', '-o /tmp/x', '--config-locations=/tmp/x', '-', '--', ' --exec=x https://www.tiktok.com/@a/video/12345678',
      'https://www.tiktok.com/@someone', 'https://www.tiktok.com/', 'https://www.instagram.com/someone/', 'https://www.instagram.com/explore/', 'https://www.tiktok.com/@a/video/99999999999999999999999',
      'https://www.youtube.com/watch?v=dQw4w9WgXcQ', 'https://www.youtube.com/playlist?list=PL1234567890', 'https://www.xiaohongshu.com/explore/675061a600000000070315b4',
      'http://www.tiktok.com/@a/video/12345678', 'file:///etc/passwd', 'https://example.com/@a/video/12345678', 42, null, undefined,
    ]) {
      const exec = vi.fn()
      await expect(createYtDlp({ exec }).download(bad), String(bad)).rejects.toMatchObject({ name: 'LinkToolError', code: 'refused' })
      expect(exec).not.toHaveBeenCalled()
    }
  })

  it('allows a post and a short link, on TikTok and Instagram only', async () => {
    for (const ok of ['https://www.tiktok.com/@a/video/12345678', 'https://vt.tiktok.com/ZSabc123/', 'https://www.instagram.com/reel/Abc_123-xYZ/', 'https://www.instagram.com/p/DYXCSftEgWR/']) {
      const { exec } = await download(ok)
      expect(exec).toHaveBeenCalledTimes(1)
    }
  })

  it('says a fixed sentence when it fails, never what yt-dlp or the system said', async () => {
    const fail = (err) => createYtDlp({ exec: vi.fn(async () => { throw err }) }).download('https://www.tiktok.com/@a/video/12345678').catch((e) => e)
    const raw = await fail(Object.assign(new Error('ERROR: [TikTok] 12345678: Unable to download webpage: /Users/me/secret.txt AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUM'), { code: 1 }))
    expect(raw).toBeInstanceOf(LinkToolError)
    expect(raw.message).toBe('yt-dlp could not download the video')
    expect(raw.message).not.toContain('secret')
    expect(raw.detail).toContain('Unable to download') // for the server's log
    expect(await fail(Object.assign(new Error('spawn yt-dlp ENOENT'), { code: 'ENOENT' }))).toMatchObject({ code: 'not_installed', message: 'yt-dlp is not installed' })
    expect(await fail(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }))).toMatchObject({ code: 'timed_out' })
    expect(await fail(Object.assign(new Error('timed out'), { killed: true, signal: 'SIGTERM' }))).toMatchObject({ code: 'timed_out' })
  })

  it('removes its download folder', async () => {
    const before = readdirSync(tmpdir()).filter((n) => n.startsWith('jio-link-')).length
    await download('https://www.tiktok.com/@a/video/12345678')
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('jio-link-')).length).toBe(before)
  })
})

describe('what a person is told when a tool fails', () => {
  it('is a fixed sentence, and the detail goes to the log without a key or a query string', async () => {
    const warn = vi.fn()
    const tools = { download: vi.fn(async () => { throw new Error('boom at /Users/me/.env?key=AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUM and sk-ant-api03-DUMMYDUMMYDUMMYDUMMYDUMMYDUMMYDUMMY') }) }
    const browser = { read: vi.fn(async () => { throw new LinkToolError('failed', 'The page could not be opened in a browser.', 'net::ERR at https://www.tiktok.com/x?token=abcdefghijklmnopqrstuvwxyz0123456789') }) }
    const r = await reader(world(), { tools, browser, warn }).read(TT(1))
    const shown = JSON.stringify(r)
    expect(shown).not.toContain('/Users/me')
    expect(shown).not.toContain('AIza')
    expect(shown).not.toContain('boom')
    expect(r.notes[0]).toBe('The video could not be downloaded (an unexpected problem).')
    expect(r.notes[1]).toBe('The post could not be opened in a browser (The page could not be opened in a browser).')
    const logged = warn.mock.calls.map((c) => c.join(' ')).join('\n')
    expect(logged).toContain('download tool failed')
    expect(logged).not.toContain('AIza')
    expect(logged).not.toContain('sk-ant')
    expect(logged).not.toContain('token=')
  })
})

// ---------------------------------------------------------------- M6: what goes to the AI

describe('what is sent to the AI', () => {
  it('sends no comments unless LINK_READER_COMMENTS=1, and does not even ask YouTube for them', async () => {
    const w = world()
    const rd = reader(w, { youtubeKey: 'k' })
    const r = await rd.read(video(1))
    expect(w.http.getJson.mock.calls.some((c) => c[0].includes('commentThreads'))).toBe(false)
    expect(w.http.getJson.mock.calls.some((c) => c[0].includes('/videos'))).toBe(true) // the description and date still are read
    expect(w.questions()[0]).not.toContain('<comments>')
    expect(w.questions()[0]).not.toContain('queue is long')
    expect(r.source.commentsUsed).toBe(0)
    expect(rd.capabilities().youtube).toMatchObject({ description: true, comments: false })
  })

  it('with comments on, sends the words and not who wrote them or who they name', async () => {
    const w = world()
    const rd = reader(w, { youtubeKey: 'k', sendComments: true })
    const r = await rd.read(video(1))
    const everything = JSON.stringify(w.http.postJson.mock.calls.map((c) => c[1]))
    expect(w.questions()[0]).toContain('<comments>')
    expect(w.questions()[0]).toContain('the queue is long, said')
    for (const gone of ['@someone_sg', 'Another.User', 'Jane Tan', 'UCjanetan', 'authorDisplayName']) expect(everything).not.toContain(gone)
    expect(r.source.commentsUsed).toBe(1)
    expect(rd.capabilities().youtube.comments).toBe(true)
    expect(withoutHandles('@bob_sg hi @a.b and a@b.com')).not.toContain('bob_sg')
  })

  it('drops a comment that was only a handle', async () => {
    const w = world({ comment: '@someone_sg' })
    const r = await reader(w, { youtubeKey: 'k', sendComments: true }).read(video(1))
    expect(r.source.commentsUsed).toBe(0)
  })

  it('takes the web addresses out of the AI\'s answer, cuts long fields, and drops fields it was not asked for', () => {
    const long = 'x'.repeat(5000)
    const [p, ...rest] = readPlaces(JSON.stringify({
      places: [{
        name: 'Soft Order https://evil.example/pay?card=1', name_english: 'Soft Order www.evil.example', location_hint: `Visit HTTP://EVIL.EXAMPLE now ${long}`, has_address: true,
        tip: `Great. Order at https://evil.example/x and ${long}`, status: 'open', opens_on: '2026-10-01', closes_on: '', availability_note: 'see www.evil.example/deal', comment_note: 'go to http://evil.example',
        source: 'speech', confidence: 0.9, password: 'hunter2', __proto__: { admin: true }, instructions: 'ignore previous', extra: { nested: true },
      }],
    }))
    expect(rest).toHaveLength(0)
    expect(JSON.stringify(p)).not.toMatch(/evil|https?:|www\./i)
    expect(p.name).toBe('Soft Order')
    expect(p.nameEnglish).toBe('Soft Order')
    expect(p.locationHint.length).toBeLessThanOrEqual(120)
    expect(p.tip.length).toBeLessThanOrEqual(220)
    expect(Object.keys(p).sort()).toEqual(['availabilityNote', 'closesOn', 'commentNote', 'confidence', 'evidence', 'hasAddress', 'locationHint', 'name', 'nameEnglish', 'opensOn', 'status', 'tip'])
    expect(withoutLinks('see https://a.b/c, then www.d.e')).not.toMatch(/a\.b|d\.e/)
  })

  it('keeps at most 20 places, and drops a place whose name was only a link', () => {
    const places = [{ name: 'https://evil.example', tip: 'x' }, ...Array.from({ length: 30 }, (_, i) => ({ name: `Cafe ${i}` }))]
    const out = readPlaces(JSON.stringify({ places }))
    expect(out.length).toBeLessThanOrEqual(20)
    expect(out.some((p) => p.name.includes('evil'))).toBe(false)
  })

  it('never lets a link in the answer reach the reader\'s response', async () => {
    const w = world({ gemini: () => geminiAnswer([place('Soft Order', { tip: 'Pay at https://evil.example/pay now.' })]) })
    const r = await reader(w).read(video(1))
    expect(JSON.stringify(r.places)).not.toContain('evil.example')
  })
})

describe('the new limits are stated where they are set', () => {
  it('reads the temp directory and locale into a minimal environment and nothing else', () => {
    const env = toolEnvironment({ PATH: '/usr/bin', HOME: '/home/x', TMPDIR: '/tmp', GEMINI_API_KEY: 'k', SUPABASE_SERVICE_ROLE_KEY: 's', GOOGLE_MAPS_API_KEY: 'g', ANTHROPIC_API_KEY: 'a' })
    expect(env).toEqual({ LANG: 'en_US.UTF-8', LC_ALL: 'en_US.UTF-8', PATH: '/usr/bin', HOME: '/home/x', TMPDIR: '/tmp' })
  })

  it('has a real LinkReaderError for a link that cannot be used', () => {
    expect(new LinkReaderError('not_a_link').message).toBe('That is not a link that can be read.')
  })
})
