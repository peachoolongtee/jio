<script setup>
// Everyone in a session: name, their area and travel time (coloured by length: up to 30, 31 to 45, over 45 min),
// and their status as an icon
// (Joined, Location submitted, Voted, Opted out; the name is the icon's label). Others' locations are the area name only.
//   <MemberList :session="session" :names="nameOf" :voters="voterIds" />
import { computed } from 'vue'
import AppIcon from '../ui/AppIcon.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { submissionStatus } from '@/lib/session.js'
import { travelTone } from '@/lib/planner/travel.js'

const props = defineProps({
  session: { type: Object, required: true },
  names: { type: Function, required: true },
  voters: { type: Array, default: () => [] },
  // Hide area, travel time and the status icon, for example while inviting (nobody shares a location yet).
  compact: { type: Boolean, default: false },
})

const rows = computed(() =>
  props.session.members.map((member) => {
    const start = props.session.locations?.[member.id]?.start
    const minutes = props.session.meeting?.times?.[member.id]
    const status = submissionStatus(props.session, member.id, props.voters)
    const out = member.state === 'opted_out'
    const meta = props.compact || out ? '' : start?.name || 'No location yet'
    const travel = !props.compact && !out && start && minutes != null ? { minutes, tone: travelTone(minutes) } : null
    return { id: member.id, name: props.names(member.id), host: member.role === 'host', meta, travel, status, out }
  }),
)
// The status as an icon only; its name is the label for screen readers and the tooltip.
const ICON = { Joined: 'clock', 'Location submitted': 'pin', Voted: 'check', 'Opted out': 'close' }
const TONE = { Joined: 'wait', 'Location submitted': 'done', Voted: 'done', 'Opted out': 'out' }
</script>

<template>
  <ul class="members" aria-label="People">
    <li v-for="(row, i) in rows" :key="row.id" class="member rise" :class="{ 'is-out': row.out }" :style="{ '--i': i }">
      <UserAvatar :name="row.name" :person="row.id" :size="36" />
      <RouterLink :to="row.id === 'ian' ? '/profile' : `/people/${row.id}`" class="member__text">
        <span class="title-sm truncate">{{ row.name }}<span v-if="row.host" class="caption-sm text-muted"> (host)</span></span>
        <span v-if="row.meta" class="caption-sm text-muted truncate">{{ row.meta }}<template v-if="row.travel"> · <span class="member__min" :class="`is-${row.travel.tone}`">{{ row.travel.minutes }} min</span></template></span>
      </RouterLink>
      <span v-if="!compact" class="member__status" :class="`is-${TONE[row.status]}`" role="img" :aria-label="row.status" :title="row.status">
        <AppIcon :name="ICON[row.status]" :size="14" />
      </span>
    </li>
  </ul>
</template>

<style scoped>
.members { display: flex; flex-direction: column; }
.member { display: flex; align-items: center; gap: var(--spacing-md); min-height: 60px; }
.member + .member { border-top: 1px solid var(--hairline-soft); }
.member__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; min-height: var(--tap-min); justify-content: center; color: var(--ink); text-decoration: none; }
@media (hover: hover) { .member__text:hover .title-sm { text-decoration: underline; } }
.member__status { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 30px; height: 30px; border-radius: var(--rounded-full); }
.member__status.is-wait { background: var(--surface-strong); color: var(--muted); }
.member__status.is-done { background: var(--primary); color: var(--on-primary); }
.member__status.is-out { border: 1px solid var(--primary-error-text); background: var(--canvas); color: var(--primary-error-text); }
.member.is-out .member__text { opacity: 0.6; }
.member__min { font-weight: 600; }
.member__min.is-short { color: var(--travel-short); }
.member__min.is-medium { color: var(--travel-medium); }
.member__min.is-long { color: var(--travel-long); }
</style>
