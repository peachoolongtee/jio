// Finding a person to invite by the start of their username: what is worth asking, how the demo and local accounts rank their
// own people, the wait-then-ask behaviour of the invite field (an older answer never shows over a newer question), and the
// demo account's search, which sends nothing anywhere. No network.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PROFILE, boot } from './authFixture.js'
import { PEOPLE_SEARCH_DELAY_MS, createPeopleSearch, isSearchable, rankPeople, searchTerm } from '../peopleSearch.js'

vi.mock('../plannerApi.js', () => ({
  api: { defaults: {} },
  meetingArea: vi.fn(),
  rankSlot: vi.fn(),
  searchSlot: vi.fn(),
  searchPeopleByUsername: vi.fn(),
}))
const planner = await import('../plannerApi.js')

afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('what is searched for', () => {
  it('trims, drops one leading at sign and lower-cases', () => {
    expect(searchTerm(' @Sam_T ')).toBe('sam_t')
    expect(searchTerm('@@x')).toBe('@x')
    expect(searchTerm(null)).toBe('')
  })

  it('accepts 3 to 20 of a-z, 0-9 and underscore, and nothing else', () => {
    for (const ok of ['sam', 'sam_t', 'a1_', 'x'.repeat(20)]) expect(isSearchable(ok)).toBe(true)
    for (const bad of ['', 'sa', 'x'.repeat(21), 'sam t', 'sam.t', 'Sam', 'sam%', 'sàm', null]) expect(isSearchable(bad)).toBe(false)
  })
})

describe('rankPeople (the demo and local accounts)', () => {
  const person = (id, username) => ({ id, name: username.toUpperCase(), username, avatarUrl: '' })
  const all = [person('1', 'sam_tan'), person('2', 'sam'), person('3', 'samuel'), person('4', 'sam_lee'), person('5', 'sammy'), person('6', 'sam_woo'), person('7', 'ian'), person('8', 'asam')]

  it('keeps the start of a username only, with the exact match first, then people met, then the rest by username', () => {
    const found = rankPeople(all, 'sam', { metIds: new Set(['6', '3']), meId: '7' })
    expect(found.map((p) => p.username)).toEqual(['sam', 'sam_woo', 'samuel', 'sam_lee', 'sam_tan'])
    expect(found.map((p) => p.metBefore)).toEqual([false, true, true, false, false])
  })

  it('does not treat the underscore as a wildcard', () => {
    expect(rankPeople(all, 'sam_').map((p) => p.username)).toEqual(['sam_lee', 'sam_tan', 'sam_woo'])
  })

  it('never lists the caller, and answers at most 5', () => {
    expect(rankPeople(all, 'ian', { meId: '7' })).toEqual([])
    expect(rankPeople(all, 'sam', { limit: 2 })).toHaveLength(2)
    expect(rankPeople(all, 'sam')).toHaveLength(5)
  })

  it('returns only the public fields', () => {
    expect(Object.keys(rankPeople([{ ...person('1', 'sam'), dob: '2000-01-01' }], 'sam')[0]).sort()).toEqual(['avatarUrl', 'id', 'metBefore', 'name', 'username'])
  })
})

