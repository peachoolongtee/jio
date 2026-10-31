// "Confirm dietary needs" (components/event/DietaryConfirm.vue), drawn with the stand-in page (domless.js): picking a need
// beside one already selected adds to it, taking off one someone else has is the host's alone and asks first (a guest sees it
// locked, with the reason), and Confirm sends the person's own picks and the needs the group should not filter for.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { liven, mountScreen } from './domless.js'
import DietaryConfirm from '../../components/event/DietaryConfirm.vue'
import DietaryChips, { dietChips } from '../../components/event/DietaryChips.vue'

afterEach(() => vi.unstubAllGlobals())

// The line under the chips while a need is locked for a guest (it holds for the guest's own need too).
const LOCKED_NOTE = 'Someone in the outing needs this, so it stays on. Only the host can change that.'

// The dialog, open, with `mine` and `others`; `sent` collects what Confirm sends. `canDrop` is true for the host.
// How to call: const { view, sent } = await dialog({ mine: [], others: ['halal'], canDrop: false })
async function dialog({ mine = [], others = [], dropped = [], title, canDrop = true } = {}) {
  await liven(DietaryConfirm)
  const open = ref(true)
  const sent = []
  const Host = defineComponent({
    setup: () => () => h(DietaryConfirm, { ...(title ? { title } : {}), open: open.value, 'onUpdate:open': (v) => (open.value = v), mine, others, dropped, canDrop, onConfirm: (needs) => sent.push(needs) }),
  })
  return { view: await mountScreen(Host), sent }
}

// Each chip's name and whether it shows as selected. How to call: chips(view) -> [['Halal', true], ...]
const chips = (view) => view.all('button').filter((b) => b.attrs['aria-pressed'] !== undefined).map((b) => [view.text(b), b.attrs['aria-pressed'] === 'true'])
const chip = (view, name) => view.all('button').find((b) => b.attrs['aria-pressed'] !== undefined && view.text(b) === name)

