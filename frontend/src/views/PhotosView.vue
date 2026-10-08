<script setup>
// Photos: everyone in the session posts pictures from the day, newest first.
//   - They hang as instant prints on a string (PolaroidLine): drag it, use the arrows or ← and →. Each print's
//     note says where it was taken (the stop on the itinerary at that time, when posted on the day) or who
//     posted it; the line underneath says who, when and where.
//   - Tapping the print in the middle opens the swipeable viewer on it, growing out of the print. Swiping in the
//     viewer moves the line along behind it.
//   - All photos, as small thumbnails underneath: tapping one brings its print to the middle of the line.
//   - "Add photos" sits above the line (the Rausch camera floats while there are none). Your own photos can be
//     deleted in the viewer.
import { computed, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AvatarStack from '@/components/ui/AvatarStack.vue'
import PolaroidLine from '@/components/ui/PolaroidLine.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import PhotoViewer from '@/components/ui/PhotoViewer.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import NotFoundView from './NotFoundView.vue'
import { compressImage } from '@/lib/image.js'
import { HOST_ID } from '@/lib/mock/people.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

const events = useEventsStore()
const missing = ref(false)
const viewing = ref(-1)
// The print in the middle of the line.
const current = ref(0)
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

// The prints: the note on the print, and the line under the string.
const prints = computed(() =>
  ordered.value.map((p) => {
    const place = placeOf(p)
    return { id: p.id, src: p.src, alt: `Photo by ${p.name}`, note: place || p.name, title: `Photo by ${p.name}`, caption: [time(p.at), place].filter(Boolean).join(' · ') }
  }),
)

// The print of photo `i`, for the viewer to grow out of and shrink back into.
const tileImage = (i) => gallery.value?.querySelector(`[data-photo="${i}"] img`) || null
const openPhoto = (i) => viewer.value?.open(i)
// Swiping in the viewer moves the line along behind it, so closing lands on the same print.
watch(viewing, (i) => {
  if (i >= 0) current.value = i
})
// A thumbnail: bring its print to the middle and the line into view.
function showPrint(i) {
  current.value = i
  gallery.value?.querySelector('.pl')?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
}

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
        <div class="gallery__sum">
          <AvatarStack :people="contributors" :size="24" :max="5" />
          <span class="caption-sm text-muted tnum">
            {{ ordered.length }} {{ ordered.length === 1 ? 'photo' : 'photos' }}<template v-if="uploading"> · Uploading {{ uploading }}</template>
          </span>
          <AppButton variant="secondary" small class="gallery__add" @click="input?.click()">
            <AppIcon name="camera" :size="16" />
            Add photos
          </AppButton>
        </div>

        <PolaroidLine v-model:index="current" class="rise" :photos="prints" label="Photos from the day" @open="openPhoto" />

        <section class="thumbs" aria-labelledby="thumbs-head">
          <h2 id="thumbs-head" class="title-md">All photos</h2>
          <ul class="thumbs__grid">
            <li v-for="n in uploading" :key="`up-${n}`"><span class="thumb thumb--loading" aria-hidden="true" /></li>
            <li v-for="(p, k) in ordered" :key="p.id">
              <button type="button" class="thumb" :class="{ 'is-current': k === current }" :aria-label="`Photo by ${p.name}, ${time(p.at)}`" :aria-current="k === current ? 'true' : undefined" @click="showPrint(k)">
                <img :src="p.src" alt="" loading="lazy" draggable="false" />
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <template v-if="open">
      <!-- With no photos yet, the camera floats; once there are some, "Add photos" sits above the line instead. -->
      <IconButton v-if="!ordered.length && !uploading" tone="brand" label="Add photos" class="add-photo" @click="input?.click()"><AppIcon name="camera" :size="22" /></IconButton>
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
.gallery__add { margin-left: auto; }

/* All photos: small square thumbnails; the one on the line in the middle is ringed. */
.thumbs { display: flex; flex-direction: column; gap: var(--spacing-md); margin-top: var(--spacing-base); }
.thumbs__grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(72px, 1fr)); gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; }
@media (min-width: 744px) { .thumbs__grid { grid-template-columns: repeat(auto-fill, minmax(96px, 1fr)); } }
.thumb { position: relative; display: block; width: 100%; aspect-ratio: 1; padding: 0; overflow: hidden; border: 0; border-radius: var(--rounded-sm); background: var(--surface-strong); cursor: pointer; transition: transform 260ms var(--ease-spring), box-shadow var(--motion-fast) var(--ease-out); }
.thumb img { display: block; width: 100%; height: 100%; object-fit: cover; -webkit-user-drag: none; user-select: none; }
.thumb.is-current { box-shadow: 0 0 0 2px var(--canvas), 0 0 0 4px var(--ink); }
.thumb:active { transform: scale(0.94); transition-duration: 80ms; }
@media (hover: hover) { .thumb:hover { transform: translateY(-2px); } }
.thumb:focus-visible { outline: 2px solid var(--ink); outline-offset: 3px; }
.thumb--loading { animation: loading 1.1s ease-in-out infinite alternate; }
@keyframes loading { to { opacity: 0.5; } }

.add-photo { position: fixed; right: var(--spacing-lg); bottom: calc(var(--spacing-lg) + env(safe-area-inset-bottom, 0px)); z-index: 15; width: 60px; height: 60px; box-shadow: var(--shadow-float); }
@media (min-width: 1128px) { .add-photo { right: var(--spacing-xl); bottom: var(--spacing-xl); } }
</style>
