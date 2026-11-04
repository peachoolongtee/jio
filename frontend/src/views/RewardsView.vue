<script setup>
// Rewards: spend JioCoins on sample café vouchers.
//   - The balance sits at the top right; the + beside it opens a small popover on how JioCoins are earned.
//   - Café vouchers, filtered by category and, with "Can claim", to the ones the balance covers that hold no code to use. Each card has
//     its price at the bottom, beside its action (Faith, 4 November 2026):
//       Not claimed   "Claim", or "Claim again" when the last code was used or ran out. A Claim that the balance does not cover is greyed,
//                     with the JioCoins that are missing under the price.
//       Holding a code "Claimed", until that code is used or runs out.
//     Claiming asks first, then shows the code and lowers the balance. Every button on the page is the same round pill.
//   - Your vouchers, at the bottom: every code claimed, and the only place a code is listed. Codes to use come first, with their last day, the
//     code to copy and "Mark as used", which asks first; used and expired ones follow, greyed, with the code struck through. Each code is
//     valid for a while after it is claimed (lib/vouchers.js). After a code is marked, focus goes to the heading (the button that opened
//     the dialog is gone) and a polite live region says "Marked as used".
import { coins } from '@/lib/currency.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import CoinBadge from '@/components/ui/CoinBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import GridPulse from '@/components/ui/GridPulse.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import { useGroupsStore } from '@/stores/groups.js'
import { POINTS_PER_MEETUP } from '@/lib/mock/people.js'
import { REWARD_CATEGORIES } from '@/lib/mock/rewards.js'
import { vRadioGroup } from '@/lib/radioGroup.js'
import { useNow } from '@/lib/useNow.js'
import { dayLabel, validUntilOf, voucherGroups, voucherState } from '@/lib/vouchers.js'
import CopyCode from '@/components/ui/CopyCode.vue'

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
  groups.rewards.filter((r) => (category.value === 'all' || r.category === category.value) && (!claimable.value || (r.cost <= points.value && !holdsCode(r)))),
)
const iconFor = (reward) => REWARD_CATEGORIES.find((c) => c.id === reward?.category)?.icon || 'drink'
// Whether a voucher holds a code still to use. How to call: holdsCode(reward) -> true
const holdsCode = (reward) => groups.redemptions.some((r) => r.rewardId === reward.id && voucherState(r, now.value) === 'usable')
// Whether a voucher has been claimed before, so its button says "Claim again". How to call: claimedBefore(reward) -> false
const claimedBefore = (reward) => groups.redemptions.some((r) => r.rewardId === reward.id)
const claimWord = (reward) => (claimedBefore(reward) ? 'Claim again' : 'Claim')
// A voucher the balance does not cover, and that holds no code. How to call: isShort(reward) -> true
const isShort = (reward) => reward.cost > points.value && !holdsCode(reward)

// The claimed codes, usable first, then used, then expired, on a clock that moves so a code greys out once its last day passes.
const now = useNow()
const mine = computed(() => voucherGroups(groups.redemptions, now.value))
// Your vouchers as one list, codes to use first, with the line each row shows. How to call: myVouchers.value -> [{ id, state, line, ... }]
const myVouchers = computed(() => [
  ...mine.value.usable.map((r) => ({ ...r, state: 'usable', line: validUntilOf(r) ? `Use by ${dayLabel(validUntilOf(r))}` : 'Ready to use' })),
  ...mine.value.used.map((r) => ({ ...r, state: 'used', line: `Used on ${dayLabel(r.usedAt)}` })),
  ...mine.value.expired.map((r) => ({ ...r, state: 'expired', line: `Expired on ${dayLabel(validUntilOf(r))}` })),
])
// The code being marked as used, while "Mark as used?" asks.
const using = ref(null)
const useBusy = ref(false)
const useError = ref('')
// The words for a screen reader after a code is marked, and the "Your vouchers" heading that takes focus then.
const announcement = ref('')
const mineHead = ref(null)

// Asks before a code is marked as used. How to call: askUse(redemption)
function askUse(redemption) {
  useError.value = ''
  using.value = redemption
}

