# Handoff: meeting spots the group votes on, and Roam

Written 2026-10-11 by the lead's orchestrating agent, for a fresh session that has none of the earlier conversation. Everything a new session needs is here or behind a pointer from here.

## 1. How to start the fresh session

Open a new session in `/Users/ianpong/Projects/jio` and paste this:

```text
You are the lead orchestration agent for Jio. Read CLAUDE.md, then docs/handoffs/meeting-spots-and-roam.md in full, then DESIGN.md.

Build the feature in that handoff: meeting spots the group suggests and votes on, a host shortcut for a place that is already decided, and Roam. The product decisions are settled in section 3; do not reopen them. Section 4 holds the one question still open; ask me that first, and carry on with slice 1 while you wait.

Work as section 8 describes: delegate each slice to a subagent with a full brief, log the round in docs/agents/work-log.md before delegating, check every claim yourself before you accept it, and record real results. Start with section 7's "Before any slice". Do not commit or push until I ask.
```

## 2. What is being built, in three sentences

Today Jio works out one meeting area from where everyone starts and the host confirms it. The lead wants that step to be communal: the app suggests fair spots, members suggest their own, everyone says which ones work for them, and the host settles it. Roam, which suggests things to do near where a group already is, exists only in the backend; it gets its first screens.

## 3. Decisions, settled by the lead on 2026-10-11

The lead was asked eleven questions and took the recommended answer to each. Question 11 had no recommendation and is in section 4.

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

In the lead's own words: "I want to make it like a communal thing where people can also suggest meetup spots, and people can take a vote accordingly", "for the decisions, I think the host can", members are "still asked where they're starting from", and for Roam "we assume that they are already at a common location, so it will be suggesting things around the vicinity".

### What follows from the decisions (the orchestrating agent's reading, not the lead's words)

- **One flow, no mode switch.** Converge and Roam differ in one step. The session keeps its five steps (Create, Invite, Locate, Vote, Itinerary) and its statuses. The spot vote lives inside Locate: the status stays `locating` until the host confirms a spot, then becomes `voting` as today.
- **Approval voting, not ranking.** A member may mark any number of spots. No ordering, no points.
- **Ties** in the preselection go to the spot with the shortest longest trip, which is the app's existing fairness rule.
- **Limits.** Three suggestions from the app. One suggestion per member at a time; suggesting again replaces it. The host's "already have a place" replaces the whole list.
- **A change undoes approvals honestly.** If a member's start changes, the app's suggestions and every spot's travel times are worked out again. Approvals for a spot that is still listed are kept; approvals for a spot that dropped out are removed, and a banner says so, the way "Votes for places were cleared" does today.
- **Privacy rule from `CLAUDE.md` still holds:** the group sees a member's area, never their exact place. "Use my location" in Roam shows the group the area's name only.

## 4. Open question for the lead

**Question 11: which parts must be in the graded demo, and by when?** Until answered, build in the order of section 7: the spot vote first (it is the part that makes Jio different), the host shortcut with it, Roam after.

Two smaller points to raise when they come up, each with a default so work does not stop:

- **A deadline for the spot vote?** Default: none. The host confirms when ready.
- **Can a member who is not the host use "we are here already"?** Default: yes, it is only a label on their suggestion.

## 5. What exists today (checked against `main` at `5b975c2`, 2026-10-11)

Read the code before relying on any line below; it is a map, and the code is the territory.

### Frontend

