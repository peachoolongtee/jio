<script setup>
// A living reference for the Jio design system: every token and shared component on one page.
// Open /design-system while building a screen to see what exists before writing new styles.
import { ref } from 'vue'
import AppButton from '@/components/ui/AppButton.vue'
import AppIcon from '@/components/ui/AppIcon.vue'
import AvatarStack from '@/components/ui/AvatarStack.vue'
import BannerNote from '@/components/ui/BannerNote.vue'
import BottomSheet from '@/components/ui/BottomSheet.vue'
import CategoryIcon from '@/components/ui/CategoryIcon.vue'
import ChipButton from '@/components/ui/ChipButton.vue'
import CountdownChip from '@/components/ui/CountdownChip.vue'
import MeetupGraph from '@/components/ui/MeetupGraph.vue'
import EmptyState from '@/components/ui/EmptyState.vue'
import IconButton from '@/components/ui/IconButton.vue'
import IllustrationBlob from '@/components/ui/IllustrationBlob.vue'
import InfoTag from '@/components/ui/InfoTag.vue'
import ListRow from '@/components/ui/ListRow.vue'
import ModalDialog from '@/components/ui/ModalDialog.vue'
import PriceTier from '@/components/ui/PriceTier.vue'
import ProgressBar from '@/components/ui/ProgressBar.vue'
import ProgressDonut from '@/components/ui/ProgressDonut.vue'
import RangeSlider from '@/components/ui/RangeSlider.vue'
import RatingBadge from '@/components/ui/RatingBadge.vue'
import SegmentTabs from '@/components/ui/SegmentTabs.vue'
import SelectField from '@/components/ui/SelectField.vue'
import SkeletonRow from '@/components/ui/SkeletonRow.vue'
import SortableList from '@/components/ui/SortableList.vue'
import SplitView from '@/components/ui/SplitView.vue'
import StatTile from '@/components/ui/StatTile.vue'
import StatusPill from '@/components/ui/StatusPill.vue'
import TabBar from '@/components/ui/TabBar.vue'
import TextField from '@/components/ui/TextField.vue'
import ToastMessage from '@/components/ui/ToastMessage.vue'
import ToggleSwitch from '@/components/ui/ToggleSwitch.vue'
import UserAvatar from '@/components/ui/UserAvatar.vue'
import PlaceCard from '@/components/event/PlaceCard.vue'
import PollBar from '@/components/event/PollBar.vue'
import StopCard from '@/components/event/StopCard.vue'
import SuggestionCard from '@/components/event/SuggestionCard.vue'
import TravelConnector from '@/components/event/TravelConnector.vue'
import { moveItem } from '@/lib/planner/itinerary.js'

