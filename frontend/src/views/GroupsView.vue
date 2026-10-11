<script setup>
// Sessions: every session Ian is in, upcoming and past.
import { computed, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SegmentTabs from '@/components/ui/SegmentTabs.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { visibleSessions } from '@/lib/sessionFilter.js'

const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()
const tab = ref('upcoming')

onMounted(() => Promise.all([events.loadSessions(), groups.loadPeople()]))

const isPast = (s) => ['completed', 'cancelled'].includes(s.status)
const list = computed(() => visibleSessions(events.sessions).filter((s) => (tab.value === 'past' ? isPast(s) : !isPast(s))))
const nameOf = (id) => (id === 'ian' ? auth.user?.name ?? '' : groups.nameOf(id))
</script>

<template>
  <main class="screen" data-testid="groups-view">
    <header class="screen__header">
      <div class="screen__bar">
        <h1 class="display-xl">Sessions</h1>
        <AppButton variant="pill" to="/sessions/new">
          <AppIcon name="plus" :size="14" />
          Create
        </AppButton>
      </div>
      <SegmentTabs v-model="tab" label="Sessions" :tabs="[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }]" />
    </header>
    <div class="screen__body">
      <div v-if="!events.loaded" class="stack">
        <SkeletonRow v-for="n in 3" :key="n" :lines="3" />
      </div>
      <EmptyState v-else-if="!list.length" illustration="invite" :title="tab === 'past' ? 'No past sessions' : 'No upcoming sessions'" >
        <AppButton v-if="tab === 'upcoming'" variant="secondary" to="/sessions/new">Create session</AppButton>
      </EmptyState>
      <ul v-else class="grid-3">
        <li v-for="session in list" :key="session.id"><SessionCard :session="session" :names="nameOf" /></li>
      </ul>
    </div>
  </main>
</template>