- **All data is local.** `frontend/src/lib/api.js` is the data layer every view and store goes through. It keeps one object in local storage under `jio-demo-v1`, with `VERSION = 8` and a shape check (`hasShape`). An older or malformed save keeps the account and starts the rest fresh, so a new session field needs a version bump.
- **A session** (`createSession`, about line 813) has: `id`, `title`, `date`, `start`, `end`, `hostId`, `status` (`inviting`, `locating`, `voting`, `confirmed`, `completed`, `cancelled`), `members[]`, `locations{}` (per person: `start` and `end`, each `{ areaId, label }`), `meeting` (one object, or null), `prefs`, `options`, `votes`, `plan`, `banner`, `replan`, `photos`, `radius`.
- **The meeting area today:** `computeMeeting(session)` (about line 300) calls `planner.meetingArea(...)`, which posts to the backend's `/api/meeting-area`. It runs when a location changes (`applyTrigger`) and stores one result in `session.meeting`. `useMeetingArea(id)` (about line 927) is the host's "Confirm location": it sets the status to `voting` and builds the place options. Find out what `computeMeeting` does when the backend is not running, and keep that behaviour.
- **The screen:** `frontend/src/views/GroupDetailView.vue` covers people, locations and the meeting area. It shows "Waiting for N people" with "Continue without <name>" for the host, a "Finding the meeting point" progress bar, a map with each person's start area and travel time, and a "Confirm location" button.
- **Steps bar:** `frontend/src/components/event/SessionSteps.vue` (`STEPS`, `reachedStep`, `viewingStep`, `stepsFor`). It sits above the title on every session screen and must not move or flicker between screens; see "Four fixes from use" in `DESIGN.md`.
- **Home:** `frontend/src/views/LandingView.vue` with `frontend/src/lib/homeMeetups.js`. `nextStepFor(session, myId)` decides the chip on each meetup ("Vote", "Waiting for 2 people" and so on). A new state in the session needs a new answer there.
- **Planner calls:** `frontend/src/lib/plannerApi.js` has `meetingArea`, `rankSlot` (posts to `/api/converge`) and `searchSlot`. There is **no Roam call**.
- **Roam:** `frontend/src/views/RoamView.vue` is an empty page headed "What next?" and has no route.
- **Location helpers already there:** `listAreas()`, `searchPlaces()`, `placeFromCoords()` in `api.js`.
- **Demo tools:** `frontend/src/components/dev/DemoPanel.vue` simulates friends' locations, votes and photos. A showcase of sessions in every state (`components/dev/showcase.js`) was being built on branch `feat/demo-showcase` when this was written; check whether it has landed.

### Backend

- **`POST /api/meeting-area`** returns **one** area: `area`, `centre`, `worstMinutes`, `worstMember`, `meanMinutes`, `travelByMember`, `approximate`, `travel`. It returns no runners-up and cannot be asked about a particular area. Section 6 changes that.
- **`POST /api/converge`** ranks places around a `centre`. **`POST /api/roam`** does the same around `current: { lat, lng }`; members need only an `id`; categories default to eat, drink and activity; results carry `travelMinutes` and `distanceKm`.
- **Docs:** `backend/docs/planner-api.md` (request and response for every route), `backend/docs/external-apis.md`.
- **OneMap is a shared budget:** at most 60 routed trips per request, whole candidates only, and 240 calls a minute for the whole server. A trip over either limit uses an estimate and is flagged `approximate`. Asking about more areas costs members × areas trips, so the new inputs need bounds and must go through the same cap.
- **Every planner input has an upper bound** in the `MAX` block of `backend/src/routes/plan-schemas.js`.

### Database (live, but no app code reads or writes it yet)

- `sessions.meeting_area_id` and the other `meeting_*` columns are **server-only writes**; the trigger `guard_session_changes` enforces it. `meeting_method` may only be `same`, `fairest` or `centre`.
- There is no table for suggested spots or approvals.
- **Do not change the live database for this feature.** The frontend is still local. Write down the schema this feature will need (section 6) on ticket #80, where the session endpoints are designed, and stop there.

## 6. Design

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
6. The map shows every spot as a pin; selecting a row selects its pin and the reverse. Follow Home's pins (`components/home/MeetupPins.vue`) and their hover card, and read section 9 on that.

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
proposals: [{ id, venueId, by: '<personId>', at }]      // Roam proposals waiting for the host

