-- Jio migration: drop the two completion functions that were put on the live project by hand before review.
--
-- What it removes: complete_session_with_stops(uuid, jsonb) and complete_session_with_travel(uuid, jsonb, jsonb). They came from
-- pull request #164 (held, not merged) and were run in the SQL editor on or after 17 October 2026, so they were never in the
-- project's migration list. Both insert stops.not_before_minute, which the live stops table does not have, so neither could run;
-- nothing in the app calls them, and nothing in the database depends on them (checked on 21 October 2026). They also took the
-- stops and every member's minutes from the browser, which the design does not allow. Finishing an outing and the travel ledger
-- come back, built to the design, with stage 5 (ticket #130).
--
-- Idempotent. db/schema.sql and db/policies.sql never carried these functions, so they need no change.

drop function if exists public.complete_session_with_stops(uuid, jsonb);
drop function if exists public.complete_session_with_travel(uuid, jsonb, jsonb);
