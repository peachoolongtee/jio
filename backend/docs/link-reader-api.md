# Link reader API (save places from a post)

A person pastes a link to a YouTube, TikTok, Instagram or Xiaohongshu post. The server reads it and answers with the **places in it**, whether each one is **open now**, and its **Google Maps match**. The frontend lets the person pick places and put them in a saved list.

**Status: backend only. Merged dark: present in the code and OFF unless the server is started with `LINK_READER=1`.** Nothing here is saved by the server: the routes are stateless. The saved list, and the reports below, are the frontend's and the database's job.

Code: `src/routes/links.js`, `src/services/link-reader.js` (the work), `link-source.js` (links, dates, freshness, the lists of allowed hosts), `post-reports.js` (report rules), `link-tools.js` (yt-dlp, development only), `link-browser.js` (Chrome, development only). Tests: `tests/link-reader.test.js` and `tests/link-reader-hardening.test.js`. Stub mode answers from `tests/fixtures/link-reader/`, so the frontend can build against it with no keys: start the server with `STUB_EXTERNALS=1 LINK_READER=1` and use `https://www.youtube.com/watch?v=stubVideo01`.

## Routes

All are under `/api`, JSON in and out, errors in the usual `{ error, message }` shape.

**Off by default.** Without `LINK_READER=1` none of the three routes exists: each answers **404** `{ "error": "not_found", ... }`, exactly like any unknown address. A screen must treat that 404 as "this server cannot read links" and not offer the feature (do not call `capabilities` expecting a 200 on every server). With `LINK_READER=1` but no `GEMINI_API_KEY`, `capabilities` answers 200 with `enabled: false`, and `read` and `refresh` answer **503** `{ "error": "link_reader_unavailable", "message": ... }`.

**Limits for one caller.** `read` is limited to 3 requests a minute, and `refresh` to 3 requests a minute (counted separately, by signed-in user or else address; `LINK_READER_PER_CALLER_PER_MINUTE`). Over the limit it answers **429** `{ "error": "rate_limited", "message": ... }` with a `Retry-After` header in seconds. Every request counts, a refused one too: a read that is answered from the cache, and a request with a bad body. Show "try again in a minute" and do not retry on a timer.

### `GET /api/links/capabilities`

What this server can read, so a screen offers only what works. Call it once.

```json
{ "enabled": true,
  "youtube": { "video": true, "description": true, "comments": true },
  "tiktok": { "video": false, "caption": true },
  "instagram": { "video": false, "caption": false },
  "xiaohongshu": { "video": false, "caption": false },
  "google": true }
```

(`tiktok`, `instagram` and `xiaohongshu` also carry `slides`: pages opened in Chrome, a development tool.) `enabled: false` means no `GEMINI_API_KEY`: `read` and `refresh` answer 503. `youtube.comments` is `false` unless the server has `LINK_READER_COMMENTS=1` (see "What goes to the AI").

### `POST /api/links/read`

Request: `{ "url": "<pasted link>", "centre": { "lat": 1.3, "lng": 103.84 } }`. `centre` is optional (a point in Singapore: the Google search leans towards it).

A link that cannot be read answers **400** with `error: "not_a_link"` or `"unsupported_site"`. Show the message. Only an `https://` link on a supported site, on the default port, naming one post, is readable: `http://` links, other ports, a login in the address, and a link to a site's home page, a profile, a channel, a feed, a playlist or a search are all `not_a_link` (a TikTok or Xiaohongshu short link such as `vt.tiktok.com/ZS.../` or `xhslink.com/o/...` is a post and is accepted). Everything else answers **200**, so check `status`:

| `status` | Meaning |
|---|---|
| `ok` | `places` holds what was found (it can be empty: say "no places found"). |
| `unreadable` | `reason` says why, `retryable` says whether trying again can help, `notes` holds sentences to show. Reasons: `ai_unavailable` (the AI is busy, over its budget, paused or not answering: retry in a minute), `busy` (this server is already gathering two other posts: retry in a moment), `post_unreadable` (the AI would not read this post: it may be private, removed, age-restricted or too long; not retryable, and the same link is not asked about again for 5 minutes), `site_not_supported`, `instagram_needs_video_tool` (needs a development tool this server does not have), `login_required` (the site showed a login or captcha: say it cannot be read), `nothing_to_read`. (`reader_off` is no longer answered by the route: a server without a Gemini key answers 503.) |

A read takes 10 to 40 seconds for a video. Show progress, and do not let the person press it twice. The same post read again is answered at once (`fromCache: true`): the AI's reading is kept for 6 hours. Its Google matches are kept for 10 minutes, the same time as Google's own answers, and are made once for that time: a second read makes no Google call, and the `centre` of the first read decides the bias for those 10 minutes.

