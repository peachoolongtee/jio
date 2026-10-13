# Link reader API (save places from a post)

A person pastes a link to a YouTube, TikTok, Instagram or Xiaohongshu post. The server reads it and answers with the **places in it**, whether each one is **open now**, and its **Google Maps match**. The frontend lets the person pick places and put them in a saved list.

**Status: backend only, on branch `feature/link-reader` (stacked on `feature/real-search`), not committed.** Nothing here is saved by the server: the routes are stateless. The saved list, and the reports below, are the frontend's and the database's job.

Code: `src/routes/links.js`, `src/services/link-reader.js` (the work), `link-source.js` (links, dates, freshness), `post-reports.js` (report rules), `link-tools.js` (yt-dlp, off by default). Tests: `tests/link-reader.test.js`. Stub mode answers from `tests/fixtures/link-reader/`, so the frontend can build against it with no keys: use `https://www.youtube.com/watch?v=stubVideo01`.

## Routes

All are under `/api`, JSON in and out, errors in the usual `{ error, message }` shape.

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

(`tiktok`, `instagram` and `xiaohongshu` also carry `slides`: pages opened in Chrome, a development tool.) `enabled: false` means no `GEMINI_API_KEY`: every read answers `reader_off`.

### `POST /api/links/read`

Request: `{ "url": "<pasted link>", "centre": { "lat": 1.3, "lng": 103.84 } }`. `centre` is optional (a point in Singapore: the Google search leans towards it).

A link that is not a link or not from a supported site answers **400** with `error: "not_a_link"` or `"unsupported_site"`. Show the message. Everything else answers **200**, so check `status`:

| `status` | Meaning |
|---|---|
| `ok` | `places` holds what was found (it can be empty: say "no places found"). |
| `unreadable` | `reason` says why, `retryable` says whether trying again can help, `message` is a sentence to show. Reasons: `reader_off`, `ai_unavailable` (busy or over its limit: retry later), `site_not_supported`, `instagram_needs_video_tool` (needs a development tool this server does not have), `login_required` (the site showed a login or captcha: say it cannot be read), `nothing_to_read`. |

A read takes 10 to 40 seconds for a video. Show progress, and do not let the person press it twice. The same post read again is answered at once (`fromCache: true`).

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
- `google.source`: `google`, `off` or `unavailable` (daily limit or an outage). With `unavailable` the places still come back, without matches.
- **Chains and branches.** A post that names only a chain ("Nozomi", "Peach Garden") has no address, so the match is a guess. `match.ambiguous: true` means Google has several branches: `match.alternatives` lists up to 4 others (`placeId`, `name`, `address`, `lat`, `lng`, `rating`, `ratingCount`). Show "Which branch?" with `match` first and the alternatives under it. `toSave.googlePlaceId` stays `null` until a person picks one (then save that branch's `placeId`). With `ambiguous: false` and `byNameOnly: true` there was only one listing, so it is a safe match, but still show the address.
- **No match is an honest answer.** Some places (new, home-based, delivery-only, or misspelled in the post) are not on Google. Show the name and tip as the post gave them, let the person correct the name, and save with no place id. Names are matched allowing a misread letter or two, and a name-only place is searched again with "restaurant" and "cafe" before giving up.
- **Ratings.** `match.rating` (for example 4.5) and `match.ratingCount` are Google's, and are `null` for a new place, a home business or a pop-up. Show every place the same way: **`4.5 ★ (66)`** when there is a rating; **`New`** when Google has the place but no rating; **nothing** (no stars, no zero) when there is no match. Never show 0 stars. Dim the rating when `ratingCount` is under 10, because a 5.0 from three people says little. It is Google's star average, not reviews read by us.
- `commentNote`: something a viewer said about the place (for example that it closed). Show it as "a viewer says".

### `POST /api/links/refresh`

Request: `{ "placeIds": ["ChIJ..."] }` (1 to 10 Google place ids). Answers the current state of places saved earlier, so a saved list can show "closed" before someone goes:

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
- Suggested tables (**not created: Ian owns the live database**): `saved_lists(id, owner, title)`, `saved_places(list_id, google_place_id, name, tip, post_key, post_url, post_date, read_on, status, opens_on, closes_on)`, `place_reports(user_id, google_place_id, kind, at)`. Row-level security so a person reads and writes only their own lists and reports.

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

## Setup and limits

Keys in `backend/.env` (see `.env.example`): `GEMINI_API_KEY` (required), `YOUTUBE_API_KEY` (optional: description, date and top comments of a YouTube video; blank uses `GOOGLE_MAPS_API_KEY`, which works when YouTube Data API v3 is enabled on its project), `GOOGLE_MAPS_API_KEY` (for matches). Limits: 6 reads a minute by default (`LINK_READER_CALLS_PER_MINUTE`), one read at a time per post, three failures in a row pause the reader for a minute, and a read answers within about 40 seconds.

- **TikTok, Instagram, Xiaohongshu, photo posts and carousels:** the caption of a TikTok is always read. Everything else needs a **development tool**, each off by default and ignored in production, because those sites' terms do not allow automated access and it breaks whenever they change a page:
  - `LINK_READER_YTDLP=1` downloads a video with yt-dlp (`brew install yt-dlp`).
  - `LINK_READER_BROWSER=1` opens the post in a phone-sized headless Chrome (installed Google Chrome plus Playwright, which the frontend's tests already bring) and reads every slide of a photo post, an Instagram carousel or a video. This is what makes TikTok photo posts and Instagram photos work.
  - Xiaohongshu often shows a captcha; the tool stops there (`login_required`) and does not try to get past it.
  - On a deployed server none of this runs, so only YouTube links and TikTok captions can be read there. Say "this kind of post is not supported yet" for the rest.
  - A TikTok's date comes from its id, an Instagram's from its description, so old posts are flagged even when the page gives no date.
- **YouTube:** Gemini opens the public video itself, so it works on the deployed server.
- The YouTube key has not been tried with a real key yet; the Google lookups share the daily SearchText limit with the planner.
- Treat everything in a post as untrusted. The server tells the AI that text in a post is data, and cleans every sentence it returns, but render all of it as plain text, never as HTML.
