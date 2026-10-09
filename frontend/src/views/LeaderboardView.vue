<script setup>
// Leaderboard: one ranking, the points earned this season. A season is a calendar quarter; when it ends,
// first place wins points to spend, and season points start again from 0 (points to spend are kept).
// The rule, the countdown and the last few winners are on this screen. Ian's row is pinned at the bottom
// when he is outside the top 10. Spending points is on Rewards. The other rows are hand-written, so a "Sample data
// for the demo" note says so. Someone with no season points has no rank (null): it reads "No rank yet".
// States: skeleton rows while loading, a message with Retry if loading fails, and a message when there is no one to rank.
// The podium is in the order 1st, 2nd, 3rd for screen readers and the keyboard; CSS `order` puts 2nd on the left.
import { computed, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import SampleNote from '@/components/ui/SampleNote.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import StatTile from '@/components/ui/StatTile.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useGroupsStore } from '@/stores/groups.js'
import { endsInText, lastDay, seasonRange } from '@/lib/season.js'
import { useNow } from '@/lib/useNow.js'
import { format } from 'date-fns'

const TOP = 10

const groups = useGroupsStore()

// The store's own loading flag stays on if a load fails, so this view keeps its own.
const loading = ref(true)
const loadError = ref(false)
async function load() {
  loading.value = true
  loadError.value = false
  try {
    await Promise.all([groups.loadLeaderboard(), groups.loadSeason()])
  } catch {
    loadError.value = true
  } finally {
    loading.value = false
  }
}
onMounted(load)

const now = useNow()
const season = computed(() => groups.season)
const endsIn = computed(() => (season.value ? endsInText(season.value, now.value) : ''))
const endDate = computed(() => (season.value ? format(lastDay(season.value), 'd MMM') : ''))
// "Darius" or "Darius and Nicole"; "Nobody" when nobody earned points that season.
const winnerNames = (past) => (past.winners.length ? past.winners.map((w) => (w.isMe ? 'You' : w.name)).join(' and ') : 'Nobody')

const top = computed(() => groups.leaderboard.slice(0, TOP))
// The top three on a podium, everyone else in the list below. Nobody without a rank is on the podium.
const podiumRows = computed(() => top.value.slice(0, 3).filter((r) => r.rank != null))
// In reading order (1st, 2nd, 3rd); the CSS puts 1st in the middle.
const podium = computed(() => podiumRows.value.map((row, i) => ({ ...row, place: i + 1 })))
const rest = computed(() => top.value.filter((r) => !podiumRows.value.includes(r)))
// What a screen reader and the eye get for a rank that may be null.
const rankText = (rank) => (rank == null ? '–' : rank)
const rankLabel = (rank) => (rank == null ? 'No rank yet' : `Rank ${rank}`)
const yourRank = computed(() => (!groups.me ? '-' : groups.me.rank == null ? 'No rank yet' : ordinal(groups.me.rank)))
const pinned = computed(() => {
  const me = groups.me
  return me && !top.value.some((r) => r.isMe) ? me : null
})
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}
</script>

