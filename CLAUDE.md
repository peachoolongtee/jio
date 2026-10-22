# Jio

Persistent project record for agents working in this repo. Keep it short: tasks and bugs live on the issue tracker, history lives in the work log, and this file holds what neither can tell you.

## Project Overview

Jio decides where a group should meet, fairly, and plans the outing around it. It is a graded IS216 group project by a six-person team. The repo owner is the team lead.

- **Shape:** a pnpm workspace with `frontend/` (Vue 3, Vite, Pinia, Leaflet on OneMap tiles) and `backend/` (Express on Node 24). The database is Supabase: Postgres, Auth and Realtime. Versions and scripts are in the `package.json` files; setup is in `README.md`.
- **Intended data flow:** the browser talks to Supabase directly for plain reads and writes, under row-level security. The backend exists for secrets and computation: the planner, OneMap routing and weather.
- **Three seams.** Change behaviour at these, and the rest of the code follows:
  - `frontend/src/lib/api.js`: every view and store reads and writes through its functions.
  - `backend/src/services/http.js`: every call to an external API goes through it, so stub mode can answer from fixtures.
  - `backend/src/db/supabase.js`: the server's token check, user-scoped client and service-key client.
- **Specification:** build spec v2 is kept outside the repo. `dev` has since grown a different product shape (sessions, not groups and events). Which one is the plan of record is an open decision on the tracker.

## Working Rules

- **`dev` is where work lands; `main` is held still.** Decided by the lead on 2026-10-11 for the pitch on 12 October. Nothing goes to `main` until the lead says. Work goes into `dev` through pull requests.
- **Commit and push only when the user asks.** When asked, make sequential commits with plain lowercase messages and no prefixes.
- **Code comments** are sentence case, and every function carries a "How to call" example.
- **pnpm only**, on Node 24.
- **Secrets:** report what kind of value a variable holds, never the value. Both `.env` files are git-ignored. `backend/.env` carries old database connection strings as comments; leave them for the lead to delete.
- **The live database is shared.** Before any schema change, list the project's migrations and tables. The account tables (`profiles`, `profile_private`, the sign-up trigger, `username_available`) were made by a teammate; build on them and leave them as they are.
- **Teammates' branches and pull requests are read-only.** Review them; change them only when the user says so.
- **Test database changes in a transaction that rolls back**, so no rows are left on the live project.

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues on `peachoolongtee/jio`. The one live map is issue #109, "Jio to the freeze", grouped by feature. The first map (issue #1) and the audit tracker (issue #47) were closed as records on 2026-10-11; every ticket of theirs that still describes work is under #109. See `docs/agents/issue-tracker.md`.

### Design language

`DESIGN.md` at the repo root records the design language as it ships: tokens, components, layout, motion, voice, and the known conflicts with this file's rules. Read it before building or changing any screen. Its machine-readable twin is `.impeccable/design.json`.

### Domain docs

Single-context: one `CONTEXT.md` glossary at the repo root, and `docs/adr/` when a decision earns a record. See `docs/agents/domain.md`.

### Handoffs

`docs/handoffs/2026-10-13-continue-on-another-machine.md` is where to start a session on a new machine: what is waiting on the lead, how he works, and the traps already met. `docs/handoffs/meeting-spots-and-roam.md` holds the meeting spots and Roam decisions.

## Current State

As of 2026-10-09. The Supabase foundation was built on branch `feat/supabase-foundation`, which sits on top of `dev`, and was sent to `main` through a pull request at the lead's request. `main` therefore also carries everything that was on `dev`. Run `git log --oneline origin/dev..origin/main` to see whether `dev` has caught up.

| Area | State |
|---|---|
| Frontend screens | Sign-up, sessions, meeting area, voting, itinerary, photos, leaderboard with seasons, rewards in JioCoins, profiles. Home shows every current meetup as a pin on the map, with a detail on hover and a list below, whose first row starts a new meetup. In development builds the sign-up screen and the demo tools can load a showcase: ten sessions, one in each state. A host can edit a session's title, date and times until it starts. A top bar from 744 px and a pill tab bar on phones. All data is in one browser's local storage. |
| Backend planner | Built on `dev`: `/api/meeting-area`, `/api/converge`, `/api/roam`, `/api/search`. Travel times and weather are internal estimates. Open to anyone. |
| Database | Session schema and access rules applied to the live `jio` project on 2026-10-09, then revised twice the same day after two reviews (three migrations). Since stages 2 and 3, a real account's sessions, members, invites, locations, meeting spots, suggestions and approvals are rows in it, read and written as described under "What a browser may write directly". `apply_session_plan` (stage 3) is written but not yet run on the live project: run `db/tests/apply_session_plan.sql` in a rolled-back transaction first. |
| Login | On `dev`: sign-up, login and sign-out with Supabase accounts, a login screen and guard, and the planner client sends the login token. Never run against the real project; email confirmation is still on there. The backend's token check and `GET /api/me` are as before. |
| What is saved where | For a real account, in Supabase: the account and profile, and a session through the meeting-spot step (members, invites, starts and ends, spots, suggestions, approvals, the confirm and the known place). Votes, plans, photos, friends and JioCoins, and everything for the demo and local accounts, are in one browser's local storage. |
| External APIs | The planner uses the live data.gov.sg forecast through the HTTP helper. OneMap gives address search (`GET /api/places/search`, no account needed) and public transport routing, which switches on with `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` (Faith has an account) and falls back to the estimate whenever it cannot route. Google Places (New) adds restaurants, cafés, malls and private activities per request, with photos through `GET /api/places/photo`; it is off without `GOOGLE_MAPS_API_KEY`. See `backend/docs/external-apis.md`. |
| Venues | 1,782 in the planner's pool by default: 63 hand-made and curated, 1,302 CDC sites, and 417 of 483 places saved from OneMap's government lists (`backend/src/db/mock/onemap-places.json`), with NEA's hawker closure dates to the end of 2026. The 36 invented venues and the sample visit history are added only with `INCLUDE_FICTIONAL_VENUES=1` (1,818), which the tests set. Of these, only the 36 invented venues carry review counts; the others score as 4.0 when ranked (a rating counts as far as its reviews). |
| End-to-end tests, deploy | Not started. |

