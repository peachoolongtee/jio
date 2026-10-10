# Handoff: meeting spots the group votes on, and Roam

Written 2026-10-11 by the lead's orchestrating agent, and revised the same day when the work was paused to move to another machine. It is for a fresh session that has none of the earlier conversation. Everything a new session needs is here or behind a pointer from here.

**Read section 2 first.** It says what is already done and what was left half done.

## 1. How to start the fresh session

Open a new session in the Jio repository and paste this:

```text
You are the lead orchestration agent for Jio. Read CLAUDE.md, then docs/handoffs/meeting-spots-and-roam.md in full, then DESIGN.md.

Continue the feature in that handoff: meeting spots the group suggests and votes on, a host shortcut for a place that is already decided, and Roam. The product decisions are settled in section 4; do not reopen them. Section 2 says where the work stopped: start there, with slices 1 and 2.

Work as section 9 describes: delegate each slice to a subagent with a full brief, log the round in docs/agents/work-log.md before delegating, check every claim yourself before you accept it, and record real results. Do not commit or push until I ask.
```

If this file is not in the repository on the new machine (it was untracked when the work paused), save it as `docs/handoffs/meeting-spots-and-roam.md` first.

## 2. Where the work stopped (2026-10-11, about 01:00)

> **Update, later on 2026-10-11, on the second machine.** The first machine's branch was never pushed, so slices 1 and 2 were built again from `main` at `2e1643d` (Google Places had landed by then) and checked by the lead agent. They are committed on `feat/meeting-spots`, which has not been pushed. Round 15 in `docs/agents/work-log.md` has the results, the shape of `session.spots` that slice 3 is briefed from, and what differs from sections 7 and 9 below. Slice 3 is next. The rest of this section describes the first attempt and is kept as a record.

The lead paused the work to move it to another machine. Two agents were running and were stopped mid-task.

### Done, and on GitHub

| What | Where |
|---|---|
| Six tickets for the slices, under the wayfinder map, with their blocking edges | peachoolongtee/jio#94 (slice 1), #95 (slice 2), #96 (slice 3), #97 (slice 4), #98 (slice 5), #99 (slice 6). #96 and #97 are blocked by #95; #98 by #97; #99 by #96, #97 and #98. |
| The decisions table | In the body of #94 |
| The lead's answer to question 11 | A comment on #94; also section 5 below |
| The schema this feature will need, as a proposal, not applied | A comment on #80, dated 11 Oct 2026 |

### Done, but only on the first machine unless the branch was pushed

Branch `feat/meeting-spots`, cut from `main` at `5b975c2`. **Nothing on it was committed when the work paused.** Check first:

```bash
git fetch origin
git branch -r | grep meeting-spots
```

- **If the branch is on the remote:** check it out, run `pnpm install`, and everything in the table below is there.
- **If it is not:** start `feat/meeting-spots` from `main` and redo the table below. It is small. Appendix A has the text for `CONTEXT.md` and the work log.

| File | State |
|---|---|
| `docs/handoffs/meeting-spots-and-roam.md` | This file |
| `CONTEXT.md` | Six new words added (Appendix A) |
| `docs/agents/work-log.md` | Round 12 added, slices 12.1 and 12.2 marked "In progress" (Appendix A) |
| `backend/tests/meeting-area-baseline.test.js` and `backend/tests/fixtures/meeting-area-baseline.json` | **Slice 1, finished part.** 44 recorded requests to `/api/meeting-area` and the answers `main` gave, compared byte for byte. Recorded before any source change. |
| `backend/src/routes/plan-schemas.js` | **Slice 1, half done.** `alternatives` and `include` are accepted and bounded (`MAX.alternatives`, `MAX.includedAreas`, an unknown or repeated area id is refused). The engine and the route do not use them yet, so they do nothing. |
| Everything else in slice 1 | Not started: the engine, the route, `candidates` in the answer, the routing order under the cap, the tests, the docs |
| Slice 2 | Not started. The agent was still reading when it was stopped. |

Suites on the half-done tree: `pnpm test` 428 passed, 1 skipped, 21 files. The frontend suite and the build were not run after the pause. Baseline on `main` at `5b975c2`: `pnpm test` 383 passed, 1 skipped, 20 files; `pnpm --filter jio-frontend test` 324 passed, 30 files; `pnpm build` succeeded.

### Not done

- Slices 1 and 2 need to be run to the end. Use the briefs in section 9; they carry what was learned on the first attempt.
- Slices 3 to 6.
- Nothing has been verified by the lead agent beyond the suite counts above. The baseline test has not yet been run against an untouched copy of `main` by anyone but the agent that wrote it.

### Two things in flight that this work depends on

Neither had landed on `main` when the work paused. The lead said to go ahead on a separate branch anyway.

| Work | State on 2026-10-11 | Where it overlaps |
|---|---|---|
| Google Places pull request, peachoolongtee/jio#91 | Open, mergeable | It adds to `backend/src/routes/plan.js` (the converge and roam handlers, a photo route), the `MAX` block in `plan-schemas.js` (appended at the end), `backend/docs/planner-api.md`, `backend/tests/onemap-limits.test.js` and `backend/tests/plan-routes.test.js`. Slice 1 touches the meeting-area handler and puts its `MAX` entries after `members`, so the merge should be small. |
| Showcase and Home's "Plan a new meetup" row, branch `feat/demo-showcase` | Uncommitted in the first machine's main checkout, being worked on by another session | It changes `createSession` (a `hostId` parameter) and `inviteFriends` (an `acceptAfter` option) in `frontend/src/lib/api.js`, and `LandingView.vue`, `MeetupList.vue`, `DemoPanel.vue`. Slice 2 must leave those two functions alone apart from the new session field. Slice 3's Home chips and demo tools will meet it. |