<template>
  <main class="screen">
    <header class="screen__header">
      <h1 class="display-xl">Leaderboard</h1>
      <div v-if="season" class="season-line">
        <p class="body-sm text-muted">Season {{ season.number }} · {{ seasonRange(season) }} · points this season</p>
        <span class="season-chip"><AppIcon name="clock" :size="13" /><span class="tnum">{{ endsIn }}</span></span>
      </div>
      <SampleNote />
    </header>

    <div class="screen__body">
      <div class="board-layout">
        <section class="section" aria-labelledby="rank-head">
          <h2 id="rank-head" class="sr-only">Ranking by points this season</h2>
          <BannerNote v-if="season" icon="trophy" class="season-rule">
            First place on {{ endDate }} wins <strong>{{ season.prize }} points</strong> to spend on Rewards.
            Then everyone's season points start again from 0.
          </BannerNote>
          <div v-if="loading && !groups.leaderboard.length" class="stack" aria-busy="true">
            <SkeletonRow v-for="n in 6" :key="n" avatar />
          </div>
          <EmptyState v-else-if="loadError" title="Could not load the leaderboard" text="Check your connection and try again." role="alert">
            <AppButton variant="secondary" :disabled="loading" @click="load">Retry</AppButton>
          </EmptyState>
          <EmptyState v-else-if="!top.length" title="No one to rank yet" text="Finish a meetup to earn season points. Everyone who does shows up here.">
            <AppButton variant="secondary" to="/sessions/new">Create meetup</AppButton>
          </EmptyState>
          <template v-else>
          <ol v-if="podium.length" class="podium rise" aria-label="Top three">
            <li v-for="row in podium" :key="row.id" class="podium__spot rise" :class="[`podium__spot--${row.place}`, { 'is-me': row.isMe }]" :style="{ '--i': row.place === 1 ? 0 : row.place }">
              <RouterLink :to="row.isMe ? '/profile' : `/people/${row.id}`" class="podium__link" :aria-label="`${rankLabel(row.rank)}: ${row.name}, ${row.seasonPoints} points this season`">
                <span class="podium__avatar">
                  <UserAvatar :name="row.name" :src="row.photo" :person="row.id" :size="row.place === 1 ? 72 : 56" />
                  <span class="podium__rank">{{ rankText(row.rank) }}</span>
                </span>
                <span class="title-sm truncate">{{ row.name }}</span>
                <span class="podium__count"><span class="display-sm tnum">{{ row.seasonPoints }}</span> <span class="caption-sm text-muted">pts</span></span>
              </RouterLink>
            </li>
          </ol>
          <ol v-if="rest.length" class="board card">
            <li v-for="(row, i) in rest" :key="row.id" class="board__row rise" :class="{ 'is-me': row.isMe, 'is-podium': row.rank != null && row.rank <= 3 }" :style="{ '--i': i + 3 }">
              <span class="board__rank" :aria-label="rankLabel(row.rank)">{{ rankText(row.rank) }}</span>
              <UserAvatar :name="row.name" :src="row.photo" :person="row.id" :size="40" />
              <RouterLink :to="row.isMe ? '/profile' : `/people/${row.id}`" class="board__name">
                <span class="title-sm truncate">{{ row.name }}<template v-if="row.isMe"> (you)</template></span>
                <span class="caption-sm text-muted">{{ row.homeArea }}</span>
              </RouterLink>
              <span class="board__count">
                <span class="title-md tnum">{{ row.seasonPoints }}</span>
                <span class="caption-sm text-muted">pts</span>
              </span>
            </li>
          </ol>
          </template>
          <div v-if="pinned" class="board__pinned">
            <div class="board__row is-me">
              <span class="board__rank" :aria-label="rankLabel(pinned.rank)">{{ rankText(pinned.rank) }}</span>
              <UserAvatar :name="pinned.name" :src="pinned.photo" :person="pinned.id" :size="40" />
              <RouterLink to="/profile" class="board__name"><span class="title-sm truncate">{{ pinned.name }} (you)</span></RouterLink>
              <span class="board__count"><span class="title-md tnum">{{ pinned.seasonPoints }}</span><span class="caption-sm text-muted">pts</span></span>
            </div>
          </div>
        </section>

        <aside class="side">
          <div class="me-stats" aria-label="Your standing">
            <StatTile label="Your rank" :value="yourRank" icon="trophy" :hint="groups.me?.rank != null ? `of ${groups.leaderboard.length} this season` : ''" />
            <StatTile label="Season points" :value="groups.me?.seasonPoints ?? 0" icon="sparkle" :hint="endsIn" />
          </div>
          <section v-if="season?.past.length" class="past card" aria-labelledby="past-head">
            <h2 id="past-head" class="title-md">Past seasons</h2>
            <ol class="past__list">
              <li v-for="past in season.past" :key="past.number" class="past__row">
                <span class="past__icon"><AppIcon name="trophy" :size="16" /></span>
                <span class="past__text">
                  <span class="title-sm">{{ winnerNames(past) }}</span>
                  <span class="caption-sm text-muted">Season {{ past.number }}<template v-if="past.winners.length"> · {{ past.winners[0].seasonPoints }} points · won {{ past.prize }}</template></span>
                </span>
              </li>
            </ol>
          </section>
        </aside>
      </div>

    </div>

  </main>
