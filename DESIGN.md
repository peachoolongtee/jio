---
name: Jio
description: A Singapore group-meetup planner. White canvas, near-black ink, one bright red, and a dotted map of the island.
colors:
  primary: "#ff385c"
  primary-bright: "#ff385c"
  brand-logo: "#f93d64"
  primary-active: "#e00b41"
  primary-disabled: "#ffd1da"
  primary-error-text: "#c13515"
  primary-error-text-hover: "#b32505"
  ink: "#222222"
  body: "#3f3f3f"
  muted: "#6a6a6a"
  muted-soft: "#929292"
  canvas: "#ffffff"
  surface-soft: "#f7f7f7"
  surface-strong: "#f2f2f2"
  hairline: "#dddddd"
  hairline-soft: "#ebebeb"
  border-strong: "#c1c1c1"
  border-control: "#8a8a8a"
  on-primary: "#ffffff"
  on-dark: "#ffffff"
  scrim: "#000000"
  medal-gold-fg: "#c08a00"
  medal-gold-bg: "#f2c14e"
  medal-gold-on: "#5c4100"
  medal-silver-fg: "#7a8699"
  medal-silver-bg: "#c9d1dc"
  medal-silver-on: "#3b4452"
  medal-bronze-fg: "#b0602b"
  medal-bronze-bg: "#dda274"
  medal-bronze-on: "#5a2e10"
  scale-good: "#15803d"
  scale-middle: "#b7791f"
  scale-middle-text: "#97641a"
  scale-bad: "#dc2626"
  cat-eat-fg: "#ea580c"
  cat-drink-fg: "#0284c7"
  cat-shop-fg: "#9333ea"
  cat-activity-fg: "#059669"
  person-1: "#2563eb"
  person-2: "#7c3aed"
  person-3: "#0d9488"
  person-4: "#c026d3"
  person-5: "#ea580c"
  person-6: "#4d7c0f"
  person-7: "#0891b2"
  person-8: "#a16207"
  rain-wash: "#4f7aa6"
  rain-streak: "#6f9bc8"
  rain-text: "#2a4866"
typography:
  display-xl:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "28px"
    fontWeight: 700
    lineHeight: 1.4
  display-lg:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "22px"
    fontWeight: 500
    lineHeight: 1.18
    letterSpacing: "-0.44px"
  display-md:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "21px"
    fontWeight: 700
    lineHeight: 1.4
  display-sm:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "20px"
    fontWeight: 600
    lineHeight: 1.2
    letterSpacing: "-0.18px"
  title-md:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
  title-sm:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.25
  body-md:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "16px"
    fontWeight: 400
    lineHeight: 1.5
  body-sm:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "14px"
    fontWeight: 400
    lineHeight: 1.43
  caption:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.29
  caption-sm:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.23
  micro-label:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "12px"
    fontWeight: 700
    lineHeight: 1.33
  badge:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "11px"
    fontWeight: 600
    lineHeight: 1.18
  button-md:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "16px"
    fontWeight: 500
    lineHeight: 1.25
  button-sm:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "14px"
    fontWeight: 500
    lineHeight: 1.29
  nav-link:
    fontFamily: "\"Airbnb Cereal VF\", Circular, Inter, -apple-system, system-ui, Roboto, \"Helvetica Neue\", sans-serif"
    fontSize: "16px"
    fontWeight: 600
    lineHeight: 1.25
rounded:
  xs: "4px"
  sm: "8px"
  md: "14px"
  lg: "20px"
  full: "9999px"
spacing:
  xxs: "2px"
  xs: "4px"
  sm: "8px"
  md: "12px"
  base: "16px"
  lg: "24px"
  xl: "32px"
  xxl: "48px"
components:
  button-primary:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: "0 24px"
    height: "48px"
  button-primary-active:
    backgroundColor: "{colors.primary-active}"
    textColor: "{colors.on-primary}"
  button-primary-disabled:
    backgroundColor: "{colors.primary-disabled}"
    textColor: "{colors.on-primary}"
  button-next:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.full}"
    padding: "0 24px"
    height: "48px"
  button-secondary:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: "0 23px"
    height: "48px"
  button-tertiary:
    textColor: "{colors.ink}"
    typography: "{typography.button-sm}"
    padding: "0"
  button-pill:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-sm}"
    rounded: "{rounded.full}"
    padding: "0 20px"
    height: "44px"
  button-danger:
    backgroundColor: "{colors.primary-error-text}"
    textColor: "{colors.on-primary}"
    typography: "{typography.button-md}"
    rounded: "{rounded.sm}"
    padding: "0 24px"
    height: "48px"
  icon-button:
    backgroundColor: "{colors.surface-strong}"
    textColor: "{colors.ink}"
    rounded: "{rounded.full}"
    size: "44px"
  chip:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.caption}"
    rounded: "{rounded.full}"
    padding: "0 12px"
    height: "32px"
  chip-selected:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-dark}"
  status-pill-confirmed:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    typography: "{typography.badge}"
    rounded: "{rounded.full}"
    padding: "4px 10px"
  status-pill-completed:
    backgroundColor: "{colors.ink}"
    textColor: "{colors.on-dark}"
  text-field:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    typography: "{typography.body-md}"
    rounded: "{rounded.sm}"
    padding: "14px 12px"
    height: "56px"
  card:
    backgroundColor: "{colors.canvas}"
    textColor: "{colors.ink}"
    rounded: "{rounded.md}"
    padding: "24px"
  tab-current:
    backgroundColor: "#ffe9ed"
    textColor: "{colors.primary}"
    rounded: "{rounded.full}"
    height: "44px"
  tab-create:
    backgroundColor: "{colors.primary}"
    textColor: "{colors.on-primary}"
    rounded: "{rounded.full}"
    height: "44px"
---

# Design System: Jio

This file records the design language as it ships at commit `65567bb`, the head of the pull request "Feat/leaderboard jiocoins" (number 87), which is merged into `main`. Every value below was read from the code under `frontend/src/`. Where a sentence states intent that the code does not prove, it is marked "inferred". Where the code departs from the project's own written rules, the departure is listed under Known Conflicts and is not resolved here.

A token is a named value kept in one place so that every screen uses the same one. Jio's tokens are CSS custom properties (variables written `--name`) in `frontend/src/styles/tokens.css`. The frontmatter above lists them without the leading `--`.

## Overview

**Creative North Star: "The Meeting Point"** (inferred from the code; the lead has not confirmed a name).

Jio is a white page with near-black text and one bright red, called Rausch in the code (`--primary`). The red marks the place where people meet and the action that gets them there: the map pin on Home, the "Create" circle in the navigation, the main button on a screen, the filled steps of a session. Home opens on a muted dotted map of Singapore (`SingaporeMap`) with routes drawing in from around the island to one point, and a red pin (`PinButton`) standing on that point with the Jio logo in its head.

Around that centre the product is plain. Cards are white with a 1px grey line and no shadow until they are hovered. Type is Inter at modest weights (400 to 700). Controls are round: pills, circles and 8px corners. Navigation is a white pill floating at the bottom of a phone and a full-width bar along the top from 744px. Three screens (Leaderboard, Rewards, Profile) sit on a fine grid whose cells shade softly in grey where the pointer passes (`GridPulse`). The app's currency is drawn as a pink coin with a crown (`CoinBadge`), and the same crown replaces the dot of the "i" in the logo (`JioLogo`).

Photos come in two kinds. Place photos are one stock picture per kind of place, captioned "Illustrative photo" on the place's detail view. Session photos hang as instant prints on a string (`PolaroidLine`) and open in a dark full-screen viewer (`PhotoViewer`). The copy is short labels and statuses, with no exclamation marks, no emoji and no upper-case labels; estimated times always say "about".

**Key Characteristics:**
- One red (`--primary`, `#ff385c`) on a white canvas with `#222222` ink.
- A dotted map of Singapore and a red map pin as the Home screen's signature.
- Pill navigation on phones, a top bar from 744px.
- Flat white cards with a hairline; a shadow only for things that float or are hovered.
- Information colours for categories, people and travel time, always with a word, icon or key.
- Motion on almost everything, all of it switched off or shortened under reduced motion.
- Sample content and estimates are said to be so in words.

## Colors

The palette is white, greys and one red, plus four sets of information colours that never mark an action.

Source for every row: `frontend/src/styles/tokens.css`. "Uses" counts references outside `tokens.css`.

### Primary

| Token | Value | What it is for |
|---|---|---|
| `--primary` | `#ff385c` | The brand red. Main buttons, the Create circle, the meeting-area pin, "Live now", the Confirmed pill, filled session steps, the progress donut, the selected calendar day. |
| `--primary-bright` | `#ff385c` | The same value under a second name, for glows, washes and rings (`SingaporeMap`, `.enter-game`, the Home meetup pulse). |
| `--brand-logo` | `#f93d64` | The logo pink. `JioLogo`, `frontend/public/favicon.svg`, the `theme-color` meta tag, and the Home greeting's gradient. |
| `--primary-active` | `#e00b41` | Red when pressed or hovered. |
| `--primary-disabled` | `#ffd1da` | Disabled red buttons. |
| `--primary-error-text` | `#c13515` | Error text, the Cancelled pill, warnings, the danger button's fill. |
| `--primary-error-text-hover` | `#b32505` | The danger button hovered or pressed. Used only in `AppButton`. |

Tints of the red are made in place with `color-mix`, not tokens: 11% on white for the current tab (`TabBar`), 14% for the donut's track (`ProgressDonut`), 16% for the hold fill and 35% for its border (`HoldButton`), 18% for the start marker's ring (`GroupDetailView`).

### Secondary: information colours

These carry information on maps, keys, stripes and avatars. None of them is used for an action.

| Token | Value | What it is for |
|---|---|---|
| `--cat-eat-fg` | `#ea580c` | Eat: stop number, map pin, card stripe, category icon. |
| `--cat-drink-fg` | `#0284c7` | Drink. |
| `--cat-shop-fg` | `#9333ea` | Shop. |
| `--cat-activity-fg` | `#059669` | Activity. |
| `--cat-eat-bg`, `--cat-drink-bg`, `--cat-shop-bg`, `--cat-activity-bg` | `color-mix(in srgb, <fg> 12%, var(--canvas))` | The pale circle behind a category icon (`CategoryIcon`). `--cat-drink-bg` is also used once in `RewardsView`. |
| `--person-1` to `--person-8` | `#2563eb`, `#7c3aed`, `#0d9488`, `#c026d3`, `#ea580c`, `#4d7c0f`, `#0891b2`, `#a16207` | One colour per person, the same on their avatar, map pin and profile banner. Chosen by `personIndex(id)` in `frontend/src/lib/people.js`. |
| `--rain-wash` | `#4f7aa6` | The tint over a rainy area on a map, drawn at 10 to 40% opacity and feathered to nothing at its edge. See "Weather". |
| `--rain-streak` | `#6f9bc8` | The drops of the rain, at 0.38, 0.6 and 0.85 opacity for the far, middle and near layer. Decoration: no text sits on it, so no contrast ratio applies. |
| `--rain-text` | `#2a4866` | Text and icon of the rain chip, on white: 9.5:1. |
| `--scale-good` | `#15803d` | The good end of the travel scale. Reached only through `--travel-short`. |
| `--scale-middle` | `#b7791f` | Amber as a fill. Reached through `--travel-medium` and read by `lib/confetti.js`. |
| `--scale-middle-text` | `#97641a` | Amber as text. Reached only through `--travel-medium-text`. |
| `--scale-bad` | `#dc2626` | The bad end. Reached only through `--travel-long`. |
| `--travel-short` | `var(--scale-good)` | Travel time up to 30 min. |
| `--travel-medium` | `var(--scale-middle)` | 31 to 45 min, as a fill. One use, in `GroupDetailView`. |
| `--travel-medium-text` | `var(--scale-middle-text)` | 31 to 45 min, as text (`MemberList`, `PlannerMap`). |
| `--travel-long` | `var(--scale-bad)` | Over 45 min. |

### Tertiary: leaderboard medals

| Token | Value | What it is for |
|---|---|---|
| `--medal-gold-fg`, `--medal-silver-fg`, `--medal-bronze-fg` | `#c08a00`, `#7a8699`, `#b0602b` | Crown icons and avatar rings for 1st, 2nd, 3rd (`LeaderboardPodium`, `LeaderboardRankings`). |
| `--medal-gold-bg`, `--medal-silver-bg`, `--medal-bronze-bg` | `#f2c14e`, `#c9d1dc`, `#dda274` | The podium blocks. Used only in `LeaderboardPodium`. |
| `--medal-gold-on`, `--medal-silver-on`, `--medal-bronze-on` | `#5c4100`, `#3b4452`, `#5a2e10` | The rank number on a block. Used only in `LeaderboardPodium`. |

### Neutral

| Token | Value | What it is for |
|---|---|---|
| `--ink` | `#222222` | Headings, body text, the focus outline, and the fill of selected chips, switches and sliders. |
| `--body` | `#3f3f3f` | Longer running text; a selected chip when hovered. |
| `--muted` | `#6a6a6a` | Secondary text, field labels, inactive tabs. |
| `--muted-soft` | `#929292` | Disabled text; session steps not yet reached. |
| `--canvas` | `#ffffff` | The page, cards, sheets, dialogs. |
| `--surface-soft` | `#f7f7f7` | Banners, hover backgrounds, the Home map band. |
| `--surface-strong` | `#f2f2f2` | Icon-button circles, photo plates, neutral tags, empty progress blocks. |
| `--hairline` | `#dddddd` | The default 1px border of cards and dividers. Too light (1.36:1) to outline a control. |
| `--hairline-soft` | `#ebebeb` | Lighter dividers; the progress bar's track. |
| `--border-strong` | `#c1c1c1` | Decorative outlines: dashed empties, the next button, the sheet handle, disabled outlines. |
| `--border-control` | `#8a8a8a` | The edge that marks a control: text fields, selects, unselected chips, the switch. 3.45:1 on white, for WCAG's 3:1 (issue #62). |
| `--on-primary` | `#ffffff` | Text and icons on the red. |
| `--on-dark` | `#ffffff` | Text on ink and on the photo viewer. |
| `--scrim` | `#000000` | The backdrop behind sheets and dialogs, drawn at 50% opacity. |
| `--selected` | `var(--ink)` | The selected fill. |
| `--on-selected` | `var(--on-dark)` | Text on the selected fill. |

### Defined but unused

These are declared in `tokens.css` and referenced nowhere else in `frontend/src/`: `--luxe` (`#460479`), `--plus` (`#92174d`), `--legal-link` (`#428bff`), `--surface-card` (`#ffffff`). `--star-rating` (`#222222`) has one use, in `RatingBadge`.

### Colours hard-coded outside the tokens

| File | Values | Note |
|---|---|---|
| `components/ui/CoinBadge.vue` | `#f7365e`, `#ff9db1`, `#fff`, `#fff4e6` | The coin's own artwork. `#f7365e` is neither `--primary` nor `--brand-logo`. |
| `components/ui/PolaroidLine.vue` | `#f1ede6`, `#8a7f72`, `#fbfaf7`, `#d9d5cc`, `#3b3833`, `#e3c9a1`, `#c9a67a`, `#b8915f` | A local paper, string and peg palette, declared as `--pl-*` on the component. |
| `views/LandingView.vue` | `#ff8a5c` | The middle stop of the greeting's gradient. `#000` appears only in masks. |
| `styles/app.css` | `#fff` | The `.enter-game__ring` border, where `--canvas` holds the same value. |
| `frontend/index.html`, `frontend/public/favicon.svg` | `#f93d64` | Equal to `--brand-logo`; these files cannot read CSS variables. |

### Named Rules

**The Information Colour Rule.** Category, person, travel and medal colours say what something is and never mark an action. Each appears with a word, an icon or a key: `CategoryKey` on maps, the category's name on `CategoryIcon`, "about 25 min" beside a coloured travel time, the rank number beside a medal.

**The Two Selections Rule.** As shipped, a choice the user toggles is filled with ink (`ChipButton`, `ToggleSwitch`, `SegmentTabs`, `RangeSlider`, `TravelConnector`, `ProgressBar`), and progress or position is filled with red (`SessionSteps`, `SegmentedProgress`, `ProgressDonut`, the current tab in `TabBar`). `CalendarPicker` is the exception: its selected day is red. See Known Conflicts.

## Typography

**Body and heading font:** Inter, bundled as a variable font (`frontend/src/assets/fonts/InterVariable.woff2`, weights 100 to 900, `font-display: swap`). The stack in `--font-sans` names "Airbnb Cereal VF" and Circular first; neither is bundled, so Inter is what loads unless a device has them installed.

**Second font:** `--font-display` is `ui-serif, "New York", "Iowan Old Style", Georgia, "Times New Roman", serif`, the device's own serif. It has two uses, both in `PolaroidLine` (the title under the string). It is not used for any heading elsewhere.

**Character:** One sans family carries everything. Hierarchy comes from size and a step in weight, not from a second face.

### Hierarchy

Each role is a `font` shorthand token and a class of the same name in `frontend/src/styles/app.css` (for example `class="display-xl"` or `font: var(--text-display-xl)`). "Class uses" counts the class in templates.

| Token | Value (weight size/line-height) | Class uses | What it is for |
|---|---|---|---|
| `--text-display-xl` | 700 28px/1.4 | 15 | Screen titles (`<h1>`). |
| `--text-display-lg` | 500 22px/1.18, letter-spacing -0.44px on the class | 2 | Card hero titles, the meeting area's name. |
| `--text-display-md` | 700 21px/1.4 | 1 | Big values (`StatTile`). |
| `--text-display-sm` | 600 20px/1.2, letter-spacing -0.18px on the class | 27 | Section headings, sheet and dialog titles. |
| `--text-title-md` | 600 16px/1.25 | 24 | Card titles, names. |
| `--text-title-sm` | 500 16px/1.25 | 25 | Lighter titles. |
| `--text-body-md` | 400 16px/1.5 | 13 | Body text; the `body` default. |
| `--text-body-sm` | 400 14px/1.43 | 47 | Meta lines, dates, distances, hints and errors. |
| `--text-caption` | 500 14px/1.29 | 38 | Labels, chips. |
| `--text-caption-sm` | 400 13px/1.23 | 57 | Small meta text, tags, the sample note. |
| `--text-link` | 400 14px/1.43 | 0 | Declared; the `.link` class is not used. |
| `--text-micro-label` | 700 12px/1.33 | 0 | Map pins (`PlannerMap`, by variable). The `.micro-label` class is not used. |
| `--text-badge` | 600 11px/1.18 | 1 | `StatusPill`, `CountdownChip` (at 12px), Leaderboard pills (at 13px). |
| `--text-button-md` | 500 16px/1.25 | 0 | Buttons (by variable; primary buttons override the weight to 600). |
| `--text-button-sm` | 500 14px/1.29 | 0 | Small buttons, tertiary buttons, `SegmentTabs`. |
| `--text-nav-link` | 600 16px/1.25 | 0 | Top-bar tab names, set to 15px in `TabBar`. |

Helper classes in `app.css`: `.text-muted` (84 uses), `.text-error` (19), `.truncate` (30), `.clamp-2` (7), `.tnum` for tabular figures (29). `.text-body` and `.text-brand` are defined and not used.

### Sizes written outside the scale

