// The host's "Confirm <area>" on a pin's card on the map asks "Confirm <area> without everyone?" first, as the footer's does, when some people
// have not shared where they start (review of 1 November 2026: the phone path skipped the warning). The question is shown by the footer's
// SpotConfirm, so it survives the card closing. Rendered with the page stand-in (miniDom.js) and a real events store with a watched confirmSpot.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mount } from './miniDom.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../../components/ui/ModalDialog.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ props: ['open', 'title', 'text'], emits: ['update:open'], setup: (p, { slots }) => () => (p.open ? h('div', [h('h2', p.title), p.text ? h('p', p.text) : null, slots.default?.()]) : null) }) }
})

vi.stubGlobal('localStorage', fakeStorage())
const { useEventsStore } = await import('../../stores/events.js')
const { default: SpotConfirm } = await import('../../components/spots/SpotConfirm.vue')
const { default: SpotCard } = await import('../../components/spots/SpotCard.vue')
const { missingSentence } = await import('../../components/spots/confirmSpot.js')

const NAMES = { ian: 'Ian', jonathan: 'Jonathan', faith: 'Faith' }
const names = (id) => NAMES[id] || id
const spot = (areaId, name) => ({
  areaId, area: { id: areaId, name, lat: 1.3, lng: 103.8 }, by: 'app', byName: null, here: false, worstMinutes: 30, meanMinutes: 25,
  times: { ian: 30, jonathan: 20 }, approximate: false, approvedBy: [], approvalCount: 0,
})
// Faith has not shared where she starts.
const SESSION = {
  id: 's1', status: 'locating', hostId: 'ian', activeIds: ['ian', 'jonathan', 'faith'], findingSpots: false,
  locations: { ian: { start: { areaId: 'tampines' } }, jonathan: { start: { areaId: 'jurong-east' } } },
  spots: { list: [spot('bugis', 'Bugis'), spot('bishan', 'Bishan')], approvals: {}, suggestions: {}, preselectedAreaId: 'bugis', appMethod: 'fairest' },
}
const EVERYONE = { ...SESSION, locations: { ...SESSION.locations, faith: { start: { areaId: 'bugis' } } } }

let pinia
let events
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  events = useEventsStore()
  vi.spyOn(events, 'confirmSpot').mockResolvedValue({})
})

describe('the pin card\'s confirm', () => {
  it('asks first, naming who has not shared a start, and confirms nothing until the host says so', async () => {
    const card = mount(SpotCard, { spot: SESSION.spots.list[1], session: SESSION, myId: 'ian', isHost: true, names }, [pinia])
    const bar = mount(SpotConfirm, { session: SESSION, isHost: true, hostName: 'Ian', selectedId: 'bugis', names }, [pinia])
    await card.button('Confirm Bishan').click()
    await nextTick()
    expect(events.confirmSpot).not.toHaveBeenCalled()
    expect(bar.text()).toContain('Confirm Bishan without everyone?')
    expect(bar.text()).toContain('Faith has not shared where they start')
    const inDialog = bar.all('button', 'Confirm Bishan').at(-1)
    for (const fn of [].concat(inDialog.listeners.click || [])) await fn({ target: inDialog })
    await nextTick()
    expect(events.confirmSpot).toHaveBeenCalledWith('s1', 'bishan')
    expect(bar.text()).not.toContain('without everyone?')
  })

  it('"Keep waiting" confirms nothing and closes the question', async () => {
    const card = mount(SpotCard, { spot: SESSION.spots.list[0], session: SESSION, myId: 'ian', isHost: true, names }, [pinia])
    const bar = mount(SpotConfirm, { session: SESSION, isHost: true, hostName: 'Ian', selectedId: 'bugis', names }, [pinia])
    await card.button('Confirm Bugis').click()
    await nextTick()
    expect(bar.text()).toContain('without everyone?')
    await bar.button('Keep waiting').click()
    await nextTick()
    expect(events.confirmSpot).not.toHaveBeenCalled()
    expect(bar.text()).not.toContain('without everyone?')
  })

  it('confirms at once when everyone has shared where they start', async () => {
    const card = mount(SpotCard, { spot: EVERYONE.spots.list[1], session: EVERYONE, myId: 'ian', isHost: true, names }, [pinia])
    await card.button('Confirm Bishan').click()
    expect(events.confirmSpot).toHaveBeenCalledWith('s1', 'bishan')
  })
})

describe('missingSentence', () => {
  it('names one, two, or two and a count', () => {
    expect(missingSentence(['Faith'])).toBe('Faith has')
    expect(missingSentence(['Faith', 'Nicole'])).toBe('Faith and Nicole have')
    expect(missingSentence(['A', 'B', 'C'])).toBe('A, B and 1 other have')
    expect(missingSentence(['A', 'B', 'C', 'D'])).toBe('A, B and 2 others have')
  })
})
