// The Locate screen's meeting spots, rendered with a tiny stand-in for the page (miniDom.js) and a real events store whose
// actions are watched: the list of spots, "Works for me", "Suggest a spot", the host's confirm and the demo tools. The
// area picker and the dialog are stood in for, because they open over the page.
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick } from 'vue'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mount } from './miniDom.js'

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
const { canApprove, canSuggest, shownSpotId, tripsLine, unpricedSuggestion } = await import('../../components/spots/spotText.js')
const { useEventsStore } = await import('../../stores/events.js')
const { clearApprovals, friendSuggests, friendsApprove, hasSpots } = await import('../../components/dev/spotDemo.js')

const NAMES = { ian: 'Ian', jonathan: 'Jonathan', faith: 'Faith' }
const names = (id) => NAMES[id] || id
const spot = (areaId, name, extra = {}) => ({
  areaId, area: { id: areaId, name, lat: 1.3, lng: 103.8 }, by: 'app', byName: null, here: false, worstMinutes: 30, meanMinutes: 25,
  times: { ian: 30, jonathan: 20 }, approximate: false, approvedBy: [], approvalCount: 0, ...extra,
})
// A session in Locating with two starts in: the app's two spots and a suggestion from Jonathan.
function session(over = {}) {
  return {
    id: 's1', status: 'locating', hostId: 'ian', activeIds: ['ian', 'jonathan', 'faith'], findingSpots: false,
    locations: { ian: { start: { areaId: 'tampines' } }, jonathan: { start: { areaId: 'jurong-east' } } },
    spots: {
      list: [spot('bugis', 'Bugis'), spot('bishan', 'Bishan'), spot('novena', 'Novena', { by: 'jonathan', byName: 'Jonathan', here: true })],
      approvals: {}, suggestions: { jonathan: { areaId: 'novena', here: true } }, preselectedAreaId: 'bugis', appMethod: 'fairest',
    },
    ...over,
  }
}
let pinia
let events
beforeEach(() => {
  pinia = createPinia()
  setActivePinia(pinia)
  events = useEventsStore()
  for (const name of ['approveMySpot', 'suggestMySpot', 'withdrawMySpot', 'confirmSpot', 'setKnownPlace']) vi.spyOn(events, name).mockResolvedValue({})
})
const list = (s, extra = {}) => mount(SpotList, { session: s, myId: 'ian', names, selectedId: 'bugis', isHost: true, hostName: 'Ian', ...extra }, [pinia])

describe('the list of spots', () => {
  it('shows the app\'s spots and a member\'s suggestion with its label and "We are here already"', () => {
    const text = list(session()).text()
    expect(text).toContain('Where to meet')
    expect(text).toContain('Bugis')
    expect(text).toContain('Bishan')
    expect(text).toContain('Suggested by Jio')
    expect(text).toContain('Novena')
    expect(text).toContain('Suggested by Jonathan')
    expect(text).toContain('We are here already')
    expect(text).toContain('Longest trip 30 min · Average 25 min')
    expect(text).toContain('Jonathan 20 min')
    expect(text).toContain('Fairest')
  })

  it('says "about" when the times are estimates, and not otherwise', () => {
    const estimated = session()
    estimated.spots.list = [spot('bugis', 'Bugis', { approximate: true })]
    expect(list(estimated).text()).toContain('Longest trip about 30 min · Average about 25 min')
    expect(list(estimated).text()).toContain('Jonathan about 20 min')
    expect(list(session()).text()).not.toContain('about')
  })

  it('prints no "null" and no "0 min" for a known place that nobody has a trip to yet', () => {
    const known = session({ status: 'voting' })
    known.spots.list = [spot('bugis', 'Bugis', { by: 'ian', byName: 'Ian', worstMinutes: null, meanMinutes: null, times: {} })]
    known.spots.suggestions = {}
    const text = list(known).text()
    expect(tripsLine(known.spots.list[0])).toBe('')
    expect(text).toContain('Bugis')
    expect(text).toContain('No trips to compare yet')
    expect(text).not.toContain('null')
    expect(text).not.toContain('0 min')
  })

  it('says what opens the list when fewer than two starts are in, and offers no suggestion', () => {
    const early = session({ locations: { ian: { start: { areaId: 'tampines' } } } })
    early.spots = { list: [], approvals: {}, suggestions: {}, preselectedAreaId: null, appMethod: null }
    const page = list(early)
    expect(page.text()).toContain('No spots yet')
    expect(page.text()).toContain('two people have shared where they start. So far, 1 of 3 have.')
    expect(page.button('Suggest a spot')).toBeNull()
    expect(page.button('We already have a place')).not.toBeNull()
  })
})