| File | Value | Where |
|---|---|---|
| `views/LandingView.vue` | `800 clamp(44px, 9vw, 80px)/0.95`, letter-spacing -0.045em | The Home greeting, "Hi, {name}". The only weight 800 heading on a screen. |
| `components/ui/PinButton.vue` | `800 30px/1`, `600 13px/1.1` | The two lines in the pin's head. |
| `components/ui/RadialTimePicker.vue` | `700 26px/1.2`, `700 12px/1` | The time and its orbiting buttons. |
| `components/ui/TabBar.vue` | `600 12px/1.9` | The current tab's name on phones. |
| `views/RewardsView.vue` | `700 22px/1` | The balance. |
| `components/ui/PolaroidLine.vue` | `500 clamp(18px, 2.2vw, 24px)/1.15` in `--font-display`; `500 12px/1` with 0.14em letter-spacing | The print's title and the counter. |

### Named Rules

**The Tabular Figures Rule.** Times, counts and amounts take `.tnum` so digits line up (`CoinBadge`, `CountdownChip`, `SegmentedProgress`, the Leaderboard countdown).

## Layout

### Spacing

A 4px base with one 2px step. Source: `tokens.css`.

| Token | Value | What it is for |
|---|---|---|
| `--spacing-xxs` | 2px | Tag padding, tight stacks. |
| `--spacing-xs` | 4px | Icon-to-text gaps, pill padding. |
| `--spacing-sm` | 8px | Gaps in rows, the smallest card padding. |
| `--spacing-md` | 12px | Gaps inside cards and sections. |
| `--spacing-base` | 16px | Card padding, grid gaps. |
| `--spacing-lg` | 24px | The phone gutter, the gap between sections of a screen, `.card` padding. |
| `--spacing-xl` | 32px | The desktop gutter, dialog margins. |
| `--spacing-xxl` | 48px | The tablet gutter; two other uses (`LandingView`, `NotFoundView`). |
| `--spacing-section` | 64px | Defined, not used. |

Values written as plain pixels where no token matches include 6px, 10px, 14px, 20px and 23px (for example `padding: 0 23px` on the secondary button, `padding: 0 20px` on the pill button, `gap: 6px` in `CountdownChip`).

### The page shell

`frontend/src/App.vue` renders `.app > .app__main` and, on top-level screens, `TabBar`. A screen is top-level when its route has `meta.tabs: true` and the user is signed in: Home (`/`), Sessions (`/sessions`), Leaderboard, Rewards and Profile (`frontend/src/router/index.js`). Every other screen has its own back arrow and no tab bar.

`.app__main` is a column at least `100dvh` tall with `overflow-x: clip`, so a full-width band never scrolls sideways. `html` has `scrollbar-gutter: stable`. On top-level screens `.app__main` is padded by `--topbar-real-height` at the top and by `--tabbar-real-height` at the bottom (the bar plus the safe-area inset it grows by; see Safe areas). The page runs edge to edge under a phone's notch and home indicator (`viewport-fit=cover` in `frontend/index.html`); see Safe areas.

A screen is built from classes in `app.css`:

| Class | What it does |
|---|---|
| `.screen` | A centred column, at most `--content-max-width` plus two gutters wide. |
| `.screen--form` | Narrows it to `--form-max-width`. Used by `AuthView`. |
| `.screen--wide-form` | Narrows it to `--wide-form-max-width`. Used by `CreateEventView`. |
| `.screen__header` | Padding `12px gutter 16px`; 32px top padding from 1128px. Holds `.screen__bar` and `.screen__titles`. |
| `.screen__body` | Sections 24px apart, gutter padding at the sides. |
| `.screen__footer` | A sticky bar at the bottom (`z-index: 5`). A full-width button on phones; from 744px a row aligned right, where a block button becomes `width: auto; min-width: 200px`. |
| `.section`, `.section__head` | A heading row with an optional action on the right, at least 44px tall. |
| `.grid-3` | One column, two from 744px, three from 1128px, 16px gap. |
| `.card` | White, 1px `--hairline`, `--rounded-md`, 24px padding, 12px gap, no shadow. |
| `.grid-page`, `.page-grid` | Puts `GridPulse` fixed behind the whole window and lifts the screen's other children above it. |
| `.scroll-x`, `.chip-row` | A row that scrolls sideways to the screen edge; a wrapping row of chips. |
| `.photo` | A square grey plate that stands in for a picture. |
| `.stack`, `.row`, `.wrap`, `.gap-xs` to `.gap-lg`, `.between`, `.grow` | Flex helpers. |
| `.sr-only` | Text for screen readers only. |
| `.mobile-only`, `.desktop-only`, `.note` | Defined, not used in any template. |

### Frame tokens

| Token | Value | What it is for |
|---|---|---|
| `--gutter` | 24px; 48px from 744px; 32px from 1128px | Side padding of every screen. |
| `--content-max-width` | 1200px | The widest a screen's content gets. |
| `--form-max-width` | 480px | Single-column forms. |
| `--wide-form-max-width` | 880px | Create session. |
| `--dialog-max-width` | 480px | `ModalDialog`, and `BottomSheet` on desktop. |
| `--sheet-max-width` | 600px | `BottomSheet` from 744px. |
| `--side-panel-width` | 420px | `BottomSheet` with `side` on desktop. |
| `--tabbar-height` | 88px; 0px from 744px | Room kept for the phone pill. |
| `--topbar-height` | 0px; 72px from 744px | Room kept for the top bar. |
| `--topbar-real-height` | `--topbar-height` + `env(safe-area-inset-top)` | The top bar's real height. Use it, not the line above, wherever something clears, clamps to or sticks under the top bar. Registered with `@property` as a length, so a script reads it in px (`frontend/src/lib/bars.js`). |
| `--tabbar-real-height` | `--tabbar-height` + `env(safe-area-inset-bottom)` | The same for the phone pill: its height, its gap and the home indicator's inset. |
| `--tap-min` | 44px | The smallest tap target. |

### Navigation and the width at which it switches

`frontend/src/components/ui/TabBar.vue` is one component with two layouts, switched by CSS at 744px.

- **Under 744px:** a white pill fixed at the bottom centre, 56px tall, 12px plus the bottom safe area above the edge, `z-index: 20`. Tabs are icons only, each 44px. The current tab is tinted red and its name slides out beside the icon. Create is a solid red circle. Under 400px the current tab shows no name; under 380px tabs may shrink to 40px wide.
- **From 744px:** a full-width bar fixed at the top, `--topbar-height` (72px) tall, with a bottom hairline and no shadow. The logo is at the left, every tab shows its name, and Create is a red pill at the right reading "Create session" (just "Create" between 744px and 1127px).

### Breakpoints

Media queries cannot read variables, so these numbers are written out.

| Width | What changes |
|---|---|
| 744px | The gutter widens, navigation moves to the top, the footer's button stops being full-width, sheets stop being full-width, `.grid-3` becomes two columns. Used in 19 rules. |
| 1128px | `.grid-3` becomes three columns, `SplitView` shows list and map side by side, `BottomSheet` becomes a centred dialog or a side panel. Used in 13 rules. |

One-off widths used by a single component: 379px, 399px and 399.98px (`TabBar`, `LeaderboardRankings`), 419.98px (`PolaroidLine`), 480px (`StopCard`), 560px (`PopoverPanel`, in script), 599px (`LeaderboardCard`), 768px (`PlaceDetail`, where the rest of the system uses 744px).

### How screens stack on phones

Everything is one column. A list and its map are shown one at a time with a List / Map switch (`SplitView`). Under 1128px the map is `max(240px, min(72dvh, 100dvh - 160px))` tall, so on a phone on its side (about 375px high) it is 240px: the formula's `100dvh - 160px` is only 215px there, and the 240px floor wins. Measured at 812x375 and 667x375, the map scrolled into view ends 24px above the top of the 64px footer (85px with a 21px bottom inset), but the page's header and the List / Map switch sit above the map, so the map and the button are not both in view before the page is scrolled. Overlays rise from the bottom as sheets and can be dragged down by the handle or header to close: let go past 96px, or flick, and the sheet closes; otherwise it springs back. A sheet that was dragged closed opens again at rest. The handle's grab area is 44px tall: for a sheet with no header it grows upward over the backdrop, so nothing inside the sheet moves. On a screen in landscape under 500px tall, the sticky footer's padding drops to 8px above and below, so it is 64px tall instead of 88px. The main action is a full-width button in the sticky footer. The photo and controls of a `StopCard` drop under its text at 480px and below. Layout changes are done in CSS, so resizing the window keeps a screen's state.

### Safe areas

