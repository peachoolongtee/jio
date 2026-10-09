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
import SelectField from '../ui/SelectField.vue'
import StatusPill from '../ui/StatusPill.vue'
import ToggleSwitch from '../ui/ToggleSwitch.vue'
import * as api from '@/lib/api.js'
import { FRIEND_PICKS, HOST_ID, PEOPLE } from '@/lib/mock/people.js'
import { AREAS } from '@/lib/mock/places.js'
import { useEventsStore } from '@/stores/events.js'
import { usePlannerStore } from '@/stores/planner.js'

const SPAN = 3000
// Which option each friend votes for, by rank, so one place usually leads.
const PATTERN = [0, 1, 0, 2, 0]

const route = useRoute()
const router = useRouter()
const events = useEventsStore()
const planner = usePlannerStore()

const open = ref(false)
const running = ref('')
const note = ref('')
const change = ref({ personId: 'jonathan', which: 'start', areaId: 'orchard' })
const optOutId = ref('jonathan')

const session = computed(() => {
  const id = route.params.id
  return (id && events.byId[id]) || events.current
})
const friendsIn = computed(() => (session.value ? session.value.activeIds.filter((id) => id !== HOST_ID) : []))
const friendOptions = computed(() => friendsIn.value.map((id) => ({ value: id, label: PEOPLE.find((p) => p.id === id).name })))
const areaOptions = [...AREAS].sort((a, b) => a.name.localeCompare(b.name)).map((a) => ({ value: a.id, label: a.name }))
const status = computed(() => session.value?.status)
const live = computed(() => ['locating', 'voting', 'confirmed'].includes(status.value))
// Why the friend buttons may be off, or what still has to happen, so a click never seems to do nothing.
const hostLocated = computed(() => !!session.value?.locations?.[HOST_ID]?.start)
const friendsHint = computed(() => {
  if (status.value === 'inviting') return friendsIn.value.length ? 'Tap Start session on the session page first. Friends share their locations after that.' : 'Invite at least one friend and start the session first.'
  if (status.value === 'locating' && !hostLocated.value) return 'The meeting point appears once everyone, you included, has shared where they start. Set your From location on the session page.'
  return ''
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
const nameOf = (id) => PEOPLE.find((p) => p.id === id)?.name

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

const simulateLocations = () => act('locations', async () => {
  const s = session.value
  const waiting = friendsIn.value.filter((id) => !s.locations?.[id]?.start)
  note.value = waiting.length ? '' : 'Every friend already has a start location.'
  await spread(
    waiting.map((id) => () => api.setLocation(s.id, id, 'start', { areaId: PEOPLE.find((p) => p.id === id).homeAreaId })),
    SPAN,
  )
  if (waiting.length && !hostLocated.value) note.value = "Friends' locations are in. Set your own From location to find the meeting point."
})

const simulateVoting = () => act('voting', async () => {
  const id = session.value.id
  // First each friend picks categories and how long they can stay, then they vote.
  const fresh = await api.getSession(id)
  const needPicks = friendsIn.value.filter((f) => !fresh.prefs[f]?.categories?.length)
  await spread(needPicks.map((f) => () => api.setPreferences(id, f, FRIEND_PICKS[f])), SPAN * 0.3)
  const plan = await api.getPlan(id)
  const jobs = []
  friendsIn.value.forEach((f, i) => {
    plan.slots.forEach((slot, s) => {
      if (!slot.options.length) return
      const pick = slot.options[PATTERN[(i + s) % PATTERN.length] % slot.options.length]
      jobs.push(() => api.vote(id, slot.id, f, pick.id).catch(() => {}))
    })
  })
  await spread(jobs, SPAN * 0.6)
  if (!plan.slots.length) note.value = 'Friends picked categories. No slots yet.'
})

// Friends post photos from the day. Placeholder photography from picsum.photos, a mix of shapes.
const SHAPES = [[800, 1000], [800, 600], [800, 800], [800, 1100], [800, 560]]
const simulatePhotos = () => act('photos', async () => {
  const s = session.value
  const jobs = friendsIn.value.slice(0, 5).map((f, i) => () => {
    const [w, h] = SHAPES[(i + (s.photos?.length || 0)) % SHAPES.length]
    return api.addPhoto(s.id, f, `https://picsum.photos/seed/jio-${s.id}-${f}-${s.photos?.length || 0}/${w}/${h}`)
  })
  await spread(jobs, SPAN)
})

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

    <section class="demo-group">
      <h3 class="title-md">Friends</h3>
      <p v-if="friendsHint" class="body-sm text-muted">{{ friendsHint }}</p>
      <AppButton block variant="secondary" :disabled="!session || !live || !!running" @click="simulateLocations">
        {{ running === 'locations' ? 'Submitting locations' : 'Simulate friends submitting locations' }}
      </AppButton>
      <AppButton block variant="secondary" :disabled="!session || status !== 'voting' || !!running" @click="simulateVoting">
        {{ running === 'voting' ? 'Voting' : 'Simulate friends voting' }}
      </AppButton>
      <AppButton block variant="secondary" :disabled="!session || !['confirmed', 'completed'].includes(status) || !!running" @click="simulatePhotos">
        {{ running === 'photos' ? 'Posting photos' : 'Simulate friends posting photos' }}
      </AppButton>
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
      <ToggleSwitch :model-value="conditions.crowd" label="Simulate crowd" @update:model-value="setCondition('crowd', $event)" />
      <ToggleSwitch :model-value="!conditions.routing" label="Routing unavailable" @update:model-value="setCondition('routing', !$event)" />
      <ToggleSwitch :model-value="conditions.sessionDay" label="It is the session day" @update:model-value="setCondition('sessionDay', $event)" />
    </section>


    <template #footer>
      <AppButton block variant="danger" @click="reset">Reset demo data</AppButton>
    </template>
  </BottomSheet>
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
