<script setup>
// Photos: everyone in the session posts pictures from the day, newest first.
//   - The newest photo leads, large, with the next two beside it (under it on a phone).
//   - The rest sit in a masonry wall of mixed shapes.
//   - Each photo carries a small frosted tag with who posted it; the lead one also says when, and where
//     (the stop on the itinerary at that time, when it was posted on the day).
//   - Tapping a photo opens the swipeable viewer on that photo, growing out of its tile.
//   - The Rausch camera button adds photos. Your own photos can be deleted in the viewer.
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AvatarStack from '@/components/ui/AvatarStack.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import PhotoViewer from '@/components/ui/PhotoViewer.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import NotFoundView from './NotFoundView.vue'
import { compressImage } from '@/lib/image.js'
import { HOST_ID } from '@/lib/mock/people.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

// The wall's tile shapes, in turn, so neighbouring photos differ.
const SHAPES = ['4 / 5', '1 / 1', '3 / 4', '4 / 3', '1 / 1', '4 / 5', '5 / 4']
const LEAD = 3

const events = useEventsStore()
const missing = ref(false)
const viewing = ref(-1)
const uploading = ref(0)
const error = ref('')
const input = ref(null)
const gallery = ref(null)
const viewer = ref(null)

const session = computed(() => events.byId[props.id])
const open = computed(() => ['confirmed', 'completed'].includes(session.value?.status))

async function load() {
  missing.value = false
  try {
    await events.loadSession(props.id)
    if (open.value) await events.loadItinerary(props.id)
  } catch {
    missing.value = true
  }
}
onMounted(load)
watch(() => props.id, load)

// Newest first, for the gallery and the viewer alike, so swiping on moves back in time.
const ordered = computed(() => [...(session.value?.photos || [])].reverse())
const lead = computed(() => ordered.value.slice(0, LEAD))
const rest = computed(() => ordered.value.slice(LEAD))
const contributors = computed(() => [...new Map(ordered.value.map((p) => [p.personId, { id: p.personId, name: p.name }])).values()])

const time = (at) => new Date(at).toLocaleTimeString('en-SG', { hour: '2-digit', minute: '2-digit', hour12: false })

const dayKey = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

// The stop that was on when the photo was posted, if it was posted on the day of the session
// (or today, while the demo treats today as the session day).
function placeOf(photo) {
  const stops = events.itineraries[props.id]?.stops
  if (!stops?.length || !session.value) return ''
  const at = new Date(photo.at)
  const day = dayKey(at)
  const onTheDay = day === session.value.date || (session.value.isToday && day === dayKey(new Date()))
  if (!onTheDay) return ''
  const minute = at.getHours() * 60 + at.getMinutes()
  const stop = stops.find((s, k) => minute >= s.start && minute < (stops[k + 1]?.start ?? s.end))
  return stop?.venue.name || ''
}

// The gallery picture of photo `i`, for the viewer to grow out of and shrink back into.
const tileImage = (i) => gallery.value?.querySelector(`[data-photo="${i}"] img`) || null
const openPhoto = (i) => viewer.value?.open(i)

async function onFiles(event) {
  const files = [...(event.target.files || [])]
  event.target.value = ''
  error.value = ''
  for (const file of files) {
    uploading.value += 1
    try {
      await events.addPhoto(props.id, await compressImage(file))
    } catch (e) {
      error.value = e.message
    }
    uploading.value -= 1
  }
}

