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
import { useGroupsStore } from '@/stores/groups.js'
import * as api from '@/lib/api.js'
import { coins } from '@/lib/currency.js'
import { endsInText, lastDay } from '@/lib/season.js'
import { useNow } from '@/lib/useNow.js'

const groups = useGroupsStore()

onMounted(() => Promise.all([groups.loadLeaderboard(), groups.loadSeason()]))

const now = useNow()
const season = computed(() => groups.season)
const endsIn = computed(() => (season.value ? endsInText(season.value, now.value) : ''))
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
  // The meetups behind this season's JioCoins, so the line under a name always explains its number.
  byline: `${row.homeArea} · ${row.seasonMeetups} ${row.seasonMeetups === 1 ? 'meetup' : 'meetups'} ${isPast.value ? 'that season' : 'this season'}`,
  to: row.isMe ? '/profile' : `/people/${row.id}`,
})
const meId = computed(() => rows.value.find((r) => r.isMe)?.id || '')
const entries = computed(() => rows.value.map(toEntry))
// The podium is for people who earned something: nobody stands on it with 0 JioCoins.
const podium = computed(() => entries.value.slice(0, 3).filter((e) => e.value > 0))
const loading = computed(() => (isPast.value ? pastLoading.value : groups.loading.leaderboard && !groups.leaderboard.length))

</script>

<template>
  <main class="screen">
    <header class="screen__header">
      <div class="title-line">
        <h1 class="display-xl">Leaderboard</h1>
        <span v-if="season" class="days-left tnum"><AppIcon name="clock" :size="14" />{{ endsIn }}</span>
      </div>
    </header>

    <div class="screen__body">
      <div class="board-layout" :class="{ 'has-side': season?.past.length }">
        <div v-if="!season || loading" class="stack" aria-busy="true">
          <SkeletonRow v-for="n in 6" :key="n" avatar />
        </div>
        <section v-else class="board" aria-label="Ranking">
          <BannerNote v-if="!isPast" icon="trophy">
            First place wins <strong>{{ coins(season.prize) }}</strong>
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

        <aside v-if="season?.past.length" class="side">
          <section class="past card" aria-labelledby="past-head">
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
@media (min-width: 1128px) { .board-layout.has-side { grid-template-columns: minmax(0, 2fr) minmax(0, 1fr); align-items: start; } }
.board { display: flex; flex-direction: column; gap: var(--spacing-base); min-width: 0; }
.side { display: flex; flex-direction: column; gap: var(--spacing-lg); }
/* The title, with the days the season has left in a Rausch pill beside it. */
.title-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm) var(--spacing-md); }
.days-left { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); font: var(--text-badge); font-size: 13px; white-space: nowrap; }
.past { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); }
.past__list { display: flex; flex-direction: column; margin: 0; padding: 0; list-style: none; }
.past__row { display: flex; align-items: center; gap: var(--spacing-md); min-height: 52px; }
.past__row + .past__row { border-top: 1px solid var(--hairline-soft); }
.past__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.past__text { display: flex; flex-direction: column; min-width: 0; }
</style>
