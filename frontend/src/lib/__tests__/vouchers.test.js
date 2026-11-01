// A claimed voucher's life (UAT item 1, 29 October 2026): it carries a last day, can be marked as used once, greys out as used or
// expired, and an old save's claims, made before they carried a last day, still draw. The data layer runs on a fake local
// storage, and the Rewards screen is drawn on the in-memory page (domless.js).
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { STORAGE_KEY, loadApi } from './planFixture.js'
import { mountScreen, until } from './domless.js'
import { VOUCHER_VALID_DAYS, claimCounts, claimLabel, dayLabel, validUntilOf, voucherGroups, voucherState, voucherValidUntil } from '../vouchers.js'

const planner = vi.hoisted(() => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../plannerApi.js', () => planner)
// A canvas drawing that needs a browser; the screen's own logic is what is under test.
vi.mock('@/components/ui/GridPulse.vue', () => ({ default: { render: () => null } }))

vi.setConfig({ testTimeout: 20000 })
const at = (iso) => vi.setSystemTime(new Date(iso))
const stored = (storage) => JSON.parse(storage.store[STORAGE_KEY])

beforeAll(() => vi.useFakeTimers({ toFake: ['Date'] }))
beforeEach(() => at('2026-10-30T10:00:00+08:00'))
afterAll(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

// The data layer signed in as Ian with JioCoins to spend; `change` edits the save before it is loaded, as an older build left it.
// How to call: const api = await richApi((save) => { save.redemptions = [...] })
async function richApi(change = () => {}) {
  const first = await loadApi()
  await first.signUp({ email: 'ian@example.com', name: 'Ian', username: 'ian', dob: '2000-01-31', homeAreaId: 'tampines' })
  const save = stored(first.storage)
  save.stats.ian.points = 1000
  change(save)
  return loadApi({ data: { [STORAGE_KEY]: JSON.stringify(save) } })
}

// The same storage read by a freshly loaded data layer, as after a reload of the page.
// How to call: const again = await reload(api)
const reload = (api) => loadApi({ data: { ...api.storage.store } })

describe('the rules of a voucher', () => {
  it('is valid for 30 days after the Singapore day it was claimed, whatever the clock zone', () => {
    expect(VOUCHER_VALID_DAYS).toBe(30)
    expect(voucherValidUntil(new Date('2026-10-30T10:00:00+08:00').getTime())).toBe('2026-11-29')
    // 11pm UTC on the 29th is already the 30th in Singapore.
    expect(voucherValidUntil(new Date('2026-10-29T23:00:00Z').getTime())).toBe('2026-11-29')
    expect(voucherValidUntil(undefined)).toBeNull()
    expect(voucherValidUntil('nonsense')).toBeNull()
  })

  it('is usable on its last day and expired the day after, in Singapore', () => {
    const r = { at: new Date('2026-10-30T10:00:00+08:00').getTime() }
    expect(voucherState(r, new Date('2026-11-29T23:59:00+08:00'))).toBe('usable')
    expect(voucherState(r, new Date('2026-11-30T00:00:00+08:00'))).toBe('expired')
    // Used stays used after the last day.
    expect(voucherState({ ...r, usedAt: Date.now() }, new Date('2027-01-01T00:00:00+08:00'))).toBe('used')
  })

  it('puts usable codes first, then used, then expired', () => {
    const now = new Date('2026-12-15T10:00:00+08:00')
    const list = [
      { id: 'old', validUntil: '2026-11-01' },
      { id: 'used', validUntil: '2027-01-01', usedAt: 1 },
      { id: 'fresh', validUntil: '2027-01-10' },
      { id: 'older', validUntil: '2026-10-01' },
    ]
    const groups = voucherGroups(list, now)
    expect(groups.usable.map((r) => r.id)).toEqual(['fresh'])
    expect(groups.used.map((r) => r.id)).toEqual(['used'])
    expect(groups.expired.map((r) => r.id)).toEqual(['old', 'older'])
  })

  it('counts the claims of each voucher and says whether it was claimed (walkthrough, 30 October 2026)', () => {
    expect(claimCounts([{ rewardId: 'r-nylon' }, { rewardId: 'r-tbb' }, { rewardId: 'r-nylon' }, {}])).toEqual({ 'r-nylon': 2, 'r-tbb': 1 })
    expect(claimCounts()).toEqual({})
    expect(claimLabel(undefined)).toBe('Not claimed')
    expect(claimLabel(0)).toBe('Not claimed')
    expect(claimLabel(1)).toBe('Claimed')
    expect(claimLabel(3)).toBe('Claimed 3 times')
  })

  it('writes days the way the app does', () => {
    expect(dayLabel('2026-11-29')).toBe('29 Nov 2026')
    expect(dayLabel(new Date('2026-10-29T23:00:00Z').getTime())).toBe('30 Oct 2026')
    expect(dayLabel(undefined)).toBe('')
    expect(dayLabel('nope')).toBe('')
  })
})

describe('claiming and using a voucher in the data layer', () => {
  it('gives a new claim its last day, and keeps it across a reload', async () => {
    const api = await richApi()
    const claimed = await api.redeemReward('r-nylon')
    expect(claimed.validUntil).toBe('2026-11-29')
    expect(stored(api.storage).redemptions[0].validUntil).toBe('2026-11-29')
    const again = await reload(api)
    const [mine] = await again.listRedemptions()
    expect(mine).toMatchObject({ id: claimed.id, validUntil: '2026-11-29', reward: { id: 'r-nylon' } })
    expect(mine.usedAt).toBeUndefined()
  })

  it('marks a code as used with today, once, and keeps it used across a reload', async () => {
    const api = await richApi()
    const claimed = await api.redeemReward('r-nylon')
    at('2026-11-02T15:00:00+08:00')
    const used = await api.markVoucherUsed(claimed.id)
    expect(used.usedAt).toBe(new Date('2026-11-02T15:00:00+08:00').getTime())
    expect(dayLabel(used.usedAt)).toBe('2 Nov 2026')
    await expect(api.markVoucherUsed(claimed.id)).rejects.toThrow('This voucher is already marked as used.')
    const again = await reload(api)
    const [mine] = await again.listRedemptions()
    expect(mine.usedAt).toBe(used.usedAt)
    expect(voucherState(mine)).toBe('used')
  })

  it('refuses to mark an expired code as used, and leaves it unused', async () => {
    const api = await richApi()
    const claimed = await api.redeemReward('r-nylon')
    at('2026-11-30T09:00:00+08:00')
    await expect(api.markVoucherUsed(claimed.id)).rejects.toThrow('This voucher expired: it was valid until 29 Nov 2026.')
    const [mine] = await api.listRedemptions()
    expect(mine.usedAt).toBeUndefined()
    expect(voucherState(mine)).toBe('expired')
  })

  it('refuses a code that is not one of yours', async () => {
    const api = await richApi()
    await expect(api.markVoucherUsed('v-nobody')).rejects.toThrow('This voucher is not one of yours.')
  })

  it('works out a last day for a claim saved before claims carried one, and one with no claim time stays usable', async () => {
    const claimedAt = new Date('2026-10-20T12:00:00+08:00').getTime()
    const api = await richApi((save) => {
      save.redemptions = [
        { id: 'v90', rewardId: 'r-nylon', code: 'JIO-OLD1-OLD2', at: claimedAt },
        { id: 'v91', rewardId: 'r-tbb', code: 'JIO-OLD3-OLD4' },
      ]
    })
    const [old, timeless] = await api.listRedemptions()
    expect(old.validUntil).toBe('2026-11-19')
    expect(validUntilOf(timeless)).toBeNull()
    expect(voucherState(timeless)).toBe('usable')
    // The stored claim is left as it was: the last day is read, not written back.
    expect(stored(api.storage).redemptions[0].validUntil).toBeUndefined()
    await api.markVoucherUsed('v90')
    expect(stored(api.storage).redemptions[0].usedAt).toBeTypeOf('number')
  })
})

describe('the Rewards screen', () => {
  // Rewards drawn for Ian, with whatever claims the save holds.
  // How to call: const { view, api } = await drawRewards((save) => { save.redemptions = [...] })
  async function drawRewards(change) {
    const api = await richApi(change)
    const { createPinia, setActivePinia } = await import('pinia')
    const pinia = createPinia()
    setActivePinia(pinia)
    const stub = { render: () => null }
    const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: stub }] })
    await router.push('/rewards')
    const { default: RewardsView } = await import('@/views/RewardsView.vue')
    const view = await mountScreen(RewardsView, { plugins: [pinia, router] })
    await until(() => view.has('[data-testid=rewards-view]') && view.has('[data-testid=voucher-card]'))
    return { view, api }
  }
  const buttonLabelled = (view, text) => view.all('button').find((b) => view.text(b) === text)
  const claims = (save) => {
    save.redemptions = [
      { id: 'v80', rewardId: 'r-nylon', code: 'JIO-AAAA-BBBB', at: new Date('2026-10-28T12:00:00+08:00').getTime(), validUntil: '2026-11-27' },
      // Claimed in September with no last day saved: it ran out on 2 October.
      { id: 'v81', rewardId: 'r-tbb', code: 'JIO-CCCC-DDDD', at: new Date('2026-09-02T12:00:00+08:00').getTime() },
    ]
  }

  it('shows a used voucher as used, with no code to show, and offers it again', async () => {
    const { view } = await drawRewards((save) => {
      save.redemptions = [{ id: 'v90', rewardId: 'r-nylon', code: 'JIO-USED-0001', at: new Date('2026-10-28T12:00:00+08:00').getTime(), validUntil: '2026-11-27', usedAt: new Date('2026-10-30T12:00:00+08:00').getTime() }]
    })
    const card = view.all('[data-testid=voucher-card]').find((c) => view.text(c).includes('SGD 3 off any coffee'))
    expect(view.text(card)).toContain('Used on 30 Oct 2026')
    expect(view.text(card)).not.toContain('Show code')
    expect(card.querySelector('[data-testid=code-reveal]')).toBeFalsy()
    expect(view.text(card)).toContain('Claim again')
  })

  it('"Claim all" asks first, then claims every voucher with no code to use that the balance covers, cheapest first', async () => {
    const { view, api } = await drawRewards(claims)
    // Ian has 1,000 JioCoins and has claimed two before; the costliest prizes are out of reach, so "Can claim" has something to hide.
    const cards = () => view.all('[data-testid=voucher-card]').length
    const all = cards()
    await view.click(view.all('button').find((b) => view.text(b).startsWith('Can claim')))
    expect(cards()).toBeLessThan(all)
    await view.click(view.all('button').find((b) => view.text(b).startsWith('Can claim')))
    await view.click(view.one('[data-testid=claim-all]'))
    await until(() => view.has('[data-testid=claim-all-confirm]'))
    // With no code to use, cheapest first, as far as 1,000 goes: 80, 100 (its code expired), 120, 150, 180, 220. r-nylon holds a code.
    expect(view.text(view.one('[data-testid=claim-all-confirm]'))).toBe('Claim 6 vouchers')
    await view.click(view.one('[data-testid=claim-all-confirm]'))
    await until(() => view.has('[data-testid=claim-all-note]'))
    expect(view.text(view.one('[data-testid=claim-all-note]'))).toBe('6 vouchers claimed. Press Show code on each to see its code.')
    const save = JSON.parse(api.storage.store['jio-demo-v1'])
    expect(save.redemptions.map((r) => r.rewardId).sort()).toEqual(['r-chye-seng-huat', 'r-creamier', 'r-forty-hands', 'r-merci-marcel', 'r-nylon', 'r-plain-vanilla', 'r-tbb', 'r-tbb'].sort())
    expect(save.stats.ian.points).toBe(1000 - 850)
  })

  it('keeps a code to use on its card alone, and an old expired claim under Past vouchers, Expired, with no button', async () => {
    const { view } = await drawRewards(claims)
    // The code to use is on its card (under the sticker), not listed again below (Faith, 31 October 2026).
    expect(view.has('[data-testid=usable-vouchers]')).toBe(false)
    const card = view.all('[data-testid=voucher-card]').find((c) => view.text(c).includes('SGD 3 off any coffee'))
    expect(view.text(card)).toContain('Use by 27 Nov 2026')
    expect(card.querySelector('[data-testid=mark-used]')).toBeTruthy()
    expect(view.text()).toContain('Past vouchers')
    expect(view.text('[data-testid=expired-vouchers]')).toContain('JIO-CCCC-DDDD')
    expect(view.text('[data-testid=expired-vouchers]')).toContain('Was valid until 2 Oct 2026')
    expect(view.text('[data-testid=expired-vouchers]')).not.toContain('Mark as used')
    expect(view.has('[data-testid=used-vouchers]')).toBe(false)
    expect(view.errors).toEqual([])
  })

  it('asks before marking a code as used, then moves it to Used with the day', async () => {
    const { view, api } = await drawRewards(claims)
    await view.click(buttonLabelled(view, 'Mark as used'))
    await until(() => view.has('[role=dialog]'))
    expect(view.text('[role=dialog]')).toContain('Mark as used?')
    expect(view.text('[role=dialog]')).toContain('JIO-AAAA-BBBB')
    // "Not now" leaves it usable.
    await view.click(buttonLabelled(view, 'Not now'))
    expect(stored(api.storage).redemptions[0].usedAt).toBeUndefined()
    await view.click(buttonLabelled(view, 'Mark as used'))
    await until(() => view.has('[role=dialog]'))
    // The dialog's own button: the dialog is drawn after the page.
    const confirm = view.all('button').filter((b) => view.text(b) === 'Mark as used').at(-1)
    await view.click(confirm)
    await until(() => view.has('[data-testid=used-vouchers]'))
    expect(view.text('[data-testid=used-vouchers]')).toContain('JIO-AAAA-BBBB')
    expect(view.text('[data-testid=used-vouchers]')).toContain('Used on 30 Oct 2026')
    // Its card now says so, and offers it again.
    const card = view.all('[data-testid=voucher-card]').find((c) => view.text(c).includes('SGD 3 off any coffee'))
    expect(view.text(card)).toContain('Used on 30 Oct 2026')
    expect(view.text(card)).toContain('Claim again')
    expect(stored(api.storage).redemptions[0].usedAt).toBe(new Date('2026-10-30T10:00:00+08:00').getTime())
    expect(view.errors).toEqual([])
  })

  it('puts the safer choice first in the dialog, and "Mark as used" last', async () => {
    const { view } = await drawRewards(claims)
    await view.click(buttonLabelled(view, 'Mark as used'))
    await until(() => view.has('[role=dialog]'))
    const labels = view.all('button').map((b) => view.text(b)).filter((t) => t === 'Not now' || t === 'Mark as used')
    // The page's own button comes first, then the dialog's two.
    expect(labels).toEqual(['Mark as used', 'Not now', 'Mark as used'])
  })

  it('moves focus to the Used heading and says "Marked as used" in a polite live region once a code is marked', async () => {
    const { view } = await drawRewards(claims)
    expect(view.text('[data-testid=voucher-status]')).toBe('')
    await view.click(buttonLabelled(view, 'Mark as used'))
    await until(() => view.has('[role=dialog]'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Mark as used').at(-1))
    await until(() => view.has('[data-testid=used-vouchers]'))
    await until(() => view.text('[data-testid=voucher-status]') === 'Marked as used')
    expect(view.all('p').some((p) => p.attrs.role === 'status' && view.text(p) === 'Marked as used')).toBe(true)
    expect(view.focused()?.id).toBe('used-head')
    expect(view.errors).toEqual([])
  })

  it('says Used and Expired once each: in the group heading, not again as a tag on the row', async () => {
    const { view } = await drawRewards(claims)
    const expired = view.text('[data-testid=expired-vouchers]')
    expect(expired).not.toMatch(/\bExpired\b/)
    expect(expired).toContain('Was valid until')
    await view.click(buttonLabelled(view, 'Mark as used'))
    await until(() => view.has('[role=dialog]'))
    await view.click(view.all('button').filter((b) => view.text(b) === 'Mark as used').at(-1))
    await until(() => view.has('[data-testid=used-vouchers]'))
    const used = view.text('[data-testid=used-vouchers]')
    expect(used.match(/\bUsed\b/g)).toHaveLength(1)
    expect(used).toContain('Used on 30 Oct 2026')
  })

  it('says on each voucher card whether it was claimed, and updates the card after a claim', async () => {
    const { view } = await drawRewards(claims)
    const card = (offer) => view.all('[data-testid=voucher-card]').find((c) => view.text(c).includes(offer))
    const inside = (node, box) => !!node && (node === box || inside(node.parent, box))
    // Kopi Corner was claimed; the bakery's claim has expired, and says so; the cupcake never was. A claimed one shows its code under a
    // sticker in place of Claim.
    expect(view.text(card('SGD 3 off any coffee'))).toContain('Use by 27 Nov 2026')
    expect(view.text(card('SGD 5 off'))).toContain('Expired on')
    // An expired code shows no code, and the voucher can be claimed again.
    expect(card('SGD 5 off').querySelector('[data-testid=code-reveal]')).toBeFalsy()
    expect(view.all('button').some((b) => view.text(b) === 'Claim again' && inside(b, card('SGD 5 off')))).toBe(true)
    expect(view.text(card('One free cupcake'))).toContain('Not claimed')
    const reveal = card('SGD 3 off any coffee').querySelector('[data-testid=code-reveal]')
    expect(reveal).toBeTruthy()
    expect(view.text(reveal)).not.toContain('JIO-AAAA-BBBB')
    await view.click(reveal.querySelector('[data-testid=code-peel]'))
    expect(view.text(reveal)).toContain('JIO-AAAA-BBBB')
    expect(view.all('button').some((b) => view.text(b) === 'Claim' && inside(b, card('SGD 3 off any coffee')))).toBe(false)
    const claim = view.all('button').find((b) => view.text(b) === 'Claim' && inside(b, card('One free cupcake')))
    await view.click(claim)
    await until(() => view.has('[role=dialog]'))
    await view.click(buttonLabelled(view, 'Claim voucher'))
    await until(() => !view.text(card('One free cupcake')).includes('Not claimed'))
    expect(view.text(card('One free cupcake'))).toContain('Use by')
    expect(view.errors).toEqual([])
  })
})
