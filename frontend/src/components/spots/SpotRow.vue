<script setup>
// One meeting spot in the list, kept short (walkthrough, 1 November 2026): its number, its name with the longest trip and the
// average beside it, then a "Vote" toggle with the people who chose it and "More details" at the end of that row. "More details"
// opens a dialog with who put the spot forward, "We are here already", and each person on a line of their own: their avatar, their
// name and their time to get there. On your own suggestion, "We are here already" and Withdraw. The whole card selects the spot (and
// its pin on the map) when pressed anywhere but on its own controls (Faith's walkthrough, 30 October 2026: the name alone was too
// small a target); the name stays a real button, for the keyboard and screen readers.
//   <SpotRow :spot="spot" :number="1" :selected="true" :mine="false" :names="nameOf" my-id="ian" can-approve fairest
//            @select="pick" @approve="(on) => ..." />
// spot: one entry of session.spots.list. number: its place in the list, drawn on its pin too. mine: you said it works
// for you. own: your suggestion of this area ({ here }), or null. fairest / leading: tags. canApprove: false once the group
// has moved on. busy: a change is being saved; the controls say so (aria-busy) but stay enabled, so a key press never drops
// the focus, and the list ignores a second press until the first is saved.
// readonly: the group has moved on from choosing, so the row has no controls (no "Vote", "We are here already" or
// Withdraw); who said it works for them stays, as words, and "More details" stays. confirmed: this is the spot the host
// confirmed; it says "Confirmed" in place of the Leading or Fairest tag.
// note: one quiet line for this row alone (the data layer's "Jio remembers", on the first spot), or ''. It is said with the person's own
// time to the spot before it ("You: about 9 min. This spot is closer to you."), so the claim stands with its evidence now that the times
// are behind "More details"; nothing is said about anyone else's.
// Emits select, approve (true or false: the new state), here (true or false), withdraw.
// Only areas are shown, never a member's exact place. Times say "about" when they are estimates.
import { computed, ref } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import ChipButton from '../ui/ChipButton.vue'
import InfoTag from '../ui/InfoTag.vue'
import ModalDialog from '../ui/ModalDialog.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { ABOUT_NOTE, byLine, peopleTrips, shortTripsLine, tripsLine, votesText } from './spotText.js'

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
  note: { type: String, default: '' },
})
const emit = defineEmits(['select', 'approve', 'here', 'withdraw'])

// The dialog with each person's trip.
const detailsOpen = ref(false)
const trips = computed(() => peopleTrips(props.spot, props.names, props.myId))
// The dialog's line under the title: who put it forward, and "We are here already" when they are.
const detailsText = computed(() => [byLine(props.spot, props.myId), props.spot.here && 'We are here already'].filter(Boolean).join(' · '))

// The signed-in person's own trip, as the start of the note: 'You: about 9 min.', or '' with no time for them. Only theirs.
// How to call: ownTrip.value -> 'You: about 9 min.'
const ownTrip = computed(() => {
  const mine = trips.value.find((trip) => trip.id === props.myId)
  return mine?.text ? `You: ${mine.text}.` : ''
})

// A press on the card selects it, unless it was on a control of its own (Vote, Withdraw, More details, the name's button handles itself).
// How to call: <li @click="pick">
function pick(event) {
  if (['button', 'a', 'input', 'label'].some((tag) => event.target.closest?.(tag))) return
  emit('select')
}
</script>