Run `gh pr list` and `git log --oneline -15 origin/main` before starting. If either has landed, merge `main` into `feat/meeting-spots` first.

## 3. What is being built, in three sentences

Today Jio works out one meeting area from where everyone starts and the host confirms it. The lead wants that step to be communal: the app suggests fair spots, members suggest their own, everyone says which ones work for them, and the host settles it. Roam, which suggests things to do near where a group already is, exists only in the backend; it gets its first screens.

## 4. Decisions, settled by the lead on 2026-10-11

The lead was asked eleven questions and took the recommended answer to each.

| # | Question | Decision |
|---|---|---|
| 1 | What is suggested and voted on at the "where" stage? | An **area** (Bishan), from the app's list of areas. Specific places stay in the existing place vote that follows. |
| 2 | Two votes per meetup, where and then what? | Yes. The first is one tap: "Works for me" on any number of spots. |
| 3 | Does a member's suggested spot show everyone's travel time? | Yes, exactly like the app's own suggestions. Showing who travels how far is the point of Jio. |
| 4 | Who settles it? | The **host** confirms. The votes are advice. The spot with the most "Works for me" is preselected. |
| 5 | What if people do not vote? | The host can confirm at any time. Nobody is waited for. |
| 6 | Can the host skip the vote when the place is already known? | Yes. "We already have a place" picks an area and goes straight to choosing what to do. |
| 7 | Some people are already together and others are travelling. A separate mode? | No. It is a member suggesting a spot, marked "we are here already". |
| 8 | When can Roam start? | Both inside a meetup once it is under way, and from Home with no meetup. From Home it creates a light meetup with no location step. |
| 9 | Where is Roam centred? | The meetup's meeting area by default, with "Use my location" as an option. |
| 10 | Does Roam need a vote? | No. It is a list. Anyone can propose a place from it; the host confirms it into the itinerary. |
| 11 | Which parts must be in the graded demo, and by when? | **The spot vote and the host's shortcut are the must-haves.** Roam is built after and shown only if it is solid in time. The demo-ready part should be on `main` in about a week, so by about 2026-10-18, which leaves room for the full review round. |

In the lead's own words: "I want to make it like a communal thing where people can also suggest meetup spots, and people can take a vote accordingly", "for the decisions, I think the host can", members are "still asked where they're starting from", and for Roam "we assume that they are already at a common location, so it will be suggesting things around the vicinity".

### What follows from the decisions (the orchestrating agent's reading, not the lead's words)

- **One flow, no mode switch.** Converge and Roam differ in one step. The session keeps its five steps (Create, Invite, Locate, Vote, Itinerary) and its statuses. The spot vote lives inside Locate: the status stays `locating` until the host confirms a spot, then becomes `voting` as today.
- **Approval voting, not ranking.** A member may mark any number of spots. No ordering, no points.
- **Ties** in the preselection go to the spot with the shortest longest trip, which is the app's existing fairness rule.
- **Limits.** Three suggestions from the app. One suggestion per member at a time; suggesting again replaces it. The host's "already have a place" replaces the whole list.
- **A change undoes approvals honestly.** If a member's start changes, the app's suggestions and every spot's travel times are worked out again. Approvals for a spot that is still listed are kept; approvals for a spot that dropped out are removed, and a banner says so, the way "Votes for places were cleared" does today.
- **Privacy rule from `CLAUDE.md` still holds:** the group sees a member's area, never their exact place. "Use my location" in Roam shows the group the area's name only.

## 5. Open points for the lead

Question 11 is answered (section 4). Two smaller points to raise when they come up, each with a default so work does not stop:

- **A deadline for the spot vote?** Default: none. The host confirms when ready.
- **Can a member who is not the host use "we are here already"?** Default: yes, it is only a label on their suggestion.

## 6. What exists today (checked against `main` at `5b975c2`, 2026-10-11)

Read the code before relying on any line below; it is a map, and the code is the territory.

### Frontend

- **All data is local.** `frontend/src/lib/api.js` is the data layer every view and store goes through. It keeps one object in local storage under `jio-demo-v1`, with `VERSION = 8` and a shape check (`hasShape`). A save with another version keeps the account and starts the rest fresh; that is what "an old save still loads" means. A new session field needs a version bump.
- **A session** (`createSession`, about line 813) has: `id`, `title`, `date`, `start`, `end`, `hostId`, `status` (`inviting`, `locating`, `voting`, `confirmed`, `completed`, `cancelled`), `members[]`, `locations{}` (per person: `start` and `end`, each `{ areaId, label }`), `meeting` (one object, or null), `prefs`, `options`, `votes`, `plan`, `banner`, `replan`, `photos`, `radius`.
- **The meeting area today:** `computeMeeting(session)` (about line 300) calls `planner.meetingArea({ members, routing })`, which posts to the backend's `/api/meeting-area`. It runs when a location changes (`applyTrigger`) and stores one result in `session.meeting`. While the status is `locating` it returns null **until every active member has a start**. `useMeetingArea(id)` (about line 927) is the host's "Confirm location": it sets the status to `voting` and builds the place options.
- **There is no offline fallback.** When the backend cannot be reached the planner call throws, `orUndo` puts the session back as it was, and the caller gets the planner's error message. "Works with the backend off" therefore means: a write that needs the planner rolls back whole and says why; a write that needs no planner (an approval) still works.
- **Ranking places needs a start for every member.** `/api/converge` requires each member to have a start or a home, and `membersFor(session)` sends only members with a start. A known place set before anyone has shared a start has no members to send. Slice 2 has to solve this (one option: a member with no start is sent as starting at the meeting area).
- **The screen:** `frontend/src/views/GroupDetailView.vue` (382 lines) covers people, locations and the meeting area. It shows "Waiting for N people" with "Continue without <name>" for the host, a "Finding the meeting point" progress bar, a map with each person's start area and travel time, and a "Confirm location" button.
- **Steps bar:** `frontend/src/components/event/SessionSteps.vue` (`STEPS`, `reachedStep`, `viewingStep`, `stepsFor`). It sits above the title on every session screen and must not move or flicker between screens; see "Four fixes from use" in `DESIGN.md`.
- **Home:** `frontend/src/views/LandingView.vue` with `frontend/src/lib/homeMeetups.js`. `nextStepFor(session, myId)` decides the chip on each meetup ("Vote", "Waiting for 2 people" and so on). A new state in the session needs a new answer there.
- **Planner calls:** `frontend/src/lib/plannerApi.js` has `meetingArea`, `rankSlot` (posts to `/api/converge`) and `searchSlot`. There is **no Roam call**.
- **Roam:** `frontend/src/views/RoamView.vue` is an empty page headed "What next?" and has no route.
- **Location helpers already there:** `listAreas()`, `searchPlaces()`, `placeFromCoords()` in `api.js`.
- **Demo tools:** `frontend/src/components/dev/DemoPanel.vue` simulates friends' locations, votes and photos. A showcase of sessions in every state (`components/dev/showcase.js`) was being built on branch `feat/demo-showcase`; see section 2.

