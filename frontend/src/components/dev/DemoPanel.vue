<script setup>
// Demo tools. Only in development builds (App.vue loads this file behind import.meta.env.DEV).
// Friends cannot act in a single-user build, so these buttons act for them through lib/api.js,
// the same way their own phones would.
import { coins } from '@/lib/currency.js'
import { computed, ref, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import BottomSheet from '../ui/BottomSheet.vue'
import ChipButton from '../ui/ChipButton.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import SelectField from '../ui/SelectField.vue'
import StatusPill from '../ui/StatusPill.vue'
import ToggleSwitch from '../ui/ToggleSwitch.vue'
import * as api from '@/lib/api.js'
import { lastWeather } from '@/lib/plannerApi.js'
import { FRIEND_PICKS, PEOPLE } from '@/lib/mock/people.js'
import { DEMO_ACCOUNT } from './demoAccount.js'
import { makeDemoPhotos } from './demoPhotos.js'
import { clearApprovals, friendSuggests, friendsApprove, hasSpots } from './spotDemo.js'
import { friendProposes } from './roamDemo.js'
import { roamOpen } from '@/lib/session.js'
import { loadShowcase } from './showcase.js'
import { placeKind } from '@/lib/placeImages.js'
import { useAuthStore } from '@/stores/auth.js'
import { AREAS } from '@/lib/mock/places.js'
import { useEventsStore } from '@/stores/events.js'
import { usePlannerStore } from '@/stores/planner.js'
import { useTourStore } from '@/tour/store.js'

const SPAN = 3000
// Which option each friend votes for, by rank, so one place usually leads.
const PATTERN = [0, 1, 0, 2, 0]
// The sample friends "Bring in sample friends" adds to a real account's session.
const SAMPLE_STAND_INS = ['darius', 'faith']

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()
const events = useEventsStore()
const planner = usePlannerStore()
const tour = useTourStore()

const open = ref(false)
const running = ref('')
const note = ref('')
const change = ref({ personId: 'jonathan', which: 'start', areaId: 'orchard' })
const optOutId = ref('jonathan')
// The question "Replace your sessions?" before the showcase is loaded.
const askShowcase = ref(false)

const session = computed(() => {
  const id = route.params.id
  return (id && events.byId[id]) || events.current
})
const friendsIn = computed(() => (session.value ? session.value.activeIds.filter((id) => id !== auth.myId) : []))
const friendOptions = computed(() => friendsIn.value.map((id) => ({ value: id, label: nameOf(id) })))
const areaOptions = [...AREAS].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: a.name }))
const status = computed(() => session.value?.status)
const live = computed(() => ['locating', 'voting', 'confirmed'].includes(status.value))
// Why the friend buttons may be off, or what still has to happen, so a click never seems to do nothing.
const hostLocated = computed(() => !!session.value?.locations?.[auth.myId]?.start)
const friendsHint = computed(() => {
  if (status.value === 'inviting' && !friendsIn.value.length && !auth.sampleWorld) return 'A real account has no friends to invite. Bring in the sample friends below, then start the session on the session page.'
  if (status.value === 'inviting') return friendsIn.value.length ? 'Tap Start session on the session page first. Friends share their locations after that.' : 'Invite at least one friend and start the session first.'
  if (status.value === 'locating' && !hostLocated.value) return 'Spots open once two people have shared where they start, and the meeting point once everyone has. Set your From location on the session page.'
  return ''
})

// Roam: a friend can propose a place only while the plan is under way. Why the button may be off, so a click never seems to do nothing.
const underway = computed(() => !!session.value && roamOpen(session.value))
const roamHint = computed(() => {
  if (!session.value || underway.value) return ''
  return 'A friend can propose a place once the plan is confirmed and it is the session day. Turn on "It is the session day" under Conditions.'
})

// The meeting spots, while the group is choosing where to meet. Why the buttons may be off, so a click never seems to do nothing.
const spotsOpen = computed(() => hasSpots(session.value))
const anyApprovals = computed(() => Object.keys(session.value?.spots?.approvals || {}).length > 0)
const spotsHint = computed(() => {
  if (!session.value || spotsOpen.value) return ''
  if (status.value === 'locating') return hostLocated.value ? 'No spots yet. They open once two people have shared where they start: simulate friends submitting locations.' : 'No spots yet. They open once two people have shared where they start: set your From location, then simulate friends submitting locations.'
  return 'Spots change only while a session is choosing where to meet (after Start session, before Confirm).'
})

