// The real heights of the top bar and the tab bar, for a script that keeps something clear of them (a hover card's
// clamp). They come from the page's two custom properties in styles/tokens.css, which include the safe-area inset the bar
// grows by, so the CSS and the script read one source. Registered there as lengths, they read back in px.

// The number of px in a length, or `fallback` when it is not one (a browser that does not register custom properties
// reads them back as text).
// How to call: px('72px', 0) -> 72; px('calc(72px + 0px)', 0) -> 0; px('', 8) -> 8
function px(text, fallback) {
  const value = parseFloat(text)
  return Number.isFinite(value) && /px\s*$/.test(String(text).trim()) ? value : fallback
}

// How to call: barHeights() -> { top: 72, bottom: 0 }; barHeights(getComputedStyle(el)) to read from another element
export function barHeights(style = getComputedStyle(document.documentElement)) {
  const read = (real, nominal) => px(style.getPropertyValue(real), px(style.getPropertyValue(nominal), 0))
  return { top: read('--topbar-real-height', '--topbar-height'), bottom: read('--tabbar-real-height', '--tabbar-height') }
}
