# End-to-end tests

Playwright drives a real Chromium through the app. Each teammate writes two tests here. The example to copy is `create-session.spec.js`; the shared set-up is `fixtures.js`; the servers and settings are in `../../playwright.config.js`.

## Once per machine

```bash
pnpm install
pnpm --filter jio-frontend exec playwright install chromium
```

## Run

Run these from the repo root. Nothing else needs to be running: the config starts a stub backend on port **3994** and the frontend on port **5194**, and stops them when the run ends.

```bash
pnpm test:e2e                                                  # all tests, headless
pnpm test:e2e tests/e2e/create-session.spec.js                 # one file
pnpm test:e2e -g "creates a session"                           # tests whose title matches
pnpm test:e2e --headed                                         # watch the browser
pnpm test:e2e --ui                                             # UI mode: pick tests, step through, time-travel
pnpm test:e2e --repeat-each=3                                  # a new test should pass three times in a row
```

If something is already listening on 3994 or 5194 the run reuses it, so close any server you started by hand there. Never use another port for these tests: 3000, 5173 and the like belong to your own dev servers.

## Write a test

1. Copy `create-session.spec.js` to `my-feature.spec.js`.
2. Import from `./fixtures.js`, never from `@playwright/test`:

   ```js
   import { test, expect, signInDemo } from './fixtures.js'

   test('what a person can now do', async ({ page }) => {
     await signInDemo(page)          // demo account, demo data reset, on Home
     await page.getByRole('link', { name: 'Jio your friends' }).click()
     await expect(page.getByRole('heading', { level: 1, name: 'Create session' })).toBeVisible()
   })
   ```

3. Find things by role and accessible name (`getByRole`, `getByLabel`, `getByText`), the way a person or a screen reader does. No CSS classes, no coordinates. If a control has no usable name, that is an accessibility bug: fix the app, not the test. Use `exact: true` when a name is a prefix of another ("Next" and "Next month").
4. Do not sleep. `expect(...)` and locators wait on their own.

What `fixtures.js` gives you:

| Name | What it does |
|---|---|
| `test`, `expect` | Playwright's, with a fresh browser context per test (its own local storage, so tests never share demo data), the network guard and the fixed clock. |
| `signInDemo(page, { showcase })` | Opens the app, signs in as the demo account (Ian, with friends Darius, Jonathan, Nicole, Faith and Darryl), clears its meetups and ends on Home. `{ showcase: true }` keeps ten sample sessions, one in each state, instead (a few seconds longer). |
| `openDemoTools(page)`, `resetDemoData(page)` | The "Demo tools" sheet that acts for friends (simulate their locations and votes, and so on), and its "Reset demo data". The sheet only exists in development builds, which is what the tests run on. |
| `setTime(page, 'Start time', '14:00')` | Types a time into a time field. |
| `dayName('2026-11-07')`, `daysAhead(3)` | The accessible name of a day in the date picker; a day counted from the fixed "today". |
| `useScenario(page, 'rain')` | Picks a stub backend scenario for the test (see below). |
| `FIXED_NOW` | The fixed time, as a `Date`. |
| `createSession(page, { title, day, start, end })` | From Home, makes a session through the form and ends on its Start choice ("How do you want to pick the meeting point?", which comes before inviting). Answers the session's id. The form's own times are three hours long, which holds only three of the four kinds of stop: pass `end` for a longer day if a test needs all four. |
| `inviteAndStart(page, ['Darius', 'Nicole'])` | From the Start choice: keeps "Find the fairest spot" and presses Next, which opens Invite; invites the friends, waits until they have joined, presses Start session and ends on the Locate step. |

### The clock

Every test starts at **Wednesday 4 November 2026, 10:00 in Singapore**, and the browser runs in the `Asia/Singapore` time zone. Time still moves on from there, so animations and timers work. Use `daysAhead(n)` for a day a few days away, so the test never depends on the real date. To start at another time for a file or a group of tests:

```js
test.use({ fixedNow: new Date('2026-12-24T14:00:00Z') })   // 22:00 in Singapore
test.use({ fixedNow: null })                                // the real clock; avoid
```

### Stub scenarios

The stub backend answers the planner from fixtures. A request header picks the scenario: `rain` (heavy showers everywhere) or `routing-fail` (travel times become estimates). `useScenario` adds that header to the page's calls to the backend:

```js
await useScenario(page, 'rain')   // before the page makes the call, usually before signInDemo
```

The demo account's Home and data layer make no backend calls; the planner screens (meeting area, Vote, Roam, the weather on a stop) do. One thing to know: the stub backend runs on the real clock, and its forecast covers the next 24 hours from now, so a stop on the fixed day in the browser (4 November 2026 and later) has no weather. See "Testing from Playwright" in `backend/docs/planner-api.md`.

## Allocation

Each teammate owns one file with two tests. `create-session.spec.js` is the example to copy and is not counted for anyone. Run one person's file with `pnpm --filter jio-frontend exec playwright test tests/e2e/<file>`.

