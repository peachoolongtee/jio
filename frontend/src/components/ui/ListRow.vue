<script setup>
// One row of a list: something on the left, a title with a line under it, something on the right.
//   <ListRow title="Junction 8" meta="Shop · Bishan">
//     <template #leading><UserAvatar name="Darius" :size="32" /></template>
//     <template #trailing><RatingBadge :score="8.6" /></template>
//   </ListRow>
// Pass `to` to make the title a link. Use `as="li"` inside a <ul>.
import { RouterLink } from 'vue-router'

defineProps({
  title: { type: String, default: '' },
  meta: { type: String, default: '' },
  to: { type: [String, Object], default: null },
  as: { type: String, default: 'div' },
})
</script>

<template>
  <component :is="as" class="list-row">
    <slot name="leading" />
    <div class="list-row__text">
      <RouterLink v-if="to" class="list-row__title list-row__title--link" :to="to"><slot>{{ title }}</slot></RouterLink>
      <span v-else class="list-row__title"><slot>{{ title }}</slot></span>
      <span v-if="meta || $slots.meta" class="list-row__meta"><slot name="meta">{{ meta }}</slot></span>
    </div>
    <slot name="trailing" />
  </component>
</template>

<style scoped>
.list-row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 64px; border-bottom: 1px solid var(--hairline-soft); }
.list-row__text { flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.list-row__title { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font: var(--text-title-md); }
/* The link grows to a 44px tap area without moving the text. */
.list-row__title--link { margin: -13px 0; padding: 13px 0; color: var(--ink); text-decoration: none; }
@media (hover: hover) { .list-row__title--link:hover { text-decoration: underline; } }
.list-row__meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font: var(--text-caption-sm); }
</style>
