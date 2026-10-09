# Merging your frontend onto the backend planner

> **Update, 9 Oct 2026.** Crowd estimates were cut: `lib/planner/crowd.js`, the "Simulate crowd" switch, the map's heat layer and the `crowd` field on options are gone, because there is no data source. The planner now uses the live weather forecast, and `weatherCase` is sent only when the demo rain switch is on. Where this guide mentions crowd, ignore it.


For Darius, before you push your frontend work. Everyone else working on the frontend can use it too.

**What happened:** `dev` now has Nicole and Faith's backend planner (`feature/backend-engines`), and the frontend uses it. The meeting area, the suggestions for each slot and "Search a place" come from `POST /api/meeting-area`, `/api/converge` and `/api/search` instead of the ranking code in `src/lib/planner/`. That old ranking is deleted, so there is one algorithm.

**What did not change in the switch-over:** every function in `src/lib/api.js` keeps its name, arguments and return shape. Slots, voting, the itinerary, rewards and auth work as before.

**Then a round of UI changes** landed on `dev` too (place photos, colour coding, a search radius, a meeting-point animation, a bigger map, Car instead of Grab, café discounts). Those touch screens and components, so they are listed separately in [2b](#2b-ui-changes-after-the-switch-over). If you changed the same screens, expect conflicts there; each row says what to keep.

---

## 1. Merge `dev` into your work before you push

Merge rather than rebase: you resolve conflicts once, not once per commit.

```bash
git status                      # commit or stash anything unsaved first
git fetch origin
git merge origin/dev            # on your own branch
pnpm install                    # the backend has new packages
```

If git reports conflicts, fix each file with the table below, then:

```bash
git add <the files you fixed>
git commit                      # finishes the merge
```

Then run the checks in [section 4](#4-check-it-works) **before** you push or open the PR into `dev`.

---

## 2. Where conflicts can happen

These are the only frontend files changed on `dev`. If you didn't touch a file, git takes the new version and there is nothing to do.

| File | What changed on `dev` | If you also changed it |
|---|---|---|
| `src/lib/api.js` | The "Planner, run on the backend" section, and the functions that call it, now call the backend and are `async`. See [api.js in detail](#apijs-in-detail). | Keep `dev`'s planner code, then add your changes back on top. |
| `src/lib/plannerApi.js` | **New.** The axios client, the requests, and the backend's field names converted to the ones the cards read. | Nothing to merge. Add new backend calls here, not in your components. |
| `src/lib/planner/suggestions.js` | Only `reconcileOptions`, `moreOptions`, `OPTIONS_START` and `OPTIONS_MAX` are left. | Keep `dev`'s version. If your code imported a deleted function, see [Deleted functions](#deleted-functions-and-what-to-use-instead). |
| `src/lib/planner/meetingArea.js` | Only `meetingResultLine` and `MIN_LOCATIONS` are left. | Same as above. |
| `src/lib/planner/timeOfDay.js` | Only `MEAL_WINDOWS` and `mealWindow` are left. | Same as above. |
| `src/lib/planner/crowd.js` | `CROWD_PENALTY` deleted. `CROWD_LABELS` has `unknown`, and `crowdText('unknown')` returns "Crowd unknown". | Keep both sides' changes. |
| `src/components/dev/DemoPanel.vue` | Each demo action runs through a small `act()` helper, so a failure shows in the panel instead of leaving the buttons disabled. | Keep `act()`, and wrap any new demo button in it. |
| `src/components/map/PlannerMap.vue` | One line in `drawHeat()`: skip places whose crowd is `unknown`. | Keep that line. |
| `src/lib/planner/__tests__/*.test.js` (3 files) | Tests for the deleted functions removed. | Keep `dev`'s version. |
| `src/lib/__tests__/api.backend.test.js` | **New.** Runs a whole session through `api.js` against the real backend. | Nothing to merge. |

### api.js in detail

If `api.js` conflicts, keep these from `dev` exactly as they are:

- `import * as planner from './plannerApi.js'` and `export { api } from './plannerApi.js'`. The axios client moved to `plannerApi.js`.
- `VERSION = 4` and `venues: {}` in `freshDb()`. `db.venues` remembers every venue the backend sends.
- `venueById` looks in `db.venues` first.
- The whole "Planner, run on the backend" section: `membersFor`, `computeMeeting`, `rankSlot`, `rankAll`, `rankedIds`, `takeTicket`, `syncOptions`, `applyTrigger`.
- `orUndo()`, and the writes wrapped in it (`setLocation`, `useMeetingArea`, `optOut`, `setPreferences`, `deleteSlot`, `restoreSlots`, `respondReplan`, `replan`). If the backend can't answer, these put the session back as it was instead of half-saving it.
- `getPlan`, `confirmPlan`, `addMoreOptions`, `searchVenuesForSlot`, `addOption`.

Two rules if you add or change functions in `api.js`:

1. **Await the planner.** `computeMeeting`, `rankSlot`, `syncOptions`, `applyTrigger` and `reopenVoting` are network calls now. Without `await`, the session saves before the backend answers.
2. **A write that calls the planner goes inside `orUndo(session, async () => { ... })`.** Put your checks that throw (like "This session has ended") before it.

### Deleted functions and what to use instead

| Deleted | Use instead |
|---|---|
| `scoreVenue`, `rankForSlot` | `api.getPlan(id)`. Each option has `score`, `walk`, `crowd`, `reasons`, `warnings` and `swap`, already ranked. |
| `chooseMeetingArea` | `session.meeting` / `session.area` from `api.getSession(id)`. |
| `unfitReason`, `WIDE_RADIUS_KM`, `SEARCH_RADIUS_KM` | `api.searchVenuesForSlot(...)`. Each result has `unfit` (`''` when it fits). |
| `indoorSwap` | `option.swap` from `getPlan`. |
| `isOpenDuring`, `fitsMealWindow`, `LAST_STOP_MRT_WALK` | Nothing. The backend only suggests places that are open and fit the slot. |
| `CROWD_PENALTY` | Nothing. The demo's "Simulate crowd" switch sends a crowd weight to the backend instead. |

`crowdLevel` and `crowdScore` are **not** deleted. `SessionMapView` still uses them for itinerary stops.

---

## 2b. UI changes after the switch-over

These changed screens and components. If you rebuilt one of these files, keep your layout and add back the parts in the right-hand column.

| File | What changed | Keep, if you rewrote the file |
|---|---|---|
| `views/PlannerView.vue` | "Search within" radius chips (Auto, 100 m to 3 km); "Leading: … · N votes" line per slot; empty and few-places messages with "Widen to …"; dimmed non-leading pins; radius circle on the map; photo in the map pop-up; Confirm dialog tie-break now `a.score - b.score` (lower is better). | `RADII`, `setRadius`, `leadText`, `emptyText`, `radiusFor`, the `:radius` and `muted` map props, `:behind` on `SuggestionCard`. |
| `views/GroupDetailView.vue` | "Finding the fairest meeting point…" in the list and on the map while the planner works; "Use …" disabled meanwhile; travel bars and minutes coloured by travel time, with a key. | `finding`, `:finding` on `PlannerMap`, `row.tone`, `TRAVEL_TONES`. |
| `views/EventView.vue`, `views/SessionMapView.vue` | Stop photos; stop numbers in category colours; category key on the itinerary map; points text says they buy café discounts. | `:image="placeImage(stop.venue)"`, `category` on map places, `CategoryKey`. |
| `views/LandingView.vue` | Points banner: what your points buy, with a link to the discounts. | `pointsLine` and the `BannerNote`. |
| `views/LeaderboardView.vue`, `views/ProfileView.vue` | "Rewards" is now "Café discounts" with a 3-step explainer (`id="rewards"` for links); Points tiles say what points are for. | `id="rewards"`, the `hint` on `StatTile`. |
| `components/event/SuggestionCard.vue` | Photo with category badge, category stripe, "Leading" tag, grey vote bar when `behind`. | `placeImage`, `crowdTone`, the `behind` prop. |
| `components/event/PlaceCard.vue`, `StopCard.vue` | Photos (`StopCard` has a new `image` prop); stop number in category colour; `RatingBadge` hidden when there is no rating. | |
| `components/map/PlannerMap.vue` | New props `finding` and `radius`; people coloured by travel time; stops coloured by category; `highlight` labelled "Leading", `muted` faded. | All of it: other screens rely on these props. |
| `components/ui/SplitView.vue` | Bigger map: 72dvh on phones, 3/5 of the width on desktop. | |
| `components/ui/StatTile.vue` | Optional `hint` line. | |
| `components/event/TravelConnector.vue`, `ui/AppIcon.vue`, `lib/planner/travel.js`, `itinerary.js` | **Grab is now Car** (`car` key, `carMinutes`, `car` icon). A plan saved with `grab` falls back to the default mode. | Use `car`, never `grab`. |
| `lib/planner/crowd.js`, `travel.js` | `crowdTone(level)` and `travelTone(minutes)`: one colour scale used everywhere. | Use these instead of local colour maps. |
| `styles/tokens.css` | `--travel-short`, `--travel-medium`, `--travel-long`. | |
| `router/index.js` | Links with `#section` scroll to it. | |
| **New:** `lib/placeImages.js`, `assets/places/*.jpg` + `CREDITS.md`, `components/map/CategoryKey.vue` | One Unsplash photo per kind of place; `placeImage(venue)` picks it. | Nothing to merge. |

`api.js` also gained `setRadius(id, metres)`, `session.findingMeeting`, `session.radius`, and per slot in `getPlan`: `empty`, `few`, `topVotes`, `tied`. A "pending" event shows work in progress; the planner store ignores it.

---

## 3. Rules for screens, so nothing breaks

These come from the backend's data. They apply to any screen you built or changed.

| Rule | Why |
|---|---|
| Get a venue from what `api.js` returns (`option.venue`, `stop.venue`), never with `VENUES.find(...)`. | Suggestions can be any of the backend's 1,513 venues. Ids like `cdc_570511` (CDC hawker sites) and `v25` (mock venues) aren't in `lib/mock/venues.js`. Only Home's `nearbyPlaces` still uses the local 63. |
| Don't re-sort options by score. If you have to, sort `a.score - b.score`. | The backend's `score` is a penalty: **lower is better**. `getPlan` already returns options best first. |
| Show crowd with `crowdText(option.crowd)`, and handle `'unknown'`. | Most CDC and mock venues have no crowd data. `crowdText` returns "Crowd unknown". |
| `venue.rating` can be `null`. Check before passing it to `RatingBadge`, which needs a number. | CDC sites have no rating. Others are out of 10, like before. |
| Show `e.message` when an `api.*` call fails, like `PlannerView` and `GroupDetailView` already do. | Any planner action can now fail with "Cannot reach the Jio planner…", which says how to fix it. |
| `searchVenuesForSlot` results: `unfitText()` in `PlannerView` knows `category`, `far`, `closed`, `meal` and `mrt`. Other codes (`capacity`, `diet:halal`…) show no text but still disable Add. | If you redesign that sheet, add text for those codes. |

New fields you can show on option cards (from `getPlan`), if you want:

| Field | Show it as |
|---|---|
| `option.explanation` | One line: why it ranked here ("50 min for whoever travels furthest and accepts CDC vouchers."). |
| `option.dietUnknown` | e.g. "Halal status not known" (`['halal']`). |
| `option.verify` | "Check the stall": the diet was only guessed from a stall name. |
| `option.approximate` | "About 25 min": travel time is an estimate. |
| `session.meeting.approximate` | The same, for the meeting area. |

---

## 4. Check it works

Run both servers, each in its own terminal:

```bash
pnpm dev:backend     # wait for "Jio backend listening on port 3000"
pnpm dev:frontend    # must say Local: http://localhost:5173/
```

**The frontend must be on port 5173.** If Vite says `5174`, another dev server is already using 5173. The backend only accepts requests from `http://localhost:5173` (`FRONTEND_ORIGIN`), so from 5174 every planner call fails with "Cannot reach the Jio planner". Stop the other server and start again.

Then:

```bash
pnpm --filter jio-frontend test    # frontend tests, including api.backend.test.js
pnpm build                         # frontend build
pnpm test                          # backend tests
```

`api.backend.test.js` starts the backend inside the test, so it doesn't need `pnpm dev:backend` running. If it fails after your merge, the frontend and backend no longer agree. The failing step tells you which part.

Then click through it once:

1. Demo tools → **Reset demo data**. Old saved data is cleared automatically anyway, because `VERSION` changed.
2. Create a session and invite friends.
3. Set your start. Demo tools → **Simulate friends submitting locations**. "Finding the fairest meeting point…" pulses on the map, then a meeting area and the line "Fairest for N people…" appear, with travel times in green, rust or red.
4. **Use this area** and pick categories. Each slot shows 3 options, best first. Some say "Crowd unknown".
5. Demo tools → turn on **Simulate rain**. An outdoor option shows "Outdoor · rain expected" and a **Swap for…** button. Press it: the indoor place replaces it and stays.
6. **Search a place** → "food stalls" → **Add** one. It stays in the slot.
7. Under **Search within**, pick **500 m**. A dashed circle appears on the map, and slots with fewer places say so with a **Widen to …** button.
8. **Simulate friends voting**. Each slot says "Leading: … · N votes", and the leader is labelled on the map. Then **Confirm plan**. The itinerary shows every stop with a photo, including CDC places, and Walk / MRT / **Car** between stops.

---

## 5. If something goes wrong

| You see | Do this |
|---|---|
| "Cannot reach the Jio planner at http://localhost:3000…" | Is `pnpm dev:backend` running? Is the page on `localhost:5173`, not `5174` or `127.0.0.1`? |
| A demo panel button stays disabled | Shouldn't happen any more: the error shows under the buttons. If it does, the action has no `act()` wrapper. |
| A venue shows as blank or `undefined` | That code looked it up in `VENUES`. Use the venue from `api.js` (rule 1 in [section 3](#3-rules-for-screens-so-nothing-breaks)). |
| Worst option shown first | Something sorts by `b.score - a.score`. Lower is better now. |
| `git merge` conflict you're unsure about | Keep `dev`'s side for everything listed under [api.js in detail](#apijs-in-detail), then re-add yours. Or ask Jonathan. |

Related docs:
- [backend/docs/planner-api.md](../../backend/docs/planner-api.md): every endpoint's request and response.
- [backend/docs/changes-and-frontend-guide.md](../../backend/docs/changes-and-frontend-guide.md): Nicole and Faith's guide that this switch-over followed.