</template>

<style scoped>
.board-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-lg); }
@media (min-width: 1128px) { .board-layout { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); align-items: start; } }
.side { display: flex; flex-direction: column; gap: var(--spacing-lg); }
.me-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
/* The season: which one, its dates, and a countdown chip like the session countdown. */
.season-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); }
.season-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); font: var(--text-badge); font-size: 12px; white-space: nowrap; }
.season-rule { margin-bottom: var(--spacing-base); }
.past { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); }
.past__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.past__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 52px; }
.past__row + .past__row { border-top: 1px solid var(--hairline-soft); }
.past__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.past__text { display: flex; flex-direction: column; min-width: 0; }
.podium { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); align-items: end; gap: var(--spacing-sm); }
.podium__link { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xs); padding: var(--spacing-base) var(--spacing-sm) 0; color: var(--ink); text-decoration: none; }
.podium__avatar { position: relative; margin-bottom: var(--spacing-xs); }
.podium__avatar :deep(.avatar) { box-shadow: 0 0 0 3px var(--canvas), 0 0 0 4px var(--hairline); }
.podium__rank { position: absolute; left: 50%; bottom: -8px; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; transform: translateX(-50%); border-radius: var(--rounded-full); background: var(--ink); box-shadow: 0 0 0 2px var(--canvas); color: var(--on-dark); font: var(--text-badge); }
.podium__spot { border-radius: var(--rounded-md) var(--rounded-md) 0 0; background: var(--canvas); }
/* The list reads 1st, 2nd, 3rd; the podium shows 2nd, 1st, 3rd. */
.podium__spot--1 { order: 2; }
.podium__spot--2 { order: 1; }
.podium__spot--3 { order: 3; }
.podium__spot--1 { padding-bottom: var(--spacing-xl); background: var(--surface-soft); }
.podium__spot--2, .podium__spot--3 { padding-bottom: var(--spacing-base); }
.podium__count { color: var(--ink); }
.podium__spot.is-me .podium__link .title-sm::after { content: " (you)"; color: var(--muted); font-weight: 400; }
.board { display: flex; flex-direction: column; gap: 0; padding: var(--spacing-xs) var(--spacing-sm); }
.board__row { display: grid; grid-template-columns: 32px 40px minmax(0, 1fr) auto; align-items: center; gap: var(--spacing-md); min-height: 64px; padding: 0 var(--spacing-sm); }
.board__row + .board__row { border-top: 1px solid var(--hairline-soft); }
.board__row.is-me { border-radius: var(--rounded-sm); background: var(--surface-soft); }
.board__rank { display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--rounded-full); color: var(--muted); font: var(--text-caption); }
.board__row.is-podium .board__rank { background: var(--ink); color: var(--on-dark); }
.board__name { display: flex; flex-direction: column; min-width: 0; min-height: var(--tap-min); justify-content: center; color: var(--ink); text-decoration: none; }
@media (hover: hover) { .board__name:hover .title-sm { text-decoration: underline; } }
.board__count { display: flex; flex-direction: column; align-items: flex-end; }
/* Pinned above the floating tab bar at every width: the same room the page leaves under the bar (App's .app__main). */
.board__pinned { position: sticky; bottom: calc(var(--tabbar-height) + env(safe-area-inset-bottom, 0px)); margin-top: var(--spacing-sm); padding-top: var(--spacing-sm); border-top: 2px solid var(--ink); background: var(--canvas); }
</style>
