// Saved places (Faith, 4 November 2026): what is kept from a post, a demo account's list in this browser, a real account's through the table,
// and the two screens. The screens are drawn on the in-memory page (domless.js); no network.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createMemoryHistory, createRouter } from 'vue-router'
import { mountScreen, until } from './domless.js'
import { asSavedVenue, findSavedPin, forgetPostDraft, isSavedVenueId, knownVenue, matchesQuery, savedAddress, savedArea, savedCopy, savedKey, savedMapsUrl, savedVenueId, toSavedPlace } from '../savedPlaces.js'

const held = vi.hoisted(() => ({ findPlacesToSave: vi.fn(), listSavedPlaces: vi.fn(), savePlaces: vi.fn(), removeSavedPlace: vi.fn(), postReaderStatus: vi.fn(), placesFromPost: vi.fn() }))
vi.mock('../api.js', async (importOriginal) => ({ ...(await importOriginal()), ...held }))
vi.mock('../plannerApi.js', () => ({ api: { defaults: {} }, meetingArea: vi.fn(), rankSlot: vi.fn(), searchSlot: vi.fn() }))
vi.setConfig({ testTimeout: 20000 })

const POST_PLACE = {
  name: '下一家咖啡',
  nameEnglish: 'Next Door Cafe',
  tip: 'Try the paella',
  locationHint: 'Katong',
  // Google's details are on the place, and must not be kept.
  match: { placeId: 'g_one', name: 'Next Door Spanish Cafe', address: '699 E Coast Rd', rating: 4.3, ratingCount: 1051 },
  toSave: { googlePlaceId: 'g_one', name: '下一家咖啡', nameEnglish: 'Next Door Cafe', tip: 'Try the paella', postKey: 'tiktok:1', postUrl: 'https://www.youtube.com/watch?v=a1', platform: 'tiktok' },
}

describe('a saved place in a vote', () => {
  const POINT = { lat: 1.28, lng: 103.85 }
  // A OneMap that answers only what it was given. How to call: oneMap({ '048458': [{ name: 'X', postal: '048458', ...POINT }] })
  const oneMap = (answers) => vi.fn(async (q) => answers[q] || [])

  it('finds the pin by postal code first, exactly', async () => {
    const search = oneMap({ '048458': [{ name: 'Elsewhere', postal: '111111', lat: 1.3, lng: 103.9 }, { name: 'Amoy', postal: '048458', ...POINT }] })
    expect(await findSavedPin({ name: 'Amoy Hotel', locationHint: '76 Telok Ayer St, Singapore 048458' }, { search })).toEqual({ ...POINT, rough: false })
    expect(search).toHaveBeenCalledTimes(1)
  })

  it('then by the street without its unit, then by a place of the same name', async () => {
    expect(await findSavedPin({ name: 'A', locationHint: '70 Telok Ayer St, #01-01' }, { search: oneMap({ '70 Telok Ayer St': [{ name: 'B', ...POINT }] }) })).toEqual({ ...POINT, rough: false })
    expect(await findSavedPin({ name: 'Tong Lee', locationHint: null }, { search: oneMap({ 'Tong Lee': [{ name: 'TONG LEE', ...POINT }] }) })).toEqual({ ...POINT, rough: false })
  })

  it('never takes a place of another name, and an area only as a rough pin', async () => {
    expect(await findSavedPin({ name: 'Nylon', locationHint: null }, { search: oneMap({ Nylon: [{ name: 'Nylon Mansion', ...POINT }] }) })).toBeNull()
    const areas = [{ name: 'Katong Park', ...POINT }]
    expect(await findSavedPin({ name: 'Nylon', locationHint: 'Katong' }, { search: oneMap({}), areas })).toEqual({ ...POINT, rough: true })
    expect(await findSavedPin({ name: 'Nylon', locationHint: 'Joo Chiat' }, { search: oneMap({ 'Joo Chiat': [{ name: 'Joo Chiat Complex', ...POINT }] }), areas })).toEqual({ ...POINT, rough: true })
  })

  it('has no pin when nothing fits or OneMap fails, and never fails the add', async () => {
    expect(await findSavedPin({ name: 'Nylon', locationHint: 'somewhere near the river, I think' }, { search: oneMap({}) })).toBeNull()
    const down = vi.fn(async () => { throw new Error('503') })
    expect(await findSavedPin({ name: 'Nylon', locationHint: '70 Telok Ayer St' }, { search: down })).toBeNull()
  })

  it('copies the person\'s words and one category, and claims nothing Jio does not know', () => {
    const copy = savedCopy({ id: '7f3c', name: '下一家', nameEnglish: 'Next Door', categories: ['eat'], tip: 'Try the paella', locationHint: ' Katong ', googlePlaceId: 'g1' }, { ...POINT, rough: true })
    expect(copy).toEqual({ id: '7f3c', name: 'Next Door', category: 'eat', address: 'Katong', ...POINT, rough: true, googlePlaceId: 'g1' })
    expect(JSON.stringify(copy)).not.toContain('paella')
    expect(savedCopy({ id: '7f3c', name: 'A', categories: ['eat'] }, null)).toMatchObject({ address: null, lat: null, lng: null, rough: false })
    const venue = asSavedVenue({ ...copy, id: 'saved_7f3c' })
    expect(venue).toMatchObject({ saved: true, price: null, rating: null, hours: [], indoor: true })
    expect(venue.diet.halal).toBe('unknown')
    expect(isSavedVenueId(savedVenueId({ id: '7f3c' }))).toBe(true)
    expect(isSavedVenueId('v25')).toBe(false)
  })
})

