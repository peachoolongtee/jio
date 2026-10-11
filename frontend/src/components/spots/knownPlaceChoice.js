// "We already have a place", named while the session is being created. A known place needs at least two people (the data
// layer refuses it for one), and a new session has only its host, so the host's choice waits here until they start the
// session. It lives in session storage: it is the host's intention, not session data, and it goes when the tab does.
// A choice belongs to one session: it is stored with the session's creation time, so a session made later under the same
// id (after "Reset demo data") never inherits it.

const KEY = 'jio-known-place'

// Every stored choice, by session id. Storage that is missing or blocked reads as no choices.
// How to call: readAll() -> { s1: { areaId: 'bugis', at: 1760000000000 } }
function readAll() {
  try {
    const parsed = JSON.parse(globalThis.sessionStorage?.getItem(KEY) || '{}')
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}
// Keep every choice, by session id. Storage that refuses the write loses them with the page.
// How to call: writeAll({ s1: { areaId: 'bugis', at: 1760000000000 } })
function writeAll(all) {
  try {
    globalThis.sessionStorage?.setItem(KEY, JSON.stringify(all))
  } catch {
    // The choice is lost with the page; the host can name the place again from the session.
  }
}

// Keep the area the host named for this session. An empty area forgets it.
// How to call: rememberKnownPlace({ id: 's1', createdAt: 1760000000000 }, 'bugis')
export function rememberKnownPlace(session, areaId) {
  const all = readAll()
  if (areaId) all[session.id] = { areaId, at: session.createdAt }
  else delete all[session.id]
  writeAll(all)
}

// The area the host named for this session, or '' when there is none (or it was named for an earlier session of that id).
// How to call: recalledKnownPlace({ id: 's1', createdAt: 1760000000000 }) -> 'bugis'
export function recalledKnownPlace(session) {
  const kept = readAll()[session.id]
  return kept && kept.at === session.createdAt && typeof kept.areaId === 'string' ? kept.areaId : ''
}

// Forget it, once it has been used or removed.
// How to call: forgetKnownPlace({ id: 's1', createdAt: 1760000000000 })
export const forgetKnownPlace = (session) => rememberKnownPlace(session, '')
