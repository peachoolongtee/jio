// The demo tour's state: which saves of the story and which side cases are loaded, which checkpoint is selected, and whether
// the tour is on. Pinia, like the other stores, and kept in local storage so a reload stays where it was.
//
// The tour is "on" (live) only for the demo account, with every session it loaded still there. While it is on:
//   - the strip shows (TourStrip.vue) and the stand-in planner answers when the real one does not (standIn.js);
//   - the lists show the selected checkpoint's save and the side cases, not all ten saves (lib/sessionFilter.js).
// Leaving the tour keeps the account and its sessions, hides the strip and takes the stand-in off. The lists keep showing the
// one save that was selected, so ten copies of one outing do not appear; restarting the tour loads everything again.
// Anything else that resets the data (signing out, the development showcase) ends the tour for good.
//   const tour = useTourStore(); await tour.start(); tour.go(3)
import { defineStore } from 'pinia'
import { computed, ref } from 'vue'
import * as api from '@/lib/api.js'
import { setSessionFilter } from '@/lib/sessionFilter.js'
import { CHECKPOINTS, STORY_TITLE } from './story.js'
import { loadTour } from './load.js'
import { startStandIn, stopStandIn } from './standIn.js'

export const TOUR_KEY = 'jio-tour-v1'

// The saved state, when it looks right: ten ids for the story, a list of ids for the side cases, a checkpoint number.
// How to call: readManifest(localStorage.getItem(TOUR_KEY)) -> { story, side, index, left, rough } or null
export function readManifest(text) {
  try {
    const saved = JSON.parse(text)
    const ids = (list) => Array.isArray(list) && list.every((id) => typeof id === 'string')
    if (!saved || !ids(saved.story) || saved.story.length !== CHECKPOINTS.length || !ids(saved.side)) return null
    const index = Number.isInteger(saved.index) && saved.index >= 0 && saved.index < CHECKPOINTS.length ? saved.index : 0
    return { story: saved.story, side: saved.side, index, left: saved.left === true, rough: saved.rough === true }
  } catch {
    return null
  }
}

// Does this list of sessions still hold the tour: every id there, the story's all with the story's title?
// How to call: holdsTour(manifest, await api.listSessions()) -> true
export function holdsTour(manifest, sessions) {
  const byId = new Map(sessions.map((s) => [s.id, s]))
  return manifest.story.every((id) => byId.get(id)?.title === STORY_TITLE) && manifest.side.every((id) => byId.has(id))
}