describe('Confirm dietary needs', () => {
  it('adds a picked need beside one someone else has, and sends the person’s own', async () => {
    const { view, sent } = await dialog({ mine: [], others: ['halal'] })
    expect(chips(view)).toEqual([['Halal', true], ['Vegetarian', false], ['Vegan', false]])
    await view.click(chip(view, 'Vegetarian'))
    expect(chips(view)).toEqual([['Halal', true], ['Vegetarian', true], ['Vegan', false]])
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: ['vegetarian'], dropped: [] })
  })

  it('asks before taking off a need someone else has, reminds them someone needs it, and can keep it or drop it', async () => {
    const { view, sent } = await dialog({ mine: [], others: ['halal'] })
    await view.click(chip(view, 'Halal'))
    // The question, over the dialog: no name.
    expect(view.all('h2').map((h) => view.text(h))).toEqual(['Confirm dietary needs', 'Unselect halal?'])
    expect(view.text(view.all('section').at(-1))).toContain('Someone in this outing needs halal')
    await view.click('[data-testid="diet-keep"]')
    expect(view.all('h2').length).toBe(1)
    expect(chips(view)[0]).toEqual(['Halal', true])
    await view.click(chip(view, 'Halal'))
    await view.click('[data-testid="diet-drop"]')
    expect(chips(view)[0]).toEqual(['Halal', false])
    expect(view.text('[data-testid="diet-dropped"]')).toBe('Someone in this outing needs halal, but places will not be filtered for it.')
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: [], dropped: ['halal'] })
    // Selecting it again brings the filter back, with no question.
    await view.click(chip(view, 'Halal'))
    expect(view.all('h2').length).toBe(1)
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: [], dropped: [] })
  })

  it('shows a guest the needs of others selected and locked, says why, and sends their own picks only', async () => {
    const { view, sent } = await dialog({ mine: [], others: ['halal'], canDrop: false })
    expect(chip(view, 'Halal').attrs['aria-disabled']).toBe('true')
    expect(view.text('[data-testid="diet-locked-reason"]')).toBe(LOCKED_NOTE)
    await view.click(chip(view, 'Halal'))
    // No question, and the need stays on.
    expect(view.all('h2').length).toBe(1)
    expect(chips(view)[0]).toEqual(['Halal', true])
    await view.click(chip(view, 'Vegan'))
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: ['vegan'], dropped: [] })
  })

  it('shows the host no lock and no reason', async () => {
    const { view } = await dialog({ mine: [], others: ['halal'] })
    expect(chip(view, 'Halal').attrs['aria-disabled']).toBeUndefined()
    expect(view.all('[data-testid="diet-locked-reason"]').length).toBe(0)
    expect(view.all('[data-testid="diet-lock"]').length).toBe(0)
  })

  it('marks a locked chip that is on with a lock, also when the need is the guest’s own as well, and says why in words that hold for both', async () => {
    // Someone else has halal and so does the guest: the chip is on and locked, whoever's need it started as.
    const { view, sent } = await dialog({ mine: ['halal'], others: ['halal'], canDrop: false })
    expect(chips(view)[0]).toEqual(['Halal', true])
    expect(chip(view, 'Halal').attrs['aria-disabled']).toBe('true')
    expect(view.text('[data-testid="diet-locked-reason"]')).toBe(LOCKED_NOTE)
    expect(view.all('[data-testid="diet-lock"]').length).toBe(1)
    expect(view.text('[data-testid="diet-locked-reason"]')).not.toMatch(/someone else's need/i)
    // A tap changes nothing.
    await view.click(chip(view, 'Halal'))
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: ['halal'], dropped: [] })
  })

  it('has chips a guest cannot turn off by default: canDrop is false unless the host says so', () => {
    expect(dietChips({ mine: [], others: ['halal'] })[0]).toMatchObject({ value: 'halal', selected: true, shared: true, locked: true })
    expect(dietChips({ mine: [], others: ['halal'], canDrop: true })[0].locked).toBe(false)
  })

  it('is titled for confirming, and for editing when opened again from the Vote page', async () => {
    expect((await dialog()).view.text('h2')).toBe('Confirm dietary needs')
    const editing = await dialog({ mine: ['vegan'], title: 'Edit dietary needs' })
    expect(editing.view.text('h2')).toBe('Edit dietary needs')
    // It opens on the person's current needs, which they can take off.
    await editing.view.click(chip(editing.view, 'Vegan'))
    await editing.view.click('[data-testid="diet-confirm-button"]')
    expect(editing.sent.at(-1)).toEqual({ mine: [], dropped: [] })
  })

  it('adds a picked need beside the person’s own', async () => {
    const { view, sent } = await dialog({ mine: ['halal'], others: [] })
    await view.click(chip(view, 'Vegetarian'))
    expect(chips(view)).toEqual([['Halal', true], ['Vegetarian', true], ['Vegan', false]])
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: ['halal', 'vegetarian'], dropped: [] })
  })
})

// The same chips inline on the Vote page: each tap is sent at once, and taking off a need someone else has asks first.
// How to call: const { view, sent } = await inline({ mine: [], others: ['halal'], canDrop: false })
async function inline({ mine = [], others = [], dropped = [], canDrop = true } = {}) {
  await liven(DietaryChips)
  const state = { mine: ref(mine), dropped: ref(dropped) }
  const sent = []
  const Host = defineComponent({
    setup: () => () => h(DietaryChips, {
      mine: state.mine.value, others, dropped: state.dropped.value, canDrop,
      onChange: (next) => { sent.push(next); state.mine.value = next.mine; state.dropped.value = next.dropped },
    }),
  })
  return { view: await mountScreen(Host), sent }
}

