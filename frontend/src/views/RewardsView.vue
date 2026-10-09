<script setup>
// Rewards: spend JioCoins on sample café vouchers. A note at the top says they are not real offers.
//   - Your JioCoins: the balance, how far to the next voucher you cannot afford yet, and how JioCoins are earned.
//   - Café vouchers: redeeming one asks first, then shows its code and lowers the balance. A voucher that costs
//     more than the balance has a disabled Claim button, and the JioCoins that are missing are written beside it.
//   - Your vouchers: every code redeemed so far.
import { coins } from '@/lib/currency.js'
import { computed, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import { useGroupsStore } from '@/stores/groups.js'
import { POINTS_PER_MEETUP } from '@/lib/mock/people.js'

const groups = useGroupsStore()
const confirming = ref(null)
const redeemed = ref(null)
const busy = ref(false)
const error = ref('')

onMounted(() => Promise.all([groups.loadLeaderboard(), groups.loadSeason(), groups.loadRewards()]))

const points = computed(() => groups.me?.points ?? 0)
const prize = computed(() => groups.season?.prize ?? 500)
// The cheapest voucher still out of reach, to show how close the next one is.
const next = computed(() => [...groups.rewards].sort((a, b) => a.cost - b.cost).find((r) => r.cost > points.value) || null)
const progress = computed(() => (next.value ? Math.min(100, Math.round((points.value / next.value.cost) * 100)) : 100))
const affordable = computed(() => groups.rewards.filter((r) => r.cost <= points.value).length)

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
  <main class="screen" data-testid="rewards-view">
    <header class="screen__header">
      <h1 class="display-xl">Rewards</h1>
      <p class="body-sm text-muted">Spend your JioCoins on sample café vouchers.</p>
    </header>

    <div class="screen__body">
      <BannerNote icon="info" data-testid="rewards-sample-note">Sample rewards for the demo. These are not real offers, and no café will accept the codes.</BannerNote>

      <!-- Your points: the balance, the next voucher, and how points are earned. -->
      <section class="wallet rise" aria-labelledby="wallet-head">
        <div class="wallet__balance">
          <h2 id="wallet-head" class="caption wallet__label">Your JioCoins</h2>
          <p class="wallet__points tnum">{{ points }}</p>
          <p class="body-sm wallet__note">
            <template v-if="next">{{ coins(next.cost - points) }} more for your next voucher: {{ next.offer }}, {{ next.cafe }}</template>
            <template v-else-if="groups.rewards.length">Enough for every voucher below</template>
          </p>
          <div v-if="next" class="wallet__bar" role="progressbar" :aria-valuenow="progress" aria-valuemin="0" aria-valuemax="100" :aria-label="`${progress}% of the way to the next voucher`">
            <span :style="{ width: `${progress}%` }" />
          </div>
        </div>
        <ul class="earn" aria-label="How to earn JioCoins">
          <li><span class="earn__icon"><AppIcon name="check" :size="16" /></span><span class="body-sm"><strong>{{ coins(POINTS_PER_MEETUP) }}</strong> for every meetup you finish</span></li>
          <li><span class="earn__icon"><AppIcon name="trophy" :size="16" /></span><span class="body-sm"><strong>{{ coins(prize) }}</strong> for first place when a leaderboard season ends</span></li>
          <li><span class="earn__icon"><AppIcon name="drink" :size="16" /></span><span class="body-sm">Claim a sample voucher below to get a demo code</span></li>
        </ul>
      </section>

      <section class="section" aria-labelledby="vouchers-head">
        <div class="section__head">
          <h2 id="vouchers-head" class="display-sm">Café vouchers</h2>
          <span v-if="groups.rewards.length" class="caption text-muted">{{ affordable }} of {{ groups.rewards.length }} within reach</span>
        </div>
        <div v-if="groups.loading.rewards && !groups.rewards.length" class="grid-3">
          <SkeletonRow v-for="n in 3" :key="n" />
        </div>
        <EmptyState v-else-if="!groups.rewards.length" title="No vouchers right now" text="New café vouchers show up here." />
        <ul v-else class="grid-3">
          <li v-for="(reward, i) in groups.rewards" :key="reward.id" class="voucher rise" :class="{ 'is-short': reward.cost > points }" :style="{ '--i': i }">
            <div class="voucher__top">
              <span class="voucher__icon"><AppIcon name="drink" :size="20" /></span>
              <span class="voucher__cost caption">{{ coins(reward.cost) }}</span>
            </div>
            <h3 class="title-md">{{ reward.offer }}</h3>
            <p class="caption-sm text-muted">{{ reward.cafe }}</p>
            <div class="voucher__action">
              <AppButton v-if="reward.cost <= points" small @click="confirming = reward">Claim</AppButton>
              <template v-else>
                <AppButton variant="secondary" small disabled :aria-describedby="`short-${reward.id}`">Claim</AppButton>
                <span :id="`short-${reward.id}`" class="caption voucher__short">{{ coins(reward.cost - points) }} short</span>
              </template>
            </div>
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

    <ModalDialog :open="!!confirming" :title="confirming ? `Claim for ${coins(confirming.cost)}?` : ''" @update:open="(v) => !v && (confirming = null)">
      <template #content>
        <p v-if="confirming" class="body-md">{{ confirming.offer }} · {{ confirming.cafe }}</p>
        <p v-if="confirming" class="caption text-muted">You will have {{ coins(points - confirming.cost) }} left.</p>
        <p v-if="error" class="body-sm text-error" role="alert">{{ error }}</p>
      </template>
      <AppButton block :disabled="busy" @click="redeem">Claim voucher</AppButton>
      <AppButton block variant="secondary" @click="confirming = null">Not now</AppButton>
    </ModalDialog>

    <ModalDialog :open="!!redeemed" title="Your voucher code" @update:open="(v) => !v && (redeemed = null)">
      <template #content>
        <div v-if="redeemed" class="stack gap-sm">
          <span class="body-md">{{ redeemed.reward.offer }} · {{ redeemed.reward.cafe }}</span>
          <code class="code code--big">{{ redeemed.code }}</code>
          <span class="caption text-muted">A demo code only. Balance {{ coins(redeemed.points) }}.</span>
        </div>
      </template>
      <AppButton block @click="redeemed = null">Done</AppButton>
    </ModalDialog>
  </main>
</template>

<style scoped>
/* Your points: the balance on a soft Rausch wash, and how points are earned beside it. */
.wallet { display: grid; grid-template-columns: minmax(0, 1fr); gap: var(--spacing-lg); padding: var(--spacing-lg); border: 1px solid var(--hairline); border-radius: var(--rounded-lg); background: linear-gradient(135deg, color-mix(in srgb, var(--primary-bright) 9%, var(--canvas)), var(--canvas) 60%); }
@media (min-width: 744px) { .wallet { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); align-items: center; } }
.wallet__balance { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.wallet__label { margin: 0; color: var(--muted); letter-spacing: 0.08em; text-transform: uppercase; }
.wallet__points { margin: 0; color: var(--primary); font: 700 64px/1 var(--font-sans); letter-spacing: -0.03em; }
.wallet__note { margin: var(--spacing-xs) 0 0; color: var(--body); }
.wallet__bar { height: 8px; margin-top: var(--spacing-sm); overflow: hidden; border-radius: var(--rounded-full); background: color-mix(in srgb, var(--primary-bright) 14%, var(--canvas)); }
.wallet__bar > span { display: block; height: 100%; border-radius: inherit; background: var(--primary); transition: width 600ms var(--ease-out); }
.earn { display: flex; flex-direction: column; gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; }
.earn li { display: flex; align-items: center; gap: var(--spacing-md); padding: var(--spacing-sm) var(--spacing-md); border-radius: var(--rounded-md); background: var(--canvas); border: 1px solid var(--hairline-soft); }
.earn__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 32px; height: 32px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }

.voucher { display: flex; flex-direction: column; gap: var(--spacing-sm); height: 100%; padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.voucher > :last-child { margin-top: auto; }
.voucher__action { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm) var(--spacing-md); }
.voucher__short { color: var(--muted); }
.voucher__top { display: flex; align-items: center; justify-content: space-between; }
.voucher__icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--cat-drink-bg); color: var(--cat-drink-fg); }
.voucher__cost { padding: var(--spacing-xxs) var(--spacing-sm); border: 1px solid var(--ink); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font: var(--text-badge); }
.voucher.is-short .voucher__cost { border-color: var(--hairline); background: var(--surface-strong); color: var(--muted); }
.code-row { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); min-height: 56px; border-bottom: 1px solid var(--hairline-soft); }
.code { padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-xs); background: var(--surface-strong); font: var(--text-caption); letter-spacing: 1px; }
.code--big { align-self: flex-start; padding: var(--spacing-sm) var(--spacing-base); font: var(--text-display-sm); }
</style>
