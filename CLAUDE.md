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

### Domain docs

Single-context: one `CONTEXT.md` glossary at the repo root, and `docs/adr/` when a decision earns a record. See `docs/agents/domain.md`.

## Current State

As of 2026-10-09. The Supabase foundation was built on branch `feat/supabase-foundation`, which sits on top of `dev`, and was sent to `main` through a pull request at the lead's request. `main` therefore also carries everything that was on `dev`. Run `git log --oneline origin/dev..origin/main` to see whether `dev` has caught up.

| Area | State |
|---|---|
| Frontend screens | Built on `dev`: sign-up, sessions, invite, meeting area, voting, itinerary, leaderboard. All data is in one browser's local storage. |
| Backend planner | Built on `dev`: `/api/meeting-area`, `/api/converge`, `/api/roam`, `/api/search`. Travel times and weather are internal estimates. Open to anyone. |
| Database | Session schema and access rules applied to the live `jio` project on 2026-10-09, then revised twice the same day after two reviews (three migrations). No app code reads or writes it yet. |
| Login | Backend token check and `GET /api/me` built and hardened after two reviews. No login screen; the frontend sends no token. |
| External APIs | On `feature/external-apis` (not merged): live NEA 2-hour forecast and OneMap search are wired into the planner; OneMap routing is built and switches on once `ONEMAP_EMAIL` and `ONEMAP_PASSWORD` are set. See `backend/docs/external-apis.md`. No OneMap account yet. |
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
- **Planner limits:** every list, string and number in a planner request has an upper bound, held in one `MAX` block in `backend/src/routes/plan-schemas.js`.
- **Routes added to the Express app go in through `createApp({ mount })`**, because the "not found" handler is last.

## Agent Delegation Log

The full record is `docs/agents/work-log.md`. Add a round there before delegating, and fill in each result as it arrives. Latest round:

**Round 1, 2026-10-09, project initialisation: completed.** Four read-only agents reviewed the unpushed branch, the schema, the open frontend pull request, and ran the checks. They found three significant defects in the login check and a blocker in the schema.

**Round 2, 2026-10-09, fixes: completed.** A backend agent hardened the login check; the lead revised the schema on the live project. An independent tester confirmed the results. A second review asked for more changes.

**Round 3, 2026-10-09, second-review fixes: completed.** A backend agent fixed `GET /api/me`, the error handler and the key refresh; the lead tightened two constraints and one rule on the live project. The lead verified both. No further review was run on round 3.

## Work Completed

See the closed tickets on the tracker, and `docs/agents/work-log.md` for agent rounds. On `feat/supabase-foundation`, 26 commits on top of `dev`: env example update, the session schema and access rules, planner input limits, JSON error answers, Supabase clients, the login check and its tests, the fixes from review rounds 2 and 3, and these agent docs.

## Work In Progress

A ticket's assignee is its owner. Query the tracker for open, assigned tickets. No agent work is running.

## Outstanding Tasks

The tracker is the source of truth. Start from the audit tracker, issue #47: three tickets to fix before any public deploy, the seven "Overhaul N of 7" tickets in order, and four decisions for the lead.

## Known Issues

Recorded as tickets under issue #47. The ones that change how you work today:

- **Sign-up will fail as built.** The existing sign-up trigger requires a date of birth and a lowercase username without dots. The sign-up screens collect neither correctly.
- **The planner routes accept anyone.** The login check exists but is not applied to them, because the frontend sends no token yet.
- **The open frontend pull request changes `frontend/src/lib/api.js`, the router and two stores.** Frontend work on login or the data layer conflicts with it until it is merged or closed. It also adds photos, seasons and points that the schema has no tables for.
- **An old database password is in git history.** The repo must stay private until the lead resets it.
- **CI runs only on pull requests and `main`**, and runs only the backend tests.
- **Two error shapes.** The login check answers `{ error: { code, message } }`, as agreed on ticket #8. The planner routes answer `{ error, message }`. The lead has to pick one before the frontend handles errors.
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

| 2026-10-09 | `feature/external-apis` working tree | `pnpm test` | 278 passed, 1 skipped, 17 files |
| 2026-10-09 | `feature/external-apis` working tree | live NEA forecast and OneMap search, no account | 47 areas parsed; slot at 20:00 used the live forecast; next-day slot answered `outside_forecast_period`; postal code 520201 found |

Not yet verified: a real user's login token against `GET /api/me`, OneMap routing with a real account, and anything end to end.

## Next Steps

1. Bring `dev` level with `main`, so teammates build on the foundation. Then the lead decides on the open frontend pull request, which targets `dev`.
2. The lead settles the sign-up questions, the error shape and the product-shape decision.
3. Continue the overhaul tickets in order. The external-API step needs only the OneMap account, so it can run in parallel.
