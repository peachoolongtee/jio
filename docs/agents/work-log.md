# Agent work log

The running record of delegated work on this repo. `CLAUDE.md` holds only the latest round; the history lives here. Newest round first. Times are the machine's local time.

Each entry records: the parent task, the agent and its role, scope and files it may change, status, findings, files changed, and what was verified. A status is one of **not started**, **in progress**, **blocked** or **completed**. An entry is completed only when its acceptance criteria are met and the result was checked.

Never write a password, key, token or connection string here.

## Round 1: project initialisation (2026-10-09)

Parent task: initialise project context and get an independent check of the unpushed branch `feat/supabase-foundation` before any further implementation. All four agents are read-only, so none can conflict with another. Only the lead writes `CLAUDE.md` and `docs/agents/`.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 1.1 | Backend and security review | The login check, Supabase clients, `GET /api/me`, planner input limits and their tests on the branch | Nothing | Every finding has a file and line, a failure scenario, and says whether it was confirmed by tracing the code | **Completed** 01:19 |
| 1.2 | Database review | `db/schema.sql` and `db/policies.sql` | Nothing | Each table's read and write rules are stated; any way for a user to read or change another user's data is reported with the exact statement | **Completed** 01:21 |
| 1.3 | Architecture and frontend impact | The open pull request "Session flow: merge the backend planner and redesign the frontend" against `dev` | Nothing | Lists what it changes in the data layer, what it needs from the database that the schema lacks, and which overhaul steps it conflicts with | **Completed** 01:19 |
| 1.4 | Testing | Install, backend tests, frontend tests and build on the branch as it stands | Nothing (removes its own build output) | Reports the exact commands and their real output; no result is assumed | **Completed** 01:15 |

Results are added below as each agent reports.

### 1.4 Testing: completed