// New functions:
suggestSpot(id, personId, areaId, { here = false })      // replaces that person's earlier suggestion
withdrawSpot(id, personId)
approveSpot(id, personId, areaId, on)                    // any member, while locating
confirmSpot(id, areaId)                                  // host only; takes over from useMeetingArea
setKnownPlace(id, areaId)                                // host only; from inviting or locating straight to voting
roamNearby(id, { point?, categories? })                  // the list; point defaults to the meeting area
proposeStop(id, personId, venueId)                       // any member, session under way
resolveProposal(id, proposalId, accept)                  // host only
startRoam({ areaId | point, title? })                    // Home's entry: the light meetup
```

Bump `VERSION`, extend `hasShape`, and keep `useMeetingArea` working as "confirm the top spot" until every caller has moved.

### Backend contract (slice 1)

`POST /api/meeting-area` gains, with nothing changing when the new fields are left out:

- Request: `alternatives` (0 to 3, default 0): how many runners-up to return. `include` (up to 8 area ids): areas to evaluate whatever their rank.
- Response: `candidates: [{ area, worstMinutes, meanMinutes, travelByMember, approximate, source: 'ranked' | 'included' }]`, the chosen area first.
- Both bounds go in the `MAX` block. The 60-trip cap is unchanged: an included area that cannot be routed inside the cap is estimated and flagged.
- An unknown area id is a 400 in the flat error shape.

### Schema for later (record on ticket #80; do not apply)

A `session_spots` table (session, area, suggested by, here flag), a `spot_approvals` table (session, area, member), a `stop_proposals` table, and two more values for `meeting_method` (`voted`, `chosen`). Confirming a spot and resolving a proposal are server writes, like the meeting area today.

## 7. Slices, in order

### Before any slice

1. `git fetch`, then check what has landed: `gh pr list`, `git log --oneline -15 origin/main`. Two pieces of work were in flight on 2026-10-11: the Google Places pull request (peachoolongtee/jio#91) with its audit fixes, and branch `feat/demo-showcase` (Home's "Plan a new meetup" row and the showcase data). Build on `main` once both are in; ask the lead if either is not.
2. Start a branch from `main`, for example `feat/meeting-spots`.
3. Open tickets on the tracker for the slices below, under the wayfinder map (issue #1); see `docs/agents/issue-tracker.md`. Put section 3's table in the first ticket so the decisions live on the tracker.
4. Add the new words to `CONTEXT.md`: **meeting spot**, **suggestion**, **works for me**, **known place**, **proposal**, and say what **Roam** now means on screen.
5. Add the round to `docs/agents/work-log.md`.

### The slices

| # | Slice | Owner | Depends on | Done when |
|---|---|---|---|---|
| 1 | Backend: `candidates`, `alternatives` and `include` on `/api/meeting-area` | Backend agent | Nothing | Old requests answer exactly as before; bounds tested; route calls per request at or under 60 with 30 members, 3 alternatives and 8 included areas; docs updated |
| 2 | Data layer: spots, approvals, confirm, known place, version bump | Frontend agent | The contract in section 6, not slice 1's code | Unit tests for every rule in section 3 and "What follows"; works with the backend off; old saves load |
| 3 | Locate screen: the list, "Works for me", "Suggest a spot", host confirm, known place, map pins, Home's chips, demo tools | Frontend agent | 2 | Measured at 320, 375, 744 and 1280 px; keyboard reaches every control; steps bar does not move |
| 4 | Roam inside a meetup: the planner call, "What next?", the list, proposals, host confirm | Frontend agent | 2 | A proposal becomes an itinerary stop only after the host accepts; works with the backend off or says plainly that it cannot |
| 5 | Roam from Home: the entry, the light meetup, "Use my location" | Frontend agent | 4 | Location refused or unavailable falls back to picking an area; the group sees an area name only |
| 6 | Review and record | Reviewers, then the lead | 3, 4, 5 | Findings fixed or ticketed; `DESIGN.md`, `CLAUDE.md`, work log and showcase data updated |

Slices 1 and 2 can run at the same time. Slices 3 and 4 touch different views and can run at the same time once 2 is in, if each is told which files are the other's.

## 8. How to delegate

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

### What every brief carries

Objective; context the agent cannot see (it knows only what the brief says); the files it may change and the ones it must not; the rules that bind it, by pointer to `CLAUDE.md` and `DESIGN.md`; the output wanted; acceptance criteria that can be checked. Tell it what you have already ruled out. Tell it to say so when the brief is wrong for the codebase, not to follow or skip it silently. Ask for real output, pasted.

### What to do with a report

- Run the suites yourself: `pnpm test`, `pnpm --filter jio-frontend test`, `pnpm build`. Record the counts with the date in `CLAUDE.md`'s table.
- Read the changed code for the riskiest claim in the report.
- Open the screen yourself where you can, and say plainly what you did not see.
- A review that confirms your own view is weak evidence. Give reviewers the code and the claims, never your conclusion.

### Brief for slice 1 (paste, then adjust)

```text
You are adding runners-up and named areas to one route of Jio's planner backend (Express 4 on Node 24, zod, vitest; pnpm). Work in /Users/ianpong/Projects/jio on the current branch. Do not commit or push. Do not touch frontend/, db/, CLAUDE.md or docs/agents/. Never read or print a .env file. Never call the real OneMap, Google or data.gov.sg services: tests use stub HTTP.

