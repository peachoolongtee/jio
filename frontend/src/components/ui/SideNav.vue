<script setup>
// The main navigation on desktop (1128px and up): the wordmark, "Create session" and the same
// destinations as the mobile tab bar. App.vue places it once, on the left.
import { RouterLink } from 'vue-router'
import AppButton from './AppButton.vue'
import AppIcon from './AppIcon.vue'
import UserAvatar from './UserAvatar.vue'

defineProps({
  // The signed-in person, for the row at the bottom.
  user: { type: Object, default: null },
  links: {
    type: Array,
    default: () => [
      { label: 'Home', icon: 'tab-feed', to: '/', exact: true },
      { label: 'Sessions', icon: 'tab-lists', to: '/sessions' },
      { label: 'Leaderboard', icon: 'tab-board', to: '/leaderboard' },
      { label: 'Profile', icon: 'tab-profile', to: '/profile' },
    ],
  },
})
</script>

<template>
  <nav class="side" aria-label="Main">
    <RouterLink to="/" class="side__brand display-xl" aria-label="Jio, home">Jio</RouterLink>
    <AppButton block to="/sessions/new">
      <AppIcon name="plus" />
      Create session
    </AppButton>
    <ul class="side__links">
      <li v-for="link in links" :key="link.to">
        <RouterLink
          class="side__link"
          :to="link.to"
          :exact-active-class="link.exact ? 'is-active' : ''"
          :active-class="link.exact ? '' : 'is-active'"
        >
          <AppIcon :name="link.icon" :size="22" />
          <span class="title-sm">{{ link.label }}</span>
        </RouterLink>
      </li>
    </ul>
    <RouterLink v-if="user" to="/profile" class="side__me">
      <UserAvatar :name="user.name" :src="user.photo" :size="32" />
      <span class="side__me-text">
        <span class="caption truncate">{{ user.name }}</span>
        <span class="caption-sm text-muted truncate">@{{ user.username }}</span>
      </span>
    </RouterLink>
  </nav>
</template>

<style scoped>
.side {
  position: sticky;
  top: 0;
  flex-direction: column;
  gap: var(--spacing-lg);
  height: 100dvh;
  padding: var(--spacing-xl) var(--spacing-base) var(--spacing-lg);
  border-right: 1px solid var(--hairline);
  background: var(--canvas);
}
.side__brand { align-self: flex-start; padding: 0 var(--spacing-sm); border-radius: var(--rounded-sm); color: var(--primary); text-decoration: none; }
.side__links { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.side__link {
  display: flex;
  align-items: center;
  gap: var(--spacing-md);
  min-height: 48px;
  padding: 0 var(--spacing-md);
  border-radius: var(--rounded-sm);
  color: var(--body);
  text-decoration: none;
  transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out);
}
.side__link:active { background: var(--surface-strong); transition-duration: 0ms; }
.side__link.is-active { background: var(--surface-soft); color: var(--ink); }
.side__link.is-active .title-sm { font-weight: 600; }
.side__me { display: flex; align-items: center; gap: var(--spacing-sm); min-height: 56px; margin-top: auto; padding: var(--spacing-sm); border-radius: var(--rounded-sm); color: var(--ink); text-decoration: none; }
.side__me-text { display: flex; flex-direction: column; min-width: 0; }
@media (hover: hover) {
  .side__link:hover { background: var(--surface-soft); color: var(--ink); }
  .side__link.is-active:hover { background: var(--surface-strong); color: var(--ink); }
  .side__me:hover { background: var(--surface-soft); }
}
</style>
