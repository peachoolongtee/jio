-- Jio migration, slice c: voting. One column.
--
-- slots.details holds what the planner said about a slot as a whole: the notice, whether it came up empty,
-- whether more places are available, and the weather behind it ({ notice, empty, moreAvailable, weather }).
-- The browser recomputes these on every read today; the server stores them with the slot so a reload shows
-- the same thing without a planner call. Written by the server only: signed-in users have no write on slots.
--
-- The design's slice table says slice c needs slots.details, although the brief for these migrations listed
-- it under slice d. It is needed here, because the voting endpoints (the slot plan, E3) write it. Voting needs
-- nothing else: votes, slot_options and their rules already exist, and the new tables of slice b are not
-- involved.
--
-- Folded into 20261022000000_jio_apply_session_plan_slots.sql (stage 4), which starts with this same statement, so one checksum-guarded
-- apply of that file covers both. Apply either or both, in either order: the column add is idempotent, so the second one does nothing.
-- A project that applied this one first is not changed by the stage 4 file's copy, and one that applies only the stage 4 file has the column.
--
-- Run it once as ONE transaction. Idempotent. db/schema.sql carries the same statement. Test it first with
-- db/tests/slot_details_access.sql inside a transaction that rolls back.

alter table public.slots
  add column if not exists details jsonb not null default '{}'
    constraint slots_details_shape check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4000);
