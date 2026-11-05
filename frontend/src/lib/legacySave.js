// A real account's save from before every real account carried its own id. That build made a real account the sample person
// (the id in lib/mock/people.js) in every row it wrote: host, member, location, spot, approval, suggestion, vote, proposal,
// photo and standings. A person who tried the app then and signs in again must keep their sessions, so this walks the known
// shape of a save and gives the account's own id to each place the sample person's id stands for the account. Every other
// person in the save (the sample friends the sessions were made with) keeps their sample id.
//
// It is a walk over named tables, not a search and replace, so a title or a place's name that happens to read like the id is
// never touched. The test that guards it builds a save with the data layer's own writes and fails if any id is left behind.
// How to call: remapLegacySave(JSON.parse(text), 'ian', '7f3c2a10-...') -> the save with '7f3c2a10-...' where 'ian' was

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)

// Does this save look like the old build's real account: the account's own Supabase id as `authId`, and the sample id as `id`?
// How to call: isLegacyRealSave(saved, 'ian', '7f3c2a10-...') -> true
export function isLegacyRealSave(saved, from, authId) {
  return isObject(saved) && isObject(saved.user) && saved.user.authId === authId && saved.user.id === from
}

// The save with the id `from` replaced by `to` in every table that holds a person's id. Does not change `saved`. Throws a
// TypeError when a table is not the shape the data layer writes, so the caller can keep the backup and start fresh.
// `isSample(id)` says which ids are the sample people: their numbers are not kept, because a real account's world holds only
// its own and real people's.
// How to call: remapLegacySave(saved, 'ian', 'uuid', { isSample: (id) => id === 'darius' })
export function remapLegacySave(saved, from, to, { isSample = () => false } = {}) {
  const swap = (id) => (id === from ? to : id)
  // The same object with its keys swapped. How to call: keyed({ ian: 1, darius: 2 }) -> { uuid: 1, darius: 2 }
  const keyed = (object) => {
    if (object === undefined || object === null) return object
    if (!isObject(object)) throw new TypeError('expected an object')
    return Object.fromEntries(Object.entries(object).map(([id, value]) => [swap(id), value]))
  }
  const list = (value, map) => {
    if (value === undefined || value === null) return value
    if (!Array.isArray(value)) throw new TypeError('expected a list')
    return value.map(map)
  }

  const session = (s) => ({
    ...s,
    hostId: swap(s.hostId),
    members: list(s.members, (m) => ({ ...m, id: swap(m.id) })),
    locations: keyed(s.locations),
    prefs: keyed(s.prefs),
    votes: isObject(s.votes) ? Object.fromEntries(Object.entries(s.votes).map(([slot, byPerson]) => [slot, keyed(byPerson)])) : s.votes,
    meeting: isObject(s.meeting) ? { ...s.meeting, times: keyed(s.meeting.times) } : s.meeting,
    spots: isObject(s.spots)
      ? {
          ...s.spots,
          // `by` is 'app' or a person's id.
          list: list(s.spots.list, (spot) => ({ ...spot, by: swap(spot.by), times: keyed(spot.times) })),
          approvals: keyed(s.spots.approvals),
          suggestions: keyed(s.spots.suggestions),
        }
      : s.spots,
    proposals: list(s.proposals, (p) => ({ ...p, by: swap(p.by) })),
    photos: list(s.photos, (p) => ({ ...p, personId: swap(p.personId) })),
  })

  // A past season keeps only the account's own result: the sample people's standings are not part of a real account's world.
  const season = (past) => ({
    ...past,
    winners: list(past.winners, (w) => ({ ...w, id: swap(w.id) })).filter((w) => w.id === to),
    standings: list(past.standings, (row) => ({ ...row, id: swap(row.id) })).filter((row) => row.id === to),
  })

  return {
    ...saved,
    user: { ...saved.user, id: to },
    // A real account's friends are the people it shares sessions with, not a list it keeps.
    friends: [],
    sessions: list(saved.sessions, session),
    stats: Object.fromEntries(Object.entries(keyed(saved.stats) ?? {}).filter(([id]) => id === to || !isSample(id))),
    pastSeasons: list(saved.pastSeasons, season),
  }
}
