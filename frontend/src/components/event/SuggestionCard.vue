<script setup>
// One suggested place in a slot, with its vote.
//   <SuggestionCard :option="option" :stop="{ start: 900, duration: 60 }" :group-size="3" me="ian" leading mine :outing="['faith']" :friends="['nicole']" @vote="vote" @swap="swap" @open="showReviews" />
// A photo of the kind of place with its category icon, the name, walking time, price tier,
// up to three tags (the planner's reasons, and when the place is open at `stop`), one sample review, a rain warning with an
// indoor swap, and who voted. The walking time is not labelled here: the page says once where walks are measured from.
// The name is a button inside its heading and its press area covers the photo too, so the photo and the name both open the
// place (`open`, with the option and 'name'); one control, so a screen reader meets the place once.
// The review line is its own button, apart from the vote and the swap, and opens the place's reviews (`open`, with 'review'). It quotes
// the start of a review by someone in the outing (`outing`, ids), else by a friend (`friends`, ids), with a "Sample" tag;
// with neither it says how many sample reviews there are. It stays on the card whatever the card's state.
// Colour coding: a stripe in the category colour. `leading` outlines the card in ink
// and tags it "Leading"; `behind` (another place leads) mutes the vote count. `closed` makes the vote read-only.
// Roam ("What next?") uses the same card without votes: `meta` replaces the walking line ("about 4 min away · 250 m") and
// the `foot` slot replaces the vote row (a tag and a "Propose" button).
//   <SuggestionCard :option="place" meta="about 4 min away · 250 m"><template #foot>...</template></SuggestionCard>
import { computed } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import ChipButton from '../ui/ChipButton.vue'
import InfoTag from '../ui/InfoTag.vue'
import PriceTier from '../ui/PriceTier.vue'
import RatingBadge from '../ui/RatingBadge.vue'
import UserAvatar from '../ui/UserAvatar.vue'
import { distanceText } from '@/lib/planner/format.js'
import { placeImage } from '@/lib/placeImages.js'
import { cardLine, reviewLabel } from '@/lib/reviewPick.js'
import { cardTags, hoursNote, votersText } from '@/lib/cardText.js'

const props = defineProps({
  option: { type: Object, required: true },
  leading: { type: Boolean, default: false },
  behind: { type: Boolean, default: false },
  mine: { type: Boolean, default: false },
  closed: { type: Boolean, default: false },
  selected: { type: Boolean, default: false },
  meta: { type: String, default: '' },
  // Ids of the other people in the outing, and of the signed-in person's friends: who the review line may quote.
  outing: { type: Array, default: () => [] },
  friends: { type: Array, default: () => [] },
  // When this stop would happen, { start (minutes after midnight), duration (minutes) }, for the opening-hours tag. Without it, no hours tag.
  stop: { type: Object, default: null },
  // How many people are active in the session, and the signed-in person's id. Up to four people get names under the card
  // ("You and Darius voted"); without a group size, or with more people, the card shows the count.
  groupSize: { type: Number, default: 0 },
  me: { type: String, default: '' },
})
defineEmits(['vote', 'swap', 'open'])

// The tags: the planner's reasons (not "Short walk", which the line above says, and not "Quiet at 15:00", which nothing
// measures) and, when the place lists hours, whether it is open at the stop.
const tags = computed(() => cardTags(props.option.reasons, hoursNote(props.option.venue.hours, props.stop?.start, props.stop?.duration)))
const votedText = computed(() => votersText({ voters: props.option.voters, votes: props.option.votes, groupSize: props.groupSize, me: props.me }))
const openName = computed(() => `Open ${props.option.venue.name}`)

// The review line: how many sample reviews the place has and the one to quote, if there is one.
const line = computed(() => cardLine(props.option.venue, { outing: props.outing, friends: props.friends }))
const reviewName = computed(() => reviewLabel(props.option.venue.name, line.value))
</script>

<template>
  <article class="sugg" :class="[`sugg--${option.venue.category}`, { 'is-leading': leading, 'is-behind': behind, 'is-selected': selected }]" :aria-label="option.venue.name" :data-option="option.id">
    <div class="sugg__top">
      <span class="sugg__photo">
        <img :src="placeImage(option.venue)" alt="" loading="lazy" width="72" height="72" />
        <CategoryIcon class="sugg__cat" :category="option.venue.category" :size="28" />
      </span>
      <div class="sugg__title">
        <div class="sugg__name">
          <h4 class="title-md">
            <button type="button" class="sugg__open clamp-2" :data-open-for="option.id" :aria-label="openName" @click="$emit('open', option, 'name')">{{ option.venue.name }}</button>
          </h4>
          <!-- The place's score, as on Home's cards and in the detail. Left out when the source gives none. -->
          <RatingBadge v-if="option.venue.rating != null" :score="option.venue.rating" />
        </div>
        <p class="sugg__meta caption-sm text-muted">
          <span v-if="meta">{{ meta }}</span>
          <span v-else>about {{ option.walk }} min walk<template v-if="option.distanceM != null"> · {{ distanceText(option.distanceM) }}</template></span>
          <PriceTier :price="option.venue.price" />
        </p>
      </div>
    </div>

    <div class="sugg__tags">
      <InfoTag v-if="leading" tone="strong" icon="trophy">Leading</InfoTag>
      <InfoTag v-for="tag in tags" :key="tag.key" :tone="tag.tone" :icon="tag.icon">{{ tag.text }}</InfoTag>
      <InfoTag v-if="option.warnings.includes('rain')" tone="warning" icon="rain">Outdoor, rain expected</InfoTag>
    </div>
    <button type="button" class="sugg__review" :data-review-for="option.id" :aria-label="reviewName" @click="$emit('open', option, 'review')">
      <template v-if="line.review">
        <UserAvatar :name="line.review.name" :person="line.review.personId" :size="24" />
        <span class="sugg__who caption-sm">{{ line.review.name }}</span>
        <span class="sugg__quote caption-sm truncate">"{{ line.review.text }}"</span>
        <InfoTag>Sample</InfoTag>
      </template>
      <template v-else>
        <AppIcon name="comment" :size="16" />
        <span class="sugg__quote caption-sm truncate">{{ line.count }} sample {{ line.count === 1 ? 'review' : 'reviews' }}</span>
      </template>
    </button>
    <AppButton v-if="option.swap && !closed" variant="secondary" small class="sugg__swap" @click="$emit('swap', option)">
      <AppIcon name="swap" />
      Swap for {{ option.swap.name }}
    </AppButton>

    <div class="sugg__vote">
      <slot name="foot">
        <span class="sugg__count">
          <AvatarStack v-if="option.voters.length" :people="option.voters" :size="20" :max="4" />
          <span class="caption" :class="{ 'sugg__lead': leading }">{{ votedText }}</span>
        </span>
        <ChipButton v-if="!closed" radio check :selected="mine" :aria-label="`${mine ? 'Your vote' : 'Vote for'} ${option.venue.name}`" @click="$emit('vote', option)">
          {{ mine ? 'Voted' : 'Vote' }}
        </ChipButton>
      </slot>
    </div>
  </article>
