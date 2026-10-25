// The words and small decisions behind the Start choice (lib/startChoice.js): the cards, the main button's label, the area search, what a
// guest and the host are told, and turning the browser's location into an area. No screen, no network.
import { describe, expect, it, vi } from 'vitest'
import { AREAS } from '../mock/places.js'
import { CHOICES, POPULAR_AREAS, START_NOTE, WHERE_NOTE, areaHere, findAreas, guestLine, hostPendingLine, locationError, meetByOf, startLabel, whereLabel } from '../startChoice.js'

describe('the two choices', () => {
  it('are the fairest spot (the default, tagged) and "We already know where"', () => {
    expect(CHOICES.map((c) => c.key)).toEqual(['fairest', 'known'])
    expect(CHOICES[0]).toMatchObject({ title: 'Find the fairest spot', tag: 'Default' })
    expect(CHOICES[1]).toMatchObject({ title: 'We already know where', tag: '' })
  })

  it('name the main button for the choice, with the notes under it', () => {
    expect(startLabel('fairest')).toBe('Ask everyone to share where they start')
    expect(startLabel('known')).toBe('Choose the area')
    expect(START_NOTE).toBe('Guests see that you chose this.')
    expect(WHERE_NOTE).toBe('Then you choose places together.')
    expect(whereLabel({ name: 'Bishan' })).toBe('Meet at Bishan')
    expect(whereLabel(null, true)).toBe('Use my location')
    expect(whereLabel(null)).toBe('Choose an area')
  })

  it('read a session with none as the fairest spot, so an old session does not change', () => {
    expect(meetByOf({ meetBy: null })).toBe('fairest')
    expect(meetByOf({})).toBe('fairest')
    expect(meetByOf({ meetBy: 'known' })).toBe('known')
  })
})

describe('the areas on the follow-up', () => {
  it('offers the seven popular areas, every one in the app\'s own area list', () => {
    expect(POPULAR_AREAS).toEqual(['bishan', 'tampines', 'jurong-east', 'bugis', 'orchard', 'punggol', 'woodlands'])
    for (const id of POPULAR_AREAS) expect(AREAS.some((a) => a.id === id)).toBe(true)
    expect(findAreas('').map((a) => a.name)).toEqual(['Bishan', 'Tampines', 'Jurong East', 'Bugis', 'Orchard', 'Punggol', 'Woodlands'])
  })

  it('finds an area by part of its name, ignoring case and extra spaces, and finds none for nonsense', () => {
    expect(findAreas('  JURONG  ').map((a) => a.id)).toEqual(['jurong-east'])
    expect(findAreas('bis').map((a) => a.id)).toEqual(['bishan'])
    expect(findAreas('zzz')).toEqual([])
    expect(findAreas('a', 3)).toHaveLength(3)
  })
})

describe('what the group is told', () => {
  const base = { status: 'locating', hostId: 'ian' }

  it('tells a guest which way the host chose, by the host\'s name', () => {
    const fair = guestLine({ ...base, meetBy: 'fairest' }, 'Ian', 'faith')
    expect(fair.title).toBe('Ian chose to find the fairest spot')
    expect(fair.text).toBe("Add where you are starting. Jio then finds the meeting point that is fair on everyone's trip. You can still suggest a spot.")
    expect(guestLine({ ...base, meetBy: 'known' }, 'Ian', 'faith').title).toBe('Ian chose the place')
  })

  it('says nothing to the host, for a session that started before the choice, or once the group has moved on', () => {
    expect(guestLine({ ...base, meetBy: 'fairest' }, 'Ian', 'ian')).toBeNull()
    expect(guestLine({ ...base, meetBy: null }, 'Ian', 'faith')).toBeNull()
    expect(guestLine({ ...base, meetBy: 'known', status: 'voting' }, 'Ian', 'faith')).toBeNull()
    expect(guestLine({ ...base, meetBy: 'known', status: 'inviting' }, 'Ian', 'faith')).toBeNull()
    expect(guestLine(null, 'Ian', 'faith')).toBeNull()
  })

  it('reminds the host only when they chose a known place and it is not named yet', () => {
    expect(hostPendingLine({ ...base, meetBy: 'known' }, 'ian')).toMatch(/We already have a place/)
    expect(hostPendingLine({ ...base, meetBy: 'known' }, 'faith')).toBeNull()
    expect(hostPendingLine({ ...base, meetBy: 'fairest' }, 'ian')).toBeNull()
    expect(hostPendingLine({ ...base, meetBy: 'known', status: 'voting' }, 'ian')).toBeNull()
  })
})

describe('areaHere', () => {
  const where = (lat, lng) => ({ getCurrentPosition: (ok) => ok({ coords: { latitude: lat, longitude: lng } }) })
  const refused = (code) => ({ getCurrentPosition: (_ok, no) => no({ code }) })

  it('turns the position into the area and passes on only that', async () => {
    const placeFromCoords = vi.fn(async () => ({ id: 'here-tampines', areaId: 'tampines', sub: 'Tampines' }))
    const place = await areaHere(where(1.3521, 103.9448), placeFromCoords)
    expect(place.areaId).toBe('tampines')
    expect(placeFromCoords).toHaveBeenCalledWith(1.3521, 103.9448)
  })

  it('says why when location is refused, missing, slow or outside Singapore', async () => {
    const none = async () => null
    await expect(areaHere(refused(1), none)).rejects.toThrow('Location access is off. Pick an area instead.')
    await expect(areaHere(refused(2), none)).rejects.toThrow('Your location could not be found. Pick an area instead.')
    await expect(areaHere(refused(3), none)).rejects.toThrow('Finding your location took too long. Pick an area instead.')
    await expect(areaHere(null, none)).rejects.toThrow('This browser cannot share your location. Pick an area instead.')
    await expect(areaHere(where(51.5, -0.12), none)).rejects.toThrow('Your location is outside Singapore. Pick an area instead.')
    expect(locationError({ message: 'odd' })).toBe('odd')
  })
})
