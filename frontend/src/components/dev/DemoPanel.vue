<script setup>
// Demo tools. Only in development builds (App.vue loads this file behind import.meta.env.DEV).
// Friends cannot act in a single-user build, so these buttons act for them through lib/api.js,
// the same way their own phones would.
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

async function simulateLocations() {
  const s = session.value
  const waiting = friendsIn.value.filter((id) => !s.locations?.[id]?.start)
  running.value = 'locations'
  note.value = waiting.length ? '' : 'Every friend already has a start location.'
  await spread(
    waiting.map((id) => () => api.setLocation(s.id, id, 'start', { areaId: PEOPLE.find((p) => p.id === id).homeAreaId })),
    SPAN,
  )
  running.value = ''
}

async function simulateVoting() {
  const id = session.value.id
  running.value = 'voting'
  note.value = ''
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
  running.value = ''
}

async function applyChange() {
  const { personId, which, areaId } = change.value
  await api.setLocation(session.value.id, personId, which, { areaId })
  note.value = `${nameOf(personId)}'s ${which} location is now ${AREAS.find((a) => a.id === areaId).name}.`
}

async function optOut() {
  await api.optOut(session.value.id, optOutId.value)
  note.value = `${nameOf(optOutId.value)} opted out.`
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

    <section class="demo-group">
      <h3 class="title-md">Friends</h3>
      <AppButton block variant="secondary" :disabled="!session || !live || !!running" @click="simulateLocations">
        {{ running === 'locations' ? 'Submitting locations' : 'Simulate friends submitting locations' }}
      </AppButton>
      <AppButton block variant="secondary" :disabled="!session || status !== 'voting' || !!running" @click="simulateVoting">
        {{ running === 'voting' ? 'Voting' : 'Simulate friends voting' }}
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
      <h3 class="title-md">Conditions</h3>
      <ToggleSwitch :model-value="conditions.rain" label="Simulate rain" @update:model-value="setCondition('rain', $event)" />
      <ToggleSwitch :model-value="conditions.crowd" label="Simulate crowd" @update:model-value="setCondition('crowd', $event)" />
      <ToggleSwitch :model-value="!conditions.routing" label="Routing unavailable" @update:model-value="setCondition('routing', !$event)" />
      <ToggleSwitch :model-value="conditions.sessionDay" label="It is the session day" @update:model-value="setCondition('sessionDay', $event)" />
    </section>

    <p v-if="note" class="body-sm" role="status">{{ note }}</p>

    <template #footer>
      <AppButton block variant="danger" @click="reset">Reset demo data</AppButton>
    </template>
  </BottomSheet>
</template>

<style scoped>
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
/* Desktop: in the sidebar, above the profile row, clear of every screen's actions. */
@media (min-width: 1128px) { .demo-fab { left: var(--spacing-base); right: auto; bottom: 96px; } }
@media (hover: hover) { .demo-fab:hover { background: var(--body); } }
.demo-target { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); padding: var(--spacing-md); border-radius: var(--rounded-md); background: var(--surface-soft); }
.demo-group { display: flex; flex-direction: column; gap: var(--spacing-sm); padding-top: var(--spacing-base); border-top: 1px solid var(--hairline); }
</style>