watch(open, async (isOpen) => {
  if (isOpen) {
    await planner.loadConditions()
    if (!events.loaded) await events.loadSessions()
  }
})
watch(friendsIn, (ids) => {
  if (!ids.includes(change.value.personId)) change.value.personId = ids[0] || ''
  if (!ids.includes(optOutId.value)) optOutId.value = ids[0] || ''
})

const wait = (ms) => new Promise((r) => setTimeout(r, ms))
const nameOf = (id) => PEOPLE.find((p) => p.id === id)?.name || 'Someone'

// Run the jobs evenly across `span` milliseconds, like friends acting one after another.
function spread(jobs, span) {
  const step = span / Math.max(jobs.length, 1)
  return Promise.all(jobs.map((job, i) => wait(step * (i + 1)).then(() => job(i))))
}

// Run a demo action. A failure (the planner backend not answering, say) shows in the note
// instead of leaving the buttons disabled.
async function act(kind, fn) {
  running.value = kind
  note.value = ''
  try {
    await fn()
  } catch (e) {
    note.value = e.message
  } finally {
    running.value = ''
  }
}

// A real account has no friends yet, so the steps that need two people cannot start. This puts two sample friends into the
// session as stand-ins (they join at once), and the buttons below then act for them as for the demo account's friends.
// How to call: bringSampleFriends()
const bringSampleFriends = () => act('sample-friends', async () => {
  await api.inviteFriends(session.value.id, SAMPLE_STAND_INS)
  note.value = 'Darius and Faith joined as stand-ins.'
})

const simulateLocations = () => act('locations', async () => {
  const s = session.value
  const waiting = friendsIn.value.filter((id) => !s.locations?.[id]?.start)
  note.value = waiting.length ? '' : 'Every friend already has a start location.'
  await spread(
    waiting.map((id) => () => api.setLocation(s.id, id, 'start', { areaId: PEOPLE.find((p) => p.id === id).homeAreaId })),
    SPAN,
  )
  if (waiting.length && !hostLocated.value) note.value = "Friends' locations are in. Set your own From location so the spots count your trip too."
})

const simulateVoting = () => act('voting', async () => {
  const id = session.value.id
  const plan = await api.getPlan(id)
  const jobs = []
  // Each friend votes in the categories they like (FRIEND_PICKS), for one place in each.
  friendsIn.value.forEach((f, i) => {
    plan.slots.forEach((slot, s) => {
      if (!slot.options.length || !FRIEND_PICKS[f]?.categories?.includes(slot.category)) return
      // Voting for a place they already voted for would take the vote back.
      if (slot.options.some((o) => o.voters.some((v) => v.id === f))) return
      const pick = slot.options[PATTERN[(i + s) % PATTERN.length] % slot.options.length]
      jobs.push(() => api.vote(id, slot.id, f, pick.id).catch(() => {}))
    })
  })
  await spread(jobs, SPAN)
})

// Friends post photos from the day, filling the session's album: photos made from the app's own place photos,
// of the kinds of place on the itinerary (demoPhotos.js), posted by the friends in turn. A session holds up to
// PHOTOS_MAX photos, so this stops at the cap, and at the first photo that fails to save (the browser's storage is
// full, say), and shows why in the note.
const simulatePhotos = () => act('photos', async () => {
  const s = await api.getSession(session.value.id)
  const room = api.PHOTOS_MAX - s.photoCount
  if (room <= 0) {
    note.value = `The session already holds ${api.PHOTOS_MAX} photos. Delete one first.`
    return
  }
  const friends = friendsIn.value.length ? friendsIn.value : [auth.myId]
  const itinerary = await api.getItinerary(s.id).catch(() => null)
  const kinds = (itinerary?.stops || []).map((stop) => placeKind(stop.venue))
  let srcs
  try {
    srcs = await makeDemoPhotos(kinds, room, `${s.id}-${s.photoCount}`)
  } catch (e) {
    note.value = e.message
    return
  }
  let failure = ''
  let posted = 0
  const jobs = srcs.map((src, i) => async () => {
    if (failure) return
    try {
      await api.addPhoto(s.id, friends[(i + s.photoCount) % friends.length], src)
      posted += 1
    } catch (e) {
      failure = e.message
    }
  })
  await spread(jobs, SPAN)
  note.value = failure ? `Posted ${posted}. ${failure}` : `Posted ${posted} photos. The album is full (${api.PHOTOS_MAX}).`
})