- **Verified by the lead:** the working tree is unchanged, HEAD is still `41aface`, the build output is gone, and the probe port is free. The test counts match the lead's own run at the same commit.
- **Files changed:** none.
- **Results, all from real output at `41aface`:**

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Lockfile up to date |
| `pnpm test` | 217 passed, 1 skipped, 16 files. The skip is in `cdc.test.js`. |
| `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| `pnpm build` | Succeeded |
| Server started without an env file | Starts, and logs that Supabase is not configured |
| `GET /healthz` | 200 |
| `GET /api/me` without Supabase configured | 404 in JSON: the route is not mounted |
| `GET /api/nope` | 404 in JSON |
| `POST /api/meeting-area`, two members | 200, `approximate: false` |
| `POST /api/converge`, 800 constraints | 400 in under 2 ms, naming `groupConstraints` |
| `POST /api/converge`, 150 kB body | 413 in JSON |
| Both `.env` files | Ignored by git |

- **Findings:** CI covers the backend tests and the build on pull requests and on pushes to `main`. It does not run the frontend tests or anything on feature branches. This is already a ticket under the audit tracker.
- **Not verified:** `GET /api/me` with a real login token, and anything end to end.

### 1.1 Backend and security review: completed

- **Verified by the lead:** the three significant findings were reproduced against the real code with a fake Supabase before being accepted.
- **Files changed:** none.
- **Findings, confirmed by reproduction:**

| # | Severity | Finding | Reproduction |
|---|---|---|---|
| 1 | Major | A token whose header says `alg: none`, a number, or `RS256`, with the real key id, crashes the check | 500 and a logged error each time, where the answer should be 401 |
| 2 | Major | With no cached signing keys, a Supabase outage is reported as a bad token | 401 "sign in again" for a valid token; a hung Supabase leaves the request hanging with no timeout |
| 3 | Major | A token with an unknown key id, or none, makes the server call Supabase every time | 20 requests caused 40 outbound calls; 20 with no key id caused 20 |

- **Findings, traced by the reviewer and not yet reproduced:** `categories` has no length limit; other body-parser client errors answer 500; a partly set Supabase config silently drops the login routes; two error shapes coexist; anonymous sign-ins would pass the role check; a display name over 80 characters fails every planner call for the group; several tests are weak or missing.
- **Clean:** no token that is not a genuine user's gets through; the anon and service keys are refused; the per-request client shares no state; the token is never logged; middleware order is correct.
- **Learned along the way:** the Supabase library caches signing keys per process for ten minutes, shared across clients. Tests that need a cold cache must run in a fresh process.
- **Follow-up:** round 2, deliverable 2.1.

### 1.3 Architecture and frontend impact: completed

- **Verified by the lead:** spot-checked against the branch at `9389a27`: 86 files, all under `frontend/`; 52 data-layer functions against 46 on `dev`; sign-up steps and the username rule as reported; no file in common with the unpushed backend commits.
- **Files changed:** none.
- **What the open frontend pull request does:**
  - Adds six data-layer functions: seasons, a place detail, stop reordering and session photos. No existing signature changes. Still local storage only.
  - Adds no login screen. Sign-up still collects no date of birth and allows dots in usernames, so it would fail the live sign-up trigger.
  - Sends the planner the same requests as `dev`, all within the new limits.
  - Fixes none of the audit's frontend findings outright, and makes three slightly worse: the planner request flood, the hard-coded user id, and points awarded in the browser.
- **What it needs that the schema lacks:** session photos and a storage bucket, seasons and their winners, a points ledger, rewards and redemptions, friends, and a plan start time.
- **Sequencing cost:**
  - Merge it first: no conflict today. The overhaul then ports 52 functions, and the schema must grow before the six new ones can leave local storage.
  - Overhaul first: conflicts in the data layer, the router, two stores, the sign-up view and six other views, and about 16 functions get written twice.
- **Not verified:** the pull request's own test count and its layout and contrast claims, since nothing was run.

### 1.2 Database review: completed

- **Verified by the lead:** findings 1 to 6 were checked against the two SQL files and are correct as stated. Findings marked "needs a live test" are checked in round 2.
- **Files changed:** none.
- **Exposure so far:** none. The session tables hold no rows and no app code reads them.
- **Findings:**

| # | Severity | Finding |
|---|---|---|
| 1 | Blocker | Every member of a session, and so anyone holding its invite link, can read all other members' exact start and end coordinates and labels. The app promises only the area is shared. |
| 2 | Major | Opting out removes no rights, and a member can set themselves back to joined with no recalculation. |
| 3 | Major | A member can add any venue id as a voting option, with no limit, bypassing the planner's dietary and fit checks. |
| 4 | Major | `profiles.home_area_id` is readable by every signed-in user, because that table is readable by all. |
| 5 | Major | A member can write values that break the planner: duplicate categories that inflate a count, out-of-range coordinates. |
| 6 | Major | Direct writes skip the state machine: a host can edit a confirmed or finished session, a member can move after confirmation, slots can be removed in any status. |
| 7 | Major, untested | Deleting a host's account deletes the session and other people's votes, itinerary and ledger rows. |
| 8 to 14 | Minor | The status guard is a deny-list; two helper functions answer for any slot id; a finished-but-not-completed session can still be joined; votes lack `on update cascade`; four foreign keys lack indexes; list queries call a function per row; realtime delete events are not filtered by row-level security. |

- **Clean:** row-level security is on everywhere; logged-out visitors have no table access; nobody can become host or join without a token; a client cannot forge an id, status, meeting area, role or invite token; `profile_private` is readable only by its owner and the server.
- **Why the lead does the fix:** only the lead session has the Supabase connection, so a subagent could write SQL but not run it. An independent review agent rechecks the result in 2.3.
- **Follow-up:** round 2, deliverable 2.2.

## Round 2: fix what round 1 found (2026-10-09)

Parent task: fix the confirmed defects on `feat/supabase-foundation` before the branch is pushed. Nothing is committed.

| # | Role | Scope | May change | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| 2.1 | Backend | Harden the token check; tidy error handling, start-up config checks and the `categories` limit | `backend/src/db/supabase.js`, `backend/src/middleware/auth.js`, `backend/src/app.js`, `backend/src/index.js`, `backend/src/routes/plan-schemas.js`, `backend/tests/auth.test.js`, `backend/tests/limits.test.js`, `backend/.env.example`, `backend/docs/planner-api.md` | Round 1.1 | The lead's reproduction scripts give 401, 503 and a bounded number of outbound calls; all suites pass | **Completed** 01:30 |
| 2.2 | Database, done by the lead | Revise the schema and rules to close the findings of 1.2, apply a corrective migration, rerun the access test | `db/schema.sql`, `db/policies.sql`, the live `jio` project | Round 1.2 | Each finding of 1.2 has a check in the rolled-back access test, and all checks pass; the live functions and policies match the files | **Completed** 01:30 |
| 2.3 | Review and testing, two agents | An independent second review of both fixes, and a re-run of every check plus the reproduction scripts | Nothing | 2.1, 2.2 | Real output for each command | **Completed** 01:45. The review asked for changes: see round 3. |

### 2.1 Backend: completed

- **Agent:** an implementer subagent, limited to nine named files. It reported 241 backend tests passing.
- **Verified by the lead:** only the nine allowed files changed, nothing is staged or committed, and HEAD is still `41aface`. The lead's own reproduction scripts, written before the fix, now give:

| Case | Before | After |
|---|---|---|
| Token header `alg: none`, a number, or `RS256`, with the real key id | 500, error logged | 401, nothing logged |
| Valid token, Supabase unreachable or answering 503, no keys cached | 401 "sign in again" | 503 `auth_unavailable` with `Retry-After` |
| Valid token, Supabase hangs, no keys cached | Request hangs | 503 after 5 seconds |
| 20 tokens with different unknown key ids | 40 outbound calls | 0 |
| 20 tokens with no key id | 20 outbound calls | 0 |
| 20 valid tokens | 200 | 200 |

- **Suites, run by the lead after the fix:** `pnpm test` 241 passed, 1 skipped, 16 files; `pnpm --filter jio-frontend test` 39 passed; `pnpm build` succeeded.
- **What changed:** the server keeps its own copy of Supabase's public signing keys and verifies only `ES256` and `RS256` tokens whose key id it holds; a new `AuthUnavailableError` becomes a 503; start-up exits when the Supabase settings are partly set, or missing in production; other client errors from the body parser answer their own 4xx; `categories` is capped at 4 and de-duplicated.
- **Checked against the real project:** the issuer the new check requires matches the one the project publishes.
- **Not verified:** a real user's token. The project also lists `HS256` among its signing algorithms; if it still issues such tokens to users, set `SUPABASE_ALLOW_LEGACY_TOKENS=1`. The server warns once if it refuses one.
- **Left as reported by the agent:** while serving stale keys in an outage, each request after the ten-minute mark retries the refresh; database calls made with the user or service client have no timeout.

### 2.2 Database: completed

- **Done by the lead**, because only the lead session has the Supabase connection.
- **Files changed:** `db/schema.sql`, `db/policies.sql`. Applied to the live project as migration `jio_session_schema_review_fixes`, which first checked that every session table was empty.
- **What changed, by finding:**

| Finding | Fix |
|---|---|
| 1. Members could read each other's exact coordinates | Exact places moved to `session_member_places`, which only its owner and the server read. `session_members` keeps area ids only. |
| 2. Opting out removed no rights | `state` is server only. Write rules require a joined member. The invite link no longer flips a member back to joined. |
| 3. Members could add any venue as an option | `slot_options` is server only. Adding an option goes through the server, which checks the venue. |
| 4. Home area readable by everyone | `home_area_id` moved from `profiles` to `profile_private`. |
| 5. Planner-breaking values | Categories must be unique and at most four. Coordinates must be inside Singapore, which also rejects NaN. The time picks were last changed is set by a trigger. |
| 6. Writes skipped the state machine | Members edit only while the session is inviting, locating or voting. The radius, banner and slot removal are server only. A host changes the date and times only while inviting, and nothing once the session is completed or cancelled. |
| 7. Deleting a host erased others' history | `sessions.host_id` and `commute_ledger.user_id` now block the delete. |
| 8. Status guard was a deny-list | `guard_session_changes` lets the server through and holds every other role to the rules. Starting needs two joined members. |
| 10. Helpers answered for any slot id | Replaced by functions that return only the caller's own ids. |
| 11. Loose joining | A confirmed session cannot be joined. A link counts each person once. |
| 9, 14 | `votes` follows a swapped option; four foreign keys gained indexes; list queries call a helper once per query. |

- **Verified by the lead on the live project:**
  - A 68-step access test, acting as a host, two guests, an opted-out member, an outsider, a logged-out visitor and the server, with at least one step per finding. 68 of 68 passed. It rolled itself back, and the project still holds 1 auth user and 0 sessions.
  - All 15 functions have the same fingerprint in the database as in `db/schema.sql`, and the 24 policies match `db/policies.sql`.
  - The two account functions written by a teammate have the same fingerprint as before today.
  - Every one of the 12 tables has row-level security on, and logged-out visitors have no table access.
- **Consequence for the overhaul:** opting out, adding or swapping an option, removing or restoring a slot, and changing the radius are now server endpoints, not direct database writes.
- **Not fixed, by choice:** realtime delete events are not filtered by row-level security; no published table has a private key, and `session_member_places` is not published.

### 2.3 Testing half: completed 01:30

- **Agent:** a verifier subagent, read-only.
- **Verified by the lead:** the working tree has the same 14 entries as before it ran, its build output is gone and its port is free. Its numbers match the lead's own run.
- **Results, from real output on the working tree after round 2:**

| Step | Result |
|---|---|
| `pnpm install --frozen-lockfile` | Lockfile up to date |
| `pnpm test` | 241 passed, 1 skipped, 16 files |
| `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| `pnpm build` | Succeeded |
| Login-check tests alone, three runs in a row | 35 passed each time, about half a second each: no flakiness seen |
| Reproduction scripts for the three login-check findings | Every line as expected: 401 for bad algorithms, 503 for an outage, 503 after 5 seconds for a hang, 0 outbound calls for unknown key ids, 200 for valid tokens |
| Server without an env file: bogus `Content-Encoding` | 415 in JSON |
| Server without an env file: five categories | 400 naming `categories` |
| Start-up with one of three Supabase settings | Exits 1, naming the two missing variables |
| Start-up in production with none | Exits 1 |

