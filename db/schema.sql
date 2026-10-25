-- Jio database schema: tables, functions and triggers for the session model.
--
-- How to apply:
--   1. Run this file, then db/policies.sql, in the Supabase SQL editor (or as one migration).
--   2. Apply the same pair to the test project.
--
-- Run the two files together as ONE transaction (one migration, or one paste into the SQL editor).
-- Row-level security is switched on in db/policies.sql, so between the two files the new tables
-- would be open to any signed-in user. Both files are safe to run more than once.
--
-- On the "jio" project the account tables, the sign-up trigger and username_available() already
-- exist and are left as they are: this file only adds columns to profile_private, and
-- db/policies.sql sets the same permissions on them that the project already had.
--
-- These files describe a fresh build. "create table if not exists" does not change a table that is
-- already there, so a change to an existing table's columns needs its own migration.
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
-- username_available first. This is the function as first made on "jio"; it is replaced further down (after the
-- planner columns) by one that also saves the name, home area and dietary needs.
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
-- Private: only the owner and the server read these. home_area_id is here, not on profiles, because
-- every signed-in user can read profiles and where someone lives is not for strangers.
alter table public.profile_private
  add column if not exists home_area_id text
    constraint home_area_length check (char_length(home_area_id) <= 60),
  add column if not exists dietary text[] not null default '{}'
    constraint dietary_values check (dietary <@ array['halal', 'vegetarian', 'vegan']::text[]),
  add column if not exists budget_max_per_person numeric(6, 2)
    constraint budget_positive check (budget_max_per_person > 0),
  add column if not exists needs_step_free boolean not null default false;

-- The sign-up trigger's function again, now that profile_private has the planner columns. Besides the username and
-- date of birth it saves the name, home area and dietary needs typed at sign-up, which come in the same metadata:
--   supabase.auth.signUp({ email, password, options: { data: {
--     username: 'sam', dob: '2003-05-17', name: 'Sam Tan', home_area_id: 'tampines', dietary: ['halal'] } } })
-- They are saved here, not by the app afterwards, because with email confirmation on nobody is signed in after
-- sign-up to write them. Those three are optional: one that breaks a rule (a name over 50 characters, an unknown
-- dietary need) is left out rather than failing the sign-up. "create or replace" so it also updates the "jio" project,
-- where the original function from the block above already exists.
create or replace function public.handle_new_user()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  v_meta jsonb := coalesce(new.raw_user_meta_data, '{}'::jsonb);
  v_username text := lower(trim(v_meta ->> 'username'));
  v_dob date := (v_meta ->> 'dob')::date;
  v_name text := nullif(trim(v_meta ->> 'name'), '');
  v_area text := nullif(trim(v_meta ->> 'home_area_id'), '');
  v_dietary text[] := '{}';
begin
  if v_username is null or v_dob is null then
    raise exception 'A username and date of birth are required to sign up';
  end if;
  if v_dob > current_date then
    raise exception 'Date of birth cannot be in the future';
  end if;
  if char_length(v_name) > 50 then
    v_name := null;
  end if;
  if char_length(v_area) > 60 then
    v_area := null;
  end if;
  if jsonb_typeof(v_meta -> 'dietary') = 'array' then
    select coalesce(array_agg(distinct need order by need), '{}') into v_dietary
    from jsonb_array_elements_text(v_meta -> 'dietary') as t(need)
    where need in ('halal', 'vegetarian', 'vegan');
  end if;

  insert into public.profiles (id, username, display_name)
  values (new.id, v_username, coalesce(v_name, v_username));

  insert into public.profile_private (id, dob, home_area_id, dietary)
  values (new.id, v_dob, v_area, v_dietary);

  return new;
end;
$$;

-- Is this email already used by an account? Asked by the sign-up screen on its email question, before anything else, so
-- a registered email is told straight away instead of after every question. It answers only true or false, but that
-- is still a lookup of who has an account, so only the server may call it (policies.sql grants it to service_role and
-- to nobody else): the browser asks the backend (POST /api/accounts/email-check), which limits how often each caller
-- may ask. Auth stores addresses in lower case, so the address is lower-cased and trimmed here and compared with the
-- column as it is, which lets the index on auth.users.email be used. An account that has been deleted
-- (auth.users.deleted_at is set) does not count. Fails to create if this Supabase version has no deleted_at column.
--   select public.email_registered('sam@example.com');  -- true or false
create or replace function public.email_registered(p_email text)
returns boolean
language sql stable security definer set search_path = ''
as $$
  select exists (
    select 1 from auth.users
    where email = lower(trim(p_email))
      and deleted_at is null
  );
$$;

-- True when a list has no repeated entry. Used by the check on session_members.categories, so one
-- person cannot count three times by sending the same category three times.
--   select public.array_is_unique(array['eat', 'drink']);  -- true
create or replace function public.array_is_unique(items text[])
returns boolean
language sql immutable set search_path = ''
as $$
  select cardinality(items) = (select count(distinct item) from unnest(items) as item);
$$;

-- ── Sessions ────────────────────────────────────────────────────────────

-- One outing. Status moves inviting → locating → voting → confirmed → completed, or to cancelled.
-- A signed-in host creates the row, renames it, changes its date and times while it is still
-- "inviting", starts it and cancels it. Everything else is written by the server.
create table if not exists public.sessions (
  id uuid primary key default gen_random_uuid(),
  -- A host's account cannot be deleted while they host a session: that would erase other people's history.
  host_id uuid not null references public.profiles (id) on delete restrict,
  title text not null check (char_length(btrim(title)) between 1 and 80),
  date date not null,
  start_time time not null,
  end_time time not null,
  status text not null default 'inviting'
    check (status in ('inviting', 'locating', 'voting', 'confirmed', 'completed', 'cancelled')),
  -- The search radius the group chose, or null to let the planner widen on its own. Server only:
  -- changing it re-ranks every slot.
  radius_meters integer check (radius_meters between 100 and 3000),
  -- The meeting area. Server only, written after the planner has run.
  meeting_area_id text,
  -- How the meeting area was settled: the planner's own pick ('same', 'fairest', 'centre'), the spot the
  -- group approved most ('voted') or a spot the host chose regardless ('chosen').
  meeting_method text check (meeting_method in ('same', 'fairest', 'centre', 'voted', 'chosen')),
  meeting_max_minutes integer,
  meeting_total_minutes integer,
  meeting_count integer,
  -- True when the travel times behind the meeting area are estimates, not real routes.
  meeting_approximate boolean,
  meeting_computed_at timestamptz,
  -- A one-line notice for the group, and a pending "plan again?" prompt. Server only.
  banner jsonb,
  replan jsonb,
  completed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (end_time > start_time)
);
create index if not exists sessions_host_id_idx on public.sessions (host_id);

-- Raised by one on every write the server makes to a plan, so a late answer can be told from a current one and
-- clients know when to refetch. Server only.
alter table public.sessions add column if not exists plan_version bigint not null default 0;

-- How the host chose to pick the meeting point: 'fairest' (everyone shares where they start and the planner finds a fair
-- spot) or 'known' (the host names the area and the group goes straight to choosing places). Null on a session that
-- started before the choice existed, and read as 'fairest'. It is the host's intent, written by the host in the update
-- that starts the session; meeting_method above is the planner's result and stays the server's.
alter table public.sessions
  add column if not exists meet_by text
    constraint sessions_meet_by_check check (meet_by in ('fairest', 'known'));

-- meeting_method also accepts 'voted' and 'chosen' on a sessions table that may already exist, so it is a
-- guarded constraint as well as part of the table definition above. The old check is dropped by what it
-- checks, not by its name, and the new one is added under the name Postgres gave the old one.
do $sessions_checks$
declare
  old_check record;
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'sessions_meeting_method_check' and conrelid = 'public.sessions'::regclass
      and pg_get_constraintdef(oid) like '%voted%'
  ) then
    for old_check in
      select conname from pg_constraint
      where conrelid = 'public.sessions'::regclass and contype = 'c'
        and pg_get_constraintdef(oid) like '%meeting_method%'
    loop
      execute format('alter table public.sessions drop constraint %I', old_check.conname);
    end loop;
    alter table public.sessions add constraint sessions_meeting_method_check
      check (meeting_method in ('same', 'fairest', 'centre', 'voted', 'chosen'));
  end if;
end;
$sessions_checks$;

-- The suggested order of the stops. All server only.
-- order_reason is one short sentence; order_source says whether the AI or the planner's own rules chose the
-- order. Both are set or both are null; the server clears them when someone moves a stop by hand.
-- order_suggestion is what the server last suggested: { basis, order, starts, reason, source, at }, where basis
-- is a 64-character hash of the winners and the session's date and times, and order lists at most 8 slot ids.
-- plan_start_minute is when the plan starts, in minutes after midnight, which reordering keeps.
alter table public.sessions
  add column if not exists order_reason text
    constraint order_reason_length check (char_length(order_reason) between 1 and 200),
  add column if not exists order_source text
    constraint order_source_values check (order_source in ('ai', 'rules')),
  add column if not exists order_suggestion jsonb,
  add column if not exists plan_start_minute integer
    constraint plan_start_minute_range check (plan_start_minute between 0 and 1439);

do $sessions_order_checks$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_note_pair' and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions add constraint order_note_pair
      check ((order_reason is null) = (order_source is null));
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'order_suggestion_shape' and conrelid = 'public.sessions'::regclass
  ) then
    alter table public.sessions add constraint order_suggestion_shape
      check (
        order_suggestion is null or (
          jsonb_typeof(order_suggestion) = 'object'
          and octet_length(order_suggestion::text) <= 4000
          and coalesce((order_suggestion ->> 'basis') ~ '^[0-9a-f]{64}$', false)
          and case when jsonb_typeof(order_suggestion -> 'order') = 'array'
                   then jsonb_array_length(order_suggestion -> 'order') <= 8
                   else false end
        )
      );
  end if;
