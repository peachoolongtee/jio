<script setup>
// Rewards: spend JioCoins on sample café vouchers.
//   - The balance sits at the top right; the + beside it opens a small popover on how JioCoins are earned.
//   - One white card holds both lists, with every voucher a card nested in it (Faith, 4 November 2026). At its top a two-way switch,
//     "Vouchers" and "Your vouchers" (with a red badge of how many codes are ready to use), and a red streak runs round its border
//     (BorderTrail). The switch moved into the card from above it, and "Café vouchers" became "Vouchers" (Darius, 4 November 2026).
//   - Vouchers, filtered by category and, with "Can claim", to the ones the balance covers that hold no code to use. Each card has
//     its price at the bottom, beside its action:
//       Not claimed   "Claim", also once the last code was used or ran out. A Claim that the balance does not cover is greyed,
//                     with the JioCoins that are missing under the price.
//       Holding a code "Claimed", until that code is used or runs out.
//     Claiming asks first, then shows the code and lowers the balance. Every button on the page is the same round pill.
//   - Your vouchers: every code claimed, as rows that show no code. Codes to use come first with "Use now"; used and expired ones follow,
//     greyed. Each code is valid for a while after it is claimed (lib/vouchers.js).
//   - Pressing any voucher opens its details in a sheet: what it costs, its dates, the code if you hold one, and the terms. The sheet's
//     button claims it or marks it as used, each of which asks first. After a code is marked, focus goes to the list's heading (the button
//     that opened the dialog is gone) and a polite live region says "Marked as used".
import { coins } from '@/lib/currency.js'
import { computed, nextTick, onBeforeUnmount, onMounted, ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import CoinBadge from '@/components/ui/CoinBadge.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import GridPulse from '@/components/ui/GridPulse.vue'
import BorderTrail from '@/components/ui/BorderTrail.vue'
import IconButton from '@/components/ui/IconButton.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import { useGroupsStore } from '@/stores/groups.js'
import { POINTS_PER_MEETUP } from '@/lib/mock/people.js'
import { REWARD_CATEGORIES } from '@/lib/mock/rewards.js'
import { vRadioGroup } from '@/lib/radioGroup.js'
import { useNow } from '@/lib/useNow.js'
import { VOUCHER_VALID_DAYS, dayLabel, validUntilOf, voucherGroups, voucherState, voucherTerms } from '@/lib/vouchers.js'
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
// The claim button's word: always "Claim". Once a code is used or runs out the voucher is simply claimable again, with no "Claim again"
// (Darius, 4 November 2026). How to call: claimWord(reward) -> 'Claim'
const claimWord = () => 'Claim'
// A voucher the balance does not cover, and that holds no code. How to call: isShort(reward) -> true
const isShort = (reward) => reward.cost > points.value && !holdsCode(reward)

// The claimed codes, usable first, then used, then expired, on a clock that moves so a code greys out once its last day passes.
const now = useNow()
const mine = computed(() => voucherGroups(groups.redemptions, now.value))
// Your vouchers as one list, codes to use first, with the date each row shows. How to call: myVouchers.value -> [{ id, state, dateLabel, day, line, ... }]
const dated = (r, state, dateLabel, day) => ({ ...r, state, dateLabel, day, line: `${dateLabel} ${day}` })
const myVouchers = computed(() => [
  ...mine.value.usable.map((r) => (validUntilOf(r) ? dated(r, 'usable', 'Use by', dayLabel(validUntilOf(r))) : { ...r, state: 'usable', dateLabel: 'Status', day: 'Ready to use', line: 'Ready to use' })),
  ...mine.value.used.map((r) => dated(r, 'used', 'Used on', dayLabel(r.usedAt))),
  ...mine.value.expired.map((r) => dated(r, 'expired', 'Expired on', dayLabel(validUntilOf(r)))),
])
// The tab showing: the vouchers to claim, or the ones you claimed.
const tab = ref('shop')
const tabs = computed(() => {
  const ready = mine.value.usable.length
  return [{ id: 'shop', label: 'Vouchers', count: 0 }, { id: 'mine', label: 'Your vouchers', count: ready }]
})

// The voucher whose details are open: { reward, voucher }, where voucher is the claim shown, if any.
const detail = ref(null)
const detailOpen = computed({ get: () => !!detail.value, set: (open) => { if (!open) detail.value = null } })
const detailState = computed(() => detail.value?.voucher?.state || 'new')
// Details from a card: the code still to use, if the voucher holds one. How to call: openCard(reward)
function openCard(reward) {
  detail.value = { reward, voucher: myVouchers.value.find((r) => r.rewardId === reward.id && r.state === 'usable') || null }
}
// Details from a row of Your vouchers. How to call: openMine(voucher)
function openMine(voucher) {
  detail.value = { reward: voucher.reward, voucher }
}
// The sheet closes first, so focus is back on the page before the dialog that asks takes it. How to call: await claimFromDetail()
async function claimFromDetail() {
  const { reward } = detail.value
  detail.value = null
  await nextTick()
  error.value = ''
  confirming.value = reward
}
// How to call: await useFromDetail()
async function useFromDetail() {
  const { voucher } = detail.value
  detail.value = null
  await nextTick()
  askUse(voucher)
}
// The code being marked as used, while "Mark as used?" asks.
const using = ref(null)
const useBusy = ref(false)
const useError = ref('')
// The words for a screen reader after a code is marked, and the heading of the list showing, which takes focus then.
const announcement = ref('')
const listHead = ref(null)

// Asks before a code is marked as used. How to call: askUse(redemption)
function askUse(redemption) {
  useError.value = ''
  using.value = redemption
}

// Marks the code in the dialog as used, then closes it; a refusal (it expired meanwhile, say) stays in the dialog. The button that
// opened the dialog leaves the page with the code, so focus goes to the list's heading once the page has redrawn, and the live
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
    listHead.value?.focus()
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
// list's heading, without moving the page. How to call: closeRedeemed()
async function closeRedeemed() {
  redeemed.value = null
  await nextTick()
  listHead.value?.focus({ preventScroll: true })
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
      <!-- One card for both lists: the switch at its top, and a red streak running round its border. -->
      <div class="rewards__card">
      <BorderTrail :size="120" :width="2" :duration="6" background="linear-gradient(to left, var(--primary-disabled), var(--primary), var(--primary-disabled))" />
      <div class="switch" role="group" aria-label="Which vouchers">
        <button v-for="t in tabs" :key="t.id" type="button" class="switch__tab" :class="{ 'is-active': tab === t.id }" :aria-pressed="String(tab === t.id)" :aria-label="t.count ? `${t.label}, ${t.count} ready to use` : undefined" @click="tab = t.id">
          <AppIcon :name="t.id === 'shop' ? 'gift' : 'coin'" :size="18" />{{ t.label }}<span v-if="t.count" class="switch__badge tnum" aria-hidden="true">{{ t.count }}</span>
        </button>
      </div>
      <section v-if="tab === 'shop'" class="section rewards__panel" aria-labelledby="vouchers-head">
        <h2 id="vouchers-head" ref="listHead" class="sr-only" tabindex="-1">Vouchers</h2>
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
            <h3 class="title-md"><button type="button" class="voucher__open" data-testid="voucher-open" @click="openCard(reward)">{{ reward.offer }}</button></h3>
            <p class="caption-sm text-muted">{{ reward.cafe }}</p>
            <div class="voucher__foot">
              <span class="voucher__price">
                <CoinBadge class="voucher__cost" :amount="reward.cost" />
                <span v-if="isShort(reward)" :id="`short-${reward.id}`" class="caption-sm voucher__short"><CoinBadge :amount="reward.cost - points" /> short</span>
              </span>
              <span v-if="holdsCode(reward)" class="state-pill" data-testid="voucher-held">Claimed</span>
              <AppButton v-else-if="!isShort(reward)" variant="pill" class="rewards__pill voucher__action" @click="confirming = reward">{{ claimWord(reward) }}</AppButton>
              <AppButton v-else variant="secondary" class="voucher__action" small disabled :aria-describedby="`short-${reward.id}`">{{ claimWord(reward) }}</AppButton>
            </div>
          </li>
        </ul>
      </section>

      <!-- Every code claimed, codes to use first. A row shows no code: pressing it opens the details. -->
      <section v-else class="section rewards__panel" aria-labelledby="mine-head">
        <h2 id="mine-head" ref="listHead" class="sr-only" tabindex="-1">Your vouchers</h2>
        <EmptyState v-if="!myVouchers.length" title="No vouchers yet" text="Vouchers you claim show up here." />
        <ul v-else class="grid-3" data-testid="my-vouchers">
          <li v-for="r in myVouchers" :key="r.id">
            <button type="button" class="my-voucher" :class="{ 'is-done': r.state !== 'usable' }" :data-testid="`voucher-${r.state}`" @click="openMine(r)">
              <span class="voucher__icon"><AppIcon :name="iconFor(r.reward)" :size="20" /></span>
              <span class="my-voucher__text">
                <span class="title-sm">{{ r.reward?.offer }}</span>
                <span class="caption-sm voucher__muted">{{ r.reward?.cafe }}</span>
                <span class="caption-sm voucher__muted">{{ r.line }}</span>
              </span>
              <span class="state-pill" :class="{ 'state-pill--go': r.state === 'usable' }">{{ r.state === 'usable' ? 'Use now' : r.state === 'used' ? 'Used' : 'Expired' }}</span>
            </button>
          </li>
        </ul>
      </section>
      </div>
      <p class="sr-only" role="status" data-testid="voucher-status">{{ announcement }}</p>
    </div>

    <!-- A voucher's details. -->
    <BottomSheet v-model:open="detailOpen" :title="detail?.reward?.offer || ''">
      <div v-if="detail" class="detail" data-testid="voucher-detail">
        <p class="detail__place">
          <span class="voucher__icon"><AppIcon :name="iconFor(detail.reward)" :size="20" /></span>
          <span class="body-md">{{ detail.reward?.cafe }}</span>
        </p>
        <dl class="detail__facts">
          <div><dt class="caption-sm voucher__muted">JioCoins</dt><dd class="title-sm"><CoinBadge :amount="detail.reward?.cost" /></dd></div>
          <div v-if="detail.voucher"><dt class="caption-sm voucher__muted">{{ detail.voucher.dateLabel }}</dt><dd class="title-sm">{{ detail.voucher.day }}</dd></div>
          <div v-else><dt class="caption-sm voucher__muted">Valid for</dt><dd class="title-sm">{{ VOUCHER_VALID_DAYS }} days after claiming</dd></div>
        </dl>
        <CopyCode v-if="detailState === 'usable'" :code="detail.voucher.code" :label="detail.reward?.offer" />
        <code v-else-if="detail.voucher" class="code code--done">{{ detail.voucher.code }}</code>
        <div class="stack gap-sm">
          <h3 class="title-sm">Details</h3>
          <ul class="detail__terms body-sm"><li v-for="line in voucherTerms(detail.reward)" :key="line">{{ line }}</li></ul>
        </div>
        <p v-if="detailState === 'new' && isShort(detail.reward)" class="caption voucher__short"><CoinBadge :amount="detail.reward.cost - points" /> short</p>
      </div>
      <template v-if="detail && detailState === 'usable'" #footer>
        <AppButton variant="pill" class="rewards__pill" block data-testid="mark-used" @click="useFromDetail">Mark as used</AppButton>
      </template>
      <template v-else-if="detail && detailState === 'new'" #footer>
        <AppButton v-if="isShort(detail.reward)" variant="secondary" small block disabled>{{ claimWord(detail.reward) }}</AppButton>
        <AppButton v-else variant="pill" class="rewards__pill" block data-testid="detail-claim" @click="claimFromDetail">{{ claimWord(detail.reward) }}</AppButton>
      </template>
    </BottomSheet>

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
/* One white card holds the switch and the list, with every voucher a card nested in it (Faith, 4 November 2026); the red streak runs
   round its border (Darius, 4 November 2026). */
.rewards__card { position: relative; display: flex; flex-direction: column; gap: var(--spacing-lg); padding: var(--spacing-lg); border: 1px solid var(--border-strong); border-radius: var(--rounded-lg); background: var(--canvas); }
@media (max-width: 743.98px) { .rewards__card { gap: var(--spacing-base); padding: var(--spacing-base) var(--spacing-md); } }
.rewards__panel { margin: 0; }
/* The switch: two halves of one pill. The current one is white with a bold ink rim; the other is muted on the soft track. */
.switch { display: grid; grid-template-columns: 1fr 1fr; gap: 4px; align-self: center; width: min(100%, 460px); padding: 4px; border-radius: var(--rounded-full); background: var(--surface-soft); }
.switch__tab { display: inline-flex; align-items: center; justify-content: center; gap: var(--spacing-sm); min-height: var(--tap-min); padding: 0 var(--spacing-base); border: 2px solid transparent; border-radius: var(--rounded-full); background: transparent; color: var(--muted); font: var(--text-button-md); cursor: pointer; transition: background-color var(--motion-fast) var(--ease-out), color var(--motion-fast) var(--ease-out), border-color var(--motion-fast) var(--ease-out); }
.switch__tab.is-active { border-color: var(--ink); background: var(--canvas); color: var(--ink); }
@media (hover: hover) { .switch__tab:not(.is-active):hover { color: var(--ink); } }
.switch__tab:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
/* How many codes are ready to use: a small red badge, white figures (4.89:1 on the pressed red). */
.switch__badge { display: inline-flex; align-items: center; justify-content: center; min-width: 22px; height: 22px; padding: 0 6px; border-radius: var(--rounded-full); background: var(--primary-active); color: var(--on-primary); font: var(--text-badge); }
/* Phones: tighter halves, labels on one line, and no icons under 420px so both names fit. */
@media (max-width: 743.98px) { .switch__tab { gap: var(--spacing-xs); padding: 0 var(--spacing-sm); font: var(--text-button-sm); white-space: nowrap; } }
@media (max-width: 419.98px) { .switch__tab :deep(svg) { display: none; } }
@media (prefers-reduced-motion: reduce) { .switch__tab { transition: none; } }
.filters { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: var(--spacing-xs) var(--spacing-md); margin-bottom: var(--spacing-base); }
.filters .scroll-x { min-width: 0; flex: 1 1 auto; margin-right: 0; padding-right: 0; }
.earn { display: flex; flex-direction: column; gap: var(--spacing-sm); margin: 0; padding: 0; list-style: none; }
.earn li { display: flex; align-items: center; gap: var(--spacing-sm); }
.earn__icon { flex-shrink: 0; display: inline-flex; align-items: center; justify-content: center; width: 28px; height: 28px; border-radius: var(--rounded-full); background: var(--surface-strong); color: var(--ink); }

.voucher { position: relative; display: flex; flex-direction: column; gap: var(--spacing-sm); height: 100%; padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); }
.voucher__icon { flex: none; display: inline-flex; align-items: center; justify-content: center; width: 40px; height: 40px; border-radius: var(--rounded-full); background: var(--cat-drink-bg); color: var(--cat-drink-fg); }
/* The offer's name opens the details, and its press area covers the card. The action sits above that area. */
.voucher__open { padding: 0; border: 0; background: transparent; color: inherit; font: inherit; text-align: left; cursor: pointer; }
.voucher__open::after { content: ''; position: absolute; inset: 0; border-radius: var(--rounded-md); }
.voucher__open:focus-visible { outline: none; }
.voucher__open:focus-visible::after { outline: 2px solid var(--ink); outline-offset: 2px; }
.voucher__action { position: relative; z-index: 1; }
@media (hover: hover) { .voucher:hover, .my-voucher:hover { border-color: var(--border-strong); } }
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
/* "Use now" on a row: the row is the button, so this is a label in the voucher's own tint (6.1:1). */
.state-pill--go { background: var(--status-voting-bg); color: var(--status-voting-fg); }
.voucher__muted { color: var(--muted); }
/* A row of Your vouchers: one button, with the icon, the words and the state across it. */
.my-voucher { display: flex; align-items: center; gap: var(--spacing-md); width: 100%; height: 100%; padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); font: inherit; text-align: left; cursor: pointer; }
.my-voucher:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
.my-voucher__text { flex: 1 1 auto; display: flex; flex-direction: column; gap: var(--spacing-xxs); min-width: 0; }
/* Used and expired: greyed, still readable (muted is 5.4:1 on white). */
.my-voucher.is-done { color: var(--muted); }
.my-voucher.is-done .voucher__icon { background: var(--surface-strong); color: var(--muted); }
/* A voucher's details. */
.detail { display: flex; flex-direction: column; align-items: stretch; gap: var(--spacing-base); }
.detail__place { display: flex; align-items: center; gap: var(--spacing-md); margin: 0; }
.detail__facts { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); margin: 0; padding: var(--spacing-base); border: 1px solid var(--hairline); border-radius: var(--rounded-md); }
.detail__facts dd { margin: var(--spacing-xxs) 0 0; }
.detail__facts > div + div { padding-left: var(--spacing-md); border-left: 1px solid var(--hairline); }
.detail__terms { display: flex; flex-direction: column; gap: var(--spacing-xs); margin: 0; padding-left: var(--spacing-lg); color: var(--body); list-style: disc; }
/* A used or expired code: struck through so it is not read out at a till. */
.code--done { align-self: flex-start; color: var(--muted); text-decoration: line-through; }
.code { padding: var(--spacing-xs) var(--spacing-sm); border-radius: var(--rounded-xs); background: var(--surface-strong); font: var(--text-caption); letter-spacing: 1px; }
.code--big { align-self: flex-start; padding: var(--spacing-sm) var(--spacing-base); font: var(--text-display-sm); }
</style>
