// The Vote card's name, tags and voters, rendered with the stand-in page (miniDom.js). The name is the control that opens the
// place (its press area also covers the photo, in CSS); the tags and the voters' words come from lib/cardText.js.
import { describe, expect, it } from 'vitest'
import { mount } from './miniDom.js'
import SuggestionCard from '../../components/event/SuggestionCard.vue'

const VENUE = { id: 'maxwell-food-centre', name: 'Maxwell Food Centre', kind: 'hawker', category: 'eat', area: 'Chinatown', price: 6, hours: ['10:00-22:00'], rating: 8.1 }
const option = (over = {}) => ({
  id: VENUE.id, venue: VENUE, walk: 1, distanceM: 70, reasons: ['Near MRT', 'Short walk'], warnings: [], votes: 0, voters: [], swap: null, ...over,
})
function watch(extra = {}) {
  const sent = { open: [], vote: [], swap: [] }
  const props = {
    option: option(), outing: [], friends: [],
    onOpen: (...args) => sent.open.push(args), onVote: (o) => sent.vote.push(o), onSwap: (o) => sent.swap.push(o), ...extra,
  }
  return { sent, page: mount(SuggestionCard, props) }
}
const openButton = (page) => page.all('button').find((b) => b.props['data-open-for'])
const inside = (el, tag) => { for (let n = el.parent; n; n = n.parent) if (n.tag === tag) return true; return false }

describe('the card\'s name', () => {
  it('is one button, named "Open <place>", inside the heading, and the heading stays', () => {
    const { page } = watch()
    const button = openButton(page)
    expect(page.all('button').filter((b) => b.props['data-open-for'])).toHaveLength(1)
    expect(page.attr(button, 'aria-label')).toBe('Open Maxwell Food Centre')
    expect(page.attr(button, 'type')).toBe('button')
    expect(page.textOf(button)).toBe('Maxwell Food Centre')
    const headings = page.all('h4')
    expect(headings).toHaveLength(1)
    expect(page.textOf(headings[0])).toBe('Maxwell Food Centre')
    expect(inside(button, 'h4')).toBe(true)
  })

  it('opens the place when pressed, with the option and where it was pressed, and does not vote or swap', async () => {
    const { page, sent } = watch({ option: option({ swap: { id: 'x', name: 'Indoor place' } }) })
    await page.button('Maxwell Food Centre').click()
    expect(sent.open).toHaveLength(1)
    expect(sent.open[0][0].id).toBe(VENUE.id)
    expect(sent.open[0][1]).toBe('name')
    expect(sent.vote).toHaveLength(0)
    expect(sent.swap).toHaveLength(0)
  })

  it('has no button inside another, and the photo is not a second control', () => {
    const { page } = watch({ option: option({ swap: { id: 'x', name: 'Indoor place' } }) })
    expect(page.all('button').some((b) => inside(b, 'button'))).toBe(false)
    expect(page.all('img').some((i) => inside(i, 'button'))).toBe(false)
    // Name, review line, swap and vote chip: four controls, each separate.
    expect(page.all('button')).toHaveLength(4)
  })

  it('leaves the review line and the vote chip as they were', async () => {
    const { page, sent } = watch()
    await page.button('Vote').click()
    expect(sent.vote).toHaveLength(1)
    expect(sent.open).toHaveLength(0)
    await page.all('button').find((b) => b.props['data-review-for']).listeners.click({ pointerType: 'mouse', detail: 1 })
    expect(sent.vote).toHaveLength(1)
    expect(sent.open).toHaveLength(1)
    expect(sent.open[0][1]).toBe('review')
  })

  it('is there on a closed card too', () => {
    const { page } = watch({ closed: true })
    expect(openButton(page)).toBeTruthy()
  })
})

describe('the card\'s tags', () => {
  it('drops "Short walk", keeps "Near MRT", and adds the hours when told the stop', () => {
    const { page } = watch({ stop: { start: 19 * 60, duration: 90 } })
    expect(page.text()).not.toContain('Short walk')
    expect(page.text()).toContain('Near MRT')
    expect(page.text()).toContain('Open until 22:00')
    expect(page.text()).toContain('about 1 min walk')
  })

  it('warns when the place closes during the stop, or is closed at its start', () => {
    expect(watch({ stop: { start: 21 * 60, duration: 90 } }).page.text()).toContain('Closes at 22:00')
    expect(watch({ stop: { start: 8 * 60, duration: 60 } }).page.text()).toContain('Closed at this time')
  })

  it('shows no hours tag without a stop, or for a place with no hours', () => {
    expect(watch().page.text()).not.toMatch(/Open until|Closes at|Closed at this time|undefined/)
    const noHours = option({ venue: { ...VENUE, hours: [] } })
    const text = watch({ option: noHours, stop: { start: 720, duration: 60 } }).page.text()
    expect(text).not.toMatch(/Open until|Closes at|Closed at this time|undefined/)
    const missing = option({ venue: { ...VENUE, hours: undefined } })
    expect(watch({ option: missing, stop: { start: 720, duration: 60 } }).page.text()).not.toMatch(/undefined/)
  })

  it('still shows "Leading" and the rain warning', () => {
    const { page } = watch({ leading: true, stop: { start: 19 * 60, duration: 90 }, option: option({ warnings: ['rain'], reasons: ['Near MRT', 'Hidden gem'] }) })
    const text = page.text()
    expect(text).toContain('Leading')
    expect(text).toContain('Outdoor, rain expected')
    expect(text).toContain('Near MRT')
    expect(text).toContain('Hidden gem')
    expect(text).toContain('Open until 22:00')
  })
})

describe('the card\'s voters', () => {
  const people = (...ids) => ids.map((id) => ({ id, name: id[0].toUpperCase() + id.slice(1) }))
  const card = (ids, groupSize, me = 'ian') => watch({ option: option({ voters: people(...ids), votes: ids.length }), groupSize, me }).page.text()

  it('keeps "0 votes" with nobody voting, and the count when it is not told the group', () => {
    expect(card([], 3)).toContain('0 votes')
    expect(card(['darius'], 0)).toContain('1 vote')
    expect(card(['darius', 'nicole'], 0)).toContain('2 votes')
  })

  it('names the voters of a small group, "You" first', () => {
    expect(card(['darius'], 4)).toContain('Darius voted')
    expect(card(['darius', 'nicole'], 4)).toContain('Darius and Nicole voted')
    expect(card(['darius', 'ian'], 4)).toContain('You and Darius voted')
    expect(card(['darius', 'ian', 'nicole'], 4)).toContain('You, Darius and Nicole voted')
    expect(card(['ian', 'darius', 'nicole', 'faith'], 4)).toContain('Everyone voted')
  })

  it('keeps the count for a group of five or more', () => {
    expect(card(['darius'], 5)).toContain('1 vote')
    expect(card(['darius', 'nicole'], 6)).toContain('2 votes')
    expect(card(['darius', 'nicole'], 6)).not.toContain('voted')
  })

  it('keeps the avatar stack beside the words', () => {
    const { page } = watch({ option: option({ voters: people('darius'), votes: 1 }), groupSize: 3 })
    expect(page.all('span').some((s) => s.props.role === 'img' && /Darius/.test(s.props['aria-label']))).toBe(true)
  })
})