describe('what is kept from a post', () => {
  it('keeps the post\'s words and Google\'s id, and nothing else of Google\'s', () => {
    const row = toSavedPlace(POST_PLACE, ['eat', 'drink'])
    expect(row).toEqual({ name: '下一家咖啡', nameEnglish: 'Next Door Cafe', categories: ['eat', 'drink'], tip: 'Try the paella', locationHint: 'Katong', googlePlaceId: 'g_one', postKey: 'tiktok:1', postUrl: 'https://www.youtube.com/watch?v=a1' })
    expect(JSON.stringify(row)).not.toContain('699 E Coast')
    expect(JSON.stringify(row)).not.toContain('Spanish')
    expect(JSON.stringify(row)).not.toContain('1051')
  })

  it('knows a place by its Google id, or with none by its name in any case', () => {
    expect(savedKey({ googlePlaceId: 'g_one', name: 'A' })).toBe(savedKey({ googlePlaceId: 'g_one', name: 'B' }))
    expect(savedKey({ googlePlaceId: null, name: ' Goliath OUTDOOR ' })).toBe(savedKey({ googlePlaceId: null, name: 'goliath outdoor' }))
    expect(savedKey({ googlePlaceId: null, name: 'A' })).not.toBe(savedKey({ googlePlaceId: 'A', name: 'A' }))
  })

  it('finds the place Jio knows it as by name, and never takes a place from Google', () => {
    const found = [{ id: 'google_x', name: 'Nylon Coffee' }, { id: 'nylon', name: 'NYLON  coffee!' }]
    expect(knownVenue({ name: 'Nylon Coffee' }, found).id).toBe('nylon')
    expect(knownVenue({ name: '尼龙', nameEnglish: 'Nylon Coffee' }, found).id).toBe('nylon')
    expect(knownVenue({ name: 'Nylon Coffee' }, [found[0]])).toBeNull()
    expect(knownVenue({ name: 'Somewhere else' }, found)).toBeNull()
  })

  it('matches what was typed against its names and where the post says it is', () => {
    const place = { name: '下一家', nameEnglish: 'Next Door', locationHint: 'Katong' }
    expect(matchesQuery(place, '')).toBe(true)
    expect(matchesQuery(place, 'next')).toBe(true)
    expect(matchesQuery(place, 'katong')).toBe(true)
    expect(matchesQuery(place, 'bugis')).toBe(false)
  })

  it('shows an area beside the category, and never a street address or a long description', () => {
    expect(savedArea({ locationHint: 'Tanjong Pagar' })).toBe('Tanjong Pagar')
    expect(savedArea({ locationHint: 'Raffles City' })).toBe('Raffles City')
    expect(savedArea({ locationHint: '70 Telok Ayer St, #01-01, Singapore 048458' })).toBe('')
    expect(savedArea({ locationHint: "Near Cedar Girls' (Secondary School), Aljunied Macpherson area" })).toBe('')
    expect(savedArea({ locationHint: null })).toBe('')
    expect(savedAddress({ locationHint: '70 Telok Ayer St, #01-01' })).toBe('70 Telok Ayer St, #01-01')
    expect(savedAddress({ locationHint: 'Tanjong Pagar' })).toBe('')
    expect(savedAddress({ locationHint: null })).toBe('')
  })

  it('links to Google Maps by id, or searches by name and hint', () => {
    expect(savedMapsUrl({ name: 'A', googlePlaceId: 'g_one' })).toContain('query_place_id=g_one')
    const search = savedMapsUrl({ name: 'Goliath', locationHint: 'Katong', googlePlaceId: null })
    expect(search).not.toContain('query_place_id')
    expect(search).toContain('Goliath')
    expect(search).toContain('Katong')
  })
})

