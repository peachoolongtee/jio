<script setup>
// Where the forecast on a screen came from, and when: one muted line, shown once under the list it belongs to.
//   <WeatherSource :block="itinerary.weather" />                          "NEA forecast, 14:10" (with the licence notice one tap away)
//   <WeatherSource :block="check.weather" refresh-failed />               "NEA forecast, 14:10 · could not check again"
//   <WeatherSource :block="plan.weather" banner />                        a simulated forecast as a banner at the top; nothing otherwise
// The words are made by lib/weatherText.js sourceLine: "NEA forecast, 14:10", "Weather is checked from the day before" (the stop
// is outside the forecast window), "Weather is not available right now" (the forecast could not be fetched) and, for a
// simulated forecast, "Simulated forecast". A simulated forecast is never muted: in the line it is an outlined tag with a
// sentence beside it, and with `banner` it is a banner. Screens that show weather put the banner at the top and the line
// under the list, so the label is the first thing seen while a simulated forecast is on.
// The Singapore Open Data Licence asks for a notice wherever NEA's forecast is shown: a live line has "About this forecast",
// which opens it.
import { computed, ref, useId } from 'vue'
import AppButton from '../ui/AppButton.vue'
import AppIcon from '../ui/AppIcon.vue'
import BannerNote from '../ui/BannerNote.vue'
import InfoTag from '../ui/InfoTag.vue'
import { SIMULATED_NOTE, SIMULATED_TEXT, licenceNotice, sourceLine } from '@/lib/weatherText.js'

const props = defineProps({
  // A weather object or block (lib/weatherText.js): { source, basis, issuedAt, phrase, reason }. Null reads as outside the window.
  block: { type: Object, default: null },
  // The last check on the day did not work, so the forecast is the one before it.
  refreshFailed: { type: Boolean, default: false },
  // Show only the simulated forecast's banner (and nothing for any other forecast).
  banner: { type: Boolean, default: false },
})

const line = computed(() => sourceLine(props.block, { refreshFailed: props.refreshFailed }))
const notice = computed(() => (line.value.kind === 'live' ? licenceNotice(props.block) : null))
const open = ref(false)
const noticeId = `wx-notice-${useId()}`
</script>

<template>
  <template v-if="banner">
    <BannerNote v-if="line.kind === 'simulated'" icon="info" data-testid="weather-simulated-banner">
      <strong>{{ SIMULATED_TEXT }}.</strong> {{ SIMULATED_NOTE }}
    </BannerNote>
  </template>
  <div v-else class="wx" data-testid="weather-source">
    <p v-if="line.kind === 'simulated'" class="wx__line wx__line--simulated">
      <InfoTag tone="strong" icon="info">{{ SIMULATED_TEXT }}</InfoTag>
      <span class="caption-sm">{{ SIMULATED_NOTE }}</span>
    </p>
    <p v-else class="wx__line caption-sm text-muted">
      <AppIcon name="info" :size="14" />
      <span>{{ line.text }}</span>
      <AppButton v-if="notice" variant="tertiary" underline small class="wx__more" :aria-expanded="open" :aria-controls="noticeId" @click="open = !open">
        About this forecast
      </AppButton>
    </p>
    <p v-if="notice && open" :id="noticeId" class="wx__notice caption-sm text-muted">
      {{ notice.before }}
      <a :href="notice.url" target="_blank" rel="noopener noreferrer">{{ notice.licence }}</a>{{ notice.after }}
    </p>
  </div>
</template>

<style scoped>
.wx { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.wx__line { display: flex; flex-wrap: wrap; align-items: center; gap: var(--spacing-xs) var(--spacing-sm); margin: 0; }
.wx__line :deep(svg) { flex-shrink: 0; }
.wx__line--simulated { color: var(--ink); }
.wx__line--simulated .caption-sm { font-weight: 600; }
.wx__more.btn { min-height: var(--tap-min); font-weight: 400; }
.wx__notice { margin: 0; max-width: 60ch; }
.wx__notice a { color: inherit; text-decoration: underline; }
.wx__notice a:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; border-radius: var(--rounded-xs); }
</style>