describe('the invite field\'s state', () => {
  // A search whose answers a test lets go one at a time. `ignoreAbort` is a request that does not notice its signal, so a late answer
  // does arrive and only the field's own check keeps it off the screen.
  // How to call: const s = fakeSearch(); s.calls[0].resolve([...])
  function fakeSearch({ ignoreAbort = false } = {}) {
    const calls = []
    const search = vi.fn((term, { signal }) => new Promise((resolve, reject) => {
      const call = { term, signal, resolve, reject }
      if (!ignoreAbort) signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })))
      calls.push(call)
    }))
    return { search, calls }
  }
  const sam = { id: '1', name: 'Sam', username: 'sam', avatarUrl: '', metBefore: false }

  it('asks nothing under 3 characters, then once, after the pause', async () => {
    vi.useFakeTimers()
    const s = fakeSearch()
    const found = createPeopleSearch({ search: s.search })
    expect(found.phase.value).toBe('short')
    found.text.value = 'sa'
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.search).not.toHaveBeenCalled()
    expect(found.phase.value).toBe('short')
    found.text.value = 'sam'
    expect(found.phase.value).toBe('waiting')
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS - 1)
    expect(s.search).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(s.search).toHaveBeenCalledTimes(1)
    expect(s.search.mock.calls[0][0]).toBe('sam')
    expect(found.phase.value).toBe('looking')
    s.calls[0].resolve([sam])
    await vi.advanceTimersByTimeAsync(0)
    expect(found.phase.value).toBe('done')
    expect(found.people.value).toEqual([sam])
  })

  it('waits for the pause to end after the last key, and asks about what is there then', async () => {
    vi.useFakeTimers()
    const s = fakeSearch()
    const found = createPeopleSearch({ search: s.search })
    for (const text of ['sam', 'sam_', 'sam_t']) {
      found.text.value = text
      await vi.advanceTimersByTimeAsync(200)
    }
    expect(s.search).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(50)
    expect(s.search.mock.calls.map((c) => c[0])).toEqual(['sam_t'])
  })

  it('does not ask again for spaces or capitals that change nothing', async () => {
    vi.useFakeTimers()
    const s = fakeSearch()
    const found = createPeopleSearch({ search: s.search })
    found.text.value = 'sam'
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    found.text.value = ' SAM '
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.search).toHaveBeenCalledTimes(1)
  })

  it('never shows an older answer over a newer question: it cancels the old request and ignores its late answer', async () => {
    vi.useFakeTimers()
    const s = fakeSearch({ ignoreAbort: true })
    const found = createPeopleSearch({ search: s.search })
    found.text.value = 'sam'
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    const [first] = s.calls
    found.text.value = 'sam_'
    expect(first.signal.aborted).toBe(true)
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    const second = s.calls[1]
    // The newer answer comes first; the older one arrives afterwards (a request that ignored its signal).
    second.resolve([{ ...sam, id: '2', username: 'sam_tan' }])
    await vi.advanceTimersByTimeAsync(0)
    first.resolve([sam])
    await vi.advanceTimersByTimeAsync(0)
    expect(found.people.value.map((p) => p.username)).toEqual(['sam_tan'])
    expect(found.phase.value).toBe('done')
  })

  it('ignores an older failure that arrives late, too', async () => {
    vi.useFakeTimers()
    const s = fakeSearch({ ignoreAbort: true })
    const found = createPeopleSearch({ search: s.search })
    found.text.value = 'sam'
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    found.text.value = 'sam_'
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    s.calls[1].resolve([sam])
    await vi.advanceTimersByTimeAsync(0)
    s.calls[0].reject(new Error('Jio could not be reached.'))
    await vi.advanceTimersByTimeAsync(0)
    expect(found.phase.value).toBe('done')
    expect(found.error.value).toBe('')
  })

  it('keeps the last answer while the next is waited for, and drops it under 3 characters', async () => {
    vi.useFakeTimers()
    const s = fakeSearch()
    const found = createPeopleSearch({ search: s.search })
    found.text.value = 'sam'
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    s.calls[0].resolve([sam])
    await vi.advanceTimersByTimeAsync(0)
    found.text.value = 'sam_'
    expect(found.people.value).toEqual([sam])
    expect(found.phase.value).toBe('waiting')
    found.text.value = 'sa'
    expect(found.people.value).toEqual([])
    expect(found.phase.value).toBe('short')
  })

  it('answers nobody at once, with no request, for text that can start no username', async () => {
    vi.useFakeTimers()
    const s = fakeSearch()
    const found = createPeopleSearch({ search: s.search })
    found.text.value = 'sam tan'
    expect(found.phase.value).toBe('done')
    expect(found.people.value).toEqual([])
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.search).not.toHaveBeenCalled()
  })

  it('fails with the sentence, and tries again at once on retry', async () => {
    vi.useFakeTimers()
    const s = fakeSearch()
    const found = createPeopleSearch({ search: s.search })
    found.text.value = 'sam'
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    s.calls[0].reject(new Error('Jio could not be reached. Check your connection and try again.'))
    await vi.advanceTimersByTimeAsync(0)
    expect(found.phase.value).toBe('failed')
    expect(found.error.value).toBe('Jio could not be reached. Check your connection and try again.')
    found.retry()
    expect(found.phase.value).toBe('looking')
    expect(s.calls).toHaveLength(2)
    s.calls[1].resolve([sam])
    await vi.advanceTimersByTimeAsync(0)
    expect(found.phase.value).toBe('done')
    expect(found.error.value).toBe('')
  })

  it('clears to the starting state, and stops for good when disposed', async () => {
    vi.useFakeTimers()
    const s = fakeSearch()
    const found = createPeopleSearch({ search: s.search })
    found.text.value = 'sam'
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    s.calls[0].resolve([sam])
    await vi.advanceTimersByTimeAsync(0)
    found.clear()
    expect(found.text.value).toBe('')
    expect(found.people.value).toEqual([])
    expect(found.phase.value).toBe('short')
    found.text.value = 'kim'
    found.dispose()
    await vi.advanceTimersByTimeAsync(1000)
    expect(s.search).toHaveBeenCalledTimes(1)
  })
})

describe('the demo account\'s search', () => {
  const DEMO = { ...PROFILE, email: 'ian@jio.demo', name: 'Ian', username: 'ian', demo: true, friends: ['darius'] }

  it('searches the sample people here, sends nothing anywhere, ranks met people first and never lists the caller', async () => {
    planner.searchPeopleByUsername.mockClear()
    const { api } = await boot(null)
    await api.signUp({ ...DEMO })
    expect(await api.searchPeople('da')).toEqual([])
    expect((await api.searchPeople('dar')).map((p) => p.username)).toEqual(['darius', 'darryl'])
    expect(await api.searchPeople('ian')).toEqual([])
    // A person met in a session comes first among the rest.
    const { id } = await api.createSession({ title: 'Saturday', date: '2099-10-10', start: '12:00', end: '20:00' })
    await api.inviteFriends(id, ['darryl'])
    const found = await api.searchPeople('dar')
    expect(found.map((p) => [p.username, p.metBefore])).toEqual([['darryl', true], ['darius', false]])
    expect(Object.keys(found[0]).sort()).toEqual(['avatarUrl', 'id', 'metBefore', 'name', 'username'])
    // The start of a username, not a display name or the middle.
    expect(await api.searchPeople('ari')).toEqual([])
    expect(await api.searchPeople('Mei Ling')).toEqual([])
    expect((await api.searchPeople('@MEI')).map((p) => p.username)).toEqual(['meiling'])
    expect(planner.searchPeopleByUsername).not.toHaveBeenCalled()
  })

  it('answers with an AbortError when the search is cancelled while it waits', async () => {
    const { api } = await boot(null)
    await api.signUp({ ...DEMO })
    const controller = new AbortController()
    const pending = api.searchPeople('dar', { signal: controller.signal })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
  })
})
