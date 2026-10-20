// The invite field on a shared session (components/group/InviteByUsername.vue), drawn for real (with the real TextField) on the
// in-memory page (domless.js), on fake timers so the 250 ms pause costs nothing: the hint under three letters, the results after
// the pause, "Already invited.", nobody found, a failed search with Try again, the clear button, that typing and Enter invite
// nobody while the Invite button does, where focus goes (Enter and the arrows, the clear button, after an invitation), and that
// leaving the screen cancels a search that is waiting or running. The page does no layout, so widths are checked in a browser.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { fakeStorage } from './planFixture.js'
import { mountScreen } from './domless.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../api.js', async (original) => ({ ...(await original()), searchPeople: vi.fn() }))

vi.stubGlobal('localStorage', fakeStorage())
const api = await import('../api.js')
const { default: InviteByUsername } = await import('../../components/group/InviteByUsername.vue')
const { useEventsStore } = await import('../../stores/events.js')
const { PEOPLE_SEARCH_DELAY_MS } = await import('../peopleSearch.js')

const SAM = { id: 'u-sam', name: 'Sam Tan', username: 'sam_tan', avatarUrl: '', metBefore: true }
const SAMUEL = { id: 'u-samuel', name: 'Samuel', username: 'samuel', avatarUrl: '', metBefore: false }
const SAMMY = { id: 'u-sammy', name: 'Sammy', username: 'sammy', avatarUrl: '', metBefore: false }
const session = { id: 's1', title: 'Saturday', members: [{ id: 'host', role: 'host', state: 'joined' }, { id: 'u-samuel', role: 'guest', state: 'invited' }] }

const flush = () => vi.advanceTimersByTimeAsync(0)
let pinia
let events
beforeEach(() => {
  vi.useFakeTimers()
  pinia = createPinia()
  setActivePinia(pinia)
  events = useEventsStore()
  vi.spyOn(events, 'inviteByUsername').mockResolvedValue(session)
  api.searchPeople.mockReset().mockResolvedValue([SAM, SAMUEL, SAMMY])
})
afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

// Draw the field and give it a way to type and press. How to call: const f = await open(); await f.type('sam')
async function open() {
  const view = await mountScreen(InviteByUsername, { plugins: [pinia], props: { session } })
  const input = () => view.one('input')
  const buttons = (label) => view.all('button').filter((b) => !label || view.text(b).includes(label))
  const named = (label) => view.all('button').find((b) => b.attrs['aria-label'] === label) ?? null
  return {
    view,
    input,
    named,
    async type(text) {
      view.type('input', text)
      await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    },
    // A press, as the keyboard or a finger does it; the page redraws after.
    async press(el) {
      el.dispatch('click')
      await flush()
    },
    async key(el, key) {
      const event = el.dispatch('keydown', { key })
      await flush()
      return event
    },
    // Who has focus, by name: 'field' for the input, else the button's label. (The page's elements are compared by name, since a
    // failed comparison of two of them would try to print the whole page.)
    focus: () => {
      const el = view.focused()
      return el?.tag === 'input' ? 'field' : (el?.attrs['aria-label'] ?? el?.tag ?? 'nothing')
    },
    invites: () => buttons('Invite').filter((b) => b.attrs['aria-label']?.startsWith('Invite ')),
    rows: () => view.all('li'),
    status: () => view.all('p').find((p) => p.attrs.role === 'status' && (p.attrs.class || '').includes('sr-only')),
  }
}