// A friend suggests a spot (here: they are there already), friends say which spots work for them, or every approval goes.
// How to call: suggestSpot(true)
const suggestSpot = (here) => act('spots', async () => { note.value = await friendSuggests(api, session.value, friendsIn.value, { here }) })
// A friend proposes a place from "What next?" on the plan that is under way, so the host can add it or leave it out.
// How to call: proposePlace()
const proposePlace = () => act('roam', async () => { note.value = await friendProposes(api, session.value, friendsIn.value) })
const approveSpots = () => act('spots', async () => { note.value = await friendsApprove(api, session.value, friendsIn.value) })
const clearSpotApprovals = () => act('spots', async () => { note.value = await clearApprovals(api, session.value) })

const applyChange = () => act('change', async () => {
  const { personId, which, areaId } = change.value
  await api.setLocation(session.value.id, personId, which, { areaId })
  note.value = `${nameOf(personId)}'s ${which} location is now ${AREAS.find((a) => a.id === areaId).name}.`
})

const optOut = () => act('optout', async () => {
  await api.optOut(session.value.id, optOutId.value)
  note.value = `${nameOf(optOutId.value)} opted out.`
})

// The leaderboard season ends now instead of at the end of the quarter: first place wins the prize.
const endSeason = () => act('season', async () => {
  const ended = await api.endSeason()
  const names = ended.winners.map((w) => w.name).join(' and ')
  note.value = names ? `Season ${ended.number} ended. ${names} won ${coins(ended.prize)}.` : `Season ${ended.number} ended. Nobody earned JioCoins, so nobody won.`
})

// Replace the sessions with the showcase (showcase.js): ten sessions, one for each state a screen can show. The question
// above it has been answered. The count shows in the note as they finish. Home and the other screens follow on their
// own, as every write tells them; the sessions are loaded once more at the end in case one was missed. A failure part way
// says what was loaded and what was not (the note); what was made stays.
// How to call: loadShowcaseData()
const loadShowcaseData = () => act('showcase', async () => {
  askShowcase.value = false
  note.value = 'Loading showcase data'
  try {
    const result = await loadShowcase({ onProgress: ({ done, total }) => (note.value = `Loading showcase data: ${done} of ${total} sessions`) })
    note.value = `${result.sessions.length} sessions loaded.${result.planner === 'backend' ? '' : ' The planner is not running, so meeting areas and places are rough stand-ins. Confirming a spot, suggesting one and the voting screens need it.'}`
  } finally {
    await events.loadSessions()
  }
})

// Replace the sessions with the demo tour (tour/): one outing in eight checkpoints, and a few side cases. The strip appears
// on every screen and the lists show the selected checkpoint. This panel closes on the way, since Home is where it starts.
// How to call: startTheTour()
const startTheTour = () => act('tour', async () => {
  note.value = 'Loading the tour'
  open.value = false
  try {
    await tour.start({ onProgress: ({ done, total }) => (note.value = `Loading the tour: ${done} of ${total} sessions`) })
  } catch (err) {
    open.value = true
    throw err
  } finally {
    await events.loadSessions()
  }
  note.value = ''
  router.push({ path: '/', query: { meetup: tour.sessionId(0) } })
})

// A new demo account with the sample history (10 meetups and 1,000 JioCoins), then Home. This panel closes on the way,
// since it only shows while signed in. If the profile is rejected nothing is erased, so the panel opens again with the
// reason. If sign-up fails after the wipe, the person is sent to the sign-up page, which shows the reason.
async function startOver() {
  open.value = false
  note.value = ''
  try {
    await auth.startOver(DEMO_ACCOUNT)
  } catch (e) {
    note.value = e.message
    if (auth.signedIn) open.value = true
    else router.replace('/signup')
    return
  }
  router.push('/')
}

async function reset() {
  await api.resetDemo()
  note.value = 'Demo data reset.'
  open.value = false
  router.push('/')
}

const conditions = computed(() => planner.conditions)
const setCondition = (key, value) => planner.setCondition(key, value)
</script>