end;
$sessions_order_checks$;

-- Who is in a session and what they want to do. Every member can read every row here, so it holds
-- only what the group may see: the area someone starts from, never the exact place.
-- A member edits their own areas and picks while the session is open. state, role and
-- travel_minutes are server only: opting out changes the meeting area, so the server does it.
create table if not exists public.session_members (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete cascade,
  role text not null default 'guest' check (role in ('host', 'guest')),
  state text not null default 'joined' check (state in ('joined', 'opted_out')),
  -- The MRT area the person sets off from and goes to afterwards, for example "bugis".
  -- A null end area means "same as the start".
  start_area_id text check (char_length(start_area_id) <= 60),
  end_area_id text check (char_length(end_area_id) <= 60),
  -- What the person picked on the Activities screen: at most one of each category.
  categories text[] not null default '{}'
    check (
      categories <@ array['eat', 'drink', 'shop', 'activity']::text[]
      and cardinality(categories) <= 4
      and public.array_is_unique(categories)
    ),
  stay_until time,
  -- Set by a trigger whenever categories or stay_until change.
  preferences_set_at timestamptz,
  -- Minutes from this person's start to the meeting area. Server only.
  travel_minutes integer,
  joined_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id)
);
create index if not exists session_members_user_id_idx on public.session_members (user_id);

-- Shape limits on the two lists the planner reads. Added as named constraints so that running this
-- file again adds them to tables that already exist.
--   dietary: one flat list, no repeats, at most 3. The planner refuses a longer list, and one
--     member's bad list would fail planning for the whole group.
--   categories: one flat list. '{{eat},{drink}}' would otherwise pass the checks above.
-- array_ndims() is null for an empty list, which is allowed.
do $shape$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'dietary_shape' and conrelid = 'public.profile_private'::regclass
  ) then
    alter table public.profile_private add constraint dietary_shape check (
      coalesce(array_ndims(dietary), 1) = 1
      and cardinality(dietary) <= 3
      and public.array_is_unique(dietary)
    );
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'categories_one_dimension' and conrelid = 'public.session_members'::regclass
  ) then
    alter table public.session_members add constraint categories_one_dimension check (
      coalesce(array_ndims(categories), 1) = 1
    );
  end if;
end;
$shape$;

-- The exact place behind a member's start and end: the address they typed, or their coordinates.
-- Only the owner and the server read this table. The rest of the group sees the area on
-- session_members and nothing more. Coordinates must fall inside Singapore.
create table if not exists public.session_member_places (
  session_id uuid not null,
  user_id uuid not null,
  start_label text check (char_length(start_label) <= 120),
  start_lat double precision check (start_lat between 1.1 and 1.5),
  start_lng double precision check (start_lng between 103.5 and 104.1),
  end_label text check (char_length(end_label) <= 120),
  end_lat double precision check (end_lat between 1.1 and 1.5),
  end_lng double precision check (end_lng between 103.5 and 104.1),
  updated_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade,
  -- A latitude always comes with its longitude.
  check ((start_lat is null) = (start_lng is null)),
  check ((end_lat is null) = (end_lng is null))
);

-- Invite links, and invitations to one named person. The token is 32 random bytes, so links cannot be guessed
-- or counted through. A link expires 7 days after it is made unless the host sets an earlier time, and never
-- later than 30 days. A host can revoke a link and nothing else about it changes.
create table if not exists public.invites (
  token text primary key
    default translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_'),
  session_id uuid not null references public.sessions (id) on delete cascade,
  created_by uuid not null references public.profiles (id) on delete cascade,
  expires_at timestamptz not null default now() + interval '7 days',
  revoked boolean not null default false,
  -- How many people have joined with this link. An invitation to one person is used once.
  uses integer not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists invites_session_id_idx on public.invites (session_id);
create index if not exists invites_created_by_idx on public.invites (created_by);

-- invitee_id is set on an invitation to one named person; a link made for anyone leaves it null. Until the
-- person accepts there is no row for them in session_members, so they read nothing of the session.
-- declined_at is set when the invitee says no. Only the server's functions write it.
alter table public.invites
  add column if not exists invitee_id uuid references public.profiles (id) on delete cascade,
  add column if not exists declined_at timestamptz;

do $invites_checks$
begin
  if not exists (
    select 1 from pg_constraint where conname = 'invites_expiry_limit' and conrelid = 'public.invites'::regclass
  ) then
    alter table public.invites add constraint invites_expiry_limit
      check (expires_at <= created_at + interval '30 days');
  end if;
  -- Only an invitation to a named person can be declined, and it is accepted at most once.
  if not exists (
    select 1 from pg_constraint where conname = 'invites_decline_needs_invitee' and conrelid = 'public.invites'::regclass
  ) then
    alter table public.invites add constraint invites_decline_needs_invitee
      check (declined_at is null or invitee_id is not null);
  end if;
  if not exists (
    select 1 from pg_constraint where conname = 'invites_personal_single_use' and conrelid = 'public.invites'::regclass
  ) then
    alter table public.invites add constraint invites_personal_single_use
      check (invitee_id is null or uses <= 1);
  end if;
end;
$invites_checks$;

-- One live link per session: to replace a link, revoke it and make another. An expired link that was never
-- revoked still counts as live here, because an index cannot ask what time it is.
create unique index if not exists invites_one_live_link_idx
  on public.invites (session_id) where invitee_id is null and not revoked;
-- One invitation per person per session, so a decline cannot be nagged. It is final even if the host
-- later revokes the invitation.
create unique index if not exists invites_one_per_invitee_idx on public.invites (session_id, invitee_id);
create index if not exists invites_invitee_id_idx on public.invites (invitee_id);

-- ── Planning ────────────────────────────────────────────────────────────
-- Everything in this section is written by the server only. Members read it, and vote.

-- One time slot per category the group picked. Built from everyone's preferences.
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
  -- The host can remove a slot and restore it later, through the server: removing a slot also
  -- clears its options and votes.
  deleted boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (session_id, category)
);

-- What the planner said about the slot as a whole: the notice, whether it came up empty, whether more places
-- are available, and the weather behind it ({ notice, empty, moreAvailable, weather }). Stored with the slot
-- so a reload shows the same thing without a planner call. Server only.
alter table public.slots
  add column if not exists details jsonb not null default '{}'
    constraint slots_details_shape check (jsonb_typeof(details) = 'object' and octet_length(details::text) <= 4000);

