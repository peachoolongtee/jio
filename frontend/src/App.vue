<script setup>
// The app frame. One responsive layout for phone and desktop:
//   mobile and tablet  the screen, with the tab bar at the bottom on top-level screens
//   desktop            the sidebar on the left and the screen beside it
// The switch between them is CSS only, so resizing the window never re-creates the screen or loses its state.
import { computed, defineAsyncComponent } from 'vue'
import { RouterView, useRoute } from 'vue-router'
import SideNav from '@/components/ui/SideNav.vue'
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
  <div class="app" :class="{ 'has-nav': showNav, 'has-tabs': showTabs }">
    <SideNav v-if="showNav" class="app__side" :user="auth.user" />
    <div class="app__main">
      <RouterView />
    </div>
    <TabBar v-if="showTabs" class="app__tabs" />
    <component :is="DemoPanel" v-if="DemoPanel && auth.signedIn && route.meta.nav !== false" />
  </div>
</template>
