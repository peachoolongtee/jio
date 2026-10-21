<script setup>
// Sessions: every session the signed-in person is in, upcoming and past. It has no create button of its own: the navigation
// has one at every width (the top bar from 744 px, the tab bar on phones), as on the profile page.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SegmentTabs from '@/components/ui/SegmentTabs.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import InvitationList from '@/components/event/InvitationList.vue'
import SessionCard from '@/components/event/SessionCard.vue'
import { watchSessions } from '@/lib/api.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'
import { visibleSessions } from '@/lib/sessionFilter.js'

const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()
const tab = ref('upcoming')

// Shared sessions change while this page is open: the list follows. Stops when the page is left.
let stopWatching = () => {}
onBeforeUnmount(() => stopWatching())
onMounted(() => {
  stopWatching = watchSessions()
  return Promise.all([events.loadSessions(), groups.loadPeople()])
})

const isPast = (s) => ['completed', 'cancelled'].includes(s.status)
const list = computed(() => visibleSessions(events.sessions).filter((s) => (tab.value === 'past' ? isPast(s) : !isPast(s))))
const nameOf = (id) => (id === auth.myId ? auth.user?.name ?? '' : groups.nameOf(id))
</script>

<template>
  <main class="screen" data-testid="groups-view">
    <header class="screen__header">
      <div class="screen__bar">
        <h1 class="display-xl">Sessions</h1>
      </div>
      <SegmentTabs v-model="tab" label="Sessions" :tabs="[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }]" />
    </header>
    <div class="screen__body">
      <InvitationList />
      <div v-if="!events.loaded" class="stack">
        <SkeletonRow v-for="n in 3" :key="n" :lines="3" />
      </div>
      <!-- The navigation's Create is the one create button: the empty state only says there are none. -->
      <EmptyState v-else-if="!list.length" illustration="invite" :title="tab === 'past' ? 'No past sessions' : 'No upcoming sessions'" />
      <ul v-else class="grid-3">
        <li v-for="session in list" :key="session.id"><SessionCard :session="session" :names="nameOf" /></li>
      </ul>
    </div>
  </main>
</template>
