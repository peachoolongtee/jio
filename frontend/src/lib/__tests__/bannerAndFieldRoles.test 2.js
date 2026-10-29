// What a screen reader is told: an error banner is an alert unless it is a standing state of the screen (a cancelled or
// paused session), which is a status so it is not read out each time the screen loads. A Vote chip is a toggle among the
// card's other controls, not one radio of a set. Drawn with the stand-in page (miniDom.js).
import { describe, expect, it } from 'vitest'
import { createPinia } from 'pinia'
import { h } from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { mount } from './miniDom.js'
import BannerNote from '../../components/ui/BannerNote.vue'
import SessionNotices from '../../components/event/SessionNotices.vue'
import SuggestionCard from '../../components/event/SuggestionCard.vue'

const banner = (page) => page.all('div').find((d) => String(d.props.class || '').includes('banner '))
const roleOf = (page, el) => page.attr(el, 'role')

describe('BannerNote', () => {
  const note = (props, attrs = {}) => mount({ render: () => h(BannerNote, { ...props, ...attrs }, () => 'Words') })

  it('is an alert for an error, and a status for the other tones', () => {
    for (const [tone, role] of [['error', 'alert'], ['warning', 'status'], ['info', 'status']]) {
      const page = note({ tone })
      expect(roleOf(page, banner(page))).toBe(role)
    }
  })

  it('takes the role it is given, so a standing error can be a status', () => {
    const page = note({ tone: 'error' }, { role: 'status' })
    expect(roleOf(page, banner(page))).toBe('status')
  })
})

describe('SessionNotices', () => {
  const session = (over) => ({ id: 's1', title: 'Saturday', status: 'voting', activeIds: ['ian', 'faith'], hostId: 'ian', ...over })
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:rest(.*)*', component: { render: () => null } }] })
  const notices = (over) => mount(SessionNotices, { session: session(over) }, [createPinia(), router])

  it('says "Session cancelled" as a status, not an alert, since the session simply is cancelled', () => {
    const page = notices({ status: 'cancelled' })
    const el = page.all('div').find((d) => page.textOf(d) === 'Session cancelled')
    expect(el).toBeTruthy()
    expect(roleOf(page, banner(page))).toBe('status')
    expect(page.all('div').some((d) => d.props.role === 'alert')).toBe(false)
  })

  it('says "Not enough people" as a status, not an alert, for a paused session', () => {
    const page = notices({ status: 'voting', activeIds: ['ian'] })
    expect(page.text()).toContain('Not enough people')
    expect(roleOf(page, banner(page))).toBe('status')
    expect(page.all('div').some((d) => d.props.role === 'alert')).toBe(false)
  })
})

describe('the Vote chip', () => {
  const VENUE = { id: 'maxwell', name: 'Maxwell Food Centre', kind: 'hawker', category: 'eat', area: 'Chinatown', price: 6, hours: [], rating: 8.1 }
  const option = { id: 'maxwell', venue: VENUE, walk: 1, distanceM: 70, reasons: [], warnings: [], votes: 0, voters: [], swap: null }

  it('is a toggle button, not a radio, so every card\'s chip is a Tab stop of its own', () => {
    const page = mount(SuggestionCard, { option, outing: [], friends: [] })
    const el = page.button('Vote')
    expect(page.attr(el, 'role')).toBeUndefined()
    expect(page.attr(el, 'aria-checked')).toBeUndefined()
    expect(page.attr(el, 'aria-pressed')).toBe('false')
    expect(page.attr(el, 'tabindex')).toBeUndefined()
  })

  it('is pressed once voted, and keeps its name, so the state is said once', () => {
    const page = mount(SuggestionCard, { option, outing: [], friends: [], mine: true })
    const el = page.button('Voted')
    expect(page.attr(el, 'aria-pressed')).toBe('true')
    expect(page.attr(el, 'aria-label')).toBe('Vote for Maxwell Food Centre')
  })
})