- **Not verified:** a real Supabase project, a real token, or anything end to end.

### 2.3 Review half: completed 01:45, verdict "changes required"

- **Agent:** a code-reviewer subagent, read-only. It ran nothing, so its "confirmed" means traced in the code.
- **Verified by the lead on the live project** (one read-only query and the migration list):
  - `profiles` has no `home_area_id`, and `session_members` has no coordinate columns. The old helper functions and the three dropped policies are gone. Six tables are published; `session_member_places` is not.
  - Every function and table is owned by `postgres`, and every table has row-level security on.
  - So the review's worry that the live project still carries version 1 leftovers is **not the case**.
- **Earlier findings:** 9 of 14 database findings and 6 of 10 backend findings are closed. The rest are partly closed and carried into round 3 or onto a ticket.
- **New findings accepted:**

| # | Severity | Finding | Lead's check |
|---|---|---|---|
| D1 | Major | `GET /api/me` selects `home_area_id` from `profiles`. The column moved to `profile_private` in round 2, so a real user gets a 500. The test's fake returns the column, which hid it. | Confirmed: the column is absent on the live project and `me.js` line 21 asks for it. |
| D3 | Major | `dietary` accepts repeats and any length. The planner allows at most 3, so one member could fail planning for the group. | Confirmed in `db/schema.sql`. |
| B1 | Major, latent | The error handler answers any error carrying a 4xx `status` as the caller's mistake, unlogged. An uncaught external-API 401 would tell the browser to sign in again. | Confirmed in `app.js` and `services/errors.js`. Nothing calls the HTTP helper yet. |
| B2 | Minor | With stale keys and Supabase failing, every request waits on a new refresh; nothing is logged; stale keys are trusted for ever. | Confirmed in `supabase.js`. |
| D4 | Minor | `categories` accepts a two-dimensional array. | To be tested live in round 3. |
| D5 | Minor | A member who opted out, or whose session is confirmed, cannot delete their own exact place. | Confirmed in `db/policies.sql`. |
| D6, D8 | Minor | Three comments in the SQL files claim more than is true. | Confirmed. |