const router = async (path) => {
  const r = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:any(.*)*', component: { render: () => null } }] })
  await r.push(path)
  return r
}

describe('"Places from a post"', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    forgetPostDraft()
    held.postReaderStatus.mockResolvedValue({ enabled: true })
    held.listSavedPlaces.mockResolvedValue([])
    held.savePlaces.mockResolvedValue([{ id: 'saved-1' }])
    held.placesFromPost.mockResolvedValue({ status: 'ok', places: [POST_PLACE, { name: 'Goliath Outdoor', locationHint: '', match: null, toSave: { googlePlaceId: null, name: 'Goliath Outdoor' } }], notes: [], source: {} })
  })
  const draw = async () => {
    const { default: View } = await import('@/views/PostPlacesView.vue')
    return mountScreen(View, { plugins: [await router('/places/from-post')] })
  }
  const read = async () => {
    const view = await draw()
    await until(() => view.has('[data-testid=post-link]'))
    view.type('input', 'https://www.youtube.com/watch?v=a1')
    await view.click(view.one('[data-testid=post-read]'))
    await until(() => view.has('[data-testid=post-kind]'))
    return view
  }
  // The chip of one category under one place, in the order they are drawn. How to call: kind(view, 0, 'Eat')
  const kind = (view, place, label) => view.all('[data-testid=post-kind]').filter((c) => view.text(c) === label)[place]

  it('offers the categories under each place with no box, and no save until one is picked', async () => {
    const view = await read()
    expect(view.all('[data-testid=post-kind]').map((c) => view.text(c))).toEqual(['Eat', 'Drink', 'Shop', 'Activity', 'Eat', 'Drink', 'Shop', 'Activity'])
    expect(view.has('input[type=checkbox]')).toBe(false)
    expect(view.has('[data-testid=post-save]')).toBe(false)
    await view.click(kind(view, 0, 'Eat'))
    expect(view.text('[data-testid=post-save]')).toBe('Save 1 place')
    await view.click(kind(view, 0, 'Eat'))
    expect(view.has('[data-testid=post-save]')).toBe(false)
    expect(view.errors).toEqual([])
  })

  it('saves only what is picked, in the one category picked last, and then says Saved as', async () => {
    const view = await read()
    await view.click(kind(view, 0, 'Drink'))
    await view.click(kind(view, 0, 'Eat'))
    await view.click('[data-testid=post-save]')
    await until(() => view.has('[data-testid=post-saved]'))
    expect(held.savePlaces).toHaveBeenCalledTimes(1)
    const [rows] = held.savePlaces.mock.calls[0]
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ name: '下一家咖啡', categories: ['eat'], googlePlaceId: 'g_one' })
    expect(view.text('[data-testid=post-saved]')).toContain('Saved as Eat')
    expect(view.all('[data-testid=post-kind]')).toHaveLength(4)
    expect(view.text('[data-testid=post-save-done]')).toContain('1 place saved')
  })

  it('shows a place already kept as Saved, with no chips', async () => {
    held.listSavedPlaces.mockResolvedValue([{ id: 's', googlePlaceId: 'g_one', name: 'x', categories: ['shop'] }])
    const view = await read()
    expect(view.text('[data-testid=post-saved]')).toContain('Saved as Shop')
    expect(view.all('[data-testid=post-kind]')).toHaveLength(4)
  })

  it('says why a save failed, and keeps what was picked', async () => {
    held.savePlaces.mockRejectedValue(new Error('Saved places are not available yet.'))
    const view = await read()
    await view.click(kind(view, 0, 'Eat'))
    await view.click('[data-testid=post-save]')
    await until(() => view.text('[data-testid=post-save-bar]').includes('not available yet'))
    expect(view.has('[data-testid=post-saved]')).toBe(false)
    expect(view.has('[data-testid=post-save]')).toBe(true)
  })

  it('keeps the link, the places and the picks after going to another page and back, with no second read', async () => {
    const view = await read()
    await view.click(kind(view, 0, 'Eat'))
    view.unmount()
    const back = await draw()
    await until(() => back.has('[data-testid=post-kind]'))
    expect(back.one('input').value).toBe('https://www.youtube.com/watch?v=a1')
    expect(back.text('[data-testid=post-save]')).toBe('Save 1 place')
    expect(held.placesFromPost).toHaveBeenCalledTimes(1)
  })

  it('keeps a link that was pasted and not read yet', async () => {
    const view = await draw()
    await until(() => view.has('[data-testid=post-link]'))
    view.type('input', 'https://www.youtube.com/watch?v=a2')
    view.unmount()
    const back = await draw()
    await until(() => back.has('[data-testid=post-link]'))
    expect(back.one('input').value).toBe('https://www.youtube.com/watch?v=a2')
  })

  it('names no site in the box', async () => {
    const view = await draw()
    await until(() => view.has('[data-testid=post-link]'))
    expect(view.one('input').attrs.placeholder).toBe('Paste a link')
  })
})