<template>
  <li class="spot" :class="{ 'is-selected': selected }" :data-area="spot.areaId" @click="pick">
    <div class="spot__top">
      <button type="button" class="spot__head" :aria-pressed="selected" @click="emit('select')">
        <span class="spot__num tnum" aria-hidden="true">{{ number }}</span>
        <span class="spot__text">
          <span class="spot__name title-md">{{ spot.area.name }}</span>
          <span v-if="tripsLine(spot)" class="spot__line body-sm tnum" :title="spot.approximate ? ABOUT_NOTE : undefined"><span class="sr-only">{{ tripsLine(spot) }}</span><span aria-hidden="true">{{ shortTripsLine(spot) }}</span></span>
        </span>
      </button>
      <InfoTag v-if="confirmed" tone="strong" class="spot__tag">Confirmed</InfoTag>
      <InfoTag v-else-if="leading" tone="strong" class="spot__tag">Leading</InfoTag>
      <InfoTag v-else-if="fairest" tone="strong" class="spot__tag">Fairest</InfoTag>
    </div>

    <p v-if="!tripsLine(spot)" class="body-sm text-muted">No trips to compare yet. They appear as people share where they start.</p>
    <p v-if="note" class="spot__note caption-sm text-muted" data-testid="spots-lean">{{ ownTrip ? `${ownTrip} ${note}` : note }}</p>

    <div class="spot__choose">
      <ChipButton v-if="!readonly" check :selected="mine" :disabled="!canApprove" :aria-busy="busy ? 'true' : undefined" :aria-label="`Vote for ${spot.area.name}`" @click="emit('approve', !mine)">Vote</ChipButton>
      <span v-if="!readonly || spot.approvalCount" class="spot__count">
        <AvatarStack v-if="spot.approvedBy.length" :people="spot.approvedBy" :size="24" :max="4" />
        <span class="body-sm" :class="{ 'text-muted': !spot.approvalCount }">{{ votesText(spot) }}</span>
      </span>
      <button type="button" class="spot__more caption" aria-haspopup="dialog" data-testid="spot-details" @click="detailsOpen = true">
        More details<span class="sr-only"> for {{ spot.area.name }}</span><AppIcon name="chevron-right" :size="16" />
      </button>
    </div>

    <div v-if="own && !readonly" class="spot__own">
      <ChipButton check :selected="own.here" :aria-busy="busy ? 'true' : undefined" :aria-label="`We are here already: ${spot.area.name}`" @click="emit('here', !own.here)">We are here already</ChipButton>
      <AppButton variant="tertiary" :aria-busy="busy ? 'true' : undefined" @click="emit('withdraw')">Withdraw<span class="sr-only"> my suggestion of {{ spot.area.name }}</span></AppButton>
    </div>

    <!-- Each person on a line of their own: avatar, name, and their time to get there. -->
    <ModalDialog v-model:open="detailsOpen" :title="spot.area.name" :text="detailsText">
      <template #content>
        <p v-if="tripsLine(spot)" class="body-sm tnum">{{ tripsLine(spot) }}</p>
        <ul v-if="trips.length" class="trip-list" aria-label="Each person's trip">
          <li v-for="trip in trips" :key="trip.id" class="trip-list__row">
            <UserAvatar :name="trip.name" :person="trip.id" :size="40" />
            <span class="trip-list__text">
              <span class="title-sm truncate">{{ trip.name }}</span>
              <span class="caption tnum trip-list__min" :class="`is-${trip.tone}`">{{ trip.text }}</span>
            </span>
          </li>
        </ul>
        <p v-else class="body-sm text-muted">No trips to compare yet. They appear as people share where they start.</p>
        <p v-if="spot.approximate" class="caption-sm text-muted">{{ ABOUT_NOTE }}</p>
      </template>
      <AppButton block variant="secondary" @click="detailsOpen = false">Close</AppButton>
    </ModalDialog>
  </li>
</template>

<style scoped>
/* A flat light grey card with the default grey edge, set apart from the white page (walkthrough, 1 November 2026). Hovered, a shade
   darker. The selected spot turns white with a 2px ink outline (the padding gives back the pixel so nothing moves). */
.spot { display: flex; flex-direction: column; gap: var(--spacing-sm); min-width: 0; padding: var(--spacing-md) var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--surface-strong); cursor: pointer; transition: border-color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .spot:not(.is-selected):hover { border-color: var(--border-strong); background: var(--hairline-soft); } }
.spot.is-selected { padding: 11px calc(var(--spacing-base) - 1px); border: 2px solid var(--ink); background: var(--canvas); }
.spot__top { display: flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
.spot__head { display: flex; flex: 1 1 0; align-items: center; gap: var(--spacing-md); min-width: 0; min-height: var(--tap-min); margin: 0; padding: 0; border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.spot__head:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* The number on the row is the number on its pin. Ink when selected, so the pair differs by more than colour. */
.spot__num { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 36px; height: 36px; border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font: var(--text-badge); font-weight: 700; }
.spot.is-selected .spot__num { background: var(--selected); color: var(--on-selected); }
/* The name and its times on one line; on a narrow phone the times wrap under the name. */
.spot__text { display: flex; flex: 1 1 0; flex-wrap: wrap; align-items: baseline; gap: 2px var(--spacing-sm); min-width: 0; }
.spot__name { overflow-wrap: anywhere; }
.spot__line { min-width: 0; color: var(--muted); overflow-wrap: anywhere; }
.spot__tag { flex-shrink: 0; }
.spot__note { margin: 0; }
.spot__choose, .spot__own { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-md); }
.spot__count { display: inline-flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); min-width: 0; }
/* "More details": a quiet text button at the far end of the vote row. */
.spot__more { display: inline-flex; align-items: center; gap: var(--spacing-xxs); min-height: var(--tap-min); margin: 0 0 0 auto; padding: 0; border: 0; background: transparent; color: var(--muted); font-weight: 600; cursor: pointer; }
@media (hover: hover) { .spot__more:hover { color: var(--ink); } }
.spot__more:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-sm); }

/* The dialog's list: one person per line, avatar, name in bold and their time under it, a hairline between rows. */
.trip-list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.trip-list__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 60px; border-bottom: 1px solid var(--hairline-soft); }
.trip-list__row:last-child { border-bottom: 0; }
.trip-list__text { display: flex; flex: 1; flex-direction: column; min-width: 0; }
.trip-list__min { font-weight: 600; }
.trip-list__min.is-short { color: var(--travel-short); }
.trip-list__min.is-medium { color: var(--travel-medium-text); }
.trip-list__min.is-long { color: var(--travel-long); }
</style>
