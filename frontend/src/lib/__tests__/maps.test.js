import { describe, expect, it } from 'vitest'
import { directionsUrl } from '../maps.js'

describe('directionsUrl', () => {
  it('asks Google Maps for directions to the place by name and address', () => {
    const url = new URL(directionsUrl({ name: "Lola's Café", address: '5 Simon Road, Singapore 545893', lat: 1.36, lng: 103.88 }))
    expect(url.origin + url.pathname).toBe('https://www.google.com/maps/dir/')
    expect(url.searchParams.get('api')).toBe('1')
    expect(url.searchParams.get('destination')).toBe("Lola's Café, 5 Simon Road, Singapore 545893")
  })
  it('uses the coordinates when there is no address', () => {
    const url = new URL(directionsUrl({ name: 'Somewhere', lat: 1.3521, lng: 103.8198 }))
    expect(url.searchParams.get('destination')).toBe('1.3521,103.8198')
  })
})
