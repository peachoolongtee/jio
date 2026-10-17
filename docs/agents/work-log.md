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

## Round 10: Home as a map of every current meetup (2026-10-10)

Parent task: the lead asked for Home to show all current meetups on the map, with a detail for the one selected and a list below, built on a separate branch, keeping the animations and improving them where there is a case. In parallel `dev` was brought level with `main` through a pull request from `main` into `dev`, merged.

Today Home is built around one meetup: the most recently created one that is not completed or cancelled. Any other active meetup is not shown on Home at all. Work is on branch `feat/home-meetups-map`, cut from `main`.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 10.1 | Frontend | Home shows every active meetup: a pin each on the dotted map, a detail card for the selected one, a list sorted soonest first, and a way to start another | `frontend/src/views/LandingView.vue`, `components/ui/SingaporeMap.vue` (additions only), new components under `components/home/`, a new `lib/homeMeetups.js` and its test | With three active meetups, all three are reachable from Home; selecting by pin or by row shows the same detail; a meetup without a meeting point appears in the list; nothing overflows at 320 px; every animation that exists today still plays and respects reduced motion; frontend suite and build pass | **Completed** |
| 10.2 | Lead | Verify in a browser, bring `DESIGN.md` in step | `DESIGN.md`, docs | 10.1 | **Completed** |

### 10.1 Home as a map of every current meetup: completed

