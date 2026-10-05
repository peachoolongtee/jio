# Jio design system

How the look of the app is put together, and how to build a new screen with it.

## Where things are

- `styles/tokens.css`: every colour, spacing step, radius, type size and the one shadow, as CSS variables.
- `styles/app.css`: the reset, the type classes, the screen layout and a few helper classes.
- `components/ui/`: shared components, for example `AppButton`, `TextField`, `ChipButton`, `BottomSheet`, `ProgressDonut`, `SplitView`, `SideNav`.
- `components/event/`: session components: `SessionCard`, `SuggestionCard`, `StopCard`, `TravelConnector`, `PlaceCard`, `PollBar`.
- `components/map/PlannerMap.vue`: every map (Leaflet on OneMap tiles).
- `assets/fonts/`: Inter, the only typeface.
- `views/DesignSystemView.vue`: a page that shows everything. Open `/design-system` in the running app.
- `views/CreateEventView.vue`: step 1 of a session, a short form built only from the pieces above.

## Rules

1. Use a token, never a raw value. Write `color: var(--muted)`, not `color: #6a6a6a`.
2. Lagoon (`--primary`) marks the main action and anything selected or in progress: selected chips, the active tab, switches, progress bars and the donut chart. Use colour with purpose: status pills, category tints (`--cat-*`) and crowd levels (`--crowd-*`) all come from tokens.
3. Screens have side padding `--gutter` (24px on mobile, wider on tablet and desktop). Use the `.screen` classes and this is done for you. Desktop content sits in a column no wider than `--content-max-width`; forms use `.screen--form`.
4. Buttons and inputs have an 8px radius. Cards have 14px. Sheets and dialogs have 20px. Chips and pills are fully round.
5. Every tap target is at least 44px. The components already do this.
6. Show a `StatusPill` on every session card and at the top of every session screen.
7. Copy is short and professional: labels, values and statuses. No exclamation marks, no emoji, no sentences that explain how the interface works. Full sentences only for errors, empty states, the meeting-area result line and the re-calculation banner.
8. Anything tappable looks tappable: an unselected chip has a visible outline. Every control has a hover state and a visible focus state, and nothing is revealed by hover alone.
9. One layout for every size. Breakpoints: mobile under 744px, tablet 744 to 1127px (mobile layout, wider margins), desktop 1128px and up (sidebar, list and map side by side, sheets open as dialogs). Switch layouts with CSS, never by re-creating the screen, so resizing keeps its state.

## A new screen

```vue
<script setup>
import AppButton from '@/components/ui/AppButton.vue'
</script>

<template>
  <main class="screen">
    <header class="screen__header">
      <div class="screen__titles">
        <h1 class="display-xl">Screen title</h1>
      </div>
    </header>
    <div class="screen__body">
      <!-- content, in sections with a 24px gap -->
    </div>
    <footer class="screen__footer">
      <AppButton block>Main action</AppButton>
    </footer>
  </main>
</template>
```

Each component file starts with a comment that shows how to use it.

## Bootstrap

Bootstrap is installed but not loaded. Its styles would override these tokens, so keep it out of `main.js` unless the team decides otherwise.
