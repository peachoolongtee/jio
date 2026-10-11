<script setup>
// The app frame: the screen, with the tab bar (TabBar) on top-level screens: a floating pill at the bottom on
// mobile, a full-width bar along the top from tablet up. Other screens have their own back button and, often, an action bar at the bottom.
import { computed, defineAsyncComponent, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import SyncNotice from '@/components/ui/SyncNotice.vue'
import TabBar from '@/components/ui/TabBar.vue'
import { useAuthStore } from '@/stores/auth.js'

// The demo tools exist only in development builds.
const DemoPanel = import.meta.env.DEV ? defineAsyncComponent(() => import('@/components/dev/DemoPanel.vue')) : null

const route = useRoute()
const router = useRouter()
const auth = useAuthStore()

// A session that ends while a page is open (the login expired, the planner refused the token, or another tab signed
// out) sends the person to the login screen at once, remembering the page, the way the guard would on their next click.
// Signing out on purpose is not counted here: the Profile screen goes to the right page itself.
watch(() => auth.sessionEnds, () => {
  if (!route.meta.public) router.replace({ path: route.fullPath, force: true })
})

const showNav = computed(() => auth.signedIn && route.meta.nav !== false)
const showTabs = computed(() => showNav.value && route.meta.tabs === true)
</script>

<template>
  <div class="app" :class="{ 'has-tabs': showTabs }">
    <div class="app__main">
      <SyncNotice v-if="route.meta.nav !== false" />
      <RouterView />
    </div>
    <TabBar v-if="showTabs" class="app__tabs" />
    <component :is="DemoPanel" v-if="DemoPanel && auth.signedIn && route.meta.nav !== false" />
  </div>
</template>
