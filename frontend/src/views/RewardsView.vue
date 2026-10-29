<script setup>
// Rewards: spend JioCoins on sample café vouchers.
//   - The balance sits at the top right; the + beside it opens a small popover on how JioCoins are earned.
//   - Café vouchers, filtered by category and, with "Can claim", to the ones the balance covers. Redeeming one asks first, then shows its code and lowers the balance. A voucher that costs
//     more than the balance has a disabled Claim button, and the JioCoins that are missing are written beside it.
//   - Your vouchers: every code redeemed so far, each valid for a while after it is claimed (lib/vouchers.js). A usable code has
//     "Mark as used", which asks first; a used code moves to a greyed "Used" group with the day it was used, and a code past its
//     last day to a greyed "Expired" group, where it can no longer be marked. Both groups sit below the usable codes.
import { coins } from '@/lib/currency.js'
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import CoinBadge from '@/components/ui/CoinBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import GridPulse from '@/components/ui/GridPulse.vue'
import IconButton from '@/components/ui/IconButton.vue'
import InfoTag from '@/components/ui/InfoTag.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import { useGroupsStore } from '@/stores/groups.js'
import { POINTS_PER_MEETUP } from '@/lib/mock/people.js'
import { REWARD_CATEGORIES } from '@/lib/mock/rewards.js'
import { vRadioGroup } from '@/lib/radioGroup.js'
import { useNow } from '@/lib/useNow.js'
import { dayLabel, voucherGroups } from '@/lib/vouchers.js'

const groups = useGroupsStore()
const confirming = ref(null)
const redeemed = ref(null)
const busy = ref(false)
const error = ref('')
// The "Earn more" popover under the + beside the balance. It closes on Escape and on a click outside it.
const earning = ref(false)
const balanceBox = ref(null)
function closeOutside(event) {
  if (earning.value && !balanceBox.value?.contains(event.target)) earning.value = false
}
function closeOnEscape(event) {
  if (earning.value && event.key === 'Escape') earning.value = false
}

onMounted(() => {
  document.addEventListener('pointerdown', closeOutside)
  document.addEventListener('keydown', closeOnEscape)
  return Promise.all([groups.loadLeaderboard(), groups.loadSeason(), groups.loadRewards()])
})
onBeforeUnmount(() => {
  document.removeEventListener('pointerdown', closeOutside)
  document.removeEventListener('keydown', closeOnEscape)
})

const points = computed(() => groups.me?.points ?? 0)
const prize = computed(() => groups.season?.prize ?? 500)

// The filter: one category (or all), and optionally only the vouchers the balance covers.
const category = ref('all')
const claimable = ref(false)
const categories = computed(() => REWARD_CATEGORIES.filter((c) => groups.rewards.some((r) => r.category === c.id)))
const shownRewards = computed(() =>
  groups.rewards.filter((r) => (category.value === 'all' || r.category === category.value) && (!claimable.value || r.cost <= points.value)),
)
const iconFor = (reward) => REWARD_CATEGORIES.find((c) => c.id === reward.category)?.icon || 'drink'

// The claimed codes, usable first, then used, then expired, on a clock that moves so a code greys out once its last day passes.
const now = useNow()
const mine = computed(() => voucherGroups(groups.redemptions, now.value))
// The code being marked as used, while "Mark as used?" asks.
const using = ref(null)
const useBusy = ref(false)
const useError = ref('')

// Asks before a code is marked as used. How to call: askUse(redemption)
function askUse(redemption) {
  useError.value = ''
  using.value = redemption
}

