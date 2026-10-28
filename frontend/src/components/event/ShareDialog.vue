<script setup>
// Share a photo from an outing (lib/sharePhoto.js). `share(photo)` hands the picture to the phone's own share sheet, which lists
// every app the person has (WhatsApp, Instagram, Telegram...). Where the browser cannot do that (most desktops), this dialog
// opens instead: "Save photo" downloads it, and a button for each app opens it in a new tab to post the saved picture there.
// It is a ModalDialog, so it sits over the full-screen photo viewer.
//   <ShareDialog ref="sharer" :session="session" />      then  sharer.value.share({ id: 'p12', src: 'data:...' }, 'Maxwell')
import { computed, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import { photoFileName, shareTargets, shareText, sharePhoto } from '@/lib/sharePhoto.js'

const props = defineProps({ session: { type: Object, default: null } })

const open = ref(false)
const photo = ref(null)
const place = ref('')
const saved = ref(false)

const text = computed(() => shareText(props.session, place.value))
const targets = computed(() => shareTargets(text.value))
const fileName = computed(() => photoFileName(props.session, photo.value))

// Share one photo: the phone's share sheet when there is one, else this dialog.
// How to call: await share(photo, 'Maxwell Food Centre')
async function share(next, where = '') {
  if (!next?.src) return
  photo.value = next
  place.value = where
  saved.value = false
  const how = await sharePhoto({ src: next.src, name: fileName.value, text: text.value })
  if (how === 'unsupported') open.value = true
}
defineExpose({ share })
</script>

<template>
  <ModalDialog v-model:open="open" title="Share photo">
    <template #content>
      <img v-if="photo" class="share__photo" :src="photo.src" alt="" />
      <p class="body-sm text-muted">{{ saved ? 'Saved. Open an app and post it from your photos.' : 'This browser cannot send a photo straight to an app. Save it, then post it in the app.' }}</p>
    </template>
    <AppButton v-if="photo" block :href="photo.src" :download="fileName" data-testid="share-save" @click="saved = true">
      <AppIcon name="download" />
      Save photo
    </AppButton>
    <div class="share__apps">
      <AppButton v-for="t in targets" :key="t.id" variant="secondary" small :href="t.href" target="_blank" :data-testid="`share-${t.id}`">{{ t.label }}</AppButton>
    </div>
    <AppButton block variant="tertiary" @click="open = false">Close</AppButton>
  </ModalDialog>
</template>

<style scoped>
.share__photo { display: block; width: 100%; max-height: 220px; object-fit: cover; border-radius: var(--rounded-md); background: var(--surface-strong); }
.share__apps { display: flex; flex-wrap: wrap; gap: var(--spacing-sm); }
.share__apps > * { flex: 1 1 0; }
</style>