Read first: CLAUDE.md (Working Rules, Architecture Decisions), docs/handoffs/meeting-spots-and-roam.md sections 5 and 6 ("Backend contract"), backend/docs/planner-api.md ("POST /api/meeting-area", "Travel times", "Limits"), backend/src/routes/plan.js, backend/src/routes/plan-schemas.js (the MAX block), backend/src/services/travel-times.js, backend/tests/onemap-limits.test.js.

Build: on POST /api/meeting-area, optional `alternatives` (integer 0 to 3, default 0) and `include` (up to 8 area ids), and in the answer `candidates`, the chosen area first, each with area, worstMinutes, meanMinutes, travelByMember, approximate and source ('ranked' or 'included'). An unknown area id answers 400 in the flat shape { error, message }.

Must stay true: a request without the new fields gets the answer it gets today, byte for byte, for a fixed set of requests (write that test first, against the current code). One request routes at most 60 OneMap trips, whole candidates only; an area that does not fit is estimated and flagged approximate. Both bounds live in the MAX block.

Tests: bounds (negative, 4, a float, a string; 9 ids, a duplicate id, an unknown id); the chosen area is candidates[0] and equals `area`; an included area appears even when it ranks last; route calls for 30 members with 3 alternatives and 8 included areas stay at or under 60, counted with stub HTTP; the whole suite passes with outbound calls blocked (section 9 of the handoff has the guard script).

Report: what changed, file by file; real test counts for both runs; the route-call counts; the docs you updated; anything in this brief that was wrong for the code and what you did instead.
```

### Brief for slice 2 (paste, then adjust)

```text
You are adding meeting spots to the local data layer of Jio's frontend (Vue 3.5, Pinia, vitest 3; pnpm). All data is one object in local storage behind frontend/src/lib/api.js. Work in /Users/ianpong/Projects/jio on the current branch. Do not commit or push. Change only frontend/src/lib/, frontend/src/stores/ and their tests. No view or component changes: another agent builds the screens on top of your functions. Never read or print a .env file.

Read first: CLAUDE.md, docs/handoffs/meeting-spots-and-roam.md sections 3, 5 and 6, then frontend/src/lib/api.js in full (createSession, computeMeeting, applyTrigger, useMeetingArea, optOut, hasShape, VERSION, orUndo, touch), frontend/src/lib/plannerApi.js, frontend/src/lib/homeMeetups.js, frontend/src/stores/events.js, and the tests beside them.

Build the contract in section 6 ("Data layer contract"): suggestSpot, withdrawSpot, approveSpot, confirmSpot, setKnownPlace, with the rules in section 3 and "What follows from the decisions". The app's three suggestions come from POST /api/meeting-area with alternatives: 3 and include: [the members' suggested area ids]; the backend half is being built at the same time, so code to the contract and find out what computeMeeting does today when the backend is not running, then give spots the same fallback. Bump VERSION and extend hasShape; an old save must still load. Keep useMeetingArea working (it confirms the preselected spot). Extend nextStepFor in homeMeetups.js: a member who has approved nothing has an action; the host with a preselected spot has "Confirm the spot".