- **Agent:** a frontend-engineer subagent, in two passes. The second pass came from the lead, who looked at the first and asked for the details to appear at the pin on hover, as first requested. The lead agent had steered the first brief toward a card under the map; that was the lead agent's call and the wrong one.
- **Built:** `lib/homeMeetups.js` (ordering soonest first, the next step for the signed-in person, pin positions with a fan-out for shared areas, selection, and where a pin's card sits); `components/home/MeetupPins.vue`, `MeetupSummary.vue`, `MeetupDetail.vue`, `MeetupList.vue`, `NextStepChip.vue`; `LandingView.vue` rewired around a selected meetup kept in `?meetup=<id>`; one additive `quick` prop on `SingaporeMap.vue`; a section in `DesignSystemView.vue`.
- **Kept:** every existing animation, and the no-meetup Home, which the agent compared box for box and by screenshot hash against `main` at 375 and 1280 px.
- **Verified by the lead, in a browser on a spare port, with three meetups created through the real planner** (two with meeting points, one still inviting):
  - Both meetups with a meeting point have a pin; the third is in the list with no pin. Pins are 50 by 64 px.
  - Clicking the "Tue" pin gives `?meetup=s2`, the Study session detail, a pressed pin and row, and "Places near Caldecott".
  - Selecting the meetup with no pin by its row gives `?meetup=s3` and no pressed pin.
  - Hovering a pin: no card at 60 ms, a card after the delay, 264 by 269 px, to the right of the pin, inside the map and the viewport, not covering the pin, with the right meetup and link. The selection and the address did not change.
  - No horizontal overflow at 320, 375 and 1280 px. No console errors.
  - The lead's pane was not on screen, so the hover was driven by dispatched pointer events and the card's closing transition could not finish there; the agent measured the close in a headless browser at about 300 ms.
- **Reported by the agent and not rechecked by the lead:** keyboard and touch behaviour of the pin card; placement at 320, 375 and 768 px with ten meetups; reduced motion; the fan-out of pins on one area.
- **Results:** `pnpm --filter jio-frontend test` 280 passed, 26 files; `pnpm test` 383 passed, 1 skipped; `pnpm build` succeeded.
- **Also fixed by the lead:** `frontend/src/lib/__tests__/api.backend.test.js` started the real backend with real HTTP, so its first ranking fetched the live forecast and once ran past the 5-second limit. It now uses stub HTTP. With outbound network blocked the whole frontend suite passes and nothing tries to leave the machine.
- **Open, for the lead:** on phones the pin card is taller than the map can hold, so it overlays the greeting or the card below; neighbouring areas' pins can overlap, since only identical areas fan out; selecting a low row on a phone does not scroll the card into view; with one meetup on a wide screen the right half beside the card is empty. An older Leaflet teardown error on leaving the plan page quickly was noticed and not touched.

## Round 11: four problems the lead found by using the app (2026-10-10)

Parent task: the lead reported four problems and asked for them to be inspected, fixed and merged to `main`. Work continues on `feat/home-meetups-map`, so the merge takes the new Home with it.

| # | The lead's words | Where to look first |
|---|---|---|
| 1 | "name cut off on home page" | The greeting on Home: large text filled with a gradient, on a tight line height |
| 2 | "when selecting end time, +/-2 hour too close to next" | `RadialTimePicker`'s ring of step buttons against the "Next" button and the other picker |
| 3 | "no back button after selecting date of session" | Create session goes straight to the invite step with no way back to the date and times |
| 4 | "toggling between different stages in the session using the bar on top abit glitchy" | `SessionSteps` as pages change |

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 11.1 | Frontend | Reproduce each problem with a measurement, fix it, measure again | The files named in its brief, under `frontend/src/` | Each problem has a before and an after number; frontend suite and build pass | **Completed** |
| 11.2 | Lead | Verify, bring `DESIGN.md` in step, commit, push, merge to `main` | Docs and the tracker | All suites pass; pull request merged | **Completed** up to the commits; the pull request and `git log` record the merge |

### 11.1 Four problems from use: completed

- **Agent:** a frontend-engineer subagent. It reproduced all four in a headless browser before changing anything, and measured each again afterwards.

| # | Problem | Before | Cause | After |
|---|---|---|---|---|
| 1 | Name cut off on Home | "Peggy Png" had 267 pixels of ink outside the name's box at desktop widths; "Farhan W" ran 4.1 px past the right edge; "Ian" had none | The name is painted through `background-clip: text`, which only shows inside the element's box: a 0.95 line with 0.06em of padding and negative letter spacing | 0 pixels outside the box for six names at seven widths |
| 2 | "+/-2 hour too close to next" | The End picker's ring overlapped the "Next" button by 25 px on phones and 33 px from 744 px, and floated above it; each ring overlapped the other picker's pill by 23 px on phones | The ring reaches 141 px each way and the form left 48 to 115 px | At least 14.6 px from "Next" and 16.6 px from the other pill; a tap on either button changed the time and never navigated |
| 3 | No back after the date | The invite step's only back control went to the session; the Create step was a dead label; browser Back went Home | Creating a session replaced the page with the invite step, and no edit path existed | A back arrow to an "Edit session" form with the values filled in; `api.updateSession`, host only and only while inviting; the Create step links there |
| 4 | Steps bar glitchy | The bar dipped to 81% opacity and drifted 6 px on every click; keyboard focus was lost in 160 of 160 activations; a second press 80 ms after the first was lost 3 times of 3; the bar's height differed between screens by up to 39 px | The bar was part of the page's cross-fade, and each header laid it out differently | Opacity stays at 1 with no drift; focus stays on the pressed step 160 times of 160; the second press took effect 6 times of 6; one height on all six screens at each width |

- **Also fixed by the agent, found during the sweep for problem 1:** a long meetup title on Home could not be read anywhere. The full-size card now wraps it; the pin card and list rows carry it as a tooltip.
- **Verified by the lead, in a browser on a spare port at 1280 px:**
  - With the account named "Peggy Png", the greeting's name box is 103 px tall for a 76 px line, with 0.22em of padding below; no horizontal overflow.
  - The invite step's back control is "Back to date and times" and leads to `/sessions/s1/edit`; that page is headed "Edit session" with the title and both times filled in; its back control returns to the invite step.
  - On the edit form the End picker's pill is 140 px above "Next", and 154 px below the Start picker's pill.
  - The steps bar is at the same height (84 px) on the session, invite and edit screens, and carries the transition name `session-steps`.
  - The lead did not open a ring or click through the steps; the pane was not on screen, so those rest on the agent's measurements.
- **Results:** `pnpm --filter jio-frontend test` 324 passed, 30 files; `pnpm test` 383 passed, 1 skipped; `pnpm build` succeeded.
- **Left, as reported:** a single word longer than the screen in the greeting is cut by the page's edge; the session header clips a title of about 60 characters at 320 px; with a mouse on a narrow window that has the sticky footer, an open End ring can still sit over the footer; keyboard users can type a time and cannot reach the ring's buttons; an old Leaflet error on leaving the plan page quickly.

## Round 12: audit of the Google Places pull request, then merge (2026-10-11)

The lead asked: "review the PR and merge together to main". The pull request is peachoolongtee/jio#91, "Add OneMap places, hawker closures and Google Places", by faithpho, from `feature/google-places` at `f9eef70`. It is backend only: 29 files, 38,231 lines added, of which 36,159 are one saved data file.

- **Where the work happens:** a throwaway worktree on branch `feat/google-places-integration`, which is `main` at `5b975c2` with the pull request merged in. The merge had no conflicts.
- **Before any review, by the lead, on the merged tree:** `pnpm test` 421 passed, 1 skipped, 22 files, and the same with outbound calls blocked (no call attempted); `pnpm --filter jio-frontend test` 324 passed, 30 files; `pnpm build` succeeded.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 12.1 | Code reviewer, read-only | The Google service, the photo route, the key, cost and the planner routes' new inputs | Nothing | Every finding has a file, a line and a way to trigger it | **Completed**: "changes required" |
| 12.2 | Code reviewer, read-only | The saved OneMap places, the hawker closures, the venue lists and the filters | Nothing | Same | **Completed**: "changes required" |
| 12.3 | Verifier | Run the merged server in stub mode and try to break it; count OneMap and Google calls; scan for secrets | Nothing in the repo | Each claim in the pull request is marked confirmed or not, with output | **Completed** |
| 12.4 | Lead | Check each finding, decide, fix or record, merge to `main` | Docs, the tracker, fixes on the integration branch | All suites pass; the review is on the pull request | **Completed** up to the commits; the pull request and `git log` record the merge |
| 12.5 | Backend | Fix the Google findings: a call budget, a circuit and timeout, shape checks, the photo route, the key, an invented fixture | The Google files, their tests and docs | Suites pass, also with outbound calls blocked; defaults unchanged | **Completed** |
| 12.6 | Backend | Fix the OneMap-places findings: closure matching, the CDC merge, broken links and text, duplicates, closed weekdays, guessed values, stale closures | The OneMap-places files, their tests and docs | Same; venues that existed before are unchanged except where intended | **Completed** |

### 12.1 to 12.3 The audit: nothing unsafe, several real defects

No reviewer could leak the key, steer the photo route to another host, or exceed the OneMap limit of 60 routed trips per request. All three asked for changes.

**Confirmed true, with evidence:**
- The Google key is sent only as a request header. It was in no response body, header, redirect or log line across converge, roam and photo requests (a fake key, stub and fake-fetch runs).
- The photo route fetched only `places.googleapis.com/v1/places/<id>/photos/<id>/media` for 34 hostile inputs (traversal, full URLs, encoded slashes, repeated parameters, control characters).
- One Google call per planner request at most, none for the meeting area or search; the cache is bounded at 500 and 2,000 entries.
- With no key the server makes no Google call and answers `google: { source: 'off' }`.
- `minOptions` and `shortlistSize`: answers are identical with the fields left out and with the defaults sent, for six fixed requests; both reject 0, negatives, 31, floats and strings.
- OneMap route calls per request stayed at or under 60 at the widest settings. One meeting-area request with 30 members measured 60 on this tree and on `main` (round 9 recorded 59; the cap is 60 and was not passed).
- Speed: converge and roam medians went from about 3 to 5 ms to about 5 to 6 ms; loading the plan data went from 13 ms to about 65 ms at start-up.
- A hawker centre is left out on each day of its closure, including the last, and is back the day after.
- No secrets in the 38,733 added lines. One organisation's contact email address sits in a saved opening-hours text.
- The edited OneMap limits test still proves what it proved.

**Defects found (the lead read the Google code and confirmed 1 to 5 there before delegating the fixes):**

| # | Where | Defect |
|---|---|---|
| 1 | Google service | Nothing caps Google calls for the process. One caller at the planner's 300 requests a minute caused 300 nearby searches and, separately, 300 photo calls in a minute; the cache key holds the exact radius, so 2,901 radii are 2,901 keys |
| 2 | Google service | A hung Google added 10 s to every planner request (six at once took 10.06 s each, and the next 10.0 s again); nothing backs off, and each failure writes a log line |
| 3 | Google adapter | A 200 from Google with an unexpected shape answered 500 for the whole request (four shapes), and the body was cached for 10 minutes |
| 4 | Photo route | A fractional width is forwarded; every width is its own billed call; the name has no length limit; the redirect target is not checked (a `javascript:` link and another host were redirected to) |
| 5 | Start-up | A whitespace-only key counts as a key |
| 6 | Test fixture | The Google fixture is a recorded real response (real place ids, names, addresses, ratings, hours), against the code's own note that only a place id may be stored |
| 7 | Hawker closures | 15 venues take the closures of two or three neighbouring centres, adding 19 future periods that are not theirs; one centre's row matches no venue |
| 8 | CDC merge | An OneMap centre replacing its CDC copy loses the copy's dietary hints, so a halal or vegetarian group loses venues it had; about 20 centres named by street and block do not merge at all |
| 9 | Saved places | 92 photo links have no scheme; names and credits are garbled ("SandsÂ®"); 21 places appear twice across lists, and two curated hawker centres are duplicated |
| 10 | Opening hours | "Closed on Monday" is ignored, so a closed attraction is offered on a Monday; by-appointment places are offered |
| 11 | Guessed values | Every attraction is priced at $15 and tagged from the guess; community-club and school halls are offered as theatres |
| 12 | Closure data | All cleaning dates end in 2026; from January 2027 every centre reads as open, with no warning |

**Not defects, but for the lead:** the nearby search's field mask asks for rating, review count, hours and price level, which is probably Google's dearer billing tier (not looked up); Google's terms restrict showing Places content beside a non-Google map, and Jio's map is OneMap; a Google venue exists only in the request that fetched it, so an option being voted on can vanish when the cache expires; the planner's validation error has `issues` and no `message`.

### 12.5 Google fixes: completed

- **Agent:** an implementer subagent, on the Google files only.
- **Call cap.** Every nearby search and photo call goes through one budget (`createCallBudget`, now reusable for a second service): 60 calls a minute by default (`GOOGLE_CALLS_PER_MINUTE`), 4 at once. A refused call throws `GoogleUnavailableError`, so the planner answers 200 with `google.source: 'unavailable'` and the photo route 503. The search radius snaps up to 500, 1000, 2000 or 3000 m for the request and the cache key.
- **Failure.** Three failures in a row pause Google for 60 seconds, then one probe is let through. Google calls time out after 3 seconds (a new per-call `timeoutMs` on the HTTP helper; every other service keeps 10). A failure is logged once a minute per reason.
- **Shape.** A `places` that is not a list is a failure and is not cached. An entry that cannot be read is skipped; an answer with skipped entries is used and not cached.
- **Photo route.** Widths snap to 200, 400, 800 or 1600; each id in the name is 1 to 300 characters; the redirect goes only to an `https` address on `googleusercontent.com` or `ggpht.com`, otherwise 502; the redirect carries `Cache-Control: public, max-age=1800`; a Google 404 or 400 is remembered for 5 minutes and answers 404.
- **Key.** `readGoogleSettings(env)` trims it; blank, or anything outside printable ASCII, counts as not set, with a warning that never prints the value. Start-up prints one line when Google is on.
- **Fixture.** Replaced with six invented places (`stub_place_01` to `06`). The recorded one remains in git history.
- **Also:** the point Google is asked about now follows the engine's `seed`; the planner's validation error carries a `message` beside `issues`; `photo.credits` lists every author.
- **Reported by the agent, not acted on:** existing test files open servers with `listen(0)` on every address, and a port can collide with another program on this machine (3 failures in 37 runs once the new file was added; the new file listens on `127.0.0.1` only, and 18 runs in a row passed). With a hung Google, the fifth and later requests in the first burst can wait about 6 seconds before the pause begins. Whether real Google photo ids stay under 300 characters is unchecked.

### 12.6 OneMap places and closures fixes: completed

- **Agent:** an implementer subagent, on the places files only.
- **Closures.** Each venue takes one centre's dates at most, its own. Closure periods attached went from 824 on 178 venues to 606 on 145. Bukit Timah Market's row matches nothing because the saved OneMap list has no centre by that name within 2.9 km; it is reported in `_meta.closures.rowsWithoutVenue`.
- **CDC merge.** An OneMap centre that replaces a CDC site keeps the site's dietary hints, stalls and kind. The site dropped is now the one with the same postal code, then a large site, then the nearest; the first-in-file rule had picked the wrong neighbour for 25 of 122 centres. Every OneMap hawker row is a centre whatever its name. CDC sites replaced: 111 by OneMap centres and 8 by curated ones (90 together before).
- **Text and links.** The adapter re-decodes text that was UTF-8 read as Windows-1252, strips tags, repairs postal codes, removes contact details and drops descriptions that are only codes. `pnpm repair:onemap-places` applied the same functions to the saved file with no network: 300 lines changed in 251 of 483 places, and a second run changed nothing.
- **Duplicates.** 16 OneMap rows dropped as the same place as another, 20 as already in a hand-made list. Central Library and Central Arts Library stay separate, as do 13 close pairs listed in the snapshot test.
- **Closed weekdays.** "Closed on Monday" becomes `closedWeekdays` at load and the hours filter answers `closed`; seven attractions are affected. Two by-appointment places leave the pool.
- **Guessed values.** 16 theatre rows (community clubs, schools, an auditorium, an amphitheatre, two studio rooms), 10 interim parks and 2 islets leave the pool and stay in the file. 18 theatres remain.
- **Stale closures.** The plan data reports the covered range (`lastCleaning` 2026-12-30) and warns at load from 30 days before it. The build script refuses to overwrite the file with an empty list, writes in a stable order, and prints one line when the login fails.
- **Pool:** 1,894 venues before the fixes, 1,819 after (eat 1,462, drink 16, activity 326, shop 15); 417 of the 483 saved OneMap places reach the planner.
- **Venues that existed before the pull request:** 42 CDC sites removed (now replaced by their centre), 13 added back (the wrong neighbour had been dropped), `closures` changed on 4, a new `closuresFrom` field on 30, no other field changed. The mock "Tampines Hawker Hub" lost four closure periods it had taken from a centre 478 m away.

### 12.4 The lead's checks and decisions

- **Changed by the lead:** the agent's rule withheld "Budget friendly" and "within budget" from every venue with a guessed price, which took the tag from all 1,303 CDC venues that had it before. The rule now applies to OneMap and Google venues only (`priceIsKnown` in `scoring.js`); whether CDC venues should lose it too is left to the lead.
- **Run by the lead on the fixed tree:** `pnpm test` 547 passed, 1 skipped, 24 files, and the same with outbound calls blocked (no call attempted); `pnpm --filter jio-frontend test` 324 passed, 30 files; `pnpm build` succeeded.
- **Checked by the lead with a separate script (a fake fetch under the real HTTP helper, outbound blocked):**
  - East Coast Lagoon Food Village is closed on 2026-10-12 and 14 and open on the 11th and 15th; Toa Payoh Lorong 4 Blk 93 has four periods, all its own, and is open on 2026-11-08.
  - North Bridge Road Market has `halal: likely`, `cdcAccepted` and 16 stalls.
  - Esplanade, Chinatown Complex, Kovan 209 and the National Museum each appear once; no photo link lacks `https://`; no name is garbled.
  - A `places` of the wrong type gives 200 with `google.source: 'unavailable'`; with a cap of 5, twelve searches at different points made 5 Google calls and the other seven answered `unavailable`; a blank key makes no call.
  - A photo link on another host answers 502 with no `Location`; a good one answers 302 with the cache header, and a width of 250.7 was asked of Google as 400.
  - Eurasian Heritage Centre is `closed` on Monday 2026-10-12 at 10:00 and fits on the Tuesday.
- **Not checked by the lead:** radius snapping (the lead's attempt ran with the budget already empty, so it rests on the agent's tests and its mutation check); anything against the real Google or OneMap services.
- **Secrets:** none in the changes. The one key-shaped string is a labelled fake in a test.
- **For the lead:** Google's billing tier for the field mask; Google's terms on showing Places content beside a non-Google map; the recorded fixture in git history; whether the four school-owned theatres that sell public tickets should stay; whether "SAM at 8Q" and "Singapore Art Museum" are one place.

## Round 13: Home's start row and showcase demo data (2026-10-11)

The lead chose both from a short list of options: the action that starts a meetup becomes the first row of Home's list, and the demo tools gain a spread of sessions in every state. One frontend-engineer subagent, on branch `feat/demo-showcase` in the main checkout. Committed and sent to `main` at the lead's word on 2026-10-11, on top of round 12; on that tree `pnpm test` gave 547 passed, 1 skipped, `pnpm --filter jio-frontend test` 353 passed, 33 files, and `pnpm build` succeeded.

- **Built:** `StartMeetupRow.vue` (a link, first in the list, the corner pill removed); `components/dev/showcase.js` (`loadShowcase`, ten sessions made through the data layer's public functions); `components/dev/offlinePlanner.js` (a stand-in used only while the showcase loads and only when the backend gives no answer); `DemoSignIn.vue` (two buttons on the sign-up screen in development builds); `createSession({ hostId })` and `inviteFriends(..., { acceptAfter })` in `lib/api.js`, neither used by the app itself.
- **Run by the lead:** `pnpm --filter jio-frontend test` 353 passed, 33 files; `pnpm build` succeeded; the production bundle contains neither "showcase" nor "Use the demo account".
- **Checked by the lead on the lead's own dev server:** "Use the demo account with showcase data" signed in and loaded ten sessions in about eight seconds against the real backend (s1 to s10: two inviting, three locating, two voting, two confirmed, one completed; s10 hosted by Darius); Home showed five pins, no corner pill, and "Plan a new meetup" as the first row, a link to the create screen.
- **Not checked by the lead:** widths and overflow (the browser pane was not on screen), which rest on the agent's headless runs.
- **Differences from the brief:** the long title is 60 characters, the form's limit; the app has no fallback when the planner backend is off, so the stand-in was added for the showcase only.
- **Incident:** the agent stopped its own backend with `pkill -f "node src/index.js"`, which also stopped the lead's backend on port 3000. The lead agent restarted it through the lead's own `node --watch` process by touching a watched file, and confirmed the port was listening. Briefs that let an agent start a server now say: stop only the processes you started, by process id.

## Round 14: decisions on meeting spots and Roam, and a handoff (2026-10-11)

The lead took the recommended answer to ten questions on how converge and roam should work. The decisions, the contract, six slices and the delegation briefs are in `docs/handoffs/meeting-spots-and-roam.md`, written for a fresh session. Nothing is built.

## Round 15: meeting spots the group suggests and votes on, slices 1 and 2 (2026-10-11)

Parent task: the lead said to continue the feature in `docs/handoffs/meeting-spots-and-roam.md` on a second machine (Windows). The decisions are on the tracker ticket peachoolongtee/jio#94; tickets #94 to #99 sit under the wayfinder map.

The first attempt, on the first machine, was never committed or pushed, so nothing of it reached this machine: no baseline test, no schema fields. This round starts both slices again. The handoff in the repository was replaced with its later revision (the one that records the pause), and the six new words went into `CONTEXT.md` again.

Work is on branch `feat/meeting-spots`, cut from `main` at `2e1643d`, which now carries the Google Places work (peachoolongtee/jio#91 and #100). The showcase branch `feat/demo-showcase` is not on the remote, so `createSession` and `inviteFriends` are as `main` has them.

This machine:

- The global `pnpm` (11.9.0) cannot start the pinned 12.4.1, so the root scripts fail. The suites are run directly: `node node_modules/vitest/vitest.mjs run` in `backend/` and in `frontend/`, and `node node_modules/vite/bin/vite.js build` in `frontend/`. Running the pinned pnpm through its Node entry point works but adds `@pnpm/exe` to `pnpm-lock.yaml`; that change was put back and is not part of this work.
- Two backend tests built a script path from `new URL(...).pathname`, which gives `C:\C:\...` on Windows. Both now use `fileURLToPath` (`onemap-limits.test.js`, `onemap-snapshot.test.js`); three failures became one.
- One backend test still fails here and only here: "the real saved file is already repaired: another run changes no byte" in `onemap-snapshot.test.js`. Git checks `onemap-places.json` out with CRLF line endings on this machine (`core.autocrlf` is true) and the repair script writes LF. Left alone: the fix is a `.gitattributes` rule, which is the lead's to decide.

Baseline before any source change, run by the lead agent: backend 546 passed, 1 failed (the line-ending test above), 1 skipped, 24 files; frontend 324 passed, 30 files; build succeeded.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 15.1 | Backend | `alternatives`, `include` and `candidates` on `POST /api/meeting-area` (ticket #94), with a baseline test recorded first | `backend/` only | Old requests answer exactly as before; bounds tested; at most 60 route calls with 30 members, 3 alternatives and 8 included areas; suite passes with outbound calls blocked; docs updated | **Done and checked by the lead** (results below) |
| 15.2 | Frontend | Spots, approvals, confirm, known place and the version bump in the local data layer (ticket #95) | `frontend/src/lib/`, `frontend/src/stores/` and their tests | One test per rule in the decisions; an old save loads; frontend suite and build pass; no existing test deleted, skipped or weakened | **Done and checked by the lead** (results below) |
| 15.3 | Lead | Verify both reports, record results | Docs | Both suites and the build run by the lead; the baseline test run on an untouched `main`; the riskiest claim in each report read in the code | Done |

### 15.1 result: runners-up and named areas on `/api/meeting-area`

- **Built (backend agent):** `alternatives` (0 to 3) and `include` (up to 8 area ids) on the request, `candidates` on the answer, both bounds in the `MAX` block after `members`. Changed `plan-schemas.js`, `engine.js` (`areasToTry`, `meetingAreaPlan`, `candidates` in `meetingArea`), `travel-times.js` (`namedAreas`, `routingOrderWithNamedAreas`), `plan.js`, `backend/docs/planner-api.md`. New tests: `meeting-area-baseline.test.js` with a fixture of 84 recorded requests, and `meeting-area-candidates.test.js` (46 tests).
- **Run by the lead:** the backend suite, 677 passed, 1 failed, 2 skipped, 26 files, and the same with outbound calls blocked, with no `BLOCKED_OUTBOUND` line. The one failure is the line-ending test named above. The second skip is the baseline's recorder, which runs only when asked to.
- **Checked by the lead:** the baseline test and its fixture, copied into an untouched export of `origin/main` (`git archive`, no `alternatives` anywhere in its schema), passed three times, 85 of 85. The fixture's sha256 is `b1f0fd82…5687`, as the agent reported. The lead read the whole diff of `backend/src`: extra areas are measured on a separate count, so the top-level answer cannot change; the cap loop in `travel-times.js` is the same loop, fed a different order.
- **Not checked by the lead:** the route-call count of 60 at the widest setting rests on the agent's test (which asserts at or under `MAX_ROUTED_TRIPS_PER_REQUEST` and that the cap did bite); the agent's two mutation checks; anything against the real OneMap.
- **Differences from the brief, accepted:**
  - `approximate` at the top level is true when any area the ranking compared used an estimate, not only the chosen one. It had to stay as it is, so each candidate's `approximate` is about that area's own trips, and `candidates[0].approximate` can be false while the top-level flag is true.
  - The routing order is: the meeting point of a non-station method, then the usual best five by estimate, then included areas in the order sent, each only if it fits the cap whole. With 12 or more members the five fill the cap, so a member's suggested spot shows estimated times ("about"). With 10 members the first included area gets real routes and the second does not.
  - For a non-station method a runner-up can have a shorter longest trip than the chosen area, because the centre is not chosen by the station rule.
  - `candidates` appears whenever either field is sent, including `alternatives: 0`.

### 15.2 result: meeting spots in the local data layer

- **Built (frontend agent):** `suggestSpot`, `withdrawSpot`, `approveSpot`, `confirmSpot` and `setKnownPlace` in `lib/api.js`, with store wrappers in `stores/events.js` (`suggestMySpot`, `withdrawMySpot`, `approveMySpot`, `confirmSpot`, `setKnownPlace`). `VERSION` is 9. `meetingArea` in `plannerApi.js` takes `alternatives` and `include`; `meetingResultLine` has words for `voted` and `chosen`; `nextStepFor` answers "Confirm the spot", "Say which spots work for you" and "Waiting for the host". New `meetingSpots.test.js` (48 tests), three added to `plannerApi.test.js`, one to `api.backend.test.js` that goes through the real backend app.
- **What the screens read:** `session.spots` is `{ list, approvals, suggestions, appMethod, preselectedAreaId }`. Each spot in `list` has `areaId`, `by` (`'app'` or a person id), `byName`, `here`, `worstMinutes`, `meanMinutes`, `times`, `approximate`, `area` (the area's own name and coordinates), `approvedBy` and `approvalCount`. `session.findingSpots` is true while the planner works the spots out. A banner that removed approvals carries `approvalsRemoved: true`. A known place set before anyone shared a start has `worstMinutes` and `meanMinutes` of null and no `times`.
- **Run by the lead:** the frontend suite, 376 passed, 31 files; the build succeeded. `pnpm-lock.yaml` is unchanged, and only `frontend/src/lib/`, `frontend/src/stores/` and their tests changed.
- **Checked by the lead:** the diff of every existing test file is additions only. The lead read the whole diff of `lib/api.js`: a call to `meetingArea` without the new arguments posts the body it always did; the spots view carries an area's coordinates and never a member's label or place; `approveSpot` and `withdrawSpot` make no planner call; `suggestSpot`, `confirmSpot` and `setKnownPlace` run inside `orUndo`.
- **Not checked by the lead:** the run with outbound calls blocked (the agent reports 376 passed and no blocked call); anything on a screen, because no screen uses these functions yet.
- **Beyond the brief, accepted for now and for the lead to confirm:**
  - `spots` also stores `suggestions` (who suggested which area) and `appMethod`. A spot the app lists is `by: 'app'` even when a member suggested it too.
  - A confirmed area with method `voted` or `chosen` is pinned: a later start, opt-out or re-plan only updates travel times and never moves it. The brief asked for this for a known place; the agent applied it to a voted spot as well. The app's first spot confirmed with no approvals keeps the planner's method and can still move, as today.
  - With no approvals, the preselected spot is the one with the shortest longest trip, which can be a member's suggestion.
  - The group can hold at most 8 different suggested areas, the planner's `include` limit.
- **Known gaps:** `suggestSpot` does not take the "latest request wins" ticket that a location change takes, so a suggestion racing a location change could apply the older answer. After a known place, when some members have a start and others do not, places are ranked for the ones with a start only.

## Round 16: the Locate screen for meeting spots, slice 3 (2026-10-11)

Parent task: the lead asked for slice 3 to be finished. Slices 1 and 2 are committed on `feat/meeting-spots` (seven commits on `2e1643d`, not pushed); at the lead's request the commits carry no co-author line.

Baseline before any change: backend suite 677 passed, 1 failed (the line-ending test from round 15), 2 skipped, 26 files; frontend suite 376 passed, 31 files; build succeeded.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 16.1 | Frontend | The Locate step in `GroupDetailView.vue`: the list of spots, "Works for me", "Suggest a spot", the host's confirm, "We already have a place" there and on the create screen, pins on the map, Home's chips, demo tools (ticket #96) | `frontend/src/views/GroupDetailView.vue`, `CreateEventView.vue`, new components, Home's chip and summary components, `components/dev/`, tests; not `lib/api.js` beyond a reported defect | No overflow at 320, 375, 744 and 1280 px; every control reachable by keyboard and named; the steps bar does not move; frontend suite and build pass; no existing test deleted, skipped or weakened | **Done and checked by the lead**, with one defect found and fixed by the lead (results below) |
| 16.2 | Lead | Verify the report, open the screen, record results | Docs | Suites and build run by the lead; the screen opened by the lead at the four widths, or what was not seen said plainly | Done |

### 16.1 result: the Locate screen for meeting spots

- **Built (frontend agent, in two runs; the first stopped at its turn limit with no report and was resumed):** `GroupDetailView.vue` shows "Where to meet" while locating; new `components/spots/` (`SpotList`, `SpotRow`, `SpotConfirm`, `SpotPins`, `KnownPlaceField`, `spotText.js`, `knownPlaceChoice.js`); "We already have a place" on the create screen, in the lobby and on Locate; a "Meeting spots" group in the demo tools (`components/dev/spotDemo.js`); `NextStepChip` wraps a long step. New tests: `spotsScreen.test.js` (22) with `miniDom.js`, a small stand-in for the page.
- **Outside the files the brief allowed, accepted:** `PlannerMap.vue` gained a `keep` prop, a `view` event and an exposed `project(lat, lng)`, so the spot pins can sit at their place on the map; `LocationSheet.vue` gained an optional `title`; `frontend/vite.config.js` compiles one test file for the browser so components can be rendered in a test. Existing callers pass none of the new props.
- **Defect found by the lead in the browser, and fixed by the lead:** after the host confirmed a spot, or set a known place from Locate, the session moved to Voting but the page stayed on Locate. `SpotConfirm` and `SpotList` show only while locating, so they were gone from the page before their "done" event could arrive. `GroupDetailView` now takes the host to the Vote screen itself when this session's status goes from locating to voting. No test covers this; it was checked in the browser both ways.
- **Run by the lead, after the fix:** the frontend suite, 398 passed, 32 files; the build succeeded.
- **Seen by the lead in the browser** (stub backend on 3101, frontend on 5174, both stopped afterwards; a session of three with two starts shared):
  - The list shows the app's three spots with "Fairest" on the first, and Faith's suggestion with "We are here already"; each has the longest trip, the average and each person's minutes.
  - "Works for me" on Braddell filled with ink, showed "Works for 1 person" and "Leading", and the confirm button became "Confirm Braddell". Selecting Caldecott's row selected its pin and made the button "Confirm Caldecott".
  - "Suggest a spot" opened the area picker under the button; searching "Bishan" and picking it added the spot with a "We are here already" toggle and "Withdraw", and the caption "You have one suggestion. A new one replaces it."
  - Hovering Faith's pin showed its card above the pin, at the pin.
  - With another person as host (the save edited by hand): no confirm button, "Waiting for Jonathan to confirm", and "Suggest a spot" still offered.
  - Confirming landed on `/sessions/s2/plan` with method `fairest`; an approved spot gave `voted`. "We already have a place", then Bugis, then "Meet at Bugis" landed on `/sessions/s3/plan` with method `chosen`. Back on Locate after that, the page shows the area and how it was chosen, with no "null".
  - No horizontal overflow: 1280 (host), 375 (host), 320 and 744 (member), 744 (host). No control under 44 px at 375 outside the map. No console errors.
- **Not seen by the lead:** the steps bar's offset across screens (the agent measured Locate and Vote equal, and did not reach Itinerary); the new Home chips on a real Home (every session in the lead's run had moved to Voting; the agent measured the chip at 320 px); the demo tools' new buttons; the known place chosen on the create screen and applied at "Start session"; the banner for removed approvals; keyboard order, focus rings, a screen reader and reduced motion. A pin's card did not open on a scripted focus; whether it opens on a real Tab was not checked.
- **For the lead to know:**
  - "We already have a place" on the create screen is remembered in the browser's session storage and applied when the host presses "Start session", because a known place needs two people and a new session has one. It is not a field on the session.
  - The banner for removed approvals is drawn in `GroupDetailView`, not in `SessionNotices`.
  - The area picker does not put the cursor in its search box when it opens with a click.
  - "Hold to end" shows on the Locate screen when someone else is the host. It was there before this round (the signed-in user's id is hard-coded).

## Round 17: real sign-up and login, the frontend's account layer (2026-10-11)

Parent task: the lead asked for the login functionality to be started on its own branch. The work is the frontend half of the tracker ticket "Overhaul 3 of 7: real sign-up, login and token checks" (peachoolongtee/jio#78), which also covers "Add a login screen and fix the sign-out crash" (#60) and the token part of "Make the production build reach the backend and send the login token" (#50). The backend's token check and `GET /api/me` were built in rounds 1 to 3.

Branch `feat/login`, cut from `main` at `aa64d15` (the showcase pull request, #102, had just merged). Rounds 15 and 16 are on `feat/meeting-spots`, which is pushed and not merged, so they are not in this file on this branch.

Baseline before any change, run by the lead agent on the Windows machine: frontend suite 353 passed, 33 files; build succeeded; backend suite 544 passed, 3 failed, 1 skipped, 24 files. The three failures are the Windows path and line-ending tests that round 15 describes; the path fix is on `feat/meeting-spots`, not here.

What the lead agent found first:

- `frontend/src/lib/supabase.js` is imported by nothing and throws when its two variables are missing.
- On this machine `frontend/.env` holds the backend's variable names (the Supabase URL, anon key and service-role key, the OneMap account, the port) and neither `VITE_SUPABASE_URL` nor `VITE_SUPABASE_ANON_KEY`. Only names were read, never values. Vite does not put a variable without the `VITE_` prefix into the bundle, so the service-role key is not exposed, but it does not belong in that file. The frontend cannot reach Supabase here until the lead sets the two `VITE_` variables.
- The lead agent cannot create an account on the live Supabase project, so a real sign-up and login are for the lead to try. Tests use a stand-in client.

Defaults taken, for the lead to confirm or change:

1. Login is by email and password, which the sign-up screen already collects.
2. Without the two `VITE_` variables the app keeps today's local accounts, so tests, the demo account and a teammate with no env file still work.
3. The demo account stays a local account even when Supabase is set.
4. Meetups stay in the browser until the data layer moves to Supabase (#79). The local id of "me" stays `ian` for now; the Supabase user id is kept beside it. The save is kept per account, so signing out no longer erases a person's meetups and a second account in the same browser gets its own.
5. The planner routes are not yet made to require a login. That needs the lead's word, because it changes how the demo account and local development reach the planner.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 17.1 | Frontend | The account layer: a Supabase auth module, and sign-up, sign-in, sign-out, the signed-in user, profile updates and the username check in the data layer and the auth store. No screens. | `frontend/src/lib/` and `frontend/src/stores/` and their tests | One test per rule; the suite and build pass with and without the Supabase variables; no call leaves the machine; no existing test deleted, skipped or weakened | **Done and checked by the lead** (results below) |
| 17.2 | Frontend | The login screen and route, the router guard, the sign-up screen sending the password and showing "check your email", and sign-out that never throws (tickets #78 and #60) | Views, components, the router and their tests; not `lib/` or `stores/` beyond a reported defect | A returning user can log in; signing out never throws, with a test; no overflow at 320, 375, 744 and 1280 px; suite and build pass | **Done and checked by the lead**, with two small fixes by the lead (results below) |
| 17.4 | Frontend | The planner client sends the login token, refreshes once on a 401 and then signs out; a missing backend address and an answer that is not JSON are errors (tickets #78 and #50) | `frontend/src/lib/plannerApi.js` and its tests | One test per rule; suite and build pass | **Done and checked by the lead** (results below) |
| 17.3 | Lead | Verify, record, and list what only the lead can try | Docs | Suites and build run by the lead; the riskiest claim read in the code | Done |

### 17.1 result: the account layer

- **Built (frontend agent):** `lib/auth.js`, the one place that talks to Supabase Auth and the profile tables (`configured`, `signUp`, `signIn`, `signOut`, `currentUser`, `accessToken`, `refreshedToken`, `loadProfile`, `saveProfile`, `usernameAvailable`, `onChange`, `useClient` for tests, and the messages a person sees in `MESSAGES`). `lib/supabase.js` no longer throws: it exports the client or null. In `lib/api.js`: a new `signIn`, `realAccountsOn`, and real-account paths in `signUp`, `signOut`, `getUser`, `updateUser` and `checkUsername`. In `stores/auth.js`: `signIn`, `pendingConfirmation`, `syncNotice`, `realAccounts`, `dismissConfirmation`, and a `signOut` that never throws. New tests: `accounts.test.js` (30) and `authStore.test.js` (12), with `authFixture.js` standing in for Supabase.
- **The account object** is always `id: 'ian'`, with `authId` (the Supabase user id, or null), `local`, `email`, and the fields it had. A local account saves to `jio-demo-v1` as before; a real account saves to `jio-demo-v1:acct:<its id>`, which survives sign-out.
- **Run by the lead:** the frontend suite, 395 passed, 35 files; the build succeeded. Only `frontend/src/lib/` and `frontend/src/stores/` changed.
- **Checked by the lead:** the whole diff of `lib/api.js`. The password is passed to `auth.signUp` and `auth.signIn` and is in no object that is saved; a real account's save is loaded only when its `authId` matches; `save()` writes nothing after a real account signs out; the local sign-up path builds the account from named fields, as before.
- **Not checked by the lead:** the run with outbound calls blocked (the agent reports 395 passed and no blocked call); the agent's two mutation checks; anything against the real Supabase project.
- **Differences from the brief, accepted:** `currentUser`, `accessToken` and `refreshedToken` are async; the client is always null under the test runner, so a developer's own env file cannot make the suite create accounts; sign-out ends this browser's session only; `api.signUp` answers the account, or `{ needsConfirmation, email }`.
- **Rests on reading, not on a live call:** how Supabase words its errors. A taken username at the trigger is told from the text "Database error saving new user"; with email confirmation on, an email already registered is told from an empty identities list.
- **For the lead to decide:**
  - In a build with Supabase set up, a local account left in the browser from before (or the demo account) still counts as signed in after a reload, with no login. That follows the default that the demo account stays local.
  - After a sign-up that needs the email confirmed, the name and home area typed are lost: the name starts as the username and the home area is empty.
  - A real account signing in on a new browser starts with no friends suggested.

### 17.4 result: the planner client sends the login token

- **Built (frontend agent):** in `lib/plannerApi.js`, a request interceptor that reads the token for each request and sends it as `Authorization: Bearer …` when there is one; on the login check's 401 for a request that carried a token, one refresh and one retry, shared by requests that fail together; with no fresh token, or a second 401, it ends the Supabase session (`auth.signOut`, because `api.js` imports this file) and rejects with "Your session has ended. Log in again."; a 503 `auth_unavailable` says "Jio cannot check your login right now. Try again in a moment."; a production build with no `VITE_API_BASE_URL` refuses the request with a plain sentence and tells the developer once in the console; an answer that is not JSON is an error and is no longer read as "no places". New tests: `plannerAuth.test.js` (15). `meetingArea`, `rankSlot` and `searchSlot` are untouched.
- **Checked by the lead:** the whole diff of `plannerApi.js`. A request with no token is never retried and signs nobody out; a retry cannot repeat (`jioRetried`).
- **For the lead to know:** a deployment that serves the frontend and the backend from one address through a proxy, with no `VITE_API_BASE_URL`, would now be refused. The rule is what ticket #50 asks for; it would need an opt-out for that kind of deployment.

### 17.2 result: the login screen, the guard, sign-up and sign-out

- **Built (frontend agent, in two runs; the first stopped at its turn limit with no report and was resumed):** `views/LoginView.vue` at `/login`; the route table moved to `router/routes.js` and the rules to `router/guard.js` (`guardFor`, `safeNext`); the sign-up screen (`AuthView.vue`) sends the password, returns to the right question after a failure, shows "Check your email", and links to the login screen; `ProfileView.vue` says what signing out does for each kind of account and lands on the right page; the unguarded reads of `auth.user` named in ticket #60 are guarded in `LandingView`, `GroupsView`, `PlannerView`, `GroupDetailView` and `ProfileView`; a new `components/ui/SyncNotice.vue`. New tests: `loginGuard` (18), `loginScreen` (11), `signupScreen` (11), `signOutScreens` (6), drawn with `domless.js`, a stand-in for the page.
- **Outside the files the brief allowed, accepted:** two lines in `App.vue` to show `SyncNotice` above every signed-in screen.
- **Added by the lead:**
  - The app frame now sends a person to the login screen when their session ends while a page is open (the login expired, the planner refused the token, or another tab signed out). The store counts those in `sessionEnds`; a sign-out the person asked for is not counted. One new store test. Without this the planner client's "session ended" left the page up with a blank name.
  - The "Log in" link on the sign-up screen was 41 px wide at 320 px; it now has the minimum width.
- **Run by the lead, after those changes:** the frontend suite, 457 passed, 40 files; the build succeeded.
- **Seen by the lead in the browser** (frontend only on 5174, started with made-up Supabase values that point at nothing, stopped afterwards):
  - A signed-out visit to `/sessions/new?x=1` lands on `/login?next=/sessions/new?x=1`; `/login?next=//evil.example/x` becomes a bare `/login`.
  - The login screen has labelled Email and Password fields with `username` and `current-password` autocomplete. Enter submits. With nothing answering, it says "Could not reach Jio. Check your connection and try again.", keeps the email, empties the password and puts the cursor in it. The made-up password was in no local storage key afterwards.
  - The sign-up screen shows "Already have an account? Log in" and the demo account buttons.
  - No horizontal overflow on `/login` and `/signup` at 320, 744 and 1280 px, and on `/login` at 375 px. No control under 44 px on `/login` at 320, 375 and 744.
- **Not seen by the lead:** a successful login or sign-up, "Check your email", the sign-out dialog and where it lands, the sync notice, the Profile note for a local account, and the new redirect when a session ends. They rest on the tests. Nothing has run against the real Supabase project.
- **Found and left:** the "Use the demo account with showcase data" button's text runs past its box at 320 px. It is from the showcase round and shows only in development builds.
- **For the lead to know:** with real accounts on, the sign-up screen shows one password rule, "6 or more characters", which is Supabase's default; the project's own setting was not checked. With real accounts off, a failed local sign-up now empties the password, which it did not before.

## Round 18: audit of three branches, then merge in the lead's order (2026-10-11)

The lead asked: "audit and merge login first then ai itinerary then meeting spots". None has a pull request.

| Branch | By | Head | Against `main` at `aa64d15` |
|---|---|---|---|
| `feat/login` | the lead's other session (round 17) | `fa827dc` | 4 commits, 28 files, merges cleanly |
| `feature/ai-itinerary` | faithpho | `01c35ee` | 2 commits, 20 files, merges cleanly |
| `feat/meeting-spots` | the lead's other session (rounds 15 and 16) | `36030e8` | 11 commits ahead and 8 behind, 39 files, one conflict (`DemoPanel.vue`) |

- **Before any review, by the lead, on each branch's head:** `feat/login`: `pnpm test` 547 passed, 1 skipped; frontend 457 passed, 40 files. `feature/ai-itinerary`: 565 passed, 1 skipped; frontend 354 passed. `feat/meeting-spots`: 678 passed, 2 skipped; frontend 398 passed. Every backend suite also passed with outbound calls blocked, and every build succeeded.
- **Known before the audit:** meeting spots conflicts with login (`CLAUDE.md`, the work log, `DemoPanel.vue`) and with the AI itinerary (`DemoPanel.vue`, `stores/events.js`). The lead cut "Ask AI" on 2026-10-09; by asking for the AI itinerary to be merged, the lead has decided this different AI feature goes in.
- **Where the work happens:** a throwaway worktree per branch. Fixes go on integration branches (`feat/login-integration` and so on), not on the branches themselves.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 18.1 | Code reviewer, read-only | Login: the account layer, token handling, the guard, storage | Nothing | Every finding has a file, a line and a way to trigger it | **Completed**: "changes required" |
| 18.2 | Verifier | Login: run it against a fake auth server on this machine and try to break it | Nothing in the repo | Each claim confirmed or refuted with output | **Completed** |
| 18.3 | Code reviewer, read-only | AI itinerary: the AI service, keys, cost, what is sent, the arrange rules, the route | Nothing | Same | **Completed**: "changes required" |
| 18.4 | Verifier | AI itinerary: run it in stub mode and with a fake AI; count calls; failures | Nothing in the repo | Same | **Completed** |
| 18.5 | Code reviewer, read-only | Meeting spots: the backend change, the data layer, the screen's code | Nothing | Same | **Completed**: "changes required" |
| 18.6 | Verifier | Meeting spots: the rules in the handoff's section 3, through the data layer and a headless browser | Nothing in the repo | Each rule confirmed or refuted with output | **Completed** |
| 18.7 | Lead | Check findings, fix or record, merge each in order, resolve conflicts, re-run suites after each merge | Fixes on integration branches, docs, the tracker | All suites pass after each merge | **Completed**: into `dev`, at the lead's word, with `main` left as it was |
| 18.8 | Frontend | Login: fix the audit's findings | `frontend/` on `feat/login-integration` | Suites pass, also offline; a production build has no demo strings | **Completed** |
| 18.9 | Backend | AI itinerary: a call budget, a cache, a deadline, a pause after failures, a smaller model, checks on the answer and the prompt | `backend/` on `feat/ai-itinerary-integration` | Suites pass, also offline; other routes unchanged | **Completed** |
| 18.10 | Frontend | AI itinerary: confirm never blocked, a choice of orders, a request ticket, honest labels | `frontend/` on the same branch | Suite and build pass | **Completed** |
| 18.11 | Frontend | Meeting spots: the timing defects, "about" on estimates, preselection, focus, Home's words, the design document | `frontend/` and `DESIGN.md` on `feat/meeting-spots-integration` | Suite and build pass | **Completed** |
| 18.12 | Backend | Meeting spots: naming an area in `include` must not change the planner's pick | `backend/` on the same branch | The baseline test untouched and passing; suites pass, also offline | **Completed** |

### 18.1 and 18.2 Login: no blocker, the main claims hold, eight defects

**Confirmed by reading and by a browser run against a fake Supabase on this machine:** the password is in no storage, URL, console message or saved object; two real accounts in one browser are stored apart and neither sees the other's sessions, nor does a signed-out person through Back or a direct address; 22 hostile `next` values stay on the site; a real account's planner requests carry the current token and no other origin receives it; a 401 `unauthenticated` causes exactly one refresh and one retry, five together share one refresh, and other 401s and a 503 sign nobody out; the demo account and showcase work beside real accounts; a production build has no demo strings. The frontend suite passes with outbound calls blocked.

| # | Defect | Evidence |
|---|---|---|
| 1 | Sign-up freezes when the username check fails: Next stays disabled, nothing is shown | Reproduced in the browser; `next()` in `AuthView.vue` has no `finally` |
| 2 | A username taken at the database shows "Could not reach Jio", because the installed auth client turns every 500 into a retryable network error | Reproduced with a fake answering 500; the real server's status is unverified |
| 3 | Sign-out waits on the server: with a server that never answers, still signed in after 15 s | Reproduced. Down, 500 and slow do end signed out |
| 4 | A blank page while the app starts: about 26 s with an expired token and Supabase unreachable; no end with a server that never answers | Reproduced; the guard awaits `auth.init()` with no limit |
| 5 | Any refresh failure signs the person out, including a network error | By reading |
| 6 | With real accounts on, a leftover or hand-made local save counts as logged in | Reproduced on a production build |
| 7 | A production build without the Supabase settings silently becomes open local sign-up | Reproduced |
| 8 | Smaller: login errors not tied to fields; "Sign in" and "Log in" mixed; `safeNext` can return a `//` path (not exploitable through the guard); the token is attached before the destination is checked; the date of birth stays in the local save after sign-out; no progress text on a slow sign-up | By reading and in the browser |

**Decided by the lead agent:** defect 6 was listed by round 17 for the lead; the audit brief required that nobody passes the guard in production without an account, so a local user is treated as signed out in a production build with Supabase configured. One build-time opt-out, `VITE_ALLOW_LOCAL_ACCOUNTS=1`, covers 6 and 7, because a deployed demo will need local accounts.
**For the lead, not fixed:** with email confirmation on, sign-up tells a person that an email is already registered, which Supabase hides on purpose.

### 18.3 and 18.4 AI itinerary: the rules are right, the AI call was unbounded

**Confirmed:** the rules module agreed with the tester's independent timeline model on 571 random plans, and every answer kept each place open and each meal in its window; at most 720 orders are enumerated, in about a millisecond; the keys are sent in headers only and appear in no response or start-up line; nothing about a person is sent to the AI provider; the AI's choice is range-checked; other routes answer exactly as on `main` (12 of 12); a save from `main` loads with all ten sessions.

| # | Defect | Evidence |
|---|---|---|
| 1 | Nothing bounds AI calls: 310 requests in a burst made 300 calls; 50 identical bodies made 50 | Measured on the real server wiring with a fake AI |
| 2 | A hung AI holds each request 20 s (Gemini) or 40 s (Claude), every time; the SDK can sleep longer on `retry-after` | Measured; the SDK's retry read in `node_modules` |
| 3 | An unexpected 200 from the provider answers 500 | Four shapes reproduced |
| 4 | Claude is asked for the largest model with a 2,000-token ceiling to choose one number | By reading |
| 5 | A stop's name reaches the prompt raw (a newline forged an "Order 7" line) and the AI's sentence is returned raw | Reproduced with an obedient fake |
| 6 | A key with a space inside counts as set | Start-up run |
| 7 | The confirm button is disabled while the AI answers (20 to 30 s with a hung AI); the suggested order cannot be declined; a stale answer can win | Browser run and reading |
| 8 | The sentence is not labelled as an AI's; "The AI is off" shows when it only failed; "least travel" was wrong in 47 of 364 plans | Browser run and a count |
| 9 | The doc's example request does not give its example answer | Three variants tried |

**Recorded, not fixed:** the route takes that day's hours from the caller and cannot be told a venue is closed on the date (the frontend has no closure data); the model names and the beta header could not be checked against the live services; the planner's rate limit keys on the caller's address and nothing sets `trust proxy`.
**Disclosed by both browser testers:** early headless runs let the page load map tiles from OneMap before a block on non-local requests was added. No API, routing or search call was made.

### 18.5 and 18.6 Meeting spots: the backend holds, two timing defects in the data layer

**Confirmed:** 180 requests without the new fields answer byte for byte as on `main`, with identical route calls; 86 checks on the new fields pass; route calls stay at or under 60 with 30 members, 3 alternatives and 8 included areas; every rule in the handoff's section 3 held outside the races, with the tester's own 49 data-layer cases; no horizontal overflow or clipped text at 320, 375, 744 and 1280 px with five spots and six members; every control has an accessible name and a visible focus ring; list and pins select each other; the steps bar did not move or fade across 300 samples at 1280 px; no demo strings in the production build.

| # | Defect | Evidence |
|---|---|---|
| 1 | A planner answer that arrives after the host confirmed is applied: the confirmed area is replaced, or the session is left in voting with no meeting area | Two failing cases in the tester's `c8.test.js` |
| 2 | A write that fails after the host confirmed restores an old snapshot and undoes the confirmation | Two failing cases |
| 3 | `suggestSpot` takes no "latest wins" ticket: a slow suggestion leaves a stale list; two close suggestions can delete each other | One failing case; the second by reading |
| 4 | Times show as exact when the server has no OneMap account and every time is an estimate | By reading |
| 5 | Naming an area in `include` can change the planner's pick in routing mode, against the docs | By reading; no test could show it with the stub's times |
| 6 | The preselected spot is compared on rounded minutes and can differ from the planner's pick with no approvals | By reading |
| 7 | Keyboard focus is lost after "Works for me" | Reproduced in the browser |
| 8 | Smaller: every Home chip restyled; Home's chip and text disagree; a suggestion can be left with no Withdraw after a reload mid-request; a Leaflet console error on starting with a known place from the create screen | By reading and in the browser |

**For the merge:** this branch bumps the saved-data version from 8 to 9, so sessions in a browser are reset on first load and the account is kept. `main`'s showcase test expects two Home labels that this branch changes, its `createSession` has `hostId` and no `spots`, and its offline planner returns no `candidates`.

### 18.7 to 18.12 The fixes, and the merges into `dev`

The lead changed the destination on 11 October: "merge to dev instead and keep main safe for now". `dev` was brought level with `main` first (pull request 104).

| Branch | What the fix agents changed | Suites on the fixed branch, run by the lead | Into `dev` |
|---|---|---|---|
| Login (`feat/login-integration`) | Sign-up no longer freezes on a failed username check; a server error is told from no connection, and a taken username is re-checked; sign-out ends the session in this browser within two seconds; a loading shell at start and a four-second bound, from the saved copy; only a refused refresh signs out; the token goes only to the planner's origin; a local account is not a login in a production build with Supabase set up; a production build with no Supabase settings shows "Jio is not available right now"; `VITE_ALLOW_LOCAL_ACCOUNTS=1` allows local accounts; the date of birth is kept out of the save | Frontend 543 passed, 43 files, also offline; backend 547 passed, 1 skipped; build succeeded; no demo strings in the bundle | Pull request 105 |
| AI order of stops (`feat/ai-itinerary-integration`) | One budget of 20 AI calls a minute and 2 at once; a 10-minute cache; a pause after three failures; an 8-second deadline with no SDK retries; Claude Haiku by default with a 400-token ceiling; any throw at the provider boundary falls back to the rules; stop names cleaned before the prompt and a sentence with a link or markup replaced; keys validated and never logged. On the screens: confirm is never blocked, the host chooses "Voted order" or "Suggested order", a request ticket, labelled sources | Backend 674 passed, 1 skipped, also offline; frontend 407 passed alone and 597 with `dev` merged in; build succeeded | Pull request 106 |
| Meeting spots (`feat/meeting-spots-integration`) | A late answer or a failed write no longer undoes a confirmation (`latestAnswer`, `orUndo` takes back only its own change); suggestions cannot delete each other; "about" on estimates; the preselected spot is the planner's pick when nobody has marked one; focus stays on a spot's controls; Home's words agree; the Leaflet error on leaving a map is fixed for every screen; naming an area in `include` cannot change the planner's pick | Backend 688 passed, 2 skipped, also offline; frontend 445 passed; build succeeded | With round 19, below |

- **Undici, observed by the backend agent:** a header value with a line break or a null is quoted in the error message, so a key with one would have been logged. The AI service logs only fixed text.
- **Not verified by anyone:** anything against the real Supabase project, Gemini or Anthropic. The model names and request options are unchecked.
- **Left, on tickets:** sign-up says when an email is registered, which Supabase hides on purpose; the arrange route cannot be told a venue is closed on the date; the rate limit keys on the caller's address with no `trust proxy`.

## Round 19: the team's walkthrough, the pitch build (2026-10-11)

The lead pasted a recording of the team testing the app together and asked for the feedback to be reconciled and audited, with suggestions first. Eighteen items were checked against the code; the lead took the recommendations, with a split into a list for the pitch on 12 October and a list for after. Merging `dev` into the meeting spots branch produced four conflicts (the store's export list, the demo panel's imports, `CLAUDE.md`, this log), each resolved by keeping both sides, and seven failing frontend tests: five expected the old save version and two were the showcase's Home labels.

| # | Role | Scope | Status |
|---|---|---|---|
| 19.1 | Frontend | The session screens: "Cancel outing"; "Save plan" and "Finish outing"; the known place off the create form; the steps bar as navigation and a back arrow that goes to the previous step; confirming a spot stays on Locate with "Next"; "No spots yet" and the "Fairest for" line removed; the map key on Vote; no people on the itinerary's maps | **Completed** |
| 19.2 | Frontend | Location search through the backend's OneMap address search, built-in areas first, 300 ms debounce, cancellation, a fallback when the backend is off; one row per area when suggesting a spot | **Completed** |
| 19.3 | Frontend | The showcase after the merges: the offline planner answers with candidates; ten sessions under the new rules, with a spot vote the person hosts, one a friend hosts, and one set by "We already have a place"; the demo tools reordered | **Completed** |
| 19.4 | Lead | Verify, record, merge into `dev` | **Completed** up to the commits |

- **Run by the lead on the finished branch:** `pnpm test` 815 passed, 2 skipped, 29 files; `pnpm --filter jio-frontend test` 807 passed, 56 files; both again with outbound calls blocked, no call attempted; `pnpm build` succeeded; the production bundle has none of the demo's strings.
- **Reported by the agents from headless browser runs, not seen by the lead:** one session walked from Create to Itinerary at 375 and 1280 px with no horizontal overflow and the steps bar at one height; typing "tampines mall" makes one search request; the showcase loads ten sessions in about six seconds with the backend running and with it stopped.
- **For the presenter:** run the backend. With it stopped the showcase loads, and confirming a spot and the voting screens cannot reach the planner. The meeting spots merge resets the sessions saved in a browser, so load the showcase again.
- **Left for after the pitch, on the new map:** finishing an outing by itself and reminders; frequent hangouts and the Jio streak; default times, one create button and the radius control.

## Round 20: decisions and a new map (2026-10-11)

- **Dietary needs and weather** were settled with the lead in a grilling session; the decisions are on their tickets and the terms are in `CONTEXT.md`. None of it is built.
- **A demo tour** (one link in, one outing as a story, a strip of checkpoints, available in the deployed build) was agreed, to be built after the merges.
- **The live database was checked:** one account and one profile; every session table is empty. Nothing about a session has ever been saved to Supabase.
- **A second map was charted,** "Jio to the freeze: wayfinder map", issue 109, grouped by feature, carrying execution. Sessions on the server is its first feature, in five stages. Invites are by link, which joins at once, and by username, which sends an invite to accept.
- **Research answered:** Google's nearby search bills at its dearest tier with the fields asked for, and its terms forbid Places content on or beside a non-Google map; the 24-hour forecast reaches 18 to 24 hours ahead and its phrases are already known to the planner.
- **Running when this was written:** an architect extending the session endpoint design, and a backend agent drafting the schema for meeting spots. Nothing is applied to the live database.

## Round 21: work that does not touch the pitch build (2026-10-11, night)

The lead asked what could carry on before the pitch and said "go" to five pieces, each on its own branch from `dev`, none to be merged until the lead has presented. All are tickets on the map, issue 109.

| # | Role | Scope | Branch | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 21.1 | Backend | Weather, the backend half: the area forecast within two hours, the regional forecast where a published period covers the stop, no effect otherwise; four states and "not known" on each result; a route that answers the state of each stop of a plan | `feat/weather-forecast-window` | Old requests answer as before apart from the documented new fields; suites pass, also with outbound calls blocked | Running |
| 21.2 | Frontend | The demo tour: `/demo`, one outing as a story saved at each checkpoint, a strip to jump between them, available in a deployed build when a flag is set | `feat/demo-tour` | Works with the backend off; suites and build pass; a build without the flag has none of it | Running |
| 21.3 | Frontend | Roam inside a meetup: "What next?" on the itinerary on the day, a list of places nearby, proposals, the host's confirm | `feat/roam-in-meetup` | The rules each have a test; suites and build pass | Running |
| 21.4 | Tracker | Check the audit tracker's and the first map's open tickets against `dev`; close what is done with its evidence, note what remains | none | Every ticket touched has a comment naming a file, a test or a pull request | Running |
| 21.5 | Backend | Reconcile the schema draft with the session endpoint design, split by build slice; nothing applied | `feat/session-schema-spots` | A fresh build equals the old files plus the migrations; the access tests pass on a throwaway database | Running |
| 21.6 | Lead | Verify each as it finishes; leave all unmerged | | Suites run by the lead on each branch | Pending |

Held until after the pitch, because they edit the same screens: the signed-in account in place of the hard-coded one, the screen half of weather, and the walkthrough's later items.

## Round 22: audit of the place-search pull request (2026-10-11, night)

The lead asked whether the open pull requests overlap with work in flight, then for an audit of peachoolongtee/jio#132, "Search any place or location with Google and OneMap", by faithpho, from `feature/real-search` at `cf364da`: backend only, 10 files, 732 lines added. It is to be merged into `dev` after the pitch and before the weather branch, which edits six of the same files.

- **Before any review, by the lead, on `dev` with the pull request merged in (no conflicts):** `pnpm test` 827 passed, 2 skipped, 30 files, and the same with outbound calls blocked, no call attempted; `pnpm --filter jio-frontend test` 807 passed, 56 files; `pnpm build` succeeded. The new Google fixture holds invented places.
- **Read by the lead before delegating:** both new Google calls (a text search and a look-up by place id) go through the budget, timeout and pause that the Google Places audit added, with a 10-minute cache and the shape check.
- **Known before the audit:** Google's terms, read on 11 October, forbid Places content on or beside a non-Google map; this pull request brings Google places to the Vote page and to the location sheet once a key is set. The decision is the lead's and is open on the map. With no key, the code does nothing.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 22.1 | Code reviewer, read-only | The new Google calls, cost per request, what reaches the browser, the search routes' rules, the engine change | Nothing | Every finding has a file, a line and a way to trigger it | Running |
| 22.2 | Verifier | Run it with a fake Google and try to break it; count calls; check the frontend still works with Google results in its answers | Nothing in the repo | Each claim confirmed or refuted with output | Running |
| 22.3 | Lead | Check findings, fix or record, merge into `dev` after the pitch | Fixes on `feat/real-search-integration` | Suites pass | Pending |

### 21.5 and after: the schema, reconciled, and two migrations applied (2026-10-11, night)

- **Reconciled by a backend agent** with the session endpoint design, as four migrations (invites; meeting spots; the slot plan's details; the plan, the suggested order and proposals), each with an access test, 316 steps in all. On a stand-in database a fresh build matched the old files plus the migrations, and every test passed. None of that ran on the live project.
- **Applied by the lead agent at the lead's word ("apply"): `jio_invites` and `jio_meeting_spots`.** Before: three migrations listed, the invites table empty and in its old shape. Each migration was sent as one statement that refuses to run unless its text has the file's checksum, runs it, and then runs the lead's own checks as real roles in a block that is always undone (ten for invites, six groups for meeting spots); the migration is kept only if they pass. Both passed first time.
- **After:** five migrations listed; the new objects present; signed-out callers may run only the invite preview; row counts unchanged (1 account, 1 profile, every session table empty).
- **Not run on the live project:** the agent's four long access tests. The lead read both migrations in full before applying them.
- **Now true of the live schema, on the design's recommendations:** a pending invitation by username lives in `invites`, with no member row until it is accepted; the meeting columns stay empty while a session is locating; a spot's travel times are by area.

## Round 23: the tracker cleared, the demo tour checked, each real service run once (2026-10-11, evening)

The lead asked what is still outstanding on each map and for the maps to be cleared of what is done or replaced; then said the remaining API keys were in `backend/.env`.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 23.1 | Lead | Read every open ticket and its latest note; close what is done or replaced, saying where each remainder went; move what is still work under one map | The tracker | No ticket closed without a note naming its evidence or its carrier | **Completed** |
| 23.2 | Lead | Check the demo tour (21.2), commit, push, merge into `integration/after-pitch` | `feat/demo-tour`, the staging branch | Suites and build by the lead; the checkpoints opened in a browser | **Completed** |
| 23.3 | Lead | Check the place-search fixes (22.3), commit and push | `feat/real-search-integration` | Suites by the lead, also with outbound calls blocked | **Completed; not merged** |
| 23.4 | Verifier | One call to each real service with the lead's keys, on its own server, under hard caps | Nothing | Each claim seen in a response; the caps kept | **Completed** |
| 23.5 | General-purpose | Redraw the pitch's tech stack diagram from the code | `docs/pitch/` | Every claim on it traced to a file | **Completed** |

### 23.1 The tracker

- **Before:** 66 open tickets under three maps. **After:** 36, all under "Jio to the freeze"; the first map and the audit tracker are closed as records.
- **Closed, 29:** 8 from the first map, 15 from the audit tracker (5 of them "Overhaul" tickets), 4 from the new map (CI, the unplanned-features decision, the leaderboard audit's findings, the review of meeting spots), and the two older maps themselves. Each has a note naming the commit or test that settles it, or the ticket that now carries what was left.
- **Carriers updated, 17**, so no remainder was lost: dietary needs, weather, the real-service run, deploy, voting on the server, place photos, the signed-in account, dead ends, Bootstrap, the endpoint design, account setup, the Google decision, layout widths, login on the planner routes, Roam in a meetup, the demo tour, the invented venues.
- **Moved under the live map, 11**, and one created: "Small calls for the lead, each with a recommendation", eight lines gathered from tickets that were otherwise finished.
- **A mistake caught:** a note on the walkthrough ticket said two leaderboard defects were unfixed. Round 8's table shows both were fixed; the note was deleted.
- **Not closed although folded:** the database password. Its ticket is closed into the account checklist, where it is the first line and is marked not done.

### 23.2 The demo tour

- **Agent:** a frontend-engineer subagent (21.2). Its report: `/demo`, one outing at eight checkpoints, a strip, three side cases, a stand-in planner for a backend that is off, the flag `VITE_DEMO_TOUR`, which needs `VITE_ALLOW_LOCAL_ACCOUNTS=1` and refuses to start without it.
- **Run by the lead on the branch:** frontend suite 862 passed, 59 files; build succeeded.
- **Opened by the lead** on a spare port with no backend, about 560 px wide: `/demo` landed on Home at checkpoint 1 in under 8 s; the strip's next button opened `/sessions/s2/invite`, `/sessions/s3`, `/sessions/s4`, `/sessions/s5/plan`, `/sessions/s6/itinerary`, `/sessions/s7/itinerary` and `/sessions/s8/photos`, with the footer buttons the report gives; no horizontal overflow; no page errors. The console showed 12 failed requests to the absent backend, not the one the report gives.
- **Found by the lead:** opening another checkpoint's address by hand leaves the strip on the old checkpoint. On a phone the strip takes about a fifth of the screen.
- **Merged into `integration/after-pitch`** (`14b1cd5`), one conflict in `DESIGN.md`, both sections kept. There: 897 backend passed, 2 skipped; 941 frontend passed, 62 files; build succeeded.
- **Not verified by anyone:** reduced motion in a browser; a real cold start of a deployed backend.

### 23.3 The place-search fixes

- **Agent:** a backend implementer (22.3) on `feat/real-search-integration`, the staging branch with the pull request merged in. Its report: all eleven audit items fixed, with 77 new tests of which 51 fail on the unfixed code; the worst case for one ranking with a hung Google fell from about 9 s to 3.3 s.
- **Run by the lead:** backend suite 986 passed, 2 skipped, 34 files, and the same with outbound calls blocked; frontend 886 passed; build succeeded.
- **Not merged into the staging branch.** The frontend half of the pull request still keeps Google's place details in the browser and shows them beside the OneMap map; that waits on the lead's decision about Google places.
- **Reported and not rechecked:** each item's behaviour; the no-key comparison (10 answers identical, 11 differ only in order and a `google` block).

### 23.4 Each real service, once

- **Agent:** a verifier, read-only, on its own server on a spare port, with caps on each kind of call. It did not read the env files.
- **Worked:** OneMap login, search (0.16 s) and routing (meeting area for Tampines and Clementi: Lavender, 29.5 min worst, 3.2 s cold with 10 trips routed and 22 estimated, 2 ms warm); the live forecast; Gemini (an order and a sentence in 1.1 s, so the model name is accepted); Google (19 places added to a ranking).
- **What it means for a demo:** with the Google key set, all ten converge results were Google places, the top five stalls at one address, the first on a single five-star review, one with a mixed English and Chinese address; no curated, CDC or OneMap place and no activity appeared.
- **Not run:** a Google photo (no place had one); a real login token (both 401s were refused on shape, so fetching Supabase's signing keys is unproven); Anthropic.

### 23.5 The tech stack diagram

- **Agent:** general-purpose. Files in `docs/pitch/`, untracked. It corrected five beliefs in its brief from the code, among them that 36 of the 1,819 venues are invented samples.
- **Seen by the lead:** the preview image. One line in the notes was out of date by the evening (meeting-spot tables went live) and was corrected.
- **Not done:** placing it in Canva. The connected Canva account does not hold the deck.

## Round 24: the staging branch walked for the pitch, and three changes the lead asked for (2026-10-11, night)

The lead asked whether the staging branch was safe to demo, then, using the pitch build, asked for the settled Locate page back, the back button to leave the session, and reviews on the places to vote on. The three changes are on `fix/locate-settled-view`, cut from `dev`, as peachoolongtee/jio#135 into `dev`; they are not on this branch yet.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 24.1 | Verifier | Walk `integration/after-pitch` in a real browser with the real OneMap and Gemini keys and Google off: the tour, the showcase, a fresh outing for tomorrow evening, an outing today with Roam, and the tour with the backend stopped | Nothing | Every claim seen on a screen or in a response | **Completed** |
| 24.2 | Lead | Locate once the spot is confirmed; the footer button's name; the top-left button | `GroupDetailView`, `MemberList`, `spotText.js`, `session.js`, `SessionSteps`, `SessionHeader`, `stepNav.js`, the router, tests | Suites pass; seen in a browser | **Completed** |
| 24.3 | Frontend | A sample review on each suggestion card, chosen by who wrote it, opening the place detail; review words by kind of place | `SuggestionCard`, `PlaceDetail`, `PlannerView`, `mock/reviews.js`, a new `reviewPick.js`, tests | No food text on a place that is not food; no planner request on opening; suites pass | **Completed** |

### 24.1 The staging branch, walked

- **Result:** no crash, console error, page error or failed request with the backend on, at 1280 and 390 px. All eight tour checkpoints, the showcase, a full outing from create to itinerary, and Roam (propose, accept, dismiss, finish) worked.
- **Found:** loading the tour makes about 55 planner requests, which drew HTTP 429 from OneMap ten times; rankings then took 3 to 8 s and the tour up to 16 s to load. A three-hour outing with four categories was confirmed with no Eat stop and ended at 21:51, past its 21:30 end, with no warning (`slots.js`, the same on `dev`). An outing tomorrow evening gets no weather at all on this branch (`outside_window`), where `dev` ranks it against the weather now. Roam listed one place, or none, when the plan ended late. With the backend off the tour runs on sample data and the showcase's Vote page says it cannot reach the planner.
- **The real 24-hour forecast answered** when called directly: a stop at 02:00 the next day got the regional forecast, issued 17:34 and valid to 06:00.
- **Seen by the lead:** one of its screenshots (the confirmed itinerary). The rest is the verifier's report.
- **Not checked:** Gemini's order inside a browser flow (the rules answered), a phone, two devices, a real login, a comparison run on `dev`.
- **The lead agent's advice to the lead:** present from `dev`; the staging branch holds up if the tour or Roam is to be shown.
- **Environment:** the lead's backend on port 3000 was started at 17:42 with the Google key still set, so Google is on in it. The lead was told three times; the env file is the lead's to edit.

### 24.2 Locate, the footer and the back button

- **By the lead agent**, after reading the page. The settled view had been replaced by the list of spots when meeting spots were built; it is back for every status from Voting on, without the votes ring and status icons. The footer button is named by `locateNext`. The top-left button first went Home with a house icon, then, on the lead's "go with your recommendations", became a back arrow to the screen the session was opened from (`rememberEntry`, `exitFor`).
- **Run:** frontend suite 853 passed, 58 files, also with outbound calls blocked; backend 815 passed, 2 skipped; build succeeded.
- **Seen in a browser with the showcase:** the settled page at 1280 px and at the pane's narrow width, no overflow; confirming a spot on a session still choosing switched the page and put focus on the footer button; from Sessions the button read "Back to Sessions" on Locate, Vote and the Itinerary, and from Home "Back to Home"; the three footer labels on a voting, a confirmed-today and a completed session; a session still choosing unchanged.
- **A slip:** a patch built with an unsplit shell variable was empty, and the command before it had already reset the main folder's copies; for under a minute the lead's running app showed plain `dev`. Rebuilt and applied. Nothing was lost.
- **Suggested and not built:** the person's own trip and a Directions button on the meeting spot card; a bar per person on one scale; how the spot was chosen; the start and end card shrunk; the top navigation on session pages at desktop width.

### 24.3 Reviews on the places to vote on

- **Agent:** a frontend-engineer subagent, in the same worktree on different files. Its report: 34 new tests; `reviewKind` checked over all 2,067 venues in the frontend and backend files; the line adds 32 px to a card; opening the detail makes no `/api` request; keyboard open and close with focus returned; no overflow at 1280, 375 and 320 px.
- **Changed from the brief by the agent, and kept:** the full display name, not a first name; the detail is local state, so the browser's Back does not close it; the search rows and the map's pin card have no line. It also found the brief wrong about which kinds lacked texts (theatre, bowling, games and places with no kind, not parks or museums).
- **Seen by the lead:** two of its screenshots, the Vote page at 1280 px with the line on each card and the detail at 375 px.
- **Not verified by anyone:** a screen reader; Safari or Firefox; the real backend.
- **Known and left:** the first card in that screenshot is one of the 36 invented venues, rated 9.0; the ticket on invented venues stands.

### 24.4 The score on the cards, and the merge (2026-10-11, night)

- **Asked for by the lead:** the place's score on each suggestion card. Added by the lead agent as a `RatingBadge` beside the name, with three tests. Seen in a browser against a stub backend on a spare port: 8 of 10 cards carry a score (the two without have none in the data), no overflow.
- **Merged at the lead's word ("merge to dev"):** peachoolongtee/jio#135, five commits, into `dev` at `d9a80b5`. CI had passed on the fourth commit and was still running on the fifth when it was merged; the lead agent had run the suites on the fifth. `main` is untouched at `aa64d15`.
- **Run on the merged code in the lead's main folder:** frontend 855 passed and 1 failed; with `VITE_API_BASE_URL` blanked for the run, 856 of 856. The failing test, in `plannerAuth.test.js`, fails the same way on plain `dev` in that folder: it depends on the machine's `frontend/.env`. Recorded on the tests ticket. Backend 815 passed, 2 skipped; build succeeded.
- **A mistake in the lead agent's own check:** the test run's result was piped through a filter, so the failing run did not stop the commit that followed it. The failure was then traced before merging.
- **Not on this branch:** `integration/after-pitch` does not have these five commits. `dev` must be merged into it before it goes to `dev`.

## Round 25: the vote cards, Directions, the CDC price rule, and the first Supabase stage begun (2026-10-11, late night)

The lead took the suggestions for the cards except the stock photos ("it gives some visual clarity"), asked for the outstanding work to continue, and had earlier asked where the Directions button was.

| # | Role | Scope | Branch | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 25.1 | Frontend | Vote cards: the photo and name open the place; "Short walk" out, an opening-hours tag in; where walks are from; voters named in a small group | `feat/vote-cards-and-directions`, from `dev` | Wording in pure functions with tests; no overflow at 320 px | **Completed**, peachoolongtee/jio#137 open, not merged |
| 25.2 | Lead | The meeting spot card: your own trip and a Directions button | the same branch | Seen in a browser at phone and desktop width | **Completed** |
| 25.3 | Backend | A guessed price makes no claim for CDC places either | `fix/guessed-price-cdc`, from staging | Before and after counts; suites pass | **Completed**, merged into staging |
| 25.4 | Lead | Bring `dev` and the two branches into `integration/after-pitch` | staging | Suites and build on the result | **Completed** |
| 25.5 | Frontend | Sessions on the server, stage 1: the signed-in account's id in place of the hard-coded one; a people source that can hold real people | `feat/sessions-stage-1-account`, from staging | The ticket's "Done when"; a scan test; the demo account and the tour unchanged | **Running** |

### 25.1 and 25.2 The cards and the meeting spot

- **Agent (25.1):** a frontend-engineer subagent. Its report: one control over the photo and name, named "Open <place>"; the hours tag uses the slot's own start and length, the same the planner ranked against; "Open until midnight" and "Open 24 hours" added beyond the brief; voters' names fall back to the count when names and count disagree; one existing assertion changed (a closed card now has two buttons, the name and the review line).
- **Run by the lead on the branch, exit codes read directly:** frontend 896 passed, 60 files, exit 0, and the same with outbound calls blocked, nothing blocked; build exit 0.
- **Seen by the lead:** two of its screenshots (the Vote page at 1280 px with the walk-from line, hours tags and "Everyone voted"; at 320 px with "You and Nicole voted" wrapping to two lines). The meeting spot card in a browser at 375 and 1280 px.
- **A defect the lead found in its own change:** the Directions button beside the name cut "Raffles Place" to "Raffle…" at phone width. Moved under the name; the name then fitted at both widths with no overflow.
- **Changed from what the lead was told:** "Near MRT" stays, because it is about the station and not the walk from the meeting spot.
- **Not verified by anyone:** the warning hours tags rendered (no showcase place was closed); a phone; a screen reader.
- **Not built, at the lead's word:** any change to the photos. Real photos for places that have one would load images from other sites, which is for after the pitch.

### 25.3 The CDC price rule

- **Agent:** an implementer subagent. All 1,303 CDC places in the pool already carried `priceAssumed`, so dropping the exception in `priceIsKnown` was the whole change; the score and the budget filter are untouched.
- **Effect:** places that can earn "Budget friendly" fell from 1,345 of 1,819 to 42. Across three eat rankings (23 results) the tag fell from 9 to 1; "within budget" appeared in none before or after.
- **Run by the lead:** backend 899 passed, 2 skipped, and the same with outbound calls blocked.

### 25.4 Staging brought level

- **`dev` merged in:** five conflicts (`SessionSteps`, `SuggestionCard`, `session.js`, `vite.config.js`, `DESIGN.md`), each resolved by keeping both sides; the back button's rule now uses the staging branch's list of Itinerary pages, so "What next?" goes back to the Itinerary. 990 frontend, 897 backend, build.
- **The cards branch merged in:** two conflicts. One Roam test expected "Short walk" on its card; it was changed to expect its absence, which is the decision. 1030 frontend passed, exit 0; 899 backend; build.
- **Found:** the Roam page reuses the place card, whose review line and name now open a place; Roam does not handle that, so there they are buttons that do nothing. On the Roam ticket.
- **Two failures that were not defects, and one process mistake:** a frontend test that depends on the machine's `frontend/.env`, and a backend test that failed once under load and passed six times after. Both times the lead agent had piped the run through a filter in front of a commit, so the commit went ahead; from this round on, commits are gated on the run's exit code.

### 25.5 Sessions on the server, stage 1: built, reviewed, fixed, merged into staging (2026-10-12, early hours)

- **Agent:** a frontend-engineer subagent on `feat/sessions-stage-1-account`. One source for who is signed in (`lib/currentUser.js`, bound by `lib/api.js`; `auth.myId` for components); a real account's data under its own id; a people source (`lib/peopleSource.js`) that reads other real people from `profiles` in one batched, cached request. Its choices: a real account has no sample friends, an empty friends list, a leaderboard of itself, and no "Suggested friends" step in sign-up; a development-only made-up real account and "Bring in sample friends" for checking.
- **Run by the lead, exit codes read:** frontend 1085 passed, 69 files; backend 899 passed, 2 skipped; build succeeded; no development-only string in the built files. Seen by the lead: two of its screenshots of the made-up account (Locate while choosing; the leaderboard after an outing). Its demo-account comparison (48 pages against the staging branch, text identical) and its real-account walk are its report.
- **Independent review:** a code-reviewer subagent, read-only, which could not run anything. No blockers. Two significant: per-session caches in the events and planner stores survived an account switch with no sign-out between, so one account could be shown another's photos, itinerary and plan; and an old-build save for a real account was overwritten on first sign-in. Eleven smaller, among them: another person's `avatar_url` reached an image tag unchecked; a display name the database allows could be refused by the planner and roll back a session's locations; one non-uuid id failed a whole batch of names; people reads had no deadline; one request per session; a blank name for an opted-out member; three tests that proved less than they claimed; the client-swap hook had no guard.
- **Fixed by the same agent, all thirteen:** stores now remember whose data they hold and empty on any change of account; an old save is copied to a `:legacy` key before anything is written and its sessions are carried over to the account's own id by walking the known tables (`lib/legacySave.js`); avatars only from `data:image/` or the project's own storage; the planner is sent ids only; non-uuid ids never go to the database and the stand-in client now refuses them as Postgres does; a 4-second deadline on people reads; one warm for a whole list; "Someone", never a blank; `requireMe` in front of every write that acts as the signed-in person; the swap hook does nothing outside development and tests.
- **The lead agent had told the lead** that not carrying an old save over was a deliberate choice and nothing should be lost. The reviewer showed it destroyed the old save. Corrected to the lead before the fix.
- **Run by the lead after the fixes, exit codes read:** frontend 1112 passed, 71 files, and the same with outbound calls blocked, nothing blocked; backend 899 passed, 2 skipped; build succeeded; the search of the built files found none of the development tools.
- **Merged into `integration/after-pitch`** (`94d24ac`), no conflicts. There: 1112 frontend, 899 backend, build, the same search clean.
- **Not verified by anyone:** a real sign-up, login, token or `profiles` read (nothing has contacted the real project); a browser walk after the fixes; a slow leaderboard or people load for the old account landing just after a switch (the agent left that window).
- **Paused at the lead's word** after this merge: "after this is merged to the branch pause implementation for now". Not started: stage 2, the Locate redesign in the mock-up, the navigation bar on session pages. Open and unmerged: peachoolongtee/jio#137 into `dev`.

## Round 26: three pull requests audited; two merged into `dev`, one held on staging (2026-10-13)

The lead asked for every new pull request to be checked, audited and merged into `dev`. Open then: the lead's own card changes (peachoolongtee/jio#137), darryl5942's sign-up and login (#138), and faithpho's link reader (#139), which is stacked on her place search (#132).

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 26.1 | Lead | Merge #137 (audited in round 25, CI green) | `dev` | CI green | **Completed** |
| 26.2 | Code reviewer, read-only | #138: the reset flow, account enumeration, the sign-up trigger, the password rule, dietary privacy, tests | Nothing | Each finding with a file, a scenario and a fix | **Completed** |
| 26.3 | Code reviewer, read-only | #139: request forgery, the downloader and browser, budgets, what goes to the AI, Google's rules, secrets | Nothing | The same | **Completed** |
| 26.4 | Lead | Run both pull requests' suites, also with outbound calls blocked; compare the live database with #138's files | Nothing on the live project | Real output, exit codes read | **Completed** |
| 26.5 | Implementer | Fix #138's findings on `feat/signup-login-2-integration` (`dev` plus #138) | That branch | Every finding fixed with a test; a migration file for the live change, not applied | **Completed**, merged as #140 |
| 26.6 | Implementer | Fix #139's findings on `feat/link-reader-integration` (staging, plus place search with its fixes, plus #139) | `backend/` on that branch | The same; off unless switched on | **Completed**, pushed, not in `dev` |

### 26.2, 26.4 and 26.5 Sign-up and login

- **Before any change, run by the lead on #138 merged with `dev`:** frontend 904 passed, backend 815 passed and 2 skipped, build, and the frontend again with outbound calls blocked, nothing attempted.
- **The live database:** the author had applied both of his changes by hand before review; no migration is recorded for them (five are listed, as before). The live bodies of `handle_new_user` and `email_registered` read the same as his file. `email_registered` was executable by `anon`. Row counts: 1 account, 1 profile, no sessions.
- **Review, no blockers, three significant:** `email_registered` is an unlimited lookup of whether an address has an account, for anyone with the public key; `/reset-password` treated any signed-in session as a valid link; the recovery token could be written back into the address bar by the router's first navigation (suspected by the reviewer, then confirmed by the fixing agent from vue-router's source and a test that reproduces it). Smaller: a password rule that allowed only six symbols; six availability calls for three username suggestions; other sessions left signed in after a reset; a fixture password the product's own rule refused.
- **Fixes, by an implementer subagent:** the email check moved to `POST /api/accounts/email-check` behind its own limit of 10 a minute, with the function made server-only by a migration file; the reset page opens its form only after a recovery (the event, or a `type=recovery` link whose token matches the session); the Supabase parts of the hash are stripped before the router is created; other sessions are ended after a change; the password rule is 8 or more characters, the four kinds, any symbol, at most 72 bytes; at most four username checks.
- **Run by the lead after the fixes, exit codes read:** frontend 952, backend 838 and 2 skipped, build, both suites with outbound calls blocked. With `dev` merged in again (the card changes): frontend 992, build; the backend failed two tests once (`accounts.test.js`'s 429 test and an `auth.test.js` test, one of them answered by something that was not this server) and passed three times in a row after. That is the port collision already on the tests ticket.
- **Checked by the lead on the live project, read only:** `auth.users` has `deleted_at`, an index on `email`, and no address that is not lower case, so the migration's function will work.
- **Merged into `dev`** as #140 (`adee7e8`); #138 shows as merged with it.
- **Not verified by anyone:** a real recovery email and link in a browser; anything against the real project.
- **Waiting on the lead:** applying `db/migrations/20261013000000_jio_email_check.sql` (until then the lookup is still open on the live project); the dashboard settings the pull request lists; "trust proxy" before a deploy.
- **Changed from the teammate's design by the lead agent's choice, and told to the lead:** the password rule.

### 26.3 and 26.6 The link reader

- **Before any change, run by the lead:** backend 882 passed and 2 skipped on the pull request's head, and with outbound calls blocked. Its CI fails on one frontend test it does not touch. Merged with staging and the place-search fixes (one conflict, both routes kept): backend 1043, frontend 1112.
- **Review, no blockers, five significant:** no switch of its own (on wherever the Gemini key is); it could drain the Google budget the planner shares; input-caused failures paused it for everyone; work was done before any budget was checked; two malformed links answered 500. Smaller: media kept in the cache; the browser's checks ran after the page loaded and it started without its sandbox with the whole environment; the development tools were refused only when `NODE_ENV` was exactly `production`.
- **Clean, by the reviewer's reading:** link parsing; the server's own fetches reach only fixed hosts; the downloader runs through an argument list; keys in headers; the model's answer is checked and nothing it returns is fetched; only the place id is kept; fixtures invented.
- **Fixes, by an implementer subagent, 97 new tests of which 89 fail on the original code:** `LINK_READER=1` or all three routes answer 404; a third of the Google budget at most, 3 ids a refresh, matching once per reading, 15 searches a read; only provider failures count toward the pause; 3 reads and 3 refreshes a minute per caller; budgets checked before gathering, two gathers at once; the unusable links answer 400; no media in the cache; request interception, the sandbox and a minimal environment for the tools; comments to the AI behind `LINK_READER_COMMENTS=1`, off, for the lead to decide.
- **Run by the lead after the fixes, exit codes read:** backend 1140 passed and 2 skipped, and with outbound calls blocked; frontend 1112; build.
- **Not verified by anyone:** any real service, Chrome or `yt-dlp` (not installed; its flags are from memory); the list of media hosts.
- **Not in `dev`:** it depends on the place search, whose fixes depend on the weather work on staging. It reaches `dev` with the staging branch.

### Left as they are

- **#132** (place search): its fixes are on staging; it shows Google places beside the map when a key is set, which is still the lead's decision.
- **#103** (the first AI order pull request, into `main`): replaced by #106 on 11 October; a teammate's, so not closed.
- **Staging is now behind `dev`** by the sign-up work. Bringing it level will conflict in the account files, where stage 1 also worked.

## Round 27: the staging branch landed, the email lookup closed, and weather on the screens (2026-10-13)

The lead said: "apply and land staging since the pitch is over", "off the email confirmation and continue on the weather implementation".

| # | Role | Scope | Status |
|---|---|---|---|
| 27.1 | Lead | Apply `jio_email_check` to the live project | **Completed** |
| 27.2 | Frontend | Merge `dev` into the staging branch (nine conflicts in four account files); make Roam open a place from its card | **Completed** |
| 27.3 | Code reviewer, read-only | Roam inside a meetup, never reviewed before | **Completed** |
| 27.4 | Frontend | Fix the Roam review's findings (the same agent as 27.2) | **Completed** |
| 27.5 | Lead | Merge place search and the link reader into staging, verify, land staging into `dev` | **Completed**, peachoolongtee/jio#143 |
| 27.6 | Frontend | Weather on the screens | **Completed**, peachoolongtee/jio#144 |
| 27.7 | Lead | Turn off email confirmation | **Not done**: the browser extension was not connected and the setting is not in the database. Back with the lead. |

- **27.1:** applied as one statement that refuses to run unless its text has the file's checksum, then checks as real roles: a logged-out visitor and a signed-in user are refused, the server gets "false" for an unknown address and "true" for a known one in upper case with spaces. After: six migrations listed; `email_registered` executable by the server only; 1 account, 1 profile, no sessions.
- **27.2:** both sides kept. A real account's sign-up is eight questions ending on dietary needs with no "Suggested friends"; a local account's is nine. The Supabase stand-in lives in one place, `components/dev/fakeSupabase.js`, with everything both sides added. The open-and-close logic for a place's detail moved to `lib/usePlaceDetail.js`, used by Vote and Roam.
- **27.3:** no blockers. One significant: an accepted stop was timed from the old plan's end, not from now, so a place accepted at 20:00 could appear at 16:10, in the past and marked closed. Smaller: nothing said when a stop ran past the session's end or past midnight; a false "was added"; button names speech control could not use; Propose shown to people who cannot propose; dismissed places kept in the save for ever; an opt-out's undo taking back a proposal made meanwhile (confirmed real by the fixing agent).
- **27.4:** all eleven fixed, each with a test; the agent undid four of the fixes to see their tests fail. New words on screen include "Ends after the session's end, 21:30", "01:30 tomorrow", "That proposal is no longer there." and "Add to plan: <place>". The same late-plan line now shows for any confirmed plan that runs over.
- **Run by the lead on staging before landing, exit codes read:** frontend 1280, backend 1163 and 2 skipped, build, the backend with outbound calls blocked, and none of the development-only account tools in the built files. One frontend run with outbound calls blocked timed out in a hook under load (load average 19) and passed twice after.
- **27.5:** landed as #143 (`33ba01d`). The place-search pull request shows as merged with it; the link reader's stays open because its base is a teammate's branch, though its commits are in `dev`.
- **27.6:** built on `feat/weather-on-screen` by a frontend-engineer subagent, merged with `dev` (two conflicts, both sides kept). Run by the lead on that state: frontend 1449, backend 1163 and 2 skipped, build. Seen by the lead: its screenshot of the itinerary on its day with rain simulated (the simulated banner, the host's Swap and Keep, "Indoor" and "Outdoor, showers"). Different from the ticket: 24-hour times; Home's rain around the outings' meeting areas, not every forecast area; with a simulated forecast every stop counts as still to come. Merged as #144 (`d0e66c2`).
- **Not verified by anyone:** a real sign-up, login or reset link; the real forecast in a browser; the link reader against any real service; two devices.
- **Arrived during the round, not looked at:** two pull requests from darryl5942 into `main` (an itinerary change and an edit-profile page), each showing about 25,000 added lines because `main` is far behind `dev`.

## Round 28: two pull requests from darryl5942 audited (2026-10-13)

The lead moved the work to his PC and said to pull, read the handoff of 13 October and carry on from the map. First on the handoff's list: darryl5942's two pull requests into `main`, an itinerary change (peachoolongtee/jio#141, branch `itinerary-replace`) and an edit-profile page (peachoolongtee/jio#142, branch `user-profile`). Each forked from `dev` at `adee7e8` and touches only `frontend/`: 7 files and 887 added lines, and 16 files and 1,257 added lines. They share `lib/api.js` and the tests' `domless.js`. `dev` has 56 commits they do not.

Baseline on `dev` at `16d4d08`, run by the lead agent on the PC, exit codes read: frontend 1,448 passed and 1 failed, 86 files (with `VITE_API_BASE_URL` blank); backend 1,162 passed, 1 failed, 2 skipped, 37 files (Google forced off); build succeeded. Both failures are this machine's line endings, not the code: `identityScan.test.js` does not strip a comment from a line that ends in a carriage return, and the saved-places test compares bytes with a file git checked out with CRLF. `realAccountData.test.js` timed out in a hook on the first run and passed alone.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 28.1 | Code reviewer, read-only | #141: replacing a stop of a confirmed itinerary | Nothing | Each finding with a file, a scenario and a fix | **Completed** |
| 28.2 | Code reviewer, read-only | #142: the edit-profile page, the photo, the password tab and the change to the password rule's hints | Nothing | The same | **Completed** |
| 28.3 | Lead | Merge each branch with `dev` locally, run the frontend suite and the build, also with outbound calls blocked | Local branches only; nothing pushed | Real output, exit codes read | **Completed** |
| 28.4 | Implementer | Fix what the reviews find, on integration branches (`dev` plus the branch plus fixes): `feat/itinerary-replace-integration` and `feat/user-profile-integration`, each in its own temporary checkout | Those branches, uncommitted | Every finding fixed with a test | **Completed** |

### 28.1 Review of #141, replacing a stop

- **Verdict:** merge after fixes. Nothing is half-written, nothing is written to a session that is over, no privacy leak, the save's shape is unchanged, one planner request per action.
- **Significant, three:**
  - The page says "It keeps its time, and the rest of the plan stays as it is", and the code drops the stop's earliest start and resets both travel legs. With a suggested order confirmed, a replaced Eat stop held at 12:00 starts at about 11:38, and a stop added from Roam can land in the past. The lead read `replaceStop` and confirmed it.
  - The cards are given the sample person as "me" (`:me="HOST_ID"`), which `dev` no longer has in that file; git merges it with no conflict.
  - Anyone in the session can replace a stop, while `dev`'s rain swap, which does the same job, is for the host only and keeps more in step (the options, the dismissed rain warning, a check that the stop has not changed).
- **Smaller:** up to ten red buttons on one screen; a footer button that overflows on a phone for a long place name; no "Try again" when the planner fails on opening; the page is drawn as the Vote step with "Back to Home"; three of its tests cannot fail; the swap icon used for Replace beside the rain flow's "Swap".
- **Merging with `dev`:** conflicts in four files (`SuggestionCard.vue`, `lib/api.js`, `stores/events.js`, `PlannerView.vue`).
- **The lead agent's defaults for the fixes, for the lead to confirm:** replacing a stop is for the host only, like the rain swap; one piece of code changes a confirmed stop's place for both; the replaced stop keeps its start and the page says later stops may move.

### 28.2 Review of #142, the edit-profile page

- **Verdict:** merge after fixes. The password change is sound: the current password is checked by a fresh sign-in, nothing changes when it is wrong, other sessions are ended afterwards, and the password is kept nowhere. The route is private. Writes go only to columns a person may change. The photo is redrawn to a small picture, which drops any location data, and is never uploaded.
- **Breaks on `dev`, two, both seen by the lead in a test run of the merged branch:** "Edit profile" appears on someone else's profile for a real account; the page uses the sample person's id for the avatar's colour.
- **Significant, three:** Save sends every field whether it changed or not, so a tab opened before another device set a dietary need erases it when only the name is edited; after a failed write to Supabase the Save button is disabled and nothing can try again, and the edit is replaced by the account's older values at the next start; the current-password check is in the page, not in Supabase, so it can be skipped from the browser's developer tools on an unlocked device (true on `dev` today too; closing it is a dashboard setting).
- **Smaller:** white text on the brand red for "Add photo"; a picture that fails while being drawn gives no message; a mismatch between the two new passwords empties the current password too; focus is lost after a failed attempt; no username field for a password manager; reset-flow words if the session ends mid-change.
- **The password rule after this pull request:** what a password must contain is unchanged from the audit of 13 October (8 or more characters, the four kinds, any symbol, at most 72 bytes, no space at either end). The pull request takes the sixth part off the checklist on sign-up, reset and the new tab, and shows it under the field only when it is broken. The three screens agree with each other and with the code. The words say "72 characters" where the code counts bytes.
- **Its edits to four existing test files** follow that one change of display and weaken nothing else.
- **Merging with `dev`, by the lead:** one conflict, in the tests' `domless.js`, where both sides added the same getter; the pull request's fuller one was kept. On the merged branch before any fix: frontend 1,489 passed and 3 failed (the two above and this machine's line-ending failure); the build succeeded.

### 28.3 and 28.4 The fixes, and what the lead ran and saw

Both fixing agents stopped once at their turn limit with no report and were resumed.

**#142, edit profile** (`feat/user-profile-integration`: `dev`, the merge, and fixes in nine files)

- **Fixed, all thirteen findings**, each with a test; the agent undid each source file in turn and saw its tests fail, though several fixes share `EditProfileView.vue` and could only be seen failing together.
- **Run by the lead after the fixes, exit codes read:** frontend 1,511 passed and 1 failed (this machine's line-ending failure, which also fails on `dev` here), the same with outbound calls blocked and no call attempted; the build succeeded.
- **Read by the lead:** the patch that sends only the fields that changed, and the current-password check, which now confirms the account that signed in is the same person and puts the old session back when it is not.
- **Seen by the lead in a browser** (the demo account, a local one, at 320 px): "Edit profile" on my own profile and not on Darius's; the page fits; "Add photo" is outlined, not red; Save is disabled until something changes; the Password tab shows only "This account lives only in this browser and has no password to change."; no console errors.
- **Changed from the teammate's design, for the lead to know:** a mismatch between the two new passwords keeps what was typed; the second field is labelled "Type it again" and the message is "The two passwords do not match.", as on the reset page; after a save that did not reach the account the page says "Saved on this device, but not to your account. Press Save details to try again." and the button stays usable; a picture over 15 MB is refused.
- **Not seen by anyone:** the password tab for a real account, a photo being chosen, the failed-save line, anything against the real project.

**#141, replacing a stop** (`feat/itinerary-replace-integration`: `dev`, the merge with four conflicts resolved, and fixes)

- **The merge:** both sides kept. The card keeps `dev`'s `foot` slot, which now passes the voters' line and whether the place leads; the pull request's `action` slot is gone.
- **Fixed, all ten findings.** One private function, `changeStopPlace`, now changes a confirmed stop's place for both the rain swap and Replace: the host only; refused when the stop no longer holds the place the caller saw or has moved; ranked for the day the itinerary uses; the stop never starts earlier than the time it was checked for; the options, the kept ranking detail and the dismissed rain warning stay in step. `replaceStop` takes the place the page saw as a fifth argument.
- **The rain swap changed with it, by the agent's choice:** it now also resets the travel to and from the stop to the default, clears the AI's note and holds the stop's start. No test of `dev`'s failed.
- **Run by the lead, exit codes read:** frontend 1,505 passed and 1 failed (the same line-ending failure), the same with outbound calls blocked and no call attempted; the build succeeded; no conflict marker left; no existing test of `dev`'s changed (`planFixture.js` gained three helpers).
- **Seen by the lead in a browser** (the showcase's confirmed "Chinatown makan crawl", stub backend, 375 px): Replace on each stop in edit mode; the replace page lights Itinerary and its arrow is "Back to Itinerary"; "This stop keeps its start, and the rest of the plan stays as it is. Later stops may move with the travel time."; "Use this place" is a secondary button; the footer is "Keep this stop"; no overflow; choosing Capitol Theatre returned to the itinerary with the stop still at 20:09 and the next stop unmoved; no console errors.
- **Found and left:** the browser tab's title on the replace page is still "Vote".
- **Not seen by anyone:** a member's view of the page, "Try again" after a planner failure, the rain flow after the change, widths other than 375 px.
- **Defaults taken by the lead agent, awaiting the lead:** replacing a stop is for the host only; a replace into another kind of stop takes the old place out of the options without adding the new one.

### 28.5 Committed, posted and sent to `dev`

The lead said: "commit no co author lines same as usual and post as a comment and merge dev".

- **Committed** on each integration branch as the merge and one commit of fixes, with no co-author line. On the itinerary branch the merge commit carries the fixes that sit in the four conflicted files, because the conflicts were resolved and fixed in one pass.
- **Posted:** the audit of each pull request as a comment on it (#141 and #142).
- **Pull requests into `dev`:** peachoolongtee/jio#147 for edit profile, and one for replacing a stop from `feat/itinerary-replace-integration`, which also carries this log.
- **Both together, run by the lead before either merged, exit codes read:** frontend 1,568 passed and 1 failed (the line-ending failure), 89 files; the build succeeded. The two branches merge with each other without a conflict.
- **Left alone:** the base of #141 and #142, which is still `main`.

## Round 28: sessions on the server, stage 2, a shared session (2026-10-16)

The lead split the open work among the team (posted on the map), gave the Google ranking fix to faithpho (#149), took every recommendation on the server design's eight questions (#125), and asked for stage 2. Darryl's two pull requests went into `dev` first as #147 and #148, after the lead's agent ran every suite on each merged with `dev` (1569 frontend at the end, 1163 backend, build, the frontend with outbound calls blocked).

| # | Role | Scope | Status |
|---|---|---|---|
| 28.1 | Frontend | Stage 2 (#127): sessions as database rows for a real account; invite by link and by username; `/join/:token`; both lobbies live; leave and remove through a new server route; a real session held at the lobby | **Completed** |
| 28.2 | Lead | Run the stage's exact reads and writes on the live project as three throwaway accounts, in one statement that rolls back | **Completed**, 26 of 26 |
| 28.3 | Code reviewer, read-only | Stage 2 | **Completed**: no blockers, four significant |
| 28.4 | Frontend | Fix the review's findings (the same agent as 28.1) | **Completed** |

- **28.1:** `frontend/src/lib/sessionsRemote.js` holds the remote functions; `lib/api.js` chooses local or remote per function by account, so the demo account, the showcase and the tour are unchanged. `DELETE /api/sessions/:id/members/:userId` (`me` or a uuid) behind the login check with its own limit. The development stand-in grew a database (`components/dev/fakeDatabase.js`) modelled on `db/schema.sql` and `db/policies.sql`. No migration was needed: the live publication already carries `sessions`, `session_members` and `invites`.
- **28.2, on the live project:** the host created a session and its host row appeared; made one link (a second refused); a signed-out caller got only the preview; a second person saw nothing before joining, joined, read the session and both members, read no invite rows, and could not rename, cancel, make a link or delete a member row; the host renamed, found a third person by exact username and invited them; that person saw the invitation and not the session, and declined; the revoked link previewed nothing and refused joining; the host cancelled. Afterwards 1 account, 1 profile, no sessions, members or invites, and none of the test accounts.
- **28.3:** the access rules and the route held. Significant: the Realtime channel would likely die on an ordinary page change (realtime-js reuses a channel that is still leaving; the stand-in did not model it); a resync did not refresh the open session page; an unfiltered delete event made every client read sessions it could not see and could mark a foreign session "gone"; a read in flight across an account switch could fill the next account's screens. Also: a read-then-write `plan_version` bump, and leaving allowed after a start.
- **28.4:** all fixed, each with a test shown to fail without its fix: a topic per channel and a short grace before closing; every open session re-read on resync; deletes ignored for sessions the account does not know; an epoch and store tickets across account switches; a conditional retrying `plan_version` bump; the route only for `inviting` sessions, ids compared in lower case; "not found" only for a missing session; the link, username, decline and leave functions refuse for a demo or local account; the host hears declines, expiries and revokes live; the stand-in now dedupes channels by topic, runs triggers before the row check, answers 22P02 for a non-uuid and fails a RETURNING the caller cannot read.
- **Run by the lead after the fixes, exit codes read:** frontend 1705 passed; backend 1185 passed and 2 skipped; build; both suites with outbound calls blocked, nothing attempted; none of the development-only tools in the built files.
- **The builder's browser walk:** 17 steps with three accounts and a signed-out visitor in separate contexts sharing one stand-in database, at 1280, 375 and 320 px, including moving between screens mid-way; no errors, no overflow. Seen by the lead: the step list and results files, not screenshots.
- **Not verified by anyone:** the live Realtime in a browser (including the `created_by` and `invitee_id` filters), two real devices, a real login token against the new route.
- **Left for stage 3, recorded in `DESIGN.md`:** the held start is enforced only in the app; a removed guest can rejoin with the same link but cannot be invited by username again; a stage 1 real account's old local-only sessions are hidden.

## Round 29: four teammates' pull requests reconciled (2026-10-17)

The lead asked for the new pull requests to be reconciled. Open then: NICHOLE-ONG's #151 (invented venues, #54), darius-soh's #152 (#120, #121, #122, #98), oj0nathan's #153 (accessibility, #62) and #154 (layout, #63). Each was merged with `dev` on its own integration branch (`review/pr-<n>`), checked by the lead's agent, reviewed by a read-only reviewer, fixed by an agent, checked again, and merged into `dev` in the order #151, #154, #153, #152.

**GitHub Actions has started no job since 16 October 10:18:** "recent account payments have failed or your spending limit needs to be increased". Every red CI mark since then is billing, not code; the lead agent's local runs were the only gate. The lead was told.

| Pull request | Review | Fixed | Run by the lead's agent before merging, exit codes read | Merged as |
|---|---|---|---|---|
| #151 | No blockers. No test for any claim; a `rating` weight accepted and ignored; the pool switched on by `NODE_ENV=test`; "today" frozen at first load; stale docs | All; 17 new tests through `loadPlanData`, 13 fail on the old `dev` | backend 1202 (one shared-port failure, passed on rerun), also with `NODE_ENV=development` and with outbound calls blocked; frontend 1705; build | #155 |
| #154 | Blocker: a sheet dragged closed reopened pushed down. Map controls, hover cards, toast and demo button ignored the insets; Home scrolled by them; a 12 px drag target | All; one source for the bars' real heights; the landscape-map sentence corrected after measuring | frontend 1721; backend; build; frontend with outbound calls blocked | #156 |
| #153 | Significant: keyboard users could Tab to one Vote chip per slot. Untested directive wiring; a disabled chosen chip could strand a group; standing banners announced as alerts; `SelectField` error not tied to its field | All; Vote chips are toggles; 24 tests of the directive's wiring. One conflict with #156 in the toast, both kept | frontend 1766; backend; build; frontend with outbound calls blocked | #157 |
| #152 | Required: a one-person "Already out?" outing paid JioCoins without limit; Home did not settle outings that ended elsewhere; the tour's hidden saves leaked into streaks. Advised: a read saved over a newer tab's save; demo "today" outings finished by themselves | All, plus the radius chips in a named chip row with one Tab stop, a notice when a radius change clears votes, tomorrow preset after 23:00, a closed outing taking no photos | frontend 1829; backend; build; frontend with outbound calls blocked | #158 |

- **Tickets closed as done:** #54, #98, #120, #121, #122. #62 and #63 stay open for the checks a person must make (a keyboard and screen reader; a real phone with screenshots).
- **Taking ratings out of the score (#151)** overlaps the Google ranking ticket #149, whose review-weighted ratings are now moot unless the lead wants ratings back; the lead was asked.
- **Known and left:** in the demo, instant invite acceptance still lets a person pair with a sample friend to earn coins (the points are a labelled demo); anti-repeat's `groupId` is caller-supplied until real history exists.
- **Not verified by anyone:** any of the four on a real phone, keyboard or screen reader.