describe('the Saved places page', () => {
  const SAVED = { id: 's1', name: '下一家', nameEnglish: 'Next Door Cafe', categories: ['eat'], tip: 'Try the paella', locationHint: 'Katong', googlePlaceId: 'g_one', postUrl: 'https://www.youtube.com/watch?v=a1' }
  beforeEach(() => vi.clearAllMocks())
  const draw = async () => {
    const { default: View } = await import('@/views/SavedPlacesView.vue')
    return mountScreen(View, { plugins: [await router('/places/saved')] })
  }
  afterEach(() => vi.unstubAllGlobals())

  it('goes back to the profile when it was opened from there, and to the post page otherwise', async () => {
    held.listSavedPlaces.mockResolvedValue([])
    const { default: View } = await import('@/views/SavedPlacesView.vue')
    const fromProfile = await mountScreen(View, { plugins: [await router('/places/saved?from=profile')] })
    await until(() => fromProfile.has('[data-testid=saved-empty]'))
    expect(fromProfile.all('a').some((a) => a.attrs.href === '/profile')).toBe(true)
    fromProfile.unmount()
    const fromPost = await mountScreen(View, { plugins: [await router('/places/saved')] })
    await until(() => fromPost.has('[data-testid=saved-empty]'))
    expect(fromPost.all('a').some((a) => a.attrs.href === '/places/from-post')).toBe(true)
  })

  it('says what to do when there are none', async () => {
    held.listSavedPlaces.mockResolvedValue([])
    const view = await draw()
    await until(() => view.has('[data-testid=saved-empty]'))
    expect(view.text()).toContain('No saved places yet')
  })

  it('shows what the post said, with its address when the post gave one, and asks Google nothing', async () => {
    held.listSavedPlaces.mockResolvedValue([SAVED, { ...SAVED, id: 's2', nameEnglish: 'ASAP', locationHint: '70 Telok Ayer St, #01-01' }])
    const view = await draw()
    await until(() => view.has('[data-testid=saved-place]'))
    const [area, address] = view.all('[data-testid=saved-place]')
    expect(view.text(area)).toContain('Next Door Cafe')
    expect(view.text(area)).toContain('Eat · Katong')
    expect(area.querySelector('[data-testid=saved-address]')).toBeFalsy()
    expect(view.text(address.querySelector('[data-testid=saved-address]'))).toBe('70 Telok Ayer St, #01-01')
    expect(view.has('[data-testid=saved-show]')).toBe(false)
  })

  it('filters by category with a chip for each category the list has', async () => {
    held.listSavedPlaces.mockResolvedValue([SAVED, { ...SAVED, id: 's2', nameEnglish: 'Goliath Outdoor', categories: ['shop'] }])
    const view = await draw()
    await until(() => view.has('[data-testid=saved-place]'))
    const chips = () => view.all('[data-testid=saved-filter]')
    expect(chips().map((c) => view.text(c))).toEqual(['All', 'Eat', 'Shop'])
    expect(view.all('[data-testid=saved-place]')).toHaveLength(2)
    await view.click(chips()[1])
    expect(view.all('[data-testid=saved-place]').map((c) => view.text(c)).join()).toContain('Next Door Cafe')
    expect(view.all('[data-testid=saved-place]')).toHaveLength(1)
    await view.click(chips()[2])
    expect(view.text(view.all('[data-testid=saved-place]')[0])).toContain('Goliath Outdoor')
  })

  it('goes back to All when the last place of the chosen category is removed', async () => {
    held.listSavedPlaces.mockResolvedValue([SAVED, { ...SAVED, id: 's2', nameEnglish: 'Goliath Outdoor', categories: ['shop'] }])
    held.removeSavedPlace.mockResolvedValue()
    const view = await draw()
    await until(() => view.has('[data-testid=saved-place]'))
    await view.click(view.all('[data-testid=saved-filter]').find((c) => view.text(c) === 'Shop'))
    await view.click('[data-testid=saved-remove]')
    await until(() => view.has('[data-testid=saved-remove-confirm]'))
    await view.click('[data-testid=saved-remove-confirm]')
    await until(() => view.all('[data-testid=saved-filter]').length === 2)
    expect(view.text(view.all('[data-testid=saved-place]')[0])).toContain('Next Door Cafe')
  })

  it('asks before removing a place, then takes it off the list', async () => {
    held.listSavedPlaces.mockResolvedValue([SAVED])
    held.removeSavedPlace.mockResolvedValue()
    const view = await draw()
    await until(() => view.has('[data-testid=saved-remove]'))
    await view.click('[data-testid=saved-remove]')
    await until(() => view.has('[data-testid=saved-remove-confirm]'))
    expect(held.removeSavedPlace).not.toHaveBeenCalled()
    await view.click('[data-testid=saved-remove-confirm]')
    await until(() => view.has('[data-testid=saved-empty]'))
    expect(held.removeSavedPlace).toHaveBeenCalledWith('s1')
  })
})