describe('the dietary chips on the Vote page', () => {
  it('sends a tap on the person’s own need at once, with no question', async () => {
    const { view, sent } = await inline({ mine: [], others: ['halal'] })
    expect(chips(view)).toEqual([['Halal', true], ['Vegetarian', false], ['Vegan', false]])
    await view.click(chip(view, 'Vegan'))
    expect(sent).toEqual([{ mine: ['vegan'], dropped: [] }])
    expect(view.all('h2').length).toBe(0)
    expect(chips(view)[2]).toEqual(['Vegan', true])
  })

  it('asks the same question before taking off a need someone else has, and sends nothing if it is kept', async () => {
    const { view, sent } = await inline({ mine: [], others: ['halal'] })
    await view.click(chip(view, 'Halal'))
    expect(view.all('h2').map((x) => view.text(x))).toEqual(['Unselect halal?'])
    await view.click('[data-testid="diet-keep"]')
    expect(sent).toEqual([])
    await view.click(chip(view, 'Halal'))
    await view.click('[data-testid="diet-drop"]')
    expect(sent).toEqual([{ mine: [], dropped: ['halal'] }])
    expect(chips(view)[0]).toEqual(['Halal', false])
    // On again: no question.
    await view.click(chip(view, 'Halal'))
    expect(view.all('h2').length).toBe(0)
    expect(sent.at(-1)).toEqual({ mine: [], dropped: [] })
  })

  it('locks a need someone else has for a guest, and keeps a guest’s own needs free', async () => {
    const { view, sent } = await inline({ mine: [], others: ['halal'], canDrop: false })
    expect(view.text('[data-testid="diet-locked-reason"]')).toBe(LOCKED_NOTE)
    await view.click(chip(view, 'Halal'))
    expect(view.all('h2').length).toBe(0)
    expect(sent).toEqual([])
    await view.click(chip(view, 'Vegetarian'))
    expect(sent).toEqual([{ mine: ['vegetarian'], dropped: [] }])
    await view.click(chip(view, 'Vegetarian'))
    expect(sent.at(-1)).toEqual({ mine: [], dropped: [] })
  })
})

describe('a guest whose own need the host dropped', () => {
  it('sees it not filtered for and locked, with a line that says the places may not fit it, and keeps it as their own', async () => {
    // Vegetarian is the guest's own; the host dropped it. Halal is someone else's and still on.
    const { view, sent } = await dialog({ mine: ['vegetarian'], others: ['halal'], dropped: ['vegetarian'], canDrop: false })
    expect(chips(view)).toEqual([['Halal', true], ['Vegetarian', false], ['Vegan', false]])
    expect(chip(view, 'Vegetarian').attrs['aria-disabled']).toBe('true')
    expect(view.text('[data-testid="diet-dropped-mine"]')).toBe('The host stopped filtering places for vegetarian, so they may not be vegetarian.')
    // Both lines, each for its own chip: the locked halal and the dropped vegetarian.
    expect(view.text('[data-testid="diet-locked-reason"]')).toBe(LOCKED_NOTE)
    expect(chip(view, 'Vegetarian').attrs['aria-describedby']).toBe(view.one('[data-testid="diet-dropped-mine"]').attrs.id)
    // A tap changes nothing, and confirming keeps the need as theirs and the host's drop as it was.
    await view.click(chip(view, 'Vegetarian'))
    expect(chips(view)[1]).toEqual(['Vegetarian', false])
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: ['vegetarian'], dropped: ['vegetarian'] })
  })

  it('says nothing of it while the need is still filtered for', async () => {
    const { view } = await dialog({ mine: ['vegetarian'], others: ['halal'], dropped: [], canDrop: false })
    expect(chips(view)[1]).toEqual(['Vegetarian', true])
    expect(view.all('[data-testid="diet-dropped-mine"]').length).toBe(0)
  })
})

describe('dietChips', () => {
  it("marks the viewer's own dropped need unselected and, for a guest, locked", () => {
    const guest = dietChips({ mine: ['vegetarian'], others: [], dropped: ['vegetarian'], canDrop: false })
    expect(guest.find((c) => c.value === 'vegetarian')).toMatchObject({ selected: false, locked: true, droppedMine: true })
    const host = dietChips({ mine: ['vegetarian'], others: [], dropped: ['vegetarian'], canDrop: true })
    expect(host.find((c) => c.value === 'vegetarian')).toMatchObject({ selected: false, locked: false, droppedMine: true })
  })
})