const COLOURS = [
  ['primary', 'Rausch. Main action.'], ['primary-active', 'Rausch pressed.'], ['primary-bright', 'Bright Rausch. Decoration only, no text.'], ['primary-disabled', 'Disabled, pale wash.'], ['primary-error-text', 'Errors, warnings.'], ['scale-middle', 'Amber fills, no text.'], ['scale-middle-text', 'Amber as text.'],
  ['ink', 'Text, selected.'], ['body', 'Running text.'], ['muted', 'Secondary text.'], ['border-strong', 'Chip outlines.'],
  ['hairline', 'Borders.'], ['surface-strong', 'Icon circles, plates.'], ['surface-soft', 'Banners.'], ['canvas', 'Background.'],
]
const CATEGORY_TINTS = ['eat', 'drink', 'shop', 'activity']
const TYPE = [
  ['display-xl', 'Screen title'], ['display-sm', 'Section heading'], ['title-md', 'Card title'], ['body-md', 'Body text'],
  ['body-sm', 'Small body text'], ['caption', 'Label or chip'], ['caption-sm', 'Meta line'], ['badge', 'Status pill'],
]
const STATUSES = ['inviting', 'locating', 'voting', 'confirmed', 'completed', 'cancelled']
const ICONS = ['back', 'close', 'plus', 'check', 'search', 'filter', 'calendar', 'clock', 'pin', 'map', 'locate', 'flag', 'route', 'layers', 'expand', 'people', 'user-plus', 'trophy', 'gift', 'sparkle', 'edit', 'trash', 'more', 'swap', 'rain', 'warning', 'info', 'lock', 'camera', 'home', 'logout', 'eat', 'drink', 'activity', 'shop', 'walk', 'mrt', 'car', 'star', 'grip']
const FRIENDS = ['Darius', 'Jonathan', 'Nicole', 'Faith']
const PLACE = { id: 'p', name: 'Tiong Bahru Bakery', category: 'drink', area: 'Tiong Bahru', distanceKm: 0.4, price: 14, rating: 8.4, tags: ['touristy'] }
const OPTION = {
  id: 'o',
  venue: { name: 'Bishan Public Library', category: 'activity', area: 'Bishan', price: 0 },
  walk: 3,
  reasons: ['Near MRT', 'Budget friendly'],
  warnings: [],
  votes: 3,
  voters: ['Darius', 'Nicole', 'Darryl'],
  swap: null,
}
const RAIN_OPTION = { ...OPTION, id: 'r', venue: { name: 'Bishan-Ang Mo Kio Park', category: 'activity', area: 'Bishan', price: 0 }, walk: 21, reasons: ['Budget friendly'], warnings: ['rain'], votes: 1, voters: ['Faith'], swap: { id: 's', name: 'Toa Payoh Public Library' } }

// Example data for the countdown (starts in about 50 minutes) and the graph.
const in50 = new Date(Date.now() + 50 * 60000)
const soon = { date: in50.toISOString().slice(0, 10), start: in50.toTimeString().slice(0, 5) }
const demoStops = ref([
  { name: 'Bishan Public Library', category: 'activity', duration: 120, price: 0 },
  { name: 'Junction 8', category: 'shop', duration: 90, price: 15 },
  { name: 'Ming Kee Chicken Rice', category: 'eat', duration: 60, price: 6 },
])
const DEMO_TIMES = ['15:00', '17:05', '18:40']
const graphHistory = Array.from({ length: 14 }, (_, i) => ({ date: new Date(Date.now() - (i * 6 + 2) * 86400000).toISOString().slice(0, 10), count: (i % 3) + 1 }))

const name = ref('')
const email = ref('not-an-email')
const area = ref('')
const picked = ref({ Darius: true, Nicole: true })
const stayTime = ref('15:00')
const tab = ref('upcoming')
const mode = ref('walk')
const votes = ref({ a: 2, b: 1 })
const myVote = ref('a')
const rain = ref(true)
const budget = ref(25)
const view = ref('list')
const sheetOpen = ref(false)
const modalOpen = ref(false)
const toast = ref(false)
</script>

