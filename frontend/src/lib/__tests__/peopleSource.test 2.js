// The people source (lib/peopleSource.js): one place that answers { id, name, username, avatarUrl } for any id. A sample
// person and the account's own profile come from memory; a real person is read from `profiles` through the Supabase client
// in one request per batch, kept in memory, and never turns into an error on a screen. The client is a stand-in; nothing
// here reaches a network.
import { describe, expect, it } from 'vitest'
import { BATCH_SIZE, NEUTRAL_NAME, PROFILE_COLUMNS, RETRY_AFTER_MS, createPeopleSource, isUuid, personFromRow, safeAvatar } from '../peopleSource.js'

// profiles.id is a uuid column, so the people in these tests have uuid-shaped ids.
const uuid = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`
const KIM_ID = uuid(10)
const SAM_ID = uuid(11)
const GONE_ID = uuid(12)
const ORIGIN = 'https://project.example.invalid'
const KIM_PHOTO = `${ORIGIN}/storage/v1/object/public/avatars/kim.png`
const KIM = { id: KIM_ID, username: 'kim', display_name: 'Kim Tan', avatar_url: KIM_PHOTO }
const SAM = { id: SAM_ID, username: 'sam', display_name: '', avatar_url: null }

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
                // As Postgres answers: one value that is not a uuid refuses the whole request.
                const bad = ids.find((id) => !isUuid(id))
                if (bad !== undefined) return { data: null, error: { message: `invalid input syntax for type uuid: "${bad}"`, code: '22P02' } }
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
    avatarOrigin: ORIGIN,
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
    const [kim, sam] = await source.load([KIM_ID, SAM_ID])
    expect(kim).toEqual({ id: KIM_ID, name: 'Kim Tan', username: 'kim', avatarUrl: KIM_PHOTO })
    // No display name: the username is the name. No photo: an empty address.
    expect(sam).toEqual({ id: SAM_ID, name: 'sam', username: 'sam', avatarUrl: '' })
    expect(source.get(KIM_ID)).toEqual(kim)
  })

  it('does not know a real person before they are read, and says "Someone" meanwhile', () => {
    const { source } = make(standIn([KIM]))
    expect(source.get(KIM_ID)).toBeNull()
    expect(source.nameOf(KIM_ID)).toBe(NEUTRAL_NAME)
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
    await source.load([KIM_ID])
    expect(PROFILE_COLUMNS).toBe('id, username, display_name, avatar_url')
    expect(stand.requests).toEqual([{ table: 'profiles', columns: PROFILE_COLUMNS, ids: [KIM_ID] }])
    expect(stand.requests[0].columns).not.toMatch(/dob|home_area|email|private/)
  })

  it('reads a batch of unknown ids in one request, leaving out the account itself, sample people and repeats', async () => {
    const stand = standIn([KIM, SAM])
    const { source } = make(stand)
    await source.load([KIM_ID, 'darius', OWN.id, SAM_ID, KIM_ID, '', GONE_ID])
    expect(stand.requests).toHaveLength(1)
    expect(stand.requests[0].ids).toEqual([KIM_ID, SAM_ID, GONE_ID])
  })

  it('sends only uuid-shaped ids, so one id that is not a uuid cannot make the database refuse the rest', async () => {
    const stand = standIn([KIM, SAM])
    const { source } = make(stand)
    const [kim, odd, sam] = await source.load([KIM_ID, 'uid-1', SAM_ID])
    expect(stand.requests).toHaveLength(1)
    expect(stand.requests[0].ids).toEqual([KIM_ID, SAM_ID])
    expect([kim.name, odd.name, sam.name]).toEqual(['Kim Tan', NEUTRAL_NAME, 'sam'])
    // An id that is only not a uuid is not asked for again either, and does not count as a failed read.
    await source.load(['uid-1', 'darius', 'not an id'])
    expect(stand.requests).toHaveLength(1)
  })

  it('knows what a uuid is', () => {
    expect(isUuid(KIM_ID)).toBe(true)
    expect(isUuid('7F3C2A10-5B6D-4E8F-9A1B-0C2D3E4F5A6B')).toBe(true)
    for (const no of ['uid-1', 'ian', '', null, undefined, 7, `${KIM_ID}0`]) expect(isUuid(no)).toBe(false)
  })

  it('splits a very large batch only at the batch size', async () => {
    const stand = standIn([])
    const { source } = make(stand)
    const ids = Array.from({ length: BATCH_SIZE + 5 }, (_, i) => uuid(100 + i))
    await source.load(ids)
    expect(stand.requests.map((r) => r.ids.length)).toEqual([BATCH_SIZE, 5])
  })

  it('keeps what it read: a second ask, for the same ids or a mix, makes no request for them', async () => {
    const stand = standIn([KIM, SAM])
    const { source } = make(stand)
    await source.load([KIM_ID])
    await source.load([KIM_ID])
    expect(stand.requests).toHaveLength(1)
    await source.load([KIM_ID, SAM_ID])
    expect(stand.requests).toHaveLength(2)
    expect(stand.requests[1].ids).toEqual([SAM_ID])
  })

  it('remembers a person with no profile row too, as "Someone", and does not ask again', async () => {
    const stand = standIn([])
    const { source } = make(stand)
    const [gone] = await source.load([GONE_ID])
    expect(gone).toEqual({ id: GONE_ID, name: NEUTRAL_NAME, username: '', avatarUrl: '' })
    await source.load([GONE_ID])
    expect(stand.requests).toHaveLength(1)
  })

  it('shares one request between two asks made at the same moment', async () => {
    const stand = standIn([KIM])
    const { source } = make(stand)
    const [a, b] = await Promise.all([source.load([KIM_ID]), source.load([KIM_ID])])
    expect(stand.requests).toHaveLength(1)
    expect(a).toEqual(b)
  })

  it('counts a change only when something was read', async () => {
    const { source } = make(standIn([KIM]))
    const before = source.version()
    await source.load(['darius'])
    expect(source.version()).toBe(before)
    await source.load([KIM_ID])
    expect(source.version()).toBeGreaterThan(before)
  })
})

describe('when a read cannot be made', () => {
  it.each([['error'], ['throw']])('falls back to "Someone" and never throws when the database answers %s', async (mode) => {
    const stand = standIn([KIM], mode)
    const { source } = make(stand)
    const [kim] = await source.load([KIM_ID])
    expect(kim.name).toBe(NEUTRAL_NAME)
    expect(source.nameOf(KIM_ID)).toBe(NEUTRAL_NAME)
    expect(source.get(KIM_ID)).toBeNull()
  })

  it('falls back the same way with no client at all (offline, or no Supabase)', async () => {
    const { source } = make(null)
    const [kim] = await source.load([KIM_ID])
    expect(kim).toEqual({ id: KIM_ID, name: NEUTRAL_NAME, username: '', avatarUrl: '' })
  })

  it('does not ask again straight away, and asks again after the wait, and then keeps the answer', async () => {
    const stand = standIn([KIM], 'error')
    const { source, tick } = make(stand)
    await source.load([KIM_ID])
    await source.load([KIM_ID])
    expect(stand.requests).toHaveLength(1)
    tick(RETRY_AFTER_MS + 1)
    stand.mode = 'ok'
    const [kim] = await source.load([KIM_ID])
    expect(stand.requests).toHaveLength(2)
    expect(kim.name).toBe('Kim Tan')
    await source.load([KIM_ID])
    expect(stand.requests).toHaveLength(2)
  })

  it('does not count a failed read as a change', async () => {
    const { source } = make(standIn([KIM], 'error'))
    const before = source.version()
    await source.load([KIM_ID])
    expect(source.version()).toBe(before)
  })
})

describe('one account at a time', () => {
  it('forgets everyone it read when reset, and reads them again', async () => {
    const stand = standIn([KIM])
    const { source } = make(stand)
    await source.load([KIM_ID])
    source.reset()
    expect(source.get(KIM_ID)).toBeNull()
    await source.load([KIM_ID])
    expect(stand.requests).toHaveLength(2)
  })

  it('drops an answer that arrives after a reset, so it cannot reach the next account', async () => {
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const client = {
      from: () => ({ select: () => ({ in: async () => (await gate, { data: [KIM], error: null }) }) }),
    }
    const { source } = make(null, { client: () => client })
    const pending = source.load([KIM_ID])
    source.reset()
    release()
    await pending
    expect(source.get(KIM_ID)).toBeNull()
  })
})

describe('photos of other people', () => {
  it('are shown only when they are an image in the address or served by this project\'s own storage', () => {
    expect(safeAvatar('data:image/png;base64,AAAA', ORIGIN)).toBe('data:image/png;base64,AAAA')
    expect(safeAvatar(KIM_PHOTO, ORIGIN)).toBe(KIM_PHOTO)
    for (const no of [
      'https://tracker.example.invalid/pixel.png',
      `${ORIGIN}.evil.invalid/storage/v1/object/public/a.png`,
      `${ORIGIN}/rest/v1/profiles`,
      `${ORIGIN}@evil.invalid/storage/v1/x.png`,
      'javascript:alert(1)',
      'data:text/html;base64,AAAA',
      '//evil.invalid/a.png',
      '',
      null,
      42,
    ]) {
      expect(safeAvatar(no, ORIGIN), String(no)).toBe('')
    }
    // With no project origin (Supabase not set up) only an image in the address is trusted.
    expect(safeAvatar(KIM_PHOTO, '')).toBe('')
  })

  it('reach a person only through that check, so another address shows initials', async () => {
    const odd = { id: GONE_ID, username: 'odd', display_name: 'Odd', avatar_url: 'https://tracker.example.invalid/pixel.png' }
    const { source } = make(standIn([KIM, odd]))
    const [kim, other] = await source.load([KIM_ID, GONE_ID])
    expect(kim.avatarUrl).toBe(KIM_PHOTO)
    expect(other).toEqual({ id: GONE_ID, name: 'Odd', username: 'odd', avatarUrl: '' })
    expect(personFromRow({ id: GONE_ID, username: 'x', display_name: 'X', avatar_url: 'https://tracker.example.invalid/p.png' }).avatarUrl).toBe('')
  })
})

describe('a read that never answers', () => {
  it('counts as a failed read after the deadline, shows "Someone", and does not throw', async () => {
    const stand = standIn([KIM], 'hang')
    const { source } = make(stand, { timeoutMs: () => 20 })
    const started = Date.now()
    const [kim] = await source.load([KIM_ID])
    expect(Date.now() - started).toBeLessThan(2000)
    expect(kim.name).toBe(NEUTRAL_NAME)
    expect(source.get(KIM_ID)).toBeNull()
    // Treated like any failed read: left alone for the cool-down, then asked again.
    await source.load([KIM_ID])
    expect(stand.requests).toHaveLength(1)
  })

  it('drops a late answer after the deadline instead of using it', async () => {
    let release
    const gate = new Promise((resolve) => (release = resolve))
    const client = { from: () => ({ select: () => ({ in: async () => (await gate, { data: [KIM], error: null }) }) }) }
    const { source } = make(null, { client: () => client, timeoutMs: () => 10 })
    await source.load([KIM_ID])
    release()
    await new Promise((resolve) => setTimeout(resolve, 10))
    expect(source.get(KIM_ID)).toBeNull()
  })
})
