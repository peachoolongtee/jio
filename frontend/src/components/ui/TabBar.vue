<script setup>
// The main navigation.
// - Mobile: a floating pill near the bottom of the screen, where thumbs reach. The current tab is tinted Rausch and
//   its name slides out beside the icon; the others are icons only (each keeps its name for screen readers and as a
//   tooltip). Create is a solid Rausch circle with a white +. The pill springs in when it first appears.
// - Tablet and up (744px): a full-width bar along the top: the Jio wordmark, every tab with its name, and
//   "Create session" as a Rausch button on the right.
// Home, Leaderboard, Create, Rewards, Profile.
// Which tab is current comes from the route (router `meta.tab`), so Home is current on the Sessions list too.
// The phone pill is never wider than the screen less 8px each side; under 400px the current tab shows only its icon.
// Create goes straight into the create page, playing the "entering a game" move from the button (lib/enterGame.js, as Home's map pin
// does). It has no menu (Faith's walkthrough, 30 October 2026: choosing first was a step too many); "Already out" is a link on the create
// page. The menu's code was removed on 1 November 2026.
import { ref } from 'vue'
import { RouterLink, useRoute, useRouter } from 'vue-router'
import AppIcon from './AppIcon.vue'
import JioLogo from './JioLogo.vue'
import { enterGame } from '@/lib/enterGame.js'

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
const isActive = (tab) => route.meta.tab === tab.id

const router = useRouter()
const button = ref(null)

// Plays the move from the Create button and opens the create page. How to call: await go('/sessions/new')
async function go(to) {
  const rect = button.value?.getBoundingClientRect?.()
  const x = rect ? rect.left + rect.width / 2 : 0
  const y = rect ? rect.top + rect.height / 2 : 0
  await enterGame({ x, y, go: () => router.push(to) })
}
</script>

<template>
  <nav class="tabbar" aria-label="Main" style="view-transition-name: app-tabs">
    <RouterLink to="/" class="tabbar__brand" aria-label="Jio home"><JioLogo :height="30" decorative /></RouterLink>
    <template v-for="tab in tabs" :key="tab.id">
    <button
      v-if="tab.create"
      :ref="(el) => (button = el)"
      type="button"
      class="tabbar__tab is-create"
      :aria-label="tab.name"
      :title="tab.name"
      data-testid="create-button"
      @click="go(tab.to)"
    >
      <AppIcon :name="tab.icon" :size="22" />
      <span class="tabbar__label" aria-hidden="true"><span>{{ tab.label }}</span></span>
      <span class="tabbar__label tabbar__label--long" aria-hidden="true"><span>{{ tab.name }}</span></span>
    </button>
    <RouterLink
      v-else
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
    </template>
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
  /* As wide as its tabs, and never wider than the screen less 8px each side. */
  width: max-content;
  min-width: min(320px, calc(100% - var(--spacing-sm) * 2));
  max-width: calc(100% - var(--spacing-sm) * 2);
  height: 56px;
  padding: var(--spacing-xs);
  border: 1px solid var(--hairline);
  border-radius: var(--rounded-full);
  background: var(--canvas);
  box-shadow: 0 12px 32px -12px rgb(0 0 0 / 0.28), var(--shadow-float);
  transform: translateX(-50%);
  animation: tabbar-in 520ms var(--ease-spring) both;
}
@keyframes tabbar-in { from { opacity: 0; transform: translateX(-50%) scale(0.9); } to { opacity: 1; transform: translateX(-50%) scale(1); } }

/* A tab: the icon, and its name folded away until the tab is current. It may shrink to 44px wide, never less. */
.tabbar__tab {
  flex: 1 1 auto;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: var(--tap-min);
  height: var(--tap-min);
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
.tabbar__label { display: grid; grid-template-columns: 0fr; min-width: 0; max-width: 84px; margin-left: 0; opacity: 0; transition: grid-template-columns 380ms var(--ease-spring), margin-left 190ms var(--ease-out), opacity 190ms var(--ease-out); }
.tabbar__label > span { min-width: 0; overflow: hidden; font: 600 12px/1.9 var(--font-sans); white-space: nowrap; text-overflow: ellipsis; }
.tabbar__tab.is-active .tabbar__label { grid-template-columns: 1fr; margin-left: var(--spacing-sm); opacity: 1; }

/* Narrow phones: the current tab is tinted but shows no name, so the pill fits whichever tab is current. */
@media (max-width: 399.98px) {
  .tabbar__label { display: none; }
  .tabbar__tab { padding: 0 var(--spacing-sm); }
}

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
    /* Below the status bar of an app added to the home screen, and clear of a notch on a phone on its side. */
    height: var(--topbar-real-height);
    padding: env(safe-area-inset-top, 0px) max(var(--gutter), calc((100vw - var(--content-max-width)) / 2), calc(env(safe-area-inset-right, 0px) + var(--spacing-base))) 0 max(var(--gutter), calc((100vw - var(--content-max-width)) / 2), calc(env(safe-area-inset-left, 0px) + var(--spacing-base)));
    border: 0;
    border-bottom: 1px solid var(--hairline);
    border-radius: 0;
    box-shadow: none;
    transform: none;
    animation: none;
  }
  .tabbar__brand { display: inline-flex; align-items: center; margin-right: var(--spacing-xl); text-decoration: none; }
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

/* Create is a button, not a link: it plays the move before it goes. */
.tabbar > button.tabbar__tab { border: 0; font: inherit; cursor: pointer; }

@media (prefers-reduced-motion: reduce) {
  .tabbar { animation: none; }
  .tabbar__tab, .tabbar__label { transition: none; }
}
</style>
