<script setup>
// "Places from a post": paste a link to a YouTube, TikTok, Instagram or Xiaohongshu post and see the places it names, each
// with its address and a link that opens it in Google Maps. No map is drawn: Google's places may not be shown on or beside the OneMap
// map (CLAUDE.md), so a place opens in Google Maps instead. Picking one or more categories under a place selects it, and "Save" adds what is
// selected to the person's saved places (Faith, 4 November 2026). Only the post's own words and Google's id are kept (lib/savedPlaces.js).
// Going to another page and back keeps the link, the places and what was picked (postDraft).
// How to call: the route /places/from-post (router/routes.js).
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import TextField from '@/components/ui/TextField.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import { listSavedPlaces, placesFromPost, postReaderStatus, savePlaces } from '@/lib/api.js'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'
import { currentUserId } from '@/lib/currentUser.js'
import { keepPostDraft, readPostDraft, savedKey, toSavedPlace } from '@/lib/savedPlaces.js'
import { mapsUrl, matchQuestion, placeAddress, placeNotes, postLinkProblem, ratingLine, readErrorText, sourceNote, unreadableText } from '@/lib/postPlaces.js'

const link = ref('')
const linkError = ref('')
// 'checking' while asking whether the server reads posts, then 'off' or 'ready'.
const reader = ref('checking')
const reading = ref(false)
const failure = ref('')
const answer = ref(null)
let controller = null
// The categories picked for each place, by its key; a place with none is not selected. What this person keeps already, as key -> categories.
const picks = ref({})
const savedByKey = ref(new Map())
const saving = ref(false)
const saveError = ref('')
const justSaved = ref(0)

onMounted(async () => {
  try {
    reader.value = (await postReaderStatus()).enabled ? 'ready' : 'off'
  } catch {
    // The server could not be asked: let the person try, and a read will say what is wrong.
    reader.value = 'ready'
  }
})
onBeforeUnmount(() => {
  controller?.abort()
  keepPostDraft(currentUserId(), { link: link.value, answer: answer.value, picks: picks.value })
})

const places = computed(() => (answer.value?.status === 'ok' ? answer.value.places : []))
// Sentences about the whole post: how old it is, and what the server could not read. The server's own notes already say
// when only a caption was read, so this screen's sentence for it is used only when the server gave none.
const postNotes = computed(() => {
  const source = answer.value?.source
  const notes = (answer.value?.notes || []).filter(Boolean)
  return [source?.warning, ...(notes.length ? notes : [sourceNote(source)])].filter(Boolean)
})
// A place's key, the same one its saved row would have. How to call: keyOf(place) -> 'id:abc'
const keyOf = (place) => savedKey(toSavedPlace(place))
const isSaved = (place) => savedByKey.value.has(keyOf(place))
const savedWords = (place) => (savedByKey.value.get(keyOf(place)) || []).map((c) => CATEGORY_LABELS[c]).join(', ')
const hasPick = (place, category) => (picks.value[keyOf(place)] || []).includes(category)
// Picks or unpicks one category of a place. How to call: togglePick(place, 'eat')
function togglePick(place, category) {
  const key = keyOf(place)
  const mine = picks.value[key] || []
  picks.value = { ...picks.value, [key]: mine.includes(category) ? mine.filter((c) => c !== category) : [...mine, category] }
  justSaved.value = 0
  saveError.value = ''
}
const picked = computed(() => places.value.filter((p) => !isSaved(p) && picks.value[keyOf(p)]?.length))
const saveLabel = computed(() => (saving.value ? 'Saving…' : `Save ${picked.value.length} ${picked.value.length === 1 ? 'place' : 'places'}`))
// Saves what is selected, then those places say "Saved". How to call: await saveTicked()
async function saveTicked() {
  if (saving.value || !picked.value.length) return
  saving.value = true
  saveError.value = ''
  const rows = picked.value.map((p) => toSavedPlace(p, CATEGORIES.filter((c) => hasPick(p, c))))
  try {
    await savePlaces(rows)
    savedByKey.value = new Map([...savedByKey.value, ...rows.map((r) => [savedKey(r), r.categories])])
    justSaved.value = rows.length
    picks.value = {}
  } catch (err) {
    saveError.value = err.message
  } finally {
    saving.value = false
  }
}
// Which of a post's places this person keeps already. A failure only leaves them looking unsaved, and saving one again changes nothing.
// How to call: await loadSavedKeys()
async function loadSavedKeys() {
  try {
    savedByKey.value = new Map((await listSavedPlaces()).map((r) => [savedKey(r), r.categories]))
  } catch {
    savedByKey.value = new Map()
  }
}
// Back from another page: what was here is here again, and a place removed from the saved list meanwhile can be picked again.
const kept = readPostDraft(currentUserId())
if (kept) {
  link.value = kept.link
  answer.value = kept.answer
  picks.value = kept.picks
  if (kept.answer) loadSavedKeys()
}
const postWarning = computed(() => answer.value?.source?.warning || '')
const googleDown = computed(() => answer.value?.google?.source === 'unavailable')
const announce = computed(() => {
  if (reading.value) return 'Reading the post'
  if (answer.value?.status === 'ok') return places.value.length ? `${places.value.length} ${places.value.length === 1 ? 'place' : 'places'} found` : 'No places found'
  return ''
})