-- The places the group is voting on for a slot. The planner ranks them. A member can ask for one
-- to be added, through the server, which checks that the venue exists and fits the slot.
create table if not exists public.slot_options (
  slot_id uuid not null references public.slots (id) on delete cascade,
  venue_id text not null check (char_length(venue_id) <= 160),
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
create index if not exists slot_options_added_by_idx on public.slot_options (added_by);

-- One vote per person per slot. This is the one planning table a member writes: their own vote,
-- while voting is open. A vote follows its option if the option is swapped, and goes when it goes.
create table if not exists public.votes (
  slot_id uuid not null,
  user_id uuid not null references public.profiles (id) on delete cascade,
  venue_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (slot_id, user_id),
  foreign key (slot_id, venue_id) references public.slot_options (slot_id, venue_id)
    on update cascade on delete cascade
);
create index if not exists votes_user_id_idx on public.votes (user_id);

-- The confirmed itinerary, in order. Written when the host confirms.
create table if not exists public.stops (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  seq integer not null check (seq >= 0),
  slot_id uuid references public.slots (id) on delete set null,
  category text check (category in ('eat', 'drink', 'shop', 'activity')),
  venue_id text not null check (char_length(venue_id) <= 160),
  -- Minutes after midnight.
  planned_start_minute integer not null check (planned_start_minute between 0 and 1439),
  duration_minutes integer not null check (duration_minutes between 1 and 720),
  -- How the group gets here from the stop before, and how long that takes.
  travel_mode text check (travel_mode in ('walk', 'mrt', 'car')),
  travel_minutes integer,
  arrived_at timestamptz,
  created_at timestamptz not null default now(),
  -- Checked at the end of the transaction, so stops can swap places in one go. Because it is
  -- deferrable it cannot be the target of "on conflict": to rewrite an itinerary, delete the
  -- session's stops and insert the new ones.
  unique (session_id, seq) deferrable initially deferred
);
create index if not exists stops_slot_id_idx on public.stops (slot_id);

-- The earliest a stop can start, in minutes after midnight: a meal waits for its time, a shop for its
-- opening. Written with the itinerary, by the server. Null means the stop has no earliest start.
alter table public.stops
  add column if not exists not_before_minute integer
    constraint not_before_minute_range check (not_before_minute between 0 and 1439);

-- ── Meeting spots ───────────────────────────────────────────────────────
-- While a session is "locating" the group chooses where to meet from a short list of areas. The server
-- writes the list and every travel figure on it; members read it and say which spots work for them.

-- True when a jsonb value is minutes by member: an object whose keys are user ids and whose values are numbers
-- from 0 to 1440, and which is no larger than 30 members' worth. Used by the check on session_spots.
--   select public.member_minutes_ok('{"6f1c7b1e-2d7e-4a8e-9a0e-3c3d9a2f7b10": 24.6}');  -- true
create or replace function public.member_minutes_ok(m jsonb)
returns boolean
language sql immutable set search_path = ''
as $$
  select case
    when jsonb_typeof(m) <> 'object' or octet_length(m::text) > 4000 then false
    else not exists (
      select 1 from jsonb_each(m) e
      where e.key !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
        or case when jsonb_typeof(e.value) = 'number'
                then (e.value #>> '{}')::numeric not between 0 and 1440
                else true end
    )
  end;
$$;

-- The list of areas the group is choosing between while a session is "locating". Written by the server only.
-- A row is there because the app lists it (rank 1 to 3, fairest first), because a member suggested it
-- (rank null) or both. Who suggested it is in spot_suggestions and is worked out on read.
-- The minutes are not rounded: the screens round them, but the tie-break between spots compares the longest
-- trip exactly. worst_minutes is the longest trip, mean_minutes the mean of the members' minutes, and
-- travel_minutes holds each located member's minutes by user id (areas only, never a place).
-- approximate is true when the times are estimates and not routes. computed_at is when they were worked out.
-- To re-price the list, upsert the rows that stay and delete only the ones that drop out: approvals follow
-- their spot, so deleting and re-inserting every row would also delete everyone's approvals.
-- The mean may sit a hair above the longest trip when everyone's minutes are equal (floating-point sums).
create table if not exists public.session_spots (
  session_id uuid not null references public.sessions (id) on delete cascade,
  area_id text not null check (char_length(area_id) between 1 and 60),
  rank integer check (rank between 1 and 3),
  worst_minutes numeric not null check (worst_minutes between 0 and 1440),
  mean_minutes numeric not null check (mean_minutes between 0 and 1440),
  travel_minutes jsonb not null default '{}' check (public.member_minutes_ok(travel_minutes)),
  approximate boolean not null default false,
  computed_at timestamptz not null default now(),
  primary key (session_id, area_id),
  check (mean_minutes <= worst_minutes + 0.001),
  -- Checked at the end of the transaction, so the ranks can swap places in one statement. Several rows
  -- may have no rank.
  unique (session_id, rank) deferrable initially deferred
);

-- What each member suggested: one suggestion at a time per member, and several members may suggest the same
-- area. There is deliberately no key to session_spots. A suggestion is kept while the list is empty (fewer than
-- two starts are shared), and the list is built from the app's spots plus these. "here" labels the suggestion
-- "we are here already". Written by the server only; the oldest suggestion comes first on screen.
-- A member who leaves takes their suggestion with them. At most 8 different areas may be suggested in a
-- session; the server checks that under the session's lock.
create table if not exists public.spot_suggestions (
  session_id uuid not null,
  user_id uuid not null,
  area_id text not null check (char_length(area_id) between 1 and 60),
  here boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (session_id, user_id),
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);

-- "Works for me": one row per member and spot, any number of spots per member. This is the table a member
-- writes: their own approval, while the session is "locating". The key to session_spots means only a listed
-- spot can be approved, and an approval goes when its spot leaves the list or its member leaves.
create table if not exists public.spot_approvals (
  session_id uuid not null,
  area_id text not null,
  user_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (session_id, area_id, user_id),
  foreign key (session_id, area_id) references public.session_spots (session_id, area_id) on delete cascade,
  foreign key (session_id, user_id) references public.session_members (session_id, user_id) on delete cascade
);
create index if not exists spot_approvals_member_idx on public.spot_approvals (session_id, user_id);

-- A place a member proposes while the group is out (Roam). The host accepts it, which the server turns into a
-- stop, or dismisses it; the proposer may dismiss their own. A proposal is pending until it is resolved.
-- Written by the server only: it checks that the venue exists, and accepting one writes stops. At most 10 are
-- pending in a session and 3 per member; the server checks that under the session's lock. A proposal goes
-- with its proposer when they leave.
create table if not exists public.stop_proposals (
  id uuid primary key default gen_random_uuid(),
  session_id uuid not null references public.sessions (id) on delete cascade,
  venue_id text not null check (char_length(venue_id) between 1 and 160),
  proposed_by uuid not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'dismissed')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  resolved_by uuid references public.profiles (id) on delete set null,
  foreign key (session_id, proposed_by) references public.session_members (session_id, user_id) on delete cascade,
  -- Resolved or pending, never half of each.
  check ((status = 'pending') = (resolved_at is null)),
  check (resolved_by is null or resolved_at is not null)
);
create index if not exists stop_proposals_session_id_idx on public.stop_proposals (session_id, created_at);
create index if not exists stop_proposals_proposer_idx on public.stop_proposals (session_id, proposed_by);
create index if not exists stop_proposals_resolved_by_idx on public.stop_proposals (resolved_by);
-- The same place cannot wait for the host twice.
create unique index if not exists stop_proposals_one_pending_idx
  on public.stop_proposals (session_id, venue_id) where status = 'pending';

-- A place's id may be up to 160 characters (the 32 hawker centres saved from OneMap have ids of 86). The tables above carry that check
-- inline, which a project built before stage 4 does not have (it has 80 on slot_options and stops). So, as in the migration
-- 20261022000000, every check of the three tables that mentions venue_id is dropped by what it checks, whatever it is called, and the
-- checks of 160 are made again under the names Postgres gives an inline check.
do $venue_checks$
declare
  old_check record;
begin
  for old_check in
    select con.conrelid::regclass as table_name, con.conname as check_name
    from pg_constraint con
    where con.contype = 'c'
      and con.conrelid in (to_regclass('public.slot_options'), to_regclass('public.stops'), to_regclass('public.stop_proposals'))
      and pg_get_constraintdef(con.oid) like '%venue_id%'
  loop
    execute format('alter table %s drop constraint %I', old_check.table_name, old_check.check_name);
  end loop;
end;
$venue_checks$;
alter table public.slot_options add constraint slot_options_venue_id_check check (char_length(venue_id) <= 160);
alter table public.stops add constraint stops_venue_id_check check (char_length(venue_id) <= 160);
alter table public.stop_proposals add constraint stop_proposals_venue_id_check check (char_length(venue_id) between 1 and 160);

-- ── Fairness and routing ────────────────────────────────────────────────

-- How far each person travelled for a session: in, between stops, and home. Written by the server
-- when the session ends. delta_from_mean is positive for someone who travelled more than the
-- group's average. A person with ledger rows cannot be deleted: everyone's delta depends on theirs.
create table if not exists public.commute_ledger (
  session_id uuid not null references public.sessions (id) on delete cascade,
  user_id uuid not null references public.profiles (id) on delete restrict,
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

-- ── Helper functions for the access rules ───────────────────────────────
-- Each returns ids that belong to the signed-in user and nothing else, so calling one tells a
-- caller nothing about anybody else's sessions. They run with the owner's rights (security definer)
-- so a rule on session_members can ask about session_members without calling itself in a loop.
-- A rule uses them as "session_id in (select public.my_session_ids())", which runs once per query.

-- The sessions the signed-in user is in, whether joined or opted out. Used for reading.
create or replace function public.my_session_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.session_id from public.session_members m where m.user_id = (select auth.uid());
$$;

-- The sessions the signed-in user has joined that can still be changed. Used for writing: an
-- opted-out member, and anyone in a confirmed or finished session, edits nothing.
create or replace function public.my_open_session_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.session_id
  from public.session_members m
  join public.sessions s on s.id = m.session_id
  where m.user_id = (select auth.uid())
    and m.state = 'joined'
    and s.status in ('inviting', 'locating', 'voting');
$$;

-- The slots of the signed-in user's sessions. Used for reading options and votes.
create or replace function public.my_slot_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select sl.id
  from public.slots sl
  join public.session_members m on m.session_id = sl.session_id
  where m.user_id = (select auth.uid());
$$;

-- The slots the signed-in user may vote in right now: they have joined, the session is in the
-- Voting stage, and the slot has not been removed.
create or replace function public.my_votable_slot_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select sl.id
  from public.slots sl
  join public.sessions s on s.id = sl.session_id
  join public.session_members m on m.session_id = sl.session_id
  where m.user_id = (select auth.uid())
    and m.state = 'joined'
    and s.status = 'voting'
    and not sl.deleted;
$$;

-- The sessions the signed-in user has joined that are choosing where to meet. Used for "Works for me":
-- someone who opted out, and anyone once the host has confirmed, approves nothing.
--   select * from public.my_locating_session_ids();
create or replace function public.my_locating_session_ids()
returns setof uuid
language sql stable security definer set search_path = ''
as $$
  select m.session_id
  from public.session_members m
  join public.sessions s on s.id = m.session_id
  where m.user_id = (select auth.uid())
    and m.state = 'joined'
    and s.status = 'locating';
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

-- ── Functions the app calls ─────────────────────────────────────────────

-- invite_preview() used to return the session id and the member count as well. A function cannot change
-- its columns in place, so the old one is dropped (only when it still has them) and made again below.
do $invite_preview$
begin
  if exists (
    select 1 from pg_proc p
    where p.pronamespace = 'public'::regnamespace and p.proname = 'invite_preview'
      and pg_get_function_result(p.oid) like '%member_count%'
  ) then
    drop function public.invite_preview(text);
  end if;
end;
$invite_preview$;

-- What an invite link leads to, for the join page. Callable when logged out.
-- Returns no row when the link is revoked, expired or unknown, or the session can no longer be joined.
-- Gives the title, date, times and host's name and nothing else. An invitation to a named person
-- previews only for that person.
--   const { data } = await supabase.rpc('invite_preview', { invite_token: token })
create or replace function public.invite_preview(invite_token text)
returns table (title text, date date, start_time time, end_time time, host_name text)
language sql stable security definer set search_path = ''
as $$
  select s.title, s.date, s.start_time, s.end_time, coalesce(p.display_name, p.username)
  from public.invites i
  join public.sessions s on s.id = i.session_id
  join public.profiles p on p.id = s.host_id
  where i.token = invite_token
    and not i.revoked
    and i.expires_at > now()
    and i.declined_at is null
    and (i.invitee_id is null or (i.invitee_id = (select auth.uid()) and i.uses = 0))
    and s.status in ('inviting', 'locating', 'voting');
$$;

-- Join a session with an invite link or a personal invitation. Returns the session id.
-- Raises an error when the link is revoked, expired or unknown, when it is a personal invitation that is not
-- the caller's, was declined or was used, or when the session is already confirmed or over (all the same
-- error, so a token tells a stranger nothing), and when the session already has 30 joined members.
-- Someone already in the session, opted out or not, is left exactly as they are.
--   const { data: sessionId, error } = await supabase.rpc('join_session', { invite_token: token })
create or replace function public.join_session(invite_token text)
returns uuid
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
  target uuid;
  added integer;
begin
  if me is null then
    raise exception 'Sign in to join a session.' using errcode = '28000';
  end if;

  -- The session row is locked until the join is done, so two people cannot take the last place together.
  select i.session_id into target
  from public.invites i
  join public.sessions s on s.id = i.session_id
  where i.token = invite_token
    and not i.revoked
    and i.expires_at > now()
    and i.declined_at is null
    and (i.invitee_id is null or (i.invitee_id = me and i.uses = 0))
    and s.status in ('inviting', 'locating', 'voting')
  for update of s;

  if target is null then
    raise exception 'This invite link is no longer valid.' using errcode = 'P0002';
  end if;

  if exists (select 1 from public.session_members m where m.session_id = target and m.user_id = me) then
    return target;
  end if;

  if (select count(*) from public.session_members m where m.session_id = target and m.state = 'joined') >= 30 then
    raise exception 'This session is full.' using errcode = 'P0001', hint = 'session_full';
  end if;

  insert into public.session_members (session_id, user_id, role, state)
  values (target, me, 'guest', 'joined')
  on conflict (session_id, user_id) do nothing;
  get diagnostics added = row_count;

  if added = 1 then
    update public.invites set uses = uses + 1 where token = invite_token;
  end if;
  return target;
end;
$$;

-- The open invitations addressed to the signed-in user, newest first, for Home: enough to show the invitation
-- and to answer it, and nothing about the session beyond that. An invitation drops out once it is accepted,
-- declined, revoked or expired, or when the session is no longer open.
--   const { data } = await supabase.rpc('my_invitations')
create or replace function public.my_invitations()
returns table (token text, title text, date date, start_time time, end_time time, host_name text, invited_at timestamptz)
language sql stable security definer set search_path = ''
as $$
  select i.token, s.title, s.date, s.start_time, s.end_time, coalesce(p.display_name, p.username), i.created_at
  from public.invites i
  join public.sessions s on s.id = i.session_id
  join public.profiles p on p.id = s.host_id
  where i.invitee_id = (select auth.uid())
    and not i.revoked
    and i.declined_at is null
    and i.uses = 0
    and i.expires_at > now()
    and s.status in ('inviting', 'locating', 'voting')
    and not exists (
      select 1 from public.session_members m where m.session_id = s.id and m.user_id = i.invitee_id
    )
  order by i.created_at desc;
$$;

-- The invitee says no. The host sees the decline; the other members do not. Raises the same error as an
-- unknown token when the invitation is not the caller's, or is revoked or already accepted. Declining twice
-- does nothing the second time.
--   await supabase.rpc('decline_invite', { invite_token: token })
create or replace function public.decline_invite(invite_token text)
returns void
language plpgsql security definer set search_path = ''
as $$
declare
  me uuid := (select auth.uid());
begin
  if me is null then
    raise exception 'Sign in to answer an invitation.' using errcode = '28000';
  end if;
  update public.invites set declined_at = coalesce(declined_at, now())
  where token = invite_token and invitee_id = me and not revoked and uses = 0;
  if not found then
    raise exception 'This invitation is no longer valid.' using errcode = 'P0002';
  end if;
end;
$$;

-- Each joined member's private planner needs, for the server only (the service key). The backend
-- first loads the session as the signed-in user, which proves they are a member, then calls this.
--   const { data } = await serviceClient.rpc('session_member_needs', { sid: sessionId })
create or replace function public.session_member_needs(sid uuid)
returns table (user_id uuid, home_area_id text, dietary text[], budget_max_per_person numeric, needs_step_free boolean)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, pp.home_area_id, pp.dietary, pp.budget_max_per_person, pp.needs_step_free
  from public.session_members m
  join public.profile_private pp on pp.id = m.user_id
  where m.session_id = sid and m.state = 'joined';
$$;

-- Each joined member's commute balance over the last 90 days, from the ledger rows of their other sessions: the
-- sum of delta_from_mean, clamped to plus or minus 14,400 minutes. Positive means they travelled more than
-- the average. For the server only (the service key); the planner uses it to favour whoever has travelled most.
--   const { data } = await serviceClient.rpc('session_travel_debt', { sid: sessionId })
create or replace function public.session_travel_debt(sid uuid)
returns table (user_id uuid, debt_minutes numeric)
language sql stable security definer set search_path = ''
as $$
  select m.user_id, greatest(-14400, least(14400, coalesce(sum(l.delta_from_mean), 0)))
  from public.session_members m
  left join public.commute_ledger l
    on l.user_id = m.user_id and l.session_id <> sid and l.created_at > now() - interval '90 days'
  where m.session_id = sid and m.state = 'joined'
  group by m.user_id;
$$;

-- Every write the server makes to a session's plan, in one transaction (the meeting spots, the slots and options of voting, and the
-- stops of a confirmed plan with the ledger of a finished outing). It locks the session row and writes NOTHING unless the version and the
-- status the server loaded are still current, so a late answer never undoes the host's confirm. It also enforces the rules JavaScript
-- must not be trusted with: only the host's confirm or known place moves a status (inviting or locating to voting, with an area), and
-- leaving inviting needs two joined members after the patch's ops; a pinned meeting area ('voted' or 'chosen') is never moved by a
-- recompute, and is set only with that confirm; the host is never opted out or removed; slots, options and their votes are written only
-- while the session is voting; the plan's moves are voting to confirmed (stops, and two joined people who voted), confirmed to voting
-- (the plan is opened again) and confirmed to completed (the ledger, whose deltas sum to zero); stops are written only while the
-- session is confirmed; and the version rises, and anything is written, only when a value differs from the stored row. Spots get the
-- time the server loaded its inputs (loaded_at) as their computed_at. Options and stops are written as a difference, so a kept option
-- keeps its votes. Returns the version after the write, or null when the session moved on. The server only (the service key); a browser
-- cannot call it.
-- The patch is described in db/migrations/20261020000000_jio_apply_session_plan.sql (stage 3),
-- db/migrations/20261022000000_jio_apply_session_plan_slots.sql (stage 4: slots, options, votes, the radius) and
-- db/migrations/20261023000000_jio_apply_session_plan_stops.sql (stage 5: the plan, its order, Roam proposals, finishing).
--   const { data } = await serviceClient.rpc('apply_session_plan', { sid, expected_version: 4, expected_status: 'locating', patch })
create or replace function public.apply_session_plan(sid uuid, expected_version bigint, expected_status text, patch jsonb)
returns bigint
language plpgsql set search_path = ''
as $$
declare
  s public.sessions%rowtype;
  sp jsonb;
  meeting jsonb;
  op jsonb;
  item jsonb;
  opt jsonb;
  hit bigint;
  changed boolean := false;
  new_status text;
  lost_approvals boolean := false;
  banner_text text;
  stamp timestamptz;
  meeting_changed boolean := false;
  banner_changed boolean := false;
  banner_new jsonb;
  banner_stamped boolean := false;
  radius_changed boolean := false;
  travel_changed boolean := false;
  slot_row public.slots%rowtype;
  v_category text;
  v_slot uuid;
  n_start integer;
  n_duration integer;
  n_picks integer;
  n_last boolean;
  n_deleted boolean;
  n_details jsonb;
  unknown_key text;
  note_new jsonb;
  note_changed boolean := false;
  suggestion_new jsonb;
  suggestion_changed boolean := false;
  start_changed boolean := false;
  replan_new jsonb;
  replan_changed boolean := false;
  reopened boolean := false;
  v_count bigint;
  v_distinct bigint;
  v_max integer;
  v_venues bigint;
  stop_row public.stops%rowtype;