## Architecture Decisions

Each is recorded in full on the ticket named. Read the ticket before changing the behaviour.

- **Token check:** the backend verifies login tokens locally and loads data as the signed-in user, so the database's rules decide access. The service key is for server-owned writes only. Ticket #8.
- **Stubbing:** one HTTP helper answers from fixtures in stub mode; a request header picks the scenario. Ticket #9.
- **Constraints:** dietary needs filter food venues only; CDC and Culture Pass are ranking boosts. Ticket #35.
- **What the group sees of a member is their area, never the exact place.** Area ids are on `session_members`. Labels and coordinates are in `session_member_places`, which only the owner and the server read.
- **Private planner needs** (home area, dietary, budget, step-free) sit in `profile_private`. Only the owner and the server read them, through `session_member_needs()`.
- **What a browser may write directly:** a new session; a host's title, date and times, start and cancel; a member's own start and end area and exact place while the session is open; a member's own "Works for me" while it is locating; a host's invite links. **Everything else goes through the server, all of it through the one function `apply_session_plan`:** the spots, suggestions, the host's confirm and known place (stage 3), opting out and rejoining, leaving and removing a guest while inviting or locating (a member's row is deleted only there, with the spots worked out again in the same write; voting and later are refused until stage 4), and later the radius, slots, options, the itinerary and the ledger. The function writes nothing if the session's version or status is not what the server loaded, raises the version only when something changed, and never moves a chosen meeting area. A run that priced the spots again moves their `computed_at` forward without raising the version, which is how a page tells a start was never priced. `sessions.banner` is `null` or `{ text, at, approvalsRemoved: true }`, written only by that function (`backend/docs/planner-api.md`). The trigger `guard_session_changes` and the access rules enforce the rest.
- **Token check:** the server holds its own copy of Supabase's public signing keys and verifies only `ES256` and `RS256` tokens whose key id it holds. It answers 503 when it cannot reach Supabase and has no keys. After a failed refresh it waits a minute before asking again, and it drops keys older than 24 hours. `SUPABASE_ALLOW_LEGACY_TOKENS=1` admits `HS256` tokens by asking Supabase.
- **Errors:** only an error raised by the body parser may answer a 4xx by its own status. Any other uncaught error answers 500 and is logged, so an external API's 401 never reaches the browser as one.
- **`db/schema.sql` and `db/policies.sql` describe a fresh build** and run together as one transaction. A change to a table that already exists on the live project needs its own migration, with the same statements added to the files.
- **Weather:** the planner scores against the live two-hour forecast and says where the weather came from in `weather.source`. A simulated forecast needs `ALLOW_SIMULATED_WEATHER=1` or stub mode; otherwise `weatherCase` is ignored, never refused, because the frontend sends it on every ranking.
- **One error shape:** `{ error: '<code>', message }` on every route. Decided by the lead on 2026-10-09, replacing the nested shape on ticket #8.
- **Rate limit:** the planner routes share a per-caller limit set in `index.js`. `createApp` applies none unless given `planRateLimit`, so tests are unaffected.
- **Sample data: partly labelled, by the lead's decision of 2026-10-10.** The lead took the leaderboard pull request as shipped, which removed the "Sample" note from the leaderboard, Home's places and the Rewards banner. It remains on the place detail and on other people's profiles; rewards use invented café names; distance-based times say "about". Do not add or remove notes without the lead.
- **Cut on 2026-10-09:** crowd estimates, "Ask AI", and the contacts and location steps in sign-up. Do not bring them back without the lead.
- **Contrast: the brand red is `#ff385c`, by the lead's decision of 2026-10-10.** White text on it is 3.52:1, below the 4.5:1 minimum, and three category and three person colours are also under it. `DESIGN.md` lists each pair under "Known Conflicts". Do not darken them without the lead; do not add new white-on-red text without reading that section.
- **OneMap is a shared budget.** The account allows 300 calls a minute for everyone. One request routes at most 60 trips, whole candidates only; the whole server makes at most `ONEMAP_CALLS_PER_MINUTE` calls (240 by default) across routing, search and login; a trip over either limit uses the estimate and is flagged `approximate`. Do not add a OneMap call that bypasses `createOneMap`'s budget.
- **Google is a paid budget.** Every Google call goes through the budget in `createGooglePlaces`: `GOOGLE_CALLS_PER_MINUTE` (60 by default) for nearby searches and photos together, three failures pause it for a minute, and each call times out after 3 seconds. A call that queued for a slot for a second or more is refused (`waited_too_long`) when the last completed call failed, and a lane is not charged for a call refused before it made a request. Google failing never fails a planner request. Do not add a Google call that bypasses it, and never write Google content to a file: fixtures are invented. **Google tops up, it does not flood** (ticket #149, decided with the lead on 16 October 2026): it is asked only about categories where we know fewer than 6 open places near the meeting point (the answer's `google` block says `not_needed` with `reason: 'enough_own_places'` otherwise), food and drink need 20 Google reviews to be added, at most 2 of the first 5 places of a category are Google's, and a rating counts as far as its reviews (`weightedRating` in `scoring.js`; a place with no rating or no review count, which is every curated, OneMap and CDC place, counts as 4.0, while the invented mock venues, served only with `INCLUDE_FICTIONAL_VENUES=1`, carry review counts and are scored on their ratings). The count of our own places uses the engine's own hard filters (`hardFilterContext`), and the cap of 2 Google places is on the first 5 places whatever `topN` is. The rating weight scales with the weights a request sends, so its share stays the same.
- **Saved places are repaired and filtered in code, not by hand.** `onemap-places.json` is written only by `pnpm build:onemap-places` (network, needs the OneMap account) or `pnpm repair:onemap-places` (no network). Duplicates, places that are not somewhere to go, and closed weekdays are worked out at load in `backend/src/db/venues.js`.
- **A guessed price makes no claim for any place** (the lead's decision of 2026-10-11): a venue with `dataQuality.priceAssumed`, whether from OneMap, Google or CDC, gets no "Budget friendly" tag and no "within budget" sentence, through `priceIsKnown` in `backend/src/planner/scoring.js`. The price still counts in the score and in the `max_price_pp` filter. Only the curated and mock venues with hand-entered prices can carry the claim.
- **The AI is a paid budget too.** `POST /api/itinerary/arrange` asks an AI to choose among orders the rules allow. Every AI call goes through one budget (`ITINERARY_AI_CALLS_PER_MINUTE`, 20 by default, 2 at once), a 10-minute cache, a pause after three failures and an 8-second deadline; anything else answers by the rules. Only venue names, kinds, times and the weather go to the provider, never anything about a person.
- **Local accounts in a production build are off** when Supabase is set up, and a production build with no Supabase settings refuses to run. `VITE_ALLOW_LOCAL_ACCOUNTS=1` turns them on, which a deployed demo needs.
- **One way to change a confirmed stop's place.** `changeStopPlace` in `frontend/src/lib/api.js` is behind both the rain swap and Replace: the host only, refused when the stop no longer holds the place the caller saw, and the stop never starts earlier than the time the planner checked it for. Do not add a second way.
- **Meeting spots:** a planner answer computed before the host confirmed is never applied afterwards, and a failed write takes back only its own change (`latestAnswer` and `orUndo` in `frontend/src/lib/api.js`). Naming an area in `include` never changes the planner's own pick.
- **Google places may not be shown on or beside the OneMap map** (Google's terms, read on 2026-10-11). No screen shows them yet; read the research on the map before building one that does.
- **Planner limits:** every list, string and number in a planner request has an upper bound, held in one `MAX` block in `backend/src/routes/plan-schemas.js`.
- **Routes added to the Express app go in through `createApp({ mount })`**, because the "not found" handler is last.
- **Dietary needs (ticket #107):** food places are filtered strictly for the group's needs (`dietPolicy` in `frontend/src/lib/api.js`, sent as the request's `dietPolicy`, which leaves `unknownPolicy` for `near_mrt`, `step_free` and `sockets` as it was); a drink stop is changed only by halal, which keeps bars out (`meetsDiet` in `backend/src/planner/filters.js`). The group's needs travel on the first member sent, so a need is never tied to a person, even in the request. Only the signed-in person's own need and the sample friends' (`SAMPLE_DIETARY`: Faith halal, Nicole vegetarian) are known until sessions are on the server (#80). Fewer than 3 food places that fit offers "Show places we couldn't confirm" (`session.unconfirmed`); those are ranked by how many of the group's needs they likely meet, most first, then by score (`byDietFit` in `backend/src/planner/engine.js`, also when the shortlist is cut). A need changed mid-vote re-ranks and shows a banner that names nobody. Caveats are tags on the card ("Halal likely", "Halal not confirmed" with a warning icon), halal brown and vegetarian and vegan green (`--diet-halal-*`, `--diet-veg-*`, both over 6:1). Each person is asked to "Confirm dietary needs" once per outing when it reaches voting (`DietaryConfirm`, `session.dietChecked`), with the others' needs selected and unnamed. A person's picks there, and on Vote's chips, are for that outing only (`session.dietMine`, read first by `dietaryOf(id, session)`); the profile is their standing setting and starts each outing. Once sessions are on the server this needs a per-outing column, which waits for the lead. With fewer than three people joined nobody else's needs are listed (`others` is empty on the server and in `othersNeeds`), so there is no "Unselect"; the places are still filtered for them. A need someone else has can be unselected, in an outing of three or more, after a second dialog ("Unselect halal?") reminds the person that someone in the outing needs it; the outing then stops filtering for it (`session.dietDropped`, `confirmDiet(id, mine, dropped)`), and selecting it again brings it back. "Group dietary needs" on Vote (the needs selected below, as tags), laid out like "Search within", holds the same Halal, Vegetarian and Vegan chips (`DietaryChips`, with the same "Unselect halal?" warning), saved at each tap. Any change to the group's dietary filter picks the places again (`syncOptions(session, { fresh: true })`): only voted places that still fit stay, the rest are the planner's best for the new needs. Sign-up has no dietary question (the ticket's "Not in sign-up"): a popup asks once per account ("Any dietary needs?", `DietaryFirstAsk` in the app frame, opened by `auth.signUp`, and for a real account never asked, by `auth.init` and `auth.signIn`), and saves the answer on the profile. That it was asked is remembered in this browser (`jio-diet-asked:<account id>`), and a saved need counts as asked; a reload keeps the question until it is answered. The ticket's question at the first outing created or joined was tried and replaced by this at the user's word (21 October 2026). An account that must confirm its email first is asked at its first sign-in. For a session on the server, the needs come from `GET /api/sessions/:id/dietary` (needs together, no names, read with the service key through `session_member_needs()`; `outingDietary` in `api.js`). It is unused on screen until voting moves to the server, because a shared session cannot open Vote yet.
- **Halal checked against MUIS (18 October 2026):** six curated hawker centres carry `halal: { muisStalls, checked }` in `frontend/src/lib/mock/venues.js` (Newton 9, Serangoon Garden 3, Tiong Bahru 2, Maxwell 1, Chinatown Complex 1, Kovan 209 1), which the adapter makes halal `likely` (one stall's certificate is not the centre's) with `dataQuality.halalSource: 'muis'` and `halalScope: 'stalls'`; their cards show "9 MUIS halal stalls" and "Halal likely, check the stall". A single certified restaurant would be `options`, verified (`halalScope: 'venue'`); none is certified today. No curated restaurant, café or stall is certified. The search and the spot-check are in `docs/dietary/halal-check-2026-10-18.md`. Rebuild with `pnpm --filter jio-backend build:venues` after a change, and search again before the final: certificates expire.
- **Venue ids may be up to 120 characters** in `currentOptionIds` and `excludeVenueIds` (`MAX.venueId`): 32 saved OneMap places have ids of 81 to 86, which the old limit of 80 refused once one became an option.

## Agent Delegation Log

The full record is `docs/agents/work-log.md`. Add a round there before delegating, and fill in each result as it arrives. Latest round:

**Round 1, 2026-10-09, project initialisation: completed.** Four read-only agents reviewed the unpushed branch, the schema, the open frontend pull request, and ran the checks. They found three significant defects in the login check and a blocker in the schema.

**Round 2, 2026-10-09, fixes: completed.** A backend agent hardened the login check; the lead revised the schema on the live project. An independent tester confirmed the results. A second review asked for more changes.

**Rounds 26 and 27, 2026-10-13, teammates' pull requests audited and merged, the staging branch landed, weather on the screens.** `dev` now holds everything built so far; `main` is still at its state before the audits. The email lookup on the live project is server-only.

**Rounds 24 and 25, 2026-10-11 and 12, the lead's changes to the pitch build, and stage 1 of sessions on the server.** The settled Locate page, the back button, reviews and scores on the vote cards went to `dev`; more card changes wait in a pull request; the CDC price rule and stage 1 (the signed-in account's id everywhere, reviewed and fixed) are on `integration/after-pitch`. Implementation was paused at the lead's word after stage 1 merged.

**Round 23, 2026-10-11, the tracker cleared, the demo tour checked, and each real service run once.** Open tickets went from 66 to 36 under one map. With the lead's keys: OneMap routing, the live forecast and Gemini answered; with the Google key set every converge result was a Google place.

**Rounds 21 and 22, 2026-10-11, five pieces built in parallel and the place-search pull request audited.** Weather's backend half, Roam in a meetup, the demo tour and the session schema are on `integration/after-pitch`; the place-search fixes are on `feat/real-search-integration`, held for the Google decision.

**Round 28, 2026-10-13, two pull requests from darryl5942 audited, fixed and sent to `dev`: completed.** Two read-only reviewers, then two frontend agents: an edit-profile page with a password tab, and replacing a stop of a confirmed itinerary. Replacing a stop is for the host only and shares one function with the rain swap.

**Round 20, 2026-10-11, decisions and a new map.** Dietary needs, weather, the demo tour and invites were settled; the map is issue #109.

**Round 19, 2026-10-11, the team's walkthrough: completed.** Eighteen items reconciled; nine built for the pitch by three frontend agents, the rest on the map.

**Round 18, 2026-10-11, audit of login, the AI order of stops and meeting spots, and their fixes: completed.** Six reviewers, then five fix agents. All three went to `dev`.

**Round 12, 2026-10-11, audit of the Google Places pull request and its fixes: completed.** Two read-only reviewers and a verifier found nothing unsafe and twelve defects; two backend agents fixed them. Went to `main` from `feat/google-places-integration`.

**Round 13, 2026-10-11, Home's start row and showcase demo data: completed.** One frontend agent. Went to `main` from `feat/demo-showcase`.

**Round 14, 2026-10-11, decisions on meeting spots and Roam.** Nothing built; the handoff is `docs/handoffs/meeting-spots-and-roam.md`.

**Round 15, 2026-10-11, meeting spots, slices 1 and 2: built on `feat/meeting-spots`.** A backend agent added runners-up and named areas to `/api/meeting-area`; a frontend agent added spots, approvals, confirm and the known place to the data layer (save version 9). The lead checked both.

**Round 16, 2026-10-11, the Locate screen for meeting spots (slice 3): built on `feat/meeting-spots`.** A frontend agent built the spot list, "Works for me", "Suggest a spot", the host's confirm, "We already have a place", the map pins and the demo tools. The lead opened it in a browser, and found and fixed one defect (the page stayed on Locate after confirming). Slices 4 to 6 (Roam, then review) are next.

**Round 17, 2026-10-11, real sign-up and login, the frontend half: built on `feat/login`.** Three frontend agents built the account layer over Supabase Auth, the login screen with its route and guard, and the planner client sending the token. The lead checked each and opened the screens. Nothing has run against the real Supabase project: that needs `VITE_SUPABASE_URL` and `VITE_SUPABASE_ANON_KEY` in `frontend/.env` and the lead's own sign-up. The planner routes do not require a login yet. Rounds 15 and 16 (meeting spots) are on `feat/meeting-spots`.

**Rounds 10 and 11, 2026-10-10, Home as a map of every meetup, and four problems the lead found by using the app: completed.** One frontend agent each. Both went to `main` from `feat/home-meetups-map`.

**Round 9, 2026-10-10, OneMap made safe and everything reconciled: completed.** A backend agent capped OneMap calls per request and per process and fixed the token handling. The defect fixes, the external-APIs pull request and these changes went to `main` together from `feat/onemap-and-defect-fixes`.

**Round 8, 2026-10-10, leaderboard defects fixed and the external-APIs pull request audited: completed.**

**Round 7, 2026-10-10, audit of the leaderboard pull request and the design document: completed.** Two read-only reviewers and a documentation agent. The pull request was merged as it is; the findings are on the pull request and on a tracker ticket.

**Rounds 5 and 6, 2026-10-09, audit of the session-flow pull request and its fixes: completed.** Three read-only reviewers, then four frontend agents on separate files. The pull request's commits, the fixes and round 4 went to `main` together from `feat/session-flow-integration`.

**Round 4, 2026-10-09, unblocked backend work: completed.** Live weather, a rate limiter, the flat error shape, CI for the frontend tests, and a design for the session endpoints (on ticket #80).

**Round 3, 2026-10-09, second-review fixes: completed.** A backend agent fixed `GET /api/me`, the error handler and the key refresh; the lead tightened two constraints and one rule on the live project. The lead verified both. No further review was run on round 3.

## Work Completed

See the closed tickets on the tracker, and `docs/agents/work-log.md` for agent rounds. On `feat/supabase-foundation`, 26 commits on top of `dev`: env example update, the session schema and access rules, planner input limits, JSON error answers, Supabase clients, the login check and its tests, the fixes from review rounds 2 and 3, and these agent docs.

## Work In Progress

A ticket's assignee is its owner. Query the tracker for open, assigned tickets. No agent work is running. Finished work that waits for the pitch to pass is on `integration/after-pitch` and goes to `dev` as one pull request.

## Outstanding Tasks

The tracker is the source of truth: the open tickets under issue #109, in the order its Notes give. First the lead's account and key checklist, then sessions on the server in five stages.

## Known Issues

Recorded as tickets under issue #109. The ones that change how you work today:

- **Sign-up and login are built and have never met the real project.** Email confirmation is still on there, and no real token has been checked by `GET /api/me`.
- **A Google key changes every ranking.** With `GOOGLE_MAPS_API_KEY` set, a real converge returned ten Google places out of ten, stalls in one food court, one of them first on a single review. Google's terms do not allow them beside the OneMap map. Leave the key empty until the lead decides. Ticket #149 changes how Google competes (a top-up, at most 2 of the first 5, reviews-weighted rating, one place per building); that is tested with invented fixtures only, and no real ranking has been run with the key since.
- **The planner routes accept anyone.** The login check exists but is not applied to them, because the frontend sends no token yet.
- **Points, season prizes and voucher codes are computed in the browser** and can be edited there. They are labelled as a demo and must not be presented as real.
- **A real account works alone, and only in one browser.** The signed-in person now comes from the account (`currentUserId()` in `frontend/src/lib/currentUser.js`, `auth.myId` in components), and a real account's data is stored under its own id. Sessions are shared through the meeting-spot step (stages 2 and 3); votes and the plan still are not, and a real account has no friends. The stage 3 pieces are tested against stand-ins only and have not met the live project. No real sign-up has been run beyond the lead's two-device check of stage 2.
- **An old database password is in git history.** The repo must stay private until the lead resets it.
- **CI has no end-to-end step.** It runs both unit suites and the build on pull requests and on pushes to `main` and `dev`.
- **A host's account cannot be deleted**, and nothing deletes sessions. Account erasure needs a server route.

## Testing and Verification

Commands are the scripts in the root `package.json`. Record real output here, with the date and commit.

| Date | Commit | Command | Result |
|---|---|---|---|
| 2026-10-09 | `41aface` | `pnpm test` | 217 passed, 1 skipped, 16 files |
| 2026-10-09 | `41aface` | `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| 2026-10-09 | `41aface` | `pnpm build` | Succeeded |
| 2026-10-09 | working tree after round 2 | `pnpm test` | 241 passed, 1 skipped, 16 files |
| 2026-10-09 | working tree after round 2 | `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| 2026-10-09 | working tree after round 2 | `pnpm build` | Succeeded |
| 2026-10-09 | live `jio` database, revised schema | 68-step access-rule test, rolled back | 68 of 68 passed, no rows left |
| 2026-10-09 | live `jio` database | Function and policy fingerprints against `db/` | 15 functions and 24 policies match |
| 2026-10-09 | `91b9434` (round 3) | `pnpm test` | 253 passed, 1 skipped, 16 files |
| 2026-10-09 | `91b9434` (round 3) | `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| 2026-10-09 | `91b9434` (round 3) | `pnpm build` | Succeeded |
| 2026-10-09 | live `jio` database, round 3 changes | 13-step test, rolled back | 13 of 13 passed, no rows left |
| 2026-10-09 | working tree after round 4 | `pnpm test` | 317 passed, 1 skipped, 18 files |
| 2026-10-09 | working tree after round 4 | `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| 2026-10-09 | working tree after round 4 | `pnpm build` | Succeeded |
| 2026-10-09 | working tree after round 4 | One planner request against the real data.gov.sg forecast | `weather.source: live`, 369 ms, then 6 ms cached |
| 2026-10-09 | `feat/session-flow-integration` after round 6 | `pnpm test` | 317 passed, 1 skipped, 18 files |
| 2026-10-09 | `feat/session-flow-integration` after round 6 | `pnpm --filter jio-frontend test` | 186 passed, 20 files |
| 2026-10-09 | `feat/session-flow-integration` after round 6 | `pnpm build` | Succeeded |
| 2026-10-10 | `65567bb`, the leaderboard pull request's head | `pnpm test` | 317 passed, 1 skipped, 18 files |
| 2026-10-10 | `65567bb` | `pnpm --filter jio-frontend test` | 192 passed, 22 files |
| 2026-10-10 | `65567bb` | `pnpm build` | Succeeded |
| 2026-10-10 | `feat/onemap-and-defect-fixes` after round 9 | `pnpm test`, also with outbound calls blocked | 383 passed, 1 skipped, 20 files, both times |
| 2026-10-10 | `feat/onemap-and-defect-fixes` after round 9 | `pnpm --filter jio-frontend test`, `pnpm build` | 229 passed, 25 files; succeeded |
| 2026-10-10 | `feat/onemap-and-defect-fixes` after round 9 | OneMap route calls for one meeting-area request, 30 members, stubbed | 59 by default and 60 at the widest setting (480 and 1,108 before) |
| 2026-10-10 | `feat/home-meetups-map` after round 11 | `pnpm --filter jio-frontend test`; `pnpm test`; `pnpm build` | 324 passed, 30 files; 383 passed, 1 skipped; succeeded |
| 2026-10-11 | `feat/google-places-integration` after round 12 | `pnpm test`, also with outbound calls blocked | 547 passed, 1 skipped, 24 files, both times |
| 2026-10-11 | `feat/google-places-integration` after round 12 | `pnpm --filter jio-frontend test`; `pnpm build` | 324 passed, 30 files; succeeded |
| 2026-10-11 | `feat/meeting-spots-integration` after round 19 (all of `dev`) | `pnpm test`; `pnpm --filter jio-frontend test`; both also with outbound calls blocked; `pnpm build` | 815 passed, 2 skipped, 29 files; 807 passed, 56 files; no call attempted; succeeded |
| 2026-10-11 | live `jio` database | Row counts | 1 account, 1 profile; every session table empty |
| 2026-10-13 | `dev` at `16d4d08`, on the Windows machine | frontend suite; backend suite; build | 1,448 passed, 1 failed, 86 files; 1,162 passed, 1 failed, 2 skipped, 37 files; succeeded. Both failures are that machine's line endings (`identityScan.test.js` and the saved-places test) |
| 2026-10-13 | round 28's two integration branches merged together, on the Windows machine | frontend suite, the build; each branch alone also with outbound calls blocked | 1,568 passed, 1 failed (the same line-ending test), 89 files; succeeded; no call attempted |
| 2026-10-11 | `feat/demo-showcase` on top of round 12 | `pnpm test`; `pnpm --filter jio-frontend test`; `pnpm build` | 547 passed, 1 skipped; 353 passed, 33 files; succeeded |
| 2026-10-11 | the pull request before the fixes, and `main` | OneMap route calls for one meeting-area request, 30 members, stubbed | 60 on both (round 9 recorded 59; the cap is 60) |
| 2026-10-11 | `feat/meeting-spots` at `2e1643d`, before round 15, on the Windows machine | backend suite; frontend suite; build | 546 passed, 1 failed, 1 skipped, 24 files; 324 passed, 30 files; succeeded. The failure is a line-ending test (see round 15) |
| 2026-10-11 | `feat/meeting-spots`, working tree after round 15 | backend suite, also with outbound calls blocked | 677 passed, 1 failed (the same test), 2 skipped, 26 files, both times |
| 2026-10-11 | `feat/meeting-spots`, working tree after round 15 | frontend suite; build | 376 passed, 31 files; succeeded |
| 2026-10-11 | an untouched export of `origin/main` at `2e1643d` | `meeting-area-baseline.test.js` with its fixture, three times | 85 of 85 passed each time |
| 2026-10-11 | `feat/meeting-spots`, working tree after round 16 | frontend suite; build | 398 passed, 32 files; succeeded |
| 2026-10-11 | `feat/meeting-spots`, working tree after round 16, stub backend | Browser check of the Locate screen at 320, 375, 744 and 1280 px | No horizontal overflow; suggest, "Works for me", confirm and the known place all work and land on Vote; no console errors |
| 2026-10-11 | `feat/login` at `aa64d15`, before round 17, on the Windows machine | frontend suite; build; backend suite | 353 passed, 33 files; succeeded; 544 passed, 3 failed, 1 skipped (Windows path and line-ending tests, fixed in part on `feat/meeting-spots`) |
| 2026-10-11 | `feat/login`, working tree after round 17 | frontend suite; build | 457 passed, 40 files; succeeded |
| 2026-10-11 | `feat/login`, working tree after round 17, made-up Supabase values | Browser check of `/login` and `/signup` at 320, 375, 744 and 1280 px | No horizontal overflow; the guard remembers the page and drops an outside address; a failed login keeps the email and empties the password |
| 2026-10-10 | `fix/leaderboard-audit-defects`, working tree | `pnpm --filter jio-frontend test` | 229 passed, 25 files |
| 2026-10-10 | `fix/leaderboard-audit-defects`, working tree | `pnpm test`, `pnpm build` | 317 passed, 1 skipped; succeeded |
| 2026-10-10 | external-APIs pull request merged with `main`, throwaway worktree | `pnpm test`, also with outbound calls blocked | 334 passed, 1 skipped, both times |
| 2026-10-09 | `feat/session-flow-integration` after round 6 | Browser check at 320, 375 and 1280 px | No horizontal overflow on six routes; sign-up completes with the date-of-birth step |
| 2026-10-09 | `feature/external-apis` merged with `main` (working tree) | `pnpm test` | 334 passed, 1 skipped, 19 files |
| 2026-10-09 | `feature/external-apis` merged with `main` (working tree) | `pnpm --filter jio-frontend test` | 186 passed, 20 files |
| 2026-10-09 | `feature/external-apis` merged with `main` (working tree) | `pnpm build` | Succeeded |
| 2026-10-09 | `feature/external-apis` merged with `main`, real OneMap account | Live server: roam, meeting area, address search | Roam: live weather, 9 of 9 trips routed by OneMap. Meeting area for Tampines + Clementi: Bugis, 28 min worst, 32 routes. Address search found Bishan MRT |
| 2026-10-11 | `integration/after-pitch` with the demo tour merged in (`14b1cd5`) | `pnpm test`; `pnpm --filter jio-frontend test`; `pnpm build` | 897 passed, 2 skipped, 32 files; 941 passed, 62 files; succeeded |
| 2026-10-11 | `feat/demo-tour`, development server, no backend | `/demo`, then each of the eight checkpoints by the strip's next button, about 560 px wide | Lands on Home at checkpoint 1; all eight open their screen; no horizontal overflow; no page errors |
| 2026-10-11 | `feat/real-search-integration`, working tree | `pnpm test`, also with outbound calls blocked; frontend suite; build | 986 passed, 2 skipped, 34 files, both times; 886 passed, 59 files; succeeded |
| 2026-10-11 | `dev` at `36a8bf0`, the lead's real keys, own server on a spare port | One call to each real service, by a verifier agent | OneMap: logged in, search 0.16 s, meeting area for Tampines and Clementi 3.2 s cold (10 trips routed, 22 estimated) and 2 ms warm. Forecast: live. Gemini: an order and a sentence in 1.1 s. Google: 19 places added; all 10 converge results were Google places. No server warnings. Not run: a Google photo, a real login token |
| 2026-10-12 | `integration/after-pitch` with stage 1 merged in (`94d24ac`) | `pnpm --filter jio-frontend test`; `pnpm test`; `pnpm build`, exit codes read | 1112 passed, 71 files; 899 passed, 2 skipped; succeeded |
| 2026-10-12 | `feat/sessions-stage-1-account` after the review's fixes | The same three, the frontend also with outbound calls blocked; a search of the built files for the development-only account tools | 1112 passed both times, nothing blocked; 899 passed, 2 skipped; succeeded; none found |
| 2026-10-17 | `review/pr-160` (#160 merged with `dev`, then the review's fixes) | `pnpm test`, also with outbound calls blocked; `pnpm --filter jio-frontend test`; `pnpm build`, exit codes read | 1248 passed, 2 skipped, 40 files, both times, nothing blocked; 1829 passed, 111 files; succeeded |
| 2026-10-18 | `feat/dietary-needs`, working tree on `5b83a4e`, on the Windows machine | backend suite; frontend suite; build | Backend 1250 passed, 4 failed, 2 skipped: `onemap-limits` and `onemap-snapshot` fail on `dev` too, and `meeting-area-include-isolation` and `rate-limit` pass on their own (40 of 40). Frontend 1738 passed, 24 failed, all under load beside two dev servers: the 19 files rerun one at a time pass except `identityScan` (fails on `dev` too) and `plannerAuth` (passes 25 of 25 with `VITE_API_BASE_URL` blank; this machine's `frontend/.env` sets it). New: `dietaryNeeds.test.js` 12 of 12, backend dietary tests in `venues.test.js`, `plan-routes.test.js` and `limits.test.js`. Build succeeded |
| 2026-10-18 | `feat/dietary-needs` with `GET /api/sessions/:id/dietary`, working tree on `5b83a4e` | frontend suite one file at a time; backend suite; build | Frontend 1843 passed, 2 failed (`identityScan`, fails on `dev` too; `plannerAuth`, passes with `VITE_API_BASE_URL` blank). Backend 1256 passed, 3 failed (`onemap-limits` and `onemap-snapshot` fail on `dev` too; `rate-limit` passes 30 of 30 alone). Build succeeded |
| 2026-10-18 | `feat/dietary-needs`, after the dialog fix and the tag colours | Browser stress test, stub backend: "Confirm dietary needs" by a real click, then five reloads; a need added in the dialog; 12 rapid presses of the unconfirmed switch; the tags' computed colours. A data-layer stress test of 40 overlapping writes, three runs | Found and fixed: the dialog reopened after Confirm, because its watcher returned a new list on every read and fired when the session was read again before the plan. Now: closed after Confirm and on all five reloads; the need saved and the outing re-filtered with a banner; the switch's saved state matches the screen, no vote on a dropped place, no page errors; tags #7c4a1e and #166534. A dialog left mid-fade while the browser pane was hidden finished when it drew again (the pane pauses frames). The stress test passed 3 of 3. Backend suite one file at a time: 1258 passed, 1 failed (`onemap-snapshot`, fails on `dev` too). Build succeeded |
| 2026-10-18 | `feat/dietary-needs`, stub backend on 3011, Supabase off, demo account | Browser check of Vote, Roam, the profile and the outing question, at 1280 and 375 px | The line under Eat, "likely" and "not confirmed" caveats, the offer with 0 and 1 fitting, the way back, a need changed on the profile (banner names nobody, votes on dropped places cleared), Roam's line and offer, the question saved and skipped once (since replaced by "Confirm dietary needs" on Vote, checked the same day: opens with the group's needs locked on, closes and stays closed after Confirm; caveats now tags). No horizontal overflow. Found and fixed: the question's Save failed to copy a reactive list |
| 2026-10-20 | `feat/sessions-stage-3-integration` (stage 3, both halves, after review fixes) | `pnpm test`, the frontend suite, both also with outbound calls blocked; `pnpm build`; `apply_session_plan` test on the live project in a rolled-back transaction | 1453 passed, 2 skipped; 2019 passed; nothing blocked; succeeded; 76 of 76 steps passed, nothing left |
| 2026-10-23 | `review/pr-177` (#177 merged with `dev`, then the review's fixes), working tree | `pnpm --filter jio-frontend test`, also with `TZ=UTC` and with outbound calls blocked; `pnpm test`; `pnpm build`, exit codes read; a browser check on a development server with a delayed backend | 2056 passed, 127 files, all three times, nothing blocked; 1547 passed, 2 skipped, 50 files; succeeded; confirming a spot at 375 and 820 px reads "Confirming…" on the footer button (the map pane is hidden, so no spinner), and at 1280 px the spinner covers the map as well |

Not yet verified: a real user's login token against `GET /api/me`, a Google photo, and anything end to end.

## Next Steps

Follow the map, issue #109. In short:

1. After the pitch on 12 October, merge `dev` into `main` once and tag it.
2. The lead's account setup: email confirmation off, the test project, the database password reset, real keys in `backend/.env`. Then run each real service once; none has been.
3. Sessions on the server, in five stages, starting with the signed-in account's id in place of the hard-coded one. The endpoint design is on its ticket and on the map.
4. Deploy and two-device tests, early.
5. Dietary needs, then weather, then Roam, the demo tour and the walkthrough items.