async function remove(photo) {
  viewing.value = -1
  await events.deletePhoto(props.id, photo.id)
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="photos-view">
    <SessionHeader :session="session" back="/" />

    <div class="screen__body">
      <SessionNotices :session="session" />
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

      <EmptyState v-if="!open" title="Photos open once the plan is confirmed" />
      <EmptyState v-else-if="!ordered.length && !uploading" illustration="done" title="No photos yet" />

      <div v-else ref="gallery" class="gallery">
        <p class="gallery__sum">
          <AvatarStack :people="contributors" :size="24" :max="5" />
          <span class="caption-sm text-muted tnum">
            {{ ordered.length }} {{ ordered.length === 1 ? 'photo' : 'photos' }}<template v-if="uploading"> · Uploading {{ uploading }}</template>
          </span>
        </p>

        <section v-if="lead.length" class="lead" :class="`lead--${lead.length}`" aria-label="Latest photos">
          <button
            v-for="(p, k) in lead"
            :key="p.id"
            type="button"
            class="tile rise"
            :class="{ 'tile--feature': k === 0 }"
            :style="{ '--i': k }"
            :data-photo="k"
            :aria-label="`Photo by ${p.name}, ${time(p.at)}`"
            @click="openPhoto(k)"
          >
            <img :src="p.src" alt="" draggable="false" />
            <span v-if="k === 0 && placeOf(p)" class="tile__tag caption-sm"><AppIcon name="pin" :size="12" />{{ placeOf(p) }}</span>
            <span class="tile__by">
              <UserAvatar :name="p.name" :person="p.personId" :size="k === 0 ? 28 : 24" />
              <span class="tile__name caption">{{ p.name }}</span>
              <span v-if="k === 0" class="tile__time caption-sm tnum">{{ time(p.at) }}</span>
            </span>
          </button>
        </section>

        <ul v-if="rest.length || uploading" class="wall" aria-label="More photos">
          <li v-for="n in uploading" :key="`up-${n}`" class="wall__item">
            <span class="tile tile--loading" aria-hidden="true" />
          </li>
          <li v-for="(p, k) in rest" :key="p.id" class="wall__item rise" :style="{ '--i': Math.min(k + LEAD, 10) }">
            <button
              type="button"
              class="tile"
              :style="{ aspectRatio: SHAPES[k % SHAPES.length] }"
              :data-photo="k + LEAD"
              :aria-label="`Photo by ${p.name}, ${time(p.at)}`"
              @click="openPhoto(k + LEAD)"
            >
              <img :src="p.src" alt="" loading="lazy" draggable="false" />
              <span class="tile__by">
                <UserAvatar :name="p.name" :person="p.personId" :size="24" />
                <span class="tile__name caption">{{ p.name }}</span>
              </span>
            </button>
          </li>
        </ul>
      </div>
    </div>

    <template v-if="open">
      <IconButton tone="brand" label="Add photos" class="add-photo" @click="input?.click()"><AppIcon name="camera" :size="22" /></IconButton>
      <input ref="input" class="sr-only" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" @change="onFiles" />
    </template>

    <PhotoViewer
      ref="viewer"
      v-model:index="viewing"
      :photos="ordered"
      :origin="tileImage"
      :place="placeOf"
      :can-delete="(p) => p.personId === HOST_ID"
      @delete="remove"
    />
  </main>
  <main v-else class="screen" data-testid="photos-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)"><SkeletonRow v-for="n in 3" :key="n" /></div>
  </main>
</template>

<style scoped>
.gallery { display: flex; flex-direction: column; gap: var(--spacing-md); }
.gallery__sum { display: flex; align-items: center; gap: var(--spacing-sm); min-height: 28px; }

/* A photo tile: large rounded corners, the picture filling it, a soft lift and a slow zoom on hover. */
.tile { position: relative; display: block; width: 100%; padding: 0; overflow: hidden; isolation: isolate; border: 0; border-radius: var(--rounded-lg); background: var(--surface-strong); cursor: zoom-in; transition: box-shadow var(--motion-medium) var(--ease-out); }
.tile img { display: block; width: 100%; height: 100%; border-radius: inherit; object-fit: cover; -webkit-user-drag: none; user-select: none; transition: transform 700ms var(--ease-out); }
@media (hover: hover) {
  .tile:hover { box-shadow: var(--shadow-float); }
  .tile:hover img { transform: scale(1.04); }
}
.tile:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }

/* Frosted white tags on the photo, like the badges on an Airbnb listing photo. */
.tile__by, .tile__tag { position: absolute; z-index: 1; display: inline-flex; align-items: center; max-width: calc(100% - var(--spacing-base)); border-radius: var(--rounded-full); background: color-mix(in srgb, var(--canvas) 84%, transparent); -webkit-backdrop-filter: blur(12px) saturate(1.6); backdrop-filter: blur(12px) saturate(1.6); color: var(--ink); white-space: nowrap; }
.tile__by { left: var(--spacing-sm); bottom: var(--spacing-sm); gap: 6px; padding: 3px 10px 3px 3px; }
.tile__name { overflow: hidden; text-overflow: ellipsis; }
.tile__time { color: var(--muted); }
.tile__tag { top: var(--spacing-base); left: var(--spacing-base); gap: var(--spacing-xs); padding: 6px 12px 6px 10px; }
.tile--feature .tile__by { left: var(--spacing-base); bottom: var(--spacing-base); gap: var(--spacing-sm); padding: 4px 14px 4px 4px; }
/* On a phone the smaller tiles show only the face, so nothing is cramped. */
@media (max-width: 743.98px) {
  .tile:not(.tile--feature) .tile__by { padding: 3px; }
  .tile:not(.tile--feature) .tile__name { display: none; }
}

/* The lead: the newest photo large, the next two beside it. */
.lead { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.lead .tile { aspect-ratio: 1 / 1; }
.lead .tile--feature { grid-column: 1 / -1; aspect-ratio: 4 / 5; }
.lead--2 .tile:not(.tile--feature) { grid-column: 1 / -1; aspect-ratio: 16 / 9; }
@media (min-width: 744px) {
  .lead { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); grid-template-rows: repeat(2, minmax(0, 1fr)); gap: var(--spacing-base); height: clamp(380px, 56vh, 560px); }
  .lead .tile, .lead .tile--feature, .lead--2 .tile:not(.tile--feature) { height: 100%; aspect-ratio: auto; }
  .lead .tile--feature { grid-column: 1; grid-row: 1 / -1; }
  .lead--2 .tile:not(.tile--feature) { grid-column: 2; grid-row: 1 / -1; }
  .lead--1 { grid-template-columns: minmax(0, 1fr); }
}

/* The wall: masonry columns of mixed shapes. */
.wall { columns: 2; column-gap: var(--spacing-md); margin-top: var(--spacing-xs); }
@media (min-width: 744px) { .wall { columns: 3; column-gap: var(--spacing-base); } }
.wall__item { break-inside: avoid; margin-bottom: var(--spacing-md); }
@media (min-width: 744px) { .wall__item { margin-bottom: var(--spacing-base); } }
.tile--loading { aspect-ratio: 4 / 5; cursor: default; animation: loading 1.1s ease-in-out infinite alternate; }
@keyframes loading { to { opacity: 0.5; } }

.add-photo { position: fixed; right: var(--spacing-lg); bottom: calc(var(--spacing-lg) + env(safe-area-inset-bottom, 0px)); z-index: 15; width: 60px; height: 60px; box-shadow: var(--shadow-float); }
@media (min-width: 1128px) { .add-photo { right: var(--spacing-xl); bottom: var(--spacing-xl); } }
</style>
