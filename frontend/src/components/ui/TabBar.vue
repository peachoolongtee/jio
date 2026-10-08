<script setup>
// The main navigation on mobile and tablet: a white bar with a hairline on top, icons only (each has a label
// for screen readers and a tooltip). The current tab is Rausch, like the Airbnb app; Create is the Rausch orb.
// Home, Sessions, Create, Leaderboard, Profile. On desktop SideNav takes its place.
import { RouterLink } from 'vue-router'
import AppIcon from './AppIcon.vue'

defineProps({
  tabs: {
    type: Array,
    default: () => [
      { label: 'Home', icon: 'tab-feed', to: '/', exact: true },
      { label: 'Sessions', icon: 'tab-lists', to: '/sessions' },
      { label: 'Create session', icon: 'tab-plus', to: '/sessions/new', create: true },
      { label: 'Leaderboard', icon: 'tab-board', to: '/leaderboard' },
      { label: 'Profile', icon: 'tab-profile', to: '/profile' },
    ],
  },
})
</script>

<template>
  <nav class="tabbar" aria-label="Main" style="view-transition-name: app-tabs">
    <template v-for="tab in tabs" :key="tab.label">
      <RouterLink v-if="tab.create" class="tabbar__create" :to="tab.to" :aria-label="tab.label" :title="tab.label">
        <AppIcon :name="tab.icon" />
      </RouterLink>
      <RouterLink
        v-else
        class="tabbar__tab"
        :to="tab.to"
        :aria-label="tab.label"
        :title="tab.label"
        :exact-active-class="tab.exact ? 'is-active' : ''"
        :active-class="tab.exact ? '' : 'is-active'"
      >
        <AppIcon :name="tab.icon" />
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
  height: calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px));
  padding: 0 max(var(--spacing-sm), calc((100% - var(--sheet-max-width)) / 2)) env(safe-area-inset-bottom, 0px);
  border-top: 1px solid var(--hairline);
  background: var(--canvas);
}
.tabbar__tab, .tabbar__create { justify-self: center; display: flex; align-items: center; justify-content: center; width: 48px; height: 48px; border-radius: var(--rounded-full); text-decoration: none; transition: color var(--motion-fast) var(--ease-out), background-color var(--motion-fast) var(--ease-out); }
.tabbar__tab { color: var(--muted); }
.tabbar__tab.is-active { color: var(--primary); }
/* The search-orb: a 48px Rausch circle. */
.tabbar__create { background: var(--primary); color: var(--on-primary); }
.tabbar__create:active { background: var(--primary-active); }
@media (hover: hover) {
  .tabbar__tab:not(.is-active):hover { color: var(--ink); }
  .tabbar__create:hover { background: var(--primary-active); }
}
/* Desktop uses SideNav instead. */
@media (min-width: 1128px) { .tabbar { display: none; } }
</style>