| Person | Their two tests | File |
|---|---|---|
| Ian | Planning an outing end to end<br>Change the meeting place after voting | `ian.spec.js` |
| Faith | Set a start by searching: the group sees the area, not the place<br>The fairest spot is first, with each person's minutes | `faith.spec.js` |
| Nichole | Create refuses the past: a past day and a start that has already passed<br>Dates lock once a session starts | `nichole.spec.js` |
| darryl | A halal need reaches Vote and only fitting places are offered<br>The host replaces a confirmed stop and the times follow | `darryl.spec.js` |
| Darius | "Already out" on Create session starts a light meetup that shows on Home<br>Finishing an outing moves it from Home to Past | `darius.spec.js` |
| Jonathan | No sideways scroll on any page (one test for each of 320, 375, 744, 1280 and 812 by 375 px)<br>Create a session using only the keyboard | `jonathan.spec.js` |
| (example) | The demo account creates a session and lands on the Start choice | `create-session.spec.js` |

Jonathan's first test is one test for each width, so his file holds six tests in all.

## Unit and component tests

The course asks each person for 1 unit test and 2 component tests as well. These are existing tests in `frontend/src/lib/__tests__/` (Nichole's unit test is in `backend/tests/`), one person each, on that person's feature. A unit test mounts nothing; a component test mounts a real screen through `domless.js`. Run one with `pnpm --filter jio-frontend exec vitest run src/lib/__tests__/<file>`.

| Person | Unit | Component |
|---|---|---|
| Ian | `startChoice.test.js`: the two choices, the fairest spot the default | `startChoice.screen.test.js`: starts the session with the fairest spot saved in the same update<br>`changePlan.screen.test.js`: "fairest" changes the session and goes to Locate |
| Faith | `clash.test.js`: `findClash` names the meetup in the way | `clashScreens.test.js`: the clash dialog says what is wrong, with the way to the other meetup<br>`sessionsSpotsScreen.test.js`: Locate lists the spots with Vote and the host's one main action |
| Nichole | `backend/tests/cdc.test.js`: CDC matching by name or site, never by distance alone | `outingScreens.test.js`: the create form holds Next when the start has passed in Singapore<br>`outingScreens.test.js`: the create form holds Next for a session with no length (23:59) |
| darryl | `profileSessions.test.js`: Upcoming lists sessions still going, soonest first | `dietaryConfirm.test.js`: asks before taking off a need someone else has<br>`editProfile.test.js`: starts from the signed-in person and saves to Supabase |
| Darius | `outingLifecycle.test.js`: never finishes a confirmed plan by the clock; the person finishes it | `homeSettle.test.js`: Home leaves a confirmed outing past its end time open and unpaid until someone finishes it<br>`outingFlowFixes.test.js`: Finish outing goes on to the review page |
| Jonathan | `radioGroup.test.js`: arrow keys skip disabled radios | `outingScreens.test.js`: finishing alone goes on to "How was it?", which says it earned nothing<br>`outingFlowFixes.test.js`: "What next?" in place of the empty timeline |

## Tests never use real services

No test may reach Supabase, OneMap, Google, Gemini or data.gov.sg.

- The backend runs in stub mode (`STUB_EXTERNALS=1`), which answers from fixtures.
- Every secret is set to an empty string for both servers, so your own `.env` files (with real keys) are ignored. With no Supabase settings the app uses its local accounts, which is the demo account.
- The fixture blocks every request to a host other than `localhost` or `127.0.0.1`. OneMap map tiles are only blocked and counted (the map draws without them). **Anything else that tries to leave fails the test**, even if the test would otherwise pass, with the address in the message. If you see that failure, the app has tried to call a real service: do not allow it, ask in the team chat.

Because accounts are local, these tests cover the screens and the data layer's rules, not Supabase sign-in or shared sessions.

## Read a failure

A failed test keeps a screenshot and a trace in `frontend/test-results/` (git-ignored). The run prints the path. Open the trace:

```bash
pnpm --filter jio-frontend exec playwright show-trace test-results/<test-folder>/trace.zip
```

It shows each step with a before and after snapshot of the page, the console, and every network request, so you can see which step failed and what the page looked like. `pnpm --filter jio-frontend exec playwright show-report` opens the HTML report. To debug a single test, run it with `--debug`. `error-context.md` in the same folder describes the page as the accessibility tree, which is the view your `getByRole` locators see.

## CI

There is no CI step yet; Jonathan owns CI (#82). When it is added, it would run, after `pnpm install --frozen-lockfile` and the existing steps:

```bash
pnpm --filter jio-frontend exec playwright install --with-deps chromium
pnpm test:e2e
```

with `CI=1` set (the config then never reuses a server and forbids `test.only`), and `frontend/playwright-report/` and `frontend/test-results/` uploaded as artifacts when it fails.