// Marks the code in the dialog as used, then closes it; a refusal (it expired meanwhile, say) stays in the dialog.
// How to call: await markUsed()
async function markUsed() {
  useBusy.value = true
  useError.value = ''
  try {
    await groups.markUsed(using.value.id)
    using.value = null
  } catch (e) {
    useError.value = e.message
  }
  useBusy.value = false
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
  <main class="screen grid-page" data-testid="rewards-view">
    <GridPulse class="page-grid" />
    <header class="screen__header rewards__header">
      <div class="stack">
        <h1 class="display-xl" data-grid-avoid>Rewards</h1>
        <p class="body-sm text-muted">Spend your <CoinBadge /> on sample café vouchers.</p>
      </div>
      <!-- The balance, and a + that opens how to earn more just under it. -->
      <div ref="balanceBox" class="balance">
        <span class="balance__pill">
          <CoinBadge class="balance__value" :amount="points" />
          <IconButton class="balance__more" label="How to earn more" :aria-expanded="String(earning)" aria-controls="earn-more" @click="earning = !earning">
            <AppIcon :name="earning ? 'close' : 'plus'" :size="16" />
          </IconButton>
        </span>
        <Transition name="pop">
          <div v-if="earning" id="earn-more" class="earn-pop" role="dialog" aria-labelledby="earn-more-head">
            <p id="earn-more-head" class="title-sm">Earn more</p>
            <ul class="earn">
              <li><span class="earn__icon"><AppIcon name="check" :size="14" /></span><span class="body-sm"><strong><CoinBadge :amount="POINTS_PER_MEETUP" /></strong> for every meetup you finish</span></li>
              <li><span class="earn__icon"><AppIcon name="trophy" :size="14" /></span><span class="body-sm"><strong><CoinBadge :amount="prize" /></strong> for first place when a leaderboard season ends</span></li>
            </ul>
            <AppButton small block to="/sessions/new">Start a meetup</AppButton>
          </div>
        </Transition>
      </div>
    </header>

    <div class="screen__body">
      <section class="section" aria-labelledby="vouchers-head">
        <div class="section__head">
          <h2 id="vouchers-head" class="display-sm">Café vouchers</h2>
        </div>
        <div v-if="groups.rewards.length" class="filters">
          <div class="scroll-x" role="radiogroup" v-radio-group aria-label="Voucher category">
            <ChipButton radio :selected="category === 'all'" @click="category = 'all'">All</ChipButton>
            <ChipButton v-for="c in categories" :key="c.id" radio :selected="category === c.id" @click="category = c.id">{{ c.label }}</ChipButton>
          </div>
          <ChipButton check :selected="claimable" @click="claimable = !claimable">Can claim</ChipButton>
        </div>
        <div v-if="groups.loading.rewards && !groups.rewards.length" class="grid-3">
          <SkeletonRow v-for="n in 3" :key="n" />
        </div>
        <EmptyState v-else-if="!groups.rewards.length" title="No vouchers right now" text="New café vouchers show up here." />
        <EmptyState v-else-if="!shownRewards.length" title="Nothing matches" :text="claimable ? 'None of these are within your balance yet.' : 'No vouchers in this category right now.'">
          <AppButton variant="secondary" small @click="(category = 'all'), (claimable = false)">Show all vouchers</AppButton>
        </EmptyState>
        <ul v-else class="grid-3">
          <li v-for="(reward, i) in shownRewards" :key="reward.id" class="voucher rise" :class="{ 'is-short': reward.cost > points }" :style="{ '--i': i }">
            <div class="voucher__top">
              <span class="voucher__icon"><AppIcon :name="iconFor(reward)" :size="20" /></span>
              <CoinBadge class="voucher__cost caption" :amount="reward.cost" />
            </div>
            <h3 class="title-md">{{ reward.offer }}</h3>
            <p class="caption-sm text-muted">{{ reward.cafe }}</p>
            <div class="voucher__action">
              <AppButton v-if="reward.cost <= points" small @click="confirming = reward">Claim</AppButton>
              <template v-else>
                <AppButton variant="secondary" small disabled :aria-describedby="`short-${reward.id}`">Claim</AppButton>
                <span :id="`short-${reward.id}`" class="caption voucher__short"><CoinBadge :amount="reward.cost - points" /> short</span>
              </template>
            </div>
          </li>
        </ul>
      </section>

      <section v-if="groups.redemptions.length" class="section" aria-labelledby="mine-head">
        <h2 id="mine-head" class="display-sm">Your vouchers</h2>
        <p v-if="!mine.usable.length" class="body-sm text-muted" data-testid="no-usable-vouchers">No codes to use right now.</p>
        <ul v-else class="stack" data-testid="usable-vouchers">
          <li v-for="r in mine.usable" :key="r.id" class="code-row">
            <span class="stack">
              <span class="title-sm">{{ r.reward?.offer }}</span>
              <span class="caption-sm text-muted">{{ r.reward?.cafe }}</span>
              <span v-if="r.validUntil" class="caption-sm text-muted">Valid until {{ dayLabel(r.validUntil) }}</span>
            </span>
            <span class="code-row__end">
              <code class="code">{{ r.code }}</code>
              <AppButton variant="secondary" small @click="askUse(r)">Mark as used</AppButton>
            </span>
          </li>
        </ul>

        <template v-if="mine.used.length">
          <h3 id="used-head" class="title-md code-group">Used</h3>
          <ul class="stack" aria-labelledby="used-head" data-testid="used-vouchers">
            <li v-for="r in mine.used" :key="r.id" class="code-row is-done">
              <span class="stack">
                <span class="title-sm">{{ r.reward?.offer }}</span>
                <span class="caption-sm">{{ r.reward?.cafe }}</span>
                <span class="caption-sm">Used on {{ dayLabel(r.usedAt) }}</span>
              </span>
              <span class="code-row__end">
                <code class="code">{{ r.code }}</code>
                <InfoTag>Used</InfoTag>
              </span>
            </li>
          </ul>
        </template>

        <template v-if="mine.expired.length">
          <h3 id="expired-head" class="title-md code-group">Expired</h3>
          <ul class="stack" aria-labelledby="expired-head" data-testid="expired-vouchers">
            <li v-for="r in mine.expired" :key="r.id" class="code-row is-done">
              <span class="stack">
                <span class="title-sm">{{ r.reward?.offer }}</span>
                <span class="caption-sm">{{ r.reward?.cafe }}</span>
                <span class="caption-sm">Was valid until {{ dayLabel(r.validUntil) }}</span>
              </span>
              <span class="code-row__end">
                <code class="code">{{ r.code }}</code>
                <InfoTag>Expired</InfoTag>
              </span>
            </li>
          </ul>
        </template>
      </section>
    </div>

    <ModalDialog :open="!!confirming" :title="confirming ? `Claim for ${coins(confirming.cost)}?` : ''" @update:open="(v) => !v && (confirming = null)">
      <template #content>
        <p v-if="confirming" class="body-md">{{ confirming.offer }} · {{ confirming.cafe }}</p>
        <p v-if="confirming" class="caption text-muted">You will have <CoinBadge :amount="points - confirming.cost" /> left.</p>
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
          <span v-if="redeemed.validUntil" class="body-sm">Valid until {{ dayLabel(redeemed.validUntil) }}</span>
          <span class="caption text-muted">A demo code only. Balance <CoinBadge :amount="redeemed.points" />.</span>
        </div>
      </template>
      <AppButton block @click="redeemed = null">Done</AppButton>
    </ModalDialog>

    <ModalDialog :open="!!using" title="Mark as used?" @update:open="(v) => !v && (using = null)">
      <template #content>
        <div v-if="using" class="stack gap-sm">
          <span class="body-md">{{ using.reward?.offer }} · {{ using.reward?.cafe }}</span>
          <code class="code">{{ using.code }}</code>
          <span class="caption text-muted">Do this once the café has taken the code. It moves to Used and cannot be undone.</span>
        </div>
        <p v-if="useError" class="body-sm text-error" role="alert">{{ useError }}</p>
      </template>
      <AppButton block :disabled="useBusy" @click="markUsed">Mark as used</AppButton>
      <AppButton block variant="secondary" @click="using = null">Not now</AppButton>
    </ModalDialog>
  </main>
</template>

<style scoped>
/* The balance: top right, beside the title. */
.rewards__header { flex-direction: row; align-items: flex-start; justify-content: space-between; gap: var(--spacing-md); }
.balance { position: relative; flex: none; }
/* Above the page body, so the popover opens over the vouchers. */
.grid-page > .rewards__header { z-index: 2; }
.balance__pill { display: inline-flex; align-items: center; gap: var(--spacing-sm); padding: 4px 4px 4px var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-full); background: var(--canvas); }
.balance__value { color: var(--primary); font: 700 22px/1 var(--font-sans); letter-spacing: -0.01em; }
.balance__more { width: 36px; height: 36px; min-width: 36px; background: var(--primary); color: var(--on-primary); }
/* How to earn more: a small card that pops out under the +, over the page. */
.earn-pop { position: absolute; top: calc(100% + 8px); right: 0; display: flex; flex-direction: column; gap: var(--spacing-md); width: min(300px, calc(100vw - var(--gutter) * 2)); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); box-shadow: var(--shadow-float); transform-origin: top right; }
.pop-enter-active { transition: opacity 160ms var(--ease-out), transform 220ms var(--ease-spring); }
.pop-leave-active { transition: opacity 120ms var(--ease-out), transform 120ms var(--ease-out); }
.pop-enter-from, .pop-leave-to { opacity: 0; transform: scale(0.92) translateY(-4px); }
@media (prefers-reduced-motion: reduce) { .pop-enter-active, .pop-leave-active { transition: none; } }
.filters { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-xs) var(--spacing-md); margin-bottom: var(--spacing-base); }
.filters .scroll-x { min-width: 0; flex: 1 1 auto; }
.earn { display: flex; flex-direction: column; gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; }
.earn li { display: flex; align-items: center; gap: var(--spacing-sm); }
.earn__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }

