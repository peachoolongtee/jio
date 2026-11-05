// The words a sortable list reads out after a move (components/ui/SortableList.vue): "<name> moved to position 1 of 2." They are true for a
// moment. They go after a few seconds and at once when the list gains or loses an item (a stop added, deleted or finished elsewhere), so
// no old position or count stays on the page. Drawn on the in-memory page (domless.js) on fake timers.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, ref } from 'vue'
import { liven, mountScreen } from './domless.js'

const { default: SortableList } = await import('../../components/ui/SortableList.vue')
await liven(SortableList)

const flush = () => vi.advanceTimersByTimeAsync(0)
beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

// A list of names with a handle on each, and a way to change the names from the test.
// How to call: const { view, items } = await draw(['a', 'b'])
async function draw(names) {
  const items = ref(names)
  const Parent = defineComponent({
    setup: () => () =>
      h(SortableList, { items: items.value, itemKey: (x) => x, itemLabel: (x) => x, label: 'Stops' }, {
        item: ({ item, handle }) => h('button', { ...handle }, item),
      }),
  })
  const view = await mountScreen(Parent)
  return { view, items }
}
const said = (view) => view.all('p').find((p) => p.attrs['aria-live'] === 'polite')

describe('the sortable list\'s announcement', () => {
  it('reads out a move, and takes it away after a few seconds', async () => {
    const { view } = await draw(['a', 'b'])
    view.all('button')[1].dispatch('keydown', { key: 'ArrowUp' })
    await flush()
    expect(view.text(said(view))).toBe('b moved to position 1 of 2.')
    await vi.advanceTimersByTimeAsync(5000)
    expect(view.text(said(view))).toBe('')
  })

  it('takes it away at once when a stop is added or removed, so it never describes a list that is gone', async () => {
    const { view, items } = await draw(['a', 'b'])
    view.all('button')[1].dispatch('keydown', { key: 'ArrowUp' })
    await flush()
    expect(view.text(said(view))).toContain('of 2')
    items.value = ['b', 'a', 'c']
    await flush()
    expect(view.text(said(view))).toBe('')
    expect(view.text()).not.toContain('moved to position')
  })
})
