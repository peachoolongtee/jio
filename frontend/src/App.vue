<script setup>
// The app frame: the screen, with the floating tab bar (TabBar) at the bottom of top-level screens, the same at
// every size. Other screens have their own back button and, often, an action bar at the bottom.
import { computed, defineAsyncComponent } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import TabBar from '@/components/ui/TabBar.vue'
import { useAuthStore } from '@/stores/auth.js'

// The demo tools exist only in development builds.
const DemoPanel = import.meta.env.DEV ? defineAsyncComponent(() => import('@/components/dev/DemoPanel.vue')) : null

const route = useRoute()
const auth = useAuthStore()

const showNav = computed(() => auth.signedIn && route.meta.nav !== false)
const showTabs = computed(() => showNav.value && route.meta.tabs === true)
</script>

<template>
  <div class="app" :class="{ 'has-tabs': showTabs }">
    <div class="app__main">
      <RouterView />
    </div>
    <TabBar v-if="showTabs" class="app__tabs" />
    <component :is="DemoPanel" v-if="DemoPanel && auth.signedIn && route.meta.nav !== false" />
  </div>
</template>
