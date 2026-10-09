<script setup>
// A session on Home, the Sessions list and a profile: title, status, date, people and where it stands.
//   <SessionCard :session="session" :names="nameOf" />
// The whole card is a link to the screen for the session's status.
import { computed } from 'vue'
import { RouterLink } from 'vue-router'
import AvatarStack from '../ui/AvatarStack.vue'
import AppIcon from '../ui/AppIcon.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import StatusPill from '../ui/StatusPill.vue'
import { dateLine, sessionPath } from '@/lib/session.js'
import { durationLabel } from '@/lib/planner/format.js'

const props = defineProps({
  session: { type: Object, required: true },
  // (id) => name, for the avatars.
  names: { type: Function, required: true },
})

const people = computed(() => props.session.activeIds.map((id) => props.names(id)).filter(Boolean))
const where = computed(() => {
  const s = props.session
  if (s.areaName) return s.areaName
  if (s.status === 'inviting' || s.status === 'cancelled') return ''
  return 'Meeting area pending'
})
</script>

<template>
  <RouterLink :to="sessionPath(session)" class="session-card">
    <div class="session-card__top">
      <h3 class="title-md clamp-2">{{ session.title }}</h3>
      <StatusPill :status="session.status" />
    </div>
    <p class="caption-sm text-muted">{{ dateLine(session) }}</p>
    <div class="session-card__meta">
      <AvatarStack :people="people" :size="24" />
      <span v-if="where" class="session-card__where caption-sm">
        <AppIcon name="pin" :size="12" />
        <span class="truncate">{{ where }}</span>
      </span>
    </div>
    <ul v-if="session.status === 'voting' && session.slots.length" class="session-card__slots">
      <li v-for="slot in session.slots" :key="slot.id" class="session-card__slot">
        <CategoryIcon :category="slot.category" :size="24" />
        <span class="caption-sm">{{ slot.time }} · {{ durationLabel(slot.duration) }}</span>
        <span class="caption-sm text-muted truncate">Pending decision · {{ slot.optionCount }} {{ slot.optionCount === 1 ? 'option' : 'options' }}</span>
      </li>
    </ul>
    <p v-if="session.status === 'confirmed' && session.plan" class="caption-sm text-brand">{{ session.plan.stops.length }} stops · {{ session.isToday ? "Today's plan" : 'Itinerary ready' }}</p>
  </RouterLink>
</template>

<style scoped>
.session-card { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); text-decoration: none; transition: border-color var(--motion-fast) ease, box-shadow var(--motion-fast) ease; }
.session-card__top { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-md); }
.session-card__meta { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); }
.session-card__where { display: inline-flex; align-items: center; gap: var(--spacing-xs); min-width: 0; color: var(--primary-active); }
.session-card__slots { display: flex; flex-direction: column; gap: var(--spacing-xs); padding-top: var(--spacing-xs); border-top: 1px solid var(--hairline-soft); }
.session-card__slot { display: grid; grid-template-columns: 24px auto minmax(0, 1fr); align-items: center; gap: var(--spacing-sm); }
@media (hover: hover) {
  .session-card:hover { border-color: var(--ink); box-shadow: var(--shadow-float); }
}
</style>