<template>
  <main class="screen">
    <header class="screen__header">
      <div class="screen__titles">
        <span class="display-xl text-brand">Jio</span>
        <h1 class="display-sm">Design system</h1>
        <p class="body-sm text-muted">Tokens: styles/tokens.css · Components: components/ui, components/event</p>
      </div>
    </header>

    <div class="screen__body">
      <section class="stack gap-md" aria-labelledby="ds-colours">
        <h2 id="ds-colours" class="display-sm">Colour</h2>
        <ul class="swatches">
          <li v-for="[token, use] in COLOURS" :key="token" class="swatch">
            <span class="swatch__chip" :style="{ background: `var(--${token})` }" />
            <span class="caption">{{ token }}</span>
            <span class="caption-sm text-muted">{{ use }}</span>
          </li>
        </ul>
        <div class="row gap-md wrap">
          <span v-for="c in CATEGORY_TINTS" :key="c" class="row gap-xs"><CategoryIcon :category="c" /> <span class="caption">{{ c }}</span></span>
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-type">
        <h2 id="ds-type" class="display-sm">Type</h2>
        <ul class="stack gap-sm">
          <li v-for="[cls, use] in TYPE" :key="cls" class="row between gap-md">
            <span :class="cls">{{ use }}</span>
            <code class="caption-sm text-muted">.{{ cls }}</code>
          </li>
        </ul>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-buttons">
        <h2 id="ds-buttons" class="display-sm">Buttons</h2>
        <AppButton block @click="toast = true">Primary</AppButton>
        <AppButton block disabled>Primary, disabled</AppButton>
        <AppButton block variant="secondary" @click="modalOpen = true">Secondary: open a dialog</AppButton>
        <div class="row gap-base wrap">
          <AppButton variant="pill" @click="toast = true">Pill</AppButton>
          <AppButton variant="secondary" small @click="toast = true">Small</AppButton>
          <AppButton variant="danger" small @click="toast = true">Danger</AppButton>
          <AppButton variant="tertiary" underline @click="sheetOpen = true">Text link: open a sheet</AppButton>
        </div>
        <div class="row gap-sm">
          <IconButton label="Back" to="/design-system"><AppIcon name="back" /></IconButton>
          <IconButton label="Session options" outline @click="toast = true"><AppIcon name="more" /></IconButton>
          <IconButton label="Delete" outline @click="toast = true"><AppIcon name="trash" /></IconButton>
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-fields">
        <h2 id="ds-fields" class="display-sm">Fields, switches and sliders</h2>
        <TextField v-model="name" label="Name" placeholder="Ian" autocomplete="given-name" />
        <TextField v-model="email" label="Email" type="email" :error="email.includes('@') ? '' : 'Enter an email address, for example name@example.com.'" />
        <SelectField v-model="area" label="Area" placeholder="Choose an area" :options="['Tiong Bahru', 'Bugis', 'Bishan']" />
        <ToggleSwitch v-model="rain" label="Simulate rain" />
        <RangeSlider v-model="budget" label="Budget per person" :min="5" :max="60" :step="5" :format="(v) => (v >= 60 ? 'Any budget' : `Up to SGD ${v}`)" />
        <ProgressBar :value="3" :max="9" label="Sign-up progress" />
      </section>

      <section class="stack gap-md" aria-labelledby="ds-chips">
        <h2 id="ds-chips" class="display-sm">Chips and tags</h2>
        <div class="chip-row" role="group" aria-label="Friends">
          <ChipButton v-for="friend in FRIENDS" :key="friend" check :selected="!!picked[friend]" @click="picked = { ...picked, [friend]: !picked[friend] }">
            <template #leading><UserAvatar :name="friend" :size="32" /></template>
            {{ friend }}
          </ChipButton>
        </div>
        <div class="chip-row" role="radiogroup" aria-label="Stay until">
          <ChipButton v-for="t in ['15:00', '18:00', '21:00']" :key="t" radio :selected="stayTime === t" @click="stayTime = t">{{ t }}</ChipButton>
        </div>
        <div class="row gap-xs wrap">
          <InfoTag>Near MRT</InfoTag>
          <InfoTag tone="strong" icon="trophy">Leading</InfoTag>
          <InfoTag tone="warning" icon="rain">Outdoor · rain expected</InfoTag>
          <InfoTag tone="error">Opted out</InfoTag>
          <PriceTier :price="8" />
          <PriceTier :price="18" />
          <PriceTier :price="32" />
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-status">
        <h2 id="ds-status" class="display-sm">Status pills</h2>
        <div class="row gap-sm wrap">
          <StatusPill v-for="status in STATUSES" :key="status" :status="status" />
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-progress">
        <h2 id="ds-progress" class="display-sm">Progress, stats and banners</h2>
        <ProgressDonut title="Locations" :people="[{ name: 'Ian', done: true }, { name: 'Darius', done: true }, { name: 'Jonathan', done: false }, { name: 'Nicole', done: true }]" done-label="Submitted" />
        <div class="two">
          <StatTile label="Successful meetups" :value="3" icon="trophy" />
          <StatTile label="Points" :value="300" icon="gift" />
        </div>
        <BannerNote dismissible @dismiss="toast = true">Meeting area moved from Bishan to Serangoon because Jonathan opted out.</BannerNote>
        <BannerNote tone="error" icon="people">Not enough people. Invite someone or cancel.</BannerNote>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-time">
        <h2 id="ds-time" class="display-sm">Countdown and meetup graph</h2>
        <div class="row gap-sm wrap">
          <CountdownChip :session="{ date: soon.date, start: soon.start, end: '23:59', status: 'confirmed' }" />
          <CountdownChip :session="{ date: '2099-01-01', start: '15:00', end: '21:00', status: 'confirmed' }" />
        </div>
        <div class="card"><MeetupGraph :history="graphHistory" :planned="[soon.date]" :weeks="16" /></div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-people">
        <h2 id="ds-people" class="display-sm">Avatars and rating</h2>
        <div class="row gap-base wrap">
          <UserAvatar name="Ian" :size="96" />
          <UserAvatar name="Darius" :size="64" />
          <UserAvatar name="Nicole" />
          <AvatarStack :people="['Ian', 'Darius', 'Jonathan', 'Nicole', 'Faith', 'Darryl']" :max="4" />
          <RatingBadge :score="8.6" />
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-tabs">
        <h2 id="ds-tabs" class="display-sm">Tabs and list rows</h2>
        <SegmentTabs v-model="tab" label="Example lists" :tabs="[{ id: 'upcoming', label: 'Upcoming' }, { id: 'past', label: 'Past' }]" />
        <ul v-if="tab === 'upcoming'">
          <ListRow as="li" title="Nylon Coffee Roasters" meta="Drink · Everton Park">
            <template #trailing><RatingBadge :score="8.6" /></template>
          </ListRow>
          <ListRow as="li" title="Darius" meta="@darius · Bugis" to="/design-system">
            <template #leading><UserAvatar name="Darius" /></template>
            <template #trailing><InfoTag tone="strong">Location submitted</InfoTag></template>
          </ListRow>
        </ul>
        <div v-else>
          <SkeletonRow v-for="n in 2" :key="n" avatar />
          <EmptyState title="No past sessions" text="Completed and cancelled sessions show up here." />
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-cards">
        <h2 id="ds-cards" class="display-sm">Places, suggestions and the itinerary</h2>
        <PlaceCard :place="PLACE" />
        <div role="radiogroup" aria-label="Example slot" class="stack gap-md">
          <SuggestionCard :option="OPTION" :total="4" leading mine />
          <SuggestionCard :option="RAIN_OPTION" :total="4" />
        </div>
        <div class="stack">
          <StopCard :number="1" time="15:00" :duration="120" name="Bishan Public Library" category="activity" :price="0" area="Bishan" />
          <TravelConnector :options="{ walk: 4, mrt: 9, car: 6 }" :mode="mode" @change="mode = $event" />
          <StopCard :number="2" :time="mode === 'walk' ? '17:04' : mode === 'mrt' ? '17:09' : '17:06'" :duration="90" name="Junction 8" category="shop" :price="15" area="Bishan" />
        </div>
        <div class="card">
          <SortableList :items="demoStops" :item-key="(s) => s.name" :item-label="(s) => s.name" label="Example stops" @move="(from, to) => (demoStops = moveItem(demoStops, from, to))">
            <template #item="{ item, index, lifted, handle }">
              <StopCard :number="index + 1" :time="DEMO_TIMES[index]" :duration="item.duration" :name="item.name" :category="item.category" :price="item.price" area="Bishan" :lifted="lifted" :warning="item.category === 'eat' && index === 0 ? 'Closed at this time' : ''">
                <template #handle><button v-bind="handle" class="drag-handle"><AppIcon name="grip" /></button></template>
              </StopCard>
            </template>
          </SortableList>
        </div>
        <div class="card" role="radiogroup" aria-label="Poll">
          <PollBar name="Ming Kee Chicken Rice" :votes="votes.a" :total="votes.a + votes.b" :leading="votes.a > votes.b" :mine="myVote === 'a'" @vote="myVote = 'a'" />
          <PollBar name="Kopitiam Junction 8" :votes="votes.b" :total="votes.a + votes.b" :leading="votes.b > votes.a" :mine="myVote === 'b'" @vote="myVote = 'b'" />
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-layout">
        <h2 id="ds-layout" class="display-sm">Layout</h2>
        <p class="caption text-muted">SplitView: one at a time on mobile, side by side on desktop</p>
        <SplitView v-model:view="view" label="Example">
          <template #list><div class="placeholder">List</div></template>
          <template #map><div class="placeholder placeholder--map">Map</div></template>
        </SplitView>
        <p class="caption text-muted">TabBar: the floating navigation at every size</p>
        <div class="frames">
          <div class="frame frame--tabs"><TabBar /></div>
        </div>
      </section>

      <section class="stack gap-md" aria-labelledby="ds-art">
        <h2 id="ds-art" class="display-sm">Illustrations and icons</h2>
        <div class="row gap-sm scroll-x">
          <IllustrationBlob name="invite" />
          <IllustrationBlob name="profile" />
          <IllustrationBlob name="sent" />
          <IllustrationBlob name="done" />
        </div>
        <ul class="icons">
          <li v-for="icon in ICONS" :key="icon" class="icons__item">
            <AppIcon :name="icon" :size="20" />
            <span class="caption-sm text-muted">{{ icon }}</span>
          </li>
        </ul>
      </section>
    </div>

    <BottomSheet v-model:open="sheetOpen" title="A sheet">
      <p class="body-md text-muted">A dialog on desktop.</p>
      <AppButton block @click="sheetOpen = false">Done</AppButton>
    </BottomSheet>

    <ModalDialog v-model:open="modalOpen" title="Confirm plan?">
      <AppButton block @click="modalOpen = false; toast = true">Confirm plan</AppButton>
      <AppButton block variant="secondary" @click="modalOpen = false">Not yet</AppButton>
    </ModalDialog>

    <ToastMessage v-model:show="toast" text="Done" />
  </main>
