-- Jio database schema: tables, functions and triggers for the session model.
--
-- How to apply:
--   1. Run this file, then db/policies.sql, in the Supabase SQL editor (or as one migration).
--   2. Apply the same pair to the test project.
--
-- Both files are safe to run more than once, and safe to run on the "jio" project as it stands:
-- anything that already exists there is left exactly as it is.
--
-- Every table has row-level security switched on in db/policies.sql. Nothing here is readable
-- until that file has run.
--
-- Venue ids are text because venues still live in the backend's JSON files (for example
-- "cdc_560160"). Area ids are text for the same reason (for example "bishan").

-- Needed for gen_random_bytes, which makes the invite tokens.
create extension if not exists pgcrypto with schema extensions;

-- ── Accounts ────────────────────────────────────────────────────────────
-- These two tables, the sign-up trigger and username_available() were created on the "jio" project
-- on 6 Oct 2026, straight in the dashboard. They are reproduced here unchanged so the test project
-- can be built from this file. On "jio" itself every statement in this section does nothing.

-- The public half of an account: what other signed-in users may see.
create table if not exists public.profiles (
  id uuid not null,
  -- 3 to 20 lowercase letters, numbers and underscores. Set at sign-up and not editable.
  username text not null,
  display_name text,
  avatar_url text,
  created_at timestamptz not null default now(),
  constraint profiles_pkey primary key (id),
  constraint profiles_id_fkey foreign key (id) references auth.users (id) on delete cascade,
  constraint profiles_username_key unique (username),
  constraint username_format check (username ~ '^[a-z0-9_]{3,20}$'),
  constraint display_name_length check (char_length(display_name) >= 1 and char_length(display_name) <= 50)
);

-- The private half: only the owner can read it. The server reads planner needs from it with the service key.
create table if not exists public.profile_private (
  id uuid not null,
  dob date not null,
  constraint profile_private_pkey primary key (id),
  constraint profile_private_id_fkey foreign key (id) references public.profiles (id) on delete cascade,
  constraint dob_range check (dob >= '1900-01-01'::date)
);

-- Creates both profile rows when someone signs up. The username and date of birth come from the sign-up call:
--   supabase.auth.signUp({ email, password, options: { data: { username, dob: '2003-05-17' } } })
-- Sign-up fails without both, or with a username that is taken or badly formed, so call
-- username_available first.
do $accounts$
begin
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'handle_new_user'
  ) then
    execute $fn$
      create function public.handle_new_user()
      returns trigger
      language plpgsql security definer set search_path = ''
      as $body$
      declare
        v_username text := lower(trim(new.raw_user_meta_data ->> 'username'));
        v_dob date := (new.raw_user_meta_data ->> 'dob')::date;
      begin
        if v_username is null or v_dob is null then
          raise exception 'A username and date of birth are required to sign up';
        end if;
        if v_dob > current_date then
          raise exception 'Date of birth cannot be in the future';
        end if;

        insert into public.profiles (id, username, display_name)
        values (new.id, v_username, v_username);

        insert into public.profile_private (id, dob)
        values (new.id, v_dob);

        return new;
      end;
      $body$
    $fn$;
  end if;

  -- Is this username free? Callable before signing up.
  --   const { data: free } = await supabase.rpc('username_available', { p_username: 'ian' })
  if not exists (
    select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public' and p.proname = 'username_available'
  ) then
    execute $fn$
      create function public.username_available(p_username text)
      returns boolean
      language sql stable security definer set search_path = ''
      as $body$
        select not exists (
          select 1 from public.profiles where username = lower(trim(p_username))
        );
      $body$
    $fn$;
  end if;

  if not exists (
    select 1 from pg_trigger
    where tgname = 'on_auth_user_created' and tgrelid = 'auth.users'::regclass and not tgisinternal
  ) then
    create trigger on_auth_user_created after insert on auth.users
      for each row execute function public.handle_new_user();
  end if;
end;
$accounts$;