export const useTourStore = defineStore('tour', () => {
  const manifest = ref(null)
  // True once the saved tour has been checked against the data (or a tour has just been loaded), so a stale save never
  // turns anything on.
  const trusted = ref(false)
  const loading = ref(false)
  // Which planner answered last, 'backend' or 'stand-in', for the strip's quiet line.
  const lastPlanner = ref('')
  // How many answers the stand-in has given since the page opened.
  const standInAnswers = ref(0)

  const loaded = computed(() => !!manifest.value && trusted.value)
  const live = computed(() => loaded.value && !manifest.value.left)
  const index = computed(() => manifest.value?.index ?? 0)
  const checkpoint = computed(() => CHECKPOINTS[index.value])
  // The session of a checkpoint, and the page that shows it best.
  const sessionId = (i) => manifest.value?.story[i] ?? ''
  const pathFor = (i) => (manifest.value ? CHECKPOINTS[i].path(sessionId(i)) : '/')
  // The planner is a rough stand-in: the tour was loaded with it, or it answered last.
  const rough = computed(() => !!manifest.value?.rough || lastPlanner.value === 'stand-in')

  function save() {
    try {
      if (manifest.value) localStorage.setItem(TOUR_KEY, JSON.stringify(manifest.value))
      else localStorage.removeItem(TOUR_KEY)
    } catch {
      // Storage may be missing or full; the tour works for this visit.
    }
  }

  // Which saves the lists show: the selected checkpoint's and everything that is not a save of the story.
  function filter(sessions) {
    const m = manifest.value
    if (!m || !trusted.value) return sessions
    const hidden = new Set(m.story.filter((_, i) => i !== m.index))
    return sessions.filter((s) => !hidden.has(s.id))
  }

  // The stand-in is on while the tour is live or loading.
  function syncStandIn() {
    if (live.value || loading.value) startStandIn(api.api, (source) => {
      lastPlanner.value = source
      if (source === 'stand-in') standInAnswers.value += 1
    }, { backend: !!api.api.defaults.baseURL || import.meta.env.DEV })
    else stopStandIn()
  }

  // Forget the tour: nothing is hidden, no strip, no stand-in.
  // How to call: tour.forget()
  function forget() {
    manifest.value = null
    trusted.value = false
    lastPlanner.value = ''
    save()
    syncStandIn()
  }

  // Select a checkpoint (0 to 9).
  // How to call: tour.select(3)
  function select(i) {
    if (!manifest.value || i < 0 || i >= CHECKPOINTS.length) return
    manifest.value = { ...manifest.value, index: i }
    save()
  }

  // Leave the tour, keeping the account and its sessions; carry on again from where it stopped.
  function leave() {
    if (!manifest.value) return
    manifest.value = { ...manifest.value, left: true }
    save()
    syncStandIn()
  }
  function resume() {
    if (!manifest.value) return
    manifest.value = { ...manifest.value, left: false }
    trusted.value = true
    save()
    syncStandIn()
  }

  // Load the story and the side cases into the demo account (which must be signed in), replacing its sessions, and start at
  // the first checkpoint. Rejects (a ShowcaseError for a session that did not finish) with the tour not loaded.
  // How to call: await tour.start({ onProgress: ({ done, total }) => (note.value = `${done} of ${total}`) })
  async function start({ now = new Date(), makePhotos, onProgress } = {}) {
    loading.value = true
    manifest.value = null
    trusted.value = false
    lastPlanner.value = ''
    syncStandIn()
    try {
      const before = standInAnswers.value
      const result = await loadTour({ now, makePhotos, onProgress })
      // Any answer from the stand-in during the load makes the saves rough, whichever planner answered last.
      const roughLoad = standInAnswers.value > before
      manifest.value = { story: result.story, side: result.side, index: 0, left: false, rough: roughLoad }
      trusted.value = true
      save()
      return result
    } finally {
      loading.value = false
      syncStandIn()
    }
  }

  // Check the saved tour against the data: the demo account is signed in and every session is there. Anything else forgets it.
  // How to call: await tour.verify()
  async function verify() {
    if (!manifest.value) return
    const seen = manifest.value
    let ok = false
    try {
      const user = await api.getUser()
      ok = !!user?.demo && holdsTour(seen, await api.listSessions())
    } catch {
      ok = false
    }
    if (manifest.value !== seen && manifest.value) return
    if (ok) {
      trusted.value = true
      syncStandIn()
    } else {
      forget()
    }
  }

  // Read the saved tour, put the lists' filter in place and keep watching the data. Called once, before the app is drawn.
  // The check against the data runs in the background; `settled()` resolves when it is done.
  // How to call: await useTourStore().attach()
  let attached = false
  async function attach() {
    if (attached) return
    attached = true
    let text = null
    try {
      text = localStorage.getItem(TOUR_KEY)
    } catch {
      text = null
    }
    manifest.value = readManifest(text)
    // Trusted for now, so the first screen is already right; the check below takes it back if the data says otherwise.
    trusted.value = !!manifest.value
    syncStandIn()
    setSessionFilter(filter)
    api.subscribe((event) => {
      if (loading.value) return
      // Signing out, or the development showcase, wiped the data the tour was made of.
      if (event.type === 'reset') forget()
      // A different account, or the same one made again: check it is still the tour's.
      else if (event.type === 'user') verify()
    })
    // Not waited for: the screen should not wait for the data layer to be asked who is signed in.
    verifying = verify()
    await Promise.resolve()
  }
  let verifying = null

  const settled = () => verifying || Promise.resolve()

  return { settled, manifest, trusted, loading, lastPlanner, loaded, live, index, checkpoint, rough, sessionId, pathFor, filter, select, leave, resume, forget, start, verify, attach }
})