describe('the invite field', () => {
  it('starts with a hint, a magnifier in the field, no clear button and no Find button', async () => {
    const f = await open()
    expect(f.view.text()).toContain('Type at least 3 letters of their username')
    expect(f.view.all('button').some((b) => f.view.text(b) === 'Find')).toBe(false)
    expect(f.named('Clear search')).toBeNull()
    expect(f.view.has('[data-testid=invite-searching]')).toBe(false)
    expect(f.rows()).toHaveLength(0)
  })

  it('asks nothing under 3 letters', async () => {
    const f = await open()
    await f.type('sa')
    expect(api.searchPeople).not.toHaveBeenCalled()
    expect(f.view.text()).toContain('Type at least 3 letters')
  })

  it('shows a spinner for the magnifier while it waits and looks, and the people after the pause, and announces the count', async () => {
    const f = await open()
    f.view.type('input', 'sam')
    await flush()
    expect(f.view.has('[data-testid=invite-searching]')).toBe(true)
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS)
    expect(api.searchPeople).toHaveBeenCalledTimes(1)
    expect(api.searchPeople.mock.calls[0][0]).toBe('sam')
    expect(f.view.has('[data-testid=invite-searching]')).toBe(false)
    expect(f.view.text()).not.toContain('Type at least 3 letters')
    const rows = f.rows().map((row) => f.view.text(row))
    expect(rows).toHaveLength(3)
    expect(rows[0]).toContain('Sam Tan@sam_tanInvite')
    expect(rows[1]).toContain('Samuel@samuelAlready invited.')
    expect(f.view.text(f.status())).toBe('3 people found')
    expect(f.named('Clear search')).not.toBeNull()
    // The Invite button has a name that says who.
    expect(f.invites().map((b) => b.attrs['aria-label'])).toEqual(['Invite Sam Tan', 'Invite Sammy'])
  })

  it('says so when nobody\'s username starts with that', async () => {
    api.searchPeople.mockResolvedValue([])
    const f = await open()
    await f.type('zzz')
    expect(f.view.text()).toContain("Nobody's username starts with that.")
    expect(f.view.text(f.status())).toBe("Nobody's username starts with that.")
  })

  it('says it could not look, offers Try again, and shows the people when that works', async () => {
    api.searchPeople.mockRejectedValueOnce(new Error('Too many requests. Wait a few seconds and try again.'))
    const f = await open()
    await f.type('sam')
    expect(f.view.text()).toContain('Too many requests. Wait a few seconds and try again.')
    expect(f.rows()).toHaveLength(0)
    await f.press(f.view.all('button').find((b) => f.view.text(b) === 'Try again'))
    expect(f.rows()).toHaveLength(3)
    expect(f.view.text()).not.toContain('Try again')
  })

  it('invites nobody by typing or by Enter', async () => {
    const f = await open()
    await f.type('sam')
    const event = await f.key(f.input(), 'Enter')
    expect(event.defaultPrevented).toBe(true)
    expect(events.inviteByUsername).not.toHaveBeenCalled()
  })

  it('moves focus to the first Invite button on Enter or the down arrow, between buttons on the arrows, and back to the field from the first', async () => {
    const f = await open()
    await f.type('sam')
    // Looked up each time: a redraw may replace the elements.
    const first = () => f.invites()[0]
    const second = () => f.invites()[1]
    await f.key(f.input(), 'Enter')
    const ul = f.view.all('ul')[0]
    console.log('DBG', Object.keys(ul.listeners), Object.keys(first().listeners), first().parent === ul, first().parent?.tag, first().parent?.parent === ul)
    expect(f.focus()).toBe('Invite Sam Tan')
    await f.key(first(), 'ArrowDown')
    expect(f.focus()).toBe('Invite Sammy')
    await f.key(second(), 'ArrowDown')
    expect(f.focus()).toBe('Invite Sammy')
    await f.key(second(), 'ArrowUp')
    expect(f.focus()).toBe('Invite Sam Tan')
    await f.key(first(), 'ArrowUp')
    expect(f.focus()).toBe('field')
    // The down arrow does the same as Enter from the field.
    await f.key(f.input(), 'ArrowDown')
    expect(f.focus()).toBe('Invite Sam Tan')
    expect(events.inviteByUsername).not.toHaveBeenCalled()
  })

  it('stays in the field when there is no Invite button to go to, and Enter after a failure tries again', async () => {
    api.searchPeople.mockResolvedValueOnce([SAMUEL])
    const f = await open()
    await f.type('samu')
    f.input().focus()
    await f.key(f.input(), 'Enter')
    expect(f.focus()).toBe('field')
    api.searchPeople.mockRejectedValueOnce(new Error('Down.')).mockResolvedValueOnce([SAM])
    await f.type('samue')
    expect(f.view.text()).toContain('Down.')
    await f.key(f.input(), 'Enter')
    expect(api.searchPeople).toHaveBeenCalledTimes(3)
    expect(f.rows()).toHaveLength(1)
  })

  it('invites the person whose button is pressed, then clears the field, says so, and puts focus back in the field', async () => {
    const f = await open()
    await f.type('sam')
    await f.press(f.invites()[0])
    expect(events.inviteByUsername).toHaveBeenCalledWith('s1', 'u-sam')
    expect(f.rows()).toHaveLength(0)
    expect(f.input().value).toBe('')
    expect(f.view.text()).toContain('Sam Tan is invited. They will see it on their Home screen.')
    expect(f.focus()).toBe('field')
  })

  it('says why an invitation failed and keeps the people', async () => {
    events.inviteByUsername.mockRejectedValue(new Error('You have already invited that person.'))
    const f = await open()
    await f.type('sam')
    await f.press(f.invites()[0])
    expect(f.view.all('p').some((p) => p.attrs.role === 'alert' && f.view.text(p) === 'You have already invited that person.')).toBe(true)
    expect(f.rows()).toHaveLength(3)
  })

  it('clears the text and the people with the clear button, and puts focus back in the field', async () => {
    const f = await open()
    await f.type('sam')
    await f.press(f.named('Clear search'))
    expect(f.input().value).toBe('')
    expect(f.rows()).toHaveLength(0)
    expect(f.view.text()).toContain('Type at least 3 letters')
    expect(f.named('Clear search')).toBeNull()
    expect(f.focus()).toBe('field')
  })

  it('stops a search that is still waiting when the screen goes, and cancels one that is running and shows nothing of its answer', async () => {
    const signals = []
    let answer
    api.searchPeople.mockImplementation((term, { signal }) => new Promise((resolve) => {
      signals.push(signal)
      answer = resolve
    }))
    const waiting = await open()
    waiting.view.type('input', 'sam')
    await vi.advanceTimersByTimeAsync(PEOPLE_SEARCH_DELAY_MS - 50)
    waiting.view.unmount()
    await vi.advanceTimersByTimeAsync(1000)
    expect(api.searchPeople).not.toHaveBeenCalled()

    const running = await open()
    await running.type('sam')
    expect(signals).toHaveLength(1)
    expect(signals[0].aborted).toBe(false)
    running.view.unmount()
    expect(signals[0].aborted).toBe(true)
    // A request that did not notice still answers: nothing is drawn or thrown.
    answer([SAM])
    await vi.advanceTimersByTimeAsync(1000)
    expect(running.view.errors).toEqual([])
    expect(running.view.warnings).toEqual([])
    expect(api.searchPeople).toHaveBeenCalledTimes(1)
  })
})
