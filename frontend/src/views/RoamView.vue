<script setup>
// "What next?": things to do near where the group is, for a plan that is under way (components/event/RoamPanel.vue: the list,
// the map, the tick to propose a place and the cross to take it back). This page is the panel under the session's header, with
// the way on at the bottom: "Itinerary", where the host adds what was proposed to the plan. The page keeps the Itinerary step
// lit and its back arrow goes to the itinerary too. A plan with no stops yet (a light meetup from Home) shows the same panel on
// its itinerary, so a person there never needs this page.
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import RoamPanel from '@/components/event/RoamPanel.vue'
import NotFoundView from './NotFoundView.vue'
import * as api from '@/lib/api.js'
import { closedText } from '@/lib/roam.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

const events = useEventsStore()

const missing = ref(false)
const loadError = ref('')

const session = computed(() => events.byId[props.id])
const closed = computed(() => closedText(session.value))

async function start() {
  missing.value = false
  loadError.value = ''
  try {
    await events.loadSession(props.id)
  } catch (e) {
    // "Not found" only for a session that is not there (or not this person's): any other failure (no network, a slow server) is a
    // reason to try again, not a reason to say the page does not exist.
    if (e?.code === 'not_found') missing.value = true
    else loadError.value = e?.message || 'Could not load this outing.'
  }
}

// A shared session's plan and proposals arrive live while this page is open, so a place put forward elsewhere shows as proposed here
// (a no-op for the demo and local accounts).
let stopWatching = () => {}
onMounted(() => {
  stopWatching = api.watchSessions()
  start()
})
onBeforeUnmount(() => stopWatching())
watch(() => props.id, start)
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="roam-view">
    <SessionHeader :session="session" title="What next?" />

    <div class="screen__body">
      <SessionNotices :session="session" />
      <RoamPanel :session="session" />
    </div>

    <!-- The way on from proposing: the itinerary, where the proposals wait for the host. -->
    <footer v-if="!closed" class="screen__footer">
      <AppButton next block :to="`/sessions/${id}/itinerary`" data-testid="roam-next">Itinerary</AppButton>
    </footer>
  </main>
  <!-- The session has not been read: a skeleton while it is asked for, and a failure with Retry when it could not be (not "not found": that is only for a session that is not there). -->
  <main v-else class="screen" :aria-busy="loadError ? undefined : 'true'" data-testid="roam-session-pending">
    <div class="screen__body" style="padding-top: var(--spacing-xl)">
      <EmptyState v-if="loadError" title="Could not load this outing" :text="loadError" role="alert" data-testid="roam-session-failed">
        <AppButton variant="secondary" @click="start">Retry</AppButton>
      </EmptyState>
      <template v-else>
        <SkeletonRow v-for="n in 4" :key="n" avatar />
      </template>
    </div>
  </main>
</template>
