<script setup>
// Photos: everyone in the session posts pictures from the day, newest first.
//   - They hang as instant prints on a string (PolaroidLine): drag it, use the arrows or ← and →. Each print's
//     note says where it was taken (the stop on the itinerary at that time, when posted on the day) or who
//     posted it; the line underneath says who, when and where.
//   - Tapping the print in the middle opens the swipeable viewer on it, growing out of the print. Swiping in the
//     viewer moves the line along behind it.
//   - All photos, as small thumbnails underneath: tapping one opens the viewer on it, growing out of the thumbnail.
//   - "Add photos" sits above the line (the Rausch camera floats while there are none). A session holds up to
//     PHOTOS_MAX photos. Your own photos can be deleted in the viewer, after a question to make sure.
//   - The pictures are not part of the session summary (it has photoCount): they load with events.loadPhotos.
//   - Share (under the line, for the print in the middle, and in the viewer) hands a photo to the phone's share sheet, for
//     WhatsApp, Instagram and the rest; where the browser cannot, a dialog offers to save it and open the app (ShareDialog).
//   - A session on the server has no photos yet (they would need storage of their own, a later update): the page says so, with the way
//     back to the itinerary, and offers no camera.
import { computed, nextTick, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AvatarStack from '@/components/ui/AvatarStack.vue'
import PolaroidLine from '@/components/ui/PolaroidLine.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import PhotoViewer from '@/components/ui/PhotoViewer.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SessionHeader from '@/components/event/SessionHeader.vue'
import SessionNotices from '@/components/event/SessionNotices.vue'
import ShareDialog from '@/components/event/ShareDialog.vue'
import NotFoundView from './NotFoundView.vue'
import { PHOTOS_MAX } from '@/lib/api.js'
import { compressImage } from '@/lib/image.js'
import { sessionPath, singaporeDate, singaporeMinutes } from '@/lib/session.js'
import { useAuthStore } from '@/stores/auth.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({ id: { type: String, required: true } })

const events = useEventsStore()
const auth = useAuthStore()
const missing = ref(false)
const viewing = ref(-1)
// The print in the middle of the line.
const current = ref(0)
const uploading = ref(0)
const error = ref('')
const loadError = ref('')
const input = ref(null)
const addButton = ref(null)
const gallery = ref(null)
const viewer = ref(null)
// Where the viewer grows out of: a thumbnail, or the print on the line.
let openedFrom = 'line'
// The photo the question "Delete this photo?" is about.
const confirming = ref(false)
let toDelete = null
const sharer = ref(null)

const session = computed(() => events.byId[props.id])
// An outing that closed by itself never had a plan, so photos stay shut for it (lib/api.js addPhoto refuses too).
const photosOff = computed(() => !!session.value?.remote)
const open = computed(() => ['confirmed', 'completed'].includes(session.value?.status) && session.value?.endedBy !== 'closed' && !photosOff.value)
// undefined until the pictures have loaded.
const loaded = computed(() => events.photos[props.id])

async function load() {
  missing.value = false
  loadError.value = ''
  try {
    await events.loadSession(props.id)
  } catch {
    missing.value = true
    return
  }
  if (!open.value) return
  try {
    await Promise.all([events.loadItinerary(props.id), events.loadPhotos(props.id)])
  } catch (e) {
    loadError.value = e.message || 'Could not load the photos.'
  }
}
onMounted(load)
watch(() => props.id, load)

// Newest first, for the gallery and the viewer alike, so swiping on moves back in time.
const ordered = computed(() => [...(loaded.value || [])].reverse())
const full = computed(() => ordered.value.length >= PHOTOS_MAX)
const contributors = computed(() => [...new Map(ordered.value.map((p) => [p.personId, { id: p.personId, name: p.name }])).values()])

// Singapore's clock, as the session's own times are.
const time = (at) => new Date(at).toLocaleTimeString('en-SG', { timeZone: 'Asia/Singapore', hour: '2-digit', minute: '2-digit', hour12: false })

// The stop that was on when the photo was posted, if it was posted on the day of the session
// (or today, while the demo treats today as the session day).
function placeOf(photo) {
  const stops = events.itineraries[props.id]?.stops
  if (!stops?.length || !session.value) return ''
  const at = new Date(photo.at)
  const day = singaporeDate(at)
  const onTheDay = day === session.value.date || (session.value.isToday && day === singaporeDate())
  if (!onTheDay) return ''
  const minute = singaporeMinutes(at)
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

// The picture of photo `i` that the viewer grows out of and shrinks back into.
const tileImage = (i) => gallery.value?.querySelector(openedFrom === 'thumb' ? `[data-thumb="${i}"] img` : `[data-photo="${i}"] img`) || null
function openPhoto(i, from = 'line') {
  openedFrom = from
  viewer.value?.open(i)
}
// Swiping in the viewer moves the line along behind it, so closing lands on the same print.
watch(viewing, (i) => {
  if (i >= 0) current.value = i
})

// Posts the pictures one by one. It stops at the first one that fails (the session is full, the browser's storage is
// full) and says why, instead of trying the rest and saying it again.
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
      break
    } finally {
      uploading.value -= 1
    }
  }
}

// The photo a press of Share would send: the one open in the viewer, else the one in the middle of the line. Its file is made ahead
// (ShareDialog.prepare), so the press can open the phone's share sheet at once.
const shareable = computed(() => ordered.value[viewing.value >= 0 ? viewing.value : current.value] || null)
watch([shareable, sharer], ([photo, dialog]) => dialog?.prepare(photo), { immediate: true, flush: 'post' })

// Share a photo, with where it was taken when that is known.
// How to call: share(photo)
function share(photo) {
  if (photo) sharer.value?.share(photo, placeOf(photo))
}

