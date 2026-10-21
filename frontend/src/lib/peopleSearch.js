// Finding a person to invite as the host types the start of their username: what counts as something to search for, how the
// demo and local accounts rank their own people, and the small state machine behind the invite field (wait a moment after the
// last key, ask, ignore an answer that a newer question replaced). No network and no component here, so each part is tested alone.
// components/group/InviteByUsername.vue and api.js (searchPeople) use it; the server's side is backend/src/routes/people.js.

import { computed, ref, watch } from 'vue'
import { createLatest, isCancelled } from './placeSearch.js'

// Fewest and most characters of a username worth asking about (a username is 3 to 20 of a-z, 0-9 and _), and the most people
// one search shows. The server enforces the same three numbers.
export const PEOPLE_SEARCH_MIN = 3
export const PEOPLE_SEARCH_MAX = 20
export const PEOPLE_SEARCH_LIMIT = 5
// How long after the last key the search is asked.
export const PEOPLE_SEARCH_DELAY_MS = 250

// What was typed as a username to look for: trimmed, one leading at sign dropped, lower case. It may still be too short or
// hold characters no username has.
// How to call: searchTerm(' @Sam_T ') -> 'sam_t'
export function searchTerm(text) {
  return String(text ?? '').trim().replace(/^@/, '').toLowerCase()
}

// Is this a term the server accepts: 3 to 20 of a-z, 0-9 and underscore? A term that is not (a space, a dot, 25 letters) can
// match no username, so it is never sent.
// How to call: isSearchable('sam_t') -> true; isSearchable('sa') -> false; isSearchable('sam t') -> false
export function isSearchable(term) {
  return /^[a-z0-9_]{3,20}$/.test(String(term ?? ''))
}

// People whose username starts with `term`, in the order the server uses: the exact match first, then people met before, then
// the rest, each group by username; at most `limit`. `people` are { id, name, username, avatarUrl }; `metIds` is a Set of ids;
// `meId` is left out. Each comes back with `metBefore`. This is for the demo and local accounts, which have no server.
// How to call: rankPeople(people, 'sam', { metIds: new Set(['u2']), meId: 'u9' }) -> [{ ...sam, metBefore: false }, ...]
export function rankPeople(people, term, { metIds = new Set(), meId = '', limit = PEOPLE_SEARCH_LIMIT } = {}) {
  const byName = (a, b) => (a.username < b.username ? -1 : a.username > b.username ? 1 : 0)
  const rank = (p) => (p.username === term ? 0 : p.metBefore ? 1 : 2)
  return people
    .filter((p) => p.id !== meId && typeof p.username === 'string' && p.username.toLowerCase().startsWith(term))
    .map((p) => ({ id: p.id, name: p.name, username: p.username, avatarUrl: p.avatarUrl || '', metBefore: metIds.has(p.id) }))
    .sort((a, b) => rank(a) - rank(b) || byName(a, b))
    .slice(0, limit)
}

// The state of the invite field. `search(term, { signal })` resolves a list of people (rejects with a sentence when it cannot).
// What it keeps, all refs:
//   text    what is typed (v-model it)
//   phase   'short' (under 3 characters), 'waiting' (typed, not asked yet), 'looking' (asked, no answer yet), 'done'
//           (answered, or the term can match nobody) or 'failed'
//   people  the last answer. It stays while a newer question is waiting or looking, so the list does not flash away.
//   error   the sentence for a failed search
// Typing again cancels what is waiting or running and forgets its answer. dispose() stops everything (call it when the screen goes).
// How to call: const found = createPeopleSearch({ search: (term, { signal }) => api.searchPeople(term, { signal }) })
export function createPeopleSearch({ search, delayMs = PEOPLE_SEARCH_DELAY_MS }) {
  const text = ref('')
  const phase = ref('short')
  const people = ref([])
  const error = ref('')
  const term = computed(() => searchTerm(text.value))
  const latest = createLatest()
  let timer = null

  // Stop whatever is waiting or running. How to call: stop()
  function stop() {
    clearTimeout(timer)
    timer = null
    latest.cancel()
  }

  // Ask now. How to call: await run('sam')
  async function run(q) {
    const job = latest.start()
    phase.value = 'looking'
    try {
      const answer = await search(q, { signal: job.signal })
      if (!job.current()) return
      people.value = Array.isArray(answer) ? answer : []
      error.value = ''
      phase.value = 'done'
    } catch (err) {
      if (!job.current() || isCancelled(err)) return
      error.value = err?.message || 'People could not be looked up. Try again.'
      phase.value = 'failed'
    }
  }

  // Sync, so the state follows the key at once and a test needs no waiting.
  watch(
    term,
    (q) => {
      stop()
      error.value = ''
      if (q.length < PEOPLE_SEARCH_MIN) {
        people.value = []
        phase.value = 'short'
      } else if (!isSearchable(q)) {
        people.value = []
        phase.value = 'done'
      } else {
        phase.value = 'waiting'
        timer = setTimeout(() => run(q), delayMs)
      }
    },
    { flush: 'sync' },
  )

  // Ask again after a failure, without waiting. How to call: retry()
  function retry() {
    if (!isSearchable(term.value)) return
    stop()
    run(term.value)
  }

  // Empty the field and everything shown. How to call: clear()
  function clear() {
    text.value = ''
  }

  // Stop for good. How to call: onBeforeUnmount(found.dispose)
  function dispose() {
    stop()
  }

  return { text, term, phase, people, error, retry, clear, dispose }
}
