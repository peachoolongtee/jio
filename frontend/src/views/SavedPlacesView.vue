<script setup>
// Saved places: what the person kept from posts, or added themselves with "Add a place" (components/saved/AddPlaceSheet.vue). Each shows what the post said, its address too when the post gave one, with the link to Google
// Maps and a way to remove it. Nothing here asks Google, so opening the page costs nothing (Faith, 4 November 2026); Google's own address and
// rating may not be stored (Google's terms). The Vote page's search lists these places too. Chips filter by category, as on Rewards. The page is laid out like
// "Places from a post", which it opens from, on plain white (Faith, 4 November 2026). Only categories the list has get a chip.
// How to call: the route /places/saved (router/routes.js).
import { computed, onMounted, ref } from 'vue'
import { useRoute } from 'vue-router'
import AddPlaceSheet from '@/components/saved/AddPlaceSheet.vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import { listSavedPlaces, removeSavedPlace } from '@/lib/api.js'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { vRadioGroup } from '@/lib/radioGroup.js'
import { savedAddress, savedArea, savedMapsUrl } from '@/lib/savedPlaces.js'

// Back goes where the person came from: their profile, or the page that reads posts.
const route = useRoute()
const backTo = computed(() => (route.query.from === 'profile' ? '/profile' : '/places/from-post'))
const adding = ref(false)
const places = ref(null)
// The category chosen, or '' for all. Removing the last place of a category falls back to all.
const chosen = ref('')
const categories = computed(() => CATEGORIES.filter((c) => (places.value || []).some((p) => p.categories[0] === c)))
const filter = computed(() => (categories.value.includes(chosen.value) ? chosen.value : ''))
const shown = computed(() => (places.value || []).filter((p) => !filter.value || p.categories[0] === filter.value))
const failure = ref('')
// The place "Remove" is asking about, and how that went.
const removing = ref(null)
const removeBusy = ref(false)
const removeError = ref('')

// How to call: await load()
async function load() {
  failure.value = ''
  try {
    places.value = await listSavedPlaces()
  } catch (err) {
    failure.value = err.message
  }
}
onMounted(load)

// How to call: await remove()
async function remove() {
  removeBusy.value = true
  removeError.value = ''
  try {
    await removeSavedPlace(removing.value.id)
    places.value = places.value.filter((p) => p.id !== removing.value.id)
    removing.value = null
  } catch (err) {
    removeError.value = err.message
  } finally {
    removeBusy.value = false
  }
}
</script>

