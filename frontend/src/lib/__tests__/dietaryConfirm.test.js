// "Confirm dietary needs" (components/event/DietaryConfirm.vue), drawn with the stand-in page (domless.js): picking a need
// beside one already selected adds to it, taking off one someone else has asks first, and Confirm sends the person's own
// picks and the needs the group should not filter for.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { liven, mountScreen } from './domless.js'
import DietaryConfirm from '../../components/event/DietaryConfirm.vue'
import DietaryChips from '../../components/event/DietaryChips.vue'

afterEach(() => vi.unstubAllGlobals())

// The dialog, open, with `mine` and `others`; `sent` collects what Confirm sends.
// How to call: const { view, sent } = await dialog({ mine: [], others: ['halal'] })
async function dialog({ mine = [], others = [], title, dropped = [], canDrop = true } = {}) {
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
// How to call: const { view, sent } = await inline({ mine: [], others: ['halal'] })
async function inline({ mine = [], others = [], dropped = [] } = {}) {
  await liven(DietaryChips)
  const state = { mine: ref(mine), dropped: ref(dropped) }
  const sent = []
  const Host = defineComponent({
    setup: () => () => h(DietaryChips, {
      mine: state.mine.value, others, dropped: state.dropped.value,
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
})

describe('only the host takes off a need someone else has (UAT of 29 October 2026, item 5)', () => {
  it('tells a guest only the host can, and changes nothing, while their own needs still come and go', async () => {
    const { view, sent } = await dialog({ mine: [], others: ['halal'], canDrop: false })
    await view.click(chip(view, 'Halal'))
    expect(view.all('h2').map((h) => view.text(h))).toEqual(['Confirm dietary needs', 'Only the host can change halal'])
    expect(view.has('[data-testid="diet-drop"]')).toBe(false)
    await view.click('[data-testid="diet-host-only"]')
    expect(chips(view)[0]).toEqual(['Halal', true])
    await view.click(chip(view, 'Vegan'))
    await view.click('[data-testid="diet-confirm-button"]')
    expect(sent.at(-1)).toEqual({ mine: ['vegan'], dropped: [] })
  })

  it('lets a guest bring back their own need the host dropped, shown unselected, and not someone else\'s', async () => {
    const own = await dialog({ mine: ['halal'], others: [], dropped: ['halal'], canDrop: false })
    expect(chips(own.view)[0]).toEqual(['Halal', false])
    await own.view.click(chip(own.view, 'Halal'))
    expect(chips(own.view)[0]).toEqual(['Halal', true])
    await own.view.click('[data-testid="diet-confirm-button"]')
    expect(own.sent.at(-1)).toEqual({ mine: ['halal'], dropped: [] })

    const theirs = await dialog({ mine: [], others: ['vegan'], dropped: ['vegan'], canDrop: false })
    await theirs.view.click(chip(theirs.view, 'Vegan'))
    expect(theirs.view.all('h2').map((h) => theirs.view.text(h)).at(-1)).toBe('Only the host can change vegan')
    expect(chips(theirs.view)[2]).toEqual(['Vegan', false])
  })
})