`ok` response (shortened, real shape from stub mode):

```json
{ "status": "ok",
  "source": { "platform": "youtube", "key": "youtube:stubVideo01", "url": "https://www.youtube.com/watch?v=stubVideo01",
              "kind": "video", "how": "youtube", "postDate": "2026-09-20", "ageDays": 22, "commentsUsed": 2, "warning": null },
  "places": [ {
      "name": "Starlight Karaoke Box", "nameEnglish": "Starlight Karaoke Box", "locationHint": "9 Example Road, #05-01",
      "hasAddress": true, "tip": "Cheap on weekdays.", "commentNote": "A viewer says the queue is long on weekends.",
      "evidence": "speech", "confidence": 0.9, "status": "open",
      "availability": { "state": "open", "usableNow": true, "line": "" },
      "freshness": { "level": "fresh", "ageDays": 22, "postedAgo": "3 weeks ago", "warning": null },
      "match": { "placeId": "stub_text_01", "name": "Starlight Karaoke Box", "address": "...", "lat": 1.3046, "lng": 103.8318,
                 "rating": 4.1, "ratingCount": 12, "businessStatus": "OPERATIONAL", "category": "activity",
                 "nameMatches": true, "byNameOnly": false },
      "toSave": { "googlePlaceId": "stub_text_01", "name": "Starlight Karaoke Box", "tip": "Cheap on weekdays.",
                  "platform": "youtube", "postKey": "youtube:stubVideo01", "postUrl": "...", "postDate": "2026-09-20",
                  "readOn": "2026-10-12", "status": "open", "opensOn": null, "closesOn": null } } ],
  "notes": [], "google": { "source": "google", "matched": 1 }, "fromCache": false }
```

Fields to use:

- `source.how`: what was actually read: `youtube` (the video itself), `video` (downloaded or played in Chrome), `slides` (a photo post or carousel, opened in Chrome) or `caption` (text only: tell the person it is less complete). `notes` is a list of plain sentences about anything missing (no YouTube key, comments off, photo post). Show them.
- `source.warning`: a sentence when the whole post is old. `places[].freshness.warning` is the same per place. Show it under the place.
- `availability.usableNow`: **false means do not offer the place as a stop today.** `state` is `open`, `temporary_now`, `not_open_yet`, `ended` or `unverified` (a pop-up or "coming soon" with no dates: never treated as open). `line` is the sentence to show (empty when open).
- `match`: the Google place, or `null`. `nameMatches: false` means Google's place has a different name: show it as "Is this it?" and let the person confirm. `category` is the planner's (`food`, `drink`, `activity`, `shop`, `outdoor`).
- `google.source`: `google`, `off` or `unavailable` (the link reader's share of the Google calls is used up for this minute, or an outage). With `unavailable` the places still come back, without matches, and the next read tries again. At most 15 places are looked up on Google for one post and at most 15 searches are made for it, so a post that names more than 15 places comes back with the later ones unmatched.
- **Chains and branches.** A post that names only a chain ("Nozomi", "Peach Garden") has no address, so the match is a guess. `match.ambiguous: true` means Google has several branches: `match.alternatives` lists up to 4 others (`placeId`, `name`, `address`, `lat`, `lng`, `rating`, `ratingCount`). Show "Which branch?" with `match` first and the alternatives under it. `toSave.googlePlaceId` stays `null` until a person picks one (then save that branch's `placeId`). With `ambiguous: false` and `byNameOnly: true` there was only one listing, so it is a safe match, but still show the address.
- **No match is an honest answer.** Some places (new, home-based, delivery-only, or misspelled in the post) are not on Google. Show the name and tip as the post gave them, let the person correct the name, and save with no place id. Names are matched allowing a misread letter or two, and a name-only place is searched again with "restaurant" and "cafe" before giving up.
- **Ratings.** `match.rating` (for example 4.5) and `match.ratingCount` are Google's, and are `null` for a new place, a home business or a pop-up. Show every place the same way: **`4.5 ★ (66)`** when there is a rating; **`New`** when Google has the place but no rating; **nothing** (no stars, no zero) when there is no match. Never show 0 stars. Dim the rating when `ratingCount` is under 10, because a 5.0 from three people says little. It is Google's star average, not reviews read by us.
- `commentNote`: something a viewer said about the place (for example that it closed). Show it as "a viewer says".

### `POST /api/links/refresh`

Request: `{ "placeIds": ["ChIJ..."] }` (1 to **3** Google place ids; more answers 400, so ask for a longer list in batches of three). Each id is looked up once (a repeated id is answered from the first), and an id's answer is kept for 10 minutes, so asking again is free for that time. Answers the current state of places saved earlier, so a saved list can show "closed" before someone goes:

```json
{ "google": "google",
  "places": [ { "placeId": "ChIJ...", "found": true, "name": "...", "address": "...", "rating": 4.1, "ratingCount": 12, "businessStatus": "OPERATIONAL" },
              { "placeId": "ChIJ...", "found": false } ] }
```

`found: false`: Google no longer has the place. `found: null`: Google could not be asked, so say nothing. `businessStatus` is Google's: `OPERATIONAL`, `CLOSED_TEMPORARILY`, `CLOSED_PERMANENTLY`.

## The saved list

Each place has a `toSave` object. **Save that, not the whole place.** It holds the Google place id and our own notes only, because Google's terms allow keeping a place id and nothing else of its data (no name from Google, address, rating or photos). Names in `toSave` are what the post said. Show Google's details live: ask for a place's address, rating and photos by id when the list is shown, and use `/api/links/refresh` for its status.

- `toSave.googlePlaceId` is `null` when there is no confident match. Let the person confirm `match` (then copy `match.placeId`) or save the place without one.
- Group a person's saved places in lists. A place saved from two posts is one place (same `googlePlaceId`) with two sources.
- `postKey` is the same for every spelling of a link to the same post (`tiktok:7690...`, `youtube:dQw4...`), so use it to find a post that has been read before.
- **Saved places:** one list a person, in `saved_places` (`db/migrations/20261104000000_jio_saved_places.sql`), which also keeps the place's `locationHint`. The browser reads and writes its own rows directly. **Applied to the live project on 4 November 2026, in the SQL editor, so it is not in the migration history.** Not built: `place_reports(user_id, google_place_id, kind, at)`.

## Out-of-date places and reports

A post can be old, and a place can close. Three layers, none of which asks people to paste anything:

1. **The post's own dates.** The AI reads the dates a post states; the server compares them with today in Singapore. A pop-up that ended is `ended`; one with no dates is `unverified`.
2. **Google.** `CLOSED_PERMANENTLY` marks a place closed on its own. `refresh` re-checks any saved place.
3. **Reports.** A person can say a saved place is `closed`, `moved`, `wrong_place`, `ended`, or `open`. `post-reports.js` (`assessReports`) turns a place's reports into a verdict. **One report never removes a place.**
   - One report per person counts (their latest, within 30 days).
   - 1 or 2 people: the place stays, with a warning.
   - 3 or more people: if Google does not list the place as open (closed, or no such place, as with a pop-up), it is hidden from suggestions. If Google says it is open, it stays with a stronger warning and goes to the **review queue** for a team member to decide: a person decides, not the count.
   - Saying "it is open" cancels reports: two more than the reports clears the warning.
   - Hiding deletes nothing. It lifts when the reports age out or people confirm it is open.

   The rules are a pure function; the frontend or a later route calls it with the reports it loaded. The review queue is the places whose verdict is `needs_review` (or `hidden`, to double check). Who reviews is a team decision: suggest the host of the session first, then the team.

## What goes to the AI

Only the post goes to Gemini: its video or slides, its caption, and its date. **Comments are not sent unless `LINK_READER_COMMENTS=1`**, and it is off by default: they are by strangers, and the project rule is that only venue names, kinds, times and the weather go to an AI provider, never anything about a person. Whether comments may be sent is waiting for the team lead's decision. When they are sent, only the words are: an author's name is never read, and any `@handle` in a comment is taken out. (A creator's own caption or description is the post itself and is sent as it is.) Everything the AI writes back has its web addresses taken out, is cut to a fixed length, and keeps only the fields asked for.

The reader's AI spend is on **the same Gemini key as the itinerary AI** (`GEMINI_API_KEY`), so both draw on one provider quota and one bill, though each keeps its own budget in the server (`LINK_READER_CALLS_PER_MINUTE` and `ITINERARY_AI_CALLS_PER_MINUTE`).

## Setup and limits

Settings in `backend/.env` (see `.env.example`). Nothing below runs unless `LINK_READER=1`.

| Variable | Default | What it does |
|---|---|---|
| `LINK_READER` | off | `1` mounts the three routes. Without it they answer 404 and nothing is built or scheduled at start-up. The start-up log says in one line that the reader is off and how to turn it on. |
| `GEMINI_API_KEY` | none | Required. Shared with the itinerary AI. Without it `read` and `refresh` answer 503. |
| `YOUTUBE_API_KEY` | `GOOGLE_MAPS_API_KEY` | A YouTube post's description and date. |
| `LINK_READER_COMMENTS` | off | `1` also reads a YouTube post's top comments and sends them to the AI (handles and authors removed). Waiting for the team lead's decision. |
| `LINK_READER_CALLS_PER_MINUTE` | 6 | The AI budget: **model calls** a minute for the whole server, one token per call (a read that tries three models spends three), at most 2 at once. |
| `LINK_READER_PER_CALLER_PER_MINUTE` | 3 | Reads, and separately refreshes, one caller may make a minute. |
| `LINK_READER_YTDLP`, `LINK_READER_BROWSER` | off | Development tools, below. They also need `NODE_ENV=development`. |

Limits, all checked before anything is gathered:

- **Per caller:** 3 reads and 3 refreshes a minute (429 over).
- **AI budget:** a read that finds no token, or the reader paused, answers `ai_unavailable` at once, without calling YouTube, TikTok, a download tool or a browser.
- **Pause:** three reads in a row that fail because the AI service is unwell (no answer, a 5xx or a 429) pause the reader for a minute. A post the AI refuses (a 400, or an answer that is not a list of places) is answered `post_unreadable` and counts for nothing; so does a key or model the service rejects (401, 403, 404), which is logged for the operator.
- **Gathering:** at most 2 posts are gathered at once (a third answers `busy`), and gathering (the download tool and the browser together) is stopped after 60 seconds, after which the read goes on with the caption alone.
- **YouTube Data API:** counted on its own, twice the AI budget a minute (each read makes at most two calls: the video, and with comments on, the comments).
- **Google:** the link reader has its own lane of **one third** of `GOOGLE_CALLS_PER_MINUTE` (20 at the default 60), drawn from the same budget, circuit and caches as the planner, so the planner always keeps at least two thirds. One read makes at most **15** Google searches: the same as the 15 places it looks up, so every place gets its first search before any gets a retry, and one read cannot spend more than the lane's 20. `refresh` looks up 3 ids at most. A call over the lane's share is not made: `google.source` is `unavailable` / `found: null`.
- **Memory:** the cache keeps the AI's reading of a post (6 hours) and the Google matches (10 minutes), never a video, a slide or a comment.

Worst case for one caller in a minute: 3 reads and 3 refreshes. They can cause at most **6 Gemini calls** (the server-wide budget; one caller's 3 reads could ask for 9), **6 YouTube Data API calls** (3 with comments off), and **20 Google calls** (the lane; 3 reads could ask for 45 and 3 refreshes for 9 more). Before the review the same caller could cause 18 Gemini calls, about 600 YouTube calls and the whole 60 Google calls of the shared budget.

- **TikTok, Instagram, Xiaohongshu, photo posts and carousels:** the caption of a TikTok is always read. Everything else needs a **development tool**, each off by default, because those sites' terms do not allow automated access and it breaks whenever they change a page. A tool runs only when its variable is `1` **and `NODE_ENV=development`** exactly (not merely "not production"), on a machine with the program installed, and never in stub mode:
  - `LINK_READER_YTDLP=1` downloads a video with yt-dlp (`brew install yt-dlp`). Only a single TikTok or Instagram post (or a short link) is passed to it, as `https://` after `--`; a profile, feed or playlist is refused first. It is told to take one video (`--no-playlist --playlist-items 1 --max-downloads 1`), to ignore config files, and runs with the environment reduced to PATH, HOME, a temp directory and the locale.
  - `LINK_READER_BROWSER=1` opens the post in a phone-sized headless Chrome (installed Google Chrome plus Playwright, which the frontend's tests already bring) and reads every slide of a photo post, an Instagram carousel or a video. Chrome runs with its sandbox, no service workers or downloads, and the same reduced environment. Every request the page makes must be `https` to a supported site or one of their media hosts (`MEDIA_HOSTS` in `link-source.js`) or it is aborted; a redirect off the supported sites ends the read before anything is read; the pictures and the video are fetched by the tool only from an allowed host whose name resolves to public addresses only, with redirects checked at each step.
  - Xiaohongshu often shows a captcha; the tool stops there (`login_required`) and does not try to get past it.
  - What a tool says is never passed to the person: a failure becomes a fixed sentence in `notes`, and the detail goes to the server log only.
  - On a deployed server none of this runs, so only YouTube links and TikTok captions can be read there. Say "this kind of post is not supported yet" for the rest.
  - A TikTok's date comes from its id, an Instagram's from its description, so old posts are flagged even when the page gives no date.
- **YouTube:** Gemini opens the public video itself, so it works on the deployed server.
- The YouTube key has not been tried with a real key yet; the Google lookups share the Google budget with the planner (within the lane above).
- Treat everything in a post as untrusted. The server tells the AI that text in a post is data, and cleans every sentence it returns, but render all of it as plain text, never as HTML.
