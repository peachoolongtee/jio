// Sharing a photo from an outing to another app (WhatsApp, Instagram, Telegram...). A phone's own share sheet is used when the
// browser can hand it the picture itself (the Web Share API with files): it lists every app the person has, Instagram included.
// Elsewhere (most desktop browsers) the picture cannot be passed to an app from a web page, so the screen offers to save it and
// opens the app to post it there (ShareDialog). Only the photo and the outing's title leave the app, and only when the person
// presses a button: nothing is sent anywhere by this file on its own.

// The apps offered when the browser cannot share the picture itself. Each opens in a new tab with the words filled in where the
// app takes them; Instagram takes no words from a link, so it opens the app's own page.
// How to call: shareTargets('Saturday laksa run, on Jio') -> [{ id: 'whatsapp', label: 'WhatsApp', href: 'https://wa.me/?text=...' }, ...]
export function shareTargets(text) {
  const words = encodeURIComponent(text)
  return [
    { id: 'whatsapp', label: 'WhatsApp', href: `https://wa.me/?text=${words}` },
    { id: 'instagram', label: 'Instagram', href: 'https://www.instagram.com/' },
    { id: 'telegram', label: 'Telegram', href: `https://t.me/share/url?url=${words}` },
  ]
}

// The words that go with a shared photo: the outing's title, and where it was taken when that is known.
// How to call: shareText({ title: 'Saturday' }, 'Maxwell Food Centre') -> 'Saturday at Maxwell Food Centre, on Jio'
export function shareText(session, place = '') {
  const title = String(session?.title || 'Our outing').trim()
  return place ? `${title} at ${place}, on Jio` : `${title}, on Jio`
}

// A file name for a saved photo: the outing's title in plain letters, and the photo's id.
// How to call: photoFileName({ title: 'Sat @ Bugis!' }, { id: 'p12' }) -> 'jio-sat-bugis-p12.jpg'
export function photoFileName(session, photo) {
  const slug = String(session?.title || 'outing').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'outing'
  return `jio-${slug}-${photo?.id || 'photo'}.jpg`
}

// The photo as a File, for the share sheet. A photo's src is a data URL (lib/image.js), which fetch reads without a network call.
// How to call: const file = await photoFile('data:image/jpeg;base64,...', 'jio-saturday-p12.jpg')
export async function photoFile(src, name) {
  const blob = await (await fetch(src)).blob()
  return new File([blob], name, { type: blob.type || 'image/jpeg' })
}

// Hand a ready photo to the phone's share sheet. Answers 'shared', 'cancelled' (the person closed the sheet), 'blocked' (the browser
// says the press is too long ago to open a sheet: the caller then offers ShareDialog, and a new press may work) or 'unsupported'
// (this browser cannot share a picture, or refused to: the caller then offers ShareDialog).
// The file must already be made (photoFile, ahead of the press): browsers only open the sheet close to the tap, and every await
// before `share` puts it further away. So this calls `share` at once, with nothing awaited first.
// How to call: const how = await sharePhoto({ file, text: 'Saturday, on Jio' })
export async function sharePhoto({ file, text }, nav = globalThis.navigator) {
  if (!file || !nav?.share || !nav?.canShare) return 'unsupported'
  const data = { files: [file], text }
  if (!nav.canShare(data)) return 'unsupported'
  try {
    await nav.share(data)
    return 'shared'
  } catch (e) {
    if (e?.name === 'AbortError') return 'cancelled'
    return e?.name === 'NotAllowedError' ? 'blocked' : 'unsupported'
  }
}
