// The two ways to confirm on the Locate screen share one busy flag (the events store's `confirming`): the footer's "Confirm <area>"
// (SpotConfirm) and the list's dialog "Meet at <area>" (SpotList). While either runs, both read "Confirming…" and say they are busy
// (aria-busy) without being disabled, so the keyboard focus stays; a press on the other, or on another control of the list, does
// nothing. Rendered with a tiny stand-in for the page (miniDom.js) and the real events store; only the data layer's two writes are
// held by hand, so no timer and no network are involved.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mount } from './miniDom.js'

const held = vi.hoisted(() => ({ confirmSpot: vi.fn(), setKnownPlace: vi.fn(), approveSpot: vi.fn() }))
vi.mock('../api.js', async (importOriginal) => ({ ...(await importOriginal()), ...held }))
vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../../components/group/LocationSheet.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return {
    default: defineComponent({
      props: ['open', 'which', 'title'],
      emits: ['select', 'update:open'],
      setup: (p, { emit }) => () => (p.open ? h('button', { onClick: () => emit('select', { areaId: 'kovan', label: 'Somewhere exact' }) }, `Picker: ${p.title}`) : null),
    }),
  }
})
vi.mock('../../components/ui/ModalDialog.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['open', 'title', 'text'], emits: ['update:open'], setup: (p, { slots }) => () => (p.open ? h('div', [h('h2', p.title), slots.content?.(), slots.default?.()]) : null) }) }
})

vi.stubGlobal('localStorage', fakeStorage())
const { default: SpotList } = await import('../../components/spots/SpotList.vue')
const { default: SpotConfirm } = await import('../../components/spots/SpotConfirm.vue')
const { useEventsStore } = await import('../../stores/events.js')

const spot = (areaId, name) => ({
  areaId, area: { id: areaId, name, lat: 1.3, lng: 103.8 }, by: 'app', byName: null, here: false, worstMinutes: 30, meanMinutes: 25,
  times: { ian: 30, jonathan: 20 }, approximate: false, approvedBy: [], approvalCount: 0,
})
const SESSION = {
  id: 's1', status: 'locating', hostId: 'ian', activeIds: ['ian', 'jonathan'], findingSpots: false,
  locations: { ian: { start: { areaId: 'tampines' } }, jonathan: { start: { areaId: 'jurong-east' } } },
  spots: { list: [spot('bugis', 'Bugis'), spot('bishan', 'Bishan')], approvals: {}, suggestions: {}, preselectedAreaId: 'bugis', appMethod: 'fairest' },
}

let pinia
let events
let list
let bar
// A write the test finishes by hand.
// How to call: const write = pending(held.confirmSpot); ...; await write.done()
function pending(fn) {
  let finish
  let fail
  fn.mockImplementation(() => new Promise((resolve, reject) => { finish = resolve; fail = reject }))
  return {
    done: async () => { finish(SESSION); await new Promise((resolve) => setTimeout(resolve, 0)); await nextTick() },
    fail: async (message) => { fail(new Error(message)); await new Promise((resolve) => setTimeout(resolve, 0)); await nextTick() },
  }
}
beforeEach(() => {
  for (const fn of Object.values(held)) fn.mockReset()
  pinia = createPinia()
  setActivePinia(pinia)
  events = useEventsStore()
  list = mount(SpotList, { session: SESSION, myId: 'ian', names: (id) => id, selectedId: 'bugis', isHost: true, hostName: 'Ian' }, [pinia])
  bar = mount(SpotConfirm, { session: SESSION, isHost: true, hostName: 'Ian', selectedId: 'bugis' }, [pinia])
})

// Pick the known place and open the "Meet at Kovan?" dialog.
// How to call: await openDialog()
async function openDialog() {
  await list.button('We already have a place').click()
  await list.button('Picker: Where is the place?').click()
  expect(list.text()).toContain('Meet at Kovan?')
}

describe('one busy flag for both ways to confirm', () => {
  it('reads "Confirming…" on the footer button, and on the dialog\'s, while the footer confirm runs; the other press does nothing', async () => {
    await openDialog()
    const write = pending(held.confirmSpot)
    const first = bar.button('Confirm Bugis').listeners.click({})
    await nextTick()
    expect(events.confirming).toBe(true)
    const footer = bar.button('Confirming…')
    expect(footer).not.toBeNull()
    expect(bar.attr(footer, 'aria-busy')).toBe('true')
    expect(footer.props.disabled).toBeFalsy()
    const meet = list.button('Confirming…')
    expect(meet).not.toBeNull()
    expect(list.attr(meet, 'aria-busy')).toBe('true')
    await meet.click()
    await footer.click()
    expect(held.setKnownPlace).not.toHaveBeenCalled()
    expect(held.confirmSpot).toHaveBeenCalledTimes(1)
    await write.done()
    await first
    expect(events.confirming).toBe(false)
    expect(bar.button('Confirming…')).toBeNull()
    expect(bar.attr(bar.button('Confirm Bugis'), 'aria-busy')).toBeUndefined()
  })

  it('does the same the other way: "Meet at Kovan" running keeps "Confirm Bugis" from starting a second confirm', async () => {
    await openDialog()
    const write = pending(held.setKnownPlace)
    const first = list.button('Meet at Kovan').listeners.click({})
    await nextTick()
    expect(events.confirming).toBe(true)
    expect(bar.button('Confirming…')).not.toBeNull()
    await bar.button('Confirming…').click()
    expect(held.confirmSpot).not.toHaveBeenCalled()
    expect(held.setKnownPlace).toHaveBeenCalledTimes(1)
    await write.done()
    await first
    expect(events.confirming).toBe(false)
  })

  it('holds the list\'s other controls while a confirm runs: they say busy and a press does nothing', async () => {
    const write = pending(held.confirmSpot)
    const first = bar.button('Confirm Bugis').listeners.click({})
    await nextTick()
    const controls = list.all('button').filter((b) => /Vote|Suggest a spot|We already have a place/.test(list.textOf(b)))
    expect(controls.length).toBeGreaterThan(2)
    for (const control of controls) {
      expect(list.attr(control, 'aria-busy')).toBe('true')
      expect(control.props.disabled).toBeFalsy()
    }
    await list.button('Vote').click()
    await list.button('We already have a place').click()
    expect(held.approveSpot).not.toHaveBeenCalled()
    expect(list.button('Picker: Where is the place?')).toBeNull()
    await write.done()
    await first
    expect(list.attr(list.button('Vote'), 'aria-busy')).toBeUndefined()
  })

  it('goes back to "Confirm Bugis" when the confirm fails, and says why through the error event', async () => {
    const messages = []
    bar = mount(SpotConfirm, { session: SESSION, isHost: true, hostName: 'Ian', selectedId: 'bugis', onError: (m) => messages.push(m) }, [pinia])
    const write = pending(held.confirmSpot)
    const first = bar.button('Confirm Bugis').listeners.click({})
    await nextTick()
    expect(bar.button('Confirming…')).not.toBeNull()
    await write.fail('Cannot reach the Jio planner right now.')
    await first
    expect(events.confirming).toBe(false)
    expect(bar.button('Confirm Bugis')).not.toBeNull()
    expect(messages.at(-1)).toBe('Cannot reach the Jio planner right now.')
  })
})
