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