// Send the pasted link, once at a time. A read can take up to 40 seconds for a video.
// How to call: read()
async function read() {
  if (reading.value) return
  linkError.value = postLinkProblem(link.value)
  if (linkError.value) return
  controller?.abort()
  controller = new AbortController()
  reading.value = true
  failure.value = ''
  answer.value = null
  picks.value = {}
  justSaved.value = 0
  saveError.value = ''
  try {
    answer.value = await placesFromPost(link.value.trim(), { signal: controller.signal })
    await loadSavedKeys()
  } catch (err) {
    if (err?.name === 'AbortError') return
    if (err?.code === 'not_a_link' || err?.code === 'unsupported_site') linkError.value = err.message
    else failure.value = readErrorText(err)
  } finally {
    reading.value = false
  }
}
</script>

<template>
  <main class="screen screen--wide-form posts">
    <header class="screen__header">
      <div class="screen__bar">
        <IconButton label="Back" to="/"><AppIcon name="back" /></IconButton>
        <AppButton variant="tertiary" underline small to="/places/saved" data-testid="saved-link">Saved places</AppButton>
      </div>
      <div class="screen__titles">
        <h1 class="display-xl">Places from a post</h1>
        <p class="body-sm text-muted">Paste a link to a YouTube, TikTok, Instagram or Xiaohongshu post to see where its places are.</p>
      </div>
    </header>

    <div class="screen__body">
      <div v-if="reader === 'checking'" aria-hidden="true"><SkeletonRow :lines="1" /></div>

      <EmptyState v-else-if="reader === 'off'" title="Reading posts is not available" text="This Jio server cannot read posts right now." role="status" />

      <template v-else>
        <form class="posts__form" novalidate @submit.prevent="read">
          <div class="grow">
            <TextField
              v-model="link"
              label="Link to a post"
              hide-label
              type="url"
              inputmode="url"
              autocomplete="off"
              spellcheck="false"
              placeholder="Paste a link"
              :error="linkError"
              data-testid="post-link"
              @input="linkError = ''"
            >
              <template #leading><AppIcon name="link" :size="16" /></template>
            </TextField>
          </div>
          <AppButton type="submit" :disabled="reading" data-testid="post-read">{{ reading ? 'Reading…' : 'Find places' }}</AppButton>
        </form>

        <p class="sr-only" role="status">{{ announce }}</p>

        <!-- The words can be read by a screen reader (the status above says only that it is reading); only the grey rows are hidden from it. -->
        <div v-if="reading" class="stack gap-md">
          <p class="body-sm text-muted" data-testid="post-reading">Reading the post. A video can take up to 40 seconds.</p>
          <div class="stack gap-md" aria-hidden="true"><SkeletonRow v-for="n in 3" :key="n" avatar /></div>
        </div>

        <EmptyState v-else-if="failure" title="Could not read the post" :text="failure" role="alert">
          <AppButton variant="secondary" @click="read">Try again</AppButton>
        </EmptyState>

        <EmptyState v-else-if="answer?.status === 'unreadable'" title="Could not read the post" :text="unreadableText(answer)" role="alert">
          <AppButton v-if="answer.retryable" variant="secondary" @click="read">Try again</AppButton>
        </EmptyState>

        <section v-else-if="answer?.status === 'ok'" class="section" aria-labelledby="posts-found">
          <div class="section__head">
            <h2 id="posts-found" class="display-sm">{{ places.length ? `${places.length} ${places.length === 1 ? 'place' : 'places'} in this post` : 'No places found' }}</h2>
          </div>

          <BannerNote v-if="postNotes.length" tone="info">
            <span v-for="note in postNotes" :key="note" class="posts__note">{{ note }}</span>
          </BannerNote>
          <BannerNote v-if="googleDown" tone="warning" icon="warning">Addresses could not be looked up just now. Try again in a minute.</BannerNote>

          <p v-if="!places.length" class="body-sm text-muted">The post does not seem to name a place. Try another post.</p>

          <ul v-else class="stack gap-base posts__list" data-testid="post-places">
            <li v-for="(place, i) in places" :key="`${i}-${place.name}`" class="card posts__place">
              <div class="between gap-sm">
                <h3 class="title-md">{{ place.nameEnglish || place.name }}</h3>
                <span v-if="ratingLine(place.match)" class="caption posts__rating" :class="{ 'is-dim': ratingLine(place.match).dim }" :aria-label="ratingLine(place.match).label">{{ ratingLine(place.match).text }}</span>
              </div>
              <p v-if="place.nameEnglish && place.nameEnglish !== place.name" class="caption-sm text-muted">{{ place.name }}</p>

              <p v-if="placeAddress(place)" class="row gap-xs body-sm posts__address"><AppIcon name="pin" :size="16" /><span>{{ placeAddress(place) }}</span></p>
              <p v-else class="body-sm text-muted">No address found. Search for it in Google Maps.</p>

              <p v-if="matchQuestion(place.match)" class="body-sm text-muted">{{ matchQuestion(place.match) }}<template v-if="place.match.name && place.match.name !== (place.nameEnglish || place.name)"> Google: {{ place.match.name }}.</template></p>
              <p v-if="place.tip" class="body-sm">{{ place.tip }}</p>
              <p v-for="note in placeNotes(place, postWarning)" :key="note" class="row gap-xs body-sm posts__warning"><AppIcon name="warning" :size="16" /><span>{{ note }}</span></p>

              <!-- Keep this place: picking what kind of place it is selects it, and it can be more than one. -->
              <p v-if="isSaved(place)" class="row gap-xs body-sm posts__saved" data-testid="post-saved"><AppIcon name="check" :size="16" />Saved as {{ savedWords(place) }}</p>
              <div v-else class="posts__kinds" role="group" :aria-label="`Save ${place.nameEnglish || place.name} as`">
                <span class="caption text-muted" aria-hidden="true">Save as</span>
                <ChipButton v-for="c in CATEGORIES" :key="c" check :selected="hasPick(place, c)" data-testid="post-kind" @click="togglePick(place, c)">{{ CATEGORY_LABELS[c] }}</ChipButton>
              </div>

              <div>
                <!-- Opens a new tab: the icon says so, and a screen reader hears which place this one is for (the page has one of these a place). -->
                <AppButton variant="secondary" small :href="mapsUrl(place)" target="_blank" data-testid="post-maps">{{ place.match ? 'Open in Google Maps' : 'Search Google Maps' }} <span class="sr-only">for {{ place.nameEnglish || place.name }}, opens in a new tab</span><AppIcon name="external" :size="14" /></AppButton>
              </div>

              <details v-if="place.match?.ambiguous && place.match.alternatives?.length" class="posts__branches">
                <summary class="caption">Other branches ({{ place.match.alternatives.length }})</summary>
                <ul class="stack gap-sm">
                  <li v-for="alt in place.match.alternatives" :key="alt.placeId" class="between gap-sm">
                    <span class="body-sm">{{ alt.name }}<template v-if="alt.address"> · {{ alt.address }}</template></span>
                    <AppButton variant="tertiary" underline :href="mapsUrl({ match: alt })" target="_blank">Open <span class="sr-only">{{ alt.name }} in Google Maps, opens in a new tab</span><AppIcon name="external" :size="14" /></AppButton>
                  </li>
                </ul>
              </details>
            </li>
          </ul>

          <p v-if="places.some((p) => p.match)" class="caption-sm text-muted">Addresses and ratings from Google Maps.</p>

          <!-- Stays in view while the list scrolls, once something is ticked or was just saved. -->
          <div v-if="picked.length || justSaved || saveError" class="posts__bar" data-testid="post-save-bar">
            <p v-if="saveError" class="body-sm text-error" role="alert">{{ saveError }}</p>
            <p v-else-if="justSaved && !picked.length" class="body-sm" role="status" data-testid="post-save-done">{{ justSaved }} {{ justSaved === 1 ? 'place' : 'places' }} saved. <RouterLink to="/places/saved">See saved places</RouterLink></p>
            <AppButton v-if="picked.length" variant="pill" class="posts__save" :disabled="saving" data-testid="post-save" @click="saveTicked">{{ saveLabel }}</AppButton>
          </div>
        </section>
      </template>
    </div>
  </main>