<template>
  <main class="screen screen--wide-form saved" data-testid="saved-places">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back" :to="backTo"><AppIcon name="back" /></IconButton>
        <AppButton variant="secondary" small data-testid="add-place-open" @click="adding = true"><AppIcon name="plus" :size="16" />Add a place</AppButton>
      </div>
      <div class="screen__titles">
        <h1 class="display-xl">Saved places</h1>
        <p class="body-sm text-muted">Places you've kept. Suggest them when your group is voting.</p>
      </div>
    </header>

    <div class="screen__body">
      <EmptyState v-if="failure" title="Could not load your saved places" :text="failure" role="alert">
        <AppButton variant="secondary" small @click="load">Try again</AppButton>
      </EmptyState>
      <div v-else-if="!places" class="stack gap-md" aria-hidden="true"><SkeletonRow v-for="n in 3" :key="n" avatar /></div>
      <EmptyState v-else-if="!places.length" title="No saved places yet" data-testid="saved-empty">
        <AppButton variant="secondary" small to="/places/from-post">Find places from a post</AppButton>
      </EmptyState>
      <section v-else class="section saved__panel" aria-label="Your saved places">
        <div class="scroll-x saved__filters" role="radiogroup" v-radio-group aria-label="Category">
          <ChipButton radio :selected="!filter" data-testid="saved-filter" @click="chosen = ''">All</ChipButton>
          <ChipButton v-for="c in categories" :key="c" radio :selected="filter === c" data-testid="saved-filter" @click="chosen = c">{{ CATEGORY_LABELS[c] }}</ChipButton>
        </div>
        <ul class="saved__list" data-testid="saved-list">
        <li v-for="place in shown" :key="place.id" class="card saved__place" data-testid="saved-place">
          <div class="saved__head">
            <CategoryIcon :category="place.categories[0]" :size="40" />
            <div class="saved__names">
              <h2 class="title-md">{{ place.nameEnglish || place.name }}</h2>
              <p class="caption-sm text-muted">{{ CATEGORY_LABELS[place.categories[0]] }}<template v-if="savedArea(place)"> · {{ savedArea(place) }}</template></p>
            </div>
          </div>
          <p v-if="place.tip" class="body-sm">{{ place.tip }}</p>

          <p v-if="savedAddress(place)" class="row gap-xs body-sm saved__address" data-testid="saved-address"><AppIcon name="pin" :size="16" /><span>{{ savedAddress(place) }}</span></p>

          <!-- At the bottom of every card, so they line up however long the words above them are. -->
          <div class="saved__actions">
            <AppButton class="saved__maps" variant="secondary" small :href="savedMapsUrl(place)" target="_blank">Open in Google Maps <span class="sr-only">for {{ place.nameEnglish || place.name }}, opens in a new tab</span><AppIcon name="external" :size="16" /></AppButton>
            <div class="saved__links">
              <AppButton variant="tertiary" underline small data-testid="saved-remove" :aria-label="`Remove ${place.nameEnglish || place.name}`" @click="(removeError = ''), (removing = place)">Remove</AppButton>
            </div>
          </div>
        </li>
        </ul>
      </section>
    </div>

    <AddPlaceSheet v-model:open="adding" @saved="load" />

    <ModalDialog :open="!!removing" :title="removing ? `Remove ${removing.nameEnglish || removing.name}?` : ''" @update:open="(v) => !v && (removing = null)">
      <template #content>
        <p class="body-md text-muted">It comes off your saved places. An outing it was added to keeps it.</p>
        <p v-if="removeError" class="body-sm text-error" role="alert">{{ removeError }}</p>
      </template>
      <AppButton block variant="secondary" @click="removing = null">Not now</AppButton>
      <AppButton block :disabled="removeBusy" data-testid="saved-remove-confirm" @click="remove">Remove</AppButton>
    </ModalDialog>
  </main>
</template>

<style scoped>
/* The white panel round the cards, as on Rewards. */
.saved__panel { padding: var(--spacing-lg); border: 1px solid var(--hairline); border-radius: var(--rounded-lg); background: var(--canvas); }
@media (max-width: 743.98px) { .saved__panel { padding: var(--spacing-base) var(--spacing-md); } }
.saved__filters { margin-right: 0; padding-right: 0; margin-bottom: var(--spacing-xs); }
/* Wider than the usual form, so three cards a row have room, and the same width as "Places from a post", so the two pages line up. */
.saved { --wide-form-max-width: 1040px; }
/* One card a row on a phone, two on a tablet, three from a desktop. Cards in a row are the same height, with the button and link held at the bottom of each. */
.saved__list { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-base); margin: 0; padding: 0; list-style: none; }
@media (min-width: 744px) { .saved__list { grid-template-columns: repeat(2, minmax(0, 1fr)); } }
@media (min-width: 1128px) { .saved__list { grid-template-columns: repeat(3, minmax(0, 1fr)); } }
/* Less under the Remove link: its tap area already leaves room below the word. */
.saved__place { height: 100%; gap: var(--spacing-md); padding: var(--spacing-lg) var(--spacing-lg) var(--spacing-md); }
.saved__head { display: flex; align-items: center; gap: var(--spacing-md); }
.saved__names { flex: 1 1 auto; min-width: 0; }
.saved__address { align-items: flex-start; margin-top: var(--spacing-xs); }
.saved__address :deep(svg) { flex-shrink: 0; margin-top: 2px; }
.saved__actions { display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xxs); margin-top: auto; }
/* A pill's round end makes it look further in than the straight text above it, so it starts a little further out. */
.saved__maps { margin-left: -2px; }
.saved__links { display: flex; flex-wrap: wrap; align-items: center; gap: 0 var(--spacing-base); }
</style>
