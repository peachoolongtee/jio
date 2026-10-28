<script setup>
// Share a photo from an outing (lib/sharePhoto.js). `share(photo)` hands the picture to the phone's own share sheet, which lists
// every app the person has (WhatsApp, Instagram, Telegram...). Where the browser cannot do that (most desktops), this dialog
// opens instead: "Save photo" downloads it, and a button for each app opens it in a new tab to post the saved picture there.
// The dialog says the order: save the photo, then open an app ("Open WhatsApp", "Open Instagram", "Open Telegram") and post it there.
// A browser only opens its share sheet close to the tap, so the picture is made ahead: the screen calls `prepare(photo)` when a photo is
// shown or chosen, and `share` then calls `navigator.share` with nothing awaited first. If the browser says the tap is too old
// (NotAllowedError) the dialog opens instead. A second `share` while one is in progress is ignored, so no dialog opens over the sheet.
// It is a ModalDialog, so it sits over the full-screen photo viewer.
//   <ShareDialog ref="sharer" :session="session" />      then  sharer.value.prepare(photo)  and  sharer.value.share(photo, 'Maxwell')
import { computed, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import { photoFile, photoFileName, shareTargets, shareText, sharePhoto } from '@/lib/sharePhoto.js'

const props = defineProps({ session: { type: Object, default: null } })

const open = ref(false)
const photo = ref(null)
const place = ref('')
const saved = ref(false)
// Whether the browser turned the share sheet down because the tap was too old (the dialog then says so), and whether a share is in progress.
const blocked = ref(false)
const sharing = ref(false)
// The picture made ahead: { id, file (once made), made (the promise of it) }.
let prepared = { id: '', file: null, made: null }

const text = computed(() => shareText(props.session, place.value))
const targets = computed(() => shareTargets(text.value))
// The sentence in the dialog: what to do and in which order, before and after the photo is saved.
const words = computed(() => {
  if (saved.value) return 'Saved. Now open an app below and post the photo from your photos.'
  const why = blocked.value ? 'The share sheet did not open.' : 'This browser cannot send a photo straight to an app.'
  return `${why} First save the photo, then open an app below and post it.`
})
const fileName = computed(() => photoFileName(props.session, photo.value))

// Make the photo's file ahead of a press, where the browser has a share sheet. Asking again for the same photo does nothing.
// How to call: prepare({ id: 'p12', src: 'data:image/jpeg;base64,...' })
function prepare(next) {
  if (!next?.src || prepared.id === next.id) return
  const mine = { id: next.id, file: null, made: null }
  mine.made = globalThis.navigator?.share
    ? photoFile(next.src, photoFileName(props.session, next)).then((file) => (mine.file = file), () => null)
    : Promise.resolve(null)
  prepared = mine
}

// Share one photo: the phone's share sheet when there is one, else this dialog.
// How to call: await share(photo, 'Maxwell Food Centre')
async function share(next, where = '') {
  if (!next?.src || sharing.value) return
  sharing.value = true
  try {
    photo.value = next
    place.value = where
    saved.value = false
    blocked.value = false
    prepare(next)
    // Made ahead, the file is there and `share` is called in this very tap; only a press that beats the preparation waits for it.
    const file = prepared.file ?? (await prepared.made)
    const how = await sharePhoto({ file, text: text.value })
    blocked.value = how === 'blocked'
    if (how === 'unsupported' || how === 'blocked') open.value = true
  } finally {
    sharing.value = false
  }
}
defineExpose({ share, prepare })
</script>

<template>
  <ModalDialog v-model:open="open" title="Share photo">
    <template #content>
      <img v-if="photo" class="share__photo" :src="photo.src" alt="" />
      <p class="body-sm text-muted">{{ words }}</p>
    </template>
    <AppButton v-if="photo" block :href="photo.src" :download="fileName" data-testid="share-save" @click="saved = true">
      <AppIcon name="download" />
      Save photo
    </AppButton>
    <div class="share__apps">
      <AppButton v-for="t in targets" :key="t.id" variant="secondary" small :href="t.href" target="_blank" :data-testid="`share-${t.id}`">Open {{ t.label }}</AppButton>
    </div>
    <AppButton block variant="tertiary" @click="open = false">Close</AppButton>
  </ModalDialog>
</template>

<style scoped>
.share__photo { display: block; width: 100%; max-height: 220px; object-fit: cover; border-radius: var(--rounded-md); background: var(--surface-strong); }
.share__apps { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.share__apps > * { flex: 1 1 0; }
</style>
