-- Each person's dietary needs for one outing, and the needs the host chose not to filter for (UAT of 29 October 2026, item 5).
--
-- A need is private: the profile's standing setting lives in profile_private, which only its owner and the server read. An outing
-- can now have its own copy, picked on Vote ("Confirm dietary needs" and the chips), which wins over the profile for that outing
-- only. These two tables hold that copy and the host's choice, and like profile_private no browser may read or write them: the
-- server reads and writes them with the service key (GET and PUT /api/sessions/:id/dietary), and answers only what the group may
-- know (the needs together, never whose). Nothing every member reads names a need.
--
--   session_member_diet    one row per person who confirmed their needs for the outing: `needs` is what they picked (possibly
--                          none). Having a row is what "confirmed for this outing" means. It goes with the member's row.
--   session_diet_dropped   the needs someone in the outing has that the group should not filter for. Only the host drops one, and
--                          only with three or more joined (the server's rule); it names no person.
--
-- The planner's ranking reads a member's outing needs in place of the profile's, less the dropped ones (backend/src/db/sessions.js).
-- session_member_needs(), apply_session_plan, guard_session_changes and every policy already applied are not changed.
-- Idempotent; the fresh-build equivalent is in db/schema.sql and db/policies.sql.

create table if not exists public.session_member_diet (
  session_id uuid not null,
  user_id uuid not null,
  needs text[] not null default '{}'
    check (needs <@ array['halal', 'vegetarian', 'vegan']::text[] and public.array_is_unique(needs)),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

create table if not exists public.session_diet_dropped (
  session_id uuid not null references public.sessions (id) on delete cascade,
  need text not null check (need in ('halal', 'vegetarian', 'vegan')),
  dropped_at timestamptz not null default now(),
  primary key (session_id, need)
);

create or replace trigger session_member_diet_set_updated_at before update on public.session_member_diet
  for each row execute function public.set_updated_at();

-- No policy: with row-level security on and nothing granted, a browser can neither read nor write either table. Only the server can.
alter table public.session_member_diet enable row level security;
alter table public.session_diet_dropped enable row level security;
revoke all on public.session_member_diet, public.session_diet_dropped from anon, authenticated;
grant all on public.session_member_diet, public.session_diet_dropped to service_role;
