<script setup>
// "Add a place" on Saved places: keep a place with no post behind it, by typing its name (Faith, 4 November 2026).
//   <AddPlaceSheet v-model:open="adding" @saved="load" />
// Typing searches as it goes, after a short pause: Jio's own places and OneMap are free, and Google is asked (one call) only when those find
// nothing. Picking a row fills in the form below it, and it can still be changed. A place from Jio's own list can later be added to a vote.
// Google's terms allow keeping a place's id and nothing else, so a Google result keeps the words the person typed and its id; its name and
// address are only shown while choosing. Nothing here is beside a map.
import { computed, onBeforeUnmount, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import TextField from '@/components/ui/TextField.vue'
import { findPlacesToSave, savePlaces } from '@/lib/api.js'
import { CATEGORIES, CATEGORY_LABELS } from '@/lib/planner/slots.js'

const open = defineModel('open', { type: Boolean, default: false })
const emit = defineEmits(['saved'])

const query = ref('')
const results = ref([])
const searching = ref(false)
const searchNote = ref('')
// The place being kept, once a row is picked or the typed words are used: { name, category, locationHint, tip, googlePlaceId }.
const draft = ref(null)
const saving = ref(false)
const saveError = ref('')

let timer = 0
let controller = null
const SEARCH_PAUSE_MS = 500
const MIN_CHARS = 3

const asTyped = computed(() => query.value.trim())
const canSave = computed(() => !!draft.value?.name?.trim() && !!draft.value.category && !saving.value)

// How to call: reset()
function reset() {
  clearTimeout(timer)
  controller?.abort()
  query.value = ''
  results.value = []
  searching.value = false
  searchNote.value = ''
  draft.value = null
  saveError.value = ''
}
watch(open, (isOpen) => {
  if (isOpen) reset()
})
onBeforeUnmount(() => {
  clearTimeout(timer)
  controller?.abort()
})

// The form, filled in. How to call: startDraft({ name: 'Nylon', locationHint: 'Everton Park' })
function startDraft(values) {
  draft.value = { name: '', category: null, locationHint: null, tip: '', googlePlaceId: null, ...values }
  saveError.value = ''
}

// How to call: search('nylon')
async function search(text) {
  controller?.abort()
  controller = new AbortController()
  const { signal } = controller
  searching.value = true
  searchNote.value = ''
  try {
    const { places, unavailable } = await findPlacesToSave(text, { signal })
    if (signal.aborted) return
    results.value = places
    if (unavailable && !places.length) searchNote.value = "Search isn't working right now. You can still add it as typed."
  } catch (err) {
    if (err?.name === 'AbortError' || signal.aborted) return
    results.value = []
    searchNote.value = err.message
  } finally {
    if (!signal.aborted) searching.value = false
  }
}
watch(query, (text) => {
  clearTimeout(timer)
  controller?.abort()
  const q = text.trim()
  if (draft.value) return
  searching.value = false
  searchNote.value = ''
  if (q.length < MIN_CHARS) {
    results.value = []
    return
  }
  timer = setTimeout(() => search(q), SEARCH_PAUSE_MS)
})

// A row was picked. What is kept from it depends on where it came from (see the top of this file). How to call: pick(row)
function pick(row) {
  if (row.source === 'google') startDraft({ name: asTyped.value, googlePlaceId: row.placeId || null, shown: row.address })
  else startDraft({ name: row.name, locationHint: row.locationHint || null, category: row.category || null })
}
// A place is one kind: picking one replaces the last, and pressing it again unpicks it. How to call: pickCategory('eat')
function pickCategory(category) {
  draft.value.category = draft.value.category === category ? null : category
}

// How to call: await save()
async function save() {
  if (!canSave.value) return
  saving.value = true
  saveError.value = ''
  const d = draft.value
  const place = { name: d.name.trim(), nameEnglish: null, categories: [d.category], tip: d.tip.trim() || null, locationHint: d.locationHint, googlePlaceId: d.googlePlaceId, postKey: null, postUrl: null }
  try {
    const saved = await savePlaces([place])
    if (!saved.length) {
      saveError.value = 'You have already saved this place.'
      return
    }
    emit('saved')
    open.value = false
  } catch (err) {
    saveError.value = err.message
  } finally {
    saving.value = false
  }
}
</script>

<template>
  <BottomSheet v-model:open="open" title="Add a place">
    <div class="add" data-testid="add-place">
      <template v-if="!draft">
        <TextField v-model="query" label="Place name" placeholder="e.g. Tiong Bahru Bakery" autocomplete="off" spellcheck="false" data-testid="add-search" />
        <p class="sr-only" role="status">{{ searching ? 'Searching' : query.trim().length >= 3 ? `${results.length} places found` : '' }}</p>
        <div v-if="searching" class="stack gap-sm" aria-hidden="true"><SkeletonRow v-for="n in 2" :key="n" :lines="1" /></div>
        <p v-else-if="searchNote" class="body-sm text-muted" data-testid="add-note">{{ searchNote }}</p>
        <ul v-if="!searching && results.length" class="add__results" aria-label="Places found" data-testid="add-results">
          <li v-for="row in results" :key="row.key">
            <button type="button" class="add__row" data-testid="add-row" @click="pick(row)">
              <span class="title-sm">{{ row.name }}</span>
              <span v-if="row.sub" class="caption-sm text-muted">{{ row.sub }}</span>
            </button>
          </li>
        </ul>
        <AppButton v-if="!searching && asTyped.length >= 3" variant="tertiary" underline small data-testid="add-typed" @click="startDraft({ name: asTyped })">Add "{{ asTyped }}" as typed</AppButton>
        <p v-if="results.some((r) => r.source === 'google')" class="caption-sm text-muted">Some results from Google Maps.</p>
      </template>

      <template v-else>
        <TextField v-model="draft.name" label="Name" autocomplete="off" maxlength="120" data-testid="add-name" />
        <p v-if="draft.shown" class="caption-sm text-muted" data-testid="add-shown">{{ draft.shown }}. Check the name: Jio keeps your words, not Google's.</p>
        <p v-else-if="draft.locationHint" class="caption-sm text-muted">{{ draft.locationHint }}</p>
        <div class="add__kinds" role="radiogroup" aria-label="What kind of place is it?">
          <span class="caption text-muted" aria-hidden="true">Save as</span>
          <ChipButton v-for="c in CATEGORIES" :key="c" radio :selected="draft.category === c" data-testid="add-kind" @click="pickCategory(c)">
            <template #leading><CategoryIcon :category="c" :size="24" /></template>
            {{ CATEGORY_LABELS[c] }}
          </ChipButton>
        </div>
        <TextField v-model="draft.tip" label="Note (optional)" multiline maxlength="500" data-testid="add-tip" />
        <p v-if="saveError" class="body-sm text-error" role="alert" data-testid="add-error">{{ saveError }}</p>
        <AppButton variant="tertiary" underline small data-testid="add-back" @click="draft = null">Search again</AppButton>
      </template>
    </div>
    <template v-if="draft" #footer>
      <AppButton variant="pill" class="add__save" block :disabled="!canSave" data-testid="add-save" @click="save">{{ saving ? 'Saving…' : 'Save place' }}</AppButton>
    </template>
  </BottomSheet>
</template>

<style scoped>
.add { display: flex; flex-direction: column; align-items: stretch; gap: var(--spacing-md); }
.add > :deep(.btn--tertiary) { align-self: flex-start; }
.add__results { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.add__row { display: flex; flex-direction: column; gap: var(--spacing-xxs); width: 100%; min-height: var(--tap-min); padding: var(--spacing-sm) 0; border: 0; border-bottom: 1px solid var(--hairline-soft); background: transparent; color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.add__row:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-xs); }
@media (hover: hover) { .add__row:hover { background: var(--surface-soft); } }
.add__kinds { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
.add__save { font-weight: 600; }
</style>
