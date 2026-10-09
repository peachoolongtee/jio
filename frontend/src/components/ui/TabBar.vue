<script setup>
// The main navigation on mobile and tablet: Home, Sessions, the create button, Leaderboard, Profile.
// App.vue places it once, fixed to the bottom of the window. On desktop SideNav takes its place.
// The router marks the current tab in Lagoon.
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'

defineProps({
  tabs: {
    type: Array,
    default: () => [
      { label: 'Home', icon: 'tab-feed', to: '/' },
      { label: 'Sessions', icon: 'tab-lists', to: '/sessions' },
      { label: 'Create session', icon: 'tab-plus', to: '/sessions/new', create: true },
      { label: 'Leaderboard', icon: 'tab-board', to: '/leaderboard' },
      { label: 'Profile', icon: 'tab-profile', to: '/profile' },
    ],
  },
})
</script>

<template>
  <nav class="tabbar" aria-label="Main">
    <template v-for="tab in tabs" :key="tab.label">
      <RouterLink v-if="tab.create" class="tabbar__create" :to="tab.to" :aria-label="tab.label">
        <AppIcon :name="tab.icon" />
      </RouterLink>
      <RouterLink v-else class="tabbar__tab" :to="tab.to" :exact-active-class="tab.to === '/' ? 'is-active' : ''" :active-class="tab.to === '/' ? '' : 'is-active'">
        <AppIcon :name="tab.icon" />
        <span class="badge">{{ tab.label }}</span>
      </RouterLink>
    </template>
  </nav>
</template>

<style scoped>
.tabbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 20;
  display: grid;
  grid-template-columns: repeat(5, minmax(0, 1fr));
  align-items: center;
  height: var(--tabbar-height);
  padding: 0 max(var(--spacing-sm), calc((100% - var(--sheet-max-width)) / 2));
  border-top: 1px solid var(--hairline);
  background: var(--canvas);
}
.tabbar__tab {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: var(--spacing-xs);
  min-height: 48px;
  border-radius: var(--rounded-sm);
  color: var(--muted);
  text-decoration: none;
}
.tabbar__tab.is-active { color: var(--primary); }
.tabbar__create {
  justify-self: center;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 48px;
  height: 48px;
  border-radius: var(--rounded-full);
  background: var(--primary);
  color: var(--on-primary);
}
.tabbar__create:active { background: var(--primary-active); }
/* Desktop uses SideNav instead. */
@media (min-width: 1128px) { .tabbar { display: none; } }
@media (hover: hover) {
  .tabbar__tab:hover { color: var(--ink); }
  .tabbar__tab.is-active:hover { color: var(--primary-active); }
  .tabbar__create:hover { background: var(--primary-active); }
}
</style>
