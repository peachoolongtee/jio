<script setup>
// What Home says about one meetup: when, title, where it stands, who is in, what it needs next from you,
// and the button that opens it at the step it is on. The content of both MeetupDetail (the card under the map) and
// the popover on a map pin, so it is written once.
//   <MeetupSummary :meetup="m" my-id="ian" :names="nameOf" title-id="home-detail-title" />
//   <MeetupSummary :meetup="m" my-id="ian" :names="nameOf" compact />      the small one, for a popover
// Order: where it stands (and whose turn), the title, the date with how soon it is, where, who, and Open meetup, a small round "next"
// pill on the right (Darius, 4 November 2026).
// compact: a smaller title (a paragraph, not a heading, cut with an ellipsis and carrying the whole title as its
// tooltip), and a smaller button. The full-size title wraps,
// however long. titleId: the id of the title, for something that labels itself by it.
// Only areas are shown, never a member's exact place.
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import CountdownChip from '../ui/CountdownChip.vue'
import MeetupStatus from './MeetupStatus.vue'
import { homeStatus, nextStepFor, whereStands } from '@/lib/homeMeetups.js'
import { dateLine } from '@/lib/session.js'

const props = defineProps({
  meetup: { type: Object, required: true },
  myId: { type: String, required: true },
  // (id) => name, for the avatars.
  names: { type: Function, required: true },
  compact: { type: Boolean, default: false },
  titleId: { type: String, default: '' },
})

const where = computed(() => whereStands(props.meetup, props.myId))
const step = computed(() => nextStepFor(props.meetup, props.myId))
// The stage and, when it is on the person, "Your turn · …" (MeetupStatus), as on Home's rows.
const status = computed(() => homeStatus(props.meetup, props.myId))
const friends = computed(() => (props.meetup.activeIds || []).filter((id) => id !== props.myId).map((id) => ({ id, name: props.names(id) })))
const invited = computed(() => (props.meetup.members || []).filter((m) => m.state === 'invited').length)
// "3 friends", "1 friend · 2 invited", "No friends yet"
const peopleText = computed(() => {
  const n = friends.value.length
  const joined = n ? `${n} ${n === 1 ? 'friend' : 'friends'}` : ''
  const waiting = invited.value ? `${invited.value} invited` : ''
  return [joined, waiting].filter(Boolean).join(' · ') || 'No friends yet'
})
</script>

<template>
  <div class="sum" :class="{ 'sum--compact': compact }">
    <!-- Where it stands and whose turn it is, first (Darius, 4 November 2026). Its stage is said once ("Ready", not also "Confirmed";
         walkthrough, 1 November 2026). -->
    <div class="sum__top">
      <MeetupStatus :status="status" />
    </div>
    <component :is="compact ? 'p' : 'h2'" :id="titleId || undefined" class="sum__title" :class="compact ? 'title-md truncate' : 'display-sm'" :title="compact ? meetup.title : undefined">{{ meetup.title }}</component>
    <!-- The date, and how soon it is on the same line. -->
    <p class="sum__when body-sm text-muted tnum"><span>{{ dateLine(meetup) }}</span><CountdownChip :session="meetup" /></p>

    <p class="sum__where" :class="{ 'is-finding': where.kind === 'finding' }">
      <AppIcon v-if="where.kind === 'area' || where.kind === 'spots' || where.kind === 'none'" name="pin" :size="16" />
      <span v-else class="meetup__pulse" aria-hidden="true" />
      <template v-if="where.areaName">
        <span class="sum__area title-md">{{ where.areaName }}</span>
        <span v-if="where.note" class="body-sm text-muted">{{ where.note }}</span>
      </template>
      <span v-else class="body-sm" :class="where.kind === 'none' ? 'text-muted' : 'sum__status'">{{ where.text }}</span>
    </p>

    <p class="sum__people body-sm">
      <AvatarStack v-if="friends.length" :people="friends" :size="24" :max="4" />
      <span class="text-muted">{{ peopleText }}</span>
    </p>

    <!-- Opens it at the step it is on: the round "next" pill with its arrow, as Next on the forms, on the right. -->
    <AppButton next class="sum__open" :to="step.to">Open meetup<span class="sr-only"> {{ meetup.title }}</span></AppButton>
  </div>
</template>

<style scoped>
.sum { display: flex; flex-direction: column; gap: var(--spacing-sm); min-width: 0; }
.sum__top { display: flex; align-items: center; gap: var(--spacing-sm); }
/* The card under the map wraps the whole title, so it is the place to read one that is cut elsewhere; the small card on a pin cuts it with an ellipsis and has the whole title as its tooltip. */
.sum__title { margin: var(--spacing-xs) 0 0; overflow-wrap: anywhere; }
.sum__title.truncate { overflow-wrap: normal; }
.sum__where { display: flex; align-items: center; flex-wrap: wrap; gap: var(--spacing-xs) var(--spacing-sm); margin: var(--spacing-xs) 0 0; }
.sum__area { min-width: 0; overflow-wrap: anywhere; }
.sum__status { color: var(--ink); font-weight: 600; }
.sum__people { display: flex; align-items: center; gap: var(--spacing-sm); margin: 0; }
.sum__when { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; }
/* Open meetup: smaller than the forms' Next, on the right. */
.sum__open { align-self: flex-end; height: 40px; min-width: 0; margin-top: var(--spacing-sm); padding: 0 var(--spacing-md) 0 var(--spacing-base); font: var(--text-button-sm); }
/* Compact: tighter, and the title sits on the status row's line. */
.sum--compact { gap: var(--spacing-xs); }
.sum--compact .sum__title { margin-top: var(--spacing-xxs); }
.sum--compact .sum__where { margin-top: 0; }
.sum--compact .sum__open { height: 36px; margin-top: var(--spacing-xs); }

/* The midpoint is still to come: a soft Rausch pulse, quicker while the planner is working it out. */
.meetup__pulse { position: relative; flex-shrink: 0; width: 10px; height: 10px; margin: 0 3px; border-radius: var(--rounded-full); background: var(--primary); }
.meetup__pulse::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--primary-bright); animation: meetup-pulse 2s ease-out infinite; }
.is-finding .meetup__pulse::after { animation-duration: 0.9s; }
@keyframes meetup-pulse { from { transform: scale(1); opacity: 0.6; } to { transform: scale(3); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .meetup__pulse::after { animation: none; } }
</style>