begin
  if patch is null or jsonb_typeof(patch) <> 'object' then
    raise exception 'The plan must be a JSON object.' using errcode = '22023';
  end if;
  -- A part of the plan this function does not know is refused, never dropped: a typo, or a server newer than this function, must be
  -- told. (Checked before the session is read, so a stale write with a typo is refused too.)
  select keys.k into unknown_key
  from jsonb_object_keys(patch) as keys(k)
  where keys.k not in ('ops', 'spots', 'slots', 'stops', 'stop_options', 'ledger', 'session', 'loaded_at', 'recomputed', 'banner_text')
  limit 1;
  if unknown_key is not null then
    raise exception 'The plan has a part this function does not know: %.', unknown_key using errcode = '22023';
  end if;
  if patch ? 'session' then
    if jsonb_typeof(patch -> 'session') <> 'object' then
      raise exception 'The session part of the plan must be a JSON object.' using errcode = '22023';
    end if;
    select keys.k into unknown_key
    from jsonb_object_keys(patch -> 'session') as keys(k)
    where keys.k not in ('status', 'meeting', 'banner', 'radius_meters', 'replan', 'plan_start_minute', 'order_note', 'order_suggestion')
    limit 1;
    if unknown_key is not null then
      raise exception 'The session part of the plan has a part this function does not know: %.', unknown_key using errcode = '22023';
    end if;
  end if;
  sp := coalesce(patch -> 'session', '{}'::jsonb);
  meeting := sp -> 'meeting';

  -- The session is locked until this function returns, so two writes cannot interleave.
  select * into s from public.sessions where id = sid for update;
  if not found or s.plan_version <> expected_version or s.status <> expected_status then
    return null;
  end if;

  -- When the server loaded the members the spots are worked out from (before the planner ran), else now.
  -- Never later than the database's own clock, so a server clock that runs fast cannot hide a later change.
  stamp := least(coalesce(nullif(patch ->> 'loaded_at', '')::timestamptz, now()), now());
  new_status := coalesce(sp ->> 'status', s.status);

  -- Rule 4: a pinned meeting area stays.
  if sp ? 'meeting' and s.meeting_method in ('voted', 'chosen')
     and ((meeting ->> 'area_id') is distinct from s.meeting_area_id
          or (meeting ->> 'method') is distinct from s.meeting_method) then
    raise exception 'The meeting area was chosen and cannot be changed by a recompute.'
      using errcode = 'P0001', hint = 'area_pinned';
  end if;

  -- Rule 1: the moves are the host's confirm (or known place), from inviting or locating to voting, with an area; and, from stage 5,
  -- the plan's: the host's confirm of the stops (voting to confirmed), opening the plan again (confirmed to voting) and finishing
  -- the outing (confirmed to completed). (The two-people check for leaving inviting comes after the ops below.)
  if new_status <> s.status then
    if not ((s.status in ('inviting', 'locating') and new_status = 'voting' and coalesce(meeting ->> 'area_id', '') <> '')
            or (s.status = 'voting' and new_status = 'confirmed')
            or (s.status = 'confirmed' and new_status in ('voting', 'completed'))) then
      raise exception 'A session cannot go from % to % this way.', s.status, new_status
        using errcode = 'P0001', hint = 'status_transition';
    end if;
    changed := true;
  end if;
  reopened := s.status = 'confirmed' and new_status = 'voting';

  -- Rule 5: a pin only with a confirm. Setting 'voted' or 'chosen' needs the move to voting in this patch, or the same pin
  -- (method and area) already stored.
  if (meeting ->> 'method') in ('voted', 'chosen') and new_status = s.status
     and not (s.meeting_method is not distinct from (meeting ->> 'method')
              and s.meeting_area_id is not distinct from (meeting ->> 'area_id')) then
    raise exception 'A meeting area is pinned only when the host confirms it.'
      using errcode = 'P0001', hint = 'pin_without_confirm';
  end if;

  -- Rule 7: slots and options are written only while the session is voting (after this patch).
  if patch ? 'slots' and new_status <> 'voting' then
    raise exception 'Slots and options are written only while the session is voting.'
      using errcode = 'P0001', hint = 'slots_status';
  end if;

  -- Rule 8 (stage 5, the plan): the stops, the details of a place put in a stop, the order note and the plan's start are written only
  -- while the session is confirmed (after this patch); the suggested order only while it is voting (it is cleared by opening the plan
  -- again, which this function does itself); the ledger only with the move to completed. Confirming needs stops.
  if (patch ? 'stops' or patch ? 'stop_options' or nullif(sp -> 'plan_start_minute', 'null'::jsonb) is not null
      or nullif(sp -> 'order_note', 'null'::jsonb) is not null) and new_status <> 'confirmed' then
    raise exception 'The stops and the order of the plan are written only while the session is confirmed.'
      using errcode = 'P0001', hint = 'stops_status';
  end if;
  if nullif(sp -> 'order_suggestion', 'null'::jsonb) is not null and not (s.status = 'voting' and new_status = 'voting') then
    raise exception 'The suggested order is written only while the session is voting.'
      using errcode = 'P0001', hint = 'order_status';
  end if;
  if patch ? 'ledger' and not (s.status = 'confirmed' and new_status = 'completed') then
    raise exception 'The ledger is written only when the outing is finished.'
      using errcode = 'P0001', hint = 'ledger_status';
  end if;
  if s.status = 'voting' and new_status = 'confirmed'
     and (not (patch ? 'stops') or jsonb_typeof(patch -> 'stops') <> 'array' or jsonb_array_length(patch -> 'stops') = 0) then
    raise exception 'A plan needs at least one stop before it can be confirmed.'
      using errcode = 'P0001', hint = 'stops_missing';
  end if;

  -- Members, suggestions, approvals, votes and options, in the order given. Rule 6: the host is never opted out or removed here.
  for op in select * from jsonb_array_elements(coalesce(patch -> 'ops', '[]'::jsonb)) loop
    case op ->> 'op'
      when 'opt_out' then
        if (op ->> 'user_id')::uuid = s.host_id then
          raise exception 'The host cannot opt out.' using errcode = 'P0001', hint = 'host_member';
        end if;
        update public.session_members m set state = 'opted_out'
        where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid and m.state = 'joined';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.spot_approvals a where a.session_id = sid and a.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.spot_suggestions g where g.session_id = sid and g.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.votes v using public.slots sl
        where sl.id = v.slot_id and sl.session_id = sid and v.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'rejoin' then
        update public.session_members m set state = 'joined'
        where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid and m.state = 'opted_out';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'remove_member' then
        if (op ->> 'user_id')::uuid = s.host_id then
          raise exception 'The host cannot be removed.' using errcode = 'P0001', hint = 'host_member';
        end if;
        delete from public.session_members m where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        delete from public.votes v using public.slots sl
        where sl.id = v.slot_id and sl.session_id = sid and v.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'suggest' then
        -- One suggestion per member. Suggesting the same again changes nothing; a different one counts as newest.
        insert into public.spot_suggestions as g (session_id, user_id, area_id, here)
        values (sid, (op ->> 'user_id')::uuid, op ->> 'area_id', coalesce((op ->> 'here')::boolean, false))
        on conflict (session_id, user_id) do update
          set area_id = excluded.area_id, here = excluded.here, created_at = now()
          where (g.area_id, g.here) is distinct from (excluded.area_id, excluded.here);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'unsuggest' then
        delete from public.spot_suggestions g where g.session_id = sid and g.user_id = (op ->> 'user_id')::uuid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'clear_approvals' then
        delete from public.spot_approvals a where a.session_id = sid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'clear_suggestions' then
        delete from public.spot_suggestions g where g.session_id = sid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'clear_votes' then
        -- Rule 7: votes are cleared only in a voting session (or one that this patch opens again: stage 5's re-plan). The meeting
        -- area moved, so every vote is for a place that no longer belongs to it.
        if not (s.status = 'voting' or reopened) then
          raise exception 'Votes are cleared only while the session is voting.' using errcode = 'P0001', hint = 'slots_status';
        end if;
        delete from public.votes v using public.slots sl where sl.id = v.slot_id and sl.session_id = sid;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      when 'swap_option' then
        -- Rule 7 again. The place changes in place, so the votes for it follow it; when the other place is already an option, the
        -- votes move to it and this one goes.
        if s.status <> 'voting' then
          raise exception 'An option is swapped only while the session is voting.' using errcode = 'P0001', hint = 'slots_status';
        end if;
        select sl.id into v_slot from public.slots sl where sl.session_id = sid and sl.category = op ->> 'category';
        if v_slot is null then
          raise exception 'This session has no % slot.', op ->> 'category' using errcode = 'P0001', hint = 'slot_missing';
        end if;
        if (op ->> 'from') is not distinct from (op ->> 'to') then
          -- The same place: nothing to swap. (Without this the votes would move onto the place, and then the place would be deleted
          -- as "the other one", taking the option and every vote with it.)
          null;
        elsif exists (select 1 from public.slot_options o where o.slot_id = v_slot and o.venue_id = op ->> 'to') then
          update public.votes v set venue_id = op ->> 'to' where v.slot_id = v_slot and v.venue_id = op ->> 'from';
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
          delete from public.slot_options o where o.slot_id = v_slot and o.venue_id = op ->> 'from';
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
        else
          update public.slot_options o set venue_id = op ->> 'to' where o.slot_id = v_slot and o.venue_id = op ->> 'from';
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
        end if;
      when 'propose' then
        -- Stage 5 (Roam): a joined member puts a place forward as the next stop, while the plan is confirmed. A place already in the
        -- plan cannot be proposed; one already waiting stays its first proposer's and this changes nothing. The limits (a full plan of
        -- 8 stops, 3 waiting for a member, 10 for the session) are checked here, under the session's lock.
        if not (s.status = 'confirmed' and new_status = 'confirmed') then
          raise exception 'A place is proposed only while the plan is confirmed.' using errcode = 'P0001', hint = 'proposal_status';
        end if;
        if not exists (select 1 from public.session_members m where m.session_id = sid and m.user_id = (op ->> 'user_id')::uuid and m.state = 'joined') then
          raise exception 'Only a joined member can propose a place.' using errcode = 'P0001', hint = 'proposal_member';
        end if;
        if exists (select 1 from public.stops st where st.session_id = sid and st.venue_id = op ->> 'venue_id') then
          raise exception 'That place is already in the plan.' using errcode = 'P0001', hint = 'already_a_stop';
        end if;
        if not exists (select 1 from public.stop_proposals p where p.session_id = sid and p.venue_id = op ->> 'venue_id' and p.status = 'pending') then
          if (select count(*) from public.stops st where st.session_id = sid) >= 8 then
            raise exception 'The plan already has the most stops it can hold.' using errcode = 'P0001', hint = 'plan_full';
          end if;
          if (select count(*) from public.stop_proposals p where p.session_id = sid and p.status = 'pending') >= 10
             or (select count(*) from public.stop_proposals p where p.session_id = sid and p.status = 'pending' and p.proposed_by = (op ->> 'user_id')::uuid) >= 3 then
            raise exception 'Too many places are waiting for an answer.' using errcode = 'P0001', hint = 'too_many_proposals';
          end if;
          insert into public.stop_proposals (id, session_id, venue_id, proposed_by)
          values (coalesce(nullif(op ->> 'id', '')::uuid, gen_random_uuid()), sid, op ->> 'venue_id', (op ->> 'user_id')::uuid);
          changed := true;
        end if;
      when 'resolve_proposal' then
        -- The host's answer to a proposal, or the proposer taking it back ("status" is accepted or dismissed). The stop an accepted
        -- proposal becomes is in the same patch's stops. One already answered changes nothing.
        if not (s.status = 'confirmed' and new_status = 'confirmed') then
          raise exception 'A proposal is answered only while the plan is confirmed.' using errcode = 'P0001', hint = 'proposal_status';
        end if;
        update public.stop_proposals p
        set status = op ->> 'status', resolved_at = now(), resolved_by = nullif(op ->> 'by', '')::uuid
        where p.id = (op ->> 'proposal_id')::uuid and p.session_id = sid and p.status = 'pending';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      else
        raise exception 'Unknown operation %.', op ->> 'op' using errcode = '22023';
    end case;
  end loop;

  -- Rule 2: leaving inviting needs two joined members, counted after the ops.
  if s.status = 'inviting' and new_status <> s.status
     and (select count(*) from public.session_members m where m.session_id = sid and m.state = 'joined') < 2 then
    raise exception 'A session needs at least two people before it can start.'
      using errcode = 'P0001', hint = 'needs_two_people';
  end if;

  -- The spots, as a difference.
  if patch ? 'spots' then
    if jsonb_typeof(patch -> 'spots') <> 'array' then
      raise exception 'The spots must be a JSON list.' using errcode = '22023';
    end if;

    -- Does the deletion below take an approval with it? (Approvals the ops above removed are already gone.)
    select exists (
      select 1 from public.spot_approvals a
      where a.session_id = sid
        and not exists (select 1 from jsonb_array_elements(patch -> 'spots') e where e ->> 'area_id' = a.area_id)
    ) into lost_approvals;

    delete from public.session_spots x
    where x.session_id = sid
      and not exists (select 1 from jsonb_array_elements(patch -> 'spots') e where e ->> 'area_id' = x.area_id);
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;

    -- A listed spot is written only if something about it changed, so its time of working out is left alone otherwise. When it
    -- is written, its time of working out is when the inputs were loaded (stamp), not when the write happens.
    for item in select * from jsonb_array_elements(patch -> 'spots') loop
      insert into public.session_spots as x (session_id, area_id, rank, worst_minutes, mean_minutes, travel_minutes, approximate, computed_at)
      values (sid, item ->> 'area_id', (item ->> 'rank')::integer, (item ->> 'worst_minutes')::numeric,
              (item ->> 'mean_minutes')::numeric, coalesce(item -> 'travel_minutes', '{}'::jsonb),
              coalesce((item ->> 'approximate')::boolean, false), stamp)
      on conflict (session_id, area_id) do update
        set rank = excluded.rank, worst_minutes = excluded.worst_minutes, mean_minutes = excluded.mean_minutes,
            travel_minutes = excluded.travel_minutes, approximate = excluded.approximate, computed_at = stamp
        where (x.rank, x.worst_minutes, x.mean_minutes, x.travel_minutes, x.approximate)
              is distinct from (excluded.rank, excluded.worst_minutes, excluded.mean_minutes, excluded.travel_minutes, excluded.approximate);
      get diagnostics hit = row_count;
      if hit > 0 then changed := true; end if;
    end loop;

    -- A run that worked the spots out again with the planner says so (`recomputed`): the list is now as current as any member's
    -- row, even when no number moved, so the time of working out is brought forward on every spot (to when the inputs were
    -- loaded). That is not a change: the version stays. (A run that only kept the stored spots does not say it, so it never
    -- hides a start that was not priced.)
    if coalesce((patch ->> 'recomputed')::boolean, false) then
      update public.session_spots x set computed_at = stamp where x.session_id = sid and x.computed_at < stamp;
    end if;

    -- The group is told only when the deletion removed an approval.
    if lost_approvals then
      banner_text := coalesce(nullif(patch ->> 'banner_text', ''), 'Some spots are no longer on the list, so approvals for them were removed.');
    end if;
  end if;

  -- The slots and their options, as a difference. A kept option keeps its votes; a dropped one takes them by foreign key.
  if patch ? 'slots' then
    if jsonb_typeof(patch -> 'slots') <> 'array' then
      raise exception 'The slots must be a JSON list.' using errcode = '22023';
    end if;
    for item in select * from jsonb_array_elements(patch -> 'slots') loop
      if jsonb_typeof(item) <> 'object' then
        raise exception 'Each slot must be a JSON object.' using errcode = '22023';
      end if;
      v_category := item ->> 'category';

      if coalesce((item ->> 'remove')::boolean, false) then
        delete from public.slots sl where sl.session_id = sid and sl.category = v_category;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        continue;
      end if;

      select * into slot_row from public.slots sl where sl.session_id = sid and sl.category = v_category;
      if not found then
        n_deleted := coalesce((item ->> 'deleted')::boolean, false);
        insert into public.slots (session_id, category, start_minute, duration_minutes, picks, is_last, deleted, details)
        values (sid, v_category, (item ->> 'start_minute')::integer, (item ->> 'duration_minutes')::integer,
                coalesce((item ->> 'picks')::integer, 0), coalesce((item ->> 'is_last')::boolean, false), n_deleted,
                coalesce(item -> 'details', '{}'::jsonb))
        returning id into v_slot;
        changed := true;
      else
        v_slot := slot_row.id;
        n_start := coalesce((item ->> 'start_minute')::integer, slot_row.start_minute);
        n_duration := coalesce((item ->> 'duration_minutes')::integer, slot_row.duration_minutes);
        n_picks := coalesce((item ->> 'picks')::integer, slot_row.picks);
        n_last := coalesce((item ->> 'is_last')::boolean, slot_row.is_last);
        n_deleted := coalesce((item ->> 'deleted')::boolean, slot_row.deleted);
        n_details := case when item ? 'details' then item -> 'details' else slot_row.details end;
        update public.slots sl
        set start_minute = n_start, duration_minutes = n_duration, picks = n_picks, is_last = n_last, deleted = n_deleted, details = n_details
        where sl.id = v_slot
          and (sl.start_minute, sl.duration_minutes, sl.picks, sl.is_last, sl.deleted, sl.details)
              is distinct from (n_start, n_duration, n_picks, n_last, n_deleted, n_details);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      end if;

      if n_deleted then
        -- A removed slot has no options, and so no votes.
        delete from public.slot_options o where o.slot_id = v_slot;
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      elsif item ? 'options' then
        if jsonb_typeof(item -> 'options') <> 'array' then
          raise exception 'The options of a slot must be a JSON list.' using errcode = '22023';
        end if;
        delete from public.slot_options o
        where o.slot_id = v_slot
          and not exists (select 1 from jsonb_array_elements(item -> 'options') e where e ->> 'venue_id' = o.venue_id);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
        for opt in select * from jsonb_array_elements(item -> 'options') loop
          insert into public.slot_options as o (slot_id, venue_id, rank, score, source, added_by, details)
          values (v_slot, opt ->> 'venue_id', (opt ->> 'rank')::integer, (opt ->> 'score')::numeric,
                  coalesce(opt ->> 'source', 'planner'), (opt ->> 'added_by')::uuid, coalesce(opt -> 'details', '{}'::jsonb))
          on conflict (slot_id, venue_id) do update
            set rank = excluded.rank, score = excluded.score, details = excluded.details
            where (o.rank, o.score, o.details) is distinct from (excluded.rank, excluded.score, excluded.details);
          get diagnostics hit = row_count;
          if hit > 0 then changed := true; end if;
        end loop;
      end if;
    end loop;

    -- Votes belong to the person, not to their membership, so nothing took a leaver's or an opted-out member's votes with them if
    -- they were cast a moment before the change: they go now.
    delete from public.votes v using public.slots sl
    where sl.id = v.slot_id and sl.session_id = sid
      and not exists (select 1 from public.session_members m where m.session_id = sid and m.user_id = v.user_id and m.state = 'joined');
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;
  end if;

  -- ── Stage 5: the plan ────────────────────────────────────────────────────
  -- Leaving confirmed: the proposals still waiting are dismissed (nobody is left to answer them). Opening the plan again also takes
  -- the stops away (the order note and the plan's start go in the session update below).
  if s.status = 'confirmed' and new_status <> 'confirmed' then
    update public.stop_proposals p set status = 'dismissed', resolved_at = now()
    where p.session_id = sid and p.status = 'pending';
    if reopened then
      delete from public.stops st where st.session_id = sid;
    end if;
  end if;

  -- Rule 8, the checks that need the rows: confirming needs two joined people who voted.
  if s.status = 'voting' and new_status = 'confirmed' then
    select count(distinct v.user_id) into v_count
    from public.votes v
    join public.slots sl on sl.id = v.slot_id and sl.session_id = sid and not sl.deleted
    join public.session_members m on m.session_id = sid and m.user_id = v.user_id and m.state = 'joined';
    if v_count < 2 then
      raise exception 'At least two people need to vote before the plan can be confirmed.'
        using errcode = 'P0001', hint = 'not_enough_votes';
    end if;
  end if;

  -- The stops, as a difference: a listed stop with an id is updated where it differs, one without an id is made, and one not listed
  -- goes. Each item is the complete row. The order (seq) is checked at the end: 0, 1, 2, ... with no gap and no repeat, and no place
  -- twice. A plan has up to 8 stops and, once confirmed, at least one.
  if patch ? 'stops' then
    if jsonb_typeof(patch -> 'stops') <> 'array' then
      raise exception 'The stops must be a JSON list.' using errcode = '22023';
    end if;
    if jsonb_array_length(patch -> 'stops') > 8 then
      raise exception 'A plan holds up to 8 stops.' using errcode = 'P0001', hint = 'too_many_stops';
    end if;
    delete from public.stops st
    where st.session_id = sid
      and not exists (select 1 from jsonb_array_elements(patch -> 'stops') e where e ->> 'id' = st.id::text);
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;
    for item in select * from jsonb_array_elements(patch -> 'stops') loop
      if jsonb_typeof(item) <> 'object' then
        raise exception 'Each stop must be a JSON object.' using errcode = '22023';
      end if;
      if nullif(item ->> 'slot_id', '') is not null
         and not exists (select 1 from public.slots sl where sl.id = (item ->> 'slot_id')::uuid and sl.session_id = sid) then
        raise exception 'A stop names a slot that is not in this session.' using errcode = 'P0001', hint = 'stop_slot';
      end if;
      if nullif(item ->> 'id', '') is not null then
        select * into stop_row from public.stops st where st.id = (item ->> 'id')::uuid and st.session_id = sid;
        if not found then
          raise exception 'A stop is not in this session.' using errcode = 'P0001', hint = 'stop_missing';
        end if;
        update public.stops st
        set seq = (item ->> 'seq')::integer, slot_id = nullif(item ->> 'slot_id', '')::uuid, category = item ->> 'category',
            venue_id = item ->> 'venue_id', planned_start_minute = (item ->> 'planned_start_minute')::integer,
            duration_minutes = (item ->> 'duration_minutes')::integer, travel_mode = item ->> 'travel_mode',
            travel_minutes = (item ->> 'travel_minutes')::integer, not_before_minute = (item ->> 'not_before_minute')::integer
        where st.id = stop_row.id
          and (st.seq, st.slot_id, st.category, st.venue_id, st.planned_start_minute, st.duration_minutes, st.travel_mode, st.travel_minutes, st.not_before_minute)
              is distinct from ((item ->> 'seq')::integer, nullif(item ->> 'slot_id', '')::uuid, item ->> 'category', item ->> 'venue_id',
                                (item ->> 'planned_start_minute')::integer, (item ->> 'duration_minutes')::integer, item ->> 'travel_mode',
                                (item ->> 'travel_minutes')::integer, (item ->> 'not_before_minute')::integer);
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      else
        insert into public.stops (session_id, seq, slot_id, category, venue_id, planned_start_minute, duration_minutes, travel_mode, travel_minutes, not_before_minute)
        values (sid, (item ->> 'seq')::integer, nullif(item ->> 'slot_id', '')::uuid, item ->> 'category', item ->> 'venue_id',
                (item ->> 'planned_start_minute')::integer, (item ->> 'duration_minutes')::integer, item ->> 'travel_mode',
                (item ->> 'travel_minutes')::integer, (item ->> 'not_before_minute')::integer);
        changed := true;
      end if;
    end loop;
    select count(*), count(distinct st.seq), coalesce(max(st.seq), -1), count(distinct st.venue_id)
    into v_count, v_distinct, v_max, v_venues
    from public.stops st where st.session_id = sid;
    if v_count = 0 then
      raise exception 'A confirmed plan keeps at least one stop.' using errcode = 'P0001', hint = 'last_stop';
    end if;
    if v_distinct <> v_count or v_max <> v_count - 1 then
      raise exception 'The stops must be numbered 0, 1, 2 ... with no gap and no repeat.' using errcode = 'P0001', hint = 'stop_order';
    end if;
    if v_venues <> v_count then
      raise exception 'A place cannot be two stops.' using errcode = 'P0001', hint = 'stop_duplicate';
    end if;
    -- Confirming: every stop is the place the group chose for a slot, so it must be an option of that slot.
    if s.status = 'voting' and exists (
      select 1 from public.stops st
      where st.session_id = sid
        and (st.slot_id is null or not exists (select 1 from public.slot_options o where o.slot_id = st.slot_id and o.venue_id = st.venue_id))
    ) then
      raise exception 'A stop is not one of the places the group could vote for.' using errcode = 'P0001', hint = 'stop_not_option';
    end if;
  end if;

  -- The details of a place put in a stop (a replaced stop): the new place is kept as an option of the stop's slot with what the
  -- planner said about it, and the place it replaces leaves the slot's options (its votes go by foreign key). Nothing else about the
  -- slot changes.
  if patch ? 'stop_options' then
    if jsonb_typeof(patch -> 'stop_options') <> 'array' then
      raise exception 'The stop options must be a JSON list.' using errcode = '22023';
    end if;
    for item in select * from jsonb_array_elements(patch -> 'stop_options') loop
      v_slot := (item ->> 'slot_id')::uuid;
      if not exists (select 1 from public.slots sl where sl.id = v_slot and sl.session_id = sid) then
        raise exception 'A stop option names a slot that is not in this session.' using errcode = 'P0001', hint = 'stop_slot';
      end if;
      if nullif(item ->> 'replaces', '') is not null and (item ->> 'replaces') is distinct from (item ->> 'venue_id') then
        delete from public.slot_options o where o.slot_id = v_slot and o.venue_id = item ->> 'replaces';
        get diagnostics hit = row_count;
        if hit > 0 then changed := true; end if;
      end if;
      insert into public.slot_options as o (slot_id, venue_id, rank, score, source, added_by, details)
      values (v_slot, item ->> 'venue_id', (item ->> 'rank')::integer, (item ->> 'score')::numeric,
              coalesce(item ->> 'source', 'planner'), (item ->> 'added_by')::uuid, coalesce(item -> 'details', '{}'::jsonb))
      on conflict (slot_id, venue_id) do update
        set rank = excluded.rank, score = excluded.score, details = excluded.details
        where (o.rank, o.score, o.details) is distinct from (excluded.rank, excluded.score, excluded.details);
      get diagnostics hit = row_count;
      if hit > 0 then changed := true; end if;
    end loop;
  end if;

  -- The ledger, written once when the outing is finished: one row for each person in it, and the deltas sum to zero (the ledger moves
  -- effort around, it never makes it). Each person must be a joined member. A row that is already there stays (a retry changes nothing).
  if patch ? 'ledger' then
    if jsonb_typeof(patch -> 'ledger') <> 'array' then
      raise exception 'The ledger must be a JSON list.' using errcode = '22023';
    end if;
    if exists (
      select 1 from jsonb_array_elements(patch -> 'ledger') e
      where not exists (select 1 from public.session_members m where m.session_id = sid and m.user_id = (e ->> 'user_id')::uuid and m.state = 'joined')
    ) then
      raise exception 'The ledger names someone who is not a joined member.' using errcode = 'P0001', hint = 'ledger_member';
    end if;
    if (select coalesce(sum((e ->> 'delta_from_mean')::numeric), 0) from jsonb_array_elements(patch -> 'ledger') e) <> 0 then
      raise exception 'The ledger''s deltas must sum to zero.' using errcode = 'P0001', hint = 'ledger_sum';
    end if;
    insert into public.commute_ledger (session_id, user_id, minutes_in, minutes_between, minutes_home, delta_from_mean)
    select sid, (e ->> 'user_id')::uuid, (e ->> 'minutes_in')::integer, coalesce((e ->> 'minutes_between')::integer, 0),
           (e ->> 'minutes_home')::integer, (e ->> 'delta_from_mean')::numeric
    from jsonb_array_elements(patch -> 'ledger') e
    on conflict (session_id, user_id) do nothing;
    get diagnostics hit = row_count;
    if hit > 0 then changed := true; end if;
  end if;

  -- Rule 3: the session section is a change only where a value differs from the stored row. The meeting is compared as it would
  -- be written, after rounding; the banner as stored.
  if sp ? 'meeting' then
    meeting_changed := (s.meeting_area_id, s.meeting_method, s.meeting_max_minutes, s.meeting_total_minutes, s.meeting_count, s.meeting_approximate)
      is distinct from (meeting ->> 'area_id', meeting ->> 'method', round((meeting ->> 'max_minutes')::numeric)::integer,
                        round((meeting ->> 'total_minutes')::numeric)::integer, round((meeting ->> 'count')::numeric)::integer,
                        (meeting ->> 'approximate')::boolean);
  end if;
  if sp ? 'meeting' and jsonb_typeof(meeting) = 'object' and meeting ? 'travel' then
    travel_changed := exists (
      select 1 from public.session_members m
      where m.session_id = sid and m.state = 'joined' and m.travel_minutes is not null
        and m.travel_minutes is distinct from case
          when (meeting -> 'travel') ? (m.user_id)::text then round(((meeting -> 'travel') ->> (m.user_id)::text)::numeric)::integer
          else null end
    );
  end if;
  -- The banner rule (documented, deliberate): a notice is a change only where it differs from the stored one apart from its time ("at"),
  -- so the same words sent again after a run that moved nothing are not written, keep their old time, and are not shown again to
  -- someone who dismissed them; a different notice, or none ("banner": null), is a change. A notice sent without a time is stamped
  -- with the database's clock when it is written; one sent with a time is written as it is.
  if sp ? 'banner' then
    banner_new := nullif(sp -> 'banner', 'null'::jsonb);
    -- A banner sent without its time is stamped by the database's clock when it is written, so a newer notice always has a later
    -- `at` than an older one. It differs from the stored one only apart from that time.
    if banner_new is not null and jsonb_typeof(banner_new) = 'object' and not (banner_new ? 'at') then
      banner_stamped := true;
      banner_changed := (s.banner - 'at') is distinct from banner_new;
    else
      banner_changed := s.banner is distinct from banner_new;
    end if;
  end if;
  if sp ? 'radius_meters' then
    radius_changed := s.radius_meters is distinct from (sp ->> 'radius_meters')::integer;
  end if;
  -- Stage 5: the order note (a sentence and who chose the order, as a pair), the suggested order, the plan's start and the pending
  -- "plan again?" prompt, each a change only where it differs from the stored value. All four are cleared when the plan is opened again
  -- (below).
  if sp ? 'order_note' then
    note_new := nullif(sp -> 'order_note', 'null'::jsonb);
    if note_new is not null and jsonb_typeof(note_new) <> 'object' then
      raise exception 'The order note must be a JSON object or null.' using errcode = '22023';
    end if;
    note_changed := (s.order_reason, s.order_source) is distinct from (note_new ->> 'reason', note_new ->> 'source');
  end if;
  if sp ? 'order_suggestion' then
    suggestion_new := nullif(sp -> 'order_suggestion', 'null'::jsonb);
    suggestion_changed := s.order_suggestion is distinct from suggestion_new;
  end if;
  if sp ? 'plan_start_minute' then
    start_changed := s.plan_start_minute is distinct from (sp ->> 'plan_start_minute')::integer;
  end if;
  if sp ? 'replan' then
    replan_new := nullif(sp -> 'replan', 'null'::jsonb);
    if replan_new is not null and jsonb_typeof(replan_new) <> 'object' then
      raise exception 'The re-plan prompt must be a JSON object or null.' using errcode = '22023';
    end if;
    replan_changed := s.replan is distinct from replan_new;
  end if;
  if meeting_changed or travel_changed or banner_changed or radius_changed or banner_text is not null
     or note_changed or suggestion_changed or start_changed or replan_changed then
    changed := true;
  end if;
  if not changed then
    return s.plan_version;
  end if;

  -- Each joined member's own minutes to the confirmed area, written only where they differ from the stored minutes, so a member's row
  -- (and its updated_at) is not touched by a patch that repeats it.
  if sp ? 'meeting' and jsonb_typeof(meeting) = 'object' and meeting ? 'travel' then
    update public.session_members m
    set travel_minutes = case
      when (meeting -> 'travel') ? (m.user_id)::text then round(((meeting -> 'travel') ->> (m.user_id)::text)::numeric)::integer
      else null end
    where m.session_id = sid and m.state = 'joined'
      and m.travel_minutes is distinct from case
        when (meeting -> 'travel') ? (m.user_id)::text then round(((meeting -> 'travel') ->> (m.user_id)::text)::numeric)::integer
        else null end;
  end if;

  update public.sessions set
    status = new_status,
    radius_meters = case when radius_changed then (sp ->> 'radius_meters')::integer else radius_meters end,
    meeting_area_id = case when meeting_changed then meeting ->> 'area_id' else meeting_area_id end,
    meeting_method = case when meeting_changed then meeting ->> 'method' else meeting_method end,
    meeting_max_minutes = case when meeting_changed then round((meeting ->> 'max_minutes')::numeric)::integer else meeting_max_minutes end,
    meeting_total_minutes = case when meeting_changed then round((meeting ->> 'total_minutes')::numeric)::integer else meeting_total_minutes end,
    meeting_count = case when meeting_changed then round((meeting ->> 'count')::numeric)::integer else meeting_count end,
    meeting_approximate = case when meeting_changed then (meeting ->> 'approximate')::boolean else meeting_approximate end,
    meeting_computed_at = case when meeting_changed and meeting ->> 'area_id' is not null then now()
                               when meeting_changed then null else meeting_computed_at end,
    banner = case
      when banner_text is not null then jsonb_build_object('text', banner_text, 'at', (extract(epoch from now()) * 1000)::bigint, 'approvalsRemoved', true)
      when banner_changed and banner_stamped then banner_new || jsonb_build_object('at', (extract(epoch from now()) * 1000)::bigint)
      when banner_changed then banner_new
      else banner end,
    -- Opening the plan again clears what belonged to the confirmed plan: the order note, the suggested order, the plan's start and
    -- the prompt. Leaving or entering confirmed clears the prompt too. Finishing the outing stamps its time once.
    order_reason = case when reopened then null when sp ? 'order_note' then note_new ->> 'reason' else order_reason end,
    order_source = case when reopened then null when sp ? 'order_note' then note_new ->> 'source' else order_source end,
    order_suggestion = case when reopened then null when sp ? 'order_suggestion' then suggestion_new else order_suggestion end,
    plan_start_minute = case when reopened then null when sp ? 'plan_start_minute' then (sp ->> 'plan_start_minute')::integer else plan_start_minute end,
    replan = case when s.status = 'confirmed' and new_status <> 'confirmed' then null
                  when s.status = 'voting' and new_status = 'confirmed' then null
                  when sp ? 'replan' then replan_new else replan end,
    completed_at = case when s.status = 'confirmed' and new_status = 'completed' then now() else completed_at end,
    plan_version = plan_version + 1
  where id = sid;

  return s.plan_version + 1;
end;
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
create or replace trigger session_member_places_set_updated_at before update on public.session_member_places
  for each row execute function public.set_updated_at();
create or replace trigger slots_set_updated_at before update on public.slots
  for each row execute function public.set_updated_at();
create or replace trigger votes_set_updated_at before update on public.votes
  for each row execute function public.set_updated_at();

-- Records when a member last changed their picks, so the client cannot set that time itself.
create or replace function public.touch_member_preferences()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if new.categories is distinct from old.categories or new.stay_until is distinct from old.stay_until then
    new.preferences_set_at := now();
  end if;
  return new;
end;
$$;

create or replace trigger session_members_touch_preferences before update on public.session_members
  for each row execute function public.touch_member_preferences();

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

-- Runs before every insert into invites, whoever inserts. The session must be open. A personal invitation
-- must not be for the host or for someone already in the session, and a session has at most 30 open ones
-- (not revoked, declined, accepted or expired). The session row is locked, so two inserts at once cannot
-- both take the last place.
create or replace function public.check_invite_insert()
returns trigger
language plpgsql security definer set search_path = ''
as $$
declare
  s public.sessions%rowtype;
begin
  select * into s from public.sessions where id = new.session_id for update;
  if not found or s.status not in ('inviting', 'locating', 'voting') then
    raise exception 'Invitations can only be made while a session is open.' using errcode = '42501';
  end if;
  if new.invitee_id is null then
    return new;
  end if;
  if new.invitee_id = s.host_id then
    raise exception 'The host is already in the session.' using errcode = '42501';
  end if;
  if exists (
    select 1 from public.session_members m where m.session_id = new.session_id and m.user_id = new.invitee_id
  ) then
    raise exception 'That person is already in the session.' using errcode = '42501';
  end if;
  if (
    select count(*) from public.invites i
    where i.session_id = new.session_id and i.invitee_id is not null
      and not i.revoked and i.declined_at is null and i.uses = 0 and i.expires_at > now()
  ) >= 30 then
    raise exception 'A session can have at most 30 open invitations.' using errcode = '42501';
  end if;
  return new;
end;
$$;

create or replace trigger invites_check_insert before insert on public.invites
  for each row execute function public.check_invite_insert();

-- Limits what anyone but the server can change on a session. The server (the service key) and
-- database owners are let through; every other role is held to these rules:
--   - A completed or cancelled session cannot be changed at all.
--   - The only status changes are starting (inviting → locating, with at least two people joined)
--     and cancelling. Voting, confirmed and completed are set by the server after the planner has run.
--   - The date and times can change only while the session is still "inviting".
--   - meet_by (how the host picks the meeting point) is set in the update that starts the session, and can change while
--     the session is locating. It can never be cleared. The row-level rule already makes the host the only one who updates.
create or replace function public.guard_session_changes()
returns trigger
language plpgsql set search_path = ''
as $$
begin
  if current_user in ('service_role', 'postgres', 'supabase_admin') then
    return new;
  end if;

  if old.status in ('completed', 'cancelled') then
    raise exception 'A % session cannot be changed.', old.status using errcode = '42501';
  end if;

  if new.status is distinct from old.status then
    if new.status = 'locating' and old.status = 'inviting' then
      if (select count(*) from public.session_members m
          where m.session_id = old.id and m.state = 'joined') < 2 then
        raise exception 'A session needs at least two people before it can start.' using errcode = '42501';
      end if;
    elsif new.status <> 'cancelled' then
      raise exception 'A session cannot go from % to % directly.', old.status, new.status
        using errcode = '42501';
    end if;
  end if;

  if old.status <> 'inviting'
     and (new.date, new.start_time, new.end_time) is distinct from (old.date, old.start_time, old.end_time) then
    raise exception 'The date and times can only change before the session starts.' using errcode = '42501';
  end if;

  if new.meet_by is distinct from old.meet_by then
    if new.meet_by is null then
      raise exception 'How to pick the meeting point cannot be cleared.' using errcode = '42501';
    end if;
    if not (old.status = 'inviting' and new.status = 'locating') and not (old.status = 'locating' and new.status = 'locating') then
      raise exception 'How to pick the meeting point can only be chosen as the session starts or while it is locating.' using errcode = '42501';
    end if;
  end if;

  return new;
end;
$$;

create or replace trigger sessions_guard_changes before update on public.sessions
  for each row execute function public.guard_session_changes();
