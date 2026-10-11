// The review line on a suggestion card, rendered with a tiny stand-in for the page (miniDom.js): the line is there in every
// state of the card, it opens the reviews and does not vote, and the vote chip does not open it.
import { describe, expect, it } from 'vitest'
import { mount } from './miniDom.js'
import SuggestionCard from '../../components/event/SuggestionCard.vue'
import { cardLine } from '../reviewPick.js'
import { reviewsFor } from '../mock/reviews.js'

const VENUE = { id: 'maxwell-food-centre', name: 'Maxwell Food Centre', kind: 'hawker', category: 'eat', area: 'Chinatown', price: 6 }
const option = (over = {}) => ({
  id: VENUE.id, venue: VENUE, walk: 6, distanceM: 420, reasons: ['Near MRT'], warnings: [], votes: 1, voters: [], swap: null, ...over,
})
// The five people who write sample reviews for Ian's circle: every one of them is a friend or in the outing.
const CIRCLE = ['darius', 'jonathan', 'nicole', 'faith', 'darryl']
const reviewButton = (page) => page.all('button').find((b) => b.props['data-review-for'])
// Events the card sent, by name.
function watch(extra = {}) {
  const sent = { open: [], vote: [], swap: [] }
  const props = {
    option: option(), outing: [], friends: CIRCLE,
    onOpen: (o) => sent.open.push(o), onVote: (o) => sent.vote.push(o), onSwap: (o) => sent.swap.push(o), ...extra,
  }
  return { sent, page: mount(SuggestionCard, props) }
}

describe('the card\'s review line', () => {
  it('shows the reviewer\'s name, the start of the review in quotation marks, and "Sample"', () => {
    const { page } = watch()
    const line = reviewButton(page)
    const { review } = cardLine(VENUE, { friends: CIRCLE })
    expect(review).not.toBeNull()
    const text = page.textOf(line)
    expect(text).toContain(review.name)
    expect(text).toContain(`"${review.text}"`)
    expect(text).toContain('Sample')
  })

  it('is one button, named for a screen reader by the place, the reviewer and the start of the review', () => {
    const { page } = watch()
    const line = reviewButton(page)
    expect(page.all('button').filter((b) => b.props['data-review-for'])).toHaveLength(1)
    const { review } = cardLine(VENUE, { friends: CIRCLE })
    expect(page.attr(line, 'aria-label')).toMatch(new RegExp(`^Reviews of Maxwell Food Centre\\. ${review.name}, sample review: `))
    expect(page.attr(line, 'type')).toBe('button')
    // No button is inside another.
    const inside = (el) => { for (let n = el.parent; n; n = n.parent) if (n.tag === 'button') return true; return false }
    expect(page.all('button').some(inside)).toBe(false)
  })

  it('quotes someone in the outing before a friend', () => {
    const reviews = reviewsFor(VENUE)
    const writer = reviews.find((r) => CIRCLE.includes(r.personId))
    const { page } = watch({ outing: [writer.personId] })
    expect(page.textOf(reviewButton(page))).toContain(writer.name)
  })

  it('says how many sample reviews there are when no reviewer is in the outing or a friend', () => {
    const { page } = watch({ friends: [], outing: [] })
    const line = reviewButton(page)
    const count = reviewsFor(VENUE).length
    expect(page.textOf(line)).toBe(`${count} sample reviews`)
    expect(page.attr(line, 'aria-label')).toBe(`Reviews of Maxwell Food Centre. ${count} sample reviews`)
    expect(page.textOf(line)).not.toContain('"')
  })

  it('opens the reviews with the option when pressed, and does not vote or swap', async () => {
    const { page, sent } = watch({ option: option({ swap: { id: 'x', name: 'Indoor place' } }) })
    await page.button('Sample').click()
    expect(sent.open).toHaveLength(1)
    expect(sent.open[0].id).toBe(VENUE.id)
    expect(sent.vote).toHaveLength(0)
    expect(sent.swap).toHaveLength(0)
  })

  it('does not open when the vote chip is pressed, and does not vote when the line is pressed', async () => {
    const { page, sent } = watch()
    await page.button('Vote').click()
    expect(sent.vote).toHaveLength(1)
    expect(sent.open).toHaveLength(0)
    await reviewButton(page).listeners.click({ pointerType: 'mouse', detail: 1 })
    expect(sent.vote).toHaveLength(1)
    expect(sent.open).toHaveLength(1)
  })

  it('is still there on a card that is leading, behind, voted for, with a swap and with a rain warning', () => {
    for (const extra of [{ leading: true }, { behind: true }, { mine: true }, { selected: true }, { option: option({ swap: { id: 's', name: 'Indoor place' }, warnings: ['rain'] }) }]) {
      const { page } = watch(extra)
      expect(reviewButton(page), JSON.stringify(Object.keys(extra))).toBeTruthy()
      expect(page.textOf(reviewButton(page))).toContain('Sample')
    }
  })

  it('is still there, and still opens, when the vote is closed', async () => {
    const { page, sent } = watch({ closed: true })
    expect(page.all('button').some((b) => b.props.role === 'radio')).toBe(false)
    expect(reviewButton(page)).toBeTruthy()
    await page.button('Sample').click()
    expect(sent.open).toHaveLength(1)
  })

  it('is there with no outing or friends given (the design-system page), as a count', () => {
    const page = mount(SuggestionCard, { option: option() })
    expect(page.textOf(reviewButton(page))).toMatch(/^\d sample reviews$/)
  })

  it('has the place\'s own words: a bowling alley is not reviewed as a restaurant', () => {
    const bowling = { id: 'bowl', name: 'Bowl Bishan', category: 'activity', cuisine: 'bowling', area: 'Bishan', price: 12 }
    const { page } = watch({ option: option({ id: 'bowl', venue: bowling }) })
    const { review } = cardLine(bowling, { friends: CIRCLE })
    expect(page.textOf(reviewButton(page))).toContain(review.text)
    expect(review.text).not.toMatch(/food|stall|dish|portion|coffee|queue/i)
  })
})
