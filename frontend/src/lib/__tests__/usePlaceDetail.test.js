// The helper the Vote page and the Roam page share to open a place's detail from a suggestion card and to give focus back
// when it closes (lib/usePlaceDetail.js). No page is drawn: the helper is called as a component's setup would call it.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createPinia, setActivePinia } from 'pinia'
import { effectScope } from 'vue'
import { fakeStorage } from './planFixture.js'

vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.mock('../api.js', async (original) => ({ ...(await original()), getPlace: vi.fn() }))
vi.stubGlobal('localStorage', fakeStorage())
const api = await import('../api.js')
const { usePlaceDetail } = await import('../usePlaceDetail.js')
const { useAuthStore } = await import('../../stores/auth.js')

const venue = { id: 'v1', name: 'Green Kitchen', category: 'eat', area: 'Bishan', price: 12 }
const option = { id: 'v1', venue, distanceM: 420 }
const SESSION = { activeIds: ['ian', 'faith', 'jonathan'], area: { id: 'bishan', name: 'Bishan' } }

let focused
beforeEach(() => {
  setActivePinia(createPinia())
  useAuthStore().user = { id: 'ian', name: 'Ian', username: 'ian', local: true }
  api.getPlace.mockReset().mockResolvedValue({ address: '1 Bishan Street' })
  focused = []
  vi.stubGlobal('CSS', { escape: (text) => String(text) })
  vi.stubGlobal('document', { querySelector: (selector) => ({ focus: (options) => focused.push([selector, options]) }) })
})
afterEach(() => vi.unstubAllGlobals())

const use = (session = SESSION) => effectScope().run(() => usePlaceDetail(() => session))

describe('usePlaceDetail', () => {
  it('lists the other people in the outing, not the signed-in person', () => {
    expect(use().outing.value).toEqual(['faith', 'jonathan'])
    expect(use(null).outing.value).toEqual([])
  })

  it('opens from the option at once, with its distance, and adds the address once the place list answers', async () => {
    const { detail, open } = use()
    open(option, 'name')
    expect(detail.value).toMatchObject({ optionId: 'v1', from: 'name', place: { name: 'Green Kitchen', distanceKm: 0.4 } })
    expect(detail.value.place.address).toBeUndefined()
    expect(detail.value.reviews.length).toBeGreaterThan(0)
    await vi.waitFor(() => expect(detail.value.place.address).toBe('1 Bishan Street'))
    expect(api.getPlace).toHaveBeenCalledWith('v1', 'bishan')
  })

  it('does not put one place\'s address on another that was opened since', async () => {
    let answer
    api.getPlace.mockReturnValueOnce(new Promise((resolve) => { answer = resolve })).mockReturnValueOnce(new Promise(() => {}))
    const { detail, open } = use()
    open(option)
    open({ id: 'v2', venue: { ...venue, id: 'v2', name: 'Other' } })
    answer({ address: 'Somewhere' })
    await new Promise((resolve) => setTimeout(resolve, 0))
    expect(detail.value.optionId).toBe('v2')
    expect(detail.value.place.address).toBeUndefined()
  })

  it('returns focus to the name for a detail opened from the name, and to the review line otherwise, and closes', async () => {
    const { detail, open, close } = use()
    open(option, 'name')
    await close()
    expect(detail.value).toBeNull()
    expect(focused).toEqual([['[data-open-for="v1"]', { preventScroll: true }]])
    open(option)
    await close()
    expect(focused.at(-1)).toEqual(['[data-review-for="v1"]', { preventScroll: true }])
  })

  it('resets without moving focus', () => {
    const { detail, open, reset } = use()
    open(option)
    reset()
    expect(detail.value).toBeNull()
    expect(focused).toEqual([])
  })
})