`frontend/index.html` sets `viewport-fit=cover`, so the page draws under the notch and home indicator, and the insets are not zero on those phones. Where they are read (issue #63):

- **Sides:** `.app` is padded by `env(safe-area-inset-left)` and `-right`, for a notch on a phone on its side. The top bar keeps its content at least 16px inside them.
- **Top:** `.app__main` is padded by `env(safe-area-inset-top)`, and the top bar grows by it, for an app added to the home screen. In Safari's own window the top inset is 0.
- **Bottom:** `.app__main` on top-level screens, the phone pill in `TabBar`, the sticky `.screen__footer`, the body or footer of a `BottomSheet`, the floating camera button in `PhotosView`, the development-only Demo button, and `ToastMessage` (its `offset` is measured from the inset).
- **One source for the bars' height:** `--topbar-real-height` and `--tabbar-real-height` (tokens.css) include the insets. `.app__main`, the top bar's own height, Home's full-height band, the sticky tops on Home and Edit profile, the Demo button and the hover cards' clamp in `MeetupPins` and `SpotPins` (through `barHeights()` in `lib/bars.js`) all read them.
- **The full-screen map** (`SessionMapView`) runs under every inset; its back bar, stop list and place card stay inside them, and so do Leaflet's own corner boxes (the zoom buttons and the attribution), moved in by the insets with `:deep(.leaflet-*)` rules.

### Stacking order

There are no z-index tokens. The values in use:

| z-index | What sits there |
|---|---|
| -1 | The fill inside the next button; the pin's ground shadow. |
| 0 | `GridPulse`. |
| 1, 2 | Local layering inside a component or screen. |
| 5 | `.screen__footer`. |
| 15 | The floating camera button (`PhotosView`). |
| 20 | `TabBar`. |
| 25 | `DemoPanel` (development builds only). |
| 30 | `BottomSheet`, `PopoverPanel`, `PlaceDetail`. |
| 40 | `PhotoViewer`, `ToastMessage`, an open `RadialTimePicker`. |
| 50 | `ModalDialog`, so a question can sit above the photo viewer. |
| 60 | The confetti canvas. |
| 500, 600 | Overlays on a Leaflet map (`CategoryKey`, map buttons, the selected-place card). |
| 1000 | The `.enter-game` cover. |
| 1100 | `MapLoading`, the spinner while the meeting spot is confirmed (once it has taken 600 ms), inside the Locate map's pane only. It is above the map's layers and buttons, takes the map's clicks, taps and scrolls (the rest of the page and the keyboard carry on), and lets the map be used again after 20 seconds. The map pane is hidden in the list view (phones and tablets), so the spinner is the map's own busy state; the confirm buttons carry it everywhere (see Locate, Loading). |
| 1100 | The bars and card of `SessionMapView`. |

## Elevation & Depth

Surfaces are flat at rest and separated by a 1px hairline and white space. Depth appears in three ways: one soft shadow for things that float, a dimmed backdrop behind sheets and dialogs, and a blurred translucent panel in a few places.

### Shadow Vocabulary

- **Float** (`--shadow-float`: `rgba(0, 0, 0, 0.02) 0 0 0 1px, rgba(0, 0, 0, 0.04) 0 2px 6px 0, rgba(0, 0, 0, 0.1) 0 4px 8px 0`): the only shadow token. Map pins and overlays, the switch knob, the slider thumb, a dragged list item, a card that is a link when hovered, the desktop `PlaceDetail` panel.
- **Ring** (`0 0 0 2px var(--canvas)`, sometimes followed by a second coloured ring): separates overlapping avatars, category badges on photos, and medal rings on the podium. Not a token.

Shadows written in place rather than taken from the token:

| File | Value |
|---|---|
| `components/ui/TabBar.vue` | `0 12px 32px -12px rgb(0 0 0 / 0.28)` in front of `--shadow-float`, on the phone pill. |
| `components/ui/PopoverPanel.vue` | `0 18px 40px -12px rgb(0 0 0 / 0.22), 0 2px 6px rgb(0 0 0 / 0.06)`. |
| `components/ui/HeroButton.vue` | `0 10px 28px -12px` of `--primary` at 70%; 75% on hover. |
| `components/ui/PinButton.vue` | `drop-shadow(0 10px 18px …)` of `--primary` at 45%. |
| `components/ui/RadialTimePicker.vue` | Three, including `0 4px 10px -2px rgb(0 0 0 / 0.14)` on the orbiting buttons. |
| `components/ui/MeetupGraph.vue`, `views/EventView.vue`, `views/GroupDetailView.vue`, `views/LandingView.vue` | One each. |

### Backdrops and blur

`BottomSheet` and `ModalDialog` put `--scrim` at 50% opacity behind the panel. `PopoverPanel` has no backdrop. `backdrop-filter: blur(...)` is used in three files: `PhotoViewer` (the dark backdrop and its buttons), `ProfileView` (the buttons on the banner) and `LeaderboardView` (the `.board` panel, 72% white with `blur(14px) saturate(1.3)`, so the grid's colour shows through softly).

### Gradients

Gradients are used in eight files. The ones a person sees: the Home band fading from `--surface-soft` to white and the greeting's name filled with a moving red-to-orange gradient (`LandingView`); the profile banner built from the person's colour (`ProfileView`); the `.enter-game` cover; the slider's filled track (`RangeSlider`); the planned-day hatching in `MeetupGraph`; the wooden pegs in `PolaroidLine`; the "Plan confirmed" banner in `EventView`, which fades from a 14% tint of `--primary-bright` to a 12% tint of `--cat-shop-fg`. The rest are masks.

### Named Rules

**The Flat At Rest Rule.** A card has a hairline and no shadow. It lifts by 2px with `--shadow-float` on hover only when the whole card is a link (`SessionCard`, `PlaceCard`). A card that cannot be clicked does not lift.

## Shapes

Corners are soft everywhere. Controls that hold one word or one icon are fully round; boxes that hold content step up from 8px to 20px with their size.

| Token | Value | What it is for |
|---|---|---|
| `--rounded-xs` | 4px | The voucher code box in `RewardsView`; the focus outline's corner on a session step and a stop's name. |
| `--rounded-sm` | 8px | Primary, secondary and danger buttons; text inputs; tooltips. |
| `--rounded-md` | 14px | Cards, photo plates, banners, the podium blocks' top corners. |
| `--rounded-lg` | 20px | Sheets, dialogs, popovers, the Leaderboard panel. |
| `--rounded-full` | 9999px | Chips, pills, avatars, icon buttons, the next button, the pill button, the phone tab bar and its tabs. |
| `--rounded-none`, `--rounded-xl` | 0px, 32px | Defined, not used. |

Radii written as plain pixels: 5px (`SegmentedProgress` blocks), 6px (`MeetupGraph` view switch), 10px (the photo strip in `EventView`), 3px and 2px (small swatches and pegs).

Borders are 1px `--hairline` by default. A stronger 1px `--border-control` outline marks a control that is not filled (a text field, a select, an unselected chip, the switch); `--border-strong` is for decoration (a dashed empty, the next button, the sheet handle). Two inset stripes are drawn with `box-shadow`: a 4px stripe in the category colour on the left edge of `SuggestionCard`, and a 3px error-red stripe on the left of an error `BannerNote`.

The recurring silhouettes are the map pin (`PinButton`, a teardrop drawn in a `0 0 100 128` box with its tip at the bottom centre), the crown (in `JioLogo`, `CoinBadge` and the `crown` icon) and the circle.

## Components

Every component file opens with a comment that shows how to call it. Paths are under `frontend/src/components/`. "Props" lists the names and defaults as the code defines them.

### Buttons

| Component | What it is for | Props and variants | States | Use it when; otherwise |
|---|---|---|---|---|
| `ui/AppButton.vue` | Every text button. | `variant`: `primary` (default), `secondary`, `tertiary`, `pill`, `danger`. `block`, `small`, `underline`, `disabled`, `next` (booleans, default false). `to`, `href`, `type` (default `button`). | Hover (devices that hover), pressed (`scale(0.97)` and a darker fill), focus (2px ink outline, 3px offset on primary), disabled. | The main action of a screen is `primary`; one that moves to the next step adds `next`. Use `secondary` for the other choice, `tertiary` for a text link, `danger` only for something that cannot be undone. |
| `ui/AppButton.vue` with `next` | A white pill, 48px tall, at least 160px wide, with the label and an arrow. On hover or keyboard focus a red dot swells to fill it and a white copy of the label slides in. On touch screens it is red from the start. | Primary only. With `small`: 44px tall, at least 120px wide. | As above; disabled shows a grey outline and grey label. | "Next", "Start session", "Vote on places", "Itinerary", "Done". Not for actions that stay on the page. |
| `ui/IconButton.vue` | A 44px circle holding one icon. | `label` (required; read out and shown as a tooltip), `outline` (false), `tone` (`''` or `'brand'`), `to`. | Hover, pressed (`scale(0.9)`), disabled. | Secondary actions such as back, close, edit, filter. Use `tone="brand"` for the one main icon action on a screen. |
| `ui/ChipButton.vue` | A 32px pill inside a 44px tap area. Outlined at rest, ink when selected. | `selected`, `radio`, `check`, `disabled` (all false). Slot `leading` for an avatar or icon (the pill becomes 40px). CSS variable `--chip-on` replaces ink with another fill. | Hover, pressed (`scale(0.94)`), selected (pops in), disabled. | Filters and picks from a short set. For two or three views of the same content use `SegmentTabs`. |
| `ui/PinButton.vue` | The Home map's main action: a red map pin, 128px wide, with the logo or two lines of words in its head. | `to` (required), `label` (`''`), `big` (`''`), `small` (`'your friends'`). | Bobs while idle, lifts on hover, squashes on press, plays the "entering a game" move on click. | Home only, placed with its bottom edge on the meeting point. One per screen. |
| `ui/HoldButton.vue` | Press and hold to confirm something that cannot be undone. A red-tinted fill sweeps across while held. | `label` (required), `action` (`''`, said to screen readers), `icon` (`'close'`), `duration` (1200). Emits `done` after a full hold, or at once for an activation that is not a press (a click with `detail` 0, which is what a screen reader, switch control or voice control sends). Its accessible name contains the visible label. | Idle, holding (label reads "Keep holding"), released early (fill runs back). | Ending a session, from `SessionHeader`. Follow `done` with a `ModalDialog`. For an ordinary destructive choice use `AppButton variant="danger"` inside a dialog. |
| `ui/HeroButton.vue` | A 60px red pill with a white circle holding an arrow. | `to` (required). | Hover (lifts 2px), pressed, focus (a white then ink ring). | Defined and not used by any screen at this commit. |

### Inputs and pickers

| Component | What it is for | Props | States | Use it when; otherwise |
|---|---|---|---|---|
| `ui/TextField.vue` | A labelled text input, 56px tall. | `label` (required), `hideLabel`, `hint`, `error`, `multiline`, `id`. `v-model`. Other attributes go to the input. Slots `leading` (a decorative 16px icon at the start; the text starts at 42px) and `trailing` (a control at the end that the caller places and makes room for). | Focus (border grows to 2px ink, padding shrinks 1px), invalid (error-red border and message with `role="alert"`), disabled. | Any typed value. |
| `ui/SelectField.vue` | A labelled dropdown that matches `TextField`. | `label`, `options` (required), `placeholder`, `error`, `id`. `v-model`. | Focus, empty (muted text), invalid. | A choice from a long list. For a short set use chips. |
| `ui/ToggleSwitch.vue` | An on/off switch, 48 by 28px, with its label on the left. Ink when on. | `label` (required), `hint`, `disabled`. `v-model`. | Off, on, hover, disabled. | A setting that takes effect at once. |
| `ui/RangeSlider.vue` | A labelled slider with its value written at the right. Ink track, white thumb. | `label` (required), `min` (0), `max` (100), `step` (1), `format`. `v-model`. | Hover (ink thumb border), focus. | A number within bounds, such as budget or distance. |
| `ui/CalendarPicker.vue` | A month calendar for one day. Weeks start on Monday. | `label` (`'Date'`), `min` (`''`, meaning today), `max` (`''`). `v-model` as `yyyy-MM-dd`. | Today (outlined, and `aria-current="date"`), selected (red fill, white number), outside the month (muted), disabled (struck through). A day fills its cell's width and is 44px tall. The grid is one tab stop: arrow keys move by day and week, Home and End by week, Page Up and Page Down by month. | Picking a session's day. New in this pull request. |
| `ui/RadialTimePicker.vue` | A 24-hour time in a round pill. On hover or tap, eight buttons orbit out 125px to add or take off 15m, 30m, 1h, 2h. The time can also be typed. | `label` (required), `fallback` (`'09:00'`), `hint`, `error`. `v-model` as `HH:mm`. | Closed, open, focused, error. | A session's start and end. New in this pull request. |
| `ui/SortableList.vue` | A list reordered by dragging a handle or with the arrow keys. | `items`, `itemKey`, `label` (required), `itemLabel`, `disabled`, `hint`. Emits `move`. Slot `item`. | Idle, sorting, dragging (the item lifts with `--shadow-float`). | Reordering stops on the itinerary. Bind the slot's `handle` to a `.drag-handle` button. |

### Navigation and progress

| Component | What it is for | Props | States | Use it when; otherwise |
|---|---|---|---|---|
| `ui/TabBar.vue` | The main navigation; see Layout. | `tabs` (default: Home, Leaderboard, Create, Rewards, Profile). | Current (`aria-current="page"`), hover, pressed. | Rendered once by `App.vue`. Do not add a second. |
| `ui/SegmentTabs.vue` | Text tabs with a 2px ink rule under the current one. | `tabs`, `label` (required). `v-model`. A tab may have `icon` and `iconOnly`. | Current, hover. | Two to four views of one list, such as Upcoming / Past. |
| `ui/SplitView.vue` | A list and a map of the same things: one at a time under 1128px, side by side from 1128px. | `label` (required), `even` (false). `v-model:view`. Slots `list`, `map`. | List, map, map expanded (desktop). | Any screen with a `PlannerMap` and a matching list. |
| `event/SessionSteps.vue` | A session's five steps (Create, Invite, Locate, Vote, Itinerary) as a bar that also navigates. | `session` (default null, for the create page). | Reached (red bar, links to its page), here (bold ink label, taller bar), later (grey), cancelled (grey bars). | At the top of every session screen, through `SessionHeader`. New in this pull request. |
| `ui/ProgressBar.vue` | A 4px ink bar. | `value`, `label` (required), `max` (1). | — | Steps of a form (sign-up). |
| `ui/SegmentedProgress.vue` | A bar of rounded blocks that fill red, with the percentage above. | `value` (required, 0 to 100), `label`, `segments` (20). | The newest block is taller. | A wait with a known end, such as finding the meeting point. |
| `ui/ProgressDonut.vue` | Who has done something, as a red ring on a pale red track. | `title`, `people` (required), `doneLabel` (`'Done'`), `todoLabel` (`'Waiting'`), `compact`, `size`. | Default (112px, names listed), compact (40px, "4 of 6"). | Joined, located and voted counts. |

### Overlays

| Component | What it is for | Props | States | Use it when; otherwise |
|---|---|---|---|---|
| `ui/PopoverPanel.vue` | A small card that opens beside the button that was pressed, with no backdrop. It follows the button on scroll and spans the width under 560px. | `title` (`''`), `width` (380), `maxHeight` (560). `v-model:open`. Slot `footer`. Emits `close`. | Open, closed. Closes on Escape, the close button and a press outside. | A quick pick that should leave the page in view: inviting friends, setting a location, adding a place. New in this pull request. |
| `ui/BottomSheet.vue` | A sheet that slides up over a dimmed backdrop; a centred dialog or side panel from 1128px. | `title`, `hideClose`, `tall`, `side`. `v-model:open`. Slot `footer`. | Open, closed. | A longer task with its own footer, such as the Home filter. |
| `ui/ModalDialog.vue` | A small centred dialog for one decision. | `title` (required), `text`. `v-model:open`. Slots `content` and default (the buttons). | Open, closed. | A yes-or-no question. Put the safer choice first. |
| `ui/ToastMessage.vue` | A short ink pill that appears above the bottom edge and leaves by itself. | `text` (required), `duration` (2500), `offset` (96). `v-model:show`. | Shown, hidden. | Confirming something that already happened. Not for errors. |
| `ui/PhotoViewer.vue` | A full-screen, swipeable carousel on a dark blurred backdrop. | `photos` (required), `canDelete`, `origin`, `place`. `v-model:index` (-1 when closed). Emits `delete`. | Controls shown or hidden, dragging, pulling down to close. | Session photos only. |
| `event/PlaceDetail.vue` | A place opened from its card: photo, name, rating, price, address, "Navigate", sample reviews. Full screen on phones, a centred panel from 768px. | `place` (required), `reviews` (null while loading), `from` (`'home'`), `error`. Emits `close`. | Loading reviews, loaded, error. | Opened by `LandingView` with a view transition from a `PlaceCard` that has `morph`. |
| `group/ClashDialog.vue` | A `ModalDialog` for a meetup that falls on top of another one the person is in. It names that meetup with its times and day, with no middle dot. | `clash` (`{ id, title, date, start, end }` or null), `mode` (`edit`, the default, or `join`). `v-model:open`. | Open, closed. | `edit` (making or changing a meetup): "That time is taken", "Change the time" and `Open "{title}"`. `join` (a link, or Rejoin): "This meetup overlaps one you're in", `View "{title}"` and "Close". Pair it with `useReturnFocus` so focus goes back to the disabled-while-busy button that started the request. |
| `group/InviteDialog.vue` | Invite friends from a `PopoverPanel` beside the Invite button. | `session` (required). `v-model:open`. | Searching, picked, sending. | Inviting from inside a session. New in this pull request. |
| `group/LocationSheet.vue` | Pick a start or end location by search or current location. | `which` (`'start'`), `home`. `v-model:open`. Emits `select`. | — | Setting a member's own location. Opens in a `PopoverPanel`. |

### Labels, badges and notes

| Component | What it is for | Props | Use it when; otherwise |
|---|---|---|---|
| `ui/StatusPill.vue` | A session's status as an 11px pill. | `status` (required): `inviting` (outlined), `locating` and `voting` (grey), `confirmed` (red), `completed` (ink), `cancelled` (error-red outline). | On `SessionCard` and in `SessionMapView`. |
| `ui/CountdownChip.vue` | When a session starts, live. | `session` (required). Tones from `lib/session.js`: `soon`, `later`, `muted`, `live` (red, with a pulsing dot). | Beside a session's status. |
| `ui/InfoTag.vue` | A small label that is not a control. It has no outline, so it does not look tappable beside a chip. | `tone`: `neutral` (default), `strong`, `warning`, `error`, and the dietary `halal` (brown, `--diet-halal-*`) and `veg` (green, `--diet-veg-*`). `icon`. | "Near MRT", "Leading", "Rain expected", "Halal likely". |
| `ui/BannerNote.vue` | A banner across the top of a screen. | `tone`: `info` (default), `warning`, `error`. `icon` (`'info'`), `dismissible`. Slot `actions`. Emits `dismiss`. | A message about the whole screen. For a field's error use the field's `error`. |
| `ui/SampleNote.vue` | A caption with an info icon that marks demo content. | Default slot; without it the text is "Sample data for the demo". | Wherever hand-written content is shown. See Known Conflicts for where it is and is not rendered. |
| `ui/CoinBadge.vue` | The JioCoins coin, alone or after an amount. | `amount` (null), `size` (null, meaning 1.1em), `short` (false). | Anywhere an amount of JioCoins is shown. In text that cannot hold a picture, use `coins(n)` from `lib/currency.js`. New in this pull request. |
| `ui/RatingBadge.vue` | A star and a score out of 10 with one decimal. | `score` (required), `large`. | Place ratings. |
| `ui/PriceTier.vue` | A price as `$`, `$$` or `$$$`. | `price` (required). | Never show the number itself. |
| `ui/EmptyState.vue` | A title, one line and one action for an empty list. | `title` (required), `text`, `illustration`. | Empty lists and failed loads (with `role="alert"` and a Retry button). |
| `ui/SkeletonRow.vue` | A grey placeholder row. | `avatar` (false), `lines` (2). | While a list loads. |
| `ui/StatTile.vue` | A big number with a label on a flat card. | `label`, `value` (required), `icon`, `hint`. | Shown only in `DesignSystemView` at this commit. |

### People, icons and the logo

| Component | What it is for | Props |
|---|---|---|
| `ui/UserAvatar.vue` | A round avatar: the photo, or the first letter of the name on the person's colour. | `name` (required), `src`, `size` (40; also 24, 32, 64, 96), `labelled` (false), `person` (their id). |
| `ui/AvatarStack.vue` | Overlapping avatars, then "+2". | `people` (required), `size` (24), `max` (5). |
| `group/MemberList.vue` | Everyone in a session: name, area, "about 25 min" coloured by length, and a status icon. | `session`, `names` (required), `voters`. |
| `ui/AppIcon.vue` | Every icon. | `name` (required, checked against the icon table), `size`, `solid`, `label`. |
| `ui/CategoryIcon.vue` | A category's icon on its pale circle, named for screen readers. | `category` (required: `eat`, `drink`, `shop`, `activity`), `size` (32). |
| `ui/IllustrationBlob.vue` | One of four small line drawings. | `name` (default `'invite'`). |
| `ui/JioLogo.vue` | The logo as an inline SVG. | `height` (28), `title` (`'Jio'`), `decorative` (false). |
| `ui/ListRow.vue` | A row: something left, a title and a line, something right. | `title`, `meta`, `to`, `as` (`'div'`). Slots `leading`, `trailing`. |

### Session and place cards

| Component | What it is for | Props |
|---|---|---|
| `event/SessionCard.vue` | A session on Home, Sessions and a profile. The whole card is a link and lifts on hover. | `session`, `names` (required), `hero` (false; the large card, with a photo band when the day has photos). |
| `event/SessionHeader.vue` | The top of every session screen: back arrow, title, date, `SessionSteps`, Invite, and "Hold to end". | `session` (required), `title`, `back` (`'/'`). |
| `event/SessionNotices.vue` | Re-plan, not enough people, and cancelled notices, and, while voting, one dismissible `BannerNote` when the meeting area moved and votes were cleared. | `session` (required). |
| `event/PlaceCard.vue` | A place near the meetup: photo, category, name, area, price tier, rating. | `place` (required), `morph` (false). |
| `event/SuggestionCard.vue` | One suggested place with its vote, a category stripe, and "about N min walk". | `option` (required), `leading`, `behind`, `mine`, `closed`, `selected`. Emits `vote`, `swap`. |
| `event/StopCard.vue` | One stop on the itinerary: a numbered dot in the category colour, time and duration, name, area, price tier. | `time`, `duration`, `name`, `category`, `price` (required), `area`, `number`, `warning`, `lifted`, `image`, `banner`. Slots `handle`, `actions`. |
| `event/TravelConnector.vue` | The Walk / MRT / Car switch between two stops, each with "about N min". | `options`, `mode` (required), `readonly`, `label`. |
| `event/LedgerCard.vue` | "Your travel": the signed-in person's own row of the travel ledger for a finished outing on the server (getting there, between stops, getting home, the total, and how that compares with the group's average). Four states: placeholder rows, the row, "Could not load your travel." and "Your travel is not worked out yet.", the last two with `Try again`. | `ledger`, `loading`, `failed`. Emits `retry`. |
| `event/PollBar.vue` | One option of a poll as a bar. | `name`, `votes`, `total` (required), `leading`, `mine`, `note`, `closed`. Shown only in `DesignSystemView` at this commit. |

### Leaderboard

| Component | What it is for | Props |
|---|---|---|
| `ui/LeaderboardCard.vue` | Title, date range, an optional season picker, the podium, and the paged list. | `fromDate`, `toDate`, `podiumRankings`, `rankings` (required), `title` (`'Leaderboard'`), `currentUserId`, `runOptions`, `pageSize` (10). `v-model:selectedRunId`. |
| `ui/LeaderboardPodium.vue` | The top three on stepped blocks 136, 104 and 84px tall. They look ordered 2 · 1 · 3 and are written, and read aloud, 1 · 2 · 3 (CSS `order`). | `rankings` (required), `currentUserId`. |
| `ui/LeaderboardRankings.vue` | The full ranking in pages. The current user's row has a 2px ink outline. | `rankings` (required), `currentUserId`, `showPagination`, `defaultPageSize` (10). |

### Maps and signature pieces

| Component | What it is for | Props |
|---|---|---|
| `map/PlannerMap.vue` | Every interactive map: Leaflet on OneMap tiles, with person pills, the red meeting-area pin, numbered stops and category dots. | `people`, `area`, `places`, `route`, `spokes`, `selected`, `label` (`'Map'`), `fitTo` (`'all'`), `zoomPosition` (`'topleft'`), `finding`, `radius`, `keep`, `rain` (`[{ lat, lng }]`, drawn as the rain of "Weather"), `rainLabel` (the chip's words). Emits `select`, `view`. |
| `weather/RainChip.vue` | The white chip that names the rain on a map: a cloud-rain icon and "Rain likely · next 2 h". Information, not a button. | `text` (empty draws nothing). |
| `map/CategoryKey.vue` | The key to category colours, over a corner of a map. | `categories`. |
| `ui/SingaporeMap.vue` | The muted dotted map of Singapore with routes that draw in to one point, and the rain of "Weather" under them. Decoration only, hidden from screen readers. | `routes`, `center`, `span` (`[420, 330]`), `hideMeet`, `quick`, `rain` (`[{ lat, lng }]`). |
| `ui/GridPulse.vue` | A fine grid drawn on one canvas. Cells shade where the pointer passes and fade out: a pale grey, about one in eight a faint wash of `--primary` (`lib/gridPulse.js`). None light by themselves. Cells behind text marked `data-grid-avoid` go faint. | `cell` (24), `reach` (1.6), `ambient` (0), `maxLit` (40), `avoid` (`'[data-grid-avoid]'`). |
| `ui/MeetupGraph.vue` | Meetup frequency as a heat map that folds up into an isometric skyline. | `history`, `planned`, `weeks` (26), `today`, `defaultView` (`'3d'`). |
| `ui/PolaroidLine.vue` | Session photos as instant prints pegged to a sagging string. | `photos` (required), `height`, `cardWidth` (260), `sag` (40), `swing` (1), `autoplay` (5000), `label` (`'Photos'`). `v-model:index`. Emits `open`. |

Use `PlannerMap` for anything a person reads a place from. Use `SingaporeMap` only as a backdrop. Use `GridPulse` only behind a whole screen, through `.grid-page`, and mark headings on it with `data-grid-avoid`.

### How the screens compose them

| Screen | File | Composition |
|---|---|---|
| Home | `views/LandingView.vue` | A full-width band with `SingaporeMap`, the greeting, and `PinButton` on the meeting point; then "Your meetups" (`SessionCard`) and "Places near your meetup" (`PlaceCard` in `.grid-3`, a Filter `BottomSheet`, `PlaceDetail`). |
| Leaderboard | `views/LeaderboardView.vue` | `.grid-page` with `GridPulse`; a title, a red countdown pill and a prize pill; `LeaderboardCard` on a blurred translucent panel. |
| Rewards | `views/RewardsView.vue` | `.grid-page`; the balance with a `+` that opens a popover; voucher cards with a Claim button; two `ModalDialog`s. |
| Profile | `views/ProfileView.vue` | `.grid-page`; a banner in the person's colour, `UserAvatar` overlapping it, three numbers, `MeetupGraph`, then sessions or recent activity. |
| Session | `views/GroupDetailView.vue` | `SessionHeader`, `ProgressDonut`, `MemberList`, `SplitView` with `PlannerMap`, `SegmentedProgress` while the meeting point is found. |
| Vote | `views/PlannerView.vue` | `SessionHeader`, `SplitView` of `SuggestionCard`s and `PlannerMap`, a `PopoverPanel` to add a place, a confirm `ModalDialog`. |
| Itinerary | `views/EventView.vue` | `SessionHeader`, a timeline of `StopCard` and `TravelConnector` in a `SortableList`, `PlannerMap`, a "Plan confirmed" banner. |
| Photos | `views/PhotosView.vue` | `PolaroidLine`, a thumbnail grid, `PhotoViewer`, a floating camera `IconButton tone="brand"`. |
| Sign-up | `views/AuthView.vue` | `.screen--form`, one question per screen, `ProgressBar`, `TextField`. |
| Create session | `views/CreateEventView.vue` | `.screen--wide-form`, `SessionSteps`, `TextField`, `CalendarPicker`, two `RadialTimePicker`s, a `next` button. |
| Design system | `views/DesignSystemView.vue` | A gallery at `/design-system`. It does not yet show the components added in this pull request other than `JioLogo`. |

## Do's and Don'ts

### Do:
- **Do** take every colour, size, radius and shadow from `frontend/src/styles/tokens.css`, and every type size from the `--text-*` tokens or their classes.
- **Do** keep one main action per screen and give it `AppButton` (`primary`, or `primary next` when it moves to the next step).
- **Do** fill a toggled choice with `--selected` (ink) and a measure of progress with `--primary`.
- **Do** show category, person, travel and medal colours with a word, an icon or a key beside them.
- **Do** keep cards flat with a 1px `--hairline`, and add the hover lift only when the whole card is a link.
- **Do** make every tap target at least `--tap-min` (44px), as `ChipButton` and `ToggleSwitch` do by padding a smaller shape.
- **Do** write estimated times as "about N min" and mark hand-written content with `SampleNote`.
- **Do** give every animation a reduced-motion path, and check `prefers-reduced-motion` in script when the script itself animates.
- **Do** read Known Conflicts before placing new white text on `--primary`, on a category colour or on a person colour. Those pairs are open decisions.

### Don't:
- **Don't** use a category, person, travel or medal colour for a button or a link.
- **Don't** render a second `TabBar`, a second `PinButton`, or `GridPulse` inside a card.
- **Don't** put a backdrop behind `PopoverPanel`, or use it for a task that needs a footer of several buttons; use `BottomSheet`.
- **Don't** show a price as a number where `PriceTier` is used, or the word "JioCoins" where `CoinBadge` fits.
- **Don't** write a label in upper case, add an exclamation mark, or use emoji. No screen does.
- **Don't** load Bootstrap. It is a dependency in `frontend/package.json` and is not imported in `frontend/src/main.js`.

## Motion

Durations and curves are tokens in `tokens.css`:

| Token | Value | What it is for |
|---|---|---|
| `--motion-fast` | 200ms | Hover and press changes, fades. |
| `--motion-medium` | 320ms | Sheets, dialogs and photos sliding into place. |
| `--ease-out` | `cubic-bezier(0.22, 1, 0.36, 1)` | The default curve. |
| `--ease-spring` | `cubic-bezier(0.34, 1.56, 0.64, 1)` | A small overshoot: buttons letting go, chips popping on. |
| `--ease-sheet` | `cubic-bezier(0.32, 0.72, 0, 1)` | Sheets and dialogs arriving. Used by `BottomSheet` and `ModalDialog`. |

A global rule in `app.css` covers every CSS animation and transition under `prefers-reduced-motion: reduce`: durations become 0.01ms, animations run once, and smooth scrolling is off. Animations run by script check the same query themselves. The last column says how each one honours it.

### Named animations

| Name | File | Duration and curve | Trigger | Reduced motion |
|---|---|---|---|---|
| `rise` | `styles/app.css` | 420ms `cubic-bezier(0.16, 1, 0.3, 1)`, delayed 60ms per `--i` | A `.rise` element appears (13 uses). | Not applied: the rule sits inside a `no-preference` query. |
| `page-out`, `page-in` | `styles/app.css`, `lib/viewTransition.js` | 180ms ease-out; 280ms `cubic-bezier(0.25, 1, 0.5, 1)`, 6px upward | A route change to a different path. | Skipped: `canViewTransition()` returns false. |
| View-transition groups | `styles/app.css` | 240ms `--ease-out` by default; `app-tabs` 0s, so the tab bar stays still | Any view transition. | Skipped. |
| `photo-hero` group | `styles/app.css`, `PhotoViewer` | 420ms `--ease-out` | A photo opens from, or closes into, its tile. | Skipped. |
| `place-card`, `place-photo` groups; `vt-fade-out`, `vt-fade-in` | `styles/app.css`, `LandingView` | 440ms `cubic-bezier(0.32, 0.72, 0, 1)`; fades 160ms and 260ms after 60ms | A `PlaceCard` opens into `PlaceDetail` and back. | Skipped. |
| `.enter-game` grow, hold, leave; `enter-ring` | `styles/app.css`, `lib/enterGame.js` | Grow 650ms `cubic-bezier(0.7, 0, 0.3, 1)`, hold 350ms, dissolve 700ms `--ease-out`; three rings 900ms from 380, 500 and 620ms | A click on `PinButton`. | `enterGame` navigates at once. |
| `pin-bob`, `pin-bob-shadow` | `PinButton` | 2.8s ease-in-out, endless | Always, while the pin waits. | `animation: none`. |
| `pin-launch` | `PinButton` | 700ms `cubic-bezier(0.5, 0, 0.3, 1)` | A click on the pin. | `animation: none`. |
| `tabbar-in` | `TabBar` | 520ms `--ease-spring` | The phone pill first appears. | `animation: none`. |
| Tab name sliding out | `TabBar` | Width 380ms `--ease-spring`; fade 190ms `--ease-out` | A tab becomes current (phones). | `transition: none`. |
| `chip-pop` | `ChipButton` | 320ms `--ease-spring` | A chip is selected. | `animation: none`. |
| `live` | `CountdownChip` | 1.6s ease-in-out, endless | A session is happening now. | Not applied (`no-preference` query). |
| `skeleton-pulse` | `SkeletonRow` | 1.2s ease-in-out, endless | A list is loading. | Global rule only. |
| `byname-spin` | `InviteByUsername` | 800ms linear, endless | The invite field is waiting for, or asking about, a username. | Global rule only (a still ring). |
| `loading` | `PhotosView` | 1.1s ease-in-out, alternating | A thumbnail is uploading. | Global rule only. |
| `map-loading-spin` | `MapLoading` | 0.8s linear, endless; the card fades in over `--motion-fast` | Confirming the meeting spot on Locate has run for 600 ms; it then stays at least 400 ms (`lib/pageLoading.js`). Seen only where the map is (the desktop, or the Map view); the buttons say "Confirming…" in every view. | Slowed to 2.4s a turn, not stopped, so it still says the page is working. |
| `sgmap-draw` | `SingaporeMap` | 1.4s `--ease-out`, delayed 0.2s plus 0.2s per route | The map mounts. | Routes are drawn at once. |
| `sgmap-comet` | `SingaporeMap` | 3.2s `cubic-bezier(0.45, 0, 0.25, 1)`, endless | After a route is drawn. | Switched off in the component's reduced-motion block. |
| `sgmap-pop` | `SingaporeMap` | 400ms `--ease-out` | A route's start ring appears. | Shown at once. |
| `rain-in` | `styles/rain.css` (`SingaporeMap`, `PlannerMap`) | 900ms `--ease-out`, opacity only | The rain first appears on a map. | `animation: none`; the rain is simply there. |
| `rain-fall` | `styles/rain.css` | Linear, endless, transform only: far 1.7s and 12px, middle 1.1s and 20px, near 0.65s and 34px | Rain is drawn. | `animation: none`; the drops stand still. |
| `rain-chip-in` | `RainChip` | 600ms `--ease-out` after 200ms, opacity and 4px rise | The chip appears. | `animation: none`. |
| `pm-comet` | `PlannerMap` | 3s `cubic-bezier(0.45, 0, 0.25, 1)`, endless | `spokes` is set. | Component reduced-motion block. |
| `pm-pulse` | `PlannerMap` | 1.8s ease-out, endless | `finding` is set. | `animation: none`. |
| Radius circle | `PlannerMap` (script) | 480ms | `radius` changes. | The map jumps instead of gliding. |
| `hello-shine` | `LandingView` | 1.6s `--ease-out` after 200ms | Home opens. | `animation: none`. |
| `meetup-pulse` | `LandingView` | 2s ease-out, endless | A meetup is going. | `animation: none`. |
| `area-reveal` | `GroupDetailView` | 420ms `--ease-spring` | The meeting point is revealed. | `animation: none`. |
| `celebrate-pop`, `celebrate` enter | `EventView` | Icon 700ms after 150ms on `cubic-bezier(0.34, 1.56, 0.64, 1)`; banner fade 400ms, move 600ms | The plan is confirmed. | Global rule only. |
| `pd-in` | `PlaceDetail` | 280ms `--ease-out` | Reviews arrive. | `animation: none`. |
| `pl-in` | `PolaroidLine` | 550ms `cubic-bezier(0.2, 0.8, 0.2, 1)` | The current print changes. | `animation: none`; the line never moves by itself and the Pause button is hidden. |
| Confetti | `lib/confetti.js` | 160 pieces over 3200ms on a canvas | `PlannerView` confirms a plan. | Does nothing. |
| Grid cells | `GridPulse` (script) | Fade in 160ms, fade out 750ms | The pointer moves; a few cells light on a timer. | Only the still grid is drawn. |
| Flat to skyline | `MeetupGraph` (script) | 1300ms `cubic-bezier(0.65, 0, 0.35, 1)`; view switch 500ms | First scroll into view; the 2D / 3D switch. | "Every change simply happens." |
| Photo slide | `PhotoViewer` | 420ms `--ease-out`; pull-back `--motion-medium`; backdrop 600ms | Swipe, arrow keys, buttons. | Transitions off; no bump at the ends. |
| Hold fill | `HoldButton` (script) | Follows the clock for `duration` (1200ms); runs back in 220ms `--ease-out` | Press and hold. | The fill follows the hold in script and does not check the query; the run-back is covered by the global rule. |

### Named transitions

| Name | File | Duration and curve |
|---|---|---|
| Press and release | `AppButton`, `IconButton`, `ChipButton` | Colour `--motion-fast` `--ease-out`; scale 260ms `--ease-spring`, 80ms on the way down. |
| Next button fill | `AppButton` | 300ms `--ease-out`; none on touch screens. |
| `sheet` | `BottomSheet` | In: backdrop `--motion-fast`, panel `--motion-medium` `--ease-sheet` from 48px below. Out: 160ms. |
| `modal` | `ModalDialog` | In: panel `--motion-medium` `--ease-sheet` from 12px below at 0.98 scale. Out: 150ms. |
| `pop` | `PopoverPanel` | In: fade 140ms, scale from 0.94 over 220ms `--ease-spring`, from the corner nearest the button. Out: 110ms. Under reduced motion: a 100ms fade only. |
| `toast` | `ToastMessage` | Fade `--motion-fast`. |
| `viewer`, `ambient` | `PhotoViewer` | Fade `--motion-fast`, stage `--motion-medium`; leave 180ms; backdrop 600ms. |
| Card lift | `SessionCard`, `PlaceCard`, `SuggestionCard` | `--motion-fast` `--ease-out`. |
| Orbiting buttons | `RadialTimePicker` | Out: 420ms `--ease-spring`, 18ms apart. In: 150ms. Under reduced motion: a 120ms fade. |
| Step bar | `SessionSteps` | `--motion-fast` `--ease-out`; off under reduced motion. |
| Sorting | `SortableList` | `--motion-fast` `--ease-out`; off under reduced motion. |

Curves and durations written in place where a token holds the same value: `200ms` in `TabBar` (`--motion-fast`), `cubic-bezier(0.34, 1.56, 0.64, 1)` in `EventView` (`--ease-spring`), `cubic-bezier(0.32, 0.72, 0, 1)` in `app.css` (`--ease-sheet`).

## Weather

How a forecast looks on a map, called "Layered drops". Words for the weather (the marks on a stop, the banners, the source line) are in `lib/weatherText.js` and are unchanged; this is the picture on a map and the chip that names it. The shapes and numbers are in `frontend/src/lib/rainLook.js`, the animation and reduced-motion rules in `frontend/src/styles/rain.css`.

**Tokens.** Three, in `tokens.css`, a blue-slate cooler than `--ink` so rain reads as weather and not as a shadow. They are information colours: they never mark an action. The app has no dark theme, so they have one value.

| Token | Value | Use |
|---|---|---|
| `--rain-wash` | `#4f7aa6` | The tint, at 40% in the middle, 28% at half way, 10% near the edge and nothing at it. |
| `--rain-streak` | `#6f9bc8` | The drops. |
| `--rain-text` | `#2a4866` | Chip text and icon, 9.5:1 on white. |

**The layers.** One patch of rain is a feathered wash (a radial gradient that ends in nothing, so there is no hard circle) and three layers of drops clipped by a feathered mask that stops a little inside the wash (66 of 72 of its radius). Each layer is a pattern that repeats, not a set of nodes: three rectangles for each patch. Far drops are short and faint (0.8 stroke, 0.38 opacity, falling 12px in 1.7s), middle drops are 1 stroke at 0.6 (20px in 1.1s), near drops are long and strongest (1.5 stroke at 0.85, 34px in 0.65s). A layer falls by exactly one tile of its pattern, so the loop has no seam. The layer fades in over 900ms (`--ease-out`) when the rain first appears. It lies under the routes, the meeting point, the pins and every marker, and it takes no pointer events. The map's tiles and attribution are not touched.

**The chip.** White, 32px tall, fully rounded, `--shadow-float`, a cloud-rain icon (`AppIcon` `rain`) and one line in `--text-caption` in `--rain-text`. It is information, not a button: no pointer events, no tap target, not focusable. Its words come from `rainChipText`, by where the forecast came from:

| Forecast | Chip |
|---|---|
| Live, the two-hour forecast (`basis: 'area'`) | "Rain likely · next 2 h" |
| Live, the 24-hour or a mixed forecast | "Rain likely" (no claim about two hours) |
| Simulated (the demo's "Simulate rain") | "Simulated rain" |
| Unavailable, outside the forecast window, or not known | No chip, and no rain drawn |

Home's line of text (`homeRainText`) follows the same rule through `rainWindow`, so a screen reader and the chip never disagree: "Rain likely around Bishan in the next two hours" only for the live two-hour forecast, "Rain likely around Bishan" for another live forecast, "Simulated rain around Bishan" for the demo's.

**Only while current.** Rain and its chip are drawn only while the forecast is current (`forecastIsCurrent` in `lib/weatherText.js`): before its `validUntil`, or before two hours after it was issued when it has no end time. A live forecast with no times, one that is unavailable, and one stored with a confirmed plan hours ago are not drawn. A simulated forecast is about no clock and is always current. This holds for Home, the itinerary's map and the full-screen map, and the screens read the shared clock, so the rain goes when the forecast runs out.

**Screens.**

| Screen | Map | What is drawn | Words for a screen reader |
|---|---|---|---|
| Home | `SingaporeMap` | One patch at each meeting area where rain is likely in the next two hours (`useHomeRain`), at most six. The chip sits just under the first of them, at the map's own scale (the pins fan out above a meeting point, so above would be behind them); it is the chip of the mock-up moved below the wash. Picking another meetup draws the map again without fading the same rain in again (`fadeRain`). | The map and the chip are hidden from screen readers. The line under the greeting says "Rain likely around Bishan in the next two hours" (`role="status"`), with the source line under it. |
| Itinerary (`EventView`), and the full-screen map (`SessionMapView`) | `PlannerMap` | A patch of its own at each stop of a confirmed plan whose weather says rain is likely, from a current live or simulated forecast (stops in the same spot share one; at most six). Chip at the top middle of the map, in a slot that clears the zoom buttons and "View map" or "Expand map" (it starts 64px down); on the full-screen map it is under the bar with the back button. The full-screen map also carries the muted source line and its licence notice (`WeatherSource`) under the chip, as Home and the itinerary do. | The chip is inside the map's region, so it is read with the map. The rain banners and the marks on each stop say the rest. |

The Locate and Vote maps show no rain: they carry no forecast for a place yet.

**On `PlannerMap`.** The rain is a Leaflet marker for each patch, in a pane of its own (z-index 350, between the tiles at 200 and the route at 400), so it moves and glides with the map. Its size covers about 1 km each way at the current zoom, between 170 and 480px across. During a zoom it scales to the size it will have, in step with the markers' glide (250ms, Leaflet's own curve), and it is made at that size when the zoom ends (without the fade). Each rainy stop has a patch of its own, so a stop zoomed into always has rain round it.

**Cost.** Each patch is three animated rectangles under one mask. Measured in Chromium with the CPU slowed 4 times, on Home and on a Leaflet map being panned, with 1, 3 and 6 patches: every frame stayed at 16.7ms (no frame over 25ms) at every count, and raster work grew by about 85ms for each patch for each 4 seconds (6 patches: about 3ms a frame on the raster threads). A map therefore draws at most six patches (`MAX_RAIN_PATCHES`).

**Motion.** Only `transform` and `opacity` change. Under `prefers-reduced-motion: reduce` there is no falling and no fade: the wash and the drops are drawn still, so the meaning is not lost, and the chip arrives without its rise.

## Iconography, Imagery and Logo

**Icons.** Every icon is an inline SVG path from one table in `frontend/src/components/ui/AppIcon.vue` (about 60 names). No icon package or icon font is installed. Icons are drawn on a 16px grid as outlines in `currentColor`, with round caps and joins and a 1.5 stroke unless the icon sets its own (1.75 or 2). `star` and `more` are filled. Tab-bar icons use a 24px grid. An icon is hidden from screen readers unless it is given a `label`. Category icons go through `CategoryIcon`, which adds the pale circle and the category's name.

**Illustrations.** `IllustrationBlob` holds four line drawings (friends and a pin, a name card, a paper plane, a flag), used by `EmptyState` and `InviteView`.

**Place photos.** `frontend/src/lib/placeImages.js` returns one photo per kind of place, not a photo of the venue. The 13 files are in `frontend/src/assets/places/`, with photographers and sources in `CREDITS.md` there (Unsplash). `PlaceDetail` captions the photo "Illustrative photo" in a dark translucent pill at its bottom right. `PlaceCard`, `SuggestionCard` and `StopCard` show the same photos with empty `alt` text and no caption.

**Session photos.** Shown as prints on `PolaroidLine` (cream paper, a handwritten note, wooden pegs) and full-screen in `PhotoViewer`. Photos use `object-fit: cover`. The plain grey `.photo` plate stands in where there is no picture.

**The logo.** `JioLogo` draws "Jio" in rounded strokes with a crown in place of the dot of the i, traced from `frontend/src/assets/brand/jio-logo.png`. It takes `currentColor`, which is `--brand-logo` by default. Variants in use: pink on white at 30px tall in the top bar (`TabBar`), and white on red at 38px tall inside `PinButton`. The favicon (`frontend/public/favicon.svg`) is the white logo on a `#f93d64` square with rounded corners (`rx="190"` in an 850 box). `frontend/index.html` sets `theme-color` to `#f93d64`. The code implies no clear-space rule: the only spacing around the logo is the top bar's `margin-right` of 32px (8px on tablets).

**The coin.** `CoinBadge` is a 32-unit SVG: a `#f7365e` disc, a lighter ring, a highlight and a cream crown. It scales with the text at 1.1em.

## Voice and Copy

These are the conventions the screens use, with examples quoted from the views.

- **Estimates say "about".** "about {{ option.walk }} min walk" (`SuggestionCard`), "about 25 min" (`MemberList`), "Long trip home: {{ trip.name }}, about {{ trip.minutes }} min" (`EventView`), "about {{ place.mrtWalk }} min walk from {{ place.mrt }} MRT" (`PlaceDetail`).
- **Invented content says "sample".** "Sample data for the demo" (`SampleNote`), "Sample reviews" (`PlaceDetail`), "Spend your [coin] on sample café vouchers." (`RewardsView`).
- **Buttons are a verb or a verb and a noun, in sentence case.** "Start session", "Invite friends", "Vote on places", "Confirm plan", "Claim voucher", "Show more", "Retry", "Try again".
- **A button that moves on names where it goes.** "Next", "Itinerary", "Done" (all `next` buttons).
- **Dialog titles are questions, and the choices answer them.** "Confirm plan?" with "Confirm" and "Not yet"; "End plan?" with "End plan" and "Not yet"; "Delete this photo?" with "Keep photo" and "Delete photo"; "Erase everything and sign out?" with "Stay signed in" and "Erase and sign out".
- **Empty states are a short title and at most one sentence.** "No photos yet" with "Add the first one with the camera button."; "No places match" with a "Clear all" button; "No one ranked yet".
- **Failed loads say what failed and offer a retry.** "Could not load places" with "Check your connection and try again."; "Could not load your meetups · Retry".
- **Screen titles are nouns.** "Leaderboard", "Rewards", "Sessions", "Create session". Sign-up asks one thing per screen: "Your email", "Create a password", "Pick a username".
- **A middle dot joins facts on one line.** "15:00 · 45 min" (`StopCard`), "Could not load your meetups · Retry" (`LandingView`).
- **Times are 24-hour.** "15:00", "Starts in 50 min", "Tomorrow, 15:00", "Live now", "Ended" (`CountdownChip`).
- **Prices are tiers.** `$`, `$$`, `$$$` (`PriceTier`).
- **No rank is said in words.** "No rank yet", shown as "–" in the list.
- **The currency is "JioCoins"** in text (`lib/currency.js`: "1 JioCoin", "1,250 JioCoins") and the coin elsewhere. One banner in `EventView` still says "points": "Completed · +{{ POINTS_PER_MEETUP }} points each to spend on sample café vouchers".
- **Two nouns are used for the same thing.** Home says "meetup" ("Your meetups", "Open meetup", "Start a meetup"); the session screens and the navigation say "session" ("Create session", "Sessions", "Start session").
- **The Home greeting** is "Hi, {name}", and the pin reads "Jio your friends".

No template contains an exclamation mark, an emoji or an upper-case label.

## Accessibility

- **Focus.** `:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }` applies to every control (`app.css`). Components that draw their own keep the 2px ink line: `ChipButton` puts it on the pill, not the larger tap area; `PinButton` turns the pin's white stroke to a 4px ink stroke; `HeroButton` and `RadialTimePicker` use rings made with `box-shadow`; `TextField` and `SelectField` thicken the border to 2px ink.
- **The focus trap.** `useFocusTrap(open, panel, { restoreOnUnmount })` in `frontend/src/lib/useFocusTrap.js` moves focus into a panel when it opens, keeps Tab and Shift+Tab inside it, and returns focus to the control that opened it. A composable is a function that a Vue component calls to share behaviour. It is used by `BottomSheet`, `ModalDialog`, `PopoverPanel` and `PlaceDetail`. `PhotoViewer` keeps focus inside itself with its own code. Each of the five closes on Escape.
- **Dialog roles.** `BottomSheet`, `ModalDialog` and `PlaceDetail` have `role="dialog"`, `aria-modal="true"` and `aria-labelledby`. `PopoverPanel` has `role="dialog"` without `aria-modal`. A `ModalDialog` given `text` also has `aria-describedby` pointing at that text, so the sentence is read after the title.
- **Announcements.** An error `BannerNote` is `role="alert"`, the other tones `role="status"`; an error that is a standing state of the screen, not an answer to something just done ("Session cancelled", "Not enough people" in `SessionNotices`), passes `role="status"` so it is not read out as an alert each time the screen loads. `ToastMessage` keeps its `role="status"` region on the page, so the first toast is heard. Placeholder rows are hidden from screen readers; the planner says "Finding places" in a hidden status line instead, as Roam does. Map pins for places are named with their stop number and category ("Stop 1, Eat: Maxwell Food Centre").
- **Labels.** `IconButton` requires `label` and sets it as both `aria-label` and `title`. `TextField` and `SelectField` require `label` and tie hints and errors to the input with `aria-describedby`; errors have `role="alert"`. Tabs carry `aria-current="page"`. `ChipButton` sets `aria-pressed`, or `role="radio"` with `aria-checked` when it is one choice in a set of chips (`radio`). A Vote chip is a toggle (`aria-pressed`, named "Vote for {place}" in either state), because it sits in a card among other buttons. `ToggleSwitch` has `role="switch"`. `ProgressBar` and `SegmentedProgress` have `role="progressbar"`. `CoinBadge` reads as "500 JioCoins". Decoration (`SingaporeMap`, `GridPulse`, the enter-game cover, confetti) is hidden with `aria-hidden`.
- **Keyboard.** A set of radio chips or poll bars is one Tab stop (a row of chips only, never a group of cards: a `radiogroup` around cards that hold other controls would leave all but one Vote chip out of the Tab order, so a slot's options are a labelled `role="group"` and every Vote chip is a Tab stop of its own): `v-radio-group` (`frontend/src/lib/radioGroup.js`) on the `radiogroup` moves between its choices with the arrow keys, Home and End, skipping disabled ones. Filters choose as focus moves; vote sets (`{ follow: false }`) only move focus, and Space or Enter votes. A disabled `ChipButton` is `aria-disabled`, not `disabled`, so it keeps focus while a request runs, and a chosen one keeps its fill. `SortableList` moves an item with the arrow keys from its handle. `HoldButton` works with Space or Enter held, and with a single activation from assistive technology. `CalendarPicker` moves between days with the arrow keys. Map pins in `PlannerMap` take focus and select on Enter. `MeetupGraph` is one focusable element that reads out the day the arrow keys land on. `AuthView` moves focus to each new question's heading.
- **Target size.** `--tap-min` is 44px. Shapes that look smaller reach it by padding: a 32px chip in a 44px button, a 28px switch with a pseudo-element that extends it. The exceptions are under Known Conflicts.
- **Touch.** Links and buttons have `-webkit-tap-highlight-color: transparent` and `touch-action: manipulation`. Hover styles sit inside `@media (hover: hover)`, and nothing is revealed by hover alone: the next button is filled from the start on touch screens, and `RadialTimePicker` opens on tap.
- **Reduced motion.** See Motion: one global rule, plus a check in every script that animates except the `HoldButton` fill.
- **Language.** `frontend/index.html` sets `lang="en"`.

## Changes since this was recorded

On 10 Oct 2026, after this document was written from commit `65567bb`, nine defects from the audit of that pull request were fixed. The tables above describe the fixed code. What changed, in one place:

- `HoldButton` also answers a single activation from assistive technology.
- `CalendarPicker` days are 44px tall with arrow-key movement and one tab stop; today carries `aria-current="date"`.
- `LeaderboardPodium` reads 1 · 2 · 3; rank labels are real text for screen readers.
- At 480px and below, `LeaderboardRankings` puts the amount under the name, and `LeaderboardCard` wraps its season picker under the title.
- `LeaderboardView` keeps the season picker mounted while a past season loads, and shows an error with "Try again" if it fails.
- `SessionNotices` shows a "votes were cleared" banner while voting.
- `GroupDetailView` has a "Waiting for N people" card; the host can continue without someone (in a shared session: remove them), behind a confirmation dialog.
- An account made through the sign-up form starts with no meetups, JioCoins or rank. Only the one-click demo account (`demo: true`) carries the sample history.

No token, colour or copy rule changed.

### Home, since 10 Oct 2026 (branch `feat/home-meetups-map`)

Home now shows every current meetup, where before it showed one. Where a sentence elsewhere in this document describes Home as a single `PinButton` on the meeting point with `SessionCard`s below, that is now the layout only when no meetup is going. With one or more going:

| Piece | File | What it is |
|---|---|---|
| Pins | `components/home/MeetupPins.vue` | One real `<button>` per meetup that has a meeting area, laid over `SingaporeMap` at that area. 50 by 64px, the day in its head. The selected pin is larger, filled red with a white head, and bobs. Pins on the same area fan out sideways by 46px. Props: `pins`, `selectedId`, `meetups`, `myId`, `names`. |
| Pin card | inside `MeetupPins.vue` | A 264px card anchored to a pin, over the map. It opens on hover after 120ms, on keyboard focus, or on a tap, and closes 150ms after the pointer leaves both pin and card, or on Escape. No backdrop and no focus trap. Hovering does not select. |
| Summary | `components/home/MeetupSummary.vue` | The content shared by the pin card and the card under the map: status, countdown, title, date line, where it stands, who is in, the next step, "Open meetup". `compact` for the pin card. |
| Detail card | `components/home/MeetupDetail.vue` | The selected meetup, in a card under the map. From 744px it sits beside the list. |
| List | `components/home/MeetupList.vue` | "Your meetups": every current meetup, soonest first, each row a button that selects it. Shown with two or more. A meetup without a meeting point has a dashed day badge and no pin. |
| Next step | `components/home/NextStepChip.vue` | The one thing a meetup needs from the signed-in person. |
| Logic | `lib/homeMeetups.js` | Ordering, the next step, pin positions, selection, and where the pin card sits. No DOM. |

- **Selection** lives in the page address as `?meetup=<id>`. The soonest meetup is selected by default. A pin and its row do the same thing.
- **"Jio your friends"** was a secondary button on the map's corner whenever a meetup is going. It is now the first row of the list (see "The start row, 11 Oct 2026" below).
- **"Places near {area}"** follows the selected meetup.
- **Motion added**, all off under reduced motion: the selected pin's bob (2.8s, endless, that pin only); pin scale on select (200ms, `--ease-spring`); routes redrawing toward the selected meetup's area (0.7s, `SingaporeMap`'s new `quick` prop); the detail card's cross-fade (120ms out, 200ms in); the pin card's fade and 5px rise (160ms in, 100ms out).
- **Stacking:** the pin layer is at 5 and an open pin card at 6 within it; the top bar and tab bar at 20 stay above.
- **No new colour and no white text on `--primary`.** The day in a selected pin's head is ink on white. "Open meetup" is a secondary button for the same reason, and so is the start row's plus (red on a tint, not white on red).
- **Not changed:** with no meetup going, Home is the same as before, checked box for box against `main`.

### The start row, 11 Oct 2026 (branch `feat/demo-showcase`)

The action that starts another meetup moved from a small white pill in the map's bottom-right corner to the first row of the meetups list. The pill read as a map control, looked secondary though it is the page's main action, and could sit near pins. With no meetup going Home is unchanged: the red `PinButton` stays in the middle of the map.

| Piece | File | What it is |
|---|---|---|
| Row | `components/home/StartMeetupRow.vue` | A real link (`<a href="/sessions/new">`), so it opens in a new tab. The box of a meetup row: 12px 16px padding, 1px border, `--rounded-md`, a 44px round badge, a 12px gap. A plus where a meetup row has its day, "Plan a new meetup" (`title-md`) over "Jio your friends" (`body-sm`, muted). Two lines, so about 70px tall where a meetup row is about 98px; width, padding, radius and badge match. |
| List | `components/home/MeetupList.vue` | New prop `startHref` and event `start`. With `startHref` the row is the first `<li>`. With no meetups and a `startHref` the list is that row alone, which is how Home shows it with one meetup going (under the card, 480px wide from 744px like the card). |

- **Treatment.** A 1px outline of the brand red at 35% on white, a badge tinted with the brand red at 11%, and a red plus on it. These are the in-place tints already used by `TabBar` (11%) and `HoldButton` (35% border). Hover (devices that hover) sets the border to `--primary` and the fill to `--surface-soft`. No new colour, no shadow, no red fill. Every word is ink or muted.
- **Contrast.** The plus is an icon, red on the 11% tint, 3.04:1, which meets the 3:1 for icons and is the same pair as the current tab's icon in Known Conflicts item 3. No white text sits on red.
- **Not a meetup.** It is never selected, has no `aria-pressed` and never changes `?meetup=`. A tab order of pins, the card's buttons, the start row, the first meetup row was measured.
- **Motion.** A plain click still plays `enterGame`, now from the centre of the plus (the element marked `data-burst`) instead of the old pill. A click with a modifier key opens a new tab as a link does. Under reduced motion `enterGame` navigates at once and the row's colour transition is off.
- **Removed.** `.hero__start` and its button in `LandingView`.

### Four fixes from use, 10 Oct 2026

- **The greeting.** `.hello__name` in `LandingView` is painted through `background-clip: text`, which only shows inside the element's own box, so letters hanging below the line (g, j, p, y) and the last letter's right edge were cut. It now carries padding (`0.12em 0.1em 0.22em 0.06em`) with a matching negative margin and `background-origin: content-box`. Rule for any new gradient-filled text: give it padding for its descenders and its last letter.
- **Time pickers.** `RadialTimePicker`'s ring reaches 141px above and below its pill. `CreateEventView` now keeps 72px between the two pickers and under the End picker, and a ring opened by a tap scrolls clear of a sticky footer by 12px. Rule: leave a ring's reach free of other controls.
- **Editing a session.** `CreateEventView` also serves `/sessions/:id/edit` ("Edit session"), for the host while the session is still inviting. The invite step's back arrow ("Back to date and times") and the steps bar's Create step lead there. Once the session has started, the page says the date and times are locked.
- **The steps bar.** `SessionSteps` now sits directly under the back row and before the title on every session screen, including the invite and edit steps, so it is at the same height on all of them at a given width. It has its own view-transition name, `session-steps`, so it neither fades nor drifts while the page behind it changes, and keyboard focus stays on the step that was pressed. `SessionHeader`'s order is now: back arrow, `SessionSteps`, title, date.
- **Titles.** The full-size meetup card on Home wraps a long title; the pin card and the list rows keep their ellipsis and carry the full title as a tooltip.

### Meeting spots, since 11 Oct 2026 (branch `feat/meeting-spots-integration`)

While a session is `locating`, the group now chooses where to meet from a list of spots, instead of being handed one meeting area. The app lists its three fairest areas and each member may suggest one of their own; anyone says "Works for me" on any number of them; the host confirms one at any time. Everything is an area, never a member's exact place. The new files are in `components/spots/`, and `GroupDetailView` composes them.

| Piece | File | What it is for |
|---|---|---|
| Spot list | `components/spots/SpotList.vue` | The section "Where to meet" (`display-sm`): a line of guidance, "Suggest a spot" (secondary, small), for the host "We already have a place" (tertiary), the rows, and the travel-time colour key. Does all writing as the signed-in person through the events store. |
| Spot row | `components/spots/SpotRow.vue` | One spot as a flat card (hairline, `--rounded-md`; the selected one has a 2px ink outline and gives back the pixel in its padding, so nothing moves). Head button: a number badge, the area name, "Suggested by Jio / you / {name}", and a `Leading` or `Fairest` `InfoTag` (tone `strong`). Then "We are here already" (pin icon) if its suggester said so, the longest trip and average, each person's minutes in their travel colour, the "Works for me" `ChipButton` with an `AvatarStack` and "Works for N people" (or "No one yet"), and on your own suggestion a "We are here already" chip and "Withdraw". |
| Spot pins | `components/spots/SpotPins.vue` | One real `<button>` per spot, laid over `PlannerMap`, with the same number as its row. Same look, size (50 by 64px), selection (larger, red, white head with an ink number, bobbing), card (264px, caret toward the pin) and timings as Home's `MeetupPins`; see below. |
| Confirm bar | `components/spots/SpotConfirm.vue` | The screen's one main action, in the footer. The host sees `AppButton next block` reading "Confirm {area}" (an ellipsis cuts a long name). Anyone else sees a clock and "Waiting for {host} to confirm". |
| Known place | `components/spots/KnownPlaceField.vue`, `knownPlaceChoice.js` | On the create screen: "Already know where to meet?" with "We already have a place", then the area, "Change place" and "Remove". The choice waits in session storage until the session starts (a known place needs two people), then the host goes straight to choosing places. |
| Words | `components/spots/spotText.js` | The copy and small decisions behind the above, with no screen: `timeText`, `tripsLine`, `peopleTrips`, `byLine`, `worksForText`, `canSuggest`, `canApprove`, `shownSpotId`, `pinName`, `unpricedSuggestion`. The list, the pins' cards and the pins' accessible names all read them, so they cannot disagree. |

**States.** Each is a state of `SpotList`, and the footer follows the same session.
- *Loading:* while the planner works the spots out, three `SkeletonRow`s with `role="status"` and "Working out where to meet" (no list yet), or the list at 60% opacity with `aria-busy="true"` and "Updating travel times…" (there is a list). The "Finding the meeting point" bar still shows once everyone has a start; "Confirm" reads "Finding the meeting point…" and is disabled while it runs. *Confirming:* while the host's confirm runs ("Confirm {area}" in the footer, "Meet at {area}" in the known-place dialog, or the meeting area) both buttons read "Confirming…" and set `aria-busy="true"`, from one flag in the events store (`confirming`), so the two never overlap and the list's other controls ignore presses meanwhile; a polite status line on the page says "Confirming the meeting spot…", and once it has taken 600 ms a spinner (`MapLoading`) covers the map pane. The words are on the buttons because the map pane is hidden in the list view, where phones and tablets start; the spinner is for the map view and the desktop's side-by-side.
- *Empty:* fewer than two starts. A dashed card, "No spots yet", "Spots open once two people have shared where they start. So far, N of M have." "Suggest a spot" is not offered; the host still sees "We already have a place".
- *Error:* a refusal or a planner failure goes up to the screen's own `role="alert"` line under "Your locations" (`error` event) as a sentence. The data layer has already taken back that write's own change, so nothing is half-saved.
- *Disabled:* `SpotRow` disables "Works for me" when the group is no longer choosing (`canApprove` false); `GroupDetailView` also drops the list and the pins from the page once the status is `voting`. "Confirm" is disabled when no spot is selected or while the meeting point is being found. A control that is saving is **not** disabled (see Keyboard).
- *A suggestion with no row:* if a reload caught your suggestion before the planner priced it, a dashed card says "{Area} has no travel times yet. Your suggestion was saved but not worked out. Try again, or take it back." with "Try again" and "Withdraw". Nobody is left holding a suggestion they cannot withdraw.
- *Long and short content:* names wrap (`overflow-wrap: anywhere`); a person's name in a trip is cut at 14 characters; a spot with no trips yet says "No trips to compare yet. They appear as people share where they start."; a spot nobody has to travel to says "Nobody has to travel".
- *Mobile and desktop:* inside `SplitView`, as for the meeting area before: the list and the map one at a time under 744px with the List / Map switch, side by side from there. The pins' layer fills the map's box and is placed again on every `view` event.

**Copy.** Sentence case. Guidance for the host: "Pick a spot and confirm it when you are ready. You do not need to wait for anyone." For a member: "Say which spots work for you. {Host} confirms the final spot." Dialog (host's known place): "Meet at {Area}?", "This replaces the list of spots and takes the group on to choosing places. Everyone can still add where they start.", "Not yet" first, then "Meet at {Area}". Travel times say "about" whenever they are estimates: when the planner flags a route as approximate, or when the answer's `travel.source` is `estimate` (no OneMap account on the server, so every time is straight-line). Rows, the pins' cards and accessible names, Home's card and `MemberList` all read the same flag.

**How the list and the pins stay in step.** One selected area (`shown` in `GroupDetailView`): the area the person picked, otherwise the one most people said works (`preselectedAreaId`), otherwise the first. A row's head button and a pin both set it; the row is outlined and the pin is red and bobbing. The row's number is the pin's number. The map keeps every spot in view through `PlannerMap`'s `keep` prop; `SpotPins` asks the map where each area is (`project(lat, lng)` through the component's ref) and places itself again on `view`. With no approvals the spot offered first is the planner's own pick (the first of the list); with approvals, the most approved, then the shortest longest trip before rounding, then the list's order.

**`PlannerMap`, since this branch.** `keep` is a list of extra `{ lat, lng }` points the view must also show, for something drawn over the map. The `view` event fires whenever the map moves or resizes. `project(lat, lng)` (exposed) gives a point in px from the map's top-left. On leaving, the map stops moving, lets go of its listener and is removed 300ms later (`map/retireMap.js`), because Leaflet ends a zoom with a 250ms timer it cannot cancel; removing the map earlier made that timer throw `Cannot read properties of undefined (reading '_leaflet_pos')` on any page left within a quarter of a second of its map fitting its view. This is fixed for every screen with a map.

**Reused from `MeetupPins`.** The pin shape and its states (at rest: white with an ink line and a pale head; selected: `--primary` with a white head, scaled 1.2 and bobbing 2.8s, its shadow shrinking; hover lifts an unselected pin 3px); the pin card (hover for 120ms, keyboard focus on the pin but not a mouse click, a tap; closes 150ms after leaving pin and card, on Escape, or on a tap elsewhere; no backdrop, no focus trap; the pin is `aria-describedby` the card while it is open); `placeCard` from `lib/homeMeetups.js` for where the card sits; the stacking (pin layer 5, an open card 6 within it); and the same reduced-motion paths. What differs: the pins sit on a Leaflet map and are placed by its projection rather than `SingaporeMap`'s; a card shows the spot's name, who suggested it, the longest trip and who it works for; and a click selects without leaving the page.

**Keyboard.** Tab order is the page's order: each row's head button, then its "Works for me", then on your own suggestion "We are here already" and "Withdraw"; the pins follow the list's controls, in the map. A control that is operated never loses focus. "Works for me", "We are here already", "Withdraw", "Suggest a spot", "We already have a place", "Meet at {Area}" and "Confirm {area}" are **not** disabled while their change is saved: they set `aria-busy="true"` and the handler ignores a second press until the first is saved, so the focus stays where it was and Enter or Space again toggles the chip back. ("Suggest a spot" does not open its picker while a change is saving, so a pick is never thrown away.) A pin's card opens on keyboard focus and Escape closes it and keeps focus on the pin; Enter or Space on a pin selects it.

**Home, for the same session.** While the group is choosing, Home names the spot that leads ("Bugis is leading · about 25 min for you") or, while nothing leads, how many there are ("3 spots to choose from"), not the planner's fairest area and not "No meeting point yet". The list row says the leading spot or "choosing a spot". The next-step chips are "Confirm the spot" for the host, "Pick your spots" for a member who has marked none and "Waiting for the host" after; they are short on purpose, because every chip on Home is a pill (`InfoTag`'s `--rounded-full`, no wrapping). Do not give one chip a different shape; shorten the label.

**No new colour and no white text on `--primary`.** The selected pin's head is white with an ink number; the number badge on a selected row is ink with `--on-selected`; the tags are ink-outlined `InfoTag`s; "Confirm" is the `next` button, which shows white on red only as the existing pattern does (Known Conflicts item 1).

### Session screens after team testing, 11 Oct 2026 (branch `feat/meeting-spots-integration`)

Eight changes the team asked for after using the app together. Where this section and an earlier one disagree, this one is the code. Nothing here adds a colour, a token or a component; no white text was added on `--primary`.

| Change | What it is now | Where |
|---|---|---|
| Calling an outing off | The header's hold button reads "Hold to cancel" (spoken: "Hold to cancel (Cancel outing)"). Its dialog is "Cancel outing?", with "Keep outing" first and the danger button "Cancel outing". The "not enough people" notice's button and dialog use the same words. The status pill still says "Cancelled", and the banner "Session cancelled" is unchanged. It still cancels: the outing becomes Cancelled and nobody earns anything. | `CANCEL_OUTING` in `lib/session.js`; `SessionHeader`, `SessionNotices` |
| The itinerary's main button | Before the session's day: "Save plan", a link Home. It saves nothing, because the plan was saved when it was confirmed, and it says nothing else. On the day: "Finish outing" (was "End plan"), dialog "Finish outing?", confirm "Finish outing", cancel "Not yet", with the coins line kept. Voting, completed and cancelled sessions show neither. Not host-only: the data layer lets any member finish, and the screen follows. | `itineraryAction` in `lib/session.js`; `EventView` |
| "We already have a place" | Gone from the create screen, with `KnownPlaceField.vue`, `knownPlaceChoice.js` (session storage), the lobby notice and the jump to Vote on Start. It is on the Locate step only, in `SpotList`, for the host. **This replaces the "Known place" row of the table above.** | `CreateEventView`, `GroupDetailView`, `SpotList` |
| The steps bar is navigation | Every step the session has reached links to its own page: Create `/edit` (host only), Invite `/invite`, Locate the session page, Vote `/plan`, Itinerary `/itinerary`. Invite no longer shares Locate's address. A step that is the page just behind this one in the browser's history goes Back instead of adding an entry (`lib/stepNav.js`); Create and Invite replace each other, as before. The bar's vertical place, its view-transition name and focus on the pressed step are unchanged. | `SessionSteps` (`stepsFor`, `backFor`) |
| The back arrow | Goes to the previous step the session has reached: Itinerary to Vote, Vote to Locate, Locate to Invite, Invite to Create (host; a guest goes Home), Create to Home. Photos and the full map go to the Itinerary. The label names the place ("Back to Vote", "Back to date and times", "Back to Home"). `SessionHeader`'s `back` prop now defaults to `''`, meaning "follow the steps"; no screen sets it. | `backFor`; `SessionHeader`, `CreateEventView`, `InviteView` |
| Invite after the start | The invite page opens at any status. The host can invite while inviting, locating and voting (what the header's Invite button already allowed) and when a confirmed plan has fewer than two people left (the notice links there). Otherwise the page is titled "Who is in", lists the people, and says why: "The plan is confirmed, so invites are closed.", "The outing is over, so invites are closed.", "The outing was cancelled, so invites are closed.", or for a guest "Only {host} can invite people." No picker and no Send button. `InviteView` no longer assumes the signed-in person is the host. | `inviteAccess` in `lib/session.js`; `InviteView` |
| Confirming stays on Locate | Confirming a spot or naming a known place no longer takes the person to Vote. The page keeps its layout: the map with the spots' pins and the list. Once the group has moved on (`voting`, `confirmed`, `completed`), the confirmed spot is first, tagged "Confirmed" (an ink-outlined `InfoTag`, in place of Leading or Fairest) and selected, under the line "{Area} is confirmed as the meeting spot."; its pin says so in its card and its name. The other spots stay, without "Works for me", "We are here already", Withdraw, "Suggest a spot", "We already have a place" or the confirm button; who said a spot works stays as words. A known place is the single row. The footer's button is "Next" (to Vote) at every status after confirming, for host and guest. A live region says "{Area} is confirmed. Press Next to choose places." and focus moves to "Next". A session called off before it was confirmed lists its spots the same way with no "Confirmed" mark and no footer. The big meeting-area card and the result line ("Fairest for N people: nobody travels more than about XX minutes") are gone from this screen; `meetingResultLine` stays in `lib/planner/meetingArea.js` and `summary().resultLine` in `lib/api.js`, which tests read, but no screen shows it. | `spotText.js` (`spotsToShow`, `confirmedAreaId`, `shownFor`, `confirmedLine`), `SpotList`, `SpotRow` (`readonly`, `confirmed`), `SpotPins` (`confirmedId`), `GroupDetailView` |
| Locate with fewer than two starts | No "No spots yet" card. The page shows the people, the "Waiting for N people" card and the map. The host still sees "Where to meet" with "We already have a place"; a member sees no spots section at all. | `SpotList` |
| The map key | The voting page's map has `CategoryKey` for the categories of the places on it, as the itinerary's map does. | `PlannerView` |
| People on the itinerary's maps | The itinerary's map and the full-screen map no longer draw each person's start. The places, the route and the meeting area stay. | `EventView`, `SessionMapView` |

Words in earlier sections that this replaces: "Hold to end" and "End session" (Components, `HoldButton` and `SessionHeader` rows; the hold button's example in `HoldButton.vue`), the dialog "End plan?" with "End plan" (Voice and Copy), "Vote on places", "Itinerary" and "Today's plan" as the session page's footer (Locate's footer is now "Next"), the Create step "Invite and Locate are both the people page" (SessionSteps comments), and the Known place row above.

### Roam ("What next?"), 11 Oct 2026 (branch `feat/roam-in-meetup`)

The first screens for Roam, inside a meetup that is under way (a confirmed plan on its day: `roamOpen` in `lib/session.js`, the same moment the footer says "Finish outing"). Nothing here adds a colour or a token, and no white text was added on `--primary`.

| Piece | File | What it is for |
|---|---|---|
| Roam page | `views/RoamView.vue`, route `/sessions/:id/roam` | `SessionHeader` titled "What next?" (the session's title moves to the line under it), a centre line ("Near Bishan", or "Near you, in Toa Payoh" when using a position), a small secondary "Use my location" button with "Back to {meeting area}" beside it once the centre has moved, kind chips (`ChipButton` radio group: All, Eat, Drink, Shop, Activity), and the places in `.grid-3`. No map and no vote: it is a list. |
| Place card | `event/SuggestionCard.vue` | The voting page's card, reused. New: the `meta` prop replaces the walking line ("about 4 min away · 250 m") and the `foot` slot replaces the vote row. Defaults are unchanged. Its foot on this page is a tag and one button (below). |
| Proposed stops | `event/ProposedStops.vue` | Under the itinerary's timeline: "Proposed stops", one dashed-outline card per proposal (a dashed hairline says it is not a stop yet; no number, time or rail), with the place, an `InfoTag` "Proposed by Faith", and for the host "Add to plan" (secondary, small) and "Not now" (tertiary, small). A guest sees "Waiting for {host} to decide", and "Take back" on their own. |
| Words and rules | `lib/roam.js` | Limits (`ROAM`: 3 waiting per member, 10 per session, 8 stops, 60 minutes), `placeAction`, `proposedRows`, `centreLine`, `travelLine`, `closedText`, `ROAM_WORDS`. Screens and tests read them. |

**Where "What next?" sits on the itinerary.** A secondary `AppButton` with the sparkle icon directly under the stops (and the proposed stops), before "Trips home". It is for every member. The footer's "Finish outing" stays the page's one main action; a second filled or `next` button would break the one-main-action rule, and a button at the end of the stops is where the next stop would go. It shows only while the plan is under way.

**The card's foot.** A place nobody has proposed: "Propose" (secondary, small, 44px; off, with the reason in a line above the list, when the person has 3 waiting, the session has 10 or the plan has 8 stops). Proposed by you: tag "Proposed by you" and "Take back" (tertiary). Proposed by someone else: tag "Proposed by Faith", nothing to press. Already in the plan: tag "In the plan". The same button element keeps keyboard focus when "Propose" becomes "Take back". A press sets `aria-busy` and a second press is ignored; the buttons are not disabled while saving. A rain warning shows as the card's existing "Outdoor, rain expected" tag.

**States.** *Loading:* three `SkeletonRow`s, and a live region "Finding places near {area}". *Empty:* "Nothing nearby fits" / "Try another kind of place." (with "Show all kinds" when a chip is on). *Planner unreachable:* `EmptyState` with `role="alert"`, "Could not load places", the client's sentence and "Retry". *Not open yet or over:* "What next? opens on the day of the outing." (also "opens once the plan is confirmed", "This outing is over.", "This outing was cancelled.") with "Back to the session". *Refused action:* the data layer's sentence in a `role="alert"` line; nothing is half-saved.

**"Use my location".** The browser is asked only when the button is pressed. The position goes to the planner for that request and is held in the page's memory for the next requests of that visit only: it is never saved, put in the address, or shown. The page says "The group sees the area's name, never where you are." If the browser refuses ("Location access is off."), has no position ("Your location is not available right now."), cannot share one, or the person is outside Singapore ("Your location is outside Singapore."), a sentence says so, followed by "Pick an area instead.", and `LocationSheet` (`which="spot"`, titled "Pick an area") opens. A picked area centres the list at the area's own point ("Near Kovan").

**The steps bar.** `/roam` belongs to the Itinerary step like photos and the full map (`ITINERARY_PAGES` in `SessionSteps`): Itinerary is lit and the back arrow reads "Back to Itinerary". The bar is at the same height on the itinerary and on Roam (64px at 375px wide, 84px at 1280px).

**Home.** A confirmed meetup with a proposal waiting shows the host the chip "Review a proposal" (tone `action`, linking to the itinerary). Everyone else, and every other state, shows what it showed before; a pending re-plan still wins.

**Timing.** The list is searched for the time the next stop would start: when the last stop ends, or now if that has passed. An accepted stop follows the last stop like any other, so the itinerary adds the leg between them (the first stop of the new plan began 16:30, the last ended 21:21, the added stop starts 21:29). Distances and times come from the planner's estimate and say "about"; a place next door says "about 1 min".

**Demo tools.** "What next?" in the demo panel has "A friend proposes a place" (`components/dev/roamDemo.js`): the friend with the fewest places waiting proposes the best free place on the list, so the host's side can be shown alone. Development only; it is not in the production bundle.

### The demo tour strip and `/demo`, 11 Oct 2026 (branch `feat/demo-tour`)

A guided demo for the lead and the graders: one link, one outing told in ten checkpoints, and a strip to move between them. It is **not in a production build unless it was built with `VITE_DEMO_TOUR=1`**, which also needs `VITE_ALLOW_LOCAL_ACCOUNTS=1` (a build with the first and not the second refuses to start, with a console line). Development builds always have it. Without the flag the strip, the route, the story and the stand-in planner are not in the bundle, and `/demo` is the "not found" page. Nothing here adds a colour, a token or a component; no white text was added on `--primary`.

| Piece | What it is | Where |
|---|---|---|
| The strip | A band at the top of every screen that has navigation, while the tour is on. Surface Soft with a hairline under it, in the page's flow (not fixed, not sticky), so it covers neither the top bar, the steps bar, a footer's button nor the phone's tab bar; it only moves the page down. Row of controls: back and next (`IconButton`, 44px), and the checkpoints. A caption above ("Demo tour. Sample data."; "Sample data. Places and times are rough." once the stand-in planner has answered or made the saves) and one line below that says what to look at. Both lines have fixed room (the line below is two lines on a phone, one from 744px), so the band is the same height at every checkpoint (125px under 744px, 111px from it) and the steps bar below never moves (measured at 320, 375 and 1280px: 189px, 189px and 195px from the top on all of them). It keeps its own view-transition name, like the tab bar and the steps bar, so it stays put while screens cross-fade. | `tour/TourStrip.vue`; drawn by `App.vue` inside `.app__main`, before the `RouterView` |
| Ten checkpoints | Just created, Invites out, Choosing how to meet, A place already known (the two ways of the Start choice), Sharing locations, Choosing the spot, Voting on places, Plan confirmed, On the day, Finished with photos. From 744px: ten numbered circles with the current one's name spelled out in an ink-outlined pill, then Restart and Leave tour. Under 744px: "3 of 10" over the name, between the arrows; pressing it opens the list of ten as rows (with Restart and Leave tour under them), and a choice closes it and puts focus back on the button. Both layouts are one set of buttons, switched in CSS. | `tour/story.js` (`CHECKPOINTS`) |
| Keyboard and screen readers | Every control is a real button or link with a name ("Previous checkpoint", "Next checkpoint", "Restart the tour", "Leave tour", and each checkpoint reads "4 Choosing the spot"). The current one has `aria-current="step"`. The line below is a `role="status"` that starts with "Checkpoint 4 of 8, Choosing the spot." for screen readers, so a change is announced. Left, right, up and down arrows, Home and End move between checkpoints; Tab works as well; Escape closes the phone list. The focus ring is the global one. Reduced motion: the strip scrolls the current checkpoint into view without gliding when asked for less motion, and the global rule covers the rest. | `TourStrip.vue` |
| `/demo` | Public, no navigation. Nobody signed in: makes the demo account, loads the tour with progress in words ("Loading the outing: 4 of 11 sessions") and a `ProgressBar`, and opens Home with the outing selected. The demo account signed in: "Restart the tour" or "Carry on" (when there is a tour). Any other account: touches nothing and says to sign out first. A failure part way says which sessions were and were not loaded and offers "Try again". | `tour/DemoView.vue`; `router/routes.js` |
| What Home shows | The ten saves are ten sessions in the data layer, so Home, Sessions and the Profile screen's list read the sessions through `visibleSessions()` (`lib/sessionFilter.js`), which hands them back unchanged unless the tour installed a filter. The filter hides the nine saves that are not the selected checkpoint's; the side cases and anything made after stay. After "Leave tour" the same filter stays (the strip and the stand-in go), so ten copies of one outing never appear; "Restart" in `/demo` loads everything again. | `lib/sessionFilter.js`; `tour/store.js` |
| The story | One outing, "Catch-up makan with the gang": Ian hosts, with Darius, Nicole and Faith, starting from Toa Payoh, Tampines, Jurong East and Bugis. The first six saves are three days before the outing and the last two are the day itself, so "On the day" is today and "Finished with photos" is the same plan completed. All eight use the times of a session that is on today. Side cases: a session a friend hosts, one where a friend opted out, one with the 60-character title, and a redeemed reward. | `tour/story.js`, `tour/load.js`, `tour/builders.js` |
| With the backend off | While the tour is on, a stand-in planner answers `/api/meeting-area`, `/api/converge`, `/api/search`, `/api/itinerary/arrange` and `/api/places/search` whenever the real one gives no answer of its own (no response, or a proxy's bare 5xx). It stops waiting for a sleeping backend after 8 seconds and leaves it alone for 45; when the backend answers, its answer is used. Never installed for a real account or outside the tour. | `tour/standIn.js`; `components/dev/offlinePlanner.js` |

Words: the strip says "sample data" and "rough"; it uses no exclamation mark and no upper-case label. The old ten-session showcase in the development tools is unchanged.

### Locate once the spot is confirmed, and the button at the top left, 11 Oct 2026 (evening)

Asked for by the lead after using the pitch build. It replaces two rows of the table above: "The back arrow" and "Confirming stays on Locate".

| Change | What it is now | Where |
|---|---|---|
| Locate, settled | From Voting on, the list of spots is gone. One card holds the confirmed meeting spot: the Rausch pin, the caption "Meeting spot" and the area's name in `display-lg`, entering with the old reveal (420 ms, spring; none under reduced motion). The map shows the meeting pin and a dashed line from each person's start, with no spot pins. Confirming still leaves the person on this page, with focus on the footer's button. | `GroupDetailView`, `settledView` in `spots/spotText.js` |
| The people card, settled | It is about the trips: each person's start area and travel time in its travel colour, and the colour key. The votes ring and the status icons are left out here, because "3 of 3 voted" on the Locate page read as a vote on the location. They are unchanged while the group is still choosing. | `GroupDetailView`; `statuses` on `MemberList` |
| The footer's button, settled | Named for where it goes, never "Next": "Choose places" (to Vote) while the group votes; "Today's plan" on the day of a confirmed plan and "See the plan" otherwise (to the Itinerary). | `locateNext` in `lib/session.js` |
| The button at the top left | A back arrow. On the session page, Vote and the Itinerary it leaves the session for the screen it was opened from (Home, Sessions, the profile), named "Back to Home" and so on; Home when that is not known, such as after a reload. The steps bar is how a person moves between steps. The photos and the full map go back to the Itinerary; Invite goes back to Create for the host. | `backFor` in `SessionSteps.vue`; `rememberEntry` and `exitFor` in `lib/stepNav.js`, called from the router |

### Reviews on the places to vote on, 11 Oct 2026 (evening)

Asked for by the lead: "show the reviews like the sample reviews on the home page". Built with two changes to that idea: the review that matters to a group is one from someone they know, so it is chosen by who wrote it and shown on the card where the choice is made; and the words follow the kind of place, so a place that is not food never gets a food text.

| Piece | What it is | Where |
|---|---|---|
| The review line | Each `SuggestionCard` carries one line under its reasons: a 24px avatar, the reviewer's name, the start of their sample review in quotation marks cut to one line, and a quiet "Sample" `InfoTag`. It is its own 44px button, apart from the vote chip and the swap button, and adds one line to the card. It quotes someone in the outing first, then a friend; with neither it reads "N sample reviews". Its name for a screen reader says "sample review". | `event/SuggestionCard.vue`; `pickReview` and `cardLine` in `lib/reviewPick.js` |
| The score | The place's score sits at the top right of the card's name, as a `RatingBadge` (a star and a score out of 10 with one decimal), as on Home's cards and in the detail. A place whose source gives no score shows none, so some cards have it and some do not. A place with a review count shows it beside the score ("★ 9.2 (512)", ticket #149); a sample place's score shows as before. The count is not built yet. | `event/SuggestionCard.vue` |
| The detail over Vote | Pressing the line opens `PlaceDetail` over the Vote page, built from the option, with no planner request. Reviews are ordered people in this outing, then friends, then everyone else; an outing member is tagged "In this outing" where a friend is tagged "Friend". "Sample reviews" and "Sample data for the demo" stay. "Navigate" is there, as on Home. Escape, the backdrop and its Back button close it and focus returns to the line; the browser's Back does not close it. | `views/PlannerView.vue`; `outing` on `event/PlaceDetail.vue`; `orderReviews` in `lib/reviewPick.js` |
| The words | `reviewKind(venue)` picks the text set: the place's own kind, then its cuisine, then its category; where a kind and a category disagree about food, the category wins. New sets: theatre, games, bowling and a general activity set. Home's 63 places keep the reviews they had. | `lib/mock/reviews.js` |

The reviews are invented and attached to real places in a real choice, which is why the label is on the card line as well as in the detail. Real reviews, written by a group after an outing, are ticketed for after the pitch. The Vote page's search rows and its map's pin card have no review line.

### The cards to vote on and the meeting spot card, 11 Oct 2026 (night)

Taken by the lead from a list of suggestions. The repeated stock photos stay, at the lead's word.

| Piece | What it is | Where |
|---|---|---|
| The photo and the name open the place | They are one control: a button inside the `h4`, named "Open <place>", whose `::after` covers the photo and the name, so either opens the place detail. Focus returns to whichever control opened it (this one, or the review line). The vote chip, the review line and the swap button are outside it. | `event/SuggestionCard.vue`, `views/PlannerView.vue` |
| Tags | The planner's reasons without "Short walk", which the line under the name already says; "Near MRT" stays, because it is about the station. Then one opening-hours tag, worked out from the place's hours at the slot's start and length: "Open until 22:00", "Open until midnight" or "Open 24 hours" (neutral); "Closes at 21:00" or "Closed at this time" (warning tone, clock icon); nothing when no hours are listed. | `cardTags` and `hoursNote` in `lib/cardText.js` |
| Dietary tags | After the opening-hours tag, one per dietary need a food place does not surely fit (ticket #107): "Halal likely" (a guess from a stall's name) or "Halal not confirmed" (no data; warning icon, shown only after "Show places we couldn't confirm"). Halal is brown, vegetarian and vegan green. Hovering says "..., check before you go". | `dietTags` in `lib/dietText.js` |
| Where the walk is from | One quiet line above the first category: "Walking times are from <meeting area>". Once per page, not on each card; absent with no meeting area. | `views/PlannerView.vue`; `walkFromText` |
| Who voted | In a session of four or fewer people the vote line names them: "Darius voted", "You and Nicole voted", "Everyone voted"; "0 votes" when none. A larger group keeps the count. If the names and the count disagree it falls back to the count. | `votersText` in `lib/cardText.js` |
| The meeting spot card | Under the spot's name, the person's own trip ("About 13 min from Bugis", or "You are already there"), then a "Directions" button: Google Maps by public transport in a new tab, to the area's centre, because a meeting spot is an area and not an address. The button sits under the name; beside it, it squeezed the name to a few letters in the list column and on a phone. | `GroupDetailView`; `myTripLine` in `spots/spotText.js`; `lib/maps.js` |

`SpotList` still knows how to draw a confirmed list (its rows, "Confirmed", no controls); no screen uses that state now.

Not built, suggested to the lead for after the pitch: the person's own trip and a "Directions" button on the meeting spot card; one bar per person on a shared scale, with the longest trip stated, so the fairness is seen; a line saying how the spot was chosen, with the other spots behind a disclosure; the start and end card shrunk once settled; the top navigation kept on session pages at desktop width.

### Walkthrough items and Roam from Home, 17 Oct 2026 (branch `feat/darius-walkthrough-items`)

Tickets #120, #121, #122 and #98. Nothing here adds a colour or a token, and no white text was added on `--primary`.

| Piece | Where | What it is |
|---|---|---|
| Overdue banner | `LandingView` | A `BannerNote` (tone `warning`, clock icon) under the invitations for each outing past its end time with no confirmed plan: "{title} has passed its end time without a confirmed plan. It closes by itself on {day, time}." with a small secondary "Open outing". A confirmed outing gets none: it finishes by itself (`dueEnding` in `lib/session.js`, `settleOutings` in `lib/api.js`). |
| Closed notice | `SessionNotices` | An info `BannerNote` (clock icon) on an outing that closed by itself two days after its end with no plan. Its session page has no footer, and its card opens the session page, not an empty itinerary (`sessionPath`). |
| Frequent hangouts | `InviteView` | Friends only. "Frequent hangouts" (up to five, most outings together first) above "All friends"; with no history, one list headed "Friends". The Jio streak sits beside the name: a 20px pill, `--primary-active` on a 10% `--primary` tint, sparkle icon and the count, with "Jio streak: N outings together" for screen readers (`lib/hangouts.js`). |
| Suggested people | `ProfileView` | On your own profile only, between the graph and Sessions: up to six rows (44px avatar, name, @username and area) in one column, two from 744px, each opening the profile, with a small secondary "Add friend" in the sample world. Moved here from the invite page. |
| Search within | `PlannerView` | While voting: a "Search within" caption, radio chips (Auto, 100 m, 250 m, 500 m, 1 km, 2 km, 3 km) under the category filter, and one muted line on what the choice means. The map's dashed ring follows it. A category with too few places inside says "Only N places fit within X." with "Widen to Y". |
| Create form times | `CreateEventView` | A new session starts at the next round hour and ends three hours later (`defaultTimes`). |
| One create button | `GroupsView` | The page header's Create pill and the empty state's button are gone: the navigation's Create (top bar or tab bar) is the one on the page, as on the profile. |
| "Already out?" row | `components/home/RoamFromHome.vue` | Under the meetups on Home (local accounts). The start row's box with a hairline outline, a 44px `--surface-strong` badge with the locate icon, "Already out?" over "Find something nearby", and a chevron. It opens `LocationSheet` ("Where are you?", with "Use current location" and the home area), then starts a light meetup and opens its Roam list. |
| No stops yet | `EventView` | A light meetup's itinerary before anything is added shows an `EmptyState` in place of the timeline, with "What next?" below it as usual. |

Changes made in the review of the pull request, before it merged:

| Piece | Where | What it is |
|---|---|---|
| No coins for one | `EventView`, `SessionNotices` | An outing pays JioCoins only when at least two people are in it (`earnsCoins`, `lib/session.js`), light or not; otherwise "Already out?" could be repeated for coins. The Finish outing dialog says "Outings with friends earn JioCoins. This one is just you, so it earns none." in place of the +10 line; the toast after says "Completed · No JioCoins for an outing of one. Outings with friends earn them."; and a finished outing of one (by hand or by itself) carries an info `BannerNote`, "This outing was just you, so it earned no JioCoins. Outings with friends earn them.", in place of the trophy banner. |
| Home settles on open | `LandingView` | Home reads the list again when it opens if an outing's end has passed (the store may already be loaded), as well as when the clock crosses an end time while it is open. |
| One read, never an old save | `lib/api.js` | Settling is a write made by a read. It takes up a newer save from another tab first (`adoptNewerSave`) and settles on top of it, so a stale tab cannot save over a voucher or a balance. Opening one outing by its address settles too, and "Finish outing" on an outing that already finished says "This outing has already finished." |
| Demo sessions stay as built | `tour/builders.js` | Sessions made by the showcase and the tour are made with `keepOpen`, so the clock never finishes or closes them (their "today" window is fixed when they load), and Home shows no overdue banner for them. |
| Invite streaks follow the tour | `InviteView` | The Jio streaks are counted from the sessions the lists show (`visibleSessions`), so the tour's final, completed save does not give the friends a streak at the earlier checkpoints. |
| Radius chips stay focusable | `PlannerView`, `ChipButton` | The chip row is a `role="radiogroup"` named by "Search within", with `v-radio-group` (one Tab stop, arrow keys choose, as the Show chips). While a radius change runs the chips are `aria-disabled` (ChipButton's `disabled`: faded, still focusable, clicks ignored), so keyboard focus is not thrown to the page. |
| Votes cleared by the radius | `lib/api.js setRadius`, `SessionNotices` | Any member may still change the radius. When it drops votes, the voting page shows the usual dismissible votes-cleared `BannerNote`: "Votes for places outside the new ring were cleared." (Auto: "Votes for places that no longer fit were cleared."). |
| Late-night create form | `CreateEventView` | After 23:00 in Singapore the default start is 00:00, so the day starts as tomorrow (`defaultDate`); a start that has already passed today is refused under the start time, "That start time has already passed today.", and an end that has passed under the end time, "That time has already passed today." Editing a session and changing only its title is never held back by the clock (`updateSession` allows it too). |
| Closed outings take no photos | `lib/api.js addPhoto`, `PhotosView` | An outing that closed by itself has no plan, so photos stay shut for it. |

Time. A session's day and times are Singapore time (UTC+8, no daylight saving), whatever time zone the browser is in. Every "now" that is compared with them is read on Singapore's clock through the helpers in `lib/session.js` (`singaporeDate`, `singaporeTime`, `singaporeMinutes`, `singaporeInstant`), never through `getHours` or `format(now)`: the create form's defaults and refusals (`defaultTimes`, `defaultDate`, `startHasPassed`, `endHasPassed`) and its calendar's today, the countdown (`startsIn`), a session's end, the auto-finish and the overdue banner (`sessionEnd`, `dueEnding`, `overdueOuting`), Home's day labels (`homeMeetups.js`), its greeting's date and the overdue banner's closing time (`LandingView`), Roam's "now" (`startRoam`, `roamNearby`, a proposal's first stop, `ProposedStops`, `RainBanners`), the photos' times on the day, and the demo's "today" window (`tour/builders.js`). The data layer refuses a past day or a start that has passed on both paths, local and server (`checkSessionFields`); the database has no rule of its own on dates. Tests set the clock with explicit instants (with `Z` or `+08:00`), so the suite passes in any time zone. Not on Singapore's clock, on purpose: seasons and the leaderboard (quarters in the browser's zone) and the dates in the sample history.

### The lead's walkthrough, part 1, 30 Oct 2026 (branch `feat/walkthrough-part-1`)

Seven items from the lead's walkthrough. Nothing here adds a token, and no white text was added on `--primary` beyond the existing main-button pattern (`AppButton`).

| Piece | Where | What it is |
|---|---|---|
| Claimed or not | `RewardsView` | Each voucher card says under the café whether you have claimed it: a muted "Not claimed", or "Claimed" in ink with a tick ("Claimed 2 times" after a second claim; a voucher can be claimed again). Counted from your claims, expired and used ones too (`claimCounts`, `claimLabel` in `lib/vouchers.js`). |
| A calmer grid | `GridPulse`, `lib/gridPulse.js` | The spectrum is gone. A lit cell is a grey of 90 to 94% lightness at 70% strength, or about one in eight the brand red at 16%; nothing lights on its own, the trail reaches 1.6 cells and at most 40 cells are lit. Still off under reduced motion. |
| No local-account note | `ProfileView` | The banner "This account lives only in this browser. Signing out erases it, and you cannot log in to it from another device." is removed. The sign-out dialog still says what is erased. |
| Search sessions | `ProfileView` | Beside the All, Upcoming and Completed chips, a pill search box ("Search by title or area", 44px, `--border-control` edge, ink ring on focus) narrows the list by title or meeting area. It sits to the right of the chips from 744px and under them on phones. With nothing left the line reads "Nothing matches “…”". |
| A day from the graph | `MeetupGraph`, `ProfileView` | Clicking or tapping a day (or Enter on the day the arrow keys reached) shows only that day: your own sessions, or someone else's recent activity. The graph emits `select` with the date and takes `selected` back. The day shows above the list as an ink chip (`--selected`, calendar icon, the day, ×), 44px tall, named "Show every day, not only <day>"; the × or the same day again lets it go. Picking a day picks All, says "Showing <day> only" in a polite status line, and brings the list's heading into view (smoothly, or at once under reduced motion), because on your own profile Friends and Suggested sit between. The graph's hint reads "Tap a day to show only that day below". |
| Take back everywhere | `InviteView` | The × on an Invited row (`TakeBackInvite`) is now also on the "Invites sent" confirmation, where a row then reads "Taken back" (muted), and on the list shown when invites are closed by a confirmed plan (not on a cancelled or finished outing). |
| Invitees are friends | `lib/api.js inviteFriends` | Inviting someone makes them a friend. The demo and local accounts add each invitee to their own list. A real account's friends are already the people in its sessions, and a pending invitee is one of them on the host's side; the invitee counts the host once they join, since their invitation does not carry the host's id (that would need the server). |
| Confirm on the map | `SpotCard`, `SpotPins` | The host's card at a meeting spot's pin has "Confirm <area>" (a small primary button, full card width) under "Works for me" while the group is choosing, the same confirm as the footer's (`events.confirmSpot`, the shared `confirming` flag). On a phone the host taps Map, taps a pin and confirms there. |
| Create asks how to start | `TabBar`, `lib/startChoice.js` | The navigation's Create (the top bar's red "Create session" from 744px, the phone pill's + circle) is a menu button. It opens a small card, under the button from 744px and above the + circle on phones (280px wide at most, `--canvas`, hairline, `--rounded-md`, `--shadow-float`), with two 56px items, each a 36px `--surface-strong` icon circle, a name and a muted line: "New session" (calendar, "Pick a day and invite friends") and "Already out" (locate, "Find places near you now"). It pops out of the button (scale and fade, none under reduced motion). Picking one plays Home's "entering a game" move (`lib/enterGame.js`) from the button into the create page in that mode. Arrow keys, Home and End move between the items, Escape returns focus to the button, and a press outside or Tab closes it. A real account has no "Already out", so its Create opens no menu and goes straight in, with the same move. |
| Already out on Create session | `CreateEventView` | `/sessions/new?start=out`, opened from the menu. The title reads "Already out", the calendar and times are hidden, one line says what it does, the title is optional ("Out in <area>"), and "Where are you?" is a row like Locate's "Starting from" (locate icon in a 40px `--surface-strong` circle, `--border-control` edge; its name is "Where are you? <area or Pick where you are>"), which opens `LocationSheet`. "Find places nearby" starts the light meetup (`startRoam`) and opens its itinerary. The page has no choice of its own; for a real account the address gives the usual form. |
| No "Already out?" on Home | `LandingView` | Home's "Already out? Find something nearby" row (`RoamFromHome`) is gone, so the navigation's Create is the one way to start a light meetup. The component stays in the repo, unused. |

### Places from a post, 30 Oct 2026 (branch `feat/link-reader-screen`)

`views/PostPlacesView.vue` at `/places/from-post`, reached from "Find places from a post" (a tertiary link) on Home. It is the first screen on the backend's link reader (`backend/docs/link-reader-api.md`).

- **Shell.** `.screen--wide-form` with a back `IconButton`, the title "Places from a post" and one line naming the four sites. One form: `TextField` "Link to a post" with the `link` icon, and the primary `AppButton` "Find places" (under it on phones, beside it from 744px, 56px tall to match the field). It reads "Reading…" and is disabled while a read runs, so a post is never sent twice.
- **States.** A `SkeletonRow` while the page asks whether the server reads posts; `EmptyState` "Reading posts is not available" when it does not (the route answers 404 without `LINK_READER=1`). While reading, a line ("A video can take up to 40 seconds.") and three `SkeletonRow`s. A failed or unreadable read is an `EmptyState` "Could not read the post" with `role="alert"`, and "Try again" only when trying again can help. A link that is plainly not a supported post is refused under the field before anything is sent (`postLinkProblem` in `lib/postPlaces.js`); the server's own refusals land there too.
- **Results.** One info `BannerNote` for the whole post (an old post, what could not be read). Then a `.card` per place: the name (and the post's own spelling under it when it was translated), Google's rating as `4.5 ★ (66)` (muted under 10 ratings, `New` with no rating, nothing without a match), the address with the `pin` icon, a line when Google's match needs checking ("Google lists it under another name. Is this it?", or several branches, listed in a `<details>`), the post's tip, and each warning with the `warning` icon. Each card's one action is a secondary small `AppButton`, "Open in Google Maps" (by the place id) or "Search Google Maps" (by name, when Google had no match), opening in a new tab. A caption under the list says "Addresses and ratings from Google Maps."
- **No map and nothing saved.** Google places may not be drawn on or beside the OneMap map, so a place opens in Google Maps instead. The link reader's saved lists need tables that do not exist yet, so the screen keeps nothing.

## Known Conflicts

Each item is a place where the shipped code departs from a rule written in `CLAUDE.md`, in `frontend/src/styles/README.md`, or in a comment in the code. They are recorded as facts. Nothing here has been changed, and the lead decides each one. Contrast ratios are computed from the token values with the WCAG 2 formula; 4.5:1 is the threshold `CLAUDE.md` names.

"This pull request" means "Feat/leaderboard jiocoins", pull request number 87 on `peachoolongtee/jio`, merged on 10 Oct 2026.

### Contrast

1. **White on `--primary`: `#ffffff` on `#ff385c` is 3.52:1.** `CLAUDE.md` says "white text sits only on colours that give 4.5:1 or better. `--primary` is the text-safe brand colour". This pull request changed `--primary` from `#d10027` (5.61:1 with white) to `#ff385c`, in commit `43b4ddb` ("restore the brighter brand colours…"); the darker value came from commit `5cc306b` ("darken brand, category and person colours for contrast"). The token's own comment now says "White text on it is 3.5:1; this brighter red was chosen over the darker #d10027 on 2026-10-09". White text or icons sit on `--primary` in: `AppButton` (`primary`, `pill`, and the filled `next`), `IconButton tone="brand"`, the Create tab in `TabBar`, `StatusPill` (Confirmed), `CountdownChip` (Live now), the selected day in `CalendarPicker`, `PinButton`, `HeroButton`, the done marks in `MemberList`, `InviteDialog` and `ProgressDonut`, the meeting-area pin and radius label in `PlannerMap`, the pin in `PlaceDetail`, the countdown pill in `LeaderboardView`, the `+` in `RewardsView`, the 56px initial badge in `InviteView`, and icon circles in `EventView` and `GroupDetailView`.
2. **`--primary` and `--primary-bright` are now the same value, `#ff385c`.** `CLAUDE.md` describes them as different ("`--primary-bright` is for decoration without text"). Changed by this pull request.
3. **`--primary` as text.** On white it is 3.52:1: the `HoldButton` label (14px), the balance in `RewardsView` (22px, weight 700), the arrow in `HeroButton`. On its 11% tint (`#ffe9ed`) it is 3.04:1: the current tab's icon and 12px name in `TabBar`. On the 16% hold fill (`#ffdfe5`) it is 2.84:1: the `HoldButton` label while held. The README says this pair is 4.6:1.
4. **White on category colours.** `--cat-eat-fg` `#ea580c` 3.56:1, `--cat-drink-fg` `#0284c7` 4.10:1, `--cat-activity-fg` `#059669` 3.77:1. `--cat-shop-fg` `#9333ea` is 5.38:1 and passes. White stop numbers sit on these in `StopCard` and `PlannerMap`. This pull request changed the first three from `#c44a0a`, `#0277b4` and `#04825b`, and removed the comment "Each is dark enough for white numbers on it (4.5:1 or more)".
5. **White on person colours.** `--person-3` `#0d9488` 3.74:1, `--person-5` `#ea580c` 3.56:1, `--person-7` `#0891b2` 3.68:1. The other five pass (4.71:1 to 5.70:1). White initials sit on these in `UserAvatar` and on person pills in `PlannerMap`. This pull request changed these three from `#0b7f75`, `#c44a0a` and `#077c99`, and removed the matching comment.
6. **Other pairs under 4.5:1, for information.** `--muted-soft` `#929292` on white is 3.11:1; besides disabled controls it colours the labels of session steps not yet reached (`SessionSteps`). `--medal-gold-fg` `#c08a00` (3.05:1) and `--medal-silver-fg` `#7a8699` (3.69:1) on white are used for crown icons and rings, not text, though the token comment also names "rank numbers". Category icons on their 12% tints are 3.07:1 (eat), 3.51:1 (drink) and 3.25:1 (activity); these are icons, not text. `--legal-link` `#428bff` is 3.30:1 on white and is unused.
7. **Pairs checked that pass.** White on `--primary-active` 4.89:1, on `--primary-error-text` 5.54:1, on `--ink` 15.91:1. `--muted` on white 5.41:1, on `--surface-soft` 5.05:1, on `--surface-strong` 4.83:1. `--primary-error-text` on white 5.54:1. `--scale-middle-text` on white 5.06:1, `--scale-good` 5.02:1, `--scale-bad` 4.83:1. Medal numbers on their blocks: 5.66:1, 6.39:1, 5.18:1.

### The "Sample data" note

8. `CLAUDE.md` says "Mock people, places, reviews and rewards carry a visible 'Sample' note (`components/ui/SampleNote.vue`)". `SampleNote` is rendered in two places: `PlaceDetail` (under the place's name) and `ProfileView` (on someone else's profile only).
9. This pull request removed `SampleNote` from `LandingView` and from `LeaderboardView`. The other ranked people are hand-written. (A stale comment in `LeaderboardView` that claimed a note was shown has since been corrected.)
10. It is not rendered on the Home place cards (`PlaceCard`), in `InviteView` or `InviteDialog` (people), or in `RewardsView`, where the intro line says "sample café vouchers" in words instead.

### The README's rules against the code

This pull request edited `frontend/src/styles/README.md` in two places: the hex in rule 2, and the sentence on data colours, which now reads "the brighter originals, chosen over darker versions on 2026-10-09" where it read "dark enough for white numbers and initials on them (4.5:1 or more)". The rest of its text describes the earlier look.

11. **Rule 2, contrast figures.** It says `--primary` gives white text 5.6:1 and is 4.6:1 on its tint, and that `--primary-bright` is a different, brighter colour. See items 1 to 3.
12. **Rule 2, "Anything selected is ink … selected chips and dates … progress bars, the donut chart".** The selected date in `CalendarPicker` is `--primary`. `ProgressDonut`, `SessionSteps` and `SegmentedProgress` are `--primary`. The current tab is a red tint, not an "active tab underline".
13. **Rule 2, "used scarcely … one or two Rausch moments".** See the list in item 1 for where red appears on a single screen.
14. **Rule 4, "No gradients".** Gradients are used in eight files; see Elevation & Depth.
15. **Rule 4, "There is one shadow, `--shadow-float`".** Eight files write their own shadows; see Elevation & Depth.
16. **Rule 4, "Buttons … do not shrink when pressed".** `AppButton` scales to 0.97 when pressed, `IconButton` to 0.9, `ChipButton` to 0.94. The same README's motion paragraph says buttons "give a little when pressed".
17. **Rule 4, "buttons and inputs 8px".** The `next` and `pill` variants, `HeroButton` and `HoldButton` are fully round.
18. **Rule 5, "Every tap target is at least 44px".** The close button of `PopoverPanel` is 36px. Legend swatches in `MeetupGraph` are 24px. Tabs in `TabBar` may be 40px wide under 380px. Calendar days are 44px tall and as wide as their column, which is about 36px at 320px wide.
19. **Rule 6, "Show a `StatusPill` … at the top of every session screen".** This pull request removed `StatusPill` from `SessionHeader` and `InviteView`; `SessionSteps` now shows where the session is. `StatusPill` remains on `SessionCard` and in `SessionMapView`.
20. **Rule 10, "The floating tab bar is the navigation at every size".** From 744px it is a bar along the top. The comment in `tokens.css` was updated; the README was not.
21. **Rule 1, "Use a token, never a raw value".** See "Colours hard-coded outside the tokens", "Sizes written outside the scale", the raw radii under Shapes, the raw shadows under Elevation & Depth and the raw curves under Motion.
22. **`DESIGN-airbnb.md`.** The README and the first line of `tokens.css` name this file as the basis of the system. It is not in the repository.

### Tokens

23. No token described by the README has been removed. Tokens whose values this pull request changed: `--primary`, `--primary-active` (`#aa001f` to `#e00b41`), `--cat-eat-fg`, `--cat-drink-fg`, `--cat-activity-fg`, `--person-3`, `--person-5`, `--person-7`. Tokens it added: `--brand-logo`, the nine `--medal-*`, `--wide-form-max-width`, `--topbar-height`.
24. Defined and unused: `--luxe`, `--plus`, `--legal-link`, `--surface-card`, `--rounded-none`, `--rounded-xl`, `--spacing-section`. Classes defined and unused: `.link`, `.micro-label`, `.button-md`, `.button-sm`, `.nav-link`, `.text-body`, `.text-brand`, `.note`, `.mobile-only`, `.desktop-only`.
25. `--font-sans` begins with "Airbnb Cereal VF" and Circular, which are not bundled and are licensed to others. Inter is the face that ships.

### Other

26. `HeroButton` is defined and used by no screen. `StatTile` and `PollBar` appear only in `DesignSystemView`.
27. `DesignSystemView` (`/design-system`) does not show `GridPulse`, `PopoverPanel`, `CoinBadge`, `PinButton`, `HeroButton`, `HoldButton`, `CalendarPicker`, `RadialTimePicker`, `SingaporeMap`, the three Leaderboard components, `SessionSteps` or `SampleNote`.
28. `PlaceDetail` switches to its panel layout at 768px; every other tablet rule uses 744px.
29. `EventView` says "points" in one banner where the rest of the app says "JioCoins".

### Shared sessions, 16 Oct 2026 (branch `feat/sessions-stage-2-shared`)

A real account's sessions are rows in Supabase (ticket 127). Nothing in the design language changed; these are the screens and pieces that appeared, all built from the tables above. The demo account and local accounts keep every screen as it was.

- **`/join/:token` (`JoinView`)** is a form-width screen like the login: the logo, one `<h1 class="display-xl">` with the session's title, "{host} invited you to" above it, the day and times below. It is public (`meta: { nav: false, public: true }`). Signed out, the footer has `Sign up to join` (a `next` button) and a tertiary `I have an account. Log in`, both carrying `?next=/join/<token>`; the sign-up and login screens keep that address on their links and go back to it. Signed in, it has one `next` button, `Join session`. A link that does not work shows `EmptyState` "This link no longer works" with the one sentence that names every reason (the database answers them all alike on purpose). Failures to load say "Could not load this invitation" with `Retry`; "You are already in {title}" has `Open session`.
- **The lobby (`GroupDetailView`, inviting)** now marks "(you)" on the signed-in person's own row only (it used to mark the host). (Stage 2 held `Start session` disabled under a sentence; stage 3 lifted that, see "Shared sessions, locating" below.) A guest has a tertiary `Leave session`; the host has a 44px `IconButton` "Remove {name}" on each guest's row. Both ask a `ModalDialog` question first ("Leave this session?" with `Stay`, "Remove {name}?" with `Keep {name}`). A session called off before it started shows the same list under the "Session cancelled" note.
- **`ShareLink`** (invite page, and compact in the Invite popover) is a labelled read-only field with the whole address, "It works until Fri 23 Oct, 19:02.", `Copy link`, `Share` (only where the browser has a share sheet) and a tertiary `Turn off link` that asks "Turn off this link?". `InviteByUsername` is a search field: `TextField` (label "Search by username", hidden) with a magnifier in its `leading` slot, which a 16px ring spinner (`byname-spin`) replaces while it looks, and a 44px round clear (x) button in `trailing` once there is text ("Clear search"; it returns focus to the field). There is no Find button. From the third character, 250 ms after the last key, up to five people whose username starts with the text appear (the exact match, then people the host has been in a session with, then by username; the server's `GET /api/people/search`, never the host themselves). Each is a 68px row with the avatar, name, @username and `Invite` (named "Invite {name}"), or "Already invited." / "Already in this session.". States: under three letters the field's hint says "Type at least 3 letters of their username"; while a newer search is waiting the old list stays at 60% and cannot be pressed; none found is "Nobody's username starts with that."; a failed search shows its sentence and `Try again`; an invitation that fails shows its sentence as an alert and keeps the list; an invitation sent clears the field, says "{name} is invited. They will see it on their Home screen." and puts focus back in the field. A visually hidden `role="status"` line says "N people found" or the failure. Keyboard: a plain list of rows with buttons, not a combobox, because a row holds a button and a sentence; Enter or the down arrow in the field moves to the first `Invite`, the up and down arrows move between the buttons, and Enter in the field invites nobody. Under reduced motion the spinner is a still ring. Copying says "Link copied." to screen readers.
- **`InvitationList`** ("Invitations", `display-sm`) is a grid of cards on Home and Sessions with `Join` and `Decline`, each with the invitation's title in its accessible name. Home's band shows a pill link, "You have an invitation", that jumps to it, because the list sits below a full-height map for a person with no meetup.
- **Known and left for stage 3.** The held start is enforced only in the app (a host could still start a session through the database directly; the leave and remove route refuses any session that is no longer inviting, for now). A guest who was removed can rejoin with the same link, but cannot be invited by username a second time ("You have already invited that person."). A real account's old local-only sessions, made before sessions moved to the server, are hidden, not carried over.
- **Known limits.** The join page cannot tell a person whether the link expired, was turned off or belongs to a session under way: `invite_preview` and `join_session` return the same answer for all of them. The Invite popover leaves out `Turn off link`, because the question it opens would sit outside the popover and close it.

### Shared sessions, locating, 20 Oct 2026 (branch `feat/sessions-stage-3-frontend`)

A real account's session now goes on from the lobby to the Locate step, kept in Supabase and worked out by the Jio server (ticket 128). The screens are the ones the local mode already has (`GroupDetailView`, `SpotList`, `SpotConfirm`); only these pieces are new or changed, all built from components above. The demo account and local accounts are untouched.

- **Start session (lobby).** The host's `Start session` (`next`) works from two joined people. A refusal is one `body-sm text-error` line (`role="alert"`) under the list, in the database's own words ("A session needs at least two people before it can start."), and the button stays for another try. A guest sees "Waiting for {host} to start the session." beside the tertiary `Leave session`; there is no Start for a guest. The held-start sentence of stage 2 is gone.
- **Locate (locating).** The same page as the local mode. While a save is out the list says so in the way it already does (placeholder rows when the list is empty, "Updating travel times…" over a list that is there); with one start in there is nothing to wait for, so nothing is shown. A save that the server turns away (an answer with its code: busy, the group has moved on, not allowed) puts the person's own change back, and only where the database still holds what this save wrote, and says why in the `text-error` line under their route, in plain words. A save the server did not answer (a timeout, no connection, a server failure) keeps the start, because the server may have done its work: a `BannerNote` (info, dismissible) under their route says "Your start is saved. The travel times may take a moment to appear." and no error line is shown. Two quick changes to the same end run one after the other. When any call that shows "Updating travel times…" fails, the notice goes off with it. "Works for me" does not need the server, so it works when the planner is down. The group sees each person's start as the area's name; the exact place is the owner's own line on their route and nobody else's.
- **People list, locating.** The host has the 44px `IconButton` "Remove {name}" on every other joined person's row (it was only in the lobby); the same question ("Remove {name}?" with `Keep {name}`) and the same words. In a shared session the "Waiting for" card has a secondary small button "Remove {name}" (it was "Continue without {name}", which hid that the person is taken out for good) with the same question and the same words as the icon button: "{name} is removed from this session and it disappears from their list. If they joined with an invite link that still works, they can rejoin with it. Someone invited by username cannot." (`components/group/removeCopy.js`, read by `RemoveMember` and the card). It is not offered when removing would leave fewer than two joined people, and the card's sentence then does not mention it. A session of this browser keeps "Continue without {name}", which only opts the person out. A guest has a tertiary `Leave session` under the people card, with the same question as in the lobby. `MemberList` gained a slot, `action`, for this.
- **Opted out.** A person who opted out of a shared session sees a `BannerNote` (info) "You opted out of this session, so your trips are not counted." with a secondary small `Rejoin`, above the people card, while the session is inviting or locating.
- **The banner.** The server's note that "Works for me" marks went with a spot that left the list is the group's, and `Dismiss` hides it for that person alone, in this browser; a later note shows again.
- **Vote (voting).** Stage 3 stopped the page here with "Voting with friends comes next"; stage 4 replaced that, see "Shared sessions, voting" below.

### Shared sessions, voting, 22 Oct 2026 (branch `feat/sessions-stage-4-frontend`)

A real account's Vote page is the page the local mode has (`PlannerView`, `SuggestionCard`, `ChipButton`, `ProgressDonut`, `SplitView`), fed from the database and the Jio server (ticket 129). The demo account and local accounts are untouched. Nothing new was drawn; these are the changes.

- **The places.** Every category the server made is listed with the places it offered, best first, from the database; reloading the page asks the planner for nothing (the cards' place details come from the server's place list, once for each place). The weather line, the "only N places fit within X" line, "Widen to ..." and "Nothing fits" read what the server stored with each category.
- **Voting.** A tap on `Vote` writes the person's own vote straight to the database and shows it at once ("Voted", the count, "You voted", the leader outline); if the database refuses it (the plan was confirmed meanwhile, the person is out, the place was dropped) the card goes back and the refusal is one `body-sm text-error` line (`role="alert"`) above the filter, in plain words ("Votes are read-only once the plan is confirmed."). A failure that proves nothing (no connection) leaves the card as shown and says so. Another person's vote appears on every open device within a moment, with their name ("Kim voted").
- **Search within.** Only the host chooses the radius. A guest sees one `caption`/`body-sm` line instead of the chips: "1 km of Bugis, set by Sam." (`data-testid="radius-readonly"`), and no "Widen to ..." buttons. The host's chips are the ones every session has.
- **A person who opted out** sees a `BannerNote` (info): "You opted out of this session, so you can't vote and your trips are not counted." with a secondary small `Rejoin`; the Vote chips, "More places" and "Search" are not offered. The Locate page's rejoin note now also shows while voting.
- **Where "Confirm plan" will be.** (Stage 4 only; stage 5 replaced it, see "Shared sessions, the plan" below.) The footer held one `caption text-muted` line, "Confirming the plan with friends comes in the next update.", above a secondary block `Back to the people`.
- **Home.** A shared meetup in voting shows the chip the local one does: `Vote` (action) until the person has voted, then `Waiting for others`. It was "Open meetup" while voting was not ready.
- **States.** Loading is the three placeholder rows and the "Finding places" status line; a load that fails is the `BannerNote` with `Try again` and the page stays usable; an empty category is the page's own sentence.

### Shared sessions, the plan, 23 Oct 2026 (branch `feat/sessions-stage-5-frontend`)

A real account's session now goes from voting to a confirmed plan, an itinerary everyone sees live, and a finished outing, kept in Supabase and worked out by the Jio server (ticket 130). The screens are the ones the local mode has (`PlannerView`'s Confirm dialog, `EventView`, `SessionNotices`, `ProposedStops`, `RainBanners`, `RoamView`, `SessionMapView`); the demo account and local accounts are untouched. One piece was drawn: `LedgerCard`, from the same tokens as the cards beside it (a `--hairline` border, `--rounded-md`, `title-md`, `body-sm`, `caption-sm`).

- **Confirm plan.** Only the host has the button (disabled and reading "Needs 2 voters" until two people have voted). A guest's footer holds "Waiting for {host} to confirm the plan." (`caption text-muted`) above the secondary block `Back to the people`. The dialog is the one the local mode has: the voted order, and, when the server has one, the `Voted order` / `Suggested order` tabs with the server's note under the rows ("AI suggestion: ..." or "Suggestion chosen by travel and waiting time. ..."). The host asks the server for the suggestion when the dialog opens; the browser never sends stops, a reason or a source back, only which order was shown. States inside the dialog: "Looking for a suggested order…" while it is out; when it could not be asked for, one `caption-sm text-muted` line, "Could not get a suggested order.", with a tertiary `Try again`, and the voted order stays usable; when the server refuses a suggested order the votes have outdated (`order_stale`, nothing written), the dialog stays open, both orders are drawn again from the stored votes with the voted one selected, and one `caption-sm` line says "The votes changed, so the suggested order changed too. Look at it again and confirm."; when the votes change under an open dialog the same redraw happens with "The votes changed, so the order below was updated."; any other refusal or failure (not enough voters, no connection, busy) is one `body-sm text-error` line (`role="alert"`) inside the dialog, with `Confirm` still there to try again. The dialog closes by itself when the group is no longer voting.
- **The itinerary.** The same page. A confirmed plan is read from the database (the stops in order, how the group gets to each, the sentence about the order) and drawn by the rules the local mode uses; a change made on another device (a move, a delete, a travel mode, a place added or replaced, the end of the outing, a re-plan) arrives live, with no reload. Only the host edits: a guest has no pencil, the Walk / MRT / Car switches only read, and on the day the footer reads "{host} finishes the outing." (`caption text-muted`) above a secondary `Back to Home` in place of `Finish outing`. A move, delete or change the server refuses is one `body-sm text-error` line above the stops, and the page then shows the plan as stored; a move on screen is put back only when the server answers that it did nothing, and otherwise stays until the stored order is read. A plan that cannot be loaded is the page's own `EmptyState` "Could not load this plan" with `Retry`.
- **Finishing.** The dialog says "The outing ends for everyone. Jio keeps how far each of you travelled." (no coins: JioCoins are kept in each browser, so the "points each" banner and the toast's coins are not shown for a shared outing; the toast reads "Outing finished"). A finished outing shows `LedgerCard` ("Your travel") above the stops: the person's own row only, never anyone else's.
- **Re-plan?** The question the server keeps on a confirmed plan is answered by the host (`Re-plan` goes back to voting with the votes kept, `Keep plan` turns the question off for everyone); a guest reads "{host} decides." with no buttons; a refusal is one `text-error` line under the question with the buttons still there.
- **Replace and the rain swap** are the host's, as in the local mode, and go through one function. Photos are not on the server yet: a shared session has no photos link on the itinerary, and the Photos page says "Photos are not shared yet. They come in a later update."
- **Roam.** "What next?" lists the places the server ranks near the meeting area (or the person's own point, sent for that one request and never stored). Proposing, adding to the plan, leaving out and taking back are as in the local mode; the proposals and the stops they become reach the other devices live. Roam from Home's light meetup stays local.
- **A route the server does not have yet** (the Roam list, the rain swap offered for a stop, and the places Replace lists are not built on the server at this commit) answers in the page's own error line, "That is not available yet. Try again after the next update.", in the place the other refusals use; no screen is hidden for it and nothing is drawn differently, so when the route arrives the line stops appearing.
- **Not drawn here.** The Known Conflicts below are unchanged; `LedgerCard` puts no white text on a colour.

## Building a New Screen

1. Start from the shell: `<main class="screen">` with `.screen__header`, `.screen__body` and, if there is a main action, `.screen__footer`. Use `.screen--form` or `.screen--wide-form` for a form. If the screen is a tab, set `meta: { tabs: true, tab: '<id>' }` on its route.
2. Title it with one `<h1 class="display-xl">`. Section headings are `<h2 class="display-sm">` inside `.section` and `.section__head`.
3. Take every colour, space, radius and shadow from `tokens.css`. If no token fits, check the tables above for the nearest one before writing a number.
4. Choose one main action. Use `AppButton` (add `next` when it leads to the next step, `block` in the footer). Use `IconButton` for secondary icon actions and give each a `label`.
5. Build from the tables under Components. For a quick pick beside a button use `PopoverPanel`; for a longer task `BottomSheet`; for a yes-or-no question `ModalDialog` with the safer choice first.
6. Lists go in `.grid-3` or a stack. Give each list four states: `SkeletonRow` while loading, `EmptyState` when empty, `EmptyState` with `role="alert"` and a Retry button when loading fails, and the content.
7. A list with a map goes in `SplitView` with `PlannerMap`, and `CategoryKey` when category colours are shown.
8. On a session screen, begin with `SessionHeader`; it brings `SessionSteps`.
9. Use information colours only for information, with a word, icon or key. Use `CoinBadge` for amounts, `PriceTier` for prices, `UserAvatar` with `person` for people.
10. Write copy as under Voice and Copy: sentence case, "about N min" for estimates, a question for a dialog title. Mark hand-written content with `SampleNote`.
11. Keep every target at least 44px, leave the global focus outline visible, and trap focus in anything that opens over the page with `useFocusTrap`.
12. For entrance motion use `.rise` with `--i` for a stagger. For anything else use `--motion-fast`, `--motion-medium` and the three `--ease-*` curves, and give it a reduced-motion path.
13. Stack to one column under 744px and add columns at 744px and 1128px in CSS only.
14. Before placing white text on `--primary`, a category colour or a person colour, read Known Conflicts items 1 to 5.
