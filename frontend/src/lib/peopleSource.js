// Where a person's name, username and photo come from. One place answers for any id:
//   - the signed-in account itself, from its own saved profile (`own`);
//   - a sample person (the demo's friends and the sample reviewers), from lib/mock/people.js (`sample`);
//   - any other id, a real person, from the `profiles` table, read through the Supabase client as the signed-in user.
//
// `profiles` is readable whole by any signed-in user, so only the four public columns are asked for (PROFILE_COLUMNS),
// and never `profile_private`. Real people are asked for in one request per batch of ids, never one per row, and an
// answer is kept in memory so asking again makes no request. A read that fails, or a client that is not there (offline,
// or the app has no Supabase), is not an error for a screen: the person shows as "Someone" and the read is tried again
// a little later. The cache is for one account at a time: reset() empties it when the signed-in person changes.
//
// A person is { id, name, username, avatarUrl }.
// How to call: const people = createPeopleSource({ client: () => supabase, own, sample }); await people.load(['7f3c...']); people.nameOf('7f3c...')

export const PROFILE_COLUMNS = 'id, username, display_name, avatar_url'
// The name shown for a person who cannot be looked up.
export const NEUTRAL_NAME = 'Someone'
// The most ids asked for in one request. A session holds at most 30 people, so a batch is normally one request.
export const BATCH_SIZE = 100
// How long to leave an id alone after a read of it failed.
export const RETRY_AFTER_MS = 30 * 1000

// A row of `profiles` as a person. A person with no display name shows their username.
// How to call: personFromRow({ id: 'u1', username: 'sam', display_name: 'Sam', avatar_url: null }) -> { id: 'u1', name: 'Sam', username: 'sam', avatarUrl: '' }
export function personFromRow(row) {
  return {
    id: row.id,
    name: (typeof row.display_name === 'string' && row.display_name.trim()) || (typeof row.username === 'string' && row.username) || NEUTRAL_NAME,
    username: typeof row.username === 'string' ? row.username : '',
    avatarUrl: typeof row.avatar_url === 'string' ? row.avatar_url : '',
  }
}

// Someone nothing is known about. How to call: unknownPerson('u9') -> { id: 'u9', name: 'Someone', username: '', avatarUrl: '' }
export const unknownPerson = (id) => ({ id, name: NEUTRAL_NAME, username: '', avatarUrl: '' })

// own(id), sample(id): a person or null. client(): a Supabase client or null. now(): the time in ms (a test sets it).
// How to call: const people = createPeopleSource({ client: () => dataClient(), own: (id) => ownProfile(id), sample: (id) => samplePerson(id) })
export function createPeopleSource({ client = () => null, own = () => null, sample = () => null, now = () => Date.now() } = {}) {
  // id -> person, for real people already read (a person with no profile row is kept as unknownPerson, so it is not asked again).
  const cache = new Map()
  // id -> the request that is reading it, so two asks for the same id at once make one request.
  const inflight = new Map()
  // id -> when its read failed, so a failing read is not repeated on every screen update.
  const failed = new Map()
  // Raised whenever the cache gains a person, so a caller can tell whether a load changed anything.
  let changes = 0
  // Raised by reset(): an answer that arrives after it belongs to the previous account and is dropped.
  let epoch = 0

  // How to call: people.get('darius') -> { id: 'darius', name: 'Darius', ... }, or null when nothing is known yet
  function get(id) {
    if (typeof id !== 'string' || !id) return null
    return own(id) || sample(id) || cache.get(id) || null
  }

  // How to call: people.nameOf('7f3c...') -> 'Sam', or 'Someone' when not read yet
  const nameOf = (id) => get(id)?.name || NEUTRAL_NAME

  // Did a read of this id fail a moment ago? How to call: coolingDown('7f3c...') -> true for RETRY_AFTER_MS after a failure
  const coolingDown = (id) => failed.has(id) && now() - failed.get(id) < RETRY_AFTER_MS

  // One request for a batch. Never throws: a failure leaves the ids unknown and starts their cool-down.
  // How to call: await readBatch(['7f3c...', '9a1b...'])
  async function readBatch(ids) {
    const mine = epoch
    let rows = null
    try {
      const c = client()
      if (c) {
        const { data, error } = await c.from('profiles').select(PROFILE_COLUMNS).in('id', ids)
        if (!error && Array.isArray(data)) rows = data
      }
    } catch {
      rows = null
    }
    if (mine !== epoch) return
    if (rows === null) {
      for (const id of ids) failed.set(id, now())
      return
    }
    const found = new Map(rows.filter((row) => row && typeof row.id === 'string').map((row) => [row.id, personFromRow(row)]))
    for (const id of ids) {
      cache.set(id, found.get(id) ?? unknownPerson(id))
      failed.delete(id)
    }
    changes += 1
  }

  // Read the people nobody has read yet, in as few requests as the batch size allows, and resolve to a person for every
  // id asked for (the neutral "Someone" for one that could not be read). Ids that are the account itself, a sample
  // person, already read, already being read, or cooling down after a failure make no request.
  // How to call: const [sam, kim] = await people.load(['u1', 'u2'])
  async function load(ids) {
    const wanted = [...new Set((Array.isArray(ids) ? ids : []).filter((id) => typeof id === 'string' && id))]
    const todo = wanted.filter((id) => !get(id) && !inflight.has(id) && !coolingDown(id))
    const started = []
    for (let i = 0; i < todo.length; i += BATCH_SIZE) {
      const batch = todo.slice(i, i + BATCH_SIZE)
      const request = readBatch(batch).finally(() => {
        for (const id of batch) if (inflight.get(id) === request) inflight.delete(id)
      })
      for (const id of batch) inflight.set(id, request)
      started.push(request)
    }
    const waiting = wanted.filter((id) => inflight.has(id)).map((id) => inflight.get(id))
    await Promise.all([...started, ...waiting])
    return wanted.map((id) => get(id) || unknownPerson(id))
  }

  // Forget everything read. Called when the signed-in person changes, so one account never sees another's cache.
  // How to call: people.reset()
  function reset() {
    epoch += 1
    cache.clear()
    inflight.clear()
    failed.clear()
    changes += 1
  }

  return { get, nameOf, load, reset, version: () => changes }
}
