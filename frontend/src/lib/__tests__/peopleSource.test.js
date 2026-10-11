// The people source (lib/peopleSource.js): one place that answers { id, name, username, avatarUrl } for any id. A sample
// person and the account's own profile come from memory; a real person is read from `profiles` through the Supabase client
// in one request per batch, kept in memory, and never turns into an error on a screen. The client is a stand-in; nothing
// here reaches a network.
import { describe, expect, it } from 'vitest'
import { BATCH_SIZE, NEUTRAL_NAME, PROFILE_COLUMNS, RETRY_AFTER_MS, createPeopleSource, personFromRow } from '../peopleSource.js'

const KIM = { id: 'uid-kim', username: 'kim', display_name: 'Kim Tan', avatar_url: 'https://example.invalid/kim.png' }
const SAM = { id: 'uid-sam', username: 'sam', display_name: '', avatar_url: null }

// A client that answers `from('profiles').select(columns).in('id', ids)` from `rows`, and keeps every request it got.
// `mode`: 'ok', 'error' (the database answers an error), 'throw' (the call throws), 'hang' (never answers).
// How to call: const stand = standIn([KIM]); stand.requests -> [{ table, columns, ids }]
function standIn(rows, mode = 'ok') {
  const stand = {
    mode,
    requests: [],
    client: {
      from(table) {
        return {
          select(columns) {
            return {
              async in(_column, ids) {
                stand.requests.push({ table, columns, ids: [...ids] })
                if (stand.mode === 'throw') throw new TypeError('Failed to fetch')
                if (stand.mode === 'hang') return new Promise(() => {})
                if (stand.mode === 'error') return { data: null, error: { message: 'boom' } }
                const named = columns.split(',').map((c) => c.trim())
                return { data: rows.filter((r) => ids.includes(r.id)).map((r) => Object.fromEntries(named.map((c) => [c, r[c]]))), error: null }
              },
            }
          },
        }
      },
    },
  }
  return stand
}

const OWN = { id: 'uid-me', name: 'Me Myself', username: 'me', avatarUrl: 'data:image/png;base64,AAAA' }
const SAMPLE = { darius: { id: 'darius', name: 'Darius', username: 'darius' } }
function make(stand, over = {}) {
  let clock = 1000
  const source = createPeopleSource({
    client: () => stand?.client ?? null,
    own: (id) => (id === OWN.id ? OWN : null),
    sample: (id) => SAMPLE[id] ?? null,
    now: () => clock,
    ...over,
  })
  return { source, tick: (ms) => (clock += ms) }
}

describe('who answers for an id', () => {
  it('answers for a sample person from the sample list, with no request', async () => {
    const stand = standIn([KIM])
    const { source } = make(stand)
    expect(source.get('darius')).toMatchObject({ id: 'darius', name: 'Darius', username: 'darius' })
    expect(source.nameOf('darius')).toBe('Darius')
    expect(await source.load(['darius'])).toEqual([SAMPLE.darius])
    expect(stand.requests).toHaveLength(0)
  })

  it('answers for the account itself from its own profile, with no request', async () => {
    const stand = standIn([KIM])
    const { source } = make(stand)
    expect(source.get(OWN.id)).toEqual(OWN)
    expect(source.nameOf(OWN.id)).toBe('Me Myself')
    await source.load([OWN.id])
    expect(stand.requests).toHaveLength(0)
  })

  it('answers { id, name, username, avatarUrl } for a real person read from profiles', async () => {
    const { source } = make(standIn([KIM, SAM]))
    const [kim, sam] = await source.load(['uid-kim', 'uid-sam'])
    expect(kim).toEqual({ id: 'uid-kim', name: 'Kim Tan', username: 'kim', avatarUrl: 'https://example.invalid/kim.png' })
    // No display name: the username is the name. No photo: an empty address.
    expect(sam).toEqual({ id: 'uid-sam', name: 'sam', username: 'sam', avatarUrl: '' })
    expect(source.get('uid-kim')).toEqual(kim)
  })

  it('does not know a real person before they are read, and says "Someone" meanwhile', () => {
    const { source } = make(standIn([KIM]))
    expect(source.get('uid-kim')).toBeNull()
    expect(source.nameOf('uid-kim')).toBe(NEUTRAL_NAME)
    expect(source.nameOf('')).toBe(NEUTRAL_NAME)
    expect(source.get(undefined)).toBeNull()
  })

  it('turns a row into a person, with the neutral name for a row with nothing to call them', () => {
    expect(personFromRow({ id: 'x', username: null, display_name: '  ', avatar_url: 7 })).toEqual({ id: 'x', name: NEUTRAL_NAME, username: '', avatarUrl: '' })
  })
})

