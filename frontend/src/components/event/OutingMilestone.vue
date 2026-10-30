<script setup>
// One quiet line on a finished outing when it was a milestone with a friend: the 1st, 5th, 10th, then every 10th outing together
// ("That's your 5th outing with Faith."). Nothing is drawn when nobody is at one, when the outing did not happen (cancelled, or
// closed with no plan), or until the list of sessions has been read (the page does that), because the number is counted from it. It stores nothing: the
// number comes from the finished outings (lib/hangouts.js outingMilestones). Say it aloud (polite status) only when it appears as
// the result of the person's own action, with `announce`; otherwise it is just text, so a page that opens on it does not speak.
//   <OutingMilestone :session="session" announce />
import { computed, onMounted } from 'vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import { milestoneText, outingMilestones } from '@/lib/hangouts.js'
import { visibleSessions } from '@/lib/sessionFilter.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'
import { useGroupsStore } from '@/stores/groups.js'

const props = defineProps({
  session: { type: Object, required: true },
  announce: { type: Boolean, default: false },
})

const auth = useAuthStore()
const events = useEventsStore()
const groups = useGroupsStore()

// The friends' names come from the people the account knows; a failed read leaves them as "Someone".
onMounted(() => groups.loadPeople().catch(() => null))

const text = computed(() => (events.loaded ? milestoneText(outingMilestones(visibleSessions(events.sessions), auth.myId, props.session), groups.nameOf) : ''))
</script>

<template>
  <BannerNote v-if="text" icon="sparkle" :quiet="!announce" data-testid="outing-milestone">{{ text }}</BannerNote>
</template>
