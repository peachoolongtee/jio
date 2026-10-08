// A Google Maps link with directions to a place, for the Navigate button (open it in a new tab).
// The name and address let Maps find the venue itself; without an address, the exact coordinates.
// Public transport by default, since most of Jio's groups take the MRT.
export function directionsUrl(place) {
  const destination = place.address ? `${place.name}, ${place.address}` : `${place.lat},${place.lng}`
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=transit`
}
