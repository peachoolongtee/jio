<script setup>
// Leaderboard: one ranking, the points earned this season. A season is a calendar quarter; when it ends,
// first place wins points to spend, and season points start again from 0 (points to spend are kept).
// The rule, the countdown and the last few winners are on this screen. Ian's row is pinned at the bottom
// when he is outside the top 10.
// Rewards: café vouchers bought with points. Redeeming shows a code and lowers the balance;
// a voucher that costs more than the balance is disabled and says how many points are missing.
import { computed, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import StatTile from '@/components/ui/StatTile.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import { useGroupsStore } from '@/stores/groups.js'
import { endsInText, lastDay, seasonRange } from '@/lib/season.js'
import { useNow } from '@/lib/useNow.js'
import { format } from 'date-fns'

const TOP = 10

const groups = useGroupsStore()
const confirming = ref(null)
const redeemed = ref(null)
const busy = ref(false)
const error = ref('')

onMounted(() => Promise.all([groups.loadLeaderboard(), groups.loadSeason(), groups.loadRewards()]))

const now = useNow()
const season = computed(() => groups.season)
const endsIn = computed(() => (season.value ? endsInText(season.value, now.value) : ''))
const endDate = computed(() => (season.value ? format(lastDay(season.value), 'd MMM') : ''))
// "Darius" or "Darius and Nicole"; "Nobody" when nobody earned points that season.
const winnerNames = (past) => (past.winners.length ? past.winners.map((w) => (w.isMe ? 'You' : w.name)).join(' and ') : 'Nobody')

const top = computed(() => groups.leaderboard.slice(0, TOP))
// The top three on a podium (2nd, 1st, 3rd), everyone else in the list below.
const podium = computed(() => {
  const [a, b, c] = top.value
  return [b, a, c].filter(Boolean).map((row) => ({ ...row, place: row === a ? 1 : row === b ? 2 : 3 }))
})
const rest = computed(() => top.value.slice(3))
const pinned = computed(() => {
  const me = groups.me
  return me && !top.value.some((r) => r.isMe) ? me : null
})
const points = computed(() => groups.me?.points ?? 0)
const ordinal = (n) => {
  const s = ['th', 'st', 'nd', 'rd']
  const v = n % 100
  return n + (s[(v - 20) % 10] || s[v] || s[0])
}

async function redeem() {
  busy.value = true
  error.value = ''
  try {
    redeemed.value = await groups.redeem(confirming.value.id)
    confirming.value = null
  } catch (e) {
    error.value = e.message
  }
  busy.value = false
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
    </header>

    <div class="screen__body">
      <div class="board-layout">
        <section class="section" aria-labelledby="rank-head">
          <h2 id="rank-head" class="sr-only">Ranking by points this season</h2>
          <BannerNote v-if="season" icon="trophy" class="season-rule">
            First place on {{ endDate }} wins <strong>{{ season.prize }} points</strong> to spend on café discounts.
            Then everyone's season points start again from 0. Points you have not spent are kept.
          </BannerNote>
          <div v-if="groups.loading.leaderboard && !groups.leaderboard.length" class="stack">
            <SkeletonRow v-for="n in 6" :key="n" avatar />
          </div>
 <template v-else>
          <ol class="podium rise" aria-label="Top three">
            <li v-for="row in podium" :key="row.id" class="podium__spot rise" :class="[`podium__spot--${row.place}`, { 'is-me': row.isMe }]" :style="{ '--i': row.place === 1 ? 0 : row.place }">
              <RouterLink :to="row.isMe ? '/profile' : `/people/${row.id}`" class="podium__link" :aria-label="`Rank ${row.rank}: ${row.name}, ${row.seasonPoints} points this season`">
                <span class="podium__avatar">
                  <UserAvatar :name="row.name" :src="row.photo" :person="row.id" :size="row.place === 1 ? 72 : 56" />
                  <span class="podium__rank">{{ row.rank }}</span>
                </span>
                <span class="title-sm truncate">{{ row.name }}</span>
                <span class="podium__count"><span class="display-sm tnum">{{ row.seasonPoints }}</span> <span class="caption-sm text-muted">pts</span></span>
              </RouterLink>
            </li>
          </ol>
          <ol v-if="rest.length" class="board card">
            <li v-for="(row, i) in rest" :key="row.id" class="board__row rise" :class="{ 'is-me': row.isMe, 'is-podium': row.rank <= 3 }" :style="{ '--i': i + 3 }">
              <span class="board__rank" :aria-label="`Rank ${row.rank}`">{{ row.rank }}</span>
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
              <span class="board__rank" :aria-label="`Rank ${pinned.rank}`">{{ pinned.rank }}</span>
              <UserAvatar :name="pinned.name" :src="pinned.photo" :person="pinned.id" :size="40" />
              <RouterLink to="/profile" class="board__name"><span class="title-sm truncate">{{ pinned.name }} (you)</span></RouterLink>
              <span class="board__count"><span class="title-md tnum">{{ pinned.seasonPoints }}</span><span class="caption-sm text-muted">pts</span></span>
            </div>
          </div>
        </section>

        <aside class="side">
          <div class="me-stats" aria-label="Your standing">
            <StatTile label="Your rank" :value="groups.me ? ordinal(groups.me.rank) : '-'" icon="trophy" :hint="groups.me ? `${groups.me.seasonPoints} points this season` : ''" />
            <StatTile label="Points" :value="points" icon="gift" hint="Spend them on café discounts below" />
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

      <section id="rewards" class="section" aria-labelledby="rewards-head">
        <div class="section__head">
          <h2 id="rewards-head" class="display-sm">Café discounts</h2>
          <span class="caption">{{ points }} points to spend</span>
        </div>
        <ol class="how" aria-label="How points work">
          <li><span class="how__n">1</span><span class="body-sm">Every meetup you finish earns <strong>100 points</strong>.</span></li>
          <li><span class="how__n">2</span><span class="body-sm">Spend them on a discount at a partner café below.</span></li>
          <li><span class="how__n">3</span><span class="body-sm">Show the code at the counter.</span></li>
        </ol>
        <div v-if="groups.loading.rewards && !groups.rewards.length" class="grid-3">
          <SkeletonRow v-for="n in 3" :key="n" />
        </div>
        <EmptyState v-else-if="!groups.rewards.length" title="No rewards right now" />
        <ul v-else class="grid-3">
          <li v-for="reward in groups.rewards" :key="reward.id" class="voucher" :class="{ 'is-short': reward.cost > points }">
            <div class="voucher__top">
              <span class="voucher__icon"><AppIcon name="drink" :size="20" /></span>
              <span class="voucher__cost caption">{{ reward.cost }} pts</span>
            </div>
            <h3 class="title-md">{{ reward.offer }}</h3>
            <p class="caption-sm text-muted">{{ reward.cafe }}</p>
            <AppButton v-if="reward.cost <= points" variant="secondary" small @click="confirming = reward">Redeem</AppButton>
            <AppButton v-else variant="secondary" small disabled>{{ reward.cost - points }} points short</AppButton>
          </li>
        </ul>
      </section>

      <section v-if="groups.redemptions.length" class="section" aria-labelledby="mine-head">
        <h2 id="mine-head" class="display-sm">Your vouchers</h2>
        <ul class="stack">
          <li v-for="r in groups.redemptions" :key="r.id" class="code-row">
            <span class="stack">
              <span class="title-sm">{{ r.reward.offer }}</span>
              <span class="caption-sm text-muted">{{ r.reward.cafe }}</span>
            </span>
            <code class="code">{{ r.code }}</code>
          </li>
        </ul>
      </section>
    </div>

    <ModalDialog :open="!!confirming" :title="confirming ? `Redeem ${confirming.cost} points?` : ''" @update:open="(v) => !v && (confirming = null)">
      <template #content>
        <p v-if="confirming" class="body-md">{{ confirming.offer }} · {{ confirming.cafe }}</p>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
      </template>
      <AppButton block :disabled="busy" @click="redeem">Redeem</AppButton>
      <AppButton block variant="secondary" @click="confirming = null">Not now</AppButton>
    </ModalDialog>

    <ModalDialog :open="!!redeemed" title="Voucher code" @update:open="(v) => !v && (redeemed = null)">
      <template #content>
        <div v-if="redeemed" class="stack gap-sm">
          <span class="body-md">{{ redeemed.reward.offer }} · {{ redeemed.reward.cafe }}</span>
          <code class="code code--big">{{ redeemed.code }}</code>
          <span class="caption text-muted">Balance {{ redeemed.points }} points</span>
        </div>
      </template>
      <AppButton block @click="redeemed = null">Done</AppButton>
    </ModalDialog>
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
.board__pinned { position: sticky; bottom: var(--tabbar-height); margin-top: var(--spacing-sm); padding-top: var(--spacing-sm); border-top: 2px solid var(--ink); background: var(--canvas); }
@media (min-width: 1128px) { .board__pinned { bottom: 0; } }
.how { display: grid; grid-template-columns: repeat(auto-fit, minmax(200px, 1fr)); gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; }
.how li { display: flex; align-items: center; gap: var(--spacing-sm); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--rounded-md); background: var(--surface-soft); }
.how__n { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; border-radius: var(--rounded-full); background: var(--ink); color: var(--on-dark); font: var(--text-caption); }
.voucher { display: flex; flex-direction: column; gap: var(--spacing-sm); height: 100%; padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.voucher > :last-child { margin-top: auto; align-self: flex-start; }
.voucher__top { display: flex; align-items: center; justify-content: space-between; }
.voucher__icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }
.voucher__cost { padding: var(--spacing-xxs) var(--spacing-sm); border: 1px solid var(--ink); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font: var(--text-badge); }
.voucher.is-short .voucher__cost { background: var(--surface-strong); color: var(--muted); }
.code-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); min-height: 56px; border-bottom: 1px solid var(--hairline-soft); }
.code { padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-xs); background: var(--surface-strong); font: var(--text-caption); letter-spacing: 1px; }
.code--big { align-self: flex-start; padding: var(--spacing-sm) var(--spacing-base); font: var(--text-display-sm); }
</style>
