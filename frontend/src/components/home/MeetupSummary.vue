<script setup>
// What Home says about one meetup: status, when, title, where it stands, who is in, what it needs next from you,
// and the button that opens it at the step it is on. The content of both MeetupDetail (the card under the map) and
// the popover on a map pin, so it is written once.
//   <MeetupSummary :meetup="m" my-id="ian" :names="nameOf" title-id="home-detail-title" />
//   <MeetupSummary :meetup="m" my-id="ian" :names="nameOf" compact />      the small one, for a popover
// compact: a smaller title (a paragraph, not a heading, cut with an ellipsis and carrying the whole title as its
// tooltip), the date on one line, the people and next step on one row, and a small button. The full-size title wraps,
// however long. titleId: the id of the title, for something that labels itself by it.
// Only areas are shown, never a member's exact place.
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import CountdownChip from '../ui/CountdownChip.vue'
import StatusPill from '../ui/StatusPill.vue'
import NextStepChip from './NextStepChip.vue'
import { nextStepFor, whereStands } from '@/lib/homeMeetups.js'
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
    <div class="sum__top">
      <StatusPill :status="meetup.status" />
      <CountdownChip :session="meetup" />
    </div>
    <component :is="compact ? 'p' : 'h2'" :id="titleId || undefined" class="sum__title" :class="compact ? 'title-md truncate' : 'display-sm'" :title="compact ? meetup.title : undefined">{{ meetup.title }}</component>
    <p class="body-sm text-muted tnum">{{ dateLine(meetup) }}</p>

    <p class="sum__where" :class="{ 'is-finding': where.kind === 'finding' }">
      <AppIcon v-if="where.kind === 'area' || where.kind === 'none'" name="pin" :size="16" />
      <span v-else class="meetup__pulse" aria-hidden="true" />
      <template v-if="where.kind === 'area'">
        <span class="sum__area title-md">{{ where.areaName }}</span>
        <span v-if="where.minutes" class="body-sm text-muted">about {{ where.minutes }} min for you</span>
      </template>
      <span v-else class="body-sm" :class="where.kind === 'none' ? 'text-muted' : 'sum__status'">{{ where.text }}</span>
    </p>

    <p class="sum__people body-sm">
      <AvatarStack v-if="friends.length" :people="friends" :size="24" :max="4" />
      <span class="text-muted">{{ peopleText }}</span>
    </p>

    <div class="sum__next">
      <span v-if="!compact" class="caption-sm text-muted">Next</span>
      <NextStepChip :step="step" />
    </div>
    <AppButton variant="secondary" block :small="compact" :to="step.to">Open meetup<span class="sr-only"> {{ meetup.title }}</span></AppButton>
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
.sum__next { display: flex; align-items: center; gap: var(--spacing-sm); margin: var(--spacing-sm) 0 var(--spacing-xs); padding-top: var(--spacing-md); border-top: 1px solid var(--hairline-soft); }
/* Compact: tighter, and the title sits on the status row's line. */
.sum--compact { gap: var(--spacing-xs); }
.sum--compact .sum__title { margin-top: var(--spacing-xxs); }
.sum--compact .sum__where { margin-top: 0; }
.sum--compact .sum__next { margin: var(--spacing-xs) 0; padding-top: var(--spacing-sm); }

/* The midpoint is still to come: a soft Rausch pulse, quicker while the planner is working it out. */
.meetup__pulse { position: relative; flex-shrink: 0; width: 10px; height: 10px; margin: 0 3px; border-radius: var(--rounded-full); background: var(--primary); }
.meetup__pulse::after { content: ""; position: absolute; inset: 0; border-radius: inherit; background: var(--primary-bright); animation: meetup-pulse 2s ease-out infinite; }
.is-finding .meetup__pulse::after { animation-duration: 0.9s; }
@keyframes meetup-pulse { from { transform: scale(1); opacity: 0.6; } to { transform: scale(3); opacity: 0; } }
@media (prefers-reduced-motion: reduce) { .meetup__pulse::after { animation: none; } }
</style>