Rules to prove with tests, one test each: approvals are any number per member; one suggestion per member, a second replaces the first and drops its approvals; only the host confirms; the preselection is the most approved and a tie goes to the shortest longest trip; a changed start recomputes travel times, keeps approvals for spots still listed, removes the rest and sets a banner that says so; opting out removes that person's suggestion and approvals; setKnownPlace works from inviting and from locating and lands on voting; a failed save rolls back (follow orUndo); nothing is written once a session is completed or cancelled.

Acceptance: pnpm --filter jio-frontend test passes with none of the existing tests deleted, skipped or weakened (paste the counts, before and after); pnpm build succeeds; the frontend suite passes with outbound calls blocked.

Report: the functions and their final signatures; the fallback you found and used; every rule and the test that proves it; anything in this brief that was wrong for the code and what you did instead.
```

### Brief for slices 3, 4 and 5

Write these when slice 2 is in, from its real function signatures. Each must name: the view it owns (`GroupDetailView.vue` for 3; `EventView.vue` and a routed `RoamView.vue` for 4; `LandingView.vue` and the create flow for 5) and the views it must not touch; `DESIGN.md` as required reading, with "Building a New Screen", "Known Conflicts" and the Home sections called out; the widths to measure (320, 375, 744, 1280 px); keyboard and screen-reader behaviour for every new control; reduced motion; what the demo tools and the showcase data need so each state can be reached in one click; and a headless-browser check with numbers in the report.

### Review round (slice 6)

Run a `code-reviewer` on the data layer and backend, a `design-reviewer` on the screens, and a `verifier` told to break the rules in section 3 through the screens, all at once. Fix what they find, or ticket it and say so.

## 9. Things this project has already learned

None of these can be found by reading the code.

- **Build the interaction the lead describes, not a near neighbour.** Asked for a popup at the location on the map, an earlier round built a card under the map and had to redo it. Restate the interaction in the brief in the lead's words.
- **Ports, and the lead's own servers.** The lead runs their own servers from this folder: the frontend on 5173 and, on 2026-10-11, the Jio backend on 3000 under `node --watch` (on other days port 3000 has held a different project). Both serve the working tree, so the lead sees uncommitted work live, and their `frontend/.env` points the planner at port 3000. Run your own previews on other ports (earlier rounds used 3101 for the backend and 5174 and up for the frontend, with `VITE_API_BASE_URL` empty and `JIO_BACKEND_URL` pointing at your backend). A temporary `.claude/launch.json` is fine; delete it after.
- **Stop only the processes you started, by their process id.** An agent cleaning up with `pkill -f "node src/index.js"` also stopped the lead's backend on port 3000. Put this sentence in every brief that lets an agent start a server.
- **When the browser pane is not on screen**, screenshots and hover fail and transitions do not advance. Measure the page (bounding boxes, computed styles, dispatched pointer events) and say that is what you did.
- **Prove the backend suite runs offline.** Save this as a file outside the repo and run `NODE_OPTIONS="--require <path>" pnpm test`; a line starting `BLOCKED_OUTBOUND` is a test reaching the network.

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

## 10. Verification before calling it done

- [ ] Each rule in section 3 has a test, and a verifier has tried to break it through the screens.
- [ ] `pnpm test`, `pnpm --filter jio-frontend test` and `pnpm build`, with real counts recorded in `CLAUDE.md`.
- [ ] The backend suite passes with outbound calls blocked.
- [ ] Old requests to `/api/meeting-area` answer exactly as before.
- [ ] OneMap route calls for one request stay at or under 60 at the widest new settings.
- [ ] No horizontal overflow at 320, 375, 744 and 1280 px on the Locate, Itinerary, Roam and Home screens.
- [ ] Every new control is reachable and operable by keyboard, and has a name a screen reader can say.
- [ ] The steps bar sits at the same height on every session screen and does not fade between them.
- [ ] A save from before this feature still loads.
- [ ] `DESIGN.md` describes the new components; `CONTEXT.md` has the new words; the showcase data includes a session in the spot vote and one with a Roam proposal.
- [ ] The schema this will need is written on ticket #80, and the live database is untouched.
- [ ] What was not verified is written down, in the work log and in the report to the lead.