// The viewer asks to delete a photo: ask first. Cancelling leaves the viewer open, focus back on its Delete button.
function askDelete(photo) {
  toDelete = photo
  confirming.value = true
}

async function confirmDelete() {
  const photo = toDelete
  toDelete = null
  confirming.value = false
  if (!photo) return
  viewing.value = -1
  error.value = ''
  try {
    await events.deletePhoto(props.id, photo.id)
    await events.loadPhotos(props.id)
  } catch (e) {
    error.value = e.message
  }
  // The photo the focus was on is gone: move it to the line, or to the camera when no photos are left.
  await nextTick()
  const target = ordered.value.length ? gallery.value?.querySelector('.pl') : addButton.value?.$el
  target?.focus({ preventScroll: true })
}
</script>

<template>
  <NotFoundView v-if="missing" />
  <main v-else-if="session" class="screen" data-testid="photos-view">
    <SessionHeader :session="session" />

    <div class="screen__body">
      <SessionNotices :session="session" />
      <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>

      <EmptyState v-if="photosOff" title="Photos are not shared yet" text="They come in a later update. Everyone in the session will be able to post pictures from the day." data-testid="photos-later">
        <AppButton variant="secondary" :to="`/sessions/${id}/itinerary`">Back to the itinerary</AppButton>
      </EmptyState>
      <EmptyState v-else-if="!open" title="Photos open once the plan is confirmed" text="Everyone in the session can post pictures from the day after that.">
        <AppButton variant="secondary" :to="sessionPath(session)">Back to the session</AppButton>
      </EmptyState>
      <div v-else-if="loadError" class="stack gap-md" role="alert">
        <p class="body-sm text-error">{{ loadError }}</p>
        <AppButton variant="secondary" @click="load">Try again</AppButton>
      </div>
      <div v-else-if="!loaded" role="status" aria-busy="true">
        <span class="sr-only">Loading photos</span>
        <SkeletonRow v-for="n in 3" :key="n" />
      </div>
      <EmptyState v-else-if="!ordered.length && !uploading" illustration="done" title="No photos yet" text="Add the first one with the camera button." />

      <div v-else ref="gallery" class="gallery">
        <div class="gallery__sum">
          <AvatarStack :people="contributors" :size="24" :max="5" />
          <span class="caption-sm text-muted tnum">
            {{ ordered.length }} of {{ PHOTOS_MAX }} {{ ordered.length === 1 ? 'photo' : 'photos' }}<template v-if="full"> · Full, delete one to add more</template><template v-if="uploading"> · Uploading {{ uploading }}</template>
          </span>
          <AppButton variant="secondary" small class="gallery__add" :disabled="full" @click="input?.click()">
            <AppIcon name="camera" :size="16" />
            Add photos
          </AppButton>
        </div>

        <PolaroidLine v-model:index="current" class="rise" :photos="prints" label="Photos from the day" @open="openPhoto($event, 'line')" />
        <div class="gallery__line">
          <p class="caption text-muted">Select the photo in the middle, or any photo below, to open it larger.</p>
          <AppButton variant="secondary" small data-testid="share-current" @click="share(ordered[current])">
            <AppIcon name="share" :size="16" />
            Share this photo
          </AppButton>
        </div>

        <section class="thumbs" aria-labelledby="thumbs-head">
          <h2 id="thumbs-head" class="title-md">All photos</h2>
          <ul class="thumbs__grid">
            <li v-for="n in uploading" :key="`up-${n}`"><span class="thumb thumb--loading" aria-hidden="true" /></li>
            <li v-for="(p, k) in ordered" :key="p.id">
              <button type="button" class="thumb" :class="{ 'is-current': k === current }" :data-thumb="k" :aria-label="`Open photo by ${p.name}, ${time(p.at)}`" :aria-current="k === current ? 'true' : undefined" @click="openPhoto(k, 'thumb')">
                <img :src="p.src" alt="" loading="lazy" draggable="false" />
              </button>
            </li>
          </ul>
        </section>
      </div>
    </div>

    <template v-if="open">
      <!-- With no photos yet, the camera floats; once there are some, "Add photos" sits above the line instead. -->
      <IconButton v-if="!ordered.length && !uploading && loaded" ref="addButton" tone="brand" label="Add photos" class="add-photo" @click="input?.click()"><AppIcon name="camera" :size="22" /></IconButton>
      <input ref="input" class="sr-only" type="file" accept="image/*" multiple tabindex="-1" aria-hidden="true" @change="onFiles" />
    </template>

    <PhotoViewer
      ref="viewer"
      v-model:index="viewing"
      :photos="ordered"
      :origin="tileImage"
      :place="placeOf"
      :can-delete="(p) => p.personId === auth.myId"
      can-share
      @delete="askDelete"
      @share="share"
    />
    <ShareDialog ref="sharer" :session="session" />

    <ModalDialog v-model:open="confirming" title="Delete this photo?" text="It is removed for everyone in the session.">
      <AppButton block variant="secondary" @click="confirming = false">Keep photo</AppButton>
      <AppButton block variant="danger" @click="confirmDelete">Delete photo</AppButton>
    </ModalDialog>
  </main>
  <main v-else class="screen" data-testid="photos-view">
    <div class="screen__body" style="padding-top: var(--spacing-xl)"><SkeletonRow v-for="n in 3" :key="n" /></div>
  </main>
</template>

<style scoped>
.gallery { display: flex; flex-direction: column; gap: var(--spacing-md); }
.gallery__sum { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); min-height: 28px; }
.gallery__add { margin-left: auto; }
.gallery__line { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
.gallery__line .caption { margin: 0; flex: 1 1 16rem; }

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
