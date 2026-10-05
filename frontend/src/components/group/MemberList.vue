<script setup>
// Everyone in a session with their submission status: Joined, Location submitted, Voted, Opted out.
// Other people's locations show as the area name and travel time only, never an exact address.
//   <MemberList :session="session" :names="nameOf" :voters="voterIds" />
import { computed } from 'vue'
import InfoTag from '../ui/InfoTag.vue'
import ListRow from '../ui/ListRow.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { STATUS_TONE, submissionStatus } from '@/lib/session.js'

const props = defineProps({
  session: { type: Object, required: true },
  names: { type: Function, required: true },
  voters: { type: Array, default: () => [] },
  // Hide area and travel time, for example while inviting.
  compact: { type: Boolean, default: false },
})

const rows = computed(() =>
  props.session.members.map((member) => {
    const loc = props.session.locations?.[member.id]
    const minutes = props.session.meeting?.times?.[member.id]
    const status = submissionStatus(props.session, member.id, props.voters)
    let meta = member.role === 'host' ? 'Host' : ''
    if (!props.compact && member.state === 'joined') {
      const where = loc?.start ? loc.start.name : 'No location yet'
      const time = loc?.start && minutes != null ? ` · ${minutes} min` : ''
      meta = [meta, `${where}${time}`].filter(Boolean).join(' · ')
    }
    return { id: member.id, name: props.names(member.id), meta, status, out: member.state === 'opted_out' }
  }),
)
</script>

<template>
  <ul class="members" aria-label="People">
    <ListRow
      v-for="row in rows"
      :key="row.id"
      as="li"
      :title="row.name"
      :meta="row.meta"
      :to="row.id === 'ian' ? '/profile' : `/people/${row.id}`"
      :class="{ 'is-out': row.out }"
    >
      <template #leading><UserAvatar :name="row.name" /></template>
      <template #trailing><InfoTag :tone="STATUS_TONE[row.status]">{{ row.status }}</InfoTag></template>
    </ListRow>
  </ul>
</template>

<style scoped>
.members .is-out { opacity: 0.6; }
</style>