### Backend

- **`POST /api/meeting-area`** returns **one** area: `area`, `centre`, `worstMinutes`, `worstMember`, `meanMinutes`, `travelByMember`, `approximate`, `travel`. It returns no runners-up and cannot be asked about a particular area. Slice 1 changes that.
- **How it picks.** `meetingArea()` in `backend/src/planner/engine.js` (about line 360) is synchronous. For method `station` it sorts areas by distance from the fairest point, keeps `maxCandidates`, and picks the best by longest trip, then by fairness-weighted mean. The other methods (`centroid`, `weighted_centroid`, `minimax`) compute a centre point, measure travel to that point, and name it after the nearest area. The frontend sends `centroid` when the demo's "routing off" switch is set.
- **How it routes.** With routing on, `plan.js` limits the station check to the 16 nearest areas and gives real routes to the best 5 by estimate. The engine runs twice (`backend/src/services/travel-times.js`): a dry run that records trips grouped into candidates by area id, then a real run. `approximate` is one flag for the chosen result.
- **Validation errors on the planner router** answer `{ error: 'invalid_input', issues: [...] }` through `invalid()` in `plan.js`, and the frontend reads `issues`. `CLAUDE.md` describes the shape as `{ error, message }`. Do not add a third shape; an unknown area id answers as the route's other validation errors do.
- **`POST /api/converge`** ranks places around a `centre`. **`POST /api/roam`** does the same around `current: { lat, lng }`; members need only an `id`; categories default to eat, drink and activity; results carry `travelMinutes` and `distanceKm`.
- **Docs:** `backend/docs/planner-api.md` (request and response for every route), `backend/docs/external-apis.md`.
- **OneMap is a shared budget:** at most 60 routed trips per request, whole candidates only, and 240 calls a minute for the whole server. A trip over either limit uses an estimate and is flagged `approximate`. With 30 members only two areas fit. Asking about more areas costs members × areas trips, so the new inputs need bounds and must go through the same cap.
- **Every planner input has an upper bound** in the `MAX` block of `backend/src/routes/plan-schemas.js`.

### Database (live, but no app code reads or writes it yet)

- `sessions.meeting_area_id` and the other `meeting_*` columns are **server-only writes**; the trigger `guard_session_changes` enforces it. `meeting_method` may only be `same`, `fairest` or `centre`.
- There is no table for suggested spots or approvals.
- **Do not change the live database for this feature.** The frontend is still local. The schema this feature will need is already written on ticket #80 as a proposal; update that comment if the design moves, and stop there.

## 7. Design

### The Locate step, after the change

1. Members share where they start, as today. The "Waiting for N people" card and "Continue without <name>" stay.
2. Once at least two starts are in, the page shows **"Where to meet"**: a list of spots.
   - Up to three from the app, the fairest first, labelled as the app's.
   - Each member's own suggestion, with their name, and "We are here already" when they marked it.
   - Every spot shows the longest trip, the average, and each person's minutes, with "about" when the times are estimates.
   - Each spot has a "Works for me" toggle and a count with the avatars of who chose it.
3. **"Suggest a spot"** opens the existing area picker. A member has one suggestion at a time.
4. **The host** sees the spot with the most approvals preselected and a "Confirm <area>" button that works at any time. Other members see "Waiting for <host> to confirm".
5. **"We already have a place"** is offered to the host when creating the session and again on the Locate step. It asks for an area, sets the meeting area, and moves to Vote. Members can still add where they start, which only adds travel times.
6. The map shows every spot as a pin; selecting a row selects its pin and the reverse. Follow Home's pins (`components/home/MeetupPins.vue`) and their hover card, and read section 10 on that.

### Roam

