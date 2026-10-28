<script setup>
// One meeting spot in the list: its name and who put it forward, the longest trip, the average and each person's
// minutes, a "Works for me" toggle with the people who chose it, and, on your own suggestion, "We are here already" and
// Withdraw. The name is a real button that selects the spot (and its pin on the map).
//   <SpotRow :spot="spot" :number="1" :selected="true" :mine="false" :names="nameOf" my-id="ian" can-approve fairest
//            @select="pick" @approve="(on) => ..." />
// spot: one entry of session.spots.list. number: its place in the list, drawn on its pin too. mine: you said it works
// for you. own: your suggestion of this area ({ here }), or null. fairest / leading: tags. canApprove: false once the group
// has moved on. busy: a change is being saved; the controls say so (aria-busy) but stay enabled, so a key press never drops
// the focus, and the list ignores a second press until the first is saved.
// readonly: the group has moved on from choosing, so the row has no controls (no "Works for me", "We are here already" or
// Withdraw); who said it works for them stays, as words. confirmed: this is the spot the host confirmed; it says
// "Confirmed" in place of the Leading or Fairest tag.
// Emits select, approve (true or false: the new state), here (true or false), withdraw.
// Only areas are shown, never a member's exact place. Times say "about" when they are estimates.
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import ChipButton from '../ui/ChipButton.vue'
import InfoTag from '../ui/InfoTag.vue'
import { ABOUT_NOTE, byLine, peopleTrips, tripsLine, worksForText } from './spotText.js'

const props = defineProps({
  spot: { type: Object, required: true },
  number: { type: Number, required: true },
  selected: { type: Boolean, default: false },
  mine: { type: Boolean, default: false },
  own: { type: Object, default: null },
  fairest: { type: Boolean, default: false },
  leading: { type: Boolean, default: false },
  readonly: { type: Boolean, default: false },
  confirmed: { type: Boolean, default: false },
  canApprove: { type: Boolean, default: true },
  busy: { type: Boolean, default: false },
  names: { type: Function, default: (id) => id },
  myId: { type: String, default: '' },
})
const emit = defineEmits(['select', 'approve', 'here', 'withdraw'])
</script>

<template>
  <li class="spot" :class="{ 'is-selected': selected }" :data-area="spot.areaId">
    <button type="button" class="spot__head" :aria-pressed="selected" @click="emit('select')">
      <span class="spot__num tnum" aria-hidden="true">{{ number }}</span>
      <span class="spot__text">
        <span class="spot__name title-md">{{ spot.area.name }}</span>
        <span class="spot__by caption-sm text-muted">{{ byLine(spot, myId) }}</span>
      </span>
      <InfoTag v-if="confirmed" tone="strong" class="spot__tag">Confirmed</InfoTag>
      <InfoTag v-else-if="leading" tone="strong" class="spot__tag">Leading</InfoTag>
      <InfoTag v-else-if="fairest" tone="strong" class="spot__tag">Fairest</InfoTag>
    </button>

    <p v-if="spot.here" class="spot__here caption"><AppIcon name="pin" :size="14" />We are here already</p>

    <div v-if="tripsLine(spot)" class="spot__trips" :title="spot.approximate ? ABOUT_NOTE : undefined">
      <p class="body-sm spot__line tnum">{{ tripsLine(spot) }}</p>
      <ul v-if="peopleTrips(spot, names, myId).length" class="spot__people" aria-label="Each person's trip">
        <li v-for="trip in peopleTrips(spot, names, myId)" :key="trip.id" class="spot__trip">
          <span class="spot__who caption-sm truncate">{{ trip.name }}</span>
          <span class="spot__min caption tnum" :class="`is-${trip.tone}`">{{ trip.text }}</span>
        </li>
      </ul>
    </div>
    <p v-else class="body-sm text-muted">No trips to compare yet. They appear as people share where they start.</p>

    <div v-if="!readonly" class="spot__choose">
      <ChipButton check :selected="mine" :disabled="!canApprove" :aria-busy="busy ? 'true' : undefined" :aria-label="`Works for me: ${spot.area.name}`" @click="emit('approve', !mine)">Works for me</ChipButton>
      <span class="spot__count">
        <AvatarStack v-if="spot.approvedBy.length" :people="spot.approvedBy" :size="24" :max="4" />
        <span class="body-sm" :class="{ 'text-muted': !spot.approvalCount }">{{ worksForText(spot) }}</span>
      </span>
    </div>

    <div v-else-if="spot.approvalCount" class="spot__choose">
      <span class="spot__count">
        <AvatarStack :people="spot.approvedBy" :size="24" :max="4" />
        <span class="body-sm">{{ worksForText(spot) }}</span>
      </span>
    </div>

    <div v-if="own && !readonly" class="spot__own">
      <ChipButton check :selected="own.here" :aria-busy="busy ? 'true' : undefined" :aria-label="`We are here already: ${spot.area.name}`" @click="emit('here', !own.here)">We are here already</ChipButton>
      <AppButton variant="tertiary" :aria-busy="busy ? 'true' : undefined" @click="emit('withdraw')">Withdraw<span class="sr-only"> my suggestion of {{ spot.area.name }}</span></AppButton>
    </div>
  </li>
</template>

<style scoped>
/* A flat card with a hairline. The selected spot has a 2px ink outline (the padding gives back the pixel so nothing moves). */
.spot { display: flex; flex-direction: column; gap: var(--spacing-sm); min-width: 0; padding: var(--spacing-md) var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.spot.is-selected { padding: 11px calc(var(--spacing-base) - 1px); border: 2px solid var(--ink); background: var(--surface-soft); }
.spot__head { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; min-height: var(--tap-min); margin: 0; padding: 0; border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.spot__head:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* The number on the row is the number on its pin. Ink when selected, so the pair differs by more than colour. */
.spot__num { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); font: var(--text-badge); font-weight: 700; }
.spot.is-selected .spot__num { background: var(--selected); color: var(--on-selected); }
.spot__text { display: flex; flex: 1 1 0; flex-direction: column; gap: 2px; min-width: 0; }
.spot__name { overflow-wrap: anywhere; }
.spot__by { overflow-wrap: anywhere; }
.spot__tag { align-self: flex-start; margin-top: var(--spacing-xs); }
.spot__here { display: flex; align-items: center; gap: var(--spacing-xs); margin: 0; color: var(--ink); }
.spot__trips { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.spot__line { margin: 0; }
.spot__people { display: flex; flex-wrap: wrap; gap: var(--spacing-xs) var(--spacing-base); margin: 0; padding: 0; list-style: none; }
.spot__trip { display: inline-flex; align-items: baseline; gap: var(--spacing-xs); max-width: 100%; min-width: 0; }
.spot__who { max-width: 14ch; color: var(--muted); }
.spot__min { font-weight: 600; white-space: nowrap; }
.spot__min.is-short { color: var(--travel-short); }
.spot__min.is-medium { color: var(--travel-medium-text); }
.spot__min.is-long { color: var(--travel-long); }
.spot__choose, .spot__own { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-md); }
.spot__count { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); min-width: 0; }
</style>
