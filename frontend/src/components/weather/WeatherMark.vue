<script setup>
// The small weather mark on a stop or an option: words and an icon, in a neutral tag, or the warning tone for the rain warning
// (an exposed stop with rain likely). Never colour alone: the label says what it is ("Dry", "Showers", "Indoor", "Outdoor,
// thundery showers", "Weather is checked from the day before"). NEA's own phrase, or why the stop is flagged, follows the label for a screen reader only.
//   <WeatherMark :mark="stopMark(stop.weather, venueSetting(stop.venue))" />
// `mark` comes from lib/weatherText.js (stopMark for the itinerary, optionMark for the voting cards and Roam).
import InfoTag from '../ui/InfoTag.vue'

defineProps({
  mark: { type: Object, required: true },
})
</script>

<template>
  <InfoTag :tone="mark.tone" :icon="mark.icon" data-testid="weather-mark" :data-state="mark.state">
    {{ mark.label }}<span v-if="mark.hint" class="sr-only">. {{ mark.hint }}</span>
  </InfoTag>
</template>