-- Added for the planner. All optional, so existing rows and the sign-up trigger are unaffected.
-- The MRT area a person lives near, for example "woodlands". Public, like the rest of this table.
alter table public.profiles add column if not exists home_area_id text;
-- What the planner must respect for this person. Private: only the owner and the server read these.
alter table public.profile_private
  add column if not exists dietary text[] not null default '{}'
    constraint dietary_values check (dietary <@ array['halal', 'vegetarian', 'vegan']::text[]),
  add column if not exists budget_max_per_person numeric(6, 2)
    constraint budget_positive check (budget_max_per_person > 0),
  add column if not exists needs_step_free boolean not null default false;

-- ── Sessions ────────────────────────────────────────────────────────────

-- One outing. Status moves inviting → locating → voting → confirmed → completed, or to cancelled.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  host_id uuid not null references public.profiles (id) on delete cascade,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  date date not null,
  start_time time not null,
  end_time time not null,
  status text not null default 'inviting'
    check (status in ('inviting', 'locating', 'voting', 'confirmed', 'completed', 'cancelled')),
  -- The search radius the group chose, or null to let the planner widen on its own.
  radius_meters integer check (radius_meters between 100 and 3000),
  -- The meeting area. Written by the server only, after the planner has run.
  meeting_area_id text,
  meeting_method text check (meeting_method in ('same', 'fairest', 'centre')),
  meeting_max_minutes integer,
  meeting_total_minutes integer,
  meeting_count integer,
  -- True when the travel times behind the meeting area are estimates, not real routes.
  meeting_approximate boolean,
  meeting_computed_at timestamptz,
  -- A one-line notice for the group, and a pending "plan again?" prompt.
  banner jsonb,
  replan jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index if not exists sessions_host_id_idx on public.sessions (host_id);

