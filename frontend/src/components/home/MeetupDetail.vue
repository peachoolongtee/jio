<script setup>
// The meetup selected on Home's map: a card under the map with its title, when, where it stands, who is in, what it
// needs next from you, and the one button that opens it at the step it is on (MeetupSummary).
//   <MeetupDetail :meetup="selected" my-id="ian" :names="nameOf" />
// When the selected meetup changes the content fades through (out, then in); under reduced motion it just swaps.
import MeetupSummary from './MeetupSummary.vue'

defineProps({
  meetup: { type: Object, required: true },
  myId: { type: String, required: true },
  // (id) => name, for the avatars.
  names: { type: Function, required: true },
})
</script>

<template>
  <section class="detail card" aria-labelledby="home-detail-title" data-testid="meetup-detail">
    <Transition name="detail" mode="out-in">
      <MeetupSummary :key="meetup.id" :meetup="meetup" :my-id="myId" :names="names" title-id="home-detail-title" />
    </Transition>
  </section>
</template>

<style scoped>
.detail { min-width: 0; gap: 0; }

/* Changing meetup: the old content fades out quickly, the new one fades and settles in. */
.detail-enter-active { transition: opacity var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.detail-leave-active { transition: opacity 120ms var(--ease-out); }
.detail-enter-from { opacity: 0; transform: translateY(6px); }
.detail-leave-to { opacity: 0; }
@media (prefers-reduced-motion: reduce) {
  .detail-enter-active, .detail-leave-active { transition: none; }
}
</style>
