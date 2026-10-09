<script setup>
// A ranked list in pages: rank, avatar, name and one line under it, then the amount in JioCoins.
//   <LeaderboardRankings :rankings="rows" current-user-id="ian" show-pagination :default-page-size="10" />
// Each ranking: { userId, rank, userName, byline?, value, photo?, to? }. `to` makes the name a link.
// The current user's row is highlighted, and the list opens on the page that has it.
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import UserAvatar from './UserAvatar.vue'
import { COIN } from '@/lib/currency.js'

const props = defineProps({
  rankings: { type: Array, required: true },
  currentUserId: { type: String, default: '' },
  showPagination: { type: Boolean, default: false },
  defaultPageSize: { type: Number, default: 10 },
})

const size = computed(() => (props.showPagination ? props.defaultPageSize : props.rankings.length || 1))
const pages = computed(() => Math.max(1, Math.ceil(props.rankings.length / size.value)))
const myPage = () => {
  const i = props.rankings.findIndex((r) => r.userId === props.currentUserId)
  return i < 0 ? 0 : Math.floor(i / size.value)
}
const page = ref(myPage())
// New rows (another season, a finished meetup): go back to the page with the current user on it.
watch(() => props.rankings, () => { page.value = myPage() })

const visible = computed(() => props.rankings.slice(page.value * size.value, (page.value + 1) * size.value))
const first = computed(() => page.value * size.value + 1)
const last = computed(() => Math.min(props.rankings.length, (page.value + 1) * size.value))
</script>

<template>
  <div class="rankings">
    <ol class="rankings__list" :start="first">
      <li v-for="(row, i) in visible" :key="row.userId" class="rankings__row rise" :class="{ 'is-me': row.userId === currentUserId }" :style="{ '--i': i + 3 }">
        <span class="rankings__rank tnum" :aria-label="`Rank ${row.rank}`">{{ row.rank }}</span>
        <UserAvatar :name="row.userName" :src="row.photo || ''" :person="row.userId" :size="40" />
        <component :is="row.to ? 'RouterLink' : 'span'" :to="row.to || undefined" class="rankings__name">
          <span class="title-sm truncate">{{ row.userName }}<template v-if="row.userId === currentUserId"> (you)</template></span>
          <span v-if="row.byline" class="caption-sm text-muted truncate">{{ row.byline }}</span>
        </component>
        <span class="rankings__value">
          <span class="title-md tnum">{{ row.value.toLocaleString('en-SG') }}</span>
          <span class="caption-sm text-muted">{{ COIN }}</span>
        </span>
      </li>
    </ol>

    <nav v-if="showPagination && pages > 1" class="rankings__pager" aria-label="Leaderboard pages">
      <button type="button" class="rankings__step" :disabled="page === 0" aria-label="Previous page" @click="page--">
        <AppIcon name="back" :size="16" />
      </button>
      <span class="caption text-muted tnum" aria-live="polite">{{ first }}–{{ last }} of {{ rankings.length }}</span>
      <button type="button" class="rankings__step" :disabled="page >= pages - 1" aria-label="Next page" @click="page++">
        <AppIcon name="chevron-right" :size="16" />
      </button>
    </nav>
  </div>
</template>

<style scoped>
.rankings { display: flex; flex-direction: column; gap: var(--spacing-sm); }
.rankings__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.rankings__row { display: grid; grid-template-columns: 28px 40px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 64px; padding: 0 var(--spacing-sm); }
.rankings__row + .rankings__row { border-top: 1px solid var(--hairline-soft); }
.rankings__row.is-me { border-top-color: transparent; border-radius: var(--rounded-sm); background: var(--surface-soft); box-shadow: inset 3px 0 0 var(--ink); }
.rankings__row.is-me + .rankings__row { border-top-color: transparent; }
.rankings__rank { color: var(--muted); font: var(--text-caption); text-align: center; }
.rankings__row.is-me .rankings__rank { color: var(--ink); }
.rankings__name { display: flex; flex-direction: column; justify-content: center; min-width: 0; min-height: var(--tap-min); color: var(--ink); text-decoration: none; }
@media (hover: hover) { a.rankings__name:hover .title-sm { text-decoration: underline; } }
.rankings__value { display: flex; flex-direction: column; align-items: flex-end; }
.rankings__pager { display: flex; align-items: center; justify-content: flex-end; gap: var(--spacing-sm); }
.rankings__step { display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); cursor: pointer; }
.rankings__step:disabled { color: var(--muted-soft); cursor: default; }
</style>
