<script setup>
// Leaderboard: one ranking, the JioCoins earned this season. A season is a calendar quarter; when it ends,
// first place wins JioCoins to spend, and season totals start again from 0 (JioCoins to spend are kept).
// The rule and the countdown are on this screen; the picker switches between this season and the last one,
// showing the last season's final ranking and winner. Spending JioCoins is on Rewards. The other people are hand-written, so a "Sample data for the demo"
// note says so. Someone with nothing this season has no rank yet (rank null).
// States: skeleton rows while loading, a message with Retry if loading fails, and a message when no one is ranked.
// Behind it all, GridPulse: a fine grid across the whole window that lights up in colour where the pointer passes.
// The ranking sits on a frosted panel above it, so the colour glows softly through without touching the text;
// the title and countdown hold the colour back.
import { computed, onMounted, ref, watch } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import CoinBadge from '@/components/ui/CoinBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import GridPulse from '@/components/ui/GridPulse.vue'
import LeaderboardCard from '@/components/ui/LeaderboardCard.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import { useGroupsStore } from '@/stores/groups.js'
import * as api from '@/lib/api.js'
import { endsInText, lastDay } from '@/lib/season.js'
import { useNow } from '@/lib/useNow.js'

const groups = useGroupsStore()

// The store's own loading flag stays on if a load fails, so this view keeps its own.
// How to call: load() (on mount, and from Retry)
const loadingNow = ref(true)
const loadError = ref(false)
async function load() {
  loadingNow.value = true
  loadError.value = false
  try {
    await Promise.all([groups.loadLeaderboard(), groups.loadSeason()])
  } catch {
    loadError.value = true
  } finally {
    loadingNow.value = false
  }
}
onMounted(load)

const now = useNow()
const season = computed(() => groups.season)
const endsIn = computed(() => (season.value ? endsInText(season.value, now.value) : ''))
// "Darius" or "Darius and Nicole"; "Nobody" when nobody earned JioCoins that season.
const winnerNames = (past) => (past.winners.length ? past.winners.map((w) => (w.isMe ? 'You' : w.name)).join(' and ') : 'Nobody')

// The picker: this season, and the one before it (when there is one). Ids are season numbers as text.
const lastSeason = computed(() => season.value?.past[0] || null)
const run = ref('')
const runOptions = computed(() => {
  if (!season.value) return []
  const options = [{ id: String(season.value.number), label: 'This season' }]
  if (lastSeason.value) options.push({ id: String(lastSeason.value.number), label: 'Last season' })
  return options
})
const shown = computed(() => {
  if (!season.value) return null
  return lastSeason.value && String(lastSeason.value.number) === run.value ? lastSeason.value : season.value
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
const loading = computed(() => (isPast.value ? pastLoading.value : loadingNow.value && !groups.leaderboard.length))
// Nobody has earned anything this season yet.
const nobody = computed(() => !isPast.value && !entries.value.some((e) => e.value > 0))

</script>

<template>
  <main class="screen grid-page">
    <GridPulse class="page-grid" />
    <header class="screen__header">
      <div class="title-line">
        <h1 class="display-xl" data-grid-avoid>Leaderboard</h1>
        <span v-if="season" class="days-left tnum" data-grid-avoid><AppIcon name="clock" :size="14" />{{ endsIn }}</span>
        <span v-if="shown" class="prize" data-grid-avoid>
          <AppIcon name="trophy" :size="14" />
          <template v-if="!isPast">Winner gets</template>
          <template v-else>{{ winnerNames(shown) }} won</template>
          <CoinBadge v-if="!isPast || shown.winners.length" class="prize__coins" :amount="shown.prize ?? season.prize" />
        </span>
      </div>
    </header>

    <div class="screen__body">
      <div class="board-layout">
        <EmptyState v-if="loadError" title="Could not load the leaderboard" text="Check your connection and try again." role="alert">
          <AppButton variant="secondary" :disabled="loadingNow" @click="load">Retry</AppButton>
        </EmptyState>
        <div v-else-if="!season || loading" class="stack" aria-busy="true">
          <SkeletonRow v-for="n in 6" :key="n" avatar />
        </div>
        <section v-else class="board" aria-label="Ranking">
          <EmptyState v-if="nobody" title="No one ranked yet" text="Finish a meetup to earn JioCoins this season. Everyone who does is ranked here." />
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

      </div>

    </div>

  </main>
</template>

<style scoped>
.board-layout { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-lg); }
/* Frosted glass: mostly white, blurred, so the grid's colours glow through it softly and the text stays sharp. */
.board { border: 1px solid color-mix(in srgb, var(--hairline) 70%, transparent); background: color-mix(in srgb, var(--canvas) 72%, transparent); -webkit-backdrop-filter: blur(14px) saturate(1.3); backdrop-filter: blur(14px) saturate(1.3); box-shadow: var(--shadow-float); }
.board { display: flex; flex-direction: column; gap: var(--spacing-base); min-width: 0; padding: var(--spacing-base); border-radius: var(--rounded-lg); }
/* The title, with the days the season has left in a Rausch pill beside it. */
.title-line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm) var(--spacing-md); }
/* The prize, beside the countdown: small, but always in view. */
.prize { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font: var(--text-badge); font-size: 13px; white-space: nowrap; }
.prize__coins { font-weight: 700; }
.days-left { display: inline-flex; align-items: center; gap: 6px; height: 28px; padding: 0 12px; border-radius: var(--rounded-full); background: var(--primary); color: var(--on-primary); font: var(--text-badge); font-size: 13px; white-space: nowrap; }
</style>
