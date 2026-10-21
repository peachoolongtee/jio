<script setup>
// The app frame: the screen, with the tab bar (TabBar) on top-level screens: a floating pill at the bottom on
// mobile, a full-width bar along the top from tablet up. Other screens have their own back button and, often, an action bar at the bottom.
// Until the app knows who is signed in (auth.ready, a few hundred milliseconds, at most about four seconds), it shows a
// placeholder of the same shape, so the page is never blank.
import { computed, defineAsyncComponent, watch } from 'vue'
import { RouterView, useRoute, useRouter } from 'vue-router'
import JioLogo from '@/components/ui/JioLogo.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SyncNotice from '@/components/ui/SyncNotice.vue'
import TabBar from '@/components/ui/TabBar.vue'
import DietaryFirstAsk from '@/components/event/DietaryFirstAsk.vue'
import { useAuthStore } from '@/stores/auth.js'
import { TOUR_BUILT } from '@/lib/tourFlag.js'

// The demo tools exist only in development builds.
const DemoPanel = import.meta.env.DEV ? defineAsyncComponent(() => import('@/components/dev/DemoPanel.vue')) : null

// The demo tour's strip exists only in a build that has the tour (lib/tourFlag.js); it hides itself when the tour is not on.
const TourStrip = TOUR_BUILT ? defineAsyncComponent(() => import('@/tour/TourStrip.vue')) : null

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
  <div v-if="!auth.ready" class="app">
    <div class="app__main">
      <main class="screen" aria-busy="true" data-testid="app-starting">
        <header class="screen__header">
          <div class="screen__bar"><JioLogo :height="36" /></div>
        </header>
        <div class="screen__body" role="status">
          <span class="sr-only">Loading Jio</span>
          <SkeletonRow v-for="n in 3" :key="n" :lines="3" />
        </div>
      </main>
    </div>
  </div>
  <div v-else class="app" :class="{ 'has-tabs': showTabs }">
    <div class="app__main">
      <SyncNotice v-if="route.meta.nav !== false" />
      <component :is="TourStrip" v-if="TourStrip && auth.signedIn && route.meta.nav !== false" />
      <RouterView />
    </div>
    <TabBar v-if="showTabs" class="app__tabs" />
    <!-- "Any dietary needs?", once, right after the account is made. -->
    <DietaryFirstAsk v-if="auth.signedIn" />
    <component :is="DemoPanel" v-if="DemoPanel && auth.signedIn && route.meta.nav !== false" />
  </div>
</template>