describe('Add a place', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    held.listSavedPlaces.mockResolvedValue([])
    held.savePlaces.mockResolvedValue([{ id: 'saved-9' }])
    held.findPlacesToSave.mockResolvedValue({ places: [], unavailable: false })
  })
  const draw = async () => {
    const { default: Sheet } = await import('@/components/saved/AddPlaceSheet.vue')
    return mountScreen(Sheet, { props: { open: true }, plugins: [await router('/places/saved')] })
  }
  const box = (view) => view.one('[data-testid=add-place]').querySelector('input')
  const type = (view, text) => { box(view).value = text; box(view).dispatch('input') }

  it('searches as a person types, and keeps a Jio place with its category ready', async () => {
    held.findPlacesToSave.mockResolvedValue({ places: [{ key: 'j', name: 'Nylon Coffee', sub: 'Everton Park', source: 'jio', category: 'drink', locationHint: 'Everton Park' }], unavailable: false })
    const view = await draw()
    type(view, 'nylon')
    await until(() => view.has('[data-testid=add-row]'))
    expect(held.findPlacesToSave.mock.calls[0][0]).toBe('nylon')
    await view.click('[data-testid=add-row]')
    await until(() => view.has('[data-testid=add-save]'))
    await view.click('[data-testid=add-save]')
    await until(() => held.savePlaces.mock.calls.length === 1)
    expect(held.savePlaces.mock.calls[0][0][0]).toEqual({ name: 'Nylon Coffee', nameEnglish: null, categories: ['drink'], tip: null, locationHint: 'Everton Park', googlePlaceId: null, postKey: null, postUrl: null })
  })

  it('does not search for one or two letters', async () => {
    const view = await draw()
    type(view, 'ny')
    await new Promise((resolve) => setTimeout(resolve, 700))
    expect(held.findPlacesToSave).not.toHaveBeenCalled()
    expect(view.errors).toEqual([])
  })

  it('keeps the words typed and the id from a Google result, and not Google\'s name or address', async () => {
    held.findPlacesToSave.mockResolvedValue({ places: [{ key: 'g', name: 'The Velvet Cut Steakhouse', sub: '51 Joo Chiat Rd', source: 'google', address: '51 Joo Chiat Rd', placeId: 'g_one' }], unavailable: false })
    const view = await draw()
    type(view, 'velvet cut')
    await until(() => view.has('[data-testid=add-row]'))
    await view.click('[data-testid=add-row]')
    await until(() => view.has('[data-testid=add-kind]'))
    expect(view.text('[data-testid=add-shown]')).toContain('51 Joo Chiat Rd')
    await view.click(view.all('[data-testid=add-kind]')[0])
    await view.click('[data-testid=add-save]')
    await until(() => held.savePlaces.mock.calls.length === 1)
    const [row] = held.savePlaces.mock.calls[0][0]
    expect(row).toMatchObject({ name: 'velvet cut', googlePlaceId: 'g_one', categories: ['eat'], locationHint: null })
    expect(JSON.stringify(row)).not.toContain('Joo Chiat')
    expect(JSON.stringify(row)).not.toContain('Steakhouse')
  })

  it('can add what was typed when nothing is found, and needs a category first', async () => {
    const view = await draw()
    type(view, 'Secret Supper Club')
    await until(() => view.has('[data-testid=add-typed]') && held.findPlacesToSave.mock.calls.length > 0)
    await view.click('[data-testid=add-typed]')
    await until(() => view.has('[data-testid=add-save]'))
    expect(view.one('[data-testid=add-save]').attrs.disabled).toBeDefined()
    // One category: picking another replaces it, and pressing it again unpicks it.
    await view.click(view.all('[data-testid=add-kind]')[0])
    await view.click(view.all('[data-testid=add-kind]')[1])
    expect(view.all('[data-testid=add-kind]').filter((c) => c.attrs['aria-checked'] === 'true')).toHaveLength(1)
    await view.click(view.all('[data-testid=add-kind]')[1])
    expect(view.one('[data-testid=add-save]').attrs.disabled).toBeDefined()
    await view.click(view.all('[data-testid=add-kind]')[1])
    await view.click('[data-testid=add-save]')
    await until(() => held.savePlaces.mock.calls.length === 1)
    expect(held.savePlaces.mock.calls[0][0][0]).toMatchObject({ name: 'Secret Supper Club', categories: ['drink'] })
  })

  it('says when the place is already saved', async () => {
    held.savePlaces.mockResolvedValue([])
    const view = await draw()
    type(view, 'Secret Supper Club')
    await until(() => view.has('[data-testid=add-typed]'))
    await view.click('[data-testid=add-typed]')
    await until(() => view.has('[data-testid=add-kind]'))
    await view.click(view.all('[data-testid=add-kind]')[0])
    await view.click('[data-testid=add-save]')
    await until(() => view.has('[data-testid=add-error]'))
    expect(view.text('[data-testid=add-error]')).toContain('already saved')
  })
})