-- Who is in a session, where they start and end, and what they want to do.
create table if not exists public.session_members (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'guest' check (role in ('host', 'guest')),
  state text not null default 'joined' check (state in ('joined', 'opted_out')),
  -- Where the person sets off from. An area id, a label to show, and exact coordinates when known.
  start_area_id text,
  start_label text,
  start_lat double precision,
  start_lng double precision,
  -- Where the person goes afterwards. All null means "same as the start".
  end_area_id text,
  end_label text,
  end_lat double precision,
  end_lng double precision,
  -- What the person picked on the Activities screen.
  categories text[] not null default '{}'
    check (categories <@ array['eat', 'drink', 'shop', 'activity']::text[]),
  stay_until time,
  preferences_set_at timestamptz,
  -- Minutes from this person's start to the meeting area. Written by the server only.
  travel_minutes integer,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index if not exists session_members_user_id_idx on public.session_members (user_id);

-- Invite links. The token is 32 random bytes, so links cannot be guessed or counted through.
create table if not exists public.invites (
  token text primary key
    default translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_'),
  session_id uuid not null references public.sessions (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz,
  revoked boolean not null default false,
  uses integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists invites_session_id_idx on public.invites (session_id);

-- ── Planning ────────────────────────────────────────────────────────────

-- One time slot per category the group picked. Built by the server from everyone's preferences.
create table if not exists public.slots (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  category text not null check (category in ('eat', 'drink', 'shop', 'activity')),
  -- Minutes after midnight.
  start_minute integer not null check (start_minute between 0 and 1439),
  duration_minutes integer not null check (duration_minutes between 1 and 720),
  -- How many people picked this category.
  picks integer not null default 0,
  is_last boolean not null default false,
  -- The host can remove a slot and restore it later.
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, category)
);

-- The places the group is voting on for a slot. Ranked ones come from the planner; a member can add one.
create table if not exists public.slot_options (
  slot_id uuid not null references public.slots (id) on delete cascade,
  venue_id text not null,
  rank integer,
  -- The planner's score. It is a penalty: lower is better.
  score numeric,
  source text not null default 'planner' check (source in ('planner', 'member')),
  added_by uuid references public.profiles (id) on delete set null,
  -- What the planner said about this place: explanation, walking minutes, crowd, and the caveats
  -- (approximate, dietUnknown, verify) that the screens must show.
  details jsonb not null default '{}',
  created_at timestamptz not null default now(),
  primary key (slot_id, venue_id)
);

-- One vote per person per slot. A vote disappears if its option is removed.
create table if not exists public.votes (
  slot_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  venue_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (slot_id, user_id),
  foreign key (slot_id, venue_id) references public.slot_options (slot_id, venue_id) on delete cascade
);

-- The confirmed itinerary, in order. Written by the server when the host confirms.
create table if not exists public.stops (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  seq integer not null check (seq >= 0),
  slot_id uuid references public.slots (id) on delete set null,
  category text check (category in ('eat', 'drink', 'shop', 'activity')),
  venue_id text not null,
  -- Minutes after midnight.
  planned_start_minute integer not null check (planned_start_minute between 0 and 1439),
  duration_minutes integer not null check (duration_minutes between 1 and 720),
  -- How the group gets here from the stop before, and how long that takes.
  travel_mode text check (travel_mode in ('walk', 'mrt', 'car')),
  travel_minutes integer,
  arrived_at timestamptz,
  created_at timestamptz not null default now(),
  -- Checked at the end of the transaction, so stops can be reordered in one go.
  unique (session_id, seq) deferrable initially deferred
);

-- ── Fairness and routing ────────────────────────────────────────────────

-- How far each person travelled for a session: in, between stops, and home. Written by the server
-- when the session ends. delta_from_mean is positive for someone who travelled more than the group's average.
create table if not exists public.commute_ledger (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  minutes_in integer not null default 0 check (minutes_in >= 0),
  minutes_between integer not null default 0 check (minutes_between >= 0),
  minutes_home integer not null default 0 check (minutes_home >= 0),
  total_minutes integer generated always as (minutes_in + minutes_between + minutes_home) stored,
  delta_from_mean numeric not null default 0,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index if not exists commute_ledger_user_id_idx on public.commute_ledger (user_id);

-- Routes already fetched from OneMap, so the same trip is not paid for twice. Server only.
-- origin_key is the start point rounded to 3 decimal places; dest_key is a venue or area id.
create table if not exists public.route_cache (
  origin_key text not null,
  dest_key text not null,
  hour_bucket smallint not null check (hour_bucket between 0 and 23),
  mode text not null check (mode in ('pt', 'walk')),
  duration_minutes integer not null check (duration_minutes >= 0),
  transfers integer,
  fetched_at timestamptz not null default now(),
  primary key (origin_key, dest_key, hour_bucket, mode)
);

-- ── Helper functions ────────────────────────────────────────────────────
-- These run with the owner's rights (security definer) so a policy can ask "is this person in the
-- session?" without the policies on session_members calling themselves in a loop.

-- True when the signed-in user is in the session.
--   select public.is_session_member('<session id>');
create or replace function public.is_session_member(sid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.session_members m
    where m.session_id = sid and m.user_id = (select auth.uid())
  );
$$;

-- True when the signed-in user hosts the session.
--   select public.is_session_host('<session id>');
create or replace function public.is_session_host(sid uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.sessions s
    where s.id = sid and s.host_id = (select auth.uid())
  );
$$;

-- The session a slot belongs to. Used by the policies on slot_options and votes.
create or replace function public.session_of_slot(slot uuid)
returns uuid
language sql stable security definer set search_path = ''
as $$
  select s.session_id from public.slots s where s.id = slot;
$$;

-- True when the slot's session is still in the Voting stage.
create or replace function public.slot_is_open(slot uuid)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from public.slots sl
    join public.sessions se on se.id = sl.session_id
    where sl.id = slot and se.status = 'voting' and not sl.deleted
  );
$$;

-- ── Functions the app calls ─────────────────────────────────────────────

-- What an invite link leads to, for the join page. Callable when logged out.
-- Returns no row when the link is revoked, expired, or the session is over.
--   const { data } = await supabase.rpc('invite_preview', { invite_token: token })
create or replace function public.invite_preview(invite_token text)
returns table (session_id uuid, title text, date date, start_time time, end_time time, host_name text, member_count bigint)
language sql stable security definer set search_path = ''
as $$
  select s.id, s.title, s.date, s.start_time, s.end_time, coalesce(p.display_name, p.username),
         (select count(*) from public.session_members m where m.session_id = s.id)
  from public.invites i
  join public.sessions s on s.id = i.session_id
  join public.profiles p on p.id = s.host_id
  where i.token = invite_token
    and not i.revoked
    and (i.expires_at is null or i.expires_at > now())
    and s.status not in ('completed', 'cancelled');
$$;

-- Join a session with an invite link. Returns the session id.
-- Raises an error when the link is revoked, expired, or the session is over.
--   const { data: sessionId, error } = await supabase.rpc('join_session', { invite_token: token })
create or replace function public.join_session(invite_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  target uuid;
begin
  if me is null then
    raise exception 'Sign in to join a session.' using errcode = '28000';
  end if;

  select i.session_id into target
  from public.invites i
  join public.sessions s on s.id = i.session_id
  where i.token = invite_token
    and not i.revoked
    and (i.expires_at is null or i.expires_at > now())
    and s.status not in ('completed', 'cancelled');

  if target is null then
    raise exception 'This invite link is no longer valid.' using errcode = 'P0002';
  end if;

  insert into public.session_members (session_id, user_id, role, state)
  values (target, me, 'guest', 'joined')
  on conflict (session_id, user_id) do update set state = 'joined';

  update public.invites set uses = uses + 1 where token = invite_token;
  return target;
end;
$$;

-- Each joined member's planner needs, for the server only (the service key). The backend first loads
-- the session as the signed-in user, which proves they are a member, then calls this.
--   const { data } = await serviceClient.rpc('session_member_needs', { sid: sessionId })
create or replace function public.session_member_needs(sid uuid)
returns table (user_id uuid, dietary text[], budget_max_per_person numeric, needs_step_free boolean)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, pp.dietary, pp.budget_max_per_person, pp.needs_step_free
  from public.session_members m
  join public.profile_private pp on pp.id = m.user_id
  where m.session_id = sid and m.state = 'joined';
$$;

-- ── Triggers ────────────────────────────────────────────────────────────

-- Keeps updated_at current on every change.
create or replace function public.set_updated_at()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create or replace trigger sessions_set_updated_at before update on public.sessions
  for each row execute function public.set_updated_at();
create or replace trigger session_members_set_updated_at before update on public.session_members
  for each row execute function public.set_updated_at();
create or replace trigger slots_set_updated_at before update on public.slots
  for each row execute function public.set_updated_at();
create or replace trigger votes_set_updated_at before update on public.votes
  for each row execute function public.set_updated_at();

-- Adds the host as the first member of a new session.
create or replace function public.add_host_membership()
returns trigger
language plpgsql security definer set search_path = ''
as $$
begin
  insert into public.session_members (session_id, user_id, role, state)
  values (new.id, new.host_id, 'host', 'joined');
  return new;
end;
$$;

create or replace trigger sessions_add_host after insert on public.sessions
  for each row execute function public.add_host_membership();

-- Limits which status changes a signed-in user can make directly. The host may start a session
-- (inviting → locating) and cancel one. Every other change (voting, confirmed, completed) is made
-- by the server, after the planner has run.
create or replace function public.guard_session_status()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.status is distinct from old.status and current_user in ('authenticated', 'anon') then
    if not (
      (old.status = 'inviting' and new.status = 'locating')
      or (new.status = 'cancelled' and old.status not in ('completed', 'cancelled'))
    ) then
      raise exception 'A session cannot go from % to % directly.', old.status, new.status
        using errcode = '42501';
    end if;
  end if;
  return new;
end;
$$;

create or replace trigger sessions_guard_status before update on public.sessions
  for each row execute function public.guard_session_status();
