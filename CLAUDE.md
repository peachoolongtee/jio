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

- **Commit and push only when the user asks.** When asked, make sequential commits with plain lowercase messages and no prefixes.
- **Code comments** are sentence case, and every function carries a "How to call" example.
- **pnpm only**, on Node 24.
- **Secrets:** report what kind of value a variable holds, never the value. Both `.env` files are git-ignored. `backend/.env` carries old database connection strings as comments; leave them for the lead to delete.
- **The live database is shared.** Before any schema change, list the project's migrations and tables. The account tables (`profiles`, `profile_private`, the sign-up trigger, `username_available`) were made by a teammate; build on them and leave them as they are.
- **Teammates' branches and pull requests are read-only.** Review them; change them only when the user says so.
- **Test database changes in a transaction that rolls back**, so no rows are left on the live project.

## Agent skills

### Issue tracker

Work is tracked in GitHub Issues on `peachoolongtee/jio`. The wayfinder map is issue #1 and the audit tracker is issue #47. See `docs/agents/issue-tracker.md`.

### Design language

`DESIGN.md` at the repo root records the design language as it ships: tokens, components, layout, motion, voice, and the known conflicts with this file's rules. Read it before building or changing any screen. Its machine-readable twin is `.impeccable/design.json`.

### Domain docs

Single-context: one `CONTEXT.md` glossary at the repo root, and `docs/adr/` when a decision earns a record. See `docs/agents/domain.md`.

## Current State

As of 2026-10-09. The Supabase foundation was built on branch `feat/supabase-foundation`, which sits on top of `dev`, and was sent to `main` through a pull request at the lead's request. `main` therefore also carries everything that was on `dev`. Run `git log --oneline origin/dev..origin/main` to see whether `dev` has caught up.

| Area | State |
|---|---|
| Frontend screens | Sign-up, sessions, meeting area, voting, itinerary, photos, leaderboard with seasons, rewards in JioCoins, profiles. A top bar from 744 px and a pill tab bar on phones. All data is in one browser's local storage. |
| Backend planner | Built on `dev`: `/api/meeting-area`, `/api/converge`, `/api/roam`, `/api/search`. Travel times and weather are internal estimates. Open to anyone. |
| Database | Session schema and access rules applied to the live `jio` project on 2026-10-09, then revised twice the same day after two reviews (three migrations). No app code reads or writes it yet. |
| Login | Backend token check and `GET /api/me` built and hardened after two reviews. No login screen; the frontend sends no token. |
| External APIs | The planner uses the live data.gov.sg forecast through the HTTP helper. OneMap is on `feature/external-apis` (not merged yet): address search (`GET /api/places/search`, no account needed) and public transport routing, which switches on with `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` (Faith has an account). See `backend/docs/external-apis.md`. |
| End-to-end tests, deploy | Not started. |

## Architecture Decisions

Each is recorded in full on the ticket named. Read the ticket before changing the behaviour.

- **Token check:** the backend verifies login tokens locally and loads data as the signed-in user, so the database's rules decide access. The service key is for server-owned writes only. Ticket #8.
- **Stubbing:** one HTTP helper answers from fixtures in stub mode; a request header picks the scenario. Ticket #9.
- **Constraints:** dietary needs filter food venues only; CDC and Culture Pass are ranking boosts. Ticket #35.
- **What the group sees of a member is their area, never the exact place.** Area ids are on `session_members`. Labels and coordinates are in `session_member_places`, which only the owner and the server read.
- **Private planner needs** (home area, dietary, budget, step-free) sit in `profile_private`. Only the owner and the server read them, through `session_member_needs()`.
- **What a browser may write directly:** a new session; a host's title, date and times, start and cancel; a member's own areas, exact place, picks and votes, while the session is open; a host's invite links. **Everything else goes through the server:** opting out, the radius, slots, options, the meeting area, the itinerary and the ledger. The trigger `guard_session_changes` and the access rules enforce this.
- **Token check:** the server holds its own copy of Supabase's public signing keys and verifies only `ES256` and `RS256` tokens whose key id it holds. It answers 503 when it cannot reach Supabase and has no keys. After a failed refresh it waits a minute before asking again, and it drops keys older than 24 hours. `SUPABASE_ALLOW_LEGACY_TOKENS=1` admits `HS256` tokens by asking Supabase.
- **Errors:** only an error raised by the body parser may answer a 4xx by its own status. Any other uncaught error answers 500 and is logged, so an external API's 401 never reaches the browser as one.
- **`db/schema.sql` and `db/policies.sql` describe a fresh build** and run together as one transaction. A change to a table that already exists on the live project needs its own migration, with the same statements added to the files.
- **Weather:** the planner scores against the live two-hour forecast and says where the weather came from in `weather.source`. A simulated forecast needs `ALLOW_SIMULATED_WEATHER=1` or stub mode; otherwise `weatherCase` is ignored, never refused, because the frontend sends it on every ranking.
- **One error shape:** `{ error: '<code>', message }` on every route. Decided by the lead on 2026-10-09, replacing the nested shape on ticket #8.
- **Rate limit:** the planner routes share a per-caller limit set in `index.js`. `createApp` applies none unless given `planRateLimit`, so tests are unaffected.
- **Sample data: partly labelled, by the lead's decision of 2026-10-10.** The lead took the leaderboard pull request as shipped, which removed the "Sample" note from the leaderboard, Home's places and the Rewards banner. It remains on the place detail and on other people's profiles; rewards use invented café names; distance-based times say "about". Do not add or remove notes without the lead.
- **Cut on 2026-10-09:** crowd estimates, "Ask AI", and the contacts and location steps in sign-up. Do not bring them back without the lead.
- **Contrast: the brand red is `#ff385c`, by the lead's decision of 2026-10-10.** White text on it is 3.52:1, below the 4.5:1 minimum, and three category and three person colours are also under it. `DESIGN.md` lists each pair under "Known Conflicts". Do not darken them without the lead; do not add new white-on-red text without reading that section.
- **Planner limits:** every list, string and number in a planner request has an upper bound, held in one `MAX` block in `backend/src/routes/plan-schemas.js`.
- **Routes added to the Express app go in through `createApp({ mount })`**, because the "not found" handler is last.