.voucher { display: flex; flex-direction: column; gap: var(--spacing-sm); height: 100%; padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.voucher > :last-child { margin-top: auto; }
.voucher__action { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm) var(--spacing-md); }
.voucher__short { color: var(--muted); }
.voucher__top { display: flex; align-items: center; justify-content: space-between; }
.voucher__icon { display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--cat-drink-bg); color: var(--cat-drink-fg); }
.voucher__cost { padding: var(--spacing-xxs) var(--spacing-sm); border: 1px solid var(--ink); border-radius: var(--rounded-full); background: var(--canvas); color: var(--ink); font: var(--text-badge); }
.voucher.is-short .voucher__cost { border-color: var(--hairline); background: var(--surface-strong); color: var(--muted); }
.code-row { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-sm) var(--spacing-md); min-height: 56px; padding: var(--spacing-sm) 0; border-bottom: 1px solid var(--hairline-soft); }
.code-row__end { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm); }
/* Used and expired codes: greyed, still readable (muted is 5.4:1 on white), the code struck through so it is not read out at a till. */
.code-row.is-done { color: var(--muted); }
.code-row.is-done .code { color: var(--muted); text-decoration: line-through; }
.code-group { margin-top: var(--spacing-lg); color: var(--muted); }
.code { padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-xs); background: var(--surface-strong); font: var(--text-caption); letter-spacing: 1px; }
.code--big { align-self: flex-start; padding: var(--spacing-sm) var(--spacing-base); font: var(--text-display-sm); }
</style>