</template>

<style scoped>
.swatches { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--spacing-base) var(--spacing-md); }
@media (min-width: 744px) { .swatches { grid-template-columns: repeat(6, minmax(0, 1fr)); } }
.swatch { display: flex; flex-direction: column; gap: var(--spacing-xxs); }
.swatch__chip { height: 48px; margin-bottom: var(--spacing-xs); border: 1px solid var(--hairline); border-radius: var(--rounded-sm); }
.icons { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: var(--spacing-base) var(--spacing-sm); }
@media (min-width: 744px) { .icons { grid-template-columns: repeat(8, minmax(0, 1fr)); } }
.icons__item { display: flex; flex-direction: column; align-items: center; gap: var(--spacing-xs); }
.two { display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: var(--spacing-md); }
.placeholder { display: flex; align-items: center; justify-content: center; min-height: 120px; border-radius: var(--rounded-md); background: var(--surface-soft); color: var(--muted); }
.placeholder--map { height: 100%; background: var(--surface-strong); }
.frames { display: flex; flex-wrap: wrap; gap: var(--spacing-base); }
.frame { overflow: hidden; border: 1px solid var(--hairline); border-radius: var(--rounded-md); }
.frame--side :deep(.side) { position: static; display: flex; height: 100%; }
.frame--tabs { flex: 1 1 320px; align-self: flex-start; }
.frame--tabs { padding: var(--spacing-base); background: var(--surface-soft); }
.frame--tabs :deep(.tabbar) { position: static; margin: 0 auto; transform: none; animation: none; }
</style>