## Agent Delegation Log

The full record is `docs/agents/work-log.md`. Add a round there before delegating, and fill in each result as it arrives. Latest round:

**Round 1, 2026-10-09, project initialisation: completed.** Four read-only agents reviewed the unpushed branch, the schema, the open frontend pull request, and ran the checks. They found three significant defects in the login check and a blocker in the schema.

**Round 2, 2026-10-09, fixes: completed.** A backend agent hardened the login check; the lead revised the schema on the live project. An independent tester confirmed the results. A second review asked for more changes.

**Round 7, 2026-10-10, audit of the leaderboard pull request and the design document: completed.** Two read-only reviewers and a documentation agent. The pull request was merged as it is; the findings are on the pull request and on a tracker ticket.

**Rounds 5 and 6, 2026-10-09, audit of the session-flow pull request and its fixes: completed.** Three read-only reviewers, then four frontend agents on separate files. The pull request's commits, the fixes and round 4 went to `main` together from `feat/session-flow-integration`.

**Round 4, 2026-10-09, unblocked backend work: completed.** Live weather, a rate limiter, the flat error shape, CI for the frontend tests, and a design for the session endpoints (on ticket #80).

**Round 3, 2026-10-09, second-review fixes: completed.** A backend agent fixed `GET /api/me`, the error handler and the key refresh; the lead tightened two constraints and one rule on the live project. The lead verified both. No further review was run on round 3.

## Work Completed

See the closed tickets on the tracker, and `docs/agents/work-log.md` for agent rounds. On `feat/supabase-foundation`, 26 commits on top of `dev`: env example update, the session schema and access rules, planner input limits, JSON error answers, Supabase clients, the login check and its tests, the fixes from review rounds 2 and 3, and these agent docs.

## Work In Progress

A ticket's assignee is its owner. Query the tracker for open, assigned tickets. No agent work is running.

## Outstanding Tasks

The tracker is the source of truth. Start from the audit tracker, issue #47: three tickets to fix before any public deploy, the seven "Overhaul N of 7" tickets in order, and four decisions for the lead.

## Known Issues

Recorded as tickets under issue #47. The ones that change how you work today:

- **The demo tools are broken.** "Dev: create a demo account" and the demo panel's "Start over" fail, because the demo account has no date of birth. "Start over" erases everything first. Adding a `dob` to `frontend/src/components/dev/demoAccount.js` fixes both.
- **Sign-up is still local.** The screens now collect a date of birth and a username the database accepts, but nothing is sent to Supabase and there is no login screen.
- **The planner routes accept anyone.** The login check exists but is not applied to them, because the frontend sends no token yet.
- **Points, season prizes and voucher codes are computed in the browser** and can be edited there. They are labelled as a demo and must not be presented as real.
- **The signed-in user's id is hard-coded** in several views, so nothing works for two real people yet.
- **An old database password is in git history.** The repo must stay private until the lead resets it.
- **CI runs only on pull requests and `main`**, and runs only the backend tests.
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
| 2026-10-09 | `feat/session-flow-integration` after round 6 | Browser check at 320, 375 and 1280 px | No horizontal overflow on six routes; sign-up completes with the date-of-birth step |
| 2026-10-09 | `feature/external-apis` merged with `main` (working tree) | `pnpm test` | 334 passed, 1 skipped, 19 files |
| 2026-10-09 | `feature/external-apis` merged with `main` (working tree) | `pnpm --filter jio-frontend test` | 186 passed, 20 files |
| 2026-10-09 | `feature/external-apis` merged with `main` (working tree) | `pnpm build` | Succeeded |
| 2026-10-09 | `feature/external-apis` merged with `main`, real OneMap account | Live server: roam, meeting area, address search | Roam: live weather, 9 of 9 trips routed by OneMap. Meeting area for Tampines + Clementi: Bugis, 28 min worst, 32 routes. Address search found Bishan MRT |

Not yet verified: a real user's login token against `GET /api/me`, and anything end to end.

## Next Steps

1. Fix the demo account (see Known Issues), then decide the other findings on the audit ticket for the leaderboard pull request.
2. Bring `dev` level with `main` if `git log --oneline origin/dev..origin/main` shows commits.
3. Build the session endpoints from the design on ticket #80, starting with a rolled-back test of its SQL.
4. Frontend: the login screen and token, then moving the data layer to Supabase.
5. Real routing needs the OneMap account.