</template>

<style scoped>
.posts__form {
  display: flex;
  flex-direction: column;
  gap: var(--spacing-md);
}
@media (min-width: 744px) {
  .posts__form {
    flex-direction: row;
    align-items: flex-start;
  }
  .posts__form > :deep(.btn),
  .posts__form > button {
    margin-top: 0;
    min-height: 56px;
  }
}
.posts__saved {
  min-height: var(--tap-min);
  font-weight: 600;
}
.posts__kinds {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: var(--spacing-sm);
}
/* Save floats over the list with no card behind it (Faith, 4 November 2026), held at the bottom while the list scrolls. A line beside it gets
   its own white pill, to stay readable over what passes under it. The empty space around them lets clicks through to the list. */
.posts__bar {
  position: sticky;
  bottom: var(--spacing-md);
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: flex-end;
  gap: var(--spacing-sm) var(--spacing-md);
  pointer-events: none;
}
.posts__bar > * {
  pointer-events: auto;
  box-shadow: var(--shadow-float);
}
.posts__bar > p {
  margin: 0;
  padding: var(--spacing-sm) var(--spacing-base);
  border-radius: var(--rounded-full);
  background: var(--canvas);
}
.posts__save {
  font-weight: 600;
}
.posts__note {
  display: block;
}
.posts__note + .posts__note {
  margin-top: var(--spacing-xs);
}
.posts__list {
  list-style: none;
  padding: 0;
  margin: 0;
}
.posts__place h3 {
  margin: 0;
  overflow-wrap: anywhere;
}
.posts__place p {
  margin: 0;
  overflow-wrap: anywhere;
}
.posts__address,
.posts__warning {
  align-items: flex-start;
}
.posts__address :deep(svg),
.posts__warning :deep(svg) {
  flex: none;
  margin-top: 2px;
}
.posts__warning {
  color: var(--body);
}
.posts__rating {
  flex: none;
  white-space: nowrap;
}
.posts__rating.is-dim {
  color: var(--muted);
}
.posts__branches summary {
  cursor: pointer;
  min-height: var(--tap-min);
  display: flex;
  align-items: center;
}
.posts__branches ul {
  list-style: none;
  padding: 0;
  margin: var(--spacing-sm) 0 0;
}
</style>
