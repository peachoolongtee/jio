<script setup>
// The main navigation, at every screen size: a floating pill near the bottom of the screen. The current tab is
// tinted Rausch and its name slides out beside the icon; the others are icons only (each keeps its name for screen
// readers and as a tooltip). Create is always the Rausch +. The pill springs in when it first appears.
// Home, Leaderboard, Create, Rewards, Profile.
import { RouterLink, useRoute } from 'vue-router'
import AppIcon from './AppIcon.vue'

defineProps({
  tabs: {
    type: Array,
    default: () => [
      { id: 'home', label: 'Home', icon: 'tab-feed', to: '/' },
      { id: 'leaderboard', label: 'Leaderboard', icon: 'tab-board', to: '/leaderboard' },
      { id: 'create', label: 'Create', name: 'Create session', icon: 'tab-plus', to: '/sessions/new', create: true },
      { id: 'rewards', label: 'Rewards', icon: 'tab-trophy', to: '/rewards' },
      { id: 'profile', label: 'Profile', icon: 'tab-profile', to: '/profile' },
    ],
  },
})

const route = useRoute()

function isActive(tab) {
  const path = route.path
  if (tab.id === 'home') return path === '/'
  if (tab.id === 'create') return path === '/sessions/new'
  return path === tab.to || path.startsWith(`${tab.to}/`)
}
</script>

<template>
  <nav class="tabbar" aria-label="Main" style="view-transition-name: app-tabs">
    <RouterLink
      v-for="tab in tabs"
      :key="tab.id"
      class="tabbar__tab"
      :class="{ 'is-active': isActive(tab), 'is-create': tab.create }"
      :to="tab.to"
      :aria-label="tab.name || tab.label"
      :aria-current="isActive(tab) ? 'page' : undefined"
      :title="tab.name || tab.label"
    >
      <AppIcon :name="tab.icon" :size="22" />
      <span class="tabbar__label" aria-hidden="true"><span>{{ tab.label }}</span></span>
    </RouterLink>
  </nav>
</template>

<style scoped>
/* A white pill floating above the page, centred, with the one shadow tier. */
.tabbar {
  position: fixed;
  left: 50%;
  bottom: calc(var(--spacing-md) + env(safe-area-inset-bottom, 0px));
  z-index: 20;
  display: flex;
  align-items: center;
  gap: var(--spacing-xs);
  min-width: 320px;
  max-width: 95vw;
  height: 56px;
  padding: var(--spacing-sm);
  border: 1px solid var(--hairline);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.28), var(--shadow-float);
  transform: translateX(-50%);
  animation: tabbar-in 520ms var(--ease-spring) both;
}
@keyframes tabbar-in { from { opacity: 0; transform: translateX(-50%) scale(0.9); } to { opacity: 1; transform: translateX(-50%) scale(1); } }

/* A tab: the icon, and its name folded away until the tab is current. */
.tabbar__tab {
  flex: 1 0 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 44px;
  height: 40px;
  padding: 0 var(--spacing-md);
  border-radius: var(--rounded-full);
  color: var(--muted);
  text-decoration: none;
  transition: background-color 200ms var(--ease-out), color 200ms var(--ease-out), transform 260ms var(--ease-spring);
}
.tabbar__tab:active { transform: scale(0.94); transition-duration: 200ms, 200ms, 80ms; }
.tabbar__tab.is-active { background: color-mix(in srgb, var(--primary) 11%, var(--canvas)); color: var(--primary); }
/* Create is always the Rausch +, current or not. */
.tabbar__tab.is-create { color: var(--primary); }
.tabbar__tab:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (hover: hover) { .tabbar__tab:not(.is-active):hover { background: var(--surface-soft); color: var(--ink); } .tabbar__tab.is-create:not(.is-active):hover { color: var(--primary-active); } }

/* The name grows from nothing to its width with a little spring, and fades in. */
.tabbar__label { display: grid; grid-template-columns: 0fr; max-width: 84px; margin-left: 0; opacity: 0; transition: grid-template-columns 380ms var(--ease-spring), margin-left 190ms var(--ease-out), opacity 190ms var(--ease-out); }
.tabbar__label > span { min-width: 0; overflow: hidden; font: 600 12px/1.9 var(--font-sans); white-space: nowrap; text-overflow: ellipsis; }
.tabbar__tab.is-active .tabbar__label { grid-template-columns: 1fr; margin-left: var(--spacing-sm); opacity: 1; }

@media (prefers-reduced-motion: reduce) {
  .tabbar { animation: none; }
  .tabbar__tab, .tabbar__label { transition: none; }
}
</style>
