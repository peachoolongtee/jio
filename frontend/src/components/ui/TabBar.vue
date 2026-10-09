<script setup>
// The main navigation.
// - Mobile: a floating pill near the bottom of the screen, where thumbs reach. The current tab is tinted Rausch and
//   its name slides out beside the icon; the others are icons only (each keeps its name for screen readers and as a
//   tooltip). Create is a solid Rausch circle with a white +. The pill springs in when it first appears.
// - Tablet and up (744px): a full-width bar along the top: the Jio wordmark, every tab with its name, and
//   "Create session" as a Rausch button on the right.
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
    <RouterLink to="/" class="tabbar__brand" aria-label="Jio home">Jio</RouterLink>
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
      <span v-if="tab.name" class="tabbar__label tabbar__label--long" aria-hidden="true"><span>{{ tab.name }}</span></span>
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
  /* As wide as its tabs (left: 50% would otherwise leave it only half the screen to size into, so it stuck at its
     old 320px minimum and cut the last tab off), and never wider than the screen. */
  width: max-content;
  max-width: calc(100vw - var(--spacing-base));
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
/* Create is a solid Rausch circle with a white +, current or not, so it stands out from the other tabs. */
.tabbar__tab.is-create { background: var(--primary); color: var(--on-primary); }
.tabbar__tab.is-create.is-active { background: var(--primary-active); color: var(--on-primary); }
.tabbar__tab:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
@media (hover: hover) { .tabbar__tab:not(.is-active):hover { background: var(--surface-soft); color: var(--ink); } .tabbar__tab.is-create:not(.is-active):hover { background: var(--primary-active); color: var(--on-primary); } }

/* The name grows from nothing to its width with a little spring, and fades in. */
.tabbar__label { display: grid; grid-template-columns: 0fr; max-width: 84px; margin-left: 0; opacity: 0; transition: grid-template-columns 380ms var(--ease-spring), margin-left 190ms var(--ease-out), opacity 190ms var(--ease-out); }
.tabbar__label > span { min-width: 0; overflow: hidden; font: 600 12px/1.9 var(--font-sans); white-space: nowrap; text-overflow: ellipsis; }
.tabbar__tab.is-active .tabbar__label { grid-template-columns: 1fr; margin-left: var(--spacing-sm); opacity: 1; }

/* Small phones: tighter tabs, so all five fit on a 320px screen. */
@media (max-width: 379px) {
  .tabbar { gap: 2px; padding: var(--spacing-xs); }
  .tabbar__tab { min-width: 40px; padding: 0 var(--spacing-sm); }
}

/* Only the wide bar shows the wordmark and Create's longer name. */
.tabbar__brand, .tabbar__label--long { display: none; }

/* Tablet and up: a full-width bar along the top. The wordmark on the left, the tabs beside it with their names,
   and Create as a Rausch button pushed to the right. */
@media (min-width: 744px) {
  .tabbar {
    top: 0;
    right: 0;
    bottom: auto;
    left: 0;
    gap: var(--spacing-md);
    /* Full width again: the phone pill's width: max-content must not shrink the top bar to its tabs. */
    width: auto;
    min-width: 0;
    max-width: none;
    height: var(--topbar-height);
    padding: 0 max(var(--gutter), calc((100vw - var(--content-max-width)) / 2));
    border: 0;
    border-bottom: 1px solid var(--hairline);
    border-radius: 0;
    box-shadow: none;
    transform: none;
    animation: none;
  }
  .tabbar__brand { display: inline-flex; align-items: center; margin-right: var(--spacing-xl); color: var(--primary); font: 800 26px/1 var(--font-sans); letter-spacing: -0.02em; text-decoration: none; }
  .tabbar__tab { flex: 0 0 auto; height: 44px; padding: 0 var(--spacing-base); }
  .tabbar__tab:not(.is-active):not(.is-create) { color: var(--body); }
  .tabbar__label, .tabbar__tab.is-active .tabbar__label { grid-template-columns: 1fr; max-width: none; margin-left: var(--spacing-sm); opacity: 1; transition: none; }
  .tabbar__label > span { font: var(--text-nav-link); font-size: 15px; }
  /* Create: last, on the right, as a Rausch button with its full name. */
  .tabbar__tab.is-create { order: 1; margin-left: auto; padding: 0 var(--spacing-lg) 0 var(--spacing-base); }
  .tabbar__tab.is-create .tabbar__label:not(.tabbar__label--long) { display: none; }
  .tabbar__tab.is-create .tabbar__label--long { display: grid; }
}
/* Tablet: tighter tabs, and Create says just "Create", so the bar fits without scrolling. */
@media (min-width: 744px) and (max-width: 1127px) {
  .tabbar { gap: var(--spacing-xs); }
  .tabbar__brand { margin-right: var(--spacing-sm); }
  .tabbar__tab { padding: 0 var(--spacing-md); }
  .tabbar__tab.is-create { padding: 0 var(--spacing-base) 0 var(--spacing-md); }
  .tabbar__tab.is-create .tabbar__label:not(.tabbar__label--long) { display: grid; }
  .tabbar__tab.is-create .tabbar__label--long { display: none; }
}

@media (prefers-reduced-motion: reduce) {
  .tabbar { animation: none; }
  .tabbar__tab, .tabbar__label { transition: none; }
}
</style>
