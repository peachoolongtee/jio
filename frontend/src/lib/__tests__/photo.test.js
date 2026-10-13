// Shrinking a profile photo (lib/photo.js). The test runner has no browser, so the file reader, the image and the canvas
// are small stand-ins that record what the code asks of them.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { PHOTO_MAX_BYTES, PHOTO_SIZE, shrinkPhoto } from '../photo.js'

afterEach(() => vi.unstubAllGlobals())

// Stand-ins for FileReader, Image and the canvas. `image` is the size of the picture in the file, or 'broken' for one
// that cannot be decoded; `reader: 'broken'` makes the file unreadable; `canvas: 'no-context'` is a canvas with no 2D
// context, and `canvas: 'no-export'` one that refuses to export. Returns what was drawn, in order: `calls` lists the
// canvas calls, and `fill` is the colour the square was filled with.
// How to call: const drawn = browser({ image: { width: 400, height: 200 } })
function browser({ image = { width: 400, height: 200 }, reader = 'ok', canvas: canvasMode = 'ok' } = {}) {
  const drawn = { calls: [] }
  vi.stubGlobal(
    'FileReader',
    class {
      readAsDataURL() {
        setTimeout(() => {
          if (reader === 'broken') this.onerror()
          else {
            this.result = 'data:image/png;base64,b3JpZ2luYWw='
            this.onload()
          }
        })
      }
    },
  )
  vi.stubGlobal(
    'Image',
    class {
      set src(value) {
        setTimeout(() => {
          if (image === 'broken') this.onerror()
          else {
            Object.assign(this, image)
            this.onload()
          }
        })
      }
    },
  )
  vi.stubGlobal('document', {
    createElement: () => {
      const canvas = {
        getContext: () => {
          if (canvasMode === 'no-context') return null
          const context = {
            fillStyle: '',
            fillRect: () => drawn.calls.push('fillRect') && Object.assign(drawn, { fill: context.fillStyle }),
            drawImage: (_img, x, y, w, h) => drawn.calls.push('drawImage') && Object.assign(drawn, { x, y, w, h }),
          }
          return context
        },
        toDataURL: (type, quality) => {
          if (canvasMode === 'no-export') throw new Error('The canvas is tainted.')
          Object.assign(drawn, { width: canvas.width, height: canvas.height, type, quality })
          return 'data:image/jpeg;base64,c21hbGw='
        },
      }
      return canvas
    },
  })
  return drawn
}

describe('shrinkPhoto', () => {
  it('makes a 160 px square JPEG, cut from the middle of the picture', async () => {
    const drawn = browser({ image: { width: 400, height: 200 } })
    expect(await shrinkPhoto({ type: 'image/png' })).toBe('data:image/jpeg;base64,c21hbGw=')
    expect(PHOTO_SIZE).toBe(160)
    expect(drawn).toMatchObject({ width: 160, height: 160, type: 'image/jpeg', quality: 0.8 })
    // A wide picture is scaled to the square's height and centred: 320 by 160, starting 80 px to the left.
    expect(drawn).toMatchObject({ x: -80, y: 0, w: 320, h: 160 })
  })

  it('refuses a file that is not an image, and no file at all, without reading it', async () => {
    const reader = vi.fn()
    vi.stubGlobal('FileReader', reader)
    await expect(shrinkPhoto({ type: 'application/pdf' })).rejects.toThrow('Choose an image file.')
    await expect(shrinkPhoto(undefined)).rejects.toThrow('Choose an image file.')
    expect(reader).not.toHaveBeenCalled()
  })

  it('says so when the picture cannot be opened, instead of never answering', async () => {
    browser({ image: 'broken' })
    await expect(shrinkPhoto({ type: 'image/heic' })).rejects.toThrow('That picture could not be opened. Try another one.')
    browser({ reader: 'broken' })
    await expect(shrinkPhoto({ type: 'image/png' })).rejects.toThrow('That picture could not be opened. Try another one.')
  })

  it('says so when drawing throws (no 2D context, a canvas that refuses to export), instead of never answering', async () => {
    browser({ canvas: 'no-context' })
    await expect(shrinkPhoto({ type: 'image/png' })).rejects.toThrow('That picture could not be opened. Try another one.')
    browser({ canvas: 'no-export' })
    await expect(shrinkPhoto({ type: 'image/png' })).rejects.toThrow('That picture could not be opened. Try another one.')
  })

  it('fills the square with white before drawing, so a transparent picture does not come out black', async () => {
    const drawn = browser()
    await shrinkPhoto({ type: 'image/png' })
    expect(drawn.fill).toBe('#ffffff')
    expect(drawn.calls).toEqual(['fillRect', 'drawImage'])
  })

  it('refuses a picture with no width or no height', async () => {
    for (const image of [{ width: 0, height: 200 }, { width: 400, height: 0 }, { width: 0, height: 0 }]) {
      browser({ image })
      await expect(shrinkPhoto({ type: 'image/png' })).rejects.toThrow('That picture could not be opened. Try another one.')
    }
  })

  it('refuses a file over 15 MB before reading it, and takes one of exactly 15 MB', async () => {
    const reader = vi.fn()
    vi.stubGlobal('FileReader', reader)
    await expect(shrinkPhoto({ type: 'image/png', size: PHOTO_MAX_BYTES + 1 })).rejects.toThrow('That picture is too large. Choose one under 15 MB.')
    expect(reader).not.toHaveBeenCalled()
    browser()
    await expect(shrinkPhoto({ type: 'image/png', size: PHOTO_MAX_BYTES })).resolves.toBe('data:image/jpeg;base64,c21hbGw=')
  })
})