describe('Works for me', () => {
  it('approves the spot, naming it, and takes the approval back when it is pressed', async () => {
    const s = session()
    s.spots.approvals = { ian: ['bishan'] }
    s.spots.list[1] = spot('bishan', 'Bishan', { approvedBy: [{ id: 'ian', name: 'Ian' }], approvalCount: 1 })
    const page = list(s)
    const bugis = page.button('Works for me')
    expect(page.attr(bugis, 'aria-label')).toBe('Works for me: Bugis')
    expect(page.attr(bugis, 'aria-pressed')).toBe('false')
    await bugis.click()
    expect(events.approveMySpot).toHaveBeenCalledWith('s1', 'bugis', true)
    const pressed = page.all('button').find((b) => page.attr(b, 'aria-label') === 'Works for me: Bishan')
    expect(page.attr(pressed, 'aria-pressed')).toBe('true')
    await pressed.listeners.click({})
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(events.approveMySpot).toHaveBeenLastCalledWith('s1', 'bishan', false)
  })

  it('counts who chose a spot in words, not only avatars', () => {
    const s = session()
    s.spots.list[0] = spot('bugis', 'Bugis', { approvedBy: [{ id: 'ian', name: 'Ian' }, { id: 'faith', name: 'Faith' }], approvalCount: 2 })
    const text = list(s).text()
    expect(text).toContain('Works for 2 people')
    expect(text).toContain('No one yet')
  })

  it('is off once the group has moved on', () => {
    const page = list(session({ status: 'voting' }))
    expect(page.button('Works for me').props.disabled).toBe(true)
    expect(canApprove(session({ status: 'voting' }), 'ian')).toBe(false)
  })

  it('shows your own suggestion with "We are here already" and Withdraw, and sends them to the data layer', async () => {
    const s = session()
    s.spots.suggestions = { ian: { areaId: 'novena', here: false } }
    s.spots.list[2] = spot('novena', 'Novena', { by: 'ian', byName: 'Ian' })
    const page = list(s)
    await page.button('We are here already').click()
    expect(events.suggestMySpot).toHaveBeenCalledWith('s1', 'novena', { here: true })
    await page.button('Withdraw').click()
    expect(events.withdrawMySpot).toHaveBeenCalledWith('s1')
  })

  // A control that is operated is not disabled while it saves: a disabled button drops the keyboard focus, and the next key
  // does nothing. It says it is busy instead, and a second press is ignored until the first is saved.
  for (const [control, press, call] of [
    ['Works for me', (page) => page.button('Works for me'), () => events.approveMySpot],
    ['We are here already', (page) => page.button('We are here already'), () => events.suggestMySpot],
    ['Withdraw', (page) => page.button('Withdraw'), () => events.withdrawMySpot],
  ]) {
    it(`keeps "${control}" enabled while it saves, and ignores a second press`, async () => {
      const s = session()
      s.spots.suggestions = { ian: { areaId: 'novena', here: false } }
      s.spots.list[2] = spot('novena', 'Novena', { by: 'ian', byName: 'Ian' })
      let finish
      call().mockImplementation(() => new Promise((resolve) => (finish = resolve)))
      const page = list(s)
      const button = press(page)
      const first = button.listeners.click({})
      await nextTick()
      button.listeners.click({})
      // The others stay enabled too, and every one says the list is busy.
      const controls = page.all('button').filter((b) => /Works for me|We are here already|Withdraw|Suggest a spot/.test(page.textOf(b)))
      expect(controls.length).toBeGreaterThan(3)
      for (const other of controls) {
        expect(other.props.disabled).toBeFalsy()
        expect(page.attr(other, 'aria-busy')).toBe('true')
      }
      expect(call()).toHaveBeenCalledTimes(1)
      finish({})
      await first
      await nextTick()
      expect(page.attr(button, 'aria-busy')).toBeUndefined()
      expect(button.props.disabled).toBeFalsy()
    })
  }

  it('does not open the area picker while a change is saving, so a pick is never thrown away', async () => {
    let finish
    events.approveMySpot.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const page = list(session())
    const first = page.button('Works for me').listeners.click({})
    await nextTick()
    await page.button('Suggest a spot').click()
    expect(page.button('Picker: Suggest a spot')).toBeNull()
    finish({})
    await first
  })

  it('shows the message the data layer gave when a change is refused', async () => {
    events.approveMySpot.mockRejectedValue(new Error('Cannot reach the Jio planner right now.'))
    const page = mount(SpotList, { session: session(), myId: 'ian', names, selectedId: 'bugis', isHost: true, onError: (m) => (page.message = m) }, [pinia])
    await page.button('Works for me').click()
    expect(page.message).toBe('Cannot reach the Jio planner right now.')
  })
})

