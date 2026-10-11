<script setup>
// The note shown when a sign-up or profile edit worked on this device but could not be written to the person's account
// (the auth store's syncNotice). It sits at the top of the frame, can be dismissed, and goes away with the next sign-in,
// sign-up or sign-out.
//   <SyncNotice />
import BannerNote from './BannerNote.vue'
import { useAuthStore } from '@/stores/auth.js'

const auth = useAuthStore()
</script>

<template>
  <div v-if="auth.signedIn && auth.syncNotice" class="sync-notice" data-testid="sync-notice">
    <BannerNote tone="warning" icon="info" dismissible @dismiss="auth.syncNotice = ''">{{ auth.syncNotice }}</BannerNote>
  </div>
</template>

<style scoped>
.sync-notice { padding: var(--spacing-md) var(--gutter) 0; }
</style>
