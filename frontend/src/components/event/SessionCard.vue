<script setup>
// A session on Home, the Sessions list and a profile: status, when it starts, title, date, people
// and where it stands. The whole card links to the screen for the session's status.
//   <SessionCard :session="session" :names="nameOf" />        a compact card
//   <SessionCard :session="session" :names="nameOf" hero />   the large card at the top of Home,
//                                                             photo-first when the day has photos
// Both are flat white cards with a hairline, like Airbnb's reservation card; they lift on hover.
import { computed, watch } from 'vue'
import { RouterLink } from 'vue-router'
import AppIcon from '../ui/AppIcon.vue'
import AvatarStack from '../ui/AvatarStack.vue'
import CategoryIcon from '../ui/CategoryIcon.vue'
import CountdownChip from '../ui/CountdownChip.vue'
import StatusPill from '../ui/StatusPill.vue'
import { dateLine, sessionPath } from '@/lib/session.js'
import { durationLabel } from '@/lib/planner/format.js'
import { useEventsStore } from '@/stores/events.js'

const props = defineProps({
  session: { type: Object, required: true },
  // (id) => name, for the avatars.
  names: { type: Function, required: true },
  hero: { type: Boolean, default: false },
})

const people = computed(() => props.session.activeIds.map((id) => ({ id, name: props.names(id) })).filter((p) => p.name))
const where = computed(() => {
  const s = props.session
  if (s.areaName) return s.areaName
  if (s.status === 'inviting' || s.status === 'cancelled') return ''
  return 'Area pending'
})

// A session summary has only photoCount, so the hero card loads the pictures (the store keeps them fresh).
// The band is decoration: if they do not load, the card simply has no band.
const events = useEventsStore()
watch(
  () => [props.hero, props.session.id, props.session.photoCount],
  ([hero, id, count]) => {
    if (hero && count) events.loadPhotos(id).catch(() => {})
  },
  { immediate: true },
)
const photos = computed(() => (props.session.photoCount ? events.photos[props.session.id] || [] : []).slice(-3).reverse())
</script>

<template>
  <RouterLink :to="sessionPath(session)" class="session-card" :class="{ 'session-card--hero': hero }">
    <!-- Photo-first, like a listing card: the latest photos from the day. -->
    <div v-if="hero && photos.length" class="session-card__photos" :class="`has-${photos.length}`">
      <img v-for="p in photos" :key="p.id" :src="p.src" alt="" />
    </div>

    <div class="session-card__body">
      <div class="session-card__top">
        <StatusPill :status="session.status" />
        <CountdownChip :session="session" />
      </div>
      <h3 class="session-card__title clamp-2" :class="hero ? 'display-lg' : 'title-md'">{{ session.title }}</h3>
      <p class="body-sm text-muted tnum">{{ dateLine(session) }}</p>

      <ul v-if="session.status === 'voting' && session.slots.length" class="session-card__slots">
        <li v-for="slot in session.slots" :key="slot.id" class="session-card__slot">
          <CategoryIcon :category="slot.category" :size="24" />
          <span class="caption-sm tnum">{{ slot.time }} · {{ durationLabel(slot.duration) }}</span>
          <span class="caption-sm text-muted truncate">Pending decision, {{ slot.optionCount }} {{ slot.optionCount === 1 ? 'option' : 'options' }}</span>
        </li>
      </ul>

      <div class="session-card__foot">
        <AvatarStack :people="people" :size="hero ? 28 : 24" :max="5" />
        <span v-if="where" class="session-card__where caption">
          <AppIcon name="pin" :size="14" />
          <span class="truncate">{{ where }}</span>
        </span>
      </div>
    </div>
  </RouterLink>
</template>

<style scoped>
.session-card { display: flex; flex-direction: column; overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--rounded-md); background: var(--canvas); color: var(--ink); text-decoration: none; transition: box-shadow var(--motion-fast) var(--ease-out), transform var(--motion-fast) var(--ease-out); }
.session-card__body { display: flex; flex-direction: column; gap: var(--spacing-sm); padding: var(--spacing-base); }
.session-card__top { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-sm); }
.session-card__title { margin-top: var(--spacing-xs); }
.session-card__slots { display: flex; flex-direction: column; gap: var(--spacing-xs); }
.session-card__slot { display: grid; grid-template-columns: 24px auto minmax(0, 1fr); align-items: center; gap: var(--spacing-sm); }
.session-card__foot { display: flex; align-items: center; justify-content: space-between; gap: var(--spacing-md); margin-top: var(--spacing-sm); }
.session-card__where { display: inline-flex; align-items: center; gap: var(--spacing-xs); min-width: 0; color: var(--ink); }
@media (hover: hover) { .session-card:hover { box-shadow: var(--shadow-float); transform: translateY(-2px); } }

/* Hero: more room, a larger title (display-lg, 22px / 500), and the photo band on top. */
.session-card--hero .session-card__body { gap: var(--spacing-sm); padding: var(--spacing-lg); }
.session-card--hero .session-card__foot { margin-top: var(--spacing-base); padding-top: var(--spacing-base); border-top: 1px solid var(--hairline-soft); }
.session-card__photos { display: grid; gap: 2px; height: 180px; background: var(--surface-strong); }
.session-card__photos.has-2 { grid-template-columns: 1fr 1fr; }
.session-card__photos.has-3 { grid-template-columns: 2fr 1fr; grid-template-rows: 1fr 1fr; }
.session-card__photos.has-3 img:first-child { grid-row: span 2; }
.session-card__photos img { width: 100%; height: 100%; min-height: 0; object-fit: cover; }
</style>