- **Findings left for the lead to decide, to be noted on the tickets:** the two error shapes (`auth.js` follows the shape agreed on ticket #8, the teammate's planner routes use a flat one); a host or anyone with ledger rows cannot delete their account; a session dated in the past but still open can be joined; delete events on live updates show the keys of deleted `session_members` and `votes` rows to any subscriber.
- **Clean, per the review:** no way was found to read another member's exact place, to act for another user, or to move a session's status outside the allowed moves. The single-flight key refresh is race-free. No statement in either SQL file fails on a second run.
- **Note:** the reviewer saw an `AGENTS.md` inside the Supabase auth package in `node_modules` that tells agents to install skills. It ignored it, and so does the lead.

## Round 3: fix what the second review found (2026-10-09)

Parent task: close the accepted findings of 2.3. Nothing is committed. The two deliverables touch different files and run in parallel.

| # | Role | Scope | May change | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| 3.1 | Backend | D1, B1, B2, and a one-time warning for an issuer mismatch; tests for each | `backend/src/routes/me.js`, `backend/src/app.js`, `backend/src/db/supabase.js`, `backend/tests/auth.test.js`, `backend/tests/limits.test.js`, `backend/docs/planner-api.md` | 2.3 | A test fails if `/api/me` asks `profiles` for a column it does not have; an error with a 4xx `status` that is not from the body parser answers 500 and is logged; with stale keys and Supabase down, the second request makes no outbound call; all suites pass | **Completed** 02:20 |
| 3.2 | Database, done by the lead | D3, D4, D5 and the comment fixes; apply to the live project | `db/schema.sql`, `db/policies.sql`, the live `jio` project | 2.3 | Each fix has a step in a rolled-back test and all steps pass; live functions and policies match the files | **Completed** 02:05 |
| 3.3 | Testing, done by the lead | Re-run every check on the finished working tree | Nothing | 3.1, 3.2 | Real output for each command | **Completed** 02:20 |

### 3.2 Database: completed

- **Done by the lead.** Files changed: `db/schema.sql`, `db/policies.sql`. Applied to the live project as migration `jio_session_schema_second_review_fixes`, the third on the project. The migration holds the same statements as the files.
- **What changed:**

| Finding | Fix |
|---|---|
| D3 | New constraint `dietary_shape` on `profile_private`: one flat list, no repeats, at most 3. |
| D4 | New constraint `categories_one_dimension` on `session_members`. Before the fix, `'{{eat},{drink}}'` passed the existing check on the live project. |
| D5 | `session_member_places_delete_own` now needs only that the row is the caller's own. Editing still needs an open session and a joined member. |
| D2, D6, D8 | Comments corrected: the two files must run as one transaction; they describe a fresh build and do not alter an existing table's columns; delete events on live updates are unfiltered and show the keys of deleted `session_members` and `votes` rows. |

- **Verified by the lead on the live project:**
  - A 13-step test run before the migration, in one transaction that rolled back: repeated and two-dimensional `dietary` refused; valid and empty lists accepted; two-dimensional `categories` refused; valid and empty accepted; a member cannot read or delete another's exact place; an opted-out member cannot edit their place and can delete it; after confirmation a member cannot edit their place and can delete it. 13 of 13 passed.
  - After the migration: both constraints are present with the definitions in the file; the delete policy reads as in the file; 24 policies in all, 20 on session tables, matching the 20 `create policy` statements in `db/policies.sql` plus the 4 account policies; 1 auth user, 0 test users, 0 sessions, 0 members, 0 places.
- **Not re-run:** the 68-step test of round 2. No function changed in round 3, and the one changed policy is covered by the 13 steps.
- **Not fixed, noted for the tickets:** a session dated in the past but still open can be joined; area ids are length-checked only, so the server must validate them; live-update delete events as above.

### 3.1 Backend: completed

- **Agent:** an implementer subagent, limited to six named files. It changed five and left `backend/docs/planner-api.md` as it was, because no documented answer changed. It reported 253 backend tests passing.
- **Verified by the lead:** the working tree gained one modified file, `backend/src/routes/me.js`; nothing in `db/`, `docs/` or `CLAUDE.md` was touched by the agent; nothing is staged and HEAD is still `41aface`. The lead read the changed code in `me.js`, `app.js` and the key refresh in `supabase.js`.
- **What changed:**

| Finding | Fix |
|---|---|
| D1 | `/api/me` no longer asks for `home_area_id`. The test's fake Supabase now refuses a column `profiles` does not have, as the real one does. |
| B1 | The error handler answers a 4xx only for errors the body parser raised. Any other error is logged and answers 500, even when it carries a 4xx `status`. |
| B2 | After a failed key refresh the server waits 60 seconds before trying again and answers from the keys it holds; with no keys it answers 503 at once for 5 seconds. One warning is logged per outage. Keys older than 24 hours are dropped. |
| B3 | A correctly signed token with the wrong issuer is still refused, and the server warns once, naming both issuers. |

- **Mutation check by the lead:** with the D1 and B1 fixes undone by hand, `auth.test.js` and `limits.test.js` gave 19 failures. With the files restored from a copy, 62 of 62 passed.
- **Left as reported by the agent:** while held keys are answering, an outage shows only as one warning line; a frontend that needs the home area must read `profile_private` itself.

### 3.3 Testing: completed

- **Done by the lead**, on the working tree after 3.1 and 3.2. A separate agent would have repeated the same commands.

| Step | Result |
|---|---|
| `pnpm test` | 253 passed, 1 skipped, 16 files |
| `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| `pnpm build` | Succeeded |
| Reproduction: `alg` of `none`, a number, or `RS256` | 401, no outbound call, nothing logged as an error |
| Reproduction: Supabase unreachable or answering 503, no keys | 503 in about 10 ms, one outbound call, one warning |
| Reproduction: Supabase hangs, no keys | 503 after 5014 ms |
| Reproduction: 20 unknown key ids; 20 tokens with no key id | 401 each, 0 outbound calls |
| Reproduction: 20 valid tokens | 200 each |

- **Not verified:** a real user's login token against `GET /api/me`, and anything end to end. Both need a login screen. No third review was run on the round 3 changes.

## Close-out of rounds 2 and 3 (2026-10-09)

The lead asked for everything to be committed, the branch pushed, and the work merged to `main`.

- **Committed:** 13 sequential commits for the code, SQL, glossary and agent docs (`2a67884` to `91b9434`), then this log and `CLAUDE.md`. Before committing, everything staged was scanned for secret-shaped values: none found.
- **Tests at `91b9434`:** `pnpm test` 253 passed, 1 skipped, 16 files.
- **Merge:** by pull request into `main`. The branch sits on `dev`, so the merge also takes `dev`'s 21 commits into `main`. The pull request and `git log` are the record of whether and when it merged.

## Round 4: backend work that needs no decision (2026-10-09)

Parent task: the lead asked for everything that is unblocked and needs no input. All frontend work waits on the session-flow pull request, which the lead has to merge. This round is backend and CI only, on branch `feat/weather-and-rate-limit`, cut from `dev`. Nothing is committed.

| # | Role | Scope | May change | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| 4.1 | Backend | The flat error shape decided on "Overhaul 3 of 7"; a rate limiter as a standalone middleware | `backend/src/middleware/auth.js`, `backend/src/middleware/rate-limit.js` (new), `backend/tests/auth.test.js`, `backend/tests/rate-limit.test.js` (new) | None | The login check answers `{ error, message }`; the limiter answers 429 with `Retry-After` after the limit and recovers after the window; all suites pass | **Completed** |
| 4.2 | Backend | Real weather from data.gov.sg through the HTTP helper; the simulated forecast behind an env flag and marked in the response | `backend/src/services/weather.js`, `backend/src/routes/plan.js`, `backend/src/routes/plan-schemas.js`, `backend/src/app.js`, `backend/src/index.js`, `backend/.env.example`, `backend/src/services/stubs.js`, `backend/tests/fixtures/datagov/`, `backend/tests/weather.test.js` (new), other planner test files only where the weather change breaks them | None | With stubs on, a rainy forecast changes the order of results and the response says where the weather came from; `weatherCase` is refused unless the flag is set; the suite passes offline | **Completed**, with one criterion changed by the lead: see 4.2 below |
| 4.3 | Architecture | Design the session endpoints of "Overhaul 5 of 7": the planner loading a session from the database, and the writes only the server may make | Nothing | None | Each endpoint has a method, path, who may call it, what it reads and writes, and its errors; open questions are listed | **Completed** |
| 4.4 | Infrastructure, done by the lead | CI runs the frontend tests, and runs on pushes to `dev` | `.github/workflows/ci.yml`, root `package.json` | None | The workflow file names every step; the same commands pass locally | **Completed** |
| 4.5 | Lead | Mount the limiter in `app.js` and merge both agents' doc text into `backend/docs/planner-api.md` | `backend/src/app.js`, `backend/docs/planner-api.md`, and the files named in 4.5 below | 4.1, 4.2 | All suites pass | **Completed** |

### 4.4 CI: completed

- **Done by the lead.** File changed: `.github/workflows/ci.yml`. The root `package.json` was left as it is.
- **What changed:** the workflow also runs on pushes to `dev`, and has a new step, `pnpm --filter jio-frontend test`.
- **Verified:** the file parses as YAML; the new step's command passes locally, 39 tests in 7 files. The workflow itself has not run on GitHub, because nothing is pushed.
- **Not done, and why:** branch protection needs the lead and a paid plan or a public repo; aligning the two vitest majors touches `frontend/package.json`, which waits on the session-flow pull request.

### 4.1 Error shape and rate limiter: completed

- **Agent:** an implementer subagent, limited to four files.
- **Verified by the lead:** only its four files changed (`auth.js`, `auth.test.js`, and the new `rate-limit.js` and `rate-limit.test.js`); the lead read the limiter and the `auth.js` diff, and reran its two test files: 74 of 74 passed (46 login check, 28 limiter).
- **What changed:**
  - The login check answers `{ error: 'unauthenticated', message }` and `{ error: 'auth_unavailable', message }`. Status codes, messages and `Retry-After: 5` are unchanged.
  - `rateLimit({ windowMs, max, keyOf, now })` is a new in-memory, fixed-window middleware with no new dependency. It counts per signed-in user, or per address when no login check ran first, and answers 429 `rate_limited` with `Retry-After`. Expired records are swept at most once per window, by a request.
- **Limits of the limiter, as reported and confirmed in the code:** counts are per process; a caller can make up to twice the limit across a window boundary; behind a proxy every anonymous caller shares one address unless Express is told to trust the proxy.
- **Not mounted yet:** the lead mounts it in 4.5, after the weather agent has finished with `app.js`.

### 4.2 Real weather: completed

- **Agent:** an implementer subagent. It changed `services/weather.js`, `routes/plan.js`, `app.js`, `index.js`, `.env.example`, `tests/plan-routes.test.js`, `tests/limits.test.js`, and added `planner/live-weather.js` and `tests/weather.test.js`. The engine is untouched.
- **What it built:** `createWeather({ http })` fetches the two-hour forecast through the HTTP helper, caches it for five minutes (30 seconds for a failure), and shares one fetch between concurrent callers. `/api/converge` and `/api/roam` score each venue from the nearest of the 47 forecast areas and answer with `weather: { source, validUntil? }`.
- **Changed by the lead after review:** the brief told the agent to refuse `weatherCase` with a 400 when the simulated forecast is off. The frontend sends `weatherCase` on every ranking, so that would have broken every slot on any normal server. The server now ignores the field, uses the live forecast, and adds `weather.simulationIgnored: true`. The brief was wrong, not the agent.
- **Verified by the lead:**
  - Read the diffs of `plan.js` and `app.js`.
  - One request against the real data.gov.sg service: `source: live`, 369 ms; a second, 6 ms from the cache; with `weatherCase` and the flag off, `simulationIgnored: true`.
  - The agent reported up to two accidental real requests during its work, before it pointed the test servers at stubs. The suites as they stand make none.
- **Left as reported:** the forecast's end time is not checked for staleness; `postranking.js` still reads the old region cases, and no route calls it.

### 4.3 Session endpoint design: completed

- **Agent:** an architect subagent, read-only.
- **Result:** 18 endpoints with caller, status, reads, writes and errors; a mapping of every `api.js` function; two new columns and two new functions as proposed SQL; a file plan, test plan and eight build slices; ten questions with a default each. Posted in full on the ticket "Overhaul 5 of 7".
- **Not verified:** nothing in it was run. The SQL is untested, and the lead has not checked each endpoint against the schema. It is a proposal.

### 4.5 Integration: completed

- **Done by the lead.** Files changed beyond the agents' work: `backend/src/app.js`, `backend/src/routes/plan.js`, `backend/src/index.js`, `backend/.env.example`, `backend/src/services/scenario.js`, `backend/tests/scenario.test.js`, `backend/tests/weather.test.js`, `backend/tests/rate-limit.test.js`, `backend/docs/planner-api.md`, `frontend/src/lib/__tests__/api.backend.test.js`.
- **What changed:**
  - The limiter is mounted on the four planner routes only, through `createApp({ planRateLimit })`. `index.js` sets 300 a minute per caller (`PLANNER_RATE_LIMIT_PER_MINUTE`), and none in stub mode. It is loose because one round of voting sends about 130 requests today.
  - The scenario header check answered in the nested error shape; it is flat now.
  - One frontend test starts the real backend and fakes rain. It now passes `allowSimulatedWeather: true`. Without that it failed, and it would have called data.gov.sg. The open frontend pull request does not touch that file.
- **Results on the finished working tree:**

| Step | Result |
|---|---|
| `pnpm test` | 317 passed, 1 skipped, 18 files |
| `pnpm --filter jio-frontend test` | 39 passed, 7 files |
| `pnpm build` | Succeeded |
| Limiter on the real app, limit of 2 | Third planner request 429 with `Retry-After`; health check and unknown routes unaffected |

- **Not verified:** the CI workflow on GitHub; the limiter behind a proxy; the weather under a real outage of data.gov.sg (tested with a failing fake only).

## Round 5: audit of the session-flow pull request (2026-10-09)

Parent task: the lead asked for an audit of the open pull request "Session flow: merge the backend planner and redesign the frontend" (head `9389a27`, 86 files, all under `frontend/`). The pull request is a teammate's and is read-only. It is checked out in a separate worktree outside the repo folder, so no agent touches the lead's working tree.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 5.1 | Code review | Correctness of the data layer, stores, router, planner libraries and the new views' logic | Nothing | Each finding has a file and line, a failure scenario, a severity, and whether it was traced | **Completed** |
| 5.2 | Design review | Layout at phone and desktop widths, accessibility, motion, consistency of the new screens and navigation | Nothing | Each finding has a file and line and names the audit ticket it relates to, if any | **Completed** |
| 5.3 | Security, honesty and fit | Forgeable points and vouchers, invented data shown as fact, privacy, fit with the lead's decisions of 9 Oct, test quality | Nothing | Each finding has a file and line; each earlier audit ticket is marked fixed, unchanged or worse | **Completed** |
| 5.4 | Testing, done by the lead | Install, tests and build on the pull request's head, and on it merged with `dev` | Nothing | Real output for each command | **Completed** |

### 5.1 and 5.3: completed. 5.2 still running.

- **5.3, security and fit: "changes required".** The lead spot-checked the main claims in the code and they hold: vouchers attributed to real cafés with no sample label; the contacts and location steps, "Ask AI" and invented crowd levels still present after the lead cut them; sign-up without a date of birth and with dots in usernames; "Sign out" wiping everything unannounced; fabricated reviews headed "from Jio friends"; unlabelled travel times. Injection checks came back clean. Points, vouchers and season prizes are all computed and stored in the browser.
- **5.1, logic: "merge with follow-ups".** No blocker. Five majors: photos as data URLs fill the storage quota and later writes then fail silently; reordering stops or adding a photo re-ranks every slot; a failed reorder is not rolled back; a save is trusted on its version number alone; ending a plan does not close an expired season first. Planner request count for a voting round is unchanged at about 130, and worse after confirmation.
- **5.4, testing by the lead:** the pull request's commits merged onto round 4 on the local branch `feat/session-flow-integration`: `pnpm test` 317 passed, 1 skipped; `pnpm --filter jio-frontend test` 81 passed, 14 files; `pnpm build` succeeded.
- **Not fixable in this round, left on their tickets:** points and prizes computed in the browser, one hard-coded user id, the browser sending the group to the planner, no login screen, confirming needing a second voter. These are the overhaul itself.

## Round 6: fix the audit's findings (2026-10-09)

Parent task: the lead said to fix what the audit found and then merge everything to `main`, unless something is a serious blocker. None is: every finding is either fixable here or already an overhaul ticket. Work is on `feat/session-flow-integration`.

| # | Role | Scope | May change | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| 6.1 | Frontend logic | The logic findings of 5.1 and the data-layer side of 5.3 | `frontend/src/lib/api.js`, `lib/season.js`, `lib/image.js`, `lib/planner/itinerary.js`, `stores/planner.js`, `stores/events.js`, the script of `components/ui/PolaroidLine.vue` and `MeetupGraph.vue`, tests under `lib/__tests__/` except `api.backend.test.js` | 5.1 | Each fix has a test that fails without it; frontend suite passes | **Completed**; verified with 6.3 in 6.4 |
| 6.2 | Frontend views | The cuts the lead decided, honest labels, sign-up fields, error states | The views and components named in its brief, `lib/plannerApi.js`, `lib/planner/crowd.js` and its users, `lib/mock/rewards.js`, `lib/mock/people.js`, `stores/auth.js` | 5.3 | No cut feature remains; every invented value is labelled; sign-up collects a date of birth; frontend suite and build pass | **Completed**; verified with 6.3 in 6.4 |
| 6.3 | Frontend design | The findings of 5.2 | The components, views and styles named in its brief; runs after 6.1 and 6.2 so no file is edited twice at once | 5.2, 6.1, 6.2 | The photo carousel can be paused and does not autoplay under reduced motion; photos can be changed and deleted safely without a pointer; the navigation fits at 320 px; text on the brand and category colours meets 4.5:1; dialogs trap focus; frontend suite and build pass | **Completed**, as two agents on separate files |
| 6.4 | Lead | Verify, run every check, commit, push, merge to `main` | Docs and the tracker, and the small files named in 6.4 below | 6.1 to 6.3 | All suites pass; pull request merged | **Completed** up to the commits; the pull request and `git log` record the merge |

### 5.2 Design review: completed, "changes required"

- **Agent:** a design-reviewer subagent, read-only. It rendered nothing: contrast ratios are computed from token values, and layout findings marked "plausible" are inferred from the CSS.
- **No blocker:** no main flow is impossible at a rubric width.
- **Nine majors:**
  - The photo carousel autoplays every 5 seconds with no pause, announces each step to screen readers, and ignores reduced motion.
  - Deleting a photo is immediate, with no confirmation or undo.
  - On touch devices the photo viewer has no previous and next buttons, so a screen-reader user cannot change photo.
  - The floating navigation is wider than a 320 px screen when "Leaderboard" is the current tab (inferred).
  - On desktop the leaderboard's pinned "you" row sits under the navigation.
  - The new brand colour `#ff385c` gives white text 3.52:1, below the 4.5:1 minimum, on every primary button, the "Confirmed" pill and two chips.
  - The current tab's label is 3.04:1.
  - A stop card's text column is about 104 px wide at 320 px (inferred).
  - The place detail and the modal dialog claim to be modal but do not trap focus.
- **Twenty-four minors,** among them small touch targets, white text on three category colours and three person colours below 4.5:1, an undiscoverable keyboard reorder, four animations that ignore reduced motion, and one-off components that duplicate design-system primitives.
- **Earlier audit points:** contrast, layout at rubric widths and hover motion on cards are worse; the bottom sheet's focus handling is unchanged and fine.

### 6.1 Frontend logic: completed

- **Agent:** a frontend-engineer subagent. Files changed: `lib/api.js`, `lib/season.js`, `stores/planner.js`, `stores/events.js`, the scripts of `PolaroidLine.vue` and `MeetupGraph.vue`, `season.test.js`, and four new test files.
- **What changed:** a failed save rolls memory back and rejects with a message; at most 12 photos a session; a session summary carries `photoCount`, not the photos; reordering stops, photos and travel-mode changes no longer re-rank; a confirmed or completed session's plan is read from storage; a failed reorder is rolled back; a save is shape-checked; an expired season is closed before points are awarded; a demo-ended season ends at the next quarter boundary; one deterministic winner on a tie; `rank: null` at zero points; deleting the first stop keeps later stops on time; sign-up rules match the database and take a date of birth; no crowd; the planner store keeps `errors` and always resets `loading`.
- **Reported by the agent:** 80 new tests; it reverted fixes 1, 2, 3, 4, 5 and 11 one at a time and saw tests fail each time. The polaroid and graph fixes have no tests.
- **Left open by its contract:** views that still read `session.photos`; these go to 6.3.

### 6.2 Frontend views: completed

- **Agent:** a frontend-engineer subagent. It created `SampleNote.vue`, `lib/signupRules.js` and two test files, deleted `lib/planner/crowd.js`, and changed nine views, eight components, `plannerApi.js`, the planner library index and suggestions, two mock files, `stores/auth.js` and the tokens.
- **What changed:** "Ask AI", the contacts and location steps and every crowd estimate are gone; vouchers use invented café names under a "Sample rewards" banner; reviews are headed "Sample reviews"; a "Sample data for the demo" note sits on other people's profiles, the leaderboard, Home's places and the place detail; travel times say "about"; a planner outage shows an error with "Try again", not "Not found"; developer text shows only in development; `weatherCase` is sent only when the rain switch is on; sign-out says it erases everything; sign-up has a date-of-birth step.
- **Outside its brief, kept:** it changed `lib/planner/meetingArea.js` and its test so the meeting line says "about N minutes".
- **Not verified by the agent:** nothing was rendered.
- **State after both, run by the lead:** `pnpm --filter jio-frontend test` 180 passed, 1 failed (a stale assertion, assigned to 6.3); `pnpm build` succeeded.

### 6.3 Design and accessibility: completed

- **Agents:** two frontend-engineer subagents on separate files.
- **6.3a, photos, navigation, dialogs, motion.** The carousel has a Pause/Play button, pauses on hover and focus, and does not autoplay under reduced motion; deleting a photo asks first; the viewer has previous and next buttons at every size; the Photos page's dead end has a link, and thumbnails open the viewer; the navigation is never wider than the screen less 8 px each side, and hides the current label under 400 px; one `useFocusTrap` composable now serves the bottom sheet, the modal dialog and the place detail; reduced-motion guards on the global rule, the router's scroll, the map and the viewer; touch targets raised to 44 px; the graph has a Reset button and an accurate role; the reorder handle says how to use it.
- **6.3b, colour and views.** `--primary` went from `#ff385c` (white text 3.52:1) to `#d10027` (5.61:1), with the old value kept as `--primary-bright` for decoration without text; three category colours and three person colours darkened to 4.8:1 or better; a text-safe amber added; the leaderboard's pinned row sits above the navigation, its podium reads in rank order, and it has empty and error states; the stop card stacks at 480 px and below; the edit toggle now gates the delete, drag and re-plan controls; Home has error states and one fewer "Create meetup"; the profile's definition list is in the right order.
- **Reported by the agents:** both ran the app in a headless browser at 320 and 1280 px and checked the carousel, viewer, delete dialog, place detail, navigation at ten widths, the itinerary in edit mode and focus after delete.
- **Not verified by anyone:** the error and empty states that need a failing data layer; the leaderboard's pinned row at desktop width (the demo user was in the top ten).

### 6.4 Verification and commits: completed

- **Small fixes by the lead**, from the agents' "outside my scope" lists: the amber text token on the map's travel label; an unused class in `app.css`; "about" on the place detail's walk time; tighter travel-mode pills under 400 px; two stale comments; a dated note at the top of `frontend/docs/backend-integration.md` saying crowd is gone.
- **Checked by the lead in a browser** (the built-in one, with the backend on a spare port because port 3000 was in use by another project):
  - Sign-up end to end with a throwaway local account: eight steps, a date-of-birth step, the username hint without dots, no contacts or location step.
  - Rewards: the sample banner and invented café names. Leaderboard: the sample note, and "No rank yet" at zero points. Profile: `dt` before `dd`.
  - No horizontal overflow on Home, Rewards, Leaderboard, Profile, the create page and the design-system page at 320 px, on four of them at 375 px and at 1280 px. The navigation's computed width at 320 px is 304 px, and its tabs are 44 px tall.
  - No console errors beyond the dev server's hot-reload socket.
  - The lead did not walk the session flow itself (planner, itinerary, photos); the agents did, headless.
- **Results on the committed tree:**

| Step | Result |
|---|---|
| `pnpm test` | 317 passed, 1 skipped, 18 files |
| `pnpm --filter jio-frontend test` | 186 passed, 20 files |
| `pnpm build` | Succeeded |

- **Commits:** 8 for round 4, one merge of the session-flow branch, 14 for the audit fixes, then this log and `CLAUDE.md`. Everything was scanned for secret-shaped values before committing: none found.
- **Left on their tickets, not fixable here:** points, prizes and codes computed in the browser; one hard-coded user id; the browser sending the group to the planner; no login screen; confirming needs a second voter; the rollback that restores a whole session; no table for photos, seasons, points, vouchers or friends.

## Round 7: audit of the leaderboard and home pull request, and the design document (2026-10-10)

Parent task: the lead asked to merge the new pull request "Feat/leaderboard jiocoins" (head `65567bb`, 76 files, 45 commits, already based on current `main`), to make no frontend amendments, to audit it only, and to write the design document from its design language. Nothing in `frontend/` is to be changed by the lead or any agent in this round.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 7.1 | Testing, done by the lead | Install, tests and build on the pull request's head, which already contains `main` | Nothing | Real output for each command | **Completed**: `pnpm test` 317 passed, 1 skipped; `pnpm --filter jio-frontend test` 192 passed, 22 files; `pnpm build` succeeded. These match the pull request's own claims. |
| 7.2 | Design review | Layout, accessibility, motion and consistency of what the pull request adds or changes; which of round 6's fixes it keeps or undoes | Nothing | Each finding has a file and line and a severity; each round 6 fix is marked kept or undone | **Completed** |
| 7.3 | Code review | Logic, data layer, honesty of what is shown, security, tests; which of round 6's fixes it keeps or undoes | Nothing | Each finding has a file and line, a failure scenario and a severity | **Completed** |
| 7.4 | Documentation | Write `DESIGN.md` from the shipped code on this head | `DESIGN.md` and its sidecar file at the repo root, nothing else | Every token, component and motion rule named in it exists in the code at the stated path; known conflicts are recorded as facts | **Completed** |
| 7.5 | Lead | Merge the pull request; post the audit on it; commit the docs | Docs and the tracker | The pull request is merged, or the lead is told exactly why not | **Completed.** The first attempt was refused by the permission system as "merge without review". After the review was posted on the pull request the merge went through: merge commit `9bd2b90`. |

### 7.2 Design review: completed

- **Agent:** a design-reviewer subagent, read-only. It rendered nothing: contrast is computed from token values and layout is worked out from the CSS.
- **No blocker.** Seven majors and 23 minors, posted in full on the pull request.
- **Majors:** white text on `#ff385c` at 3.5:1 on every primary button, pill and chip; category and person fills back to 3.6 to 4.1:1 with white; the leaderboard's name column about 15 px wide at 320 px; "Last season" stranding the page on a skeleton if its load fails; "Hold to end" with no route for a screen reader, switch or voice user; calendar day buttons about 30 px at 320 px; the sample notes removed from the leaderboard and Home.
- **Round 6 fixes:** kept: the text-safe amber, the phone navigation's fit, the photo fixes, the focus trap, the stop card, "about N min", the global reduced-motion rule. Undone: the darker `--primary`, the darker category and person colours, the leaderboard's pinned row, the podium's reading order. Changed: where the sample note shows.
- **Well built, per the review:** the popover (labelled dialog, Esc, focus trap, focus return), the grid background (hidden from assistive technology, asleep under reduced motion), and reduced-motion guards on every new animation.

### 7.3 Code review: completed

- **Agent:** a code-reviewer subagent, read-only. It ran nothing.
- **No blocker by the brief's definition.** Six majors and 14 minors, posted in full on the pull request.
- **Verified by the lead by reading the code:** `components/dev/demoAccount.js` has no `dob`; `api.signUp` calls `assertDob(profile.dob)`; `auth.startOver` signs out before signing up. So "Dev: create a demo account" fails, and "Start over" erases everything and then fails. Also verified: `STARTING_MEETUPS.ian` is 10, and no Rewards banner remains. None of this was run.
- **Other majors:** a new account shows 10 invented meetups and 1,000 JioCoins as the user's own; the Rewards "not real offers" banner removed without being listed; the leaderboard and Home places unlabelled; votes cleared on a moved meeting area with no banner to say why; a session that waits for ever on a member who never sets a start.
- **Planner requests:** 4 per voting-page load and per vote, up from 0 to 2; a simulated voting round about 56, down from about 130.
- **Round 6 fixes:** all the data-layer and sign-up fixes are kept. The saved-data version is now 8, so a version 5 save loses its sessions, points and vouchers once.
- **Security:** no `v-html`, `eval` or new `target="_blank"`; one third-party image host removed; the dot map is derived from OpenStreetMap data with attribution in a code comment only.

### 7.4 Design document: completed

- **Agent:** an impeccable-documenter subagent. It wrote `DESIGN.md` (894 lines) and its sidecar `.impeccable/design.json`, and changed nothing else.
- **Verified by the lead with a script:** every token named with a hex value in a table row matches `frontend/src/styles/tokens.css`; all 40 file paths named in the document exist; of 110 token names, the two not defined in a stylesheet are `--chip-on` (a variable `ChipButton` reads) and `--name` (a placeholder in a sentence). The lead corrected two sentences that described the pull request by a file name.
- **Contents:** the design language, tokens, components, layout, motion, imagery and logo, voice, accessibility, 29 known conflicts stated as facts, and a 14-step checklist for building a new screen.
- **Not verified:** each component's props against its file, beyond the agent's own scripted check; the agent sampled the views by script and did not read them line by line.

### 7.5 Merge and docs: completed

- The pull request is merged into `main` as `9bd2b90`, with no frontend change by the lead or any agent.
- `CLAUDE.md` now points to `DESIGN.md` and records that the lead took the brighter brand red and the reduced sample notes as shipped.

## Round 8: fix the leaderboard audit's defects, and audit the external-APIs pull request (2026-10-10)

Parent task: the lead asked for every defect from round 7 to be fixed, and for the other open pull request, "Feature/external apis" (head `4903c4f`, 15 files, all backend and docs), to be audited. The fixes are on branch `fix/leaderboard-audit-defects`, cut from `main`. The four items the ticket lists as decisions for the lead are not touched: the brand red, the sample labels, the controls removed from the voting page, and the planner request count.

| # | Role | Scope | May change | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| 8.1 | Frontend | The nine defects on the ticket "Settle the findings from the leaderboard pull request's audit" | The files named in its brief, under `frontend/src/` | Round 7 | Each defect has a test or a stated browser check; the demo account and "Start over" work; frontend suite and build pass | **Completed** |
| 8.2 | Code review | The external-APIs pull request: OneMap search and routing, travel times, the cache, and how it sits with the live weather already on `main` | Nothing | None | Each finding has a file and line, a failure scenario and a severity | **Completed** |
| 8.3 | Testing, done by the lead | The external-APIs pull request's head, and the same merged with `main` | Nothing (a throwaway worktree) | None | Real output for each command | **Completed** |
| 8.4 | Lead | Verify 8.1 in a browser; bring `DESIGN.md` in step; post the audit of 8.2 on its pull request | `DESIGN.md`, docs, the tracker | 8.1, 8.2 | The checks pass; the audit is posted | **Completed** |

### 8.2 and 8.3 External-APIs pull request: audited, "changes required"

- **Agent:** a code-reviewer subagent, read-only, reading the pull request's head in a separate worktree. It ran nothing.
- **Run by the lead, on the pull request merged with `main` in a throwaway worktree:**

| Check | Result |
|---|---|
| Merge with `main` | Clean, including `CLAUDE.md`. The review expected a conflict there; there is none. |
| `pnpm test` | 334 passed, 1 skipped, 19 files |
| `pnpm test` with every outbound network call blocked | 334 passed; no blocked call was logged |
| `pnpm --filter jio-frontend test`, `pnpm build` | 192 passed; succeeded |

- **Blocker, reproduced by the lead** with stubbed HTTP and a counter on OneMap calls: one `/api/meeting-area` request with 30 members causes 480 route calls by default and 1,108 with `maxCandidates: 37`; a `/api/converge` with 5 members causes 10, or 20 when ends differ from starts. The account allows 300 calls a minute in total; the planner's limit counts requests, and the six-at-a-time limit is per request.
- **Majors, traced by the reviewer and not reproduced:** no 401 retry, and a failed login is retried on every trip; no deadline, circuit breaker or failure cache during an outage; the token is not fetched at start-up and a wrong password leaves no log line; the address search can spend the whole shared budget.
- **Clean:** every call goes through `services/http.js`; the engine stays synchronous; the scenario is in every cache key; no secret or real-looking credential in code, tests or docs; nothing of the pull request's first, duplicate weather service remains.
- **Posted** in full on the pull request. It was not merged: the lead asked for an audit only, and it has a blocker.

### 8.1 Leaderboard defects: completed

- **Agent:** a frontend-engineer subagent. It changed 18 files under `frontend/src/` and created three test files. No colour token, sample note, removed control or planner call count was touched.
- **What changed, by defect:**

| # | Defect | Fix |
|---|---|---|
| 1 | The demo tools fail | `DEMO_ACCOUNT` has a date of birth; `quickAccount` always resets and shows the error; "Start over" checks the profile before it erases anything |
| 2 | A new account has invented history | A form sign-up starts at zero. Only an account with `demo: true` gets the sample history, and the panel says so |
| 3 | "Last season" can strand the page | The card and its picker stay mounted; a failed load shows an error with "Try again" |
| 4 | "Hold to end" needs a sustained press | A click with `detail` 0 ends at once (a dialog still confirms); a mouse or touch click still needs the hold |
| 5 | Names at 320 px | At 480 px and below the amount sits under the name and the nested padding is smaller |
| 6 | Calendar days too small | Days are 44 px tall and fill their cell; arrow keys move between days; one tab stop |
| 7 | Votes vanish without a word | The "votes were cleared" banner is shown again while voting, and only that banner |
| 8 | A session can wait for ever | A "Waiting for N people" card; the host can continue without someone, behind a confirmation |
| 9 | Podium reading order | Written 1, 2, 3 and shown 2, 1, 3; rank labels are real text |

- **Verified by the lead:**
  - `pnpm test` 317 passed, 1 skipped; `pnpm --filter jio-frontend test` 229 passed, 25 files (192 before); `pnpm build` succeeded.
  - With the date of birth removed from the demo account by hand, six of the new tests failed; restored from a copy.
  - In a browser at 320 px, with the backend on a spare port: "Dev: create a demo account" lands on Home with a stored date of birth and the sample history; the leaderboard's name column is 118 px with nothing clipped and no horizontal overflow; the podium's written order is rank 1, 2, 3; a calendar day is 36.3 by 44 px, the grid has one tab stop, and today carries `aria-current`. No console errors.
- **Reported by the agent and not rechecked by the lead:** the form sign-up starting at zero on every screen; the hold button under a mouse hold, a quick click and a `detail` 0 click; the "Last season" error state; the votes-cleared banner; the "Continue without" flow against the real planner.
- **Not verified by anyone:** a real screen reader; the `/signup` redirect after "Start over" fails late.
- **Left as it is:** the saved-data version was not raised, so a save made by a form sign-up before this fix keeps its old seeded numbers.
- **`DESIGN.md`** was brought in step by the lead: seven sentences corrected and a "Changes since this was recorded" section added.

## Round 9: make the OneMap work safe, reconcile everything and merge (2026-10-10)

Parent task: the lead asked for the OneMap changes to be made, the defect fixes committed in sequence, and everything reconciled and merged to `main`. Work is on branch `feat/onemap-and-defect-fixes`: the nine defect fixes of round 8 as nine commits, then the external-APIs pull request merged in unchanged (clean, including `CLAUDE.md`), then the OneMap changes on top.

| # | Role | Scope | May change | Depends on | Acceptance criteria | Status |
|---|---|---|---|---|---|---|
| 9.1 | Backend | A cap on OneMap calls per request and for the whole process; token retry and login backoff; outage behaviour; logging; start-up checks | `backend/src/services/onemap.js`, `travel-times.js`, `cache.js`, a new budget file, `routes/plan.js`, `plan-schemas.js`, `app.js`, `index.js`, `.env.example`, backend tests and two backend docs | Round 8.2 | The audit's counter shows at most 60 route calls for any one request; the suite passes with outbound network blocked; each behaviour has a test | **Completed** |
| 9.2 | Lead | Verify 9.1, commit, push, open a pull request into `main`, merge | Docs and the tracker | 9.1 | All suites pass; pull request merged | **Completed** up to the commits; the pull request and `git log` record the merge |

### 9.1 OneMap limits: completed

- **Agent:** an implementer subagent. It created `backend/src/services/budget.js` and `backend/tests/onemap-limits.test.js` (49 tests) and changed `onemap.js`, `travel-times.js`, `routes/plan.js`, `app.js`, `index.js`, `.env.example`, two test files and two docs. The engine under `backend/src/planner/` is untouched.
- **What changed:**
  - One request routes at most 60 trips, whole candidates only, in the engine's order. The meeting area gives real routes to the five best candidate areas by estimate, or to none if one area alone would pass the cap. Everything else keeps the estimate and is flagged `approximate`.
  - One budget for the process, shared by routing, search and login: six calls in flight and `ONEMAP_CALLS_PER_MINUTE` a minute, 240 by default. An empty budget never waits: a trip becomes an estimate, and a search answers 503 `search_unavailable` with `Retry-After`.
  - A 401 drops the token, logs in once (shared) and retries once. A failed login blocks logins for 60 seconds. A failed renewal keeps an unexpired token.
  - After five consecutive failed route calls, no calls for 30 seconds. One request waits at most 8 seconds on routing.
  - One warning per reason per minute when routing falls back. The `travel` object now says how many trips were asked for, routed, cached, walked, failed and estimated.
- **Changed by the lead after review:** the brief told the agent to refuse to start when either OneMap variable still held the example value. The lead's own `backend/.env` holds those values, as would every teammate's, so the server would have stopped starting. The example values now count as not set, as they did in the teammate's code; only half an account is refused. The brief was wrong, not the agent.
- **Verified by the lead:**

| Check | Result |
|---|---|
| `pnpm test` | 383 passed, 1 skipped, 20 files |
| The same with every outbound network call blocked | 383 passed; no blocked call logged |
| `pnpm --filter jio-frontend test`, `pnpm build` | 229 passed, 25 files; succeeded |
| The audit's counter, one `/api/meeting-area` request with 30 members | 59 route calls by default, 60 with `maxCandidates: 37`; 480 and 1,108 before |
| The counter, `/api/converge` with 5 members | 10, or 20 when ends differ: unchanged, and under the cap |
| The backend started with the local settings, on a spare port | Starts, and logs that OneMap routing is off |

- **Not verified by anyone:** anything against the real OneMap service. The agent's start-up login line is covered by a unit test only.
- **Known trade-offs, as reported:** a meeting-area result can compare real times for the routed areas with estimates for the rest, so the winner can be an estimate-only area (the answer says `approximate`); with 30 members only two areas fit under the cap; address search draws on the same budget as routing, with no reserved share.
- **Commits:** nine for the defect fixes, the merge of the external-APIs branch, six for the OneMap changes, then this log and `CLAUDE.md`.