</template>

<style scoped>
.sugg { display: flex; flex-direction: column; gap: var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); transition: box-shadow var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
/* A stripe on the left in the category colour, matching the place's pin on the map. */
.sugg--eat { --sugg-cat: var(--cat-eat-fg); }
.sugg--drink { --sugg-cat: var(--cat-drink-fg); }
.sugg--shop { --sugg-cat: var(--cat-shop-fg); }
.sugg--activity { --sugg-cat: var(--cat-activity-fg); }
.sugg { box-shadow: inset 4px 0 0 var(--sugg-cat, transparent); }
/* The leader is outlined in ink, 2px, like a selected date. */
.sugg.is-leading { border-color: var(--ink); box-shadow: inset 4px 0 0 var(--sugg-cat, transparent), inset 0 0 0 1px var(--ink); }
.sugg.is-selected { box-shadow: inset 4px 0 0 var(--sugg-cat, transparent), var(--shadow-float); }
.sugg.is-leading.is-selected { box-shadow: inset 4px 0 0 var(--sugg-cat, transparent), inset 0 0 0 1px var(--ink), var(--shadow-float); }
.sugg.is-behind .sugg__count .caption { color: var(--muted); }
.sugg__photo { position: relative; flex-shrink: 0; width: 72px; height: 72px; }
.sugg__photo img { display: block; width: 100%; height: 100%; object-fit: cover; border-radius: var(--rounded-sm); background: var(--surface-strong); }
.sugg__cat { position: absolute; right: -6px; bottom: -6px; box-shadow: 0 0 0 2px var(--canvas); border-radius: var(--rounded-full); }
.sugg__top { position: relative; display: flex; align-items: flex-start; gap: var(--spacing-md); }
.sugg__title { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xxs); }
/* The name on the left, the score at its top right. */
.sugg__name { display: flex; align-items: flex-start; justify-content: space-between; gap: var(--spacing-sm); }
.sugg__name h4 { min-width: 0; margin: 0; }
/* The name is a button that looks like text. Its ::after spreads over the photo and the name, so pressing either opens the place. */
.sugg__open { display: -webkit-box; max-width: 100%; margin: 0; padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.sugg__open::after { content: ''; position: absolute; inset: 0; border-radius: var(--rounded-sm); }
@media (hover: hover) { .sugg__open:hover { text-decoration: underline; } }
/* The ring goes round everything the press covers, not just the words. */
.sugg__open:focus-visible { outline: none; }
.sugg__open:focus-visible::after { outline: 2px solid var(--ink); outline-offset: 2px; }
.sugg__name :deep(.rating) { padding-top: 3px; }
.sugg__meta { display: flex; align-items: center; gap: var(--spacing-sm); }
.sugg__tags { display: flex; flex-wrap: wrap; gap: var(--spacing-xs); }
/* A long place name wraps inside the card instead of pushing the button past its edge. */
.sugg .sugg__swap.btn { align-self: flex-start; max-width: 100%; height: auto; min-height: var(--tap-min); padding-block: var(--spacing-xs); white-space: normal; text-align: left; }
.sugg__vote { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); margin: 0 calc(var(--spacing-xs) * -1) -6px 0; }
/* The review line is 44px to press but takes about a line of room: its padding is pulled into the gaps around it, so the row adds 32px. */
.sugg__review { display: flex; align-items: center; gap: var(--spacing-sm); min-height: var(--tap-min); margin: -12px calc(var(--spacing-sm) * -1); padding: 0 var(--spacing-sm); border: 0; border-radius: var(--rounded-sm); background: transparent; color: var(--ink); text-align: left; cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out); }
@media (hover: hover) { .sugg__review:hover { background: var(--surface-soft); } }
.sugg__review:active { background: var(--surface-strong); }
.sugg__who { flex: 0 1 auto; min-width: 0; max-width: 9em; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
.sugg__quote { flex: 1 1 0; color: var(--body); }
.sugg__review :deep(svg) { flex-shrink: 0; color: var(--muted); }
.sugg__lead { font-weight: 700; }
.sugg__count { display: inline-flex; align-items: center; gap: var(--spacing-sm); min-width: 0; }
</style>
