# Jio design system

How the look of the app is put together, and how to build a new screen with it. The system follows the Airbnb design analysis (`DESIGN-airbnb.md`): a white canvas, near-black ink, and one accent, Rausch.

## Where things are

- `styles/tokens.css`: every colour, spacing step, radius, type size and the one shadow, as CSS variables.
- `styles/app.css`: the reset, the type classes, the screen layout and a few helper classes.
- `components/ui/`: shared components, for example `AppButton`, `TextField`, `ChipButton`, `BottomSheet`, `ProgressDonut`, `SplitView`, `SideNav`, `CountdownChip`, `MeetupGraph`, `PhotoViewer`, `SortableList`.
- `components/event/`: session components: `SessionCard`, `SuggestionCard`, `StopCard`, `TravelConnector`, `PlaceCard`, `PollBar`.
- `components/map/PlannerMap.vue`: every map (Leaflet on OneMap tiles).
- `assets/fonts/`: Inter, the documented stand-in for Airbnb Cereal VF (which is licensed to Airbnb).
- `views/DesignSystemView.vue`: a page that shows everything. Open `/design-system` in the running app.
- `views/CreateEventView.vue`: step 1 of a session, a short form built only from the pieces above.

## Rules

1. Use a token, never a raw value. Write `color: var(--muted)`, not `color: #6a6a6a`.
2. Rausch (`--primary`, #ff385c) is the single accent, used scarcely: the primary button, the create orb, the active tab icon, the meeting-area pin, "Live now", the Confirmed pill and the meetup graph. Most screens are white and ink with one or two Rausch moments. Anything selected is ink (`--selected`), not Rausch: selected chips and dates, the active tab underline, switches, progress bars, the donut chart, stars. Errors and warnings use `--primary-error-text` with words beside them.
   Data colours carry information, never actions: `--cat-*` for categories (category icons, a selected category chip, card stripes, stop numbers, map pins), `--person-*` for people (each person's avatar, map pin and line to the meeting area, from `lib/people.js`), and `--travel-*` / `--crowd-*` on one good, middling, bad scale (`--scale-*`). Always pair them with words or a key (`CategoryKey`, the travel and crowd keys), because the icon or the label still has to say what it is.
   Motion: buttons and chips give a little when pressed and spring back (`--ease-spring`), cards lift on hover, lists ease in with `.rise`, and new screens rise into place. Everything still works, without movement, under reduced motion.
3. Screens have side padding `--gutter` (24px on mobile, wider on tablet and desktop). Use the `.screen` classes and this is done for you. Desktop content sits in a column no wider than `--content-max-width`; forms use `.screen--form`.
4. Shape: buttons and inputs 8px (`--rounded-sm`), cards and photos 14px (`--rounded-md`), sheets and dialogs 20px (`--rounded-lg`); chips, pills, avatars and icon buttons are fully round. Surfaces are flat: white cards with a 1px `--hairline` border on a white canvas. There is one shadow, `--shadow-float`, for things that float (the tab bar, map overlays, menus, a dragged card, a card on hover). No gradients. Buttons are 48px tall and do not shrink when pressed; the pressed state is a darker colour.
5. Every tap target is at least 44px. The components already do this.
6. Show a `StatusPill` on every session card and at the top of every session screen.
7. Copy is short and professional: labels, values and statuses. No exclamation marks, no emoji, no sentences that explain how the interface works. Full sentences only for errors, empty states and the re-calculation banner.
8. Prefer an icon on its own over an icon plus a word for secondary actions (edit, invite, filter, search, Ask AI). Use `IconButton`: its `label` is read out and shown as a tooltip. Keep words for primary actions and menu items.
9. Anything tappable looks tappable: an unselected chip has a visible outline. Every control has a hover state and a visible focus state, and nothing is revealed by hover alone.
10. One layout for every size. Breakpoints: mobile under 744px, tablet 744 to 1127px (mobile layout, wider margins), desktop 1128px and up (sidebar, list and map side by side, sheets open as dialogs). Switch layouts with CSS, never by re-creating the screen, so resizing keeps its state.

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
