<script setup>
// The full ranking in one bordered box, in pages: rank, a crown for the first three rows, avatar, name and one
// line under it, then the amount in short form ("1.2k").
//   <LeaderboardRankings :rankings="rows" current-user-id="ian" show-pagination :default-page-size="10" />
// Each ranking: { userId, rank, userName, byline?, value, photo?, to? }. `to` makes the name a link.
// rank is null for someone with nothing this season: it shows "–" and reads "No rank yet".
// The current user's row is outlined, and the list opens on the page that has it.
import { computed, ref, watch } from 'vue'
import AppIcon from './AppIcon.vue'
import UserAvatar from './UserAvatar.vue'
import { COIN, compact } from '@/lib/currency.js'

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
// The crown a row gets: its rank's medal (1 gold, 2 silver, 3 bronze), so people tied on a rank share one.
// Nobody gets a crown for 0.
const medal = (row) => (row.rank != null && row.rank <= 3 && row.value > 0 ? row.rank : 0)
const last = computed(() => Math.min(props.rankings.length, (page.value + 1) * size.value))
</script>

<template>
  <div class="rankings">
    <ol class="rankings__list">
      <li
        v-for="(row, i) in visible"
        :key="row.userId"
        class="rankings__row rise"
        :class="[{ 'is-me': row.userId === currentUserId }, medal(row) ? `is-top-${medal(row)}` : '']"
        :style="{ '--i': i + 3 }"
      >
        <span class="rankings__rank tnum" :aria-label="row.rank == null ? 'No rank yet' : `Rank ${row.rank}`">{{ row.rank ?? '–' }}</span>
        <span class="rankings__crown"><AppIcon v-if="medal(row)" name="crown" :size="20" /></span>
        <UserAvatar :name="row.userName" :src="row.photo || ''" :person="row.userId" :size="40" />
        <component :is="row.to ? 'RouterLink' : 'span'" :to="row.to || undefined" class="rankings__name">
          <span class="title-md truncate">{{ row.userId === currentUserId ? 'You' : row.userName }}</span>
          <span v-if="row.byline" class="body-sm text-muted truncate">{{ row.byline }}</span>
        </component>
        <span class="rankings__value title-md tnum" :aria-label="`${row.value} ${COIN}`">{{ compact(row.value) }}</span>
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
.rankings { display: flex; flex-direction: column; gap: var(--spacing-md); }
/* One box, rows split by hairlines. */
.rankings__list { display: flex; flex-direction: column; margin: 0; padding: 0; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--rounded-md); list-style: none; }
.rankings__row { display: grid; grid-template-columns: 20px 24px 40px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 72px; padding: var(--spacing-sm) var(--spacing-base); }
.rankings__row + .rankings__row { border-top: 1px solid var(--hairline); }
/* Your row: outlined and lifted, like a selected card. */
.rankings__row.is-me { border-radius: var(--rounded-md); background: var(--surface-soft); box-shadow: inset 0 0 0 2px var(--ink); }
.rankings__rank { color: var(--ink); font: var(--text-title-md); text-align: center; }
.rankings__crown { display: inline-flex; }
.is-top-1 .rankings__crown { color: var(--medal-gold-fg); }
.is-top-2 .rankings__crown { color: var(--medal-silver-fg); }
.is-top-3 .rankings__crown { color: var(--medal-bronze-fg); }
.rankings__name { display: flex; flex-direction: column; justify-content: center; min-width: 0; min-height: var(--tap-min); color: var(--ink); text-decoration: none; }
@media (hover: hover) { a.rankings__name:hover .title-md { text-decoration: underline; } }
.rankings__value { white-space: nowrap; }
.rankings__pager { display: flex; align-items: center; justify-content: flex-end; gap: var(--spacing-sm); }
.rankings__step { display: inline-flex; align-items: center; justify-content: center; width: var(--tap-min); height: var(--tap-min); border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); cursor: pointer; }
.rankings__step:disabled { color: var(--muted-soft); cursor: default; }
@media (max-width: 399px) { .rankings__row { grid-template-columns: 16px 20px 40px minmax(0, 1fr) auto; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); } }
</style>