describe('a suggestion with no row', () => {
  // A reload caught the planner before it priced your suggestion: it is saved, and the list has no row for it.
  const stuck = () => {
    const s = session()
    s.spots.suggestions = { ian: { areaId: 'kovan', here: true } }
    s.spots.list = s.spots.list.slice(0, 2)
    return s
  }

  it('offers to price it again or take it back', async () => {
    expect(unpricedSuggestion(stuck(), 'ian')).toEqual({ areaId: 'kovan', name: 'Kovan', here: true })
    const page = list(stuck())
    expect(page.text()).toContain('Kovan has no travel times yet')
    await page.button('Try again').click()
    expect(events.suggestMySpot).toHaveBeenCalledWith('s1', 'kovan', { here: true })
    await page.button('Withdraw').click()
    expect(events.withdrawMySpot).toHaveBeenCalledWith('s1')
  })

  it('is not shown for someone else\'s suggestion, or while the planner is pricing it, or once it has a row', () => {
    expect(list(stuck(), { myId: 'faith' }).text()).not.toContain('has no travel times yet')
    expect(list({ ...stuck(), findingSpots: true }).text()).not.toContain('has no travel times yet')
    expect(list(session()).text()).not.toContain('has no travel times yet')
  })
})

describe('Suggest a spot', () => {
  it('opens the area picker and suggests the area picked, never the place', async () => {
    const page = list(session())
    await page.button('Suggest a spot').click()
    await page.button('Picker: Suggest a spot').click()
    expect(events.suggestMySpot).toHaveBeenCalledWith('s1', 'kovan', { here: false })
  })

  it('is not offered when it would be refused', () => {
    expect(canSuggest(session(), 'ian')).toBe(true)
    expect(canSuggest(session({ status: 'voting' }), 'ian')).toBe(false)
    expect(canSuggest(session({ activeIds: ['jonathan', 'faith'] }), 'ian')).toBe(false)
    expect(canSuggest(session({ locations: { ian: { start: { areaId: 'x' } } } }), 'ian')).toBe(false)
    const full = session()
    full.spots.suggestions = Object.fromEntries(['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].map((id) => [`p${id}`, { areaId: id, here: false }]))
    expect(canSuggest(full, 'ian')).toBe(false)
    expect(list(session({ status: 'voting' })).button('Suggest a spot')).toBeNull()
  })

  it('offers "We already have a place" to the host only', () => {
    expect(list(session()).button('We already have a place')).not.toBeNull()
    expect(list(session(), { isHost: false }).button('We already have a place')).toBeNull()
  })

  it('asks before setting a known place, then sets it', async () => {
    const page = list(session())
    await page.button('We already have a place').click()
    await page.button('Picker: Where is the place?').click()
    expect(page.text()).toContain('Meet at Kovan?')
    expect(events.setKnownPlace).not.toHaveBeenCalled()
    await page.button('Meet at Kovan').click()
    expect(events.setKnownPlace).toHaveBeenCalledWith('s1', 'kovan')
  })
})

describe('confirming', () => {
  const confirmBar = (s, props = {}) => mount(SpotConfirm, { session: s, isHost: true, hostName: 'Ian', selectedId: shownSpotId(s.spots), ...props }, [pinia])

  it('offers the host "Confirm <area>" for the spot most people chose, and confirms that area', async () => {
    const s = session()
    s.spots.preselectedAreaId = 'bishan'
    expect(shownSpotId(s.spots)).toBe('bishan')
    const page = confirmBar(s)
    expect(page.button('Confirm Bishan')).not.toBeNull()
    await page.button('Confirm Bishan').click()
    expect(events.confirmSpot).toHaveBeenCalledWith('s1', 'bishan')
  })

  it('confirms another spot once the host has selected it, with nobody having approved anything', async () => {
    const s = session()
    expect(shownSpotId(s.spots, 'novena')).toBe('novena')
    const page = confirmBar(s, { selectedId: shownSpotId(s.spots, 'novena') })
    await page.button('Confirm Novena').click()
    expect(events.confirmSpot).toHaveBeenCalledWith('s1', 'novena')
  })

  it('falls back to the preselected spot when the one picked has left the list', () => {
    expect(shownSpotId(session().spots, 'gone')).toBe('bugis')
  })

  it('shows a member no confirm button, only who they are waiting for', () => {
    const page = confirmBar(session({ hostId: 'jonathan' }), { isHost: false, hostName: 'Jonathan' })
    expect(page.text()).toBe('Waiting for Jonathan to confirm')
    expect(page.all('button')).toHaveLength(0)
  })

  it('tells the host when the planner failed, and the spot stays unsettled', async () => {
    events.confirmSpot.mockRejectedValue(new Error('Cannot reach the Jio planner right now.'))
    const messages = []
    const page = confirmBar(session(), { onError: (m) => messages.push(m) })
    await page.button('Confirm Bugis').click()
    expect(events.confirmSpot).toHaveBeenCalledTimes(1)
    // The error went up (after the empty message that clears an old one), nothing says the spot was settled, and the same
    // button is still there to press again: enabled, not busy, still naming the same spot.
    expect(messages).toEqual(['', 'Cannot reach the Jio planner right now.'])
    const again = page.button('Confirm Bugis')
    expect(again).not.toBeNull()
    expect(again.props.disabled).toBeFalsy()
    expect(page.attr(again, 'aria-busy')).toBeUndefined()
    expect(page.text()).not.toContain('Waiting')
    // Pressing it again asks again.
    await again.click()
    expect(events.confirmSpot).toHaveBeenCalledTimes(2)
  })

  it('stays enabled while the confirm is saving, so the focus stays, and ignores a second press', async () => {
    let finish
    events.confirmSpot.mockImplementation(() => new Promise((resolve) => (finish = resolve)))
    const page = confirmBar(session())
    const button = page.button('Confirm Bugis')
    const first = button.listeners.click({})
    button.listeners.click({})
    await nextTick()
    expect(events.confirmSpot).toHaveBeenCalledTimes(1)
    expect(button.props.disabled).toBeFalsy()
    expect(page.attr(button, 'aria-busy')).toBe('true')
    finish({})
    await first
    await nextTick()
    expect(page.attr(button, 'aria-busy')).toBeUndefined()
  })

  it('declares no event that nothing listens to', () => {
    expect(SpotConfirm.emits).toEqual(['error'])
    expect(SpotList.emits).toEqual(['select', 'error'])
  })
})

describe('the demo tools for spots', () => {
  const fakeApi = () => ({ suggestSpot: vi.fn().mockResolvedValue({}), approveSpot: vi.fn().mockResolvedValue({}) })

  it('has a friend suggest a spot that is not listed yet, with and without "we are here already"', async () => {
    const api = fakeApi()
    const s = session()
    expect(hasSpots(s)).toBe(true)
    const note = await friendSuggests(api, s, ['jonathan', 'faith'], { here: false })
    expect(api.suggestSpot).toHaveBeenCalledWith('s1', 'faith', 'kovan', { here: false })
    expect(note).toBe('Faith suggested Kovan.')
    await friendSuggests(api, s, ['jonathan', 'faith'], { here: true })
    expect(api.suggestSpot).toHaveBeenLastCalledWith('s1', 'faith', 'kovan', { here: true })
  })

  it('has friends say which spots work, and the second spot leads', async () => {
    const api = fakeApi()
    await friendsApprove(api, session(), ['jonathan', 'faith'])
    const calls = api.approveSpot.mock.calls.map(([, person, area, on]) => `${person}:${area}:${on}`)
    expect(calls).toEqual(['jonathan:bishan:true', 'jonathan:bugis:true', 'faith:bishan:true'])
  })

  it('clears every approval, the signed-in person\'s too', async () => {
    const api = fakeApi()
    const s = session()
    s.spots.approvals = { ian: ['bugis'], faith: ['bishan', 'novena'] }
    expect(await clearApprovals(api, s)).toBe('Cleared 3 approvals.')
    expect(api.approveSpot).toHaveBeenCalledWith('s1', 'faith', 'novena', false)
    expect(api.approveSpot).toHaveBeenCalledTimes(3)
    expect(await clearApprovals(api, session())).toBe('Nobody had said which spots work.')
  })

  it('does nothing before the spots exist', () => {
    const early = session({ status: 'inviting' })
    expect(hasSpots(early)).toBe(false)
    expect(hasSpots(session({ spots: { list: [], approvals: {}, suggestions: {} } }))).toBe(false)
  })
})