// Marks the code in the dialog as used, then closes it; a refusal (it expired meanwhile, say) stays in the dialog. The button that
// opened the dialog leaves the page with the code, so focus goes to the "Your vouchers" heading once the page has redrawn, and the live
// region says what happened (cleared first, so a second code is announced too).
// How to call: await markUsed()
async function markUsed() {
  useBusy.value = true
  useError.value = ''
  try {
    await groups.markUsed(using.value.id)
    using.value = null
    announcement.value = ''
    await nextTick()
    mineHead.value?.focus()
    announcement.value = 'Marked as used'
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

// Closes the dialog that shows a new code. The Claim button that opened it is gone (the card now says "Claimed"), so focus goes to the
// heading of the list the code is in, without moving the page. How to call: closeRedeemed()
async function closeRedeemed() {
  redeemed.value = null
  await nextTick()
  mineHead.value?.focus({ preventScroll: true })
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
            <AppButton variant="pill" class="rewards__pill" block to="/sessions/new">Start a meetup</AppButton>
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
        <EmptyState v-else-if="!shownRewards.length" title="Nothing matches" :text="claimable ? 'Nothing here you can claim yet: you hold its code already, or it is more than your balance.' : 'No vouchers in this category right now.'" />
        <ul v-else class="grid-3">
          <li v-for="(reward, i) in shownRewards" :key="reward.id" class="voucher rise" :class="{ 'is-short': isShort(reward) }" :style="{ '--i': i }" data-testid="voucher-card">
            <span class="voucher__icon"><AppIcon :name="iconFor(reward)" :size="20" /></span>
            <h3 class="title-md">{{ reward.offer }}</h3>
            <p class="caption-sm text-muted">{{ reward.cafe }}</p>
            <div class="voucher__foot">
              <span class="voucher__price">
                <CoinBadge class="voucher__cost" :amount="reward.cost" />
                <span v-if="isShort(reward)" :id="`short-${reward.id}`" class="caption-sm voucher__short"><CoinBadge :amount="reward.cost - points" /> short</span>
              </span>
              <span v-if="holdsCode(reward)" class="state-pill" data-testid="voucher-held">Claimed</span>
              <AppButton v-else-if="!isShort(reward)" variant="pill" class="rewards__pill" @click="confirming = reward">{{ claimWord(reward) }}</AppButton>
              <AppButton v-else variant="secondary" small disabled :aria-describedby="`short-${reward.id}`">{{ claimWord(reward) }}</AppButton>
            </div>
          </li>
        </ul>
      </section>

      <p class="sr-only" role="status" data-testid="voucher-status">{{ announcement }}</p>
      <!-- Every code claimed, codes to use first; a code is listed here and nowhere else. -->
      <section v-if="myVouchers.length" class="section" aria-labelledby="mine-head">
        <h2 id="mine-head" ref="mineHead" class="display-sm mine__head" tabindex="-1">Your vouchers</h2>
        <ul class="mine" data-testid="my-vouchers">
          <li v-for="r in myVouchers" :key="r.id" class="mine__row" :class="{ 'is-done': r.state !== 'usable' }" :data-testid="`voucher-${r.state}`">
            <span class="voucher__icon"><AppIcon :name="iconFor(r.reward)" :size="20" /></span>
            <div class="mine__main">
              <h3 class="title-sm">{{ r.reward?.offer }}</h3>
              <p class="caption-sm mine__muted">{{ r.reward?.cafe }}</p>
              <p class="caption-sm mine__muted">{{ r.line }}</p>
              <CopyCode v-if="r.state === 'usable'" :code="r.code" :label="r.reward?.offer" />
              <code v-else class="code">{{ r.code }}</code>
            </div>
            <AppButton v-if="r.state === 'usable'" variant="secondary" small data-testid="mark-used" @click="askUse(r)">Mark as used</AppButton>
            <span v-else class="state-pill">{{ r.state === 'used' ? 'Used' : 'Expired' }}</span>
          </li>
        </ul>
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

    <ModalDialog :open="!!redeemed" title="Your voucher code" @update:open="(v) => !v && closeRedeemed()">
      <template #content>
        <div v-if="redeemed" class="stack gap-sm">
          <span class="body-md">{{ redeemed.reward.offer }} · {{ redeemed.reward.cafe }}</span>
          <code class="code code--big">{{ redeemed.code }}</code>
          <span v-if="redeemed.validUntil" class="body-sm">Valid until {{ dayLabel(redeemed.validUntil) }}</span>
          <span class="caption text-muted">A demo code only.</span>
        </div>
      </template>
      <AppButton block @click="closeRedeemed">Done</AppButton>
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
      <AppButton block variant="secondary" @click="using = null">Not now</AppButton>
      <AppButton block :disabled="useBusy" @click="markUsed">Mark as used</AppButton>
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
.voucher__icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--cat-drink-bg); color: var(--cat-drink-fg); }
/* The price and the action share the bottom of the card, so cards of different heights still line up. */
.voucher__foot { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-sm) var(--spacing-md); margin-top: auto; padding-top: var(--spacing-sm); }
.voucher__price { display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
.voucher__cost { color: var(--ink); font: 600 16px/1.25 var(--font-sans); }
.voucher.is-short .voucher__cost { color: var(--muted); }
.voucher__short { color: var(--muted); }
/* The main action as a pill, with the same weight as the greyed Claim beside it. */
.rewards__pill { font-weight: 600; }
/* A state, not a button: the shape of the buttons around it, in grey. Muted on this grey is over 4.5:1, so it stays readable. */
.state-pill { flex: none; display: inline-flex; align-items: center; height: var(--tap-min); padding: 0 20px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--muted); font: var(--text-button-sm); font-weight: 600; }
/* Your vouchers: one card a code, as many across as fit. */
.mine { display: grid; grid-template-columns: repeat(auto-fill, minmax(min(100%, 420px), 1fr)); gap: var(--spacing-md); margin: 0; padding: 0; list-style: none; }
.mine__head:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-xs); }
.mine__row { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-sm) var(--spacing-md); padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.mine__row > :last-child { margin-left: auto; }
.mine__main { flex: 1 1 140px; display: flex; flex-direction: column; align-items: flex-start; gap: var(--spacing-xxs); min-width: 0; }
.mine__muted { color: var(--muted); }
.mine__main .code, .mine__main .copy-code { margin-top: var(--spacing-xs); }
/* Used and expired codes: greyed, still readable (muted is 5.4:1 on white), the code struck through so it is not read out at a till. */
.mine__row.is-done { background: var(--surface-soft); color: var(--muted); }
.mine__row.is-done .voucher__icon { background: var(--surface-strong); color: var(--muted); }
.mine__row.is-done .code { color: var(--muted); text-decoration: line-through; }
.code { padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-xs); background: var(--surface-strong); font: var(--text-caption); letter-spacing: 1px; }
.code--big { align-self: flex-start; padding: var(--spacing-sm) var(--spacing-base); font: var(--text-display-sm); }
</style>