- **In a meetup that is under way** (status `confirmed`, on the session's day): a "What next?" action on the Itinerary page opens a list of places near the meeting area, with a "Use my location" switch. Any member can press "Propose" on a place; it appears on the itinerary as a proposed stop with their name; the host confirms or dismisses it.
- **From Home, with no meetup:** an entry ("Already out? Find something nearby") creates a light meetup for today, asks for an area or the current location, skips the location step, and opens the same list. Inviting friends is optional.
- Filters on the list are the categories the planner already has. No new ranking controls.

### Data layer contract (local `api.js`; names are proposals, keep them if nothing better turns up)

```js
// On a session:
spots: {
  list: [{ areaId, by: 'app' | '<personId>', here: false,
           worstMinutes, meanMinutes, times: { '<personId>': minutes }, approximate }],
  approvals: { '<personId>': ['<areaId>', ...] },
}
meeting: { ...as today, method: 'same' | 'fairest' | 'centre' | 'voted' | 'chosen' }
proposals: [{ id, venueId, by: '<personId>', at }]      // Roam proposals waiting for the host (slice 4)

// Slice 2:
suggestSpot(id, personId, areaId, { here = false })      // replaces that person's earlier suggestion
withdrawSpot(id, personId)
approveSpot(id, personId, areaId, on)                    // any member, while locating
confirmSpot(id, areaId)                                  // host only; takes over from useMeetingArea
setKnownPlace(id, areaId)                                // host only; from inviting or locating straight to voting

// Slices 4 and 5:
roamNearby(id, { point?, categories? })                  // the list; point defaults to the meeting area
proposeStop(id, personId, venueId)                       // any member, session under way
resolveProposal(id, proposalId, accept)                  // host only
startRoam({ areaId | point, title? })                    // Home's entry: the light meetup
```

Bump `VERSION`, extend `hasShape`, and keep `useMeetingArea` working as "confirm the preselected spot" until every caller has moved.

Defaults for what the contract leaves open (the orchestrating agent's, given to the slice 2 agent to keep or to argue with):

- **When the list appears.** `spots` is worked out as soon as two starts are in, with times for the members who have one. `session.meeting` keeps exactly today's meaning and timing while locating, so existing screens and tests are untouched.
- **`meeting.method`.** `setKnownPlace` gives `'chosen'`. `confirmSpot` gives `'voted'` when the confirmed spot has at least one approval; with none it keeps the planner's own method when the spot is the app's first suggestion, and `'chosen'` otherwise.
- **One planner request per change**, not one per spot (ticket #56 is about the frontend flooding the planner). Members' suggestions go in `include` on the same request that asks for the app's three.
- **An older backend.** An answer with no `candidates` still works: the list is the one chosen area.

### Backend contract (slice 1)

`POST /api/meeting-area` gains, with nothing changing when the new fields are left out:

- Request: `alternatives` (0 to 3, default 0): how many runners-up to return. `include` (up to 8 area ids): areas to evaluate whatever their rank.
- Response: `candidates: [{ area, worstMinutes, meanMinutes, travelByMember, approximate, source: 'ranked' | 'included' }]`, the chosen area first.
- Both bounds go in the `MAX` block. The 60-trip cap is unchanged: an included area that cannot be routed inside the cap is estimated and flagged.
- An unknown area id is a 400, in the shape this router's other validation errors use.

**Correction found on the first attempt:** `alternatives: n` means the chosen area plus up to n runners-up. For the app's three spots the frontend sends **`alternatives: 2`**, not 3.

Defaults for what the contract leaves open:

- For the non-station methods, `candidates[0]` mirrors the top-level answer, and runners-up are areas ranked by the station rule, leaving out the chosen area.
- An included area that is also the chosen area or a returned runner-up appears once, with source `'ranked'`. So the frontend works out who suggested a spot from its own data, not from `source`.
- A duplicate id in `include` is a 400.
- An included area is evaluated even when it is outside the 16 nearest that routing mode tries.
- Every candidate's numbers come from the same run as the top-level answer.
- `candidates` does not appear when neither new field is sent.

### Schema for later

On ticket #80, as a proposal: a `session_spots` table, a `spot_approvals` table, a `stop_proposals` table, and two more values for `meeting_method` (`voted`, `chosen`). Confirming a spot and resolving a proposal are server writes, like the meeting area today. Not applied.

## 8. Slices, in order

### Before any slice

Done on 2026-10-11: the tickets, the decisions on the tracker, the new words in `CONTEXT.md`, round 12 in the work log (the last two are on the branch; see section 2). Still to do on a new machine:

1. `git fetch`, then check what has landed: `gh pr list`, `git log --oneline -15 origin/main`.
2. Get onto `feat/meeting-spots` (section 2 says how), run `pnpm install`, and run the three suites for a baseline.

### The slices

| # | Ticket | Slice | Owner | Depends on | Done when |
|---|---|---|---|---|---|
| 1 | #94 | Backend: `candidates`, `alternatives` and `include` on `/api/meeting-area` | Backend agent | Nothing | Old requests answer exactly as before; bounds tested; route calls per request at or under 60 with 30 members, 3 alternatives and 8 included areas; docs updated |
| 2 | #95 | Data layer: spots, approvals, confirm, known place, version bump | Frontend agent | The contract in section 7, not slice 1's code | Unit tests for every rule in section 4 and "What follows"; planner failures roll back; old saves load |
| 3 | #96 | Locate screen: the list, "Works for me", "Suggest a spot", host confirm, known place, map pins, Home's chips, demo tools | Frontend agent | 2 | Measured at 320, 375, 744 and 1280 px; keyboard reaches every control; steps bar does not move |
| 4 | #97 | Roam inside a meetup: the planner call, "What next?", the list, proposals, host confirm | Frontend agent | 2 | A proposal becomes an itinerary stop only after the host accepts; works with the backend off or says plainly that it cannot |
| 5 | #98 | Roam from Home: the entry, the light meetup, "Use my location" | Frontend agent | 4 | Location refused or unavailable falls back to picking an area; the group sees an area name only |
| 6 | #99 | Review and record | Reviewers, then the lead | 3, 4, 5 | Findings fixed or ticketed; `DESIGN.md`, `CLAUDE.md`, work log and showcase data updated |

Slices 1 and 2 can run at the same time: one changes only `backend/`, the other only `frontend/src/lib/` and `frontend/src/stores/`. Slices 3 and 4 touch different views and can run at the same time once 2 is in, if each is told which files are the other's.

By the lead's answer to question 11, slices 1 to 3 are the must-haves. If time runs short, review and merge those before starting slice 4.

## 9. How to delegate

The standing brief from the lead: delegate to subagents, never accept a completion claim you have not checked, keep `CLAUDE.md` and `docs/agents/work-log.md` true, and let the tracker be the source of truth.

### Agents that fit each job

| Job | Agent type | Note |
|---|---|---|
| Backend slice | `implementer` | Can edit and run commands |
| Frontend slices | `frontend-engineer` | Can edit and run commands, including a headless browser |
| Review of code | `code-reviewer` | Read-only: no shell, so it cannot run tests |
| Review of screens | `design-reviewer` | Read-only |
| Proof that it works | `verifier` | Runs things; tell it to change nothing |
| Recording the design language | `impeccable-documenter` | Only if `DESIGN.md` needs a full re-record |

These agent types are defined on the first machine. If the new machine does not have them, use a general-purpose agent and put the role in the brief.

### What every brief carries

Objective; context the agent cannot see (it knows only what the brief says); the files it may change and the ones it must not; the rules that bind it, by pointer to `CLAUDE.md` and `DESIGN.md`; the output wanted; acceptance criteria that can be checked. Tell it what you have already ruled out. Tell it to say so when the brief is wrong for the codebase, not to follow or skip it silently. Ask for real output, pasted. When two agents share one checkout, tell each which directories are the other's and forbid any git command that changes the tree or the index.

### What to do with a report

- Run the suites yourself: `pnpm test`, `pnpm --filter jio-frontend test`, `pnpm build`. Record the counts with the date in `CLAUDE.md`'s table.
- Read the changed code for the riskiest claim in the report.
- For slice 1, copy the baseline test and its fixture into an untouched checkout of `main` and run it there. It must pass on both.
- Open the screen yourself where you can, and say plainly what you did not see.
- A review that confirms your own view is weak evidence. Give reviewers the code and the claims, never your conclusion.

### Brief for slice 1 (paste, then adjust the paths)

```text
You are adding runners-up and named areas to one route of Jio's planner backend (Express 4 on Node 24, zod, vitest; pnpm only). Jio decides where a group should meet, fairly. This is tracker ticket peachoolongtee/jio#94.

Where to work: the repository root, on branch feat/meeting-spots. You may change backend/ only (source, tests, backend/docs/). You must not change frontend/, db/, CLAUDE.md, CONTEXT.md, DESIGN.md or docs/. Another agent may be editing frontend/src/lib/ and frontend/src/stores/ in the same checkout: run no git command that changes the tree or index (no stash, checkout, reset, restore, add, commit, push), and do not run the frontend suite. Never read or print a .env file. Never call the real OneMap, Google or data.gov.sg services: tests use stub HTTP.

Read first: CLAUDE.md (Working Rules, Architecture Decisions), docs/handoffs/meeting-spots-and-roam.md sections 2, 6 and 7 ("Backend contract"), backend/docs/planner-api.md ("POST /api/meeting-area", "Travel times", "Limits"), backend/src/routes/plan.js, backend/src/routes/plan-schemas.js (the MAX block), backend/src/planner/engine.js (meetingArea, about line 360, and routedMinutes), backend/src/services/travel-times.js, backend/tests/onemap-limits.test.js, backend/tests/plan-routes.test.js.

Already done, if these files exist (check): backend/tests/meeting-area-baseline.test.js with its fixture of 44 requests, recorded from main before any source change; and in plan-schemas.js the two request fields with their bounds (MAX.alternatives, MAX.includedAreas; an unknown or repeated area id is refused). The baseline fixture must never be regenerated to make a failing case pass. If the files are missing, write the baseline test FIRST, against unchanged code, covering: routing off; routing on through stub HTTP; each method; an opted-out member; overrides; 30 members against the cap; a routing failure; the 400 answers.

Build: on POST /api/meeting-area, optional alternatives (integer 0 to 3, default 0), how many runners-up to return, and include (up to 8 area ids), areas to evaluate whatever their rank. The answer gains candidates: the chosen area first, each { area, worstMinutes, meanMinutes, travelByMember, approximate, source } with source 'ranked' or 'included'. Both bounds live in the MAX block. An unknown area id answers 400.

What is known about the code (check it, do not re-derive it): meetingArea() is synchronous; for method station it sorts areas by distance from the fairest point, keeps maxCandidates, and picks the best by longest trip, then fairness-weighted mean. The other methods compute a centre point, measure travel to it, and name it after the nearest area; the frontend sends centroid when the demo's "routing off" switch is set, so candidates must make sense for those methods too. With routing on, plan.js tries the 16 nearest areas and gives real routes to the best 5 by estimate; the engine runs twice, a dry run that groups trips into candidates by area id, then a real run; the cap of 60 takes whole candidates only, and with 30 members only two areas fit. approximate today is one flag for the chosen result. Validation errors on this router answer { error: 'invalid_input', issues: [...] } through invalid(); do not invent another shape, and paste the real 400 body in your report.

Defaults for what the contract leaves open (keep them, or say why not): alternatives: n returns the chosen area plus up to n runners-up, in the engine's own order. For the non-station methods, candidates[0] mirrors the top-level answer and runners-up are areas ranked by the station rule, leaving out the chosen area. An included area that is also the chosen area or a returned runner-up appears once, with source 'ranked'; included areas follow the ranked ones, in the order sent. A duplicate id is a 400. An included area is evaluated even outside the 16 nearest. approximate on each candidate means what the top-level flag means for the chosen one. Every candidate's numbers come from the same run as the top-level answer, so candidates[0] equals the top-level area, worstMinutes, meanMinutes, travelByMember and approximate. Decide the order in which areas get real routes under the cap (the chosen and the runners-up matter more than a far included area, but an included area should get real routes when there is room) and explain it in the docs and your report.

Must stay true: a request without the new fields gets the answer it gets today, byte for byte, and candidates does not appear in it. One request routes at most 60 OneMap trips, whole candidates only; an area that does not fit is estimated and flagged approximate; no OneMap call bypasses the cap or createOneMap's budget. The Google Places pull request (peachoolongtee/jio#91, not merged) also adds to plan.js, the MAX block, planner-api.md, onemap-limits.test.js and plan-routes.test.js: do not reformat, reorder or rename existing lines, keep your MAX entries directly after members: 30, and prefer a new test file over editing the shared ones. Comments are sentence case, and every function you add carries a "How to call" example.

Tests: bounds (alternatives negative, 4, a float, a string; include with 9 ids, a duplicate, an unknown id, a non-string); the chosen area is candidates[0] and equals the top-level answer; an included area appears even when it ranks last, with source 'included'; runners-up are in order and never repeat the chosen area; route calls for 30 members with alternatives: 3 and 8 included areas stay at or under 60, counted with stub HTTP the way onemap-limits.test.js counts them (report the number); a candidate that did not fit the cap is flagged approximate and a fully routed one is not; the whole backend suite passes, and passes again with outbound calls blocked (section 10 of the handoff has the guard script). Baseline on main: pnpm test 383 passed, 1 skipped, 20 files. No existing test may be deleted, skipped or weakened.

Docs: update backend/docs/planner-api.md for the new request fields, the response field, the limits and the routing order.

Report: what changed, file by file; real test counts for both runs, pasted; the route-call count at the widest setting; the exact 400 body for an unknown id; each default you kept or changed and why; anything in this brief that was wrong for the code and what you did instead; anything you did not verify.
```

### Brief for slice 2 (paste, then adjust the paths)

```text
You are adding meeting spots to the local data layer of Jio's frontend (Vue 3.5, Pinia, vitest 3; pnpm only). Jio decides where a group should meet, fairly. All data is one object in local storage behind frontend/src/lib/api.js. This is tracker ticket peachoolongtee/jio#95.

Where to work: the repository root, on branch feat/meeting-spots. You may change frontend/src/lib/, frontend/src/stores/ and their tests, and nothing else. No view or component changes: another agent builds the screens on top of your functions afterwards, from your real signatures. Another agent may be editing backend/ in the same checkout: do not touch backend/, run no git command that changes the tree or index, and do not run the backend suite. Never read or print a .env file.

Read first: CLAUDE.md, CONTEXT.md (meeting spot, suggestion, works for me, known place), docs/handoffs/meeting-spots-and-roam.md sections 4, 6 and 7, then frontend/src/lib/api.js in full (createSession, membersFor, computeMeeting, applyTrigger, useMeetingArea, optOut, startSession, syncOptions, hasShape, VERSION, orUndo, touch, summary, publicLocations), frontend/src/lib/plannerApi.js, the planning helpers api.js imports as P (recalculate, meetingResultLine), frontend/src/lib/homeMeetups.js, frontend/src/stores/events.js, and the tests beside them (note how they stand in for the planner, and frontend/src/lib/__tests__/api.backend.test.js, which builds the real backend app with stub HTTP).

Build the data layer contract in section 7, spots only: the spots field on a session, suggestSpot, withdrawSpot, approveSpot, confirmSpot, setKnownPlace, and the two new meeting.method values. Names are proposals; keep them unless something is clearly better, and report final signatures. Roam's functions and proposals are a later slice: do not build them.

The rules, from the lead's decisions (settled; do not reopen): a spot is an area from the app's list; the app lists up to three, fairest first, and each member may add one; every spot carries the longest trip, the average and each person's minutes, exactly alike for the app's and a member's. "Works for me" is approval voting: any number of spots per member, no order, no points. The host confirms, at any time, whether or not anyone approved; the spot with the most approvals is preselected, and a tie goes to the shortest longest trip. One suggestion per member at a time, and suggesting again replaces it; here: true is only a label and any member may set it. setKnownPlace replaces the whole list, sets the meeting area and moves to voting; members can still add where they start afterwards, which only adds travel times. A changed start works out the app's suggestions and every spot's travel times again; approvals for a spot still listed are kept, approvals for a spot that dropped out are removed, and a banner says so, the way "Votes for places were cleared." does today. The status stays locating until the host confirms. Nothing in spots may carry a member's label or coordinates.

What is known about the code (check it, do not re-derive it): computeMeeting posts to /api/meeting-area through planner.meetingArea({ members, routing }); while locating it returns null until every active member has a start. There is no offline fallback: when the backend cannot be reached the planner call throws, orUndo puts the session back, and the caller gets the planner's message; give spots the same behaviour, and let writes that need no planner (approveSpot) work with the backend off. The backend half: POST /api/meeting-area takes optional alternatives (0 to 3) and include (up to 8 area ids) and then answers candidates: [{ area, worstMinutes, meanMinutes, travelByMember, approximate, source: 'ranked' | 'included' }], the chosen area first. alternatives: n means the chosen area plus up to n runners-up, so send alternatives: 2 for the app's three. An included area that is also ranked appears once with source 'ranked', so work out who suggested a spot from your own data. An answer with no candidates (an older backend) must still work: the list is then the one chosen area. Extend meetingArea in plannerApi.js additively; a call without the new arguments must post the body it posts today. VERSION is 8; a save with another version keeps the account and starts the rest fresh. The signed-in user's id is hard-coded (HOST_ID); follow it.

Defaults for what the contract leaves open (keep them, or say why not): spots is worked out as soon as P.MIN_LOCATIONS starts are in, with times for the members who have a start, while session.meeting keeps exactly today's meaning and timing during locating. setKnownPlace gives method 'chosen'; confirmSpot gives 'voted' when the confirmed spot has at least one approval, and with none keeps the planner's own method when the spot is the app's first suggestion and 'chosen' otherwise; P.meetingResultLine and anything else that reads method must say something true for the new values. useMeetingArea(id) keeps working as "confirm the preselected spot", and its existing tests pass unchanged. A known place with few or no starts: /api/converge requires every member to have a start or a home and membersFor sends only members with a start, so find out what ranking places needs when the host sets a known place before anyone has shared a start, make it work, and report how; from inviting, follow what startSession does about pending invites and the two-person minimum. One planner request per change, with members' suggestions in include (ticket #56 is about flooding the planner). In homeMeetups.js, nextStepFor: while locating with spots listed, a member who has approved nothing has an action and the host has "Confirm the spot"; keep every existing answer. Another branch (not merged) changes createSession's parameters and inviteFriends: do not change those two functions beyond the new field's starting value.

Tests, one each, named for the rule: any number of approvals per member; approving twice is one approval, and on: false removes it; one suggestion per member, a second replaces the first and drops the first's approvals; a suggestion equal to one of the app's spots does not list the area twice; only the host confirms (confirmSpot, setKnownPlace); the preselection is the most approved, and a tie goes to the shortest longest trip; the host can confirm with no approvals; a changed start recomputes travel times, keeps approvals for spots still listed, removes the rest and sets a banner that says so; opting out removes that person's suggestion and approvals; setKnownPlace works from inviting and from locating, lands on voting and replaces the list; a failed planner call rolls the whole write back; nothing is written once a session is completed or cancelled; approvals and suggestions are refused outside locating; an unknown area id is refused; nothing in spots or in what getSession returns carries a member's label or coordinates; a version-8 save loads and keeps the account; an answer without candidates gives a one-spot list. Stand in for the planner the way the existing tests do. You may add one test to api.backend.test.js that goes through the real backend app; if it fails only because the backend half is not finished, leave it in and say so.

Acceptance: pnpm --filter jio-frontend test passes (baseline on main: 324 passed, 30 files), with no existing test deleted, skipped or weakened, and the counts pasted before and after; pnpm build succeeds; the frontend suite passes with outbound calls blocked (section 10 of the handoff has the guard script). Comments are sentence case, and every function you add carries a "How to call" example.

Report: the functions and their final signatures, with what each returns and throws; the exact shape of spots and of what getSession now returns for it (the screens agent will be briefed from this); how the preselection is exposed; each default you kept or changed and why; every rule and the test that proves it; real test counts, pasted; anything in this brief that was wrong for the code and what you did instead; anything you did not verify.
```

### Brief for slices 3, 4 and 5

Write these when slice 2 is in, from its real function signatures. Each must name: the view it owns (`GroupDetailView.vue` for 3; `EventView.vue` and a routed `RoamView.vue` for 4; `LandingView.vue` and the create flow for 5) and the views it must not touch; `DESIGN.md` as required reading, with "Building a New Screen", "Known Conflicts" and the Home sections called out; the widths to measure (320, 375, 744, 1280 px); keyboard and screen-reader behaviour for every new control; reduced motion; what the demo tools and the showcase data need so each state can be reached in one click; and a headless-browser check with numbers in the report.

For slice 3, from `DESIGN.md`: a toggled choice ("Works for me") is filled with ink, not red; the host's "Confirm <area>" is the screen's one primary action and, because it moves to the next step, takes `next`; "Suggest a spot" is a quick pick beside a button, so it opens in a `PopoverPanel`; the list and the map go in the `SplitView` the screen already has; travel times say "about N min" and take the travel colours with a word beside them; add no new white text on the brand red.

### Review round (slice 6)

Run a `code-reviewer` on the data layer and backend, a `design-reviewer` on the screens, and a `verifier` told to break the rules in section 4 through the screens, all at once. Fix what they find, or ticket it and say so.

## 10. Things this project has already learned

None of these can be found by reading the code.

- **Build the interaction the lead describes, not a near neighbour.** Asked for a popup at the location on the map, an earlier round built a card under the map and had to redo it. Restate the interaction in the brief in the lead's words.
- **More than one session can be working in one checkout.** On 2026-10-11 another session was editing the main checkout while this work began, so this branch was given its own git worktree and that tree was left alone. Before switching branches anywhere, look at `git status` and at how recently the changed files were written.
- **Ports on the first machine.** 3000 is another project. 5173 is the lead's own Jio dev server and serves the working tree, so the lead sees uncommitted work live. Run your own previews on other ports (earlier rounds used 3101 for the backend and 5174 for the frontend, with `VITE_API_BASE_URL` empty and `JIO_BACKEND_URL` pointing at the backend). A temporary `.claude/launch.json` is fine; delete it after. A new machine may differ: check what is listening before choosing.
- **The lead's `frontend/.env` on the first machine points the planner at port 3000**, which is the other project. That is theirs to change; say it when a "planner unavailable" message confuses a check.
- **Both `.env` files are git-ignored**, so a new machine has none until they are copied or made from the `.env.example` files. The test suites need neither.
- **When the browser pane is not on screen**, screenshots and hover fail and transitions do not advance. Measure the page (bounding boxes, computed styles, dispatched pointer events) and say that is what you did.
- **Prove the backend suite runs offline.** Save this as a `.cjs` file outside the repo and run `NODE_OPTIONS="--require <path>" pnpm test`; a line starting `BLOCKED_OUTBOUND` is a test reaching the network. In PowerShell, set the variable first: `$env:NODE_OPTIONS = "--require <path>"`, then `pnpm test`, then clear it.

  ```js
  // Fails any fetch that leaves this machine, and says so, to prove a test suite runs offline.
  const real = globalThis.fetch
  globalThis.fetch = (input, init) => {
    const url = String(typeof input === 'string' ? input : input?.url ?? input)
    if (!/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/.test(url)) {
      process.stderr.write(`BLOCKED_OUTBOUND ${url.split('?')[0]}\n`)
      return Promise.reject(new TypeError('fetch failed (blocked by the offline guard)'))
    }
    return real(input, init)
  }
  ```

- **One frontend test file builds the real backend app** (`frontend/src/lib/__tests__/api.backend.test.js`) with stub HTTP. A change to a planner route's answer can fail a frontend test.
- **The frontend sends `weatherCase` on every ranking**, which is why the backend ignores it when simulation is off and never refuses it. Do not "fix" either side alone.
- **The signed-in user's id is hard-coded** (`HOST_ID`, `'ian'`) across the frontend. It is a known issue; follow it, do not fix it here.
- **Git, under the permission mode this project runs in:** a direct push to `dev` is refused, so `dev` is brought level with a pull request from `main`. Merging a teammate's pull request is refused until a review has been posted on it. The lead's own pull requests into `main` merge normally. Do not work around a refusal; report it.
- **Commits** happen only when the lead asks, as sequential commits with plain lowercase messages and no prefixes.
- **Two decisions that look like bugs and are not:** the brand red `#ff385c` fails contrast with white text and stays by the lead's choice, so add no new white-on-red text; "Sample" notes were partly removed by the lead's choice, so add and remove none. Both are in `CLAUDE.md`.

## 11. Verification before calling it done

- [ ] Each rule in section 4 has a test, and a verifier has tried to break it through the screens.
- [ ] `pnpm test`, `pnpm --filter jio-frontend test` and `pnpm build`, with real counts recorded in `CLAUDE.md`.
- [ ] The backend suite passes with outbound calls blocked.
- [ ] Old requests to `/api/meeting-area` answer exactly as before: the baseline test passes on the branch and on an untouched `main`.
- [ ] OneMap route calls for one request stay at or under 60 at the widest new settings.
- [ ] No horizontal overflow at 320, 375, 744 and 1280 px on the Locate, Itinerary, Roam and Home screens.
- [ ] Every new control is reachable and operable by keyboard, and has a name a screen reader can say.
- [ ] The steps bar sits at the same height on every session screen and does not fade between them.
- [ ] A save from before this feature still loads.
- [ ] `DESIGN.md` describes the new components; `CONTEXT.md` has the new words; the showcase data includes a session in the spot vote and one with a Roam proposal.
- [x] The schema this will need is written on ticket #80, and the live database is untouched.
- [ ] What was not verified is written down, in the work log and in the report to the lead.

## Appendix A: text to restore if the branch was not pushed

### `CONTEXT.md`: replace the heading line `### Roam` (under `## Language`) with

```markdown
### Meeting spots

**Meeting spot**:
An area the group could meet in, listed on the Locate step with everyone's travel time to it. The app lists up to three; each member may add one.
_Avoid_: Candidate, option (an option is a place in the later vote), venue

**Suggestion**:
A meeting spot a member added. A member has one at a time; a second replaces the first. Marked "we are here already" when the member is there now.
_Avoid_: Nomination, pin

**Works for me**:
A member's approval of a meeting spot. A member may approve any number of spots; there is no order and no score. Approvals advise the host, who confirms.
_Avoid_: Vote (a vote is for a place), like, upvote

**Known place**:
A meeting area the host sets directly because the group has already decided where to meet. It skips the spot list and goes straight to choosing what to do.
_Avoid_: Fixed location, skip mode

### Roam

**Roam**:
The list of things to do near where the group already is. On screen it is "What next?" inside a meetup that is under way, and "Already out? Find something nearby" on Home, which starts a light meetup with no location step.
_Avoid_: Explore, discover

**Proposal**:
A place from the Roam list that a member puts forward as the next stop. It becomes a stop only when the host accepts it.
_Avoid_: Suggestion (that is a meeting spot), request
```

The three entries already under Roam (Stop, Current point, Single-origin event) stay below these.

### `docs/agents/work-log.md`: add at the end

```markdown
## Round 12: meeting spots the group suggests and votes on, slices 1 and 2 (2026-10-11)

Parent task: the lead settled the decisions on 2026-10-11 (the table is on the tracker ticket "Meeting area answers with runners-up and named areas", peachoolongtee/jio#94) and asked for the feature in `docs/handoffs/meeting-spots-and-roam.md` to be built on a separate branch. Tickets #94 to #99 sit under the wayfinder map, with their blocking edges.

Work is on branch `feat/meeting-spots`, cut from `main` at `5b975c2`. Neither piece of work the handoff wanted in first had landed: the Google Places pull request (peachoolongtee/jio#91) was open, and the showcase was uncommitted. Both overlap this round's files and will need a merge.

Baseline before any change: `pnpm test` 383 passed, 1 skipped, 20 files; `pnpm --filter jio-frontend test` 324 passed, 30 files; `pnpm build` succeeded.

| # | Role | Scope | May change | Acceptance criteria | Status |
|---|---|---|---|---|---|
| 12.1 | Backend | `alternatives`, `include` and `candidates` on `POST /api/meeting-area` (ticket #94) | `backend/` only | Old requests answer exactly as before; bounds tested; at most 60 route calls with 30 members, 3 alternatives and 8 included areas; suite passes with outbound calls blocked; docs updated | **Stopped part-way** when the lead paused the work: the baseline test and the two request fields exist; the engine and route are unchanged |
| 12.2 | Frontend | Spots, approvals, confirm, known place and the version bump in the local data layer (ticket #95) | `frontend/src/lib/`, `frontend/src/stores/` and their tests | One test per rule in the decisions; an old save loads; frontend suite and build pass; no existing test deleted, skipped or weakened | **Stopped before any change** |
| 12.3 | Lead | Tickets, `CONTEXT.md`, verify both reports, record results | Docs and the tracker | Both suites and the build run by the lead; the riskiest claim in each report read in the code | Tickets, glossary and the schema note on #80 done; nothing verified yet |
```