describe('reading real people', () => {
  it('asks for the four public columns of profiles and nothing else', async () => {
    const stand = standIn([KIM])
    const { source } = make(stand)
    await source.load(['uid-kim'])
    expect(PROFILE_COLUMNS).toBe('id, username, display_name, avatar_url')
    expect(stand.requests).toEqual([{ table: 'profiles', columns: PROFILE_COLUMNS, ids: ['uid-kim'] }])
    expect(stand.requests[0].columns).not.toMatch(/dob|home_area|email|private/)
  })

  it('reads a batch of unknown ids in one request, leaving out the account itself, sample people and repeats', async () => {
    const stand = standIn([KIM, SAM])
    const { source } = make(stand)
    await source.load(['uid-kim', 'darius', OWN.id, 'uid-sam', 'uid-kim', '', 'uid-gone'])
    expect(stand.requests).toHaveLength(1)
    expect(stand.requests[0].ids).toEqual(['uid-kim', 'uid-sam', 'uid-gone'])
  })

  it('splits a very large batch only at the batch size', async () => {
    const stand = standIn([])
    const { source } = make(stand)
    const ids = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => `uid-${i}`)
    await source.load(ids)
    expect(stand.requests.map((r) => r.ids.length)).toEqual([BATCH_SIZE, 5])
  })

  it('keeps what it read: a second ask, for the same ids or a mix, makes no request for them', async () => {
    const stand = standIn([KIM, SAM])
    const { source } = make(stand)
    await source.load(['uid-kim'])
    await source.load(['uid-kim'])
    expect(stand.requests).toHaveLength(1)
    await source.load(['uid-kim', 'uid-sam'])
    expect(stand.requests).toHaveLength(2)
    expect(stand.requests[1].ids).toEqual(['uid-sam'])
  })

  it('remembers a person with no profile row too, as "Someone", and does not ask again', async () => {
    const stand = standIn([])
    const { source } = make(stand)
    const [gone] = await source.load(['uid-gone'])
    expect(gone).toEqual({ id: 'uid-gone', name: NEUTRAL_NAME, username: '', avatarUrl: '' })
    await source.load(['uid-gone'])
    expect(stand.requests).toHaveLength(1)
  })

  it('shares one request between two asks made at the same moment', async () => {
    const stand = standIn([KIM])
    const { source } = make(stand)
    const [a, b] = await Promise.all([source.load(['uid-kim']), source.load(['uid-kim'])])
    expect(stand.requests).toHaveLength(1)
    expect(a).toEqual(b)
  })

  it('counts a change only when something was read', async () => {
    const { source } = make(standIn([KIM]))
    const before = source.version()
    await source.load(['darius'])
    expect(source.version()).toBe(before)
    await source.load(['uid-kim'])
    expect(source.version()).toBeGreaterThan(before)
  })
})

describe('when a read cannot be made', () => {
  it.each([['error'], ['throw']])('falls back to "Someone" and never throws when the database answers %s', async (mode) => {
    const stand = standIn([KIM], mode)
    const { source } = make(stand)
    const [kim] = await source.load(['uid-kim'])
    expect(kim.name).toBe(NEUTRAL_NAME)
    expect(source.nameOf('uid-kim')).toBe(NEUTRAL_NAME)
    expect(source.get('uid-kim')).toBeNull()
  })

  it('falls back the same way with no client at all (offline, or no Supabase)', async () => {
    const { source } = make(null)
    const [kim] = await source.load(['uid-kim'])
    expect(kim).toEqual({ id: 'uid-kim', name: NEUTRAL_NAME, username: '', avatarUrl: '' })
  })

  it('does not ask again straight away, and asks again after the wait, and then keeps the answer', async () => {
    const stand = standIn([KIM], 'error')
    const { source, tick } = make(stand)
    await source.load(['uid-kim'])
    await source.load(['uid-kim'])
    expect(stand.requests).toHaveLength(1)
    tick(RETRY_AFTER_MS + 1)
    stand.mode = 'ok'
    const [kim] = await source.load(['uid-kim'])
    expect(stand.requests).toHaveLength(2)
    expect(kim.name).toBe('Kim Tan')
    await source.load(['uid-kim'])
    expect(stand.requests).toHaveLength(2)
  })

  it('does not count a failed read as a change', async () => {
    const { source } = make(standIn([KIM], 'error'))
    const before = source.version()
    await source.load(['uid-kim'])
    expect(source.version()).toBe(before)
  })
})

describe('one account at a time', () => {
  it('forgets everyone it read when reset, and reads them again', async () => {
    const stand = standIn([KIM])
    const { source } = make(stand)
    await source.load(['uid-kim'])
    source.reset()
    expect(source.get('uid-kim')).toBeNull()
    await source.load(['uid-kim'])
    expect(stand.requests).toHaveLength(2)
  })

  it('drops an answer that arrives after a reset, so it cannot reach the next account', async () => {
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const client = {
      from: () => ({ select: () => ({ in: async () => (await gate, { data: [KIM], error: null }) }) }),
    }
    const { source } = make(null, { client: () => client })
    const pending = source.load(['uid-kim'])
    source.reset()
    release()
    await pending
    expect(source.get('uid-kim')).toBeNull()
  })
})