<template>
  <button type="button" class="demo-fab" aria-label="Demo tools" @click="open = true">
    <AppIcon name="sparkle" />
    <span>Demo</span>
  </button>

  <BottomSheet v-model:open="open" title="Demo tools" side tall>
    <p class="caption-sm text-muted">Development only</p>

    <div v-if="session" class="demo-target">
      <span class="title-sm truncate">{{ session.title }}</span>
      <StatusPill :status="session.status" />
    </div>
    <p v-else class="body-sm text-muted">No session yet.</p>
    <!-- What the last action did (or why it could not), at the top so it is seen without scrolling. -->
    <p v-if="note" class="body-sm demo-note" role="status">{{ note }}</p>

    <!-- First, since it is what a presenter starts with: the sessions every other group below acts on. -->
    <section v-if="!auth.sampleWorld" class="demo-group">
      <h3 class="title-md">Showcase and tour</h3>
      <p class="body-sm text-muted">The showcase and the tour are made of the sample people and belong to the demo account. This is a real account, so they are off. Use "Start over with a new account" below to go back to the demo account.</p>
    </section>
    <section v-else class="demo-group">
      <h3 class="title-md">Showcase</h3>
      <p class="body-sm text-muted">Replaces your sessions with ten, one for each state a screen can show, including two in the vote for where to meet (you host one, a friend hosts the other) and one where the place was already decided.</p>
      <AppButton block variant="secondary" :disabled="!!running" @click="askShowcase = true">
        {{ running === 'showcase' ? 'Loading showcase data' : 'Load showcase data' }}
      </AppButton>
      <p class="body-sm text-muted">The demo tour is the same idea told as one outing: eight checkpoints in a strip at the top of every screen, and a few side cases. It also replaces your sessions. Outside development it is at /demo.</p>
      <AppButton block variant="secondary" :disabled="!!running" @click="startTheTour">
        {{ running === 'tour' ? 'Loading the tour' : 'Start the tour' }}
      </AppButton>
    </section>

    <section class="demo-group">
      <h3 class="title-md">Friends</h3>
      <p v-if="friendsHint" class="body-sm text-muted">{{ friendsHint }}</p>
      <template v-if="!auth.sampleWorld">
        <p class="body-sm text-muted">This is a real account, which starts with no friends. Add two sample friends to the session as stand-ins to walk the steps that need more than one person.</p>
        <AppButton block variant="secondary" :disabled="!session || status !== 'inviting' || !!running" @click="bringSampleFriends">
          {{ running === 'sample-friends' ? 'Adding' : 'Bring in sample friends' }}
        </AppButton>
      </template>
      <AppButton block variant="secondary" :disabled="!session || !live || !!running" @click="simulateLocations">
        {{ running === 'locations' ? 'Submitting locations' : 'Simulate friends submitting locations' }}
      </AppButton>
      <AppButton block variant="secondary" :disabled="!session || status !== 'voting' || !!running" @click="simulateVoting">
        {{ running === 'voting' ? 'Voting' : 'Simulate friends voting' }}
      </AppButton>
      <AppButton block variant="secondary" :disabled="!session || !['confirmed', 'completed'].includes(status) || !!running" @click="simulatePhotos">
        {{ running === 'photos' ? 'Posting photos' : 'Fill the album with photos' }}
      </AppButton>
    </section>

    <section class="demo-group">
      <h3 class="title-md">What next?</h3>
      <p v-if="roamHint" class="body-sm text-muted">{{ roamHint }}</p>
      <p v-else class="body-sm text-muted">Needs the planner backend to list places near the meeting area.</p>
      <AppButton block variant="secondary" :disabled="!underway || !!running" @click="proposePlace">
        {{ running === 'roam' ? 'Proposing a place' : 'A friend proposes a place' }}
      </AppButton>
    </section>

    <section class="demo-group">
      <h3 class="title-md">Meeting spots</h3>
      <p v-if="spotsHint" class="body-sm text-muted">{{ spotsHint }}</p>
      <p v-else class="body-sm text-muted">A suggestion needs the planner backend to work out travel times; saying which spots work does not.</p>
      <AppButton block variant="secondary" :disabled="!spotsOpen || !!running" @click="suggestSpot(false)">A friend suggests a spot</AppButton>
      <AppButton block variant="secondary" :disabled="!spotsOpen || !!running" @click="suggestSpot(true)">A friend suggests a spot they are at</AppButton>
      <AppButton block variant="secondary" :disabled="!spotsOpen || !!running" @click="approveSpots">Friends say which spots work</AppButton>
      <AppButton block variant="secondary" :disabled="!spotsOpen || !anyApprovals || !!running" @click="clearSpotApprovals">Clear the approvals</AppButton>
    </section>

    <section class="demo-group">
      <h3 class="title-md">Change a friend's location</h3>
      <SelectField v-model="change.personId" label="Friend" :options="friendOptions" :disabled="!friendOptions.length" />
      <div class="chip-row" role="radiogroup" aria-label="Which location">
        <ChipButton radio :selected="change.which === 'start'" @click="change.which = 'start'">Start</ChipButton>
        <ChipButton radio :selected="change.which === 'end'" @click="change.which = 'end'">End</ChipButton>
      </div>
      <SelectField v-model="change.areaId" label="New area" :options="areaOptions" />
      <AppButton block variant="secondary" :disabled="!session || !live || !change.personId" @click="applyChange">Change location</AppButton>
    </section>

    <section class="demo-group">
      <h3 class="title-md">One friend opts out</h3>
      <SelectField v-model="optOutId" label="Friend" :options="friendOptions" :disabled="!friendOptions.length" />
      <AppButton block variant="secondary" :disabled="!session || !live || !optOutId" @click="optOut">Opt out</AppButton>
    </section>

    <section class="demo-group">
      <h3 class="title-md">Leaderboard</h3>
      <AppButton block variant="secondary" :disabled="!!running" @click="endSeason">
        {{ running === 'season' ? 'Ending the season' : 'End the season now' }}
      </AppButton>
    </section>

    <section class="demo-group">
      <h3 class="title-md">Conditions</h3>
      <ToggleSwitch :model-value="conditions.rain" label="Simulate rain" @update:model-value="setCondition('rain', $event)" />
      <p v-if="conditions.rain && lastWeather?.simulationIgnored" class="body-sm text-muted" role="status">This server ignores simulated rain. Set ALLOW_SIMULATED_WEATHER=1 in backend/.env.</p>
      <ToggleSwitch :model-value="!conditions.routing" label="Routing unavailable" @update:model-value="setCondition('routing', !$event)" />
      <ToggleSwitch :model-value="conditions.sessionDay" label="It is the session day" @update:model-value="setCondition('sessionDay', $event)" />
    </section>

    <section class="demo-group">
      <h3 class="title-md">Account</h3>
      <p class="body-sm text-muted">Reset demo data keeps your account and clears meetups. Start over also replaces the account with a new demo account that starts with sample history: 10 meetups and 1,000 JioCoins.</p>
      <AppButton block variant="secondary" :disabled="!!running" @click="startOver">Start over with a new account</AppButton>
    </section>

    <template #footer>
      <AppButton block variant="danger" :disabled="!!running" @click="reset">Reset demo data</AppButton>
    </template>
  </BottomSheet>

  <ModalDialog
    v-model:open="askShowcase"
    title="Replace your sessions?"
    text="Your sessions are replaced with ten sample ones, and your JioCoins, rewards and demo switches go back to how a new demo account starts. Your account and friends stay. It takes about ten seconds."
  >
    <AppButton block variant="secondary" @click="askShowcase = false">Not yet</AppButton>
    <AppButton block @click="loadShowcaseData">Load showcase data</AppButton>
  </ModalDialog>
</template>

<style scoped>
.demo-note { padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--rounded-sm); background: var(--surface-soft); color: var(--ink); }
.demo-fab {
  position: fixed;
  right: var(--spacing-base);
  bottom: calc(var(--tabbar-height) + var(--spacing-base));
  z-index: 25;
  display: inline-flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-height: var(--tap-min);
  padding: 0 var(--spacing-base);
  border: 0;
  border-radius: var(--rounded-full);
  background: var(--ink);
  box-shadow: var(--shadow-float);
  color: var(--on-dark);
  font: var(--text-button-sm);
}
/* From tablet up the screen's main action sits bottom-right, so the demo button moves out of its way. */
@media (min-width: 744px) { .demo-fab { right: auto; left: var(--spacing-base); } }
@media (hover: hover) { .demo-fab:hover { background: var(--body); } }
.demo-target { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-md); border-radius: var(--rounded-md); background: var(--surface-soft); }
.demo-group { display: flex; flex-direction: column; gap: var(--spacing-sm); padding-top: var(--spacing-base); border-top: 1px solid var(--hairline); }
</style>
