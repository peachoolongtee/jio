<script setup>
// Leaderboard: one ranking, the JioCoins earned this season. A season is a calendar quarter; when it ends,
// first place wins JioCoins to spend, and season totals start again from 0 (JioCoins to spend are kept).
// The rule, the countdown and the last few winners are on this screen; the picker shows a past season's
// final ranking. Spending JioCoins is on Rewards.
import { computed, onMounted, ref, watch } from 'vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import LeaderboardCard from '@/components/ui/LeaderboardCard.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import StatTile from '@/components/ui/StatTile.vue'
import { useGroupsStore } from '@/stores/groups.js'
import * as api from '@/lib/api.js'
import { coins } from '@/lib/currency.js'
import { endsInText, lastDay, seasonRange } from '@/lib/season.js'
import { useNow } from '@/lib/useNow.js'
import { format } from 'date-fns'

const groups = useGroupsStore()

onMounted(() => Promise.all([groups.loadLeaderboard(), groups.loadSeason()]))

const now = useNow()
const season = computed(() => groups.season)
const endsIn = computed(() => (season.value ? endsInText(season.value, now.value) : ''))
const endDate = computed(() => (season.value ? format(lastDay(season.value), 'd MMM') : ''))
// "Darius" or "Darius and Nicole"; "Nobody" when nobody earned JioCoins that season.
const winnerNames = (past) => (past.winners.length ? past.winners.map((w) => (w.isMe ? 'You' : w.name)).join(' and ') : 'Nobody')

// The picker: this season, then the past seasons the app remembers. Ids are season numbers as text.
const run = ref('')
const runOptions = computed(() => {
  if (!season.value) return []
  return [
    { id: String(season.value.number), label: 'This season' },
    ...season.value.past.map((p) => ({ id: String(p.number), label: `Season ${p.number}` })),
  ]
})
const shown = computed(() => {
  if (!season.value) return null
  return season.value.past.find((p) => String(p.number) === run.value) || season.value
})
const isPast = computed(() => !!shown.value && shown.value !== season.value)

// A past season's final ranking, fetched when it is picked.
const pastRows = ref([])
const pastLoading = ref(false)
watch(run, async () => {
  if (!isPast.value) return
  pastLoading.value = true
  pastRows.value = await api.getSeasonStandings(shown.value.number)
  pastLoading.value = false
})
// A new season started while the screen was open: go back to it.
watch(() => season.value?.number, (n) => { if (n != null) run.value = String(n) }, { immediate: true })

const rows = computed(() => (isPast.value ? pastRows.value : groups.leaderboard))
const toEntry = (row) => ({
  userId: row.id,
  userName: row.name,
  rank: row.rank,
  value: row.seasonPoints,
  photo: row.photo,
  byline: `${row.homeArea} · ${row.meetups} ${row.meetups === 1 ? 'meetup' : 'meetups'}`,
  to: row.isMe ? '/profile' : `/people/${row.id}`,
})
const meId = computed(() => rows.value.find((r) => r.isMe)?.id || '')
const entries = computed(() => rows.value.map(toEntry))
const podium = computed(() => entries.value.slice(0, 3))
const loading = computed(() => (isPast.value ? pastLoading.value : groups.loading.leaderboard && !groups.leaderboard.length))

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
        <p class="body-sm text-muted">Season {{ season.number }} · {{ seasonRange(season) }}</p>
        <span class="season-chip"><AppIcon name="clock" :size="13" /><span class="tnum">{{ endsIn }}</span></span>
      </div>
    </header>

    <div class="screen__body">
      <div class="board-layout">
        <div v-if="!season || loading" class="stack" aria-busy="true">
          <SkeletonRow v-for="n in 6" :key="n" avatar />
        </div>
        <section v-else class="board" aria-label="Ranking">
          <BannerNote v-if="!isPast" icon="trophy">
            First place on {{ endDate }} wins <strong>{{ coins(season.prize) }}</strong> to spend on Rewards.
            Then everyone's season total starts again from 0.
          </BannerNote>
          <BannerNote v-else icon="trophy">
            <strong>{{ winnerNames(shown) }}</strong> won this season<template v-if="shown.winners.length"> and took home {{ coins(shown.prize) }}</template>.
          </BannerNote>
          <LeaderboardCard
            v-model:selected-run-id="run"
            :title="`Season ${shown.number}`"
            :from-date="shown.startsAt"
            :to-date="lastDay(shown)"
            :podium-rankings="podium"
            :rankings="entries"
            :current-user-id="meId"
            :run-options="runOptions"
          >
            <template #empty>
              <EmptyState v-if="!entries.length" title="No ranking saved" text="This season ended before Jio kept full rankings. Only its winner is remembered." />
            </template>
          </LeaderboardCard>
        </section>

        <aside class="side">
          <div class="me-stats" aria-label="Your standing">
            <StatTile label="Your rank" :value="groups.me ? ordinal(groups.me.rank) : '-'" icon="trophy" :hint="groups.me ? `of ${groups.leaderboard.length} this season` : ''" />
            <StatTile label="JioCoins this season" :value="groups.me?.seasonPoints ?? 0" icon="coin" :hint="endsIn" />
          </div>
          <section v-if="season?.past.length" class="past card" aria-labelledby="past-head">
            <h2 id="past-head" class="title-md">Past seasons</h2>
            <ol class="past__list">
              <li v-for="past in season.past" :key="past.number" class="past__row">
                <span class="past__icon"><AppIcon name="trophy" :size="16" /></span>
                <span class="past__text">
                  <span class="title-sm">{{ winnerNames(past) }}</span>
                  <span class="caption-sm text-muted">Season {{ past.number }}<template v-if="past.winners.length"> · {{ coins(past.winners[0].seasonPoints) }} · won {{ coins(past.prize) }}</template></span>
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
.board { display: flex; flex-direction: column; gap: var(--spacing-base); min-width: 0; }
.side { display: flex; flex-direction: column; gap: var(--spacing-lg); }
.me-stats { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
/* The season: which one, its dates, and a countdown chip like the session countdown. */
.season-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); }
.season-chip { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 10px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); font: var(--text-badge); font-size: 12px; white-space: nowrap; }
.past { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); }
.past__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.past__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 52px; }
.past__row + .past__row { border-top: 1px solid var(--hairline-soft); }
.past__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.past__text { display: flex; flex-direction: column; min-width: 0; }
</style>
