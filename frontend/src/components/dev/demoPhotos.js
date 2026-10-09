// Demo photos "from the day", made in the browser from the app's own place photos (src/assets/places), so the
// Photos page can be filled without any outside service. Each one is a different crop, shape, slight tilt and
// colour treatment (warm, cool, faded, punchy, now and then black and white), with a soft vignette and sometimes
// a warm light leak, so a full album reads as snaps from one outing rather than the same picture again.
// Development only: the Demo panel uses it.
//   const srcs = await makeDemoPhotos(['hawker', 'park', 'dessert'], 6, 's1')
import { seeded } from '@/lib/mock/history.js'
import { photoOfKind } from '@/lib/placeImages.js'

// Width and height of each shape, in px: portrait, landscape, square, tall, wide.
const SHAPES = [[480, 600], [560, 420], [500, 500], [450, 600], [560, 380]]
// Canvas filters for the looks. Browsers without canvas filters (older Safari) still get the crop and the light.
const LOOKS = [
  'sepia(0.18) saturate(1.12) brightness(1.04)',
  'saturate(0.9) hue-rotate(-8deg) brightness(1.02) contrast(1.03)',
  'contrast(0.88) brightness(1.1) saturate(0.82)',
  'contrast(1.12) saturate(1.22)',
  'sepia(0.08) saturate(1.05) contrast(1.05)',
  'grayscale(1) contrast(1.12) brightness(1.04)',
]
// Kinds to mix in when the session has fewer stops than photos, so the album has some variety.
const EXTRA_KINDS = ['hawker', 'cafe', 'park', 'dessert', 'attraction', 'market', 'bar', 'mall']

const images = new Map()
// The place photo for a kind, loaded once. How to call: await load('park')
function load(kind) {
  if (!images.has(kind)) {
    images.set(kind, new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = () => reject(new Error(`Could not load the ${kind} photo.`))
      img.src = photoOfKind(kind)
    }))
  }
  return images.get(kind)
}

// One photo as a JPEG data URL: a random crop of the place photo in the given shape, tilted a little, graded,
// with a vignette. `random` is a seeded generator, so the same session gets the same album.
// How to call: await makePhoto(img, [480, 600], random)
function makePhoto(img, [w, h], random) {
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d')

  // The crop: cover the frame, then zoom in up to 45% more on a random part of the photo.
  const zoom = 1 + random() * 0.45
  const scale = Math.max(w / img.width, h / img.height) * zoom
  const tilt = (random() - 0.5) * 0.05 // up to about 1.4 degrees either way
  const dw = img.width * scale * (1 + Math.abs(tilt) * 1.2)
  const dh = img.height * scale * (1 + Math.abs(tilt) * 1.2)
  const dx = -(dw - w) * random()
  const dy = -(dh - h) * random()
  const look = LOOKS[Math.floor(random() * (random() < 0.12 ? LOOKS.length : LOOKS.length - 1))]

  ctx.save()
  if ('filter' in ctx) ctx.filter = look
  ctx.translate(w / 2, h / 2)
  ctx.rotate(tilt)
  ctx.translate(-w / 2, -h / 2)
  ctx.drawImage(img, dx, dy, dw, dh)
  ctx.restore()

  // Now and then, a warm light leak from one corner, like sun in the lens.
  if (random() < 0.35) {
    const x = random() < 0.5 ? 0 : w
    const y = random() < 0.5 ? 0 : h
    const leak = ctx.createRadialGradient(x, y, 0, x, y, Math.max(w, h) * 0.7)
    leak.addColorStop(0, 'rgba(255, 170, 90, 0.35)')
    leak.addColorStop(1, 'rgba(255, 170, 90, 0)')
    ctx.globalCompositeOperation = 'screen'
    ctx.fillStyle = leak
    ctx.fillRect(0, 0, w, h)
  }
  // A soft vignette, darker in the corners.
  const vignette = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) / 2)
  vignette.addColorStop(0, 'rgba(0, 0, 0, 0)')
  vignette.addColorStop(1, 'rgba(0, 0, 0, 0.28)')
  ctx.globalCompositeOperation = 'source-over'
  ctx.fillStyle = vignette
  ctx.fillRect(0, 0, w, h)

  return canvas.toDataURL('image/jpeg', 0.78)
}

// `count` photos as JPEG data URLs, mostly of the session's own kinds of place (in the order visited), with a
// few others mixed in. `seed` keeps an album the same each time (the session id and how many it holds).
// How to call: await makeDemoPhotos(['hawker', 'park'], 6, 's1-0')
export async function makeDemoPhotos(kinds, count, seed) {
  const random = seeded(`jio-photos-${seed}`)
  const mix = kinds.length ? [...kinds, ...kinds, ...EXTRA_KINDS.filter((k) => !kinds.includes(k))] : EXTRA_KINDS
  const out = []
  for (let i = 0; i < count; i++) {
    const kind = mix[i % mix.length]
    const shape = SHAPES[Math.floor(random() * SHAPES.length)]
    out.push(makePhoto(await load(kind), shape, random))
  }
  return out
}
