// A Google Maps link with directions to a place, for the Navigate button (open it in a new tab).
// The name and address let Maps find the venue itself; without an address, the exact coordinates.
// Public transport by default, since most of Jio's groups take the MRT.
export function directionsUrl(place) {
  // A place with no pin stands at the meeting area only for the travel times, so its point is never a destination.
  const destination = place.address ? `${place.name}, ${place.address}` : place.noPin ? `${place.name}, Singapore` : `${place.lat},${place.lng}`
  return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(destination)}&travelmode=transit`
}
